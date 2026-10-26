import type { DialogueApiConfig } from '../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiProtocol } from './apiConfigNormalize';
import { safeFetchJson } from './safeApi';
import { readAnthropicResponse } from './anthropicStream';
import { resolveBlobRefsInRequestBody } from './apiBlobRefs';

export const isAnthropicApi = (api: Pick<DialogueApiConfig, 'protocol'>): boolean =>
  normalizeApiProtocol(api.protocol) === 'anthropic';

/** Accept an origin, a /v1 base, or a complete Messages endpoint. */
export function dialogueEndpoint(api: DialogueApiConfig, resource: 'messages' | 'models' = 'messages'): string {
  let base = normalizeApiBaseUrl(api.baseUrl);
  if (!isAnthropicApi(api)) return `${base}/${resource === 'models' ? 'models' : 'chat/completions'}`;
  base = base.replace(/\/(?:messages|models|chat\/completions)$/, '');
  if (!base.endsWith('/v1')) base += '/v1';
  return `${base}/${resource}`;
}

export function dialogueHeaders(api: DialogueApiConfig): Record<string, string> {
  const key = normalizeApiCredential(api.apiKey);
  return isAnthropicApi(api) ? {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  } : { 'Content-Type': 'application/json', Authorization: `Bearer ${key || 'sk-none'}` };
}

type Block = Record<string, any>;
type Turn = { role: 'user' | 'assistant'; content: Block[] };

/** Image references have already been materialized at the request boundary. */
function imageBlock(value: unknown): Block {
  if (typeof value !== 'string' || !value.trim()) throw new Error('图片数据不可用，请重新上传图片后再发送');
  const url = value.trim();
  if (/^https?:\/\//i.test(url)) {
    try {
      if (new URL(url).hostname) return { type: 'image', source: { type: 'url', url } };
    } catch { /* Report the same actionable error as other invalid image sources. */ }
  }
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(url);
  if (match) {
    const mediaType = match[1].toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) {
      throw new Error('Anthropic 图片直传支持 PNG、JPEG、GIF 和 WebP，请转换图片格式后重试');
    }
    const data = match[2].replace(/\s+/g, '');
    // A flat character check avoids recursive regex backtracking on large photos.
    if (data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    }
  }
  throw new Error('图片数据不可用，请重新上传 PNG、JPEG、GIF 或 WebP 图片后再发送');
}

function contentBlocks(content: unknown, allowImages = true): Block[] {
  if (content == null || content === '') return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw new Error('Anthropic 请求包含无法识别的消息内容');
  return content.flatMap(block => {
    if (block?.type === 'text') return block.text ? [{ type: 'text', text: String(block.text) }] : [];
    if (block?.type === 'image_url') {
      if (!allowImages) throw new Error('Anthropic 系统提示词不支持图片，请将图片放在聊天消息中');
      return [imageBlock(block.image_url?.url)];
    }
    throw new Error('Anthropic 请求包含不支持的消息内容');
  });
}

/** Keep the existing prompt/history pipeline; convert only at the local chat boundary. */
export function toAnthropicBody(body: Record<string, any>): Record<string, any> {
  const system: string[] = [];
  const messages: Turn[] = [];
  for (const message of body.messages || []) {
    if (message.role === 'system' || message.role === 'developer') {
      system.push(...contentBlocks(message.content, false).map(block => block.text));
      continue;
    }
    let role: Turn['role'];
    let content: Block[];
    if (message.role === 'tool') {
      role = 'user';
      content = [{ type: 'tool_result', tool_use_id: message.tool_call_id,
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') }];
    } else if (message.role === 'user' || message.role === 'assistant') {
      role = message.role;
      content = contentBlocks(message.content);
      if (role === 'assistant') for (const call of message.tool_calls || []) {
        const args = call.function?.arguments;
        content.push({ type: 'tool_use', id: call.id, name: call.function?.name,
          input: typeof args === 'string' ? JSON.parse(args || '{}') : (args || {}) });
      }
    } else {
      throw new Error(`Anthropic 不支持消息角色：${String(message.role)}`);
    }
    if (!content.length) continue;
    const previous = messages[messages.length - 1];
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  }
  if (!messages.length) throw new Error('没有可发送的消息');
  // A context window can start with a saved assistant reply. Preserve it intact.
  if (messages[0].role === 'assistant') messages.unshift({ role: 'user', content: [{ type: 'text', text: '以下是已有对话记录，请继续对话。' }] });
  const result: Record<string, any> = {
    model: body.model,
    max_tokens: Number.isFinite(body.max_tokens) && body.max_tokens > 0 ? Math.floor(body.max_tokens) : 8000,
    messages,
    stream: body.stream === true,
    ...(system.length ? { system: system.join('\n\n') } : {}),
  };
  // These are local chat tools (e.g. an enabled scheduler), not cloud transport.
  // Convert them so their automatic injection cannot break an ordinary chat.
  if (body.tools?.length) {
    result.tools = body.tools.map((tool: any) => ({ name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      input_schema: tool.function.parameters || { type: 'object', properties: {} } }));
    if (body.tool_choice === 'auto') result.tool_choice = { type: 'auto' };
    else if (body.tool_choice === 'required') result.tool_choice = { type: 'any' };
    else if (body.tool_choice?.function?.name) result.tool_choice = { type: 'tool', name: body.tool_choice.function.name };
    else if (body.tool_choice === 'none') delete result.tools;
  }
  // Native v1 uses no proxy -thinking suffix, sampling dialects, or OpenAI-only fields.
  // Keep the selected streaming mode and the model's sampling defaults.
  return result;
}

export function fromAnthropicResponse(data: any): any {
  if (data?.error) throw new Error(data.error.message || 'Anthropic 接口返回错误');
  if (!Array.isArray(data?.content)) throw new Error('Anthropic 返回格式不正确，请确认接口格式和 API 地址');
  const calls = data.content.filter((block: any) => block.type === 'tool_use').map((block: any) => ({
    id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
  }));
  const input = Number(data.usage?.input_tokens || 0);
  const output = Number(data.usage?.output_tokens || 0);
  return {
    id: data.id, model: data.model, object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant',
      content: data.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''),
      ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: data.stop_reason === 'max_tokens' ? 'length' : calls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  };
}

/** Same signature as safeFetchJson: the OpenAI branch stays completely unchanged. */
export function createDialogueFetch(api: DialogueApiConfig): typeof safeFetchJson {
  return async (url, options, retries, timeout, meta, hooks) => {
    if (!isAnthropicApi(api)) return safeFetchJson(url, options, retries, timeout, meta, hooks);
    options.signal?.throwIfAborted();
    // Convert only after restoring local images. safeFetchJson's later restoration
    // cannot split a data URL into Anthropic's media_type/data fields for us.
    // Reuse the common resolver so inline references remain text placeholders.
    const resolvedBody = await resolveBlobRefsInRequestBody(options.body);
    options.signal?.throwIfAborted();
    const body = typeof resolvedBody === 'string' ? JSON.parse(resolvedBody) : {};
    const result = await safeFetchJson(dialogueEndpoint(api), {
      ...options, headers: dialogueHeaders(api), body: JSON.stringify(toAnthropicBody(body)),
    }, 0, timeout, meta, {
      ...(body.stream === true ? hooks : {}),
      responseParser: (response, _streamHooks, timing, startedAt) =>
        readAnthropicResponse(response, body.stream === true ? hooks : undefined, timing, startedAt, options.signal),
    });
    return fromAnthropicResponse(result);
  };
}

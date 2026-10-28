import type { DialogueApiConfig } from '../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiProtocol } from './apiConfigNormalize';
import { safeFetchJson } from './safeApi';
import { readAnthropicResponse } from './anthropicStream';
import { resolveBlobRefsInRequestBody } from './apiBlobRefs';
import { captureApiRequestOnce, getApiCallAmbientContext, MAX_API_RAW_USAGE_EVENTS, updateApiRequestCaptureUsage, type ApiRawUsageEvent } from './apiCallLog';
import { compareAnthropicCachePrefix, splitAnthropicCacheText } from './anthropicPromptCache';

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
export function toAnthropicBody(body: Record<string, any>, api?: Pick<DialogueApiConfig, 'temperature' | 'anthropicCustomTemperature' | 'anthropicPromptCache' | 'anthropicPromptCacheTtl'>): Record<string, any> {
  const system: Block[] = [];
  const messages: Turn[] = [];
  const cacheEnabled = api?.anthropicPromptCache !== false;
  const cacheControl = { type: 'ephemeral', ...(api?.anthropicPromptCacheTtl === '1h' ? { ttl: '1h' } : {}) };
  for (const message of body.messages || []) {
    if (message.role === 'system' || message.role === 'developer') {
      let parts = contentBlocks(message.content, false);
      // Up to four checkpoints within the stable leading prompt let an earlier
      // unchanged prefix survive edits in later memories/impressions. Existing
      // multi-block content retains its original boundaries and whitespace.
      if (cacheEnabled && message === body.messages[0] && parts.length) {
        if (parts.length === 1) parts = splitAnthropicCacheText(parts[0].text)
          .map(text => ({ type: 'text', text, cache_control: cacheControl }));
        else parts[parts.length - 1].cache_control = cacheControl;
      }
      system.push(...parts);
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
      if (role === 'assistant' && Array.isArray(message.anthropic_thinking)) {
        content.unshift(...message.anthropic_thinking.filter((block: any) =>
          (block?.type === 'thinking' && typeof block.thinking === 'string' && typeof block.signature === 'string')
          || (block?.type === 'redacted_thinking' && typeof block.data === 'string')).map((block: any) => ({ ...block })));
      }
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
    ...(system.length ? { system: cacheEnabled ? system : system.map(block => block.text).join('\n\n') } : {}),
  };
  if (body.thinking?.type === 'enabled') {
    const budget = body.thinking.budget_tokens;
    if (!Number.isInteger(budget) || budget < 1024 || budget >= result.max_tokens) {
      throw new Error('Anthropic 思考预算须至少为 1024 且小于最大输出 Token 数');
    }
    result.thinking = { type: 'enabled', budget_tokens: budget };
  }
  if (!result.thinking && api?.anthropicCustomTemperature === true) {
    const temperature = api.temperature ?? body.temperature ?? 0.85;
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
      throw new Error('Anthropic 自定义温度须在 0～1 之间，请调整温度或改用模型默认');
    }
    result.temperature = temperature;
  }
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
  // Default to model sampling, or send temperature only on explicit user opt-in.
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
  const cachedWrite = data.usage?.cache_creation_input_tokens;
  const cachedRead = data.usage?.cache_read_input_tokens;
  const cacheUsage = {
    ...(typeof cachedWrite === 'number' ? { cache_creation_input_tokens: cachedWrite } : {}),
    ...(typeof cachedRead === 'number' ? { cache_read_input_tokens: cachedRead,
      prompt_tokens_details: { cached_tokens: cachedRead } } : {}),
  };
  const promptTokens = input + (cachedWrite || 0) + (cachedRead || 0);
  const thinking = data.content.filter((block: any) => block.type === 'thinking' && typeof block.thinking === 'string').map((block: any) => block.thinking).join('\n\n');
  const thinkingBlocks = data.content.filter((block: any) => block.type === 'thinking' || block.type === 'redacted_thinking');
  return {
    id: data.id, model: data.model, object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant',
      content: data.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join(''),
      ...(thinking ? { reasoning_content: thinking } : {}),
      ...(thinkingBlocks.length ? { anthropic_thinking: thinkingBlocks } : {}),
      ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: data.stop_reason === 'max_tokens' ? 'length' : calls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: output, total_tokens: promptTokens + output, ...cacheUsage },
  };
}

/** Same signature as safeFetchJson: the OpenAI branch stays completely unchanged. */
export function createDialogueFetch(api: DialogueApiConfig): typeof safeFetchJson {
  return async (url, options, retries, timeout, meta, hooks) => {
    if (!isAnthropicApi(api)) return safeFetchJson(url, options, retries, timeout, meta, hooks);
    const nativeMeta = { ...(meta || getApiCallAmbientContext()) };
    options.signal?.throwIfAborted();
    // Convert only after restoring local images. safeFetchJson's later restoration
    // cannot split a data URL into Anthropic's media_type/data fields for us.
    // Reuse the common resolver so inline references remain text placeholders.
    const resolvedBody = await resolveBlobRefsInRequestBody(options.body);
    options.signal?.throwIfAborted();
    const body = typeof resolvedBody === 'string' ? JSON.parse(resolvedBody) : {};
    const endpoint = dialogueEndpoint(api);
    const payload = toAnthropicBody(body, api);
    const cacheDiagnostic = await compareAnthropicCachePrefix({ endpoint, credential: normalizeApiCredential(api.apiKey), charId: nativeMeta.charId, purpose: nativeMeta.purpose }, payload);
    options.signal?.throwIfAborted();
    const nativeBody = JSON.stringify(payload);
    if (cacheDiagnostic) nativeMeta.cacheDiagnostic = cacheDiagnostic;
    // The legacy global interceptor only captures /chat/completions. Claim the
    // one-shot switch here after conversion, so it contains the actual Messages
    // request (including system, tools, thinking and cache_control).
    const captureId = captureApiRequestOnce({ url: endpoint, body: nativeBody, meta: nativeMeta });
    const rawUsageEvents: ApiRawUsageEvent[] = [];
    let rawUsageEventsDropped = 0;
    const onUsage = captureId ? (event: ApiRawUsageEvent) => {
      if (rawUsageEvents.length < MAX_API_RAW_USAGE_EVENTS) rawUsageEvents.push(event);
      else rawUsageEventsDropped++;
    } : undefined;
    try {
      const result = await safeFetchJson(endpoint, {
        ...options, headers: dialogueHeaders(api), body: nativeBody,
      }, 0, timeout, nativeMeta, {
        ...(body.stream === true ? hooks : {}),
        responseParser: (response, _streamHooks, timing, startedAt) =>
          readAnthropicResponse(response, body.stream === true ? hooks : undefined, timing, startedAt, options.signal, onUsage),
      });
      const completion = fromAnthropicResponse(result);
      updateApiRequestCaptureUsage({ captureId, ok: true, response: result, rawUsageEvents, rawUsageEventsDropped });
      return completion;
    } catch (error) {
      updateApiRequestCaptureUsage({ captureId, ok: false, rawUsageEvents, rawUsageEventsDropped });
      throw error;
    }
  };
}

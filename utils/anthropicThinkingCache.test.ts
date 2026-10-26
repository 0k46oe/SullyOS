import { afterEach, expect, it, vi } from 'vitest';
import { toAnthropicBody, fromAnthropicResponse, createDialogueFetch } from './dialogueTransport';
import { extractApiTokenUsage } from './apiCallLog';
import { pickDialogueApi, resolveDialogueApi } from './characterApi';
import { configFromPreset, presetDiffersFromConfig } from './apiPresetSwitch';
import { normalizeApiConfig } from './apiConfigNormalize';
import { shouldSendThinkingParams } from './thinkingGate';
import { DB } from './db';

const api = { baseUrl: 'https://native.test', apiKey: 'fake-only', model: '【反重力】claude-opus-4-6-thinking', protocol: 'anthropic' as const, anthropicPromptCache: true };
const body = { model: api.model, max_tokens: 8000, messages: [{ role: 'system', content: '稳定角色前缀'.repeat(3000) }, { role: 'user', content: '你好' }, { role: 'system', content: '当前时间与召回 A' }] };
const thinking = { type: 'enabled', budget_tokens: 4000 };
const content = [{ type: 'thinking', thinking: '服务返回的思考摘要', signature: 'test-signature' }, { type: 'redacted_thinking', data: 'encrypted-test' }, { type: 'text', text: '正文' }];
const result = { id: 'test', model: api.model, content, usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000 } };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['claude-opus-4-6-thinking', '【反重力】claude-opus-4-6-thinking', 'provider/custom-model'])('preserves the complete selected model ID %s while enabling thinking', model => {
  const request = toAnthropicBody({ ...body, model, thinking, temperature: 0.37, reasoning_effort: 'medium', extra_body: { thinking } }, { ...api, temperature: 0.37, anthropicCustomTemperature: true });
  expect(request.model).toBe(model); expect(request.thinking).toEqual(thinking);
  expect(request).not.toHaveProperty('temperature'); expect(request).not.toHaveProperty('reasoning_effort'); expect(request).not.toHaveProperty('extra_body');
});
it('does not infer thinking from a suffix and respects the existing character/tool gate', () => {
  expect(toAnthropicBody(body, api)).not.toHaveProperty('thinking');
  expect(shouldSendThinkingParams({ thinkingActive: false, legacyToolModeActive: false, amsg2ToolsInjected: false, model: api.model })).toBe(false);
  expect(shouldSendThinkingParams({ thinkingActive: true, legacyToolModeActive: true, amsg2ToolsInjected: false, model: api.model })).toBe(false);
});
it.each([undefined, 1000, 4000.5, 8000, 9000])('rejects invalid thinking budget %s before sending', budget_tokens => {
  expect(() => toAnthropicBody({ ...body, thinking: { type: 'enabled', budget_tokens } })).toThrow('思考预算');
});
it('marks only the stable leading system block and leaves changing context outside its breakpoint', () => {
  const original = structuredClone(body);
  const first = toAnthropicBody(body, api);
  const second = toAnthropicBody({ ...body, messages: [...body.messages.slice(0, 2), { role: 'system', content: '当前时间与召回 B' }] }, api);
  expect(first.system[0]).toEqual({ type: 'text', text: body.messages[0].content, cache_control: { type: 'ephemeral' } });
  expect(first.system[0]).toEqual(second.system[0]); expect(first.system[1]).not.toHaveProperty('cache_control');
  expect(first.system[1].text).not.toBe(second.system[1].text); expect(body).toEqual(original);
  expect(JSON.stringify(toAnthropicBody(body, { anthropicPromptCache: false }))).not.toContain('cache_control');
  expect(JSON.stringify(toAnthropicBody({ ...body, messages: body.messages.slice(1) }, api))).not.toContain('cache_control');
});
it('maps only provider-returned thinking to reasoning and retains opaque blocks for signed tool continuation', () => {
  const response = fromAnthropicResponse(result);
  expect(response.choices[0].message).toMatchObject({ content: '正文', reasoning_content: '服务返回的思考摘要', anthropic_thinking: content.slice(0, 2) });
  expect(response.choices[0].message.reasoning_content).not.toContain('encrypted-test');
  const request = toAnthropicBody({ ...body, messages: [...body.messages, { ...response.choices[0].message, tool_calls: [{ id: 'call', function: { name: 'test', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call', content: 'ok' }] }, api);
  expect(request.messages.at(-2).content.slice(0, 2)).toEqual(content.slice(0, 2));
});
it('accounts for cache read/write exactly once, and distinguishes unreported cache usage from zero', () => {
  expect(fromAnthropicResponse(result).usage).toEqual({ prompt_tokens: 2110, completion_tokens: 20, total_tokens: 2130, cache_creation_input_tokens: 100, cache_read_input_tokens: 2000, prompt_tokens_details: { cached_tokens: 2000 } });
  expect(extractApiTokenUsage(result)).toEqual({ prompt: 2110, completion: 20, total: 2130, cacheRead: 2000, cacheCreation: 100 });
  expect(extractApiTokenUsage(fromAnthropicResponse(result))).toEqual(extractApiTokenUsage(result));
  expect(extractApiTokenUsage({ usage: { input_tokens: 10, output_tokens: 20 } })).not.toHaveProperty('cacheRead');
  expect(extractApiTokenUsage({ usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 } }).cacheRead).toBe(0);
});
it.each([false, true])('records the real native cache usage and emits reasoning in stream=%s', async stream => {
  const append = vi.spyOn(DB, 'appendApiCallLog').mockResolvedValue(undefined as any);
  const events = [
    { type: 'message_start', message: { ...result, content: [], usage: { ...result.usage, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '服务返回的思考摘要' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'test-' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: content[1] }, { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '正文' } }, { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', usage: { output_tokens: 20 }, delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
  ];
  const raw = stream ? events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') : JSON.stringify(result);
  const fetch = vi.fn().mockResolvedValue(new Response(raw, { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } })); vi.stubGlobal('fetch', fetch);
  const hooks = { onReasoningDelta: vi.fn(), onDelta: vi.fn() };
  const response = await createDialogueFetch(api)('unused', { method: 'POST', body: JSON.stringify({ ...body, stream, thinking }) }, 3, 0, { purpose: '聊天回复' }, hooks);
  expect(response.choices[0].message.anthropic_thinking).toEqual(content.slice(0, 2));
  expect(response.usage.prompt_tokens).toBe(2110);
  expect(hooks.onReasoningDelta.mock.calls).toEqual(stream ? [['服务返回的思考摘要', '服务返回的思考摘要']] : []);
  expect(hooks.onDelta.mock.calls).toEqual(stream ? [['正文', '正文']] : []);
  await vi.waitFor(() => expect(append).toHaveBeenCalledOnce());
  expect(append.mock.calls[0][0]).toMatchObject({ model: api.model, cacheReadTokens: 2000, cacheCreationTokens: 100, promptTokens: 2110, totalTokens: 2130 });
  expect(fetch).toHaveBeenCalledOnce();
});
it('keeps cache preference in role/preset/config and does not inherit it across API endpoints', () => {
  const disabled = { ...api, anthropicPromptCache: false };
  expect(pickDialogueApi(disabled).anthropicPromptCache).toBe(false);
  expect(normalizeApiConfig(disabled).anthropicPromptCache).toBe(false);
  expect(configFromPreset({ id: 'a', name: 'a', config: disabled }).anthropicPromptCache).toBe(false);
  expect(configFromPreset({ id: 'a', name: 'a', config: api }).anthropicPromptCache).toBe(true);
  expect(resolveDialogueApi(disabled, { dialogueApi: api }).anthropicPromptCache).toBe(true);
  expect(presetDiffersFromConfig({ id: 'a', name: 'a', config: disabled }, api)).toBe(true);
});
it('surfaces unsupported thinking/cache parameters once with no fallback model or paid retry', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'thinking/cache_control unsupported' } }), { status: 400 })); vi.stubGlobal('fetch', fetch);
  await expect(createDialogueFetch(api)('unused', { method: 'POST', body: JSON.stringify({ ...body, thinking }) }, 3)).rejects.toThrow('unsupported');
  expect(fetch).toHaveBeenCalledOnce(); expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe(api.model);
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDialogueFetch } from './dialogueTransport';
import { buildApiRequestCapture, extractApiTokenUsage, formatApiRequestCaptureTxt, getApiRequestCaptureSectionContent, isApiRequestCaptureArmed, scanSseForLog, setApiRequestCaptureArmed } from './apiCallLog';
import { DB } from './db';

const api = { protocol: 'anthropic' as const, baseUrl: 'https://native.test', apiKey: 'test-key-never-export', model: '【反重力】claude-opus-4-6-thinking' };
const body = { model: api.model, thinking: { type: 'enabled', budget_tokens: 4000 }, messages: [
  { role: 'system', content: '### 你的身份\n完整人设\n### 记忆系统\n完整记忆\n### 世界书\n完整设定' },
  { role: 'user', content: [{ type: 'text', text: '今天看这张图片' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'a'.repeat(5000) } }] },
  { role: 'system', content: '当前时间及动态召回' },
], tools: [{ type: 'function', function: { name: 'calendar', parameters: { type: 'object', properties: {} } } }] };
const response = { model: api.model, content: [{ type: 'text', text: '回复' }], usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1200, cache_creation_input_tokens: 100 } };
beforeEach(async () => { setApiRequestCaptureArmed(false); await DB.clearApiRequestCapture(); });
afterEach(() => { setApiRequestCaptureArmed(false); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])('captures the actual native request once, exports complete text and updates usage for stream=%s', async stream => {
  const events = [
    { type: 'message_start', message: { ...response, content: [], usage: { ...response.usage, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '回复' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', usage: { output_tokens: 20 }, delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
  ];
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(stream ? events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') : JSON.stringify(response), { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } })));
  vi.stubGlobal('fetch', fetch);
  const saves = vi.spyOn(DB, 'saveApiRequestCapture');
  setApiRequestCaptureArmed(true);
  const send = () => createDialogueFetch(api)('unused', { method: 'POST', body: JSON.stringify({ ...body, stream }) }, 0, 0, { appName: '消息', purpose: '聊天回复', charId: 'test' });
  await send();
  await vi.waitFor(async () => expect(await DB.getApiRequestCapture()).toMatchObject({ usageStatus: 'reported', promptTokens: 1310, completionTokens: 20, totalTokens: 1330, cacheReadTokens: 1200, cacheCreationTokens: 100 }));
  const captured = (await DB.getApiRequestCapture()) as ReturnType<typeof buildApiRequestCapture>;
  const sent = JSON.parse(fetch.mock.calls[0][1].body);
  const expected = buildApiRequestCapture({ url: 'https://native.test/v1/messages', body: sent });
  expect(captured.payload).toEqual(expected.payload);
  expect(captured.model).toBe(api.model);
  expect(captured.meta).toMatchObject({ appName: '消息', purpose: '聊天回复', charId: 'test' });
  expect(captured.binaryPlaceholders).toBe(1);
  const txt = formatApiRequestCaptureTxt(captured);
  for (const text of ['完整人设', '完整记忆', '完整设定', '当前时间及动态召回', '今天看这张图片', 'calendar', 'cache_control', 'thinking', '完整原始请求 JSON', '缓存读取 Token：1,200']) expect(txt).toContain(text);
  expect(txt).not.toContain(api.apiKey); expect(txt).not.toContain('a'.repeat(100));
  expect(captured.sections.filter(part => part.systemBlockIndex != null).map(part => getApiRequestCaptureSectionContent(captured, part)).join('')).toContain('完整记忆');
  expect(isApiRequestCaptureArmed()).toBe(false);
  await send(); expect(saves).toHaveBeenCalledOnce();
  expect((await DB.getApiRequestCapture())?.id).toBe(captured.id);
});

it('leaves normal native requests unrecorded when the one-shot switch is off', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))));
  await createDialogueFetch(api)('unused', { body: JSON.stringify(body) }, 0);
  expect(await DB.getApiRequestCapture()).toBeNull();
});

it.each(['failure', 'abort'] as const)('keeps the sent request document and marks %s instead of waiting forever', async kind => {
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
    if (kind === 'abort') { controller.abort(); throw new DOMException('stopped', 'AbortError'); }
    return new Response(JSON.stringify({ error: { message: 'provider failed' } }), { status: 400 });
  }));
  setApiRequestCaptureArmed(true);
  await expect(createDialogueFetch(api)('unused', { body: JSON.stringify(body), signal: controller.signal }, 0)).rejects.toThrow();
  await vi.waitFor(async () => expect(await DB.getApiRequestCapture()).toMatchObject({ model: api.model, usageStatus: 'failed' }));
  expect(formatApiRequestCaptureTxt((await DB.getApiRequestCapture())!)).toContain('完整人设');
});

it('does not consume the switch on a local validation error or double-capture OpenAI', async () => {
  setApiRequestCaptureArmed(true);
  await expect(createDialogueFetch(api)('unused', { body: JSON.stringify({ ...body, thinking: { type: 'enabled', budget_tokens: 1 } }) }, 0)).rejects.toThrow('思考预算');
  expect(isApiRequestCaptureArmed()).toBe(true);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))));
  await createDialogueFetch({ ...api, protocol: 'openai' })('https://oai.test/v1/chat/completions', { body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }) }, 0);
  // The existing OSContext interceptor remains the sole OpenAI capture owner.
  expect(isApiRequestCaptureArmed()).toBe(true); expect(await DB.getApiRequestCapture()).toBeNull();
});

it.each(['### 记忆系统\n字符串系统正文', [{ type: 'text', text: '### 记忆系统\n数组系统正文', cache_control: { type: 'ephemeral' } }]])('indexes top-level system without burying it in request options', system => {
  const capture = buildApiRequestCapture({ url: 'https://native.test/v1/messages', body: { model: api.model, system, messages: [{ role: 'user', content: 'hi' }] } });
  const memory = capture.sections.find(part => part.kind === 'memory')!;
  expect(getApiRequestCaptureSectionContent(capture, memory)).toContain('系统正文');
  expect(getApiRequestCaptureSectionContent(capture, capture.sections.find(part => part.kind === 'request')!)).not.toContain('系统正文');
});

it('merges native SSE start and final usage in the raw-text fallback without dropping cache counts', () => {
  const raw = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: api.model, usage: { ...response.usage, output_tokens: 0 } } })}\n\nevent: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 20 } })}\n\n`;
  const scanned = scanSseForLog(raw);
  expect(scanned.model).toBe(api.model);
  expect(extractApiTokenUsage({ usage: scanned.usage })).toEqual({ prompt: 1310, completion: 20, total: 1330, cacheRead: 1200, cacheCreation: 100 });
});

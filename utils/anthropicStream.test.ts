import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAnthropicResponse } from './anthropicStream';
import { createDialogueFetch } from './dialogueTransport';

const api = { protocol: 'anthropic' as const, baseUrl: 'https://native.test', apiKey: 'test-key', model: 'test-model' };
const start = { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: api.model, content: [], usage: { input_tokens: 12, output_tokens: 0 } } };
const blockStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const delta = (text: string, index = 0) => ({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const blockStop = { type: 'content_block_stop', index: 0 };
const end = { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } };
const stop = { type: 'message_stop' };
const wire = (events: object[], newline = '\n') => events.map(event => `event: ${(event as any).type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`).join('');
const normalEvents = () => [start, blockStart, delta('你好'), delta(' 🌷'), blockStop, end, stop];
const streamed = (events: object[], options: { chunkSize?: number; newline?: string; keepOpen?: boolean; contentType?: string } = {}) => {
  const bytes = new TextEncoder().encode(wire(events, options.newline));
  const cancel = vi.fn();
  const chunkSize = options.chunkSize || bytes.length;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
      if (!options.keepOpen) controller.close();
    }, cancel,
  });
  return { response: new Response(stream, { headers: { 'content-type': options.contentType || 'text/event-stream' } }), cancel };
};
afterEach(() => vi.unstubAllGlobals());

describe('native Anthropic streaming', () => {
  it.each([1, 2, 7, 61, 4096])('handles UTF-8 and event boundaries split into %i-byte chunks', async chunkSize => {
    const hooks = { onFirstDelta: vi.fn(), onDelta: vi.fn() };
    const timing = {};
    const response = await readAnthropicResponse(streamed(normalEvents(), { chunkSize, newline: '\r\n' }).response, hooks, timing, Date.now() - 10);
    expect(response).toMatchObject({ id: 'msg_test', model: api.model, content: [{ type: 'text', text: '你好 🌷' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 8 } });
    expect(hooks.onFirstDelta).toHaveBeenCalledOnce();
    expect(hooks.onDelta.mock.calls).toEqual([['你好', '你好'], [' 🌷', '你好 🌷']]);
    expect(timing).toHaveProperty('firstDeltaMs');
  });
  it('emits the first text while the response is still open, then cancels the socket at message_stop', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
    let sawDelta!: () => void;
    const firstDelta = new Promise<void>(resolve => { sawDelta = resolve; });
    let completed = false;
    const result = readAnthropicResponse(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), { onDelta: () => sawDelta() }).then(value => { completed = true; return value; });
    controller.enqueue(new TextEncoder().encode(wire([start, blockStart, delta('正在逐步回复')])));
    await firstDelta;
    expect(completed).toBe(false);
    controller.enqueue(new TextEncoder().encode(wire([blockStop, end, stop])));
    expect((await result).content[0].text).toBe('正在逐步回复');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('supports ping, comments, unknown events and a final event without a trailing newline', async () => {
    const raw = ': heartbeat\n\n' + wire([start, { type: 'ping' }, { type: 'future_provider_event', extra: true }, blockStart, delta('完成'), blockStop, end, stop]).trimEnd();
    const result = await readAnthropicResponse(new Response(raw, { headers: { 'content-type': 'text/event-stream' } }));
    expect(result.content[0].text).toBe('完成');
  });
  it('detects SSE without a MIME header even when the event field arrives one byte at a time', async () => {
    expect((await readAnthropicResponse(streamed(normalEvents(), { chunkSize: 1, contentType: 'text/plain' }).response)).content[0].text).toBe('你好 🌷');
  });
  it('combines multiline data fields within one SSE event', async () => {
    const raw = 'event: message_start\ndata: {"type":"message_start",\ndata: "message":' + JSON.stringify(start.message) + '}\n\n' + wire([blockStart, delta('完成'), blockStop, end, stop]);
    expect((await readAnthropicResponse(new Response(raw))).content[0].text).toBe('完成');
  });
  it('assembles tool JSON fragments by block index without mixing them into text previews', async () => {
    const events = [start, blockStart, delta('我来查询'), blockStop,
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_a', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"天气"}' } },
      { type: 'content_block_stop', index: 1 }, { ...end, delta: { stop_reason: 'tool_use' } }, stop];
    const fetch = vi.fn().mockResolvedValue(streamed(events, { chunkSize: 11 }).response);
    vi.stubGlobal('fetch', fetch);
    const hooks = { onDelta: vi.fn() };
    const result = await createDialogueFetch(api)('unused', { method: 'POST', body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: '你好' }], stream: true }) }, 2, 0, undefined, hooks);
    expect(result.choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { content: '我来查询', tool_calls: [{ id: 'tool_a', function: { name: 'lookup', arguments: '{"q":"天气"}' } }] } });
    expect(result.usage).toEqual({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
    expect(hooks.onDelta).toHaveBeenCalledOnce();
    expect(hooks.onDelta).toHaveBeenLastCalledWith('我来查询', '我来查询');
    expect(JSON.parse(fetch.mock.calls[0][1].body).stream).toBe(true);
  });
  it.each([undefined, 'application/json', 'text/event-stream'])('accepts non-stream JSON from a proxy with MIME %s', async contentType => {
    const data = { ...start.message, content: [{ type: 'text', text: '完整回复' }], stop_reason: 'end_turn' };
    const hooks = { onDelta: vi.fn() };
    const result = await readAnthropicResponse(new Response(JSON.stringify(data), { headers: contentType ? { 'content-type': contentType } : undefined }), hooks);
    expect(result).toEqual(data);
    expect(hooks.onDelta).not.toHaveBeenCalled();
  });
  it('honors the off switch even if the proxy unexpectedly returns SSE', async () => {
    const hooks = { onDelta: vi.fn() };
    const fetch = vi.fn().mockResolvedValue(streamed(normalEvents()).response);
    vi.stubGlobal('fetch', fetch);
    const result = await createDialogueFetch(api)('unused', { method: 'POST', body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: '你好' }], stream: false }) }, 2, 0, undefined, hooks);
    expect(result.choices[0].message.content).toBe('你好 🌷');
    expect(hooks.onDelta).not.toHaveBeenCalled();
    expect(JSON.parse(fetch.mock.calls[0][1].body).stream).toBe(false);
  });
  it('rejects provider errors inside HTTP 200 without retrying or succeeding with partial text', async () => {
    const fetch = vi.fn().mockResolvedValue(streamed([start, blockStart, delta('部分回复'), { type: 'error', error: { type: 'overloaded_error', message: '当前过载' } }], { keepOpen: true }).response);
    vi.stubGlobal('fetch', fetch);
    await expect(createDialogueFetch(api)('unused', { body: JSON.stringify({ messages: [{ role: 'user', content: '你好' }], stream: true }) }, 2)).rejects.toThrow('当前过载');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    [start, blockStart, delta('部分回复')],
    [start, blockStart, delta('部分回复'), blockStop, end],
  ])('rejects an early EOF instead of storing a partial reply', async (...events) => {
    await expect(readAnthropicResponse(streamed(events).response)).rejects.toThrow('未收到 message_stop');
  });
  it('rejects a premature message_stop and malformed tool JSON', async () => {
    await expect(readAnthropicResponse(streamed([start, blockStart, stop]).response)).rejects.toThrow('未完整结束');
    const events = [start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_a', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } }, blockStop, end, stop];
    await expect(readAnthropicResponse(streamed(events).response)).rejects.toThrow('JSON 未完整返回');
  });
  it('rejects malformed SSE JSON and preserves HTML error diagnostics', async () => {
    await expect(readAnthropicResponse(new Response('event: message_start\ndata: {bad json}\n\n'))).rejects.toThrow('无效 JSON');
    await expect(readAnthropicResponse(new Response('<html><title>Bad Gateway</title></html>'))).rejects.toThrow('HTML');
  });
  it('stops an in-progress stream on cancellation and does not return the partial reply', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }), { headers: { 'content-type': 'text/event-stream' } });
    const abort = new AbortController();
    let sawDelta!: () => void;
    const firstDelta = new Promise<void>(resolve => { sawDelta = resolve; });
    const result = readAnthropicResponse(response, { onDelta: () => sawDelta() }, undefined, undefined, abort.signal);
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.enqueue(new TextEncoder().encode(wire([start, blockStart, delta('部分回复')])));
    await firstDelta; abort.abort();
    await rejection;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('tolerates UI callback exceptions without dropping provider text', async () => {
    const broken = () => { throw new Error('UI callback'); };
    expect((await readAnthropicResponse(streamed(normalEvents()).response, { onFirstDelta: broken, onDelta: broken })).content[0].text).toBe('你好 🌷');
  });
});

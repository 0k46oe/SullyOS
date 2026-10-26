import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDialogueFetch } from './dialogueTransport';
import { DB } from './db';
import { buildApiRequestCapture, captureApiRequestOnce, formatApiRequestCaptureTxt, MAX_API_RAW_USAGE_EVENTS, setApiRequestCaptureArmed, snapshotApiRawUsage, updateApiRequestCaptureUsage } from './apiCallLog';
import { readAnthropicResponse } from './anthropicStream';

const api = { protocol: 'anthropic' as const, baseUrl: 'https://usage.test', apiKey: 'secret-never-export', model: '【渠道】claude-opus-4-6-thinking' };
const request = { model: api.model, stream: true, messages: [{ role: 'system', content: 'stable system' }, { role: 'user', content: 'hi' }] };
const startUsage = { input_tokens: 9, output_tokens: 0, cache_creation_input_tokens: 32265, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 32265, ephemeral_1h_input_tokens: 0 }, service_tier: 'standard', provider_detail: { nullable: null, flag: false } };
const start = (usage: unknown = startUsage) => ({ type: 'message_start', message: { id: 'msg_mock', model: 'upstream-model', role: 'assistant', content: [], ...(usage === undefined ? {} : { usage }) } });
const textEvents = [
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'private reply excluded' } },
  { type: 'content_block_stop', index: 0 },
];
const end = (usage: unknown = { output_tokens: 20 }) => ({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, ...(usage === undefined ? {} : { usage }) });
const stop = { type: 'message_stop' };
const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const captureSend = async (events: unknown[]) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse(events)));
  setApiRequestCaptureArmed(true);
  return createDialogueFetch(api)('unused', { method: 'POST', body: JSON.stringify(request) }, 0);
};
const waitCapture = async () => {
  await vi.waitFor(async () => {
    const capture = await DB.getApiRequestCapture();
    expect(capture).not.toBeNull();
    expect(capture?.rawUsageEvents).toBeDefined();
    expect(capture?.usageStatus).not.toBe('pending');
  });
  const capture = await DB.getApiRequestCapture();
  expect(capture).not.toBeNull();
  return capture!;
};
beforeEach(async () => { setApiRequestCaptureArmed(false); await DB.clearApiRequestCapture(); });
afterEach(() => { setApiRequestCaptureArmed(false); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('exports untouched start/delta usage including nested details and distinguishes them from merged statistics', async () => {
  const finalUsage = { output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 32265, provider_detail: { finished: true } };
  await captureSend([start(), ...textEvents, end(finalUsage), stop]);
  const capture = await waitCapture();
  expect(capture.rawUsageEvents).toEqual([
    { source: 'message_start', usage: startUsage }, { source: 'message_delta', usage: finalUsage },
  ]);
  expect(capture.responseUsage).toEqual({ ...startUsage, ...finalUsage });
  expect(capture).toMatchObject({ cacheReadTokens: 32265, cacheCreationTokens: 0, backendModel: 'upstream-model' });
  const txt = formatApiRequestCaptureTxt(capture);
  expect(txt).toContain('message_start'); expect(txt).toContain('message_delta');
  expect(txt).toContain('"ephemeral_5m_input_tokens": 32265');
  expect(txt).toContain('"nullable": null'); expect(txt).toContain('"flag": false');
  expect(txt).not.toContain('private reply excluded'); expect(txt).not.toContain(api.apiKey);
});

it.each(['truncated', 'provider-error', 'cancelled'] as const)('retains usage already received on %s without inventing final usage', async kind => {
  const events = [start(), ...textEvents, ...(kind === 'provider-error' ? [{ type: 'error', error: { message: 'provider failed' } }] : [])];
  if (kind === 'cancelled') {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse(events)));
    setApiRequestCaptureArmed(true);
    await expect(createDialogueFetch(api)('unused', { body: JSON.stringify(request), signal: controller.signal }, 0, 0, undefined, { onDelta: () => controller.abort() })).rejects.toThrow();
  } else await expect(captureSend(events)).rejects.toThrow();
  const capture = await waitCapture();
  expect(capture.usageStatus).toBe('failed');
  expect(capture.rawUsageEvents).toEqual([{ source: 'message_start', usage: startUsage }]);
  expect(capture.responseUsage).toBeUndefined();
  expect(formatApiRequestCaptureTxt(capture)).toContain('"cache_creation_input_tokens": 32265');
});

it('does not invent raw zeros or usage events when the stream returns no usage', async () => {
  const noUsageStart = start(); delete (noUsageStart.message as any).usage;
  const noUsageEnd = end(); delete (noUsageEnd as any).usage;
  await captureSend([noUsageStart, ...textEvents, noUsageEnd, stop]);
  const capture = await waitCapture();
  expect(capture.rawUsageEvents).toEqual([]);
  expect(capture.responseUsage).toEqual({});
  expect(capture.cacheReadTokens).toBeUndefined();
  expect(formatApiRequestCaptureTxt(capture)).toContain('缺失字段不等于返回了 0');
});

it('captures JSON usage when a proxy ignores stream=true', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: 'upstream-json', content: [{ type: 'text', text: 'ok' }], usage: startUsage }))));
  setApiRequestCaptureArmed(true);
  await createDialogueFetch(api)('unused', { body: JSON.stringify(request) }, 0);
  const capture = await waitCapture();
  expect(capture.rawUsageEvents).toEqual([{ source: 'response', usage: startUsage }]);
  expect(capture.responseUsage).toEqual(startUsage);
  expect(capture.backendModel).toBe('upstream-json');
});

it('also exports untouched OpenAI JSON and SSE usage through the existing capture boundary', async () => {
  const native = { prompt_tokens: 50, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 20 }, provider: { original: true } };
  for (const stream of [false, true]) {
    await DB.clearApiRequestCapture();
    setApiRequestCaptureArmed(true);
    const captureId = captureApiRequestOnce({ url: 'https://oai.test/v1/chat/completions', body: { model: 'oai', messages: [{ role: 'user', content: 'hi' }] } });
    updateApiRequestCaptureUsage({ captureId, ok: true, ...(stream
      ? { responseText: 'data: {"model":"upstream-oai","usage":null}\n\ndata: ' + JSON.stringify({ usage: native }) + '\n\ndata: [DONE]\n' }
      : { response: { model: 'upstream-oai', usage: native } }) });
    const capture = await waitCapture();
    expect(capture.rawUsageEvents).toEqual([{ source: stream ? 'stream_chunk' : 'response', usage: native }]);
    expect(capture.responseUsage).toEqual(native);
    expect(capture.cacheReadTokens).toBe(20);
    expect(formatApiRequestCaptureTxt(capture)).toContain('"original": true');
  }
});

it('keeps missing cache fields absent and snapshots nested objects independently of later mutations', () => {
  const usage = { output_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 10 } };
  const snapshot = snapshotApiRawUsage('message_start', usage)!;
  usage.cache_creation.ephemeral_5m_input_tokens = 99;
  expect(snapshot.usage).toEqual({ output_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 10 } });
  expect(snapshot.usage).not.toHaveProperty('cache_read_input_tokens');
  expect(snapshotApiRawUsage('response', null)).toBeUndefined();
  expect(snapshotApiRawUsage('response', [])).toBeUndefined();
});

it('bounds pathological usage event counts and explicitly reports omitted events', async () => {
  const deltas = Array.from({ length: MAX_API_RAW_USAGE_EVENTS + 3 }, (_, i) => end({ output_tokens: i }));
  await captureSend([start(), ...textEvents, ...deltas, stop]);
  const capture = await waitCapture();
  expect(capture.rawUsageEvents).toHaveLength(MAX_API_RAW_USAGE_EVENTS);
  expect(capture.rawUsageEventsDropped).toBe(4);
  expect(formatApiRequestCaptureTxt(capture)).toContain('另有 4 条 usage 事件未保存');
});

it('keeps successful replies intact if the diagnostic observer throws', async () => {
  const result = await readAnthropicResponse(sse([start(), ...textEvents, end(), stop]), undefined, undefined, undefined, undefined, () => { throw new Error('diagnostic failed'); });
  expect(result.content[0].text).toBe('private reply excluded');
  expect(result.usage).toEqual({ ...startUsage, output_tokens: 20 });
});

it('explains pending and old records without claiming zero usage', () => {
  const capture = buildApiRequestCapture({ url: 'https://usage.test/v1/messages', body: request });
  expect(formatApiRequestCaptureTxt(capture)).toContain('等待接口响应');
  capture.usageStatus = 'reported';
  expect(formatApiRequestCaptureTxt(capture)).toContain('旧记录未采集原始 usage');
});

it('leaves the capture empty while the one-shot switch is off', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sse([start(), ...textEvents, end(), stop])));
  await createDialogueFetch(api)('unused', { body: JSON.stringify(request) }, 0);
  expect(await DB.getApiRequestCapture()).toBeNull();
});

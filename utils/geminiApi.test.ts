import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLlm, anthropicContinuation, installAnthropicFetch } from './anthropicApi';
import { fetchGemini, fromGeminiResponse, geminiUsage, toGeminiRequest } from './geminiApi';
import { isGeminiEndpoint, llmApiType, normalizeLlmBaseUrl } from './llmEndpoint';
import { normalizeApiConfig } from './apiConfigNormalize';
import { configFromPreset } from './apiPresetSwitch';
import { pickDialogueApi, resolveDialogueApi } from './characterApi';
import { buildCharChatCredRow, normalizeChatApiUrl } from './amsgLlmCredentials';
import { createDialogueFetch } from './dialogueTransport';
import { safeFetchJson } from './safeApi';
import { extractApiTokenUsage } from './apiCallLog';
import { callLlm as sdkCallLlm, extractAssistantMessage } from '@rei-standard/amsg-shared';

const base = 'https://generativelanguage.googleapis.com/v1beta/models';
const originalFetch = globalThis.fetch;
const result = (parts: any[] = [{ text: '你好🙂' }], usage: any = { promptTokenCount: 100, candidatesTokenCount: 12, thoughtsTokenCount: 3, totalTokenCount: 115, cachedContentTokenCount: 64 }) => ({ responseId: 'g-test', modelVersion: 'gemini-test', candidates: [{ index: 0, content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: usage });
const tool = { type: 'function', function: { name: 'lookup', description: '查询', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false } } };
const body = { model: 'gemini-test', messages: [{ role: 'system', content: '固定人设' }, { role: 'user', content: '你好' }, { role: 'system', content: '当前提醒' }] };
function sse(events: any[], options: { close?: boolean; onCancel?: () => void } = {}) {
    const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); if (options.close !== false) controller.close(); }, cancel() { options.onCancel?.(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('Gemini native transport', () => {
    it('normalizes official and proxy endpoints, persists protocol across presets, roles and credentials', () => {
        const geminiBase = 'https://generativelanguage.googleapis.com/v1beta';
        for (const input of ['https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com/v1beta/', base, `${base}/gemini-test:generateContent`, 'https://generativelanguage.googleapis.com/v1beta/openai']) expect(normalizeLlmBaseUrl(input, 'gemini')).toBe(geminiBase);
        expect(normalizeLlmBaseUrl('https://proxy.test/prefix', 'gemini')).toBe('https://proxy.test/prefix/v1beta');
        expect(normalizeLlmBaseUrl('https://proxy.test/prefix/v1', 'gemini')).toBe('https://proxy.test/prefix/v1/models');
        expect(normalizeLlmBaseUrl('https://api.test', 'openai')).toBe('https://api.test/v1');
        expect(normalizeLlmBaseUrl('https://api.test/v1/chat/completions', 'openai')).toBe('https://api.test/v1');
        expect(normalizeLlmBaseUrl(base, 'openai')).toBe('https://generativelanguage.googleapis.com/v1');
        expect(llmApiType({ baseUrl: 'https://generativelanguage.googleapis.com' })).toBe('openai');
        expect(isGeminiEndpoint(`${base}/chat/completions`)).toBe(true);
        const api = normalizeApiConfig({ baseUrl: 'https://generativelanguage.googleapis.com', apiKey: ' key ', model: 'gemini-test', apiType: 'gemini' });
        expect(configFromPreset({ id: 'g', name: 'G', config: api })).toMatchObject({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiType: 'gemini' });
        expect(pickDialogueApi(api)).toMatchObject({ apiType: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
        expect(normalizeApiConfig({ ...api, geminiAuthMode: 'query' }).geminiAuthMode).toBe('query');
        expect(configFromPreset({ id: 'g', name: 'G', config: { ...api, geminiAuthMode: 'bearer' } })).toMatchObject({ geminiAuthMode: 'bearer' });
        expect(pickDialogueApi({ ...api, geminiAuthMode: 'auto' })).toMatchObject({ geminiAuthMode: 'auto' });
        expect(resolveDialogueApi(api, { dialogueApi: { ...api, geminiAuthMode: 'query' } }).geminiAuthMode).toBe('query');
        expect(resolveDialogueApi(api, { dialogueApi: { baseUrl: 'https://oai.test/v1', apiKey: 'other', model: 'm' } }).apiType).toBe('openai');
        expect(buildCharChatCredRow({ id: 'c' } as any, undefined, api)!.value).toMatchObject({ apiUrl: `${base}`, apiKey: 'key', primaryModel: 'gemini-test' });
        expect(normalizeChatApiUrl(base)).toBe(base);
    });
    it('keeps volatile system positions, converts images/tools/JSON, strips foreign cache markers', () => {
        const output = toGeminiRequest({ ...body, messages: [...body.messages, { role: 'user', content: [{ type: 'text', text: '看看' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }], temperature: 0, max_tokens: 8000, tools: [tool], tool_choice: { type: 'function', function: { name: 'lookup' } }, response_format: { type: 'json_schema', json_schema: { schema: { type: 'object', properties: {} } } }, prompt_cache_key: 'ignored', __sullyAnthropicOptions: { cache: true } });
        expect(output).not.toHaveProperty('systemInstruction');
        expect(output.contents[0].parts[0]).toEqual({ text: '固定人设' });
        expect(output.contents[0].parts[2].text).toContain('当前提醒');
        expect(output.contents[0].parts.at(-1)).toEqual({ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } });
        expect(output.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(tool.function.parameters);
        expect(output.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY', allowedFunctionNames: ['lookup'] });
        expect(output.generationConfig).toMatchObject({ temperature: 0, maxOutputTokens: 8000, responseMimeType: 'application/json' });
        for (const text of ['cache_control', 'prompt_cache_key', '__sully', 'stream_options']) expect(JSON.stringify(output)).not.toContain(text);
    });
    it('uses the shared dialogue route with the selected native endpoint and normalized key', async () => {
        const network = vi.fn(async () => Response.json(result())); globalThis.fetch = network;
        const response = await createDialogueFetch({ baseUrl: 'https://generativelanguage.googleapis.com', apiKey: ' key ', model: 'gemini-test', apiType: 'gemini' })('ignored', { method: 'POST', body: JSON.stringify(body) }, 0);
        expect(response.choices[0].message.content).toBe('你好🙂');
        const [url, init] = network.mock.calls[0] as any;
        expect(url).toBe(`${base}/gemini-test:generateContent`); expect(init.headers.get('x-goog-api-key')).toBe('key'); expect(init.headers.has('authorization')).toBe(false);
        expect(extractApiTokenUsage(response)).toEqual({ prompt: 100, completion: 15, total: 115, cacheRead: 64 });
        expect(geminiUsage({ promptTokenCount: 100, candidatesTokenCount: 10 }).prompt_tokens_details).toBeUndefined();
    });
    it.each([
        ['header', 'x-goog-api-key'], ['bearer', 'authorization'], ['query', 'query'],
    ] as const)('sends manual %s auth only in its selected location', async (mode, location) => {
        const network = vi.fn(async () => Response.json(result()));
        globalThis.fetch = network;
        await createDialogueFetch({ baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'secret key', model: 'gemini-test', apiType: 'gemini', geminiAuthMode: mode })('ignored', { method: 'POST', body: JSON.stringify(body) }, 0);
        const [rawUrl, init] = network.mock.calls[0] as any;
        const url = new URL(rawUrl), headers = new Headers(init.headers);
        expect(location === 'query' ? url.searchParams.get('key') : headers.get('x-goog-api-key') || headers.get('authorization')).toBe(location === 'query' ? 'secret key' : location === 'x-goog-api-key' ? 'secret key' : 'Bearer secret key');
        expect(headers.has('x-goog-api-key')).toBe(location === 'x-goog-api-key');
        expect(headers.has('authorization')).toBe(location === 'authorization');
        expect(location === 'query' ? url.searchParams.get('key') : null).toBe(location === 'query' ? 'secret key' : null);
        expect(headers.has('x-sully-gemini-api-key')).toBe(false);
    });
    it.each(['header', 'bearer', 'query'] as const)('uses %s auth for stream generation', async mode => {
        const network = vi.fn(async () => sse([{ candidates: [{ content: { parts: [{ text: '流式回复' }] }, finishReason: 'STOP' }] }]));
        globalThis.fetch = network;
        const response = await createDialogueFetch({ baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'stream-key', model: 'gemini-test', apiType: 'gemini', geminiAuthMode: mode })('ignored', { method: 'POST', body: JSON.stringify({ ...body, stream: true }) }, 0);
        expect(response.choices[0].message.content).toBe('流式回复');
        const [rawUrl, init] = network.mock.calls[0] as any;
        const url = new URL(rawUrl), headers = new Headers(init.headers);
        expect(headers.has('x-goog-api-key')).toBe(mode === 'header');
        expect(headers.has('authorization')).toBe(mode === 'bearer');
        expect(url.searchParams.get('key')).toBe(mode === 'query' ? 'stream-key' : null);
    });
    it.each(['header', 'bearer', 'query'] as const)('uses %s auth for model list GET', async mode => {
        const network = vi.fn(async () => Response.json({ models: [{ name: 'models/gemini-test' }] }));
        const response = await fetchGemini(`${base}/models`, { headers: { 'x-sully-gemini-auth-mode': mode, 'x-sully-gemini-api-key': 'list-key' } }, network);
        expect((await response.json()).data[0].id).toBe('gemini-test');
        const [rawUrl, init] = network.mock.calls[0] as any;
        const url = new URL(rawUrl), headers = new Headers(init.headers);
        expect(headers.has('x-goog-api-key')).toBe(mode === 'header');
        expect(headers.has('authorization')).toBe(mode === 'bearer');
        expect(url.searchParams.get('key')).toBe(mode === 'query' ? 'list-key' : null);
    });
    it('retries auto auth only for 401/403 and applies the same behavior to model GET', async () => {
        const network = vi.fn(async () => network.mock.calls.length < 3 ? new Response('denied', { status: network.mock.calls.length === 1 ? 401 : 403 }) : Response.json(result()));
        globalThis.fetch = network;
        const response = await createDialogueFetch({ baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'key', model: 'gemini-test', apiType: 'gemini', geminiAuthMode: 'auto' })('ignored', { method: 'POST', body: JSON.stringify(body) }, 0);
        expect(response.choices[0].message.content).toBe('你好🙂');
        expect(network).toHaveBeenCalledTimes(3);
        const attempts = network.mock.calls.map(([url, init]: any) => ({ url: new URL(url), headers: new Headers(init.headers) }));
        expect(attempts[0].headers.get('x-goog-api-key')).toBe('key');
        expect(attempts[1].headers.get('authorization')).toBe('Bearer key');
        expect(attempts[2].url.searchParams.get('key')).toBe('key');

        for (const status of [429, 500]) {
            const rejected = vi.fn(async () => new Response('no', { status }));
            const endpoint = `${base}/models`;
            await expect(fetchLlm(endpoint, { headers: { 'x-sully-gemini-auth-mode': 'auto', 'x-sully-gemini-api-key': 'key' } }, rejected)).resolves.toBeInstanceOf(Response);
            expect(rejected).toHaveBeenCalledTimes(1);
        }
        const get = vi.fn(async () => get.mock.calls.length === 1 ? new Response('denied', { status: 401 }) : Response.json({ models: [{ name: 'models/gemini-test' }] }));
        const listed = await fetchGemini(`${base}/models`, { headers: { 'x-sully-gemini-auth-mode': 'auto', 'x-sully-gemini-api-key': 'key' } }, get);
        expect((await listed.json()).data[0].id).toBe('gemini-test');
        expect(get).toHaveBeenCalledTimes(2);
        expect(new Headers((get.mock.calls[1] as any)[1].headers).get('authorization')).toBe('Bearer key');
    });
    it('preserves existing URL parameters and removes key from non-query modes', async () => {
        const calls: any[] = [];
        const transport = vi.fn(async (url: any, init: any) => { calls.push([url, init]); return Response.json({ models: [] }); });
        await fetchGemini(`${base}/models?pageToken=abc&key=old`, { headers: { 'x-sully-gemini-auth-mode': 'header', 'x-sully-gemini-api-key': 'new' } }, transport);
        expect(new URL(calls[0][0]).searchParams.get('pageToken')).toBe('abc');
        expect(new URL(calls[0][0]).searchParams.has('key')).toBe(false);
        expect(new Headers(calls[0][1].headers).get('x-goog-api-key')).toBe('new');
    });
    it('preserves signed parts and parallel function results through a local continuation', () => {
        const parts = [{ text: '先查一下', thought: true, thoughtSignature: 'signed-thought' }, { functionCall: { name: 'lookup', args: { q: '城市' }, id: 'native-id' }, thoughtSignature: 'signed-call' }, { functionCall: { name: 'lookup', args: { q: '天气' } } }];
        const first = fromGeminiResponse(result(parts)), message = first.choices[0].message;
        const request = toGeminiRequest({ ...body, messages: [body.messages[1], { role: 'assistant', content: 'placeholder', tool_calls: message.tool_calls, ...anthropicContinuation(message) }, ...message.tool_calls.map((c: any) => ({ role: 'tool', tool_call_id: c.id, content: '{"结果":"原文"}' }))] });
        expect(request.contents[1]).toEqual({ role: 'model', parts });
        expect(request.contents[2].parts).toHaveLength(2);
        expect(request.contents[2].parts[0].functionResponse).toEqual({ name: 'lookup', id: 'native-id', response: { result: '{"结果":"原文"}' } });
    });
    it('streams UTF-8 text, thought summaries, signatures, tools and trailing cache usage', async () => {
        const events = [{ responseId: 's', modelVersion: 'gemini-test', candidates: [{ content: { parts: [{ text: '想', thought: true }] } }] }, { candidates: [{ content: { parts: [{ text: '想🙂', thought: true, thoughtSignature: 'sig-thought' }, { text: '您好' }] } }] }, { candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: { q: '城市' } }, thoughtSignature: 'sig-call' }] }, finishReason: 'STOP' }] }, { usageMetadata: result().usageMetadata }];
        const network = vi.fn(async (..._args: any[]) => sse(events)); globalThis.fetch = network;
        const onDelta = vi.fn(), onReasoningDelta = vi.fn();
        const response = await safeFetchJson(`${base}/chat/completions`, { method: 'POST', body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }) }, 0, 5000, undefined, { onDelta, onReasoningDelta });
        expect(response.choices[0].message).toMatchObject({ content: '您好', reasoning_content: '想想🙂', tool_calls: [{ id: 'call_gemini_0', function: { name: 'lookup', arguments: '{"q":"城市"}' } }] });
        expect(response.choices[0].message.gemini_content[0]).toEqual({ text: '想想🙂', thought: true, thoughtSignature: 'sig-thought' });
        expect(response.choices[0].message.gemini_content.at(-1).thoughtSignature).toBe('sig-call');
        expect(response.usage.prompt_tokens_details.cached_tokens).toBe(64); expect(onDelta).toHaveBeenCalled(); expect(onReasoningDelta).toHaveBeenCalled();
        expect(network.mock.calls[0][0]).toBe(`${base}/gemini-test:streamGenerateContent?alt=sse`);
    });
    it.each(['truncated', 'error', 'blocked'])('rejects %s responses without retrying a paid model request', async mode => {
        const event = { candidates: [{ content: { parts: [{ text: '半句话' }] } }] };
        const network = vi.fn(async (..._args: any[]) => sse([event, ...(mode === 'error' ? [{ error: { message: 'overloaded' } }] : mode === 'blocked' ? [{ promptFeedback: { blockReason: 'SAFETY' } }] : [])])); globalThis.fetch = network;
        await expect(safeFetchJson(`${base}/chat/completions`, { method: 'POST', body: JSON.stringify({ ...body, stream: true }) }, 3, 5000)).rejects.toThrow(mode === 'truncated' ? '完成标记' : mode === 'blocked' ? 'SAFETY' : 'overloaded');
        expect(network).toHaveBeenCalledTimes(1);
    });
    it('paginates native models and keeps only generateContent models', async () => {
        const network = vi.fn(async (..._args: any[]) => Response.json(network.mock.calls.length === 1 ? { models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next' } : { models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }] }));
        const response = await fetchLlm(`${base}/models`, { headers: { Authorization: 'Bearer key' } }, network);
        expect((await response.json()).data.map((m: any) => m.id)).toEqual(['gemini-a', 'gemini-b']); expect(network.mock.calls[1][0]).toBe(`${base}?pageToken=next`);
    });
    it('accepts proxy models with missing capability metadata while excluding known non-generative models', async () => {
        const network = vi.fn(async () => Response.json({ models: [
            { name: 'gemini-4-argon', supportedGenerationMethods: null },
            { name: 'models/gemini-3.1-flash-lite' },
            { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/empty', supportedGenerationMethods: [] },
            { name: 'models/invalid', supportedGenerationMethods: 'generateContent' },
            { name: null, supportedGenerationMethods: null },
            { name: 'models/' },
        ] }));
        const response = await fetchLlm(`${base}/models`, { headers: { Authorization: 'Bearer key' } }, network);
        expect((await response.json()).data.map((m: any) => m.id)).toEqual(['gemini-4-argon', 'gemini-3.1-flash-lite']);
    });
    it('keeps signatures through the real amsg SDK tool continuation', async () => {
        const signed = [{ text: '检查', thought: true, thoughtSignature: 'sig' }, { functionCall: { name: 'lookup', args: { q: '城市' } }, thoughtSignature: 'tool-sig' }];
        const network = vi.fn(async (..._args: any[]) => Response.json(network.mock.calls.length === 1 ? result(signed) : result())); globalThis.fetch = network; installAnthropicFetch(false);
        const payload = { apiUrl: base, apiKey: 'key', primaryModel: 'gemini-test', messages: [{ role: 'user', content: '你好' }], tools: [tool] };
        const first = await sdkCallLlm(payload, { requireContent: false });
        const assistant = extractAssistantMessage(first.response);
        const second = await sdkCallLlm({ ...payload, messages: [...payload.messages, assistant, { role: 'tool', tool_call_id: (assistant as any).tool_calls[0].id, content: '结果' }] }, { requireContent: false });
        expect(second.content).toBe('你好🙂');
        expect(JSON.parse((network.mock.calls[1] as any)[1].body).contents[1]).toEqual({ role: 'model', parts: signed });
    });
    it('preserves authentication errors and propagates cancellation to an active native stream', async () => {
        const failure = vi.fn(async () => Response.json({ error: { message: 'bad key' } }, { status: 401 })); globalThis.fetch = failure;
        await expect(safeFetchJson(base, { method: 'POST', body: JSON.stringify(body) }, 3)).rejects.toThrow('bad key'); expect(failure).toHaveBeenCalledTimes(1);
        const controller = new AbortController(), onCancel = vi.fn();
        const response = await fetchLlm(base, { method: 'POST', body: JSON.stringify({ ...body, stream: true }), signal: controller.signal }, vi.fn(async () => sse([], { close: false, onCancel })));
        const reading = response.text(); controller.abort(new DOMException('cancelled', 'AbortError'));
        await expect(reading).rejects.toThrow('cancelled'); expect(onCancel).toHaveBeenCalledTimes(1);
    });
    it('fails unsupported content instead of silently dropping it', () => {
        expect(() => toGeminiRequest({ ...body, messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] })).toThrow('input_audio');
        expect(() => fromGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow('SAFETY');
    });
});

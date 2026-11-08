import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDialogueConnection } from './dialogueConnectionTest';
import { createDialogueFetch } from './dialogueTransport';
import { anthropicContinuation } from './anthropicApi';

const base = 'https://generativelanguage.googleapis.com';
const originalFetch = globalThis.fetch;
const response = (parts = [{ text: '连接成功' }] as any[]) => ({ candidates: [{ content: { parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5, cachedContentTokenCount: 20 } });
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('Gemini dialogue probes and chat share the native transport', () => {
  it.each(['apiType', 'protocol'] as const)('preserves the %s draft settings for streaming and nonstreaming probes', async alias => {
    for (const stream of [false, true]) {
      const network = vi.fn(async () => stream
        ? new Response('data: ' + JSON.stringify(response()) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
        : Response.json(response()));
      globalThis.fetch = network;
      const config = { baseUrl: base, apiKey: ' secret ', model: 'gemini-test', [alias]: 'gemini' as const, stream, temperature: 0, maxTokens: 6144, openaiPromptCache: true, anthropicPromptCache: true };
      expect(await testDialogueConnection(config)).toBe('连接成功');
      expect(network).toHaveBeenCalledTimes(1);
      const [url, init] = network.mock.calls[0] as any;
      expect(url).toBe(base + '/v1beta/models/gemini-test:' + (stream ? 'streamGenerateContent?alt=sse' : 'generateContent'));
      expect(new Headers(init.headers).get('x-goog-api-key')).toBe('secret');
      expect(new Headers(init.headers).has('authorization')).toBe(false);
      expect(JSON.parse(init.body)).toEqual({ contents: [{ role: 'user', parts: [{ text: 'Hi' }] }], generationConfig: { temperature: 0, maxOutputTokens: 6144 } });
      expect(JSON.stringify(config)).toContain(' secret ');
    }
  });
  it('uses the dialogue defaults rather than a five token probe limit', async () => {
    const network = vi.fn(async () => Response.json(response())); globalThis.fetch = network;
    await testDialogueConnection({ baseUrl: base, apiKey: 'key', model: 'gemini-test', apiType: 'gemini' });
    expect(JSON.parse((network.mock.calls[0] as any)[1].body).generationConfig).toEqual({ temperature: 0.85, maxOutputTokens: 8000 });
  });
  it.each(['apiType', 'protocol'] as const)('keeps signed tool turns through the actual dialogue fetch using %s', async alias => {
    const signed = [{ text: '检查', thought: true, thoughtSignature: 'sig-thought' }, { functionCall: { name: 'lookup', args: { q: '城市' }, id: 'native-call' }, thoughtSignature: 'sig-call' }];
    const network = vi.fn(async () => Response.json(response(network.mock.calls.length === 1 ? signed : undefined)));
    globalThis.fetch = network;
    const fetchChat = createDialogueFetch({ baseUrl: base, apiKey: ' key ', model: 'gemini-test', [alias]: 'gemini' });
    const messages: any[] = [{ role: 'system', content: '稳定人设\n保持原文' }, { role: 'developer', content: '稳定规则' }, { role: 'user', content: '查询' }, { role: 'system', content: '当前提醒' }];
    const options = { model: 'gemini-test', messages, temperature: 0.37, max_tokens: 8192, tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }] };
    const first = await fetchChat('unused', { method: 'POST', body: JSON.stringify(options) }, 0);
    const assistant = first.choices[0].message;
    const second = await fetchChat('unused', { method: 'POST', body: JSON.stringify({ ...options, messages: [...messages, { role: 'assistant', content: assistant.content, tool_calls: assistant.tool_calls, ...anthropicContinuation(assistant) }, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: '{"结果":"原文"}' }] }) }, 0);
    expect(second.choices[0].message.content).toBe('连接成功');
    const sent = JSON.parse((network.mock.calls[1] as any)[1].body);
    expect(sent.contents[0].parts).toEqual([{ text: '稳定人设\n保持原文' }, { text: '稳定规则' }, { text: '查询' }, { text: '<system-reminder>\n当前提醒\n</system-reminder>' }]);
    expect(sent.contents[1]).toEqual({ role: 'model', parts: signed });
    expect(sent.contents[2].parts).toEqual([{ functionResponse: { name: 'lookup', id: 'native-call', response: { result: '{"结果":"原文"}' } } }]);
    expect(sent.generationConfig).toEqual({ temperature: 0.37, maxOutputTokens: 8192 });
    expect(sent).not.toHaveProperty('systemInstruction');
    expect(network).toHaveBeenCalledTimes(2);
  });
});

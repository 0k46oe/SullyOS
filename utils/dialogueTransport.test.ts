import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDialogueFetch, dialogueEndpoint, dialogueHeaders, fromAnthropicResponse, toAnthropicBody } from './dialogueTransport';
import { configFromPreset, findActivePresetId } from './apiPresetSwitch';
import { pickDialogueApi, resolveDialogueApi } from './characterApi';
import { dataUrlToBlob, putImageBlob } from './blobRef';

const api = { protocol: 'anthropic' as const, baseUrl: 'https://native.test', apiKey: 'test-only-key', model: 'test-model' };
const body = { model: api.model, messages: [{ role: 'system', content: '角色设定' }, { role: 'user', content: '你好' }], max_tokens: 8000 };
const response = { id: 'test-message', model: api.model, content: [{ type: 'text', text: '你好呀' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
afterEach(() => vi.unstubAllGlobals());

describe('native Anthropic local chat', () => {
  it('accepts origin, versioned base and full endpoint without repeating /v1/messages', () => {
    for (const baseUrl of ['https://native.test', 'https://native.test/v1/', 'https://native.test/v1/messages']) {
      expect(dialogueEndpoint({ ...api, baseUrl })).toBe('https://native.test/v1/messages');
      expect(dialogueEndpoint({ ...api, baseUrl }, 'models')).toBe('https://native.test/v1/models');
    }
    expect(dialogueHeaders(api)).toMatchObject({ 'x-api-key': api.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
    expect(dialogueHeaders(api)).not.toHaveProperty('Authorization');
  });
  it('moves every system block to the top, merges adjacent turns, preserves history and omits proxy dialects', () => {
    const next = toAnthropicBody({ ...body, stream: true, temperature: 2, thinking: { type: 'enabled', budget_tokens: 4000 }, reasoning_effort: 'high',
      messages: [body.messages[0], { role: 'assistant', content: '已有回复' }, { role: 'system', content: '当轮规则' }, body.messages[1], { role: 'user', content: '补充' }] });
    expect(next.system).toEqual([{ type: 'text', text: '角色设定', cache_control: { type: 'ephemeral' } }, { type: 'text', text: '当轮规则' }]);
    expect(next.stream).toBe(true);
    expect(next.messages[0].role).toBe('user');
    expect(next.messages[1].content[0].text).toBe('已有回复');
    expect(next.messages[2].content).toEqual([{ type: 'text', text: '你好' }, { type: 'text', text: '补充' }]);
    expect(next.thinking).toEqual({ type: 'enabled', budget_tokens: 4000 }); expect(next).not.toHaveProperty('temperature');
    expect(next).not.toHaveProperty('reasoning_effort');
  });
  it('returns the completion shape expected by the existing parser and token accounting', () => {
    const result = fromAnthropicResponse(response);
    expect(result.choices[0].message.content).toBe('你好呀');
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(fromAnthropicResponse({ ...response, stop_reason: 'max_tokens' }).choices[0].finish_reason).toBe('length');
    expect(() => fromAnthropicResponse({ error: { message: 'bad key' } })).toThrow('bad key');
    expect(() => fromAnthropicResponse({ choices: [] })).toThrow('返回格式');
  });
  it('keeps non-streaming available and never forwards OpenAI stream_options', () => {
    expect(toAnthropicBody(body).stream).toBe(false);
    expect(toAnthropicBody({ ...body, stream: false }).stream).toBe(false);
    expect(toAnthropicBody({ ...body, stream: true, stream_options: { include_usage: true } })).not.toHaveProperty('stream_options');
  });
  it.each([0, 0.37, 1])('sends custom native temperature %s only on explicit opt-in, including image and streaming requests', async temperature => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(response))));
    vi.stubGlobal('fetch', fetch);
    for (const stream of [false, true]) {
      await createDialogueFetch({ ...api, temperature, anthropicCustomTemperature: true })('unused', { method: 'POST', body: JSON.stringify({ ...body, temperature: 0.85, stream,
        messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQIDBA==' } }] }] }) });
      const request = JSON.parse(fetch.mock.calls.at(-1)![1].body);
      expect(request).toMatchObject({ temperature, stream });
      expect(request.messages[0].content[1].source.type).toBe('base64');
    }
  });
  it('omits native temperature in default mode and uses the selected config for a connection-test body', async () => {
    expect(toAnthropicBody({ ...body, temperature: 0.85 }, { temperature: 0.37 })).not.toHaveProperty('temperature');
    expect(toAnthropicBody({ ...body, temperature: 0.85 }, { temperature: 0.37, anthropicCustomTemperature: false })).not.toHaveProperty('temperature');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetch);
    await createDialogueFetch({ ...api, temperature: 0.42, anthropicCustomTemperature: true })('unused', { method: 'POST', body: JSON.stringify(body) });
    expect(JSON.parse(fetch.mock.calls[0][1].body).temperature).toBe(0.42);
  });
  it.each([-0.01, 1.01, NaN, Infinity])('rejects invalid custom native temperature %s before a network request', async temperature => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(createDialogueFetch({ ...api, temperature, anthropicCustomTemperature: true })('unused', { method: 'POST', body: JSON.stringify(body) })).rejects.toThrow('0～1');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('surfaces a model temperature rejection once without changing configuration or retrying', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'temperature is not supported by this model' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const config = { ...api, temperature: 0.37, anthropicCustomTemperature: true };
    await expect(createDialogueFetch(config)('unused', { method: 'POST', body: JSON.stringify(body) }, 3)).rejects.toThrow('temperature is not supported');
    expect(fetch).toHaveBeenCalledOnce(); expect(config.temperature).toBe(0.37);
  });
  it('converts automatically injected local tools and their follow-up results', () => {
    const converted = toAnthropicBody({ ...body, tools: [{ type: 'function', function: { name: 'test_tool', parameters: { type: 'object' } } }], tool_choice: 'auto',
      messages: [...body.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call-test', function: { name: 'test_tool', arguments: '{"q":"test"}' } }] },
        { role: 'tool', tool_call_id: 'call-test', content: '完成' }] });
    expect(converted.tools[0]).toEqual({ name: 'test_tool', input_schema: { type: 'object' } });
    expect(converted.messages[1].content[0]).toMatchObject({ type: 'tool_use', input: { q: 'test' } });
    expect(converted.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call-test', content: '完成' });
    const data = fromAnthropicResponse({ ...response, content: [{ type: 'tool_use', id: 'call-test', name: 'test_tool', input: { q: 'test' } }] });
    expect(data.choices[0].message.tool_calls[0].function.arguments).toBe('{"q":"test"}');
  });
  it('sends the native wire format with cancellation and does not retry paid failed requests', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const send = createDialogueFetch(api);
    expect((await send('unused', { method: 'POST', signal: controller.signal, body: JSON.stringify(body) })).choices[0].message.content).toBe('你好呀');
    expect(fetch.mock.calls[0][0]).toBe('https://native.test/v1/messages');
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ stream: false, system: [{ type: 'text', text: '角色设定', cache_control: { type: 'ephemeral' } }] });
    await expect(send('unused', { method: 'POST', body: JSON.stringify(body) }, 2)).rejects.toThrow('overloaded');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('leaves legacy OpenAI URL, headers, body and response unchanged', async () => {
    const expected = { choices: [{ message: { content: 'legacy reply' } }] };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(expected)));
    vi.stubGlobal('fetch', fetch);
    const legacy = { ...api, protocol: undefined };
    const options = { method: 'POST', headers: dialogueHeaders(legacy), body: JSON.stringify(body) };
    expect(await createDialogueFetch(legacy)('https://legacy.test/v1/chat/completions', options)).toEqual(expected);
    expect(fetch.mock.calls[0][0]).toBe('https://legacy.test/v1/chat/completions');
    expect(fetch.mock.calls[0][1].body).toBe(options.body);
    expect(fetch.mock.calls[0][1].headers).toEqual(options.headers);
  });
  it('keeps protocol with presets and role snapshots; an old role API never inherits native mode', () => {
    const preset = { id: 'native', name: 'native', config: api };
    expect(pickDialogueApi(api).protocol).toBe('anthropic');
    expect(configFromPreset(preset).protocol).toBe('anthropic');
    expect(findActivePresetId([preset], { ...api, protocol: 'openai' })).toBeNull();
    expect(resolveDialogueApi(api, { dialogueApi: { baseUrl: 'https://old.test/v1', apiKey: '', model: 'old' } }).protocol).toBe('openai');
    expect(configFromPreset({ ...preset, config: { ...api, protocol: undefined } }).protocol).toBe('openai');
  });
  it.each(['png', 'jpeg', 'gif', 'webp'])('converts embedded %s images without losing surrounding text', format => {
    const converted = toAnthropicBody({ messages: [{ role: 'user', content: [
      { type: 'text', text: '先看这张图' },
      { type: 'image_url', image_url: { url: `data:image/${format};base64,AQIDBA==`, detail: 'high' } },
      { type: 'text', text: '再回答问题' },
    ] }] });
    expect(converted.messages[0].content).toEqual([
      { type: 'text', text: '先看这张图' },
      { type: 'image', source: { type: 'base64', media_type: `image/${format}`, data: 'AQIDBA==' } },
      { type: 'text', text: '再回答问题' },
    ]);
  });
  it('keeps history, multiple images, remote URLs and image-only messages in order', () => {
    const converted = toAnthropicBody({ messages: [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://images.test/old.png?a=1&b=2' } }] },
      { role: 'assistant', content: '上一张图片的回复' },
      { role: 'user', content: [{ type: 'text', text: '比较这两张' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AQIDBA==' } },
        { type: 'image_url', image_url: { url: 'https://images.test/new.jpg' } }] },
    ] });
    expect(converted.messages).toHaveLength(3);
    expect(converted.messages[0].content).toEqual([{ type: 'image', source: { type: 'url', url: 'https://images.test/old.png?a=1&b=2' } }]);
    expect(converted.messages[1].content[0].text).toBe('上一张图片的回复');
    expect(converted.messages[2].content.filter((block: any) => block.type === 'image')).toHaveLength(2);
  });
  it('handles full-size base64 payloads without recursive regex failures', () => {
    const data = 'AAAA'.repeat(350_000);
    const converted = toAnthropicBody({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }] }] });
    expect(converted.messages[0].content[0].source.data).toBe(data);
  });
  it('restores current and historical local image references before native conversion and sanitizes inline references', async () => {
    const image = 'data:image/png;base64,AQIDBA==';
    const ref = await putImageBlob(dataUrlToBlob(image));
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetch);
    await createDialogueFetch(api)('unused', { method: 'POST', body: JSON.stringify({ ...body, messages: [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: ref } }] },
      { role: 'assistant', content: '看到了上一张图' },
      { role: 'user', content: [{ type: 'text', text: `再看这张 ${ref}` }, { type: 'image_url', image_url: { url: ref } }] },
    ] }) });
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent.messages[0].content[0].source).toEqual({ type: 'base64', media_type: 'image/png', data: 'AQIDBA==' });
    expect(sent.messages[2].content).toEqual([
      { type: 'text', text: '再看这张 [图片]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQIDBA==' } },
    ]);
    expect(JSON.stringify(sent)).not.toContain('blobref:');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['', 'blobref:b_missing_image', 'data:image/svg+xml;base64,AQIDBA==', 'data:image/png;base64,broken?', 'blob:local-only', 'file:///local.png'])('rejects unavailable or unsupported images before any model request: %s', async url => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(createDialogueFetch(api)('unused', { method: 'POST', body: JSON.stringify({ ...body,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }],
    }) })).rejects.toThrow(/图片/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects images in system messages and unknown content blocks explicitly', () => {
    expect(() => toAnthropicBody({ messages: [{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'https://images.test/a.png' } }] }] })).toThrow('系统提示词不支持图片');
    expect(() => toAnthropicBody({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] })).toThrow('不支持的消息内容');
  });
  it('does not send an image request after cancellation during local reference restoration', async () => {
    const ref = await putImageBlob(dataUrlToBlob('data:image/png;base64,AQIDBA=='));
    const controller = new AbortController();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const run = createDialogueFetch(api)('unused', { method: 'POST', signal: controller.signal, body: JSON.stringify({ ...body,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: ref } }] }],
    }) });
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves OpenAI multimodal images and restores their local references using the original route', async () => {
    const image = 'data:image/png;base64,AQIDBA==';
    const ref = await putImageBlob(dataUrlToBlob(image));
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '旧接口看图回复' } }] })));
    vi.stubGlobal('fetch', fetch);
    await createDialogueFetch({ ...api, protocol: 'openai' })('https://legacy.test/v1/chat/completions', { method: 'POST',
      body: JSON.stringify({ ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: ref, detail: 'high' } }] }] }),
    });
    expect(fetch.mock.calls[0][0]).toBe('https://legacy.test/v1/chat/completions');
    expect(JSON.parse(fetch.mock.calls[0][1].body).messages[0].content).toEqual([{ type: 'image_url', image_url: { url: image, detail: 'high' } }]);
  });
});

describe('OpenAI-compatible local chat', () => {
  it('adds prompt_cache_key without Anthropic cache_control', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })));
    vi.stubGlobal('fetch', fetch);
    await createDialogueFetch({ ...api, protocol: 'openai', baseUrl: 'https://oai.test', openaiPromptCache: true })('https://oai.test/v1/chat/completions', { method: 'POST',
      body: JSON.stringify(body),
    });
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent.prompt_cache_key).toMatch(/^oai-/);
    expect(sent).not.toHaveProperty('cache_control');
  });
});

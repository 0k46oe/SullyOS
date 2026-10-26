// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useChatAI } from '../hooks/useChatAI';
import { DB } from './db';
import { dataUrlToBlob, putImageBlob } from './blobRef';
import { stopReplyRuns } from './chatReplyCancellation';
import { Blob as NodeBlob } from 'node:buffer';

vi.mock('../context/MusicContext', () => ({ useMusic: () => ({}), loadMusicHooks: () => null }));
vi.mock('./keepAlive', () => ({ KeepAlive: { start: vi.fn(), stop: vi.fn() } }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const reply = '我看到了你发来的图片。';
const completion = { id: 'image-reply', role: 'assistant', model: 'vision-test-model', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } };
const streamEvents = [
  { type: 'message_start', message: { ...completion, content: [], usage: { input_tokens: 20, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我看到了' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你发来的图片。' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
  { type: 'message_stop' },
];

// fake-indexeddb uses Node's structuredClone: it cannot preserve jsdom Blobs.
// Exercise the real storage/resolver with a cloneable Blob and its arrayBuffer
// fallback. Actual browser Blob/FileReader integration is also checked in Edge.
function useCloneableBlobs() {
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('FileReader', undefined);
}

it.each([false, true])('real private chat sends current and historical images to the same native API with stream=%s', async stream => {
  useCloneableBlobs();
  const char = { id: `native-image-${stream}`, name: '图片测试角色', emotionConfig: { enabled: false },
    dialogueApi: { baseUrl: 'https://native.test', apiKey: 'fake-native-key', model: 'vision-test-model', protocol: 'anthropic', stream } } as any;
  const ref = await putImageBlob(dataUrlToBlob(image));
  await DB.saveCharacter(char);
  for (const message of [
    { role: 'user', type: 'image', content: ref },
    { role: 'assistant', type: 'text', content: '之前的图片回复' },
    { role: 'user', type: 'image', content: image },
    { role: 'user', type: 'image', content: 'https://images.test/new.jpg' },
    { role: 'user', type: 'text', content: '帮我比较这些图片' },
  ]) await DB.saveMessage({ charId: char.id, ...message } as any);
  const fetch = vi.fn(async () => new Response(stream
    ? streamEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    : JSON.stringify(completion), { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  let current!: ReturnType<typeof useChatAI>;
  function Probe() {
    current = useChatAI({ char, apiConfig: { baseUrl: 'https://global.test/v1', apiKey: 'fake-global-key', model: 'global-model', visionApi: { enabled: false } } as any,
      userProfile: { name: '用户' } as any, groups: [], emojis: [], categories: [], realtimeConfig: {} as any,
      addToast: vi.fn(), setMessages: vi.fn(), updateCharacter: vi.fn(), updateUserProfile: vi.fn() });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await current.triggerAI([]); });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = (fetch.mock.calls as unknown as Array<[string, RequestInit]>)[0];
    expect(url).toBe('https://native.test/v1/messages');
    expect(options.headers).toMatchObject({ 'x-api-key': 'fake-native-key' });
    const sent = JSON.parse(options.body as string);
    expect(sent.model).toBe('vision-test-model');
    expect(sent.stream).toBe(stream);
    const blocks = sent.messages.flatMap((message: any) => message.content);
    expect(blocks.filter((block: any) => block.type === 'image')).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.split(',')[1] } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.split(',')[1] } },
      { type: 'image', source: { type: 'url', url: 'https://images.test/new.jpg' } },
    ]);
    expect(JSON.stringify(sent)).toContain('之前的图片回复');
    expect(JSON.stringify(sent)).toContain('帮我比较这些图片');
    expect(JSON.stringify(sent)).not.toContain('blobref:');
    expect(JSON.stringify(sent)).not.toContain('fake-global-key');
    const saved = await DB.getRecentMessagesByCharId(char.id, 20);
    expect(saved.filter(message => message.role === 'assistant').map(message => message.content)).toEqual(['之前的图片回复', reply]);
    expect(current.isTyping).toBe(false);
    expect(current.streamingBubbles).toEqual([]);
  } finally { stopReplyRuns(char.id); act(() => root.unmount()); }
}, 15_000);

it.each([false, true])('keeps explicitly enabled independent vision optional with native stream=%s', async stream => {
  useCloneableBlobs();
  const char = { id: `native-independent-vision-${stream}`, name: '独立识图测试角色', emotionConfig: { enabled: false },
    dialogueApi: { baseUrl: 'https://native.test', apiKey: 'fake-native-key', model: 'vision-test-model', protocol: 'anthropic', stream } } as any;
  const ref = await putImageBlob(dataUrlToBlob(image));
  await DB.saveCharacter(char);
  await DB.saveMessage({ charId: char.id, role: 'user', type: 'image', content: ref } as any);
  const description = '一张用于测试的图片描述';
  const fetch = vi.fn(async (url: string) => {
    if (url === 'https://vision.test/v1/chat/completions') return new Response(JSON.stringify({ choices: [{ message: { content: description } }] }));
    return new Response(stream ? streamEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') : JSON.stringify(completion),
      { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  let current!: ReturnType<typeof useChatAI>;
  function Probe() {
    current = useChatAI({ char, apiConfig: { baseUrl: 'https://global.test/v1', apiKey: 'fake-global-key', model: 'global-model',
      visionApi: { enabled: true, baseUrl: 'https://vision.test/v1', apiKey: 'fake-vision-key', model: 'independent-vision' } } as any,
      userProfile: { name: '用户' } as any, groups: [], emojis: [], categories: [], realtimeConfig: {} as any,
      addToast: vi.fn(), setMessages: vi.fn(), updateCharacter: vi.fn(), updateUserProfile: vi.fn() });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await current.triggerAI([]); });
    expect(fetch).toHaveBeenCalledTimes(2);
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(call => call[0])).toEqual(['https://vision.test/v1/chat/completions', 'https://native.test/v1/messages']);
    expect(calls[0][1].headers).toMatchObject({ Authorization: 'Bearer fake-vision-key' });
    expect(JSON.parse(calls[0][1].body as string).messages[0].content[1]).toEqual({ type: 'image_url', image_url: { url: image } });
    const sent = JSON.parse(calls[1][1].body as string);
    expect(sent.stream).toBe(stream);
    expect(JSON.stringify(sent.messages)).toContain(description);
    expect(sent.messages.flatMap((message: any) => message.content).some((block: any) => block.type === 'image')).toBe(false);
    expect(JSON.stringify(sent)).not.toContain('blobref:');
    expect((await DB.getRecentMessagesByCharId(char.id, 20)).filter(message => message.role === 'assistant').map(message => message.content)).toEqual([reply]);
  } finally { stopReplyRuns(char.id); act(() => root.unmount()); }
}, 15_000);

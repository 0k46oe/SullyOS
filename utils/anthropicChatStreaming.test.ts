// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useChatAI } from '../hooks/useChatAI';
import { DB } from './db';
import { publishReplyDisplay, stopReplyRuns } from './chatReplyCancellation';
import { putImageBlob, dataUrlToBlob } from './blobRef';
import { Blob as NodeBlob } from 'node:buffer';

vi.mock('../context/MusicContext', () => ({ useMusic: () => ({}), loadMusicHooks: () => null }));
vi.mock('./keepAlive', () => ({ KeepAlive: { start: vi.fn(), stop: vi.fn() } }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const encode = (events: object[]) => new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
const begin = [
  { type: 'message_start', message: { id: 'msg_hook', model: 'claude-test', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
];
const text = (value: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } });
const finish = [
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
  { type: 'message_stop' },
];

const cases = (['complete', 'error', 'cancel'] as const).flatMap(outcome => ([false, true].map(image => ({ outcome, image }))));
it.each(cases)('native stream reaches the real chat hook and handles $outcome (image=$image) without duplicate replies', async ({ outcome, image }) => {
  const char = { id: `native-stream-${outcome}-${image}`, name: '流式测试角色', emotionConfig: { enabled: false },
    dialogueApi: { baseUrl: 'https://native.test', apiKey: 'fake-test-key', model: 'claude-test', protocol: 'anthropic', stream: true } } as any;
  await DB.saveCharacter(char);
  if (image) {
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('FileReader', undefined);
    const ref = await putImageBlob(dataUrlToBlob('data:image/png;base64,AQIDBA=='));
    await DB.saveMessage({ charId: char.id, role: 'user', type: 'image', content: ref } as any);
  }
  await DB.saveMessage({ charId: char.id, role: 'user', type: 'text', content: '流式测试' } as any);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }), { headers: { 'content-type': 'text/event-stream' } });
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  const fetch = vi.fn(async () => { started(); return response; });
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  let current!: ReturnType<typeof useChatAI>;
  const setMessages = vi.fn();
  function Probe() {
    current = useChatAI({ char, apiConfig: { baseUrl: 'https://global.test/v1', apiKey: 'global', model: 'global' }, userProfile: { name: '用户' } as any,
      groups: [], emojis: [], categories: [], realtimeConfig: {} as any, addToast: vi.fn(), setMessages,
      updateCharacter: vi.fn(), updateUserProfile: vi.fn() });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  let run: Promise<void> | undefined;
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {
      run = current.triggerAI([]);
      await requestStarted;
      controller.enqueue(encode([...begin, text('已经显示的正文')]));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(current.streamingBubbles).toEqual(['已经显示的正文']);
    expect((await DB.getRecentMessagesByCharId(char.id, 20)).filter(message => message.role === 'assistant')).toEqual([]);
    const options = (fetch.mock.calls as unknown as Array<[string, RequestInit]>)[0][1];
    expect(options.headers).toMatchObject({ 'x-api-key': 'fake-test-key' });
    expect(JSON.parse(options.body as string)).toMatchObject({ stream: true, model: 'claude-test' });
    const images = JSON.parse(options.body as string).messages.flatMap((message: any) => message.content).filter((block: any) => block.type === 'image');
    expect(images).toHaveLength(image ? 1 : 0);
    if (image) expect(images[0].source).toEqual({ type: 'base64', media_type: 'image/png', data: 'AQIDBA==' });
    await act(async () => {
      if (outcome === 'complete') controller.enqueue(encode([text('，完整回复。'), ...finish]));
      else if (outcome === 'error') controller.enqueue(encode([{ type: 'error', error: { message: '测试中的流式故障' } }]));
      else { publishReplyDisplay(char.id, [], current.streamingBubbles); stopReplyRuns(char.id); }
      await run;
    });
    expect(current.streamingBubbles).toEqual([]);
    expect(current.isTyping).toBe(false);
    const saved = await DB.getRecentMessagesByCharId(char.id, 20);
    const replies = saved.filter(message => message.role === 'assistant').map(message => message.content);
    if (outcome === 'complete') expect(replies).toEqual(['已经显示的正文，完整回复。']);
    else if (outcome === 'error') {
      expect(replies).toEqual([]);
      expect(saved.some(message => message.role === 'system' && message.content.includes('测试中的流式故障'))).toBe(true);
    } else {
      expect(options.signal?.aborted).toBe(true);
      expect(replies).toEqual(['已经显示的正文']);
    }
    expect(fetch).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  } finally {
    stopReplyRuns(char.id);
    if (run) await act(async () => { await run; });
    act(() => root.unmount());
  }
}, 15_000);

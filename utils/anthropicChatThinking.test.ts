// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useChatAI } from '../hooks/useChatAI';
import { DB } from './db';
import { stopReplyRuns } from './chatReplyCancellation';

vi.mock('../context/MusicContext', () => ({ useMusic: () => ({}), loadMusicHooks: () => null }));
vi.mock('./keepAlive', () => ({ KeepAlive: { start: vi.fn(), stop: vi.fn() } }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each([false, true])('saves native non-stream thinking separately from the reply (image=%s)', async image => {
  const char = { id: `native-json-thinking-${image}`, name: '思考测试角色', showThinkingChain: true, emotionConfig: { enabled: false },
    dialogueApi: { baseUrl: 'https://native.test', apiKey: 'test-only', model: '【反重力】claude-opus-4-6-thinking', protocol: 'anthropic', stream: false,
      anthropicCustomTemperature: true, temperature: 0.37, anthropicPromptCache: true } } as any;
  await DB.saveCharacter(char);
  await DB.saveMessage({ charId: char.id, role: 'user', type: image ? 'image' : 'text', content: image ? 'data:image/png;base64,AQIDBA==' : '你好' } as any);
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'test-native-thinking', content: [
    { type: 'thinking', thinking: '仅展示服务提供的思考摘要', signature: 'opaque-test-signature' },
    { type: 'redacted_thinking', data: 'opaque-redacted-data' }, { type: 'text', text: '正常正文回复' },
  ], usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 4096 } })));
  vi.stubGlobal('fetch', fetch);
  let current!: ReturnType<typeof useChatAI>;
  function Probe() {
    current = useChatAI({ char, apiConfig: { baseUrl: 'https://global.test/v1', apiKey: 'test', model: 'global' }, userProfile: { name: '用户' } as any,
      groups: [], emojis: [], categories: [], realtimeConfig: {} as any, addToast: vi.fn(), setMessages: vi.fn(), updateCharacter: vi.fn(), updateUserProfile: vi.fn() });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await current.triggerAI([]); });
    expect(fetch).toHaveBeenCalledOnce();
    const request = JSON.parse(fetch.mock.calls[0][1].body);
    expect(request).toMatchObject({ model: char.dialogueApi.model, stream: false, thinking: { type: 'enabled', budget_tokens: 4000 } });
    expect(request).not.toHaveProperty('temperature');
    expect(request.system[0].cache_control).toEqual({ type: 'ephemeral' });
    const messages = (await DB.getRecentMessagesByCharId(char.id, 20)).filter(message => message.role === 'assistant');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('正常正文回复');
    expect(messages[0].metadata?.thinkingChain).toBe('仅展示服务提供的思考摘要');
    expect(JSON.stringify(messages)).not.toMatch(/opaque-test-signature|opaque-redacted-data/);
    expect(request.messages.flatMap((message: any) => message.content).filter((block: any) => block.type === 'image')).toHaveLength(image ? 1 : 0);
    expect(current.streamingThinking).toBe('');
  } finally { stopReplyRuns(char.id); act(() => root.unmount()); }
}, 15_000);

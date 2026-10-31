// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DB, openDB } from './db';
import { writeV2Backup, assembleV2Backup, createV2ArrayFieldWriter } from './backupFormat';
import { stripBackupImages } from './backupExport';
import { normalizeCharacterDefaults, normalizeCharacterImpression } from './impression';
import { migrateCharacterContextRange } from './chatContextRange';
import { normalizeApiPreset } from './apiConfigNormalize';
import { useChatAI } from '../hooks/useChatAI';
import { safeFetchJson } from './safeApi';

vi.mock('../context/MusicContext', () => ({ useMusic: () => ({}), loadMusicHooks: () => null }));
vi.mock('./keepAlive', () => ({ KeepAlive: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('./safeApi', async importOriginal => ({ ...await importOriginal<typeof import('./safeApi')>(), safeFetchJson: vi.fn() }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const globalApi = { baseUrl: 'https://global.test/v1', apiKey: 'global-key', model: 'global-model', stream: true, temperature: 0.3, maxTokens: 2048 };
const roleApi = { baseUrl: 'https://role.test/v1', apiKey: 'role-key', model: 'role-model', stream: false, temperature: 1.2, maxTokens: 16000 };
const appApi = { baseUrl: 'https://app.test/v1', apiKey: 'app-key', model: 'app-model' };
const preset = { id: 'role-preset', name: '角色模型', group: '写作', config: roleApi };
async function clearCharacters() {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('characters', 'readwrite');
        tx.objectStore('characters').clear();
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
}
afterEach(() => { vi.clearAllMocks(); });

it.each(['full', 'text_only'] as const)('%s ZIP preserves native temperature opt-in through role restore and the real private-chat hook', async mode => {
    const native = { ...roleApi, protocol: 'anthropic' as const, baseUrl: 'https://native.test', model: 'claude-test-model', stream: true, temperature: 0.37, anthropicCustomTemperature: true, anthropicPromptCache: false };
    const original = { characterUserProfile: { enabled: true, name: '专属玩家', bio: '专属故事背景' }, id: `native-private-chat-${mode}`, name: '原生测试角色', dialogueApi: native, showThinkingChain: false, emotionConfig: { enabled: false } } as any;
    await clearCharacters(); await DB.saveCharacter(original);
    const zip = new JSZip();
    const data: any = { apiConfig: native, apiPresets: [{ ...preset, config: native }] };
    const prewrittenStores: any = {};
    if (mode === 'text_only') {
        const writer = createV2ArrayFieldWriter(zip, 'characters');
        await DB.streamRawStoreData('characters', item => { writer.appendSync([stripBackupImages(item)]); });
        prewrittenStores.characters = await writer.finish();
    } else data.characters = await DB.getRawStoreData('characters');
    await writeV2Backup(zip, data, { prewrittenStores });
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
    const restored: any = await assembleV2Backup(loaded, JSON.parse(await loaded.file('manifest.json')!.async('string')));
    expect(restored.apiConfig).toEqual(native); expect(restored.apiPresets.map(normalizeApiPreset)[0].config).toMatchObject({ ...native, apiType: 'anthropic', baseUrl: 'https://native.test/v1/messages' });
    await clearCharacters(); await DB.importFullData(restored);
    const saved = (await DB.getAllCharacters()).find(item => item.id === original.id)!;
    const char = migrateCharacterContextRange(normalizeCharacterDefaults(normalizeCharacterImpression(saved))).character;
    expect(char.dialogueApi).toEqual(native);
    await DB.saveCharacter(char);
    await DB.saveMessage({ charId: char.id, role: 'user', type: 'text', content: '普通文字聊天测试' } as any);
    let current!: ReturnType<typeof useChatAI>;
    function Probe() {
        current = useChatAI({ char, apiConfig: globalApi, userProfile: { name: '用户' } as any,
            groups: [], emojis: [], categories: [], realtimeConfig: {} as any,
            addToast: vi.fn(), setMessages: vi.fn(), updateCharacter: vi.fn(), updateUserProfile: vi.fn() });
        return null;
    }
    const root = createRoot(document.createElement('div'));
    vi.mocked(safeFetchJson).mockRejectedValue(new Error('test: native request captured'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        await act(async () => root.render(createElement(Probe)));
        await act(async () => { await current.triggerAI([]); });
        expect(safeFetchJson).toHaveBeenCalledOnce();
        const [url, init] = vi.mocked(safeFetchJson).mock.calls[0];
        expect(url).toBe('https://native.test/v1/messages/chat/completions');
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ' + native.apiKey);
        const request = JSON.parse(init.body as string);
        expect(request.model).toBe(native.model); expect(request.stream).toBe(true); expect(request.temperature).toBe(0.37);
        expect(request.__sullyAnthropicOptions).toMatchObject({ cache: false, customTemperature: true });
        expect(request.messages[0].content).toContain('原生测试角色');
        expect(request.messages[0].content).toContain('专属玩家');
        expect(request.messages[0].content).toContain('专属故事背景');
        expect(char.characterUserProfile).toEqual(original.characterUserProfile);
        expect(JSON.stringify(request.messages)).toContain('普通文字聊天测试');
    } finally { act(() => root.unmount()); errors.mockRestore(); }
});

it.each(['full', 'text_only'] as const)('%s ZIP restores role credentials and preset groups, then sends them through useChatAI', async mode => {
    await clearCharacters();
    const character = { id: `restore-${mode}`, name: '备份角色', dialogueApi: roleApi, emotionConfig: { enabled: false },
        dateStyleConfig: { style: 'daily', extra: '当前补充要求' },
        dateExtraPresets: [{ id: 'daily', name: '日常', content: '多写生活细节' }, { id: 'adventure', name: '冒险', content: '加快叙事节奏' }],
    } as any;
    await DB.saveCharacter(character);
    const zip = new JSZip();
    const data: any = { apiConfig: globalApi, apiPresets: [preset] };
    const prewrittenStores: any = {};
    if (mode === 'text_only') {
        // Same cursor + streaming writer path used by exportSystem(text_only).
        const writer = createV2ArrayFieldWriter(zip, 'characters');
        await DB.streamRawStoreData('characters', item => { writer.appendSync([stripBackupImages(item)]); });
        prewrittenStores.characters = await writer.finish();
    } else {
        data.characters = await DB.getRawStoreData('characters');
    }
    await writeV2Backup(zip, data, { prewrittenStores });
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
    const restored: any = await assembleV2Backup(loaded, JSON.parse(await loaded.file('manifest.json')!.async('string')));
    expect(restored.apiPresets.map(normalizeApiPreset)).toEqual([{ ...preset, config: { ...roleApi, apiType: 'openai' } }]);
    expect(restored.apiConfig).toEqual(globalApi);
    await clearCharacters();
    expect(await DB.getAllCharacters()).toEqual([]);
    await DB.importFullData(restored);
    // Same normalization/migration used by OSProvider after import and reload.
    const saved = (await DB.getAllCharacters()).find(c => c.id === character.id)!;
    const char = migrateCharacterContextRange(normalizeCharacterDefaults(normalizeCharacterImpression(saved))).character;
    expect(char.dialogueApi).toEqual(roleApi);
    expect(char.dateStyleConfig).toEqual(character.dateStyleConfig);
    expect(char.dateExtraPresets).toEqual(character.dateExtraPresets);
    await DB.saveMessage({ charId: char.id, role: 'user', type: 'text', content: '你好' } as any);

    let current!: ReturnType<typeof useChatAI>;
    function Probe({ value }: { value: any }) {
        current = useChatAI({ char: value, apiConfig: globalApi, userProfile: { name: '用户' } as any,
            groups: [], emojis: [], categories: [], realtimeConfig: {} as any,
            addToast: vi.fn(), setMessages: vi.fn(), updateCharacter: vi.fn(), updateUserProfile: vi.fn() });
        return null;
    }
    const root = createRoot(document.createElement('div'));
    // Stop at the real request boundary, without calling a paid external API.
    vi.mocked(safeFetchJson).mockRejectedValue(new Error('test: request captured'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        for (const [value, override, expected] of [
            [char, undefined, roleApi],
            [char, appApi, { ...globalApi, ...appApi }],
            [{ ...char, dialogueApi: undefined }, undefined, globalApi],
        ] as const) {
            vi.mocked(safeFetchJson).mockClear();
            await act(async () => { root.render(createElement(Probe, { value })); });
            await act(async () => { await current.triggerAI([], override); });
            expect(safeFetchJson, errorSpy.mock.calls.map(args => args.map(String).join(' ')).join('\n')).toHaveBeenCalled();
            const [url, init] = vi.mocked(safeFetchJson).mock.calls[0];
            expect(url).toBe(expected.baseUrl + '/chat/completions');
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${expected.apiKey}`);
            expect(JSON.parse(init!.body as string)).toMatchObject({ model: expected.model, stream: expected.stream, temperature: expected.temperature, max_tokens: expected.maxTokens });
        }
    } finally {
        act(() => root.unmount()); errorSpy.mockRestore();
    }
});

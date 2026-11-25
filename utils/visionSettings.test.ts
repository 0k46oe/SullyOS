// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Settings from '../apps/Settings';
import type { APIConfig } from '../types';
import { requestSettingsFocus } from './settingsNavigation';

vi.mock('../context/OSContext', () => ({ useOS: () => context }));
vi.mock('../components/os/Modal', () => ({ default: () => null }));
vi.mock('../components/settings/VersionInfo', () => ({ default: () => null }));
vi.mock('../components/settings/StorageUsagePanel', () => ({ default: () => null }));
vi.mock('../components/settings/ActiveMsgGlobalSettingsModal', () => ({ default: () => null }));
vi.mock('../components/settings/PushVapidSettingsModal', () => ({ PushVapidSettingsModal: () => null }));
vi.mock('../components/settings/ApiCallLogModal', () => ({ default: () => null }));
vi.mock('./avatarModelBackup', () => ({ getAvatarModelBackupInventory: async () => ({ models: [], totalBytes: 0 }) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let context: any;
let saved: APIConfig;
const container = document.createElement('div');
const root = createRoot(container);
function Harness() {
    const [apiConfig, setApiConfig] = useState(saved);
    context = {
        apiConfig, updateApiConfig: (patch: Partial<APIConfig>) => {
            saved = { ...saved, ...patch };
            localStorage.setItem('os_api_config', JSON.stringify(saved));
            setApiConfig(saved);
        },
        theme: {}, realtimeConfig: {}, cloudBackupConfig: {}, characters: [], groups: [],
        userProfile: {}, apiPresets: [], availableModels: [], sysOperation: { status: 'idle' },
        addToast: vi.fn(),
    };
    return createElement(Settings);
}
function visionSection() {
    return container.querySelector<HTMLElement>('#settings-api-panel-vision')!;
}
const apiTab = (id: string) => container.querySelector<HTMLButtonElement>(`#settings-api-tab-${id}`)!;
const visionStatus = () => apiTab('vision').textContent;
async function openVision() {
    await act(async () => requestSettingsFocus('api'));
    await act(async () => apiTab('vision').click());
}
afterEach(async () => { await act(async () => { root.render(null); }); vi.restoreAllMocks(); });

describe('识图设置开关', () => {
    it('首次配置未填完整时不接入，关闭也保留尚未保存的输入', async () => {
        saved = { baseUrl: 'https://main.test/v1', apiKey: 'main-key', model: 'main' };
        await act(async () => { root.render(createElement(Harness)); });
        await openVision();
        await act(async () => { visionSection().querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
        expect(saved.visionApi?.enabled).not.toBe(true);
        expect(visionStatus()).toContain('未接入');
        const urlInput = visionSection().querySelector<HTMLInputElement>('input[type="text"]')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(urlInput, 'https://draft.test/v1');
            urlInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => { visionSection().querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
        expect(saved.visionApi?.enabled).toBe(false);
        expect(urlInput.value).toBe('https://draft.test/v1');
        await act(async () => apiTab('image').click());
        expect(container.querySelector('#settings-api-panel-image')?.textContent).toContain('保存生图与其他 API');
        expect(visionSection().hidden).toBe(true);
        await act(async () => apiTab('vision').click());
        expect(urlInput.value).toBe('https://draft.test/v1');
        await act(async () => requestSettingsFocus('api'));
        expect(apiTab('chat').getAttribute('aria-selected')).toBe('true');
        expect(saved.visionApi?.baseUrl).not.toBe('https://draft.test/v1');
    });

    it('关掉立即改变徽标并落盘，重新打开设置保持关闭，凭据保留', async () => {
        saved = { baseUrl: 'https://main.test/v1', apiKey: 'main-key', model: 'main',
            visionApi: { enabled: true, baseUrl: 'https://vision.test/v1', apiKey: 'vision-key', model: 'vision' } };
        await act(async () => { root.render(createElement(Harness)); });
        await openVision();
        expect(visionStatus()).toContain('已接入');
        await act(async () => { visionSection().querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
        expect(visionSection().querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
        expect(visionStatus()).toContain('未接入');
        expect(JSON.parse(localStorage.getItem('os_api_config')!).visionApi).toEqual({
            enabled: false, baseUrl: 'https://vision.test/v1', apiKey: 'vision-key', model: 'vision',
        });
        await act(async () => { root.render(null); });
        await act(async () => { root.render(createElement(Harness)); });
        await openVision();
        expect(visionSection().querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
        await act(async () => { visionSection().querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
        expect(saved.visionApi?.enabled).toBe(true);
        expect(visionStatus()).toContain('已接入');
        expect(saved.model).toBe('main');
    });
});

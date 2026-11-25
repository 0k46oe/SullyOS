// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Settings from '../apps/Settings';
import { requestSettingsFocus } from './settingsNavigation';

const context = vi.hoisted(() => ({
    apiConfig: { baseUrl: '', apiKey: '', model: '' }, theme: {}, realtimeConfig: {}, cloudBackupConfig: {}, characters: [], groups: [], userProfile: {},
    apiPresets: [], availableModels: [], sysOperation: { status: 'idle' }, addToast: vi.fn(), exportSystem: vi.fn(), importSystem: vi.fn(),
}));
const share = vi.hoisted(() => vi.fn());
vi.mock('../context/OSContext', () => ({ useOS: () => context }));
vi.mock('../components/os/Modal', () => ({ default: () => null }));
vi.mock('../components/settings/VersionInfo', () => ({ default: () => null }));
vi.mock('../components/settings/StorageUsagePanel', () => ({ default: () => null }));
vi.mock('../components/settings/ActiveMsgGlobalSettingsModal', () => ({ default: () => null }));
vi.mock('../components/settings/PushVapidSettingsModal', () => ({ PushVapidSettingsModal: () => null }));
vi.mock('../components/settings/ApiCallLogModal', () => ({ default: () => null }));
vi.mock('./avatarModelBackup', () => ({ getAvatarModelBackupInventory: async () => ({ models: [], totalBytes: 0 }) }));
vi.mock('./shareExport', () => ({ shareOrDownloadBlob: share }));
let host: HTMLDivElement, root: Root;
const backupSection = () => Array.from(host.querySelectorAll('section')).find(node => node.querySelector('h2')?.textContent === '备份与恢复')!;

beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(context.cloudBackupConfig, { enabled: false });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.stubGlobal('URL', class extends URL {
        static createObjectURL = () => 'blob:backup';
        static revokeObjectURL = vi.fn();
    });
    share.mockResolvedValue('cancelled');
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('retains single-ZIP export and its confirmation alongside the default volume option', async () => {
    const file = new Blob(['zip']);
    context.exportSystem.mockResolvedValue(file);
    await act(async () => root.render(createElement(Settings)));
    const section = backupSection();
    await act(async () => section.querySelector('button')!.click());
    const local = section.querySelector('#settings-backup-panel-local')!;
    const volume = local.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(volume.checked).toBe(true);
    await act(async () => volume.click());
    const button = Array.from(local.querySelectorAll('button')).find(node => node.textContent?.includes('整合导出 (文字+媒体)'))!;
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await act(async () => button.click());
    expect(context.exportSystem).not.toHaveBeenCalled();
    await act(async () => button.click());
    expect(context.exportSystem).toHaveBeenCalledWith('full', { includeBackendConnection: false });
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ blob: file }));
});

it('passes the index and all selected volumes to the unchanged restore handler', async () => {
    context.importSystem.mockResolvedValue(undefined);
    await act(async () => root.render(createElement(Settings)));
    const section = backupSection();
    await act(async () => section.querySelector('button')!.click());
    const normal = section.querySelector<HTMLInputElement>('input[accept=".json,.zip,.sullypart"]')!;
    expect(normal.multiple).toBe(true);
    const files = [new File(['{}'], 'backup.sullyindex.json'), new File(['volume'], 'backup.sullypart')];
    Object.defineProperty(normal, 'files', { value: files, configurable: true });
    await act(async () => normal.dispatchEvent(new Event('change', { bubbles: true })));
    expect(context.importSystem).toHaveBeenCalledWith(files, { confirmBackendRestore: expect.any(Function) });
});

it('defaults to the enabled cloud backup and focuses the local import when restore is requested', async () => {
    Object.assign(context.cloudBackupConfig, { enabled: true, provider: 'github' });
    await act(async () => root.render(createElement(Settings)));
    const section = backupSection();
    await act(async () => section.querySelector('button')!.click());
    expect(section.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('云端');
    expect(section.textContent).toContain('备份提醒频率');
    expect(section.querySelector('[data-settings-backup-import]')).toBeNull();

    await act(async () => requestSettingsFocus('backup'));
    const importButton = section.querySelector<HTMLButtonElement>('[data-settings-backup-import]')!;
    expect(section.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('本地文件');
    expect(document.activeElement).toBe(importButton);
    const picker = vi.spyOn(section.querySelector<HTMLInputElement>('input[accept=".json,.zip,.sullypart"]')!, 'click');
    await act(async () => importButton.click());
    expect(picker).toHaveBeenCalledOnce();
    expect(context.importSystem).not.toHaveBeenCalled();
});

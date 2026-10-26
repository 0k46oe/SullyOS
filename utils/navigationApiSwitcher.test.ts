// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NavigationApiSwitcher from '../components/os/NavigationApiSwitcher';
import { AppID } from '../types';
import { syncAmsgLlmCredentials } from './amsgStateSync';

const state = vi.hoisted(() => ({ activeApp: 'chat', activeCharacterId: 'role',
  apiConfig: { baseUrl: 'https://global.test/v1', apiKey: 'global-key', model: 'global-model', temperature: 0.6, minimaxApiKey: 'voice-key' },
  characters: [{ id: 'role', name: '测试角色', dialogueApi: { baseUrl: 'https://role.test/v1', apiKey: 'role-key', model: 'role-model' } }],
  apiPresets: [{ id: 'native', name: '原生测试预设', group: '对话', config: { protocol: 'anthropic', baseUrl: 'https://native.test', apiKey: 'native-key', model: 'native-model' } },
    { id: 'legacy', name: '兼容测试预设', config: { baseUrl: 'https://legacy.test/v1', apiKey: 'legacy-key', model: 'legacy-model' } }],
  updateApiConfig: vi.fn(), updateCharacter: vi.fn(), addToast: vi.fn() }));
vi.mock('../context/OSContext', () => ({ useOS: () => state }));
vi.mock('./amsgStateSync', () => ({ syncAmsgLlmCredentials: vi.fn() }));
let root: Root, host: HTMLDivElement;
const onClose = vi.fn();
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; vi.clearAllMocks(); state.activeApp = AppID.Chat;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = () => act(async () => root.render(React.createElement(NavigationApiSwitcher, { onClose, onOpenSettings: vi.fn() })));
const click = async (text: string) => act(async () => {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent?.includes(text));
  expect(button, text).toBeTruthy(); button!.click();
});
const setGlobal = () => act(async () => {
  const select = host.querySelector('select')!; select.value = 'global'; Simulate.change(select);
});
it('defaults to the actual chat role and preserves protocol in a role snapshot', async () => {
  await render(); expect((host.querySelector('select') as HTMLSelectElement).value).toBe('character');
  expect(host.textContent).not.toContain('role-key'); expect(host.textContent).not.toContain('native-key');
  await click('原生测试预设');
  expect(state.updateCharacter).toHaveBeenCalledWith('role', { dialogueApi: { ...state.apiPresets[0].config, temperature: 0.6 } });
  expect(state.updateApiConfig).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledOnce();
});
it('changes global credentials without overwriting a role and synchronizes legacy cloud credentials', async () => {
  await render(); await setGlobal(); await click('兼容测试预设');
  expect(state.updateApiConfig).toHaveBeenCalledWith({ ...state.apiPresets[1].config, protocol: 'openai' });
  expect(state.updateCharacter).not.toHaveBeenCalled();
  expect(syncAmsgLlmCredentials).toHaveBeenCalledWith({ ...state.apiConfig, ...state.apiPresets[1].config, protocol: 'openai' });
});
it('does not send unsupported native credentials to the OpenAI-only Worker', async () => {
  await render(); await setGlobal(); await click('原生测试预设');
  expect(state.updateApiConfig).toHaveBeenCalledWith(state.apiPresets[0].config);
  expect(syncAmsgLlmCredentials).not.toHaveBeenCalled();
});
it('restores the current role to following global and uses global scope outside private chat', async () => {
  await render(); await click('恢复跟随全局 API');
  expect(state.updateCharacter).toHaveBeenCalledWith('role', { dialogueApi: undefined });
  act(() => root.unmount()); root = createRoot(host); state.activeApp = AppID.Settings;
  await render(); expect(host.querySelector('option[value=character]')).toBeNull();
});
it('shows a failed role save without closing the picker or claiming a switch succeeded', async () => {
  state.updateCharacter.mockRejectedValueOnce(new Error('写入失败'));
  await render(); await click('原生测试预设');
  expect(host.querySelector('[role=alert]')?.textContent).toBe('写入失败');
  expect(onClose).not.toHaveBeenCalled(); expect(state.addToast).not.toHaveBeenCalled();
});

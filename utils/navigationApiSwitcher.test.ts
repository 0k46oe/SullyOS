// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NavigationApiSwitcher from '../components/os/NavigationApiSwitcher';
import { AppID } from '../types';
import { configFromPreset } from './apiPresetSwitch';
import { pickDialogueApi } from './characterApi';
import { syncAmsgLlmCredentials } from './amsgStateSync';

const state = vi.hoisted(() => ({ activeApp: 'chat', activeCharacterId: 'role',
  apiConfig: { baseUrl: 'https://global.test/v1', apiKey: 'global-key', model: 'global-model', temperature: 0.6, minimaxApiKey: 'voice-key' },
  characters: [{ id: 'role', name: '测试角色', dialogueApi: { baseUrl: 'https://role.test/v1', apiKey: 'role-key', model: 'role-model' } }],
  apiPresets: [{ id: 'native', name: '原生测试预设', group: '对话', config: { protocol: 'anthropic' as const, baseUrl: 'https://native.test', apiKey: 'native-key', model: 'native-model' } },
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
const setGlobal = () => click('全局默认');
it('defaults to the actual chat role and preserves protocol in a role snapshot', async () => {
  await render(); expect(host.querySelector('[aria-label="API 切换范围"] button')?.getAttribute('aria-pressed')).toBe('true');
  expect(host.textContent).not.toContain('role-key'); expect(host.textContent).not.toContain('native-key');
  await click('原生测试预设');
  expect(state.updateCharacter).toHaveBeenCalledWith('role', { dialogueApi: pickDialogueApi({ ...state.apiConfig, ...configFromPreset(state.apiPresets[0]) } as any) });
  expect(state.updateApiConfig).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledOnce();
});
it('changes global credentials without overwriting a role and synchronizes legacy cloud credentials', async () => {
  await render(); await setGlobal(); await click('兼容测试预设');
  expect(state.updateApiConfig).toHaveBeenCalledWith(configFromPreset(state.apiPresets[1] as any));
  expect(state.updateCharacter).not.toHaveBeenCalled();
  expect(syncAmsgLlmCredentials).toHaveBeenCalledWith({ ...state.apiConfig, ...configFromPreset(state.apiPresets[1] as any) });
});
it('synchronizes native credentials through the upstream Worker capability check', async () => {
  await render(); await setGlobal(); await click('原生测试预设');
  expect(state.updateApiConfig).toHaveBeenCalledWith(configFromPreset(state.apiPresets[0] as any));
  expect(syncAmsgLlmCredentials).toHaveBeenCalledWith({ ...state.apiConfig, ...configFromPreset(state.apiPresets[0] as any) });
});
it('restores the current role to following global and uses global scope outside private chat', async () => {
  await render(); await click('恢复跟随全局 API');
  expect(state.updateCharacter).toHaveBeenCalledWith('role', { dialogueApi: undefined });
  act(() => root.unmount()); root = createRoot(host); state.activeApp = AppID.Settings;
  await render(); expect(host.querySelector('[aria-label="API 切换范围"]')?.textContent).not.toContain('当前角色');
});

it('renders grouped cards with protocol badges and filters by group or model', async () => {
  await render();
  expect(host.querySelectorAll('.navigation-api-preset')).toHaveLength(2);
  expect(host.querySelector('[aria-label="对话预设"]')?.textContent).toContain('Anthropic');
  const search = host.querySelector('[aria-label="搜索 API 预设"]') as HTMLInputElement;
  await act(async () => { search.value = '  NATIVE-MODEL '; Simulate.change(search); });
  expect(host.querySelectorAll('.navigation-api-preset')).toHaveLength(1);
  expect(host.querySelector('.navigation-api-preset')?.textContent).toContain('原生测试预设');
  await act(async () => { search.value = '不存在'; Simulate.change(search); });
  expect(host.textContent).toContain('没有匹配的预设');
});

it('keeps selection busy during a save and cannot apply a second preset', async () => {
  let finish!: () => void;
  state.updateCharacter.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  await render(); await click('原生测试预设');
  expect([...host.querySelectorAll('.navigation-api-preset')].every(button => (button as HTMLButtonElement).disabled)).toBe(true);
  await click('兼容测试预设'); expect(state.updateCharacter).toHaveBeenCalledOnce();
  await act(async () => finish()); expect(onClose).toHaveBeenCalledOnce();
});
it('shows a failed role save without closing the picker or claiming a switch succeeded', async () => {
  state.updateCharacter.mockRejectedValueOnce(new Error('写入失败'));
  await render(); await click('原生测试预设');
  expect(host.querySelector('[role=alert]')?.textContent).toBe('写入失败');
  expect(onClose).not.toHaveBeenCalled(); expect(state.addToast).not.toHaveBeenCalled();
});

it('keeps a custom native temperature with the selected card configuration', async () => {
  const config = state.apiPresets[0].config as typeof state.apiPresets[0]['config'] & { temperature?: number; anthropicCustomTemperature?: boolean };
  config.temperature = 0.28; config.anthropicCustomTemperature = true;
  try {
    await render(); await click('原生测试预设');
    expect(state.updateCharacter).toHaveBeenCalledWith('role', { dialogueApi: expect.objectContaining({ temperature: 0.28, anthropicCustomTemperature: true, apiType: 'anthropic', model: config.model }) });
  } finally { delete config.temperature; delete config.anthropicCustomTemperature; }
});

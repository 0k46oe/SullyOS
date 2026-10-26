// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CharacterApiPanel from '../components/character/CharacterApiPanel';
import type { CharacterProfile } from '../types';

const os = vi.hoisted(() => ({
  apiConfig: { baseUrl: 'https://global.test/v1', apiKey: 'global', model: 'global-model' },
  apiPresets: [
    { id: 'a', name: '日常预设', group: '日常', config: { baseUrl: 'https://a.test/v1', apiKey: 'a', model: 'model-a' } },
    { id: 'b', name: '写作预设', group: '写作', config: { baseUrl: 'https://b.test/v1', apiKey: 'b', model: 'model-b' } },
  ],
  availableModels: ['global-model', 'another-model'],
}));
vi.mock('../context/OSContext', () => ({ useOS: () => os }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const onChange = vi.fn();
const char = { id: 'a', name: '角色 A' } as CharacterProfile;
const render = async (character = char) => act(async () => {
  root.render(React.createElement(CharacterApiPanel, { character, onChange }));
});
const click = async (text: string) => {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
};
beforeEach(async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  onChange.mockClear(); await render();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('character API draft transaction', () => {
  it('edits native temperature only in the draft until confirmed, with model-default mode available', async () => {
    await click('为角色使用独立 API');
    await act(async () => { const select = host.querySelector('select')!; select.value = 'anthropic'; Simulate.change(select); });
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Anthropic 自定义温度"]')!;
    const slider = host.querySelector<HTMLInputElement>('[aria-label="Anthropic 温度"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('false'); expect(slider.disabled).toBe(true);
    expect(host.textContent).toContain('模型默认 · 不发送温度参数');
    await act(async () => toggle.click());
    await act(async () => { slider.value = '0.37'; Simulate.change(slider); });
    expect(slider.max).toBe('1'); expect(host.textContent).toContain('当前发送：0.37');
    expect(onChange).not.toHaveBeenCalled(); await click('确定');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ anthropicCustomTemperature: true, temperature: 0.37 }));
    const saved = { ...char, dialogueApi: onChange.mock.calls[0][0] }; await render(saved); onChange.mockClear();
    await click('修改独立 API');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Anthropic 自定义温度"]')!.click());
    await click('取消'); expect(onChange).not.toHaveBeenCalled(); expect(saved.dialogueApi.anthropicCustomTemperature).toBe(true);
    await click('修改独立 API');
    expect(host.querySelector('[aria-label="Anthropic 自定义温度"]')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Anthropic 自定义温度"]')!.click());
    await click('确定'); expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ anthropicCustomTemperature: false, temperature: 0.37 }));
  });
  it('persists the selected native protocol only after the role draft is confirmed', async () => {
    await click('为角色使用独立 API');
    await act(async () => { const select = host.querySelector('select')!; select.value = 'anthropic'; Simulate.change(select); });
    expect(onChange).not.toHaveBeenCalled();
    expect(host.textContent).toContain('用于普通私聊');
    expect(host.textContent).toContain('支持视觉的模型可直接接收图片，无需配置独立识图');
    expect(host.textContent).not.toContain('图片需开启独立识图');
    const stream = host.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="流式输出"]')!;
    expect(stream.disabled).toBe(false);
    expect(stream.getAttribute('aria-checked')).toBe('false');
    await act(async () => stream.click());
    expect(stream.getAttribute('aria-checked')).toBe('true');
    await click('确定');
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ protocol: 'anthropic', stream: true, baseUrl: os.apiConfig.baseUrl }));
  });
  it('can turn native streaming off and cancel without overwriting the saved role preference', async () => {
    const character = { ...char, dialogueApi: { ...os.apiConfig, protocol: 'anthropic' as const, stream: true } };
    await render(character);
    await click('修改独立 API');
    const stream = host.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="流式输出"]')!;
    expect(stream.getAttribute('aria-checked')).toBe('true');
    await act(async () => stream.click());
    expect(stream.getAttribute('aria-checked')).toBe('false');
    await click('取消');
    expect(onChange).not.toHaveBeenCalled();
    expect(character.dialogueApi.stream).toBe(true);
  });
  it('loads grouped presets as drafts; cancellation never mutates the role or global config', async () => {
    expect(host.textContent).toContain('目前跟随设置中的 API：global.test · global-model');
    await click('为角色使用独立 API');
    expect([...host.querySelectorAll('summary')].map(x => x.textContent)).toEqual(['日常 · 1', '写作 · 1']);
    await click('日常预设');
    expect(onChange).not.toHaveBeenCalled();
    await click('取消');
    expect(onChange).not.toHaveBeenCalled();
    expect(os.apiConfig.model).toBe('global-model');
    await click('为角色使用独立 API');
    expect((host.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('global');
  });
  it('confirms only the role snapshot and can return to following Settings', async () => {
    await click('为角色使用独立 API'); await click('写作预设'); await click('确定');
    expect(onChange).toHaveBeenCalledWith({ ...os.apiPresets[1].config, protocol: 'openai' });
    const saved = { ...char, dialogueApi: onChange.mock.calls[0][0] };
    await render(saved);
    expect(host.textContent).toContain('目前使用的为：b.test · model-b');
    await click('跟随设置中的 API');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(os.apiConfig.model).toBe('global-model');
  });
  it('selecting a model only changes the draft until the outer confirmation', async () => {
    await click('为角色使用独立 API'); await click('global-model'); await click('another-model');
    expect(onChange).not.toHaveBeenCalled();
    await click('取消');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('discards a provider model-list response after the draft switches to another preset', async () => {
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    await click('为角色使用独立 API'); await click('刷新模型列表'); await click('写作预设');
    await act(async () => resolve({ ok: true, json: async () => ({ data: [{ id: 'stale-model' }] }) } as Response));
    expect(host.textContent).not.toContain('stale-model');
    expect(host.textContent).toContain('model-b');
    expect(os.availableModels).toEqual(['global-model', 'another-model']);
  });
});

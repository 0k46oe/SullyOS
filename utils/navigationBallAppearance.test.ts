// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_NAVIGATION_BALL_APPEARANCE, NAVIGATION_BALL_APPEARANCE_KEY, normalizeNavigationBallAppearance, resetNavigationBallAppearance, setNavigationBallAppearance } from './navigationBallAppearance';
import { DraggableNavigationBall } from '../components/os/NavigationBall';
import NavigationBallSettings from '../components/settings/NavigationBallSettings';
import { setNavigationBallEnabled, setNavigationBallSlot } from './navigationBall';
import { AppID } from '../types';
import { processImage } from './file';

vi.mock('../context/OSContext', () => ({ useOS: () => ({}) }));
vi.mock('./file', () => ({ processImage: vi.fn() }));
vi.mock('./iosStandalone', () => ({ isIOSStandaloneWebApp: () => false, readSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
let root: Root, host: HTMLDivElement;
const image = 'data:image/png;base64,iVBORw0KGgo=';
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); resetNavigationBallAppearance(); setNavigationBallEnabled(true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ width: 320, height: 600, left: 0, top: 0 } as DOMRect);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(React.createElement(React.Fragment, null,
  React.createElement(NavigationBallSettings), React.createElement(DraggableNavigationBall, { onBack: vi.fn(), onHome: vi.fn(), onApi: vi.fn(), onShortcut: vi.fn(), onConfigure: vi.fn() }))));
const click = async (label: string) => act(async () => {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === label);
  expect(button, label).toBeTruthy(); button!.click();
});

it('normalizes corrupt shapes, opacity, unsafe URLs and oversized images', () => {
  expect(normalizeNavigationBallAppearance(null)).toEqual(DEFAULT_NAVIGATION_BALL_APPEARANCE);
  expect(normalizeNavigationBallAppearance({ shape: 'bad', opacity: 0, image: 'javascript:bad' })).toEqual({ shape: 'rounded', opacity: 0.1, image: '', size: 44 });
  expect(normalizeNavigationBallAppearance({ shape: 'circle', opacity: NaN, image })).toEqual({ shape: 'circle', opacity: 1, image, size: 44 });
  expect(() => setNavigationBallAppearance({ image: 'https://remote.test/image.png' })).toThrow('格式不支持');
  expect(() => setNavigationBallAppearance({ image: 'data:image/png;base64,' + 'a'.repeat(800000) })).toThrow('图片过大');
});

it('updates only the ball face, preserves menu opacity and rehydrates the saved shape', async () => {
  await render(); await click('悬浮球设置'); await click('圆形');
  await act(async () => {
    const slider = host.querySelector('[aria-label="悬浮球不透明度"]') as HTMLInputElement;
    slider.value = '35'; Simulate.change(slider);
    setNavigationBallAppearance({ image });
  });
  const ball = host.querySelector('button.navigation-ball-toggle') as HTMLButtonElement;
  expect(ball.style.borderRadius).toBe('50%'); expect(ball.style.opacity).toBe('0.35');
  expect(ball.querySelector('img')?.getAttribute('src')).toBe(image);
  await act(async () => ball.click());
  expect((host.querySelector('.navigation-ball-panel') as HTMLElement).style.opacity).toBe('');
  expect(JSON.parse(localStorage.getItem(NAVIGATION_BALL_APPEARANCE_KEY)!)).toEqual({ shape: 'circle', opacity: 0.35, image, size: 44 });
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: NAVIGATION_BALL_APPEARANCE_KEY })));
  expect(ball.style.borderRadius).toBe('50%');
  await click('正方形'); expect(ball.style.borderRadius).toBe('0px');
});

it('restores only appearance, keeping the position, enabled flag and shortcuts', async () => {
  localStorage.setItem('sully_navigation_ball_position_v1', '{"x":40,"y":60}');
  setNavigationBallSlot(0, { appId: AppID.Chat, characterId: 'test-character' });
  setNavigationBallAppearance({ shape: 'square', opacity: 0.2, image });
  const slots = localStorage.getItem('sully_navigation_ball_slots_v1');
  await render(); await click('悬浮球设置'); await click('恢复默认外观');
  expect(localStorage.getItem(NAVIGATION_BALL_APPEARANCE_KEY)).toBeNull();
  expect(localStorage.getItem('sully_navigation_ball_position_v1')).toBe('{"x":40,"y":60}');
  expect(localStorage.getItem('sully_navigation_ball_enabled_v1')).toBe('1');
  expect(localStorage.getItem('sully_navigation_ball_slots_v1')).toBe(slots);
  expect(host.querySelector('.navigation-ball-custom-image')).toBeNull();
});

it('keeps the previous appearance and reports a quota error instead of pretending it saved', async () => {
  setNavigationBallAppearance({ shape: 'circle' });
  await render(); await click('悬浮球设置');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  await click('正方形');
  expect(host.textContent).toContain('外观保存失败');
  expect((host.querySelector('button.navigation-ball-toggle') as HTMLElement).style.borderRadius).toBe('50%');
});

it('compresses uploaded images and ignores a late upload after restore-default', async () => {
  let resolve!: (value: string) => void;
  vi.mocked(processImage).mockImplementation(() => new Promise(done => { resolve = done; }));
  await render(); await click('悬浮球设置');
  await act(async () => {
    const input = host.querySelector('input[type=file]') as HTMLInputElement;
    Simulate.change(input, { target: { files: [new File(['test'], 'test.png', { type: 'image/png' })], value: '' } } as any);
  });
  expect(processImage).toHaveBeenCalledWith(expect.any(File), { maxWidth: 512, quality: 0.9 });
  await click('恢复默认外观'); await act(async () => resolve(image));
  expect(localStorage.getItem(NAVIGATION_BALL_APPEARANCE_KEY)).toBeNull();
  expect(host.querySelector('.navigation-ball-custom-image')).toBeNull();
});

it('migrates old appearance records and clamps finite sizes without accepting corrupt values', () => {
  expect(normalizeNavigationBallAppearance({ shape: 'square', opacity: 0.4, image }).size).toBe(44);
  for (const [input, expected] of [[1, 24], [96.4, 96], [96.8, 97], [999, 160], [NaN, 44], [Infinity, 44], ['96', 44]] as const) {
    expect(normalizeNavigationBallAppearance({ size: input }).size).toBe(expected);
  }
});

it('accepts a multi-digit exact size on commit, syncs the slider and persists across remounts', async () => {
  await render(); await click('悬浮球设置');
  const input = host.querySelector('[aria-label="悬浮球尺寸数值"]') as HTMLInputElement;
  await act(async () => { input.value = '9'; Simulate.change(input); });
  expect(JSON.parse(localStorage.getItem(NAVIGATION_BALL_APPEARANCE_KEY) || '{}').size).toBeUndefined();
  await act(async () => { input.value = '96'; Simulate.change(input); });
  await act(async () => Simulate.blur(input));
  expect((host.querySelector('.navigation-ball') as HTMLElement).style.getPropertyValue('--navigation-ball-size')).toBe('96px');
  expect((host.querySelector('[aria-label="悬浮球尺寸"]') as HTMLInputElement).value).toBe('96');
  await act(async () => {
    const slider = host.querySelector('[aria-label="悬浮球尺寸"]') as HTMLInputElement;
    slider.value = '160'; Simulate.change(slider);
  });
  expect(input.value).toBe('160');
  expect(JSON.parse(localStorage.getItem(NAVIGATION_BALL_APPEARANCE_KEY)!).size).toBe(160);
  await act(async () => root.unmount()); root = createRoot(host); await render();
  expect((host.querySelector('.navigation-ball') as HTMLElement).style.getPropertyValue('--navigation-ball-size')).toBe('160px');
});

it('constrains an enlarged ball at the old edge and restores the default size without moving it', async () => {
  localStorage.setItem('sully_navigation_ball_position_v1', '{"x":270,"y":550}');
  await render(); await act(async () => setNavigationBallAppearance({ size: 160 }));
  const ball = host.querySelector('.navigation-ball') as HTMLElement;
  expect(parseFloat(ball.style.left)).toBeLessThanOrEqual(160);
  expect(parseFloat(ball.style.top)).toBeLessThanOrEqual(440);
  await click('悬浮球设置'); await click('恢复默认外观');
  expect(ball.style.getPropertyValue('--navigation-ball-size')).toBe('44px');
  expect(localStorage.getItem('sully_navigation_ball_position_v1')).toBe('{"x":270,"y":550}');
});

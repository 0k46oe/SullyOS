// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { beginNavigationPetChat, CLAWD_FORMS, clawdFallbackUrl, clawdFrameStyle, clawdImageUrl, NAVIGATION_PET_KEY, normalizeNavigationPet, setNavigationPet } from './navigationBallPet';
import NavigationBallSettings from '../components/settings/NavigationBallSettings';
import { DraggableNavigationBall } from '../components/os/NavigationBall';
import { DEFAULT_NAVIGATION_BALL_APPEARANCE, normalizeNavigationBallAppearance, resetNavigationBallAppearance, setNavigationBallAppearance } from './navigationBallAppearance';
import { NAVIGATION_BALL_POSITION_KEY, resetNavigationBallPosition } from './navigationBall';
import { processImage } from './file';

vi.mock('../context/OSContext', () => ({ useOS: () => ({}) }));
vi.mock('./file', () => ({ processImage: vi.fn() }));
vi.mock('./iosStandalone', () => ({ isIOSStandaloneWebApp: () => false, readSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
let host: HTMLDivElement, root: Root;
const pending: ReturnType<typeof beginNavigationPetChat>[] = [];
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); localStorage.clear(); resetNavigationBallAppearance(); setNavigationPet({ enabled: false, selection: 'auto' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ width: 320, height: 600, left: 0, top: 0 } as DOMRect);
});
afterEach(async () => {
  await act(async () => { pending.splice(0).forEach(request => request.finish('cancelled')); root.unmount(); });
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
const start = () => { const request = beginNavigationPetChat(); pending.push(request); return request; };
const render = () => act(async () => root.render(React.createElement(React.Fragment, null,
  React.createElement(NavigationBallSettings), React.createElement(DraggableNavigationBall, { onBack: vi.fn(), onHome: vi.fn(), onApi: vi.fn(), onShortcut: vi.fn(), onConfigure: vi.fn() }))));
const click = (label: string) => act(async () => {
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === label);
  expect(button, label).toBeTruthy(); button!.click();
});
const ballImage = () => host.querySelector('.navigation-ball-toggle img')?.getAttribute('src');
const selectForm = (value: string) => act(async () => {
  const select = host.querySelector('select[aria-label="Clawd 形态"]') as HTMLSelectElement;
  Simulate.change(select, { target: { value } } as any);
});

it('uses only pinned Clawd URLs and validates every selectable form', () => {
  expect(normalizeNavigationPet(null)).toEqual({ enabled: false, selection: 'auto' });
  expect(normalizeNavigationPet({ enabled: true, selection: 'https://unsafe.test' })).toEqual({ enabled: true, selection: 'auto' });
  expect(CLAWD_FORMS.length).toBe(24);
  for (const [form] of CLAWD_FORMS) expect(clawdImageUrl(form)).toMatch(/^https:\/\/raw\.githubusercontent\.com\/0k46oe\/clawd-on-desk\/[a-f0-9]{40}\/assets\/gif\/clawd-[a-z-]+\.gif$/);
  expect(clawdFrameStyle('idle')).toMatchObject({
    width: `${302 / 102 * 100}%`, height: `${300 / 102 * 100}%`,
    left: `${(102 - 201) / 102 * 100}%`, top: `${(102 - 273) / 102 * 100}%`,
  });
  expect(clawdFrameStyle('mini-idle')).toBeUndefined();
});

it('follows waiting, text, reasoning, completion, idle and sleep without persisting activity', async () => {
  await render(); await click('悬浮球设置'); await click('Clawd 动图');
  let request!: ReturnType<typeof start>;
  await act(async () => { request = start(); }); expect(ballImage()).toBe(clawdImageUrl('thinking'));
  await act(async () => request.phase('typing')); expect(ballImage()).toBe(clawdImageUrl('typing'));
  await act(async () => request.phase('thinking')); expect(ballImage()).toBe(clawdImageUrl('thinking'));
  await act(async () => request.finish('success')); expect(ballImage()).toBe(clawdImageUrl('happy'));
  await act(async () => vi.advanceTimersByTime(3500)); expect(ballImage()).toBe(clawdImageUrl('idle'));
  await act(async () => vi.advanceTimersByTime(56500)); expect(ballImage()).toBe(clawdImageUrl('sleeping'));
  expect(JSON.parse(localStorage.getItem(NAVIGATION_PET_KEY)!)).toEqual({ enabled: true, selection: 'auto' });
});

it('holds a manually selected form across requests and reload, and resumes auto immediately', async () => {
  await render(); await click('悬浮球设置'); await click('Clawd 动图'); await selectForm('juggling');
  let request!: ReturnType<typeof start>;
  await act(async () => { request = start(); request.phase('typing'); });
  expect(ballImage()).toBe(clawdImageUrl('juggling'));
  await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: NAVIGATION_PET_KEY })));
  expect(ballImage()).toBe(clawdImageUrl('juggling'));
  await selectForm('auto'); expect(ballImage()).toBe(clawdImageUrl('typing'));
  await act(async () => (host.querySelector('.navigation-ball-toggle') as HTMLButtonElement).click());
  expect(host.querySelector('.navigation-ball-panel select')).toBeTruthy();
});

it('keeps concurrent replies active, distinguishes cancellation from failure, and ignores stale updates', async () => {
  setNavigationPet({ enabled: true }); await render();
  let first!: ReturnType<typeof start>, second!: ReturnType<typeof start>;
  await act(async () => { first = start(); second = start(); first.phase('typing'); second.finish('success'); });
  expect(ballImage()).toBe(clawdImageUrl('typing'));
  await act(async () => first.finish('error')); expect(ballImage()).toBe(clawdImageUrl('error'));
  await act(async () => first.phase('typing')); expect(ballImage()).toBe(clawdImageUrl('error'));
  await act(async () => vi.advanceTimersByTime(6000)); expect(ballImage()).toBe(clawdImageUrl('idle'));
  await act(async () => { const third = start(); third.finish('cancelled'); }); expect(ballImage()).toBe(clawdImageUrl('idle'));
});

it('falls back to a visible clickable face on asset failure without changing the saved selection', async () => {
  setNavigationPet({ enabled: true, selection: 'building' }); await render();
  await act(async () => Simulate.error(host.querySelector('.navigation-ball-toggle img')!));
  expect(ballImage()).toBe(clawdFallbackUrl('building'));
  await act(async () => Simulate.error(host.querySelector('.navigation-ball-toggle img')!));
  expect(host.querySelector('.navigation-ball-image-fallback')).toBeTruthy();
  await act(async () => (host.querySelector('.navigation-ball-toggle') as HTMLButtonElement).click());
  expect(host.querySelector('.navigation-ball-panel')).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(NAVIGATION_PET_KEY)!).selection).toBe('building');
});

it('retains GIF bytes without canvas compression and rejects oversize GIFs before processing', async () => {
  const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  vi.mocked(processImage).mockResolvedValue(gif);
  await render(); await click('悬浮球设置');
  const upload = async (file: File) => act(async () => Simulate.change(host.querySelector('input[type=file]')!, { target: { files: [file], value: '' } } as any));
  await upload(new File(['GIF89a'], 'pet.gif', { type: 'image/gif' }));
  expect(processImage).toHaveBeenCalledWith(expect.any(File), { skipCompression: true }); expect(ballImage()).toBe(gif);
  expect(normalizeNavigationBallAppearance({ image: gif }).image).toBe(gif);
  vi.mocked(processImage).mockClear(); await upload(new File([new Uint8Array(580 * 1024 + 1)], 'huge.gif', { type: 'image/gif' }));
  expect(processImage).not.toHaveBeenCalled(); expect(host.textContent).toContain('580KB'); expect(ballImage()).toBe(gif);
});

it('preserves custom images on mode switch and restores the original default appearance', async () => {
  await render(); await click('悬浮球设置'); await click('Clawd 动图'); await selectForm('sleeping');
  await click('普通 / 自定义图片'); expect(host.querySelector('.navigation-ball-toggle img')).toBeNull();
  await click('Clawd 动图'); expect(ballImage()).toBe(clawdImageUrl('sleeping'));
  await click('恢复默认外观'); expect(host.querySelector('.navigation-ball-toggle img')).toBeNull();
  expect(JSON.parse(localStorage.getItem(NAVIGATION_PET_KEY)!)).toEqual({ enabled: false, selection: 'auto' });
  expect(normalizeNavigationBallAppearance(null)).toEqual(DEFAULT_NAVIGATION_BALL_APPEARANCE);
});

it('enlarges the full standard Clawd hit area, anchors its bottom right, and leaves mini/custom GIFs unchanged', async () => {
  const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  setNavigationBallAppearance({ image: gif, size: 80 });
  await render(); await click('悬浮球设置'); await click('Clawd 动图'); await selectForm('idle');
  const ball = () => host.querySelector('.navigation-ball') as HTMLDivElement;
  const toggle = () => host.querySelector('.navigation-ball-toggle') as HTMLButtonElement;
  const edge = () => ({ right: parseFloat(ball().style.left) + parseFloat(ball().style.getPropertyValue('--navigation-ball-rendered-size')),
    bottom: parseFloat(ball().style.top) + parseFloat(ball().style.getPropertyValue('--navigation-ball-rendered-size')) });
  expect(ball().style.getPropertyValue('--navigation-ball-rendered-size')).toBe('100px');
  expect(edge()).toEqual({ right: 320, bottom: 504 });
  expect(toggle().dataset.petForm).toBe('idle');
  expect(host.querySelector('.navigation-ball-toggle img')?.getAttribute('data-pet-form')).toBe('idle');
  expect(parseFloat((host.querySelector('.navigation-ball-face-preview') as HTMLElement).style.getPropertyValue('--navigation-ball-rendered-size'))).toBeLessThanOrEqual(64);
  await selectForm('mini-idle');
  expect(ball().style.getPropertyValue('--navigation-ball-rendered-size')).toBe('80px');
  expect(edge()).toEqual({ right: 308, bottom: 504 });
  await click('普通 / 自定义图片');
  expect(ballImage()).toBe(gif);
  expect(host.querySelector('.navigation-ball-toggle img')?.getAttribute('data-pet-form')).toBeNull();
  expect(ball().style.getPropertyValue('--navigation-ball-rendered-size')).toBe('80px');
  expect(edge()).toEqual({ right: 308, bottom: 504 });
});

it('drags and persists enlarged Clawd within its full visible bounds and keeps custom mode positions safe', async () => {
  setNavigationBallAppearance({ size: 160 }); setNavigationPet({ enabled: true, selection: 'idle' });
  await render();
  const ball = () => host.querySelector('.navigation-ball') as HTMLDivElement;
  const toggle = () => host.querySelector('.navigation-ball-toggle') as HTMLButtonElement;
  let pointerId = 0;
  const drag = async (x: number, y: number) => act(async () => {
    pointerId += 1;
    Simulate.pointerDown(toggle(), { button: 0, pointerId, clientX: 0, clientY: 0 } as any);
    Simulate.pointerMove(toggle(), { pointerId, clientX: x, clientY: y } as any);
    Simulate.pointerUp(toggle(), { pointerId } as any);
  });
  await drag(-9999, -9999);
  expect([ball().style.left, ball().style.top]).toEqual(['8px', '8px']);
  await drag(9999, 9999);
  expect([ball().style.left, ball().style.top]).toEqual(['120px', '392px']);
  expect(JSON.parse(localStorage.getItem(NAVIGATION_BALL_POSITION_KEY)!)).toEqual({ x: 160, y: 432 });
  await act(async () => root.render(React.createElement(React.Fragment)));
  await render();
  expect([ball().style.left, ball().style.top]).toEqual(['120px', '392px']);
  await act(async () => setNavigationPet({ selection: 'mini-idle' }));
  expect(ball().style.getPropertyValue('--navigation-ball-rendered-size')).toBe('160px');
  expect([ball().style.left, ball().style.top]).toEqual(['152px', '432px']);
  await act(async () => { setNavigationPet({ selection: 'idle' }); resetNavigationBallPosition(); });
  expect([ball().style.left, ball().style.top]).toEqual(['120px', '304px']);
  expect(localStorage.getItem(NAVIGATION_BALL_POSITION_KEY)).toBeNull();
});

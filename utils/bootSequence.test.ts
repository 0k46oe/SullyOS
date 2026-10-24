// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BootSequence from '../components/os/BootSequence';
import ClassicBootSequence from '../components/os/ClassicBootSequence';

vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));

class TestImage {
  src = '';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decode = vi.fn(() => Promise.resolve());
  constructor() { images.push(this); }
}

let images: TestImage[];
let host: HTMLDivElement;
let root: Root;
let onDone: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Image', TestImage);
  sessionStorage.clear();
  images = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  onDone = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(dataReady: boolean, wallpaper?: string, strict = false) {
  const element = React.createElement(BootSequence, { dataReady, wallpaper, onDone });
  act(() => root.render(strict ? React.createElement(React.StrictMode, null, element) : element));
}

function skip() {
  act(() => host.querySelector('[aria-label="SullyOS·糯米机"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

function opacity() {
  return (host.querySelector('[aria-label="SullyOS·糯米机"]') as HTMLElement).style.opacity;
}

async function advance(ms: number) {
  // 每帧提交 React 更新，让退场 effect 的计时从实际切换帧开始。
  while (ms > 0) {
    const step = Math.min(ms, 16);
    await act(async () => { await vi.advanceTimersByTimeAsync(step); });
    ms -= step;
  }
}

describe('开机欢迎页就绪门禁', () => {
  it('快速点击后继续显示欢迎页，数据就绪后无需再次点击', async () => {
    render(false);
    skip();
    skip();
    await advance(4000);
    expect(opacity()).toBe('1');
    expect(onDone).not.toHaveBeenCalled();
    expect(host.textContent).toContain('正在准备界面');
    render(true);
    await advance(720);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('数据已就绪时点击跳过最短停留时间', async () => {
    render(true);
    skip();
    await advance(720);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('不点击时仍保持原来的自动启动时长', async () => {
    render(true);
    await advance(1900);
    expect(opacity()).toBe('1');
    expect(onDone).not.toHaveBeenCalled();
    await advance(850);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('同会话短动画也不能绕过数据就绪', async () => {
    sessionStorage.setItem('sullyos_boot_seen_session', '1');
    render(false);
    skip();
    await advance(1000);
    expect(opacity()).toBe('1');
    render(true);
    await advance(350);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('图片加载及解码完成前保持欢迎页，支持本地 blob 壁纸', async () => {
    render(true, 'blob:custom-lock-wallpaper');
    let resolveDecode!: () => void;
    images[0].decode.mockImplementation(() => new Promise<void>(resolve => { resolveDecode = resolve; }));
    skip();
    await advance(3000);
    expect(opacity()).toBe('1');
    act(() => images[0].onload!());
    await advance(1000);
    expect(opacity()).toBe('1');
    await act(async () => { resolveDecode(); });
    await advance(720);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('更换壁纸后忽略旧图片的异步解码结果', async () => {
    render(true, 'https://example.test/old.jpg');
    let resolveOld!: () => void;
    images[0].decode.mockImplementation(() => new Promise<void>(resolve => { resolveOld = resolve; }));
    act(() => images[0].onload!());
    skip();
    render(true, 'https://example.test/new.jpg');
    await act(async () => { resolveOld(); });
    await advance(3000);
    expect(opacity()).toBe('1');
    await act(async () => { images[1].onload!(); });
    await advance(720);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('图片加载失败时仍能启动', async () => {
    render(true, '/missing.jpg');
    skip();
    act(() => images[0].onerror!());
    await advance(720);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('图片无响应超过 8 秒时放行，数据门禁继续有效', async () => {
    render(false, '/never-finishes.jpg');
    skip();
    await advance(9000);
    expect(opacity()).toBe('1');
    expect(onDone).not.toHaveBeenCalled();
    render(true, '/never-finishes.jpg');
    await advance(720);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('图片解码被浏览器拒绝时仍能启动', async () => {
    render(true, 'data:image/png;base64,broken');
    images[0].decode.mockRejectedValue(new Error('decode rejected'));
    skip();
    await act(async () => { images[0].onload!(); });
    await advance(720);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it.each(['#f0e6d2', 'linear-gradient(180deg, #eee, #aab)'])('颜色或渐变 %s 无需创建图片', async wallpaper => {
    render(true, wallpaper);
    expect(images).toHaveLength(0);
    skip();
    await advance(720);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('StrictMode 清理旧加载监听，仍等待有效图片完成', async () => {
    render(true, '/custom.jpg', true);
    expect(images).toHaveLength(2);
    expect(images[0].onload).toBeNull();
    skip();
    await advance(1000);
    expect(opacity()).toBe('1');
    await act(async () => { images[1].onload!(); });
    await advance(720);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('父组件更新回调不会重新计算退场时长，并调用最新回调', async () => {
    const first = vi.fn();
    const latest = vi.fn();
    act(() => root.render(React.createElement(ClassicBootSequence, { dataReady: true, onDone: first })));
    skip();
    await advance(350);
    act(() => root.render(React.createElement(ClassicBootSequence, { dataReady: true, onDone: latest })));
    await advance(370);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });
});

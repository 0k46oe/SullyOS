/// <reference types="vitest" />
/**
 * utils/appIcon.test.ts — PWA 图标注入的回归测试。
 *
 * 核心不变式：
 *   1. 注入的 apple-touch-icon href 必须是 data: 或 http(s)，不能是 blob:（blob 不被 iOS/Chrome 认作图标）。
 *   2. manifest 替换时所有相对路径（start_url / scope）折成绝对地址（动态 manifest 的 base 是 blob: URL）。
 *   3. clearPwaIcon 之后 DOM 回到注入前的状态。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock ────────────────────────────────────────────────────────────

const mockGetBlobForRef = vi.fn();
const mockBlobToDataUrl = vi.fn();
const mockIsStandalone = vi.fn();

vi.mock('./blobRef', () => ({
  isBlobRef: (v: unknown) => typeof v === 'string' && v.startsWith('blobref:'),
  getBlobForRef: (...args: any[]) => mockGetBlobForRef(...args),
  blobToDataUrl: (...args: any[]) => mockBlobToDataUrl(...args),
}));

vi.mock('./iosStandalone', () => ({
  isStandaloneDisplayMode: () => mockIsStandalone(),
}));

// jsdom 没有 URL.createObjectURL / revokeObjectURL；自己垫一层轻量实现，
// 同时把传给 createObjectURL 的 Blob 记下来，test 可以直接读 manifest 内容。
let lastBlobUrlId = 0;
const blobStore = new Map<string, Blob>();

function mockCreateObjectURL(blob: Blob): string {
  const id = `blob:mock-${++lastBlobUrlId}`;
  blobStore.set(id, blob);
  return id;
}

function mockRevokeObjectURL(url: string): void {
  blobStore.delete(url);
}

// 用一小张 1×1 红色 PNG 的 base64 作测试素材
const RED_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

import { injectPwaIcon, clearPwaIcon, initPwaIcon, PWA_ICON_APP_ID } from './appIcon';

// ── helpers ─────────────────────────────────────────────────────────

/** jsdom 里 <link href="./manifest.webmanifest"> 不会自动 resolve 成绝对地址，
 *  所以 setupDOM 直接把 href 写成绝对 URL，模拟真实浏览器的行为。 */
const BASE = 'http://localhost:3000';
const ORIGINAL_MANIFEST_HREF = `${BASE}/manifest.webmanifest`;

function setupDOM() {
  document.head.innerHTML = `
    <link rel="icon" type="image/png" href="./icons/icon-192.png">
    <link rel="apple-touch-icon" sizes="180x180" href="./icons/apple-touch-icon.png">
    <link rel="manifest" href="${ORIGINAL_MANIFEST_HREF}">
  `;
}

function getAppleTouchIconHref(): string | null {
  const link = document.querySelector('link[rel="apple-touch-icon"].sully-custom-pwa-icon');
  return link?.getAttribute('href') ?? null;
}

function getManifestHref(): string | null {
  const link = document.querySelector('link[rel="manifest"]');
  return link?.getAttribute('href') ?? null;
}

// 真实 manifest.webmanifest 的结构
const SAMPLE_MANIFEST = {
  short_name: 'SullyOS',
  name: 'SullyOS',
  display: 'standalone' as const,
  theme_color: '#0f1115',
  background_color: '#0f1115',
  start_url: './',
  scope: './',
  icons: [
    { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
};

// ── setup / teardown ────────────────────────────────────────────────

let _origCreateObjectURL: any = undefined;
let _origRevokeObjectURL: any = undefined;

beforeEach(() => {
  // jsdom 没有 URL.createObjectURL / revokeObjectURL，垫一层轻量实现
  _origCreateObjectURL = (URL as any).createObjectURL;
  _origRevokeObjectURL = (URL as any).revokeObjectURL;
  (URL as any).createObjectURL = mockCreateObjectURL;
  (URL as any).revokeObjectURL = mockRevokeObjectURL;
  blobStore.clear();
  lastBlobUrlId = 0;

  setupDOM();
  mockGetBlobForRef.mockReset();
  mockBlobToDataUrl.mockReset();
  mockIsStandalone.mockReset();
  mockIsStandalone.mockReturnValue(false);

  // fetch mock：请求真实 manifest 时返回 SAMPLE_MANIFEST
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    if (url === ORIGINAL_MANIFEST_HREF) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ...SAMPLE_MANIFEST }),
      } as Response);
    }
    // 动态 manifest（blob: URL）：从 blobStore 取 Blob 内容
    if (url.startsWith('blob:mock-')) {
      const blob = blobStore.get(url);
      if (!blob) return Promise.reject(new Error('blob not found'));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => JSON.parse(await blob.text()),
      } as Response);
    }
    return Promise.reject(new Error(`unexpected fetch url: ${url}`));
  });
});

afterEach(() => {
  clearPwaIcon();
  // 恢复 URL 上的原始方法（如果有的话）
  if (_origCreateObjectURL !== undefined) {
    (URL as any).createObjectURL = _origCreateObjectURL;
    _origCreateObjectURL = undefined;
  } else {
    delete (URL as any).createObjectURL;
  }
  if (_origRevokeObjectURL !== undefined) {
    (URL as any).revokeObjectURL = _origRevokeObjectURL;
    _origRevokeObjectURL = undefined;
  } else {
    delete (URL as any).revokeObjectURL;
  }
  vi.restoreAllMocks();
});

// ── injectPwaIcon ───────────────────────────────────────────────────

describe('injectPwaIcon', () => {
  it('blobRef 令牌 → 解成 data URL 注入 apple-touch-icon', async () => {
    mockGetBlobForRef.mockResolvedValue(new Blob([RED_PIXEL_PNG], { type: 'image/png' }));
    mockBlobToDataUrl.mockResolvedValue(RED_PIXEL_PNG);

    await injectPwaIcon('blobref:test_123');

    const href = getAppleTouchIconHref();
    expect(href).toBe(RED_PIXEL_PNG);
    // 核心不变式：注入的 href 不能是 blob: URL
    expect(href).not.toMatch(/^blob:/);
  });

  it('data: URI → 直接注入，不经过 Blob 解析', async () => {
    await injectPwaIcon(RED_PIXEL_PNG);

    expect(getAppleTouchIconHref()).toBe(RED_PIXEL_PNG);
    expect(mockGetBlobForRef).not.toHaveBeenCalled();
  });

  it('http URL → 直接注入', async () => {
    const remoteUrl = 'https://cdn.example.com/icon.png';
    await injectPwaIcon(remoteUrl);

    expect(getAppleTouchIconHref()).toBe(remoteUrl);
  });

  it('blobRef 解析失败 → 不注入，不抛异常', async () => {
    mockGetBlobForRef.mockResolvedValue(null);

    await expect(injectPwaIcon('blobref:dead')).resolves.toBeUndefined();
    expect(getAppleTouchIconHref()).toBeNull();
  });

  it('多次调用 → 每次都替换旧注入（不会堆叠多个 link）', async () => {
    mockGetBlobForRef.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    mockBlobToDataUrl.mockResolvedValue(RED_PIXEL_PNG);

    await injectPwaIcon('blobref:a');
    await injectPwaIcon('blobref:b');

    const links = document.querySelectorAll('link[rel="apple-touch-icon"].sully-custom-pwa-icon');
    expect(links.length).toBe(1);
  });
});

// ── manifest 替换（standalone 模式） ─────────────────────────────────

describe('manifest 替换（standalone）', () => {
  beforeEach(() => {
    mockIsStandalone.mockReturnValue(true);
    mockGetBlobForRef.mockResolvedValue(new Blob([RED_PIXEL_PNG], { type: 'image/png' }));
    mockBlobToDataUrl.mockResolvedValue(RED_PIXEL_PNG);
  });

  it('standalone 下 manifest href 被换成 blob: URL', async () => {
    await injectPwaIcon('blobref:test');

    expect(getManifestHref()).toMatch(/^blob:mock-/);
  });

  it('动态 manifest 的图标全部替换为 data: URI', async () => {
    await injectPwaIcon('blobref:test');

    // 从 blobStore 直接读生成的 manifest JSON（不绕 fetch）
    const manifestUrl = getManifestHref()!;
    const blob = blobStore.get(manifestUrl);
    expect(blob).toBeTruthy();
    const manifest = JSON.parse(await blob!.text());

    for (const icon of manifest.icons) {
      expect(icon.src).toBe(RED_PIXEL_PNG);
    }
    // 覆盖 192、512、512 maskable 三个槽
    expect(manifest.icons).toHaveLength(3);
  });

  it('动态 manifest 里相对路径折成绝对地址', async () => {
    await injectPwaIcon('blobref:test');

    const manifestUrl = getManifestHref()!;
    const blob = blobStore.get(manifestUrl)!;
    const manifest = JSON.parse(await blob.text());

    // start_url / scope 被转为绝对 URL（base 是原始 manifest 的绝对地址）
    expect(manifest.start_url).toBe(`${BASE}/`);
    expect(manifest.scope).toBe(`${BASE}/`);
    // 不再是裸的 "./"
    expect(manifest.start_url).not.toBe('./');
    expect(manifest.scope).not.toBe('./');
  });

  it('fetch 真实 manifest 失败 → apple-touch-icon 照常注入，不抛异常', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'));

    await expect(injectPwaIcon('blobref:test')).resolves.toBeUndefined();
    // manifest 没被替换
    expect(getManifestHref()).toBe(ORIGINAL_MANIFEST_HREF);
    // apple-touch-icon 照常
    expect(getAppleTouchIconHref()).toBe(RED_PIXEL_PNG);
  });
});

// ── clearPwaIcon ────────────────────────────────────────────────────

describe('clearPwaIcon', () => {
  it('删掉注入的 apple-touch-icon，恢复原始 manifest href', async () => {
    mockGetBlobForRef.mockResolvedValue(new Blob([RED_PIXEL_PNG], { type: 'image/png' }));
    mockBlobToDataUrl.mockResolvedValue(RED_PIXEL_PNG);
    mockIsStandalone.mockReturnValue(true);

    await injectPwaIcon('blobref:test');
    expect(getAppleTouchIconHref()).toBe(RED_PIXEL_PNG);

    clearPwaIcon();
    expect(getAppleTouchIconHref()).toBeNull();
    expect(getManifestHref()).toBe(ORIGINAL_MANIFEST_HREF);
  });

  it('没注入过时调用 clear 也不抛异常', () => {
    expect(() => clearPwaIcon()).not.toThrow();
  });
});

// ── initPwaIcon ─────────────────────────────────────────────────────

describe('initPwaIcon', () => {
  it('customIcons 里有 _pwa_ → 注入', async () => {
    mockGetBlobForRef.mockResolvedValue(new Blob([RED_PIXEL_PNG], { type: 'image/png' }));
    mockBlobToDataUrl.mockResolvedValue(RED_PIXEL_PNG);

    await initPwaIcon({ [PWA_ICON_APP_ID]: 'blobref:saved', 'some_app': 'blobref:other' });

    expect(getAppleTouchIconHref()).toBe(RED_PIXEL_PNG);
  });

  it('customIcons 里没有 _pwa_ → 不动 DOM', async () => {
    const before = getAppleTouchIconHref();
    await initPwaIcon({ 'some_app': 'blobref:other' });
    expect(getAppleTouchIconHref()).toBe(before);
  });

  it('customIcons 为空对象 → 不炸', async () => {
    await expect(initPwaIcon({})).resolves.toBeUndefined();
  });
});

// ── PWA_ICON_APP_ID 常量 ───────────────────────────────────────────

describe('PWA_ICON_APP_ID', () => {
  it('是 _pwa_，不跟任何已安装 App 的 id 冲突', () => {
    expect(PWA_ICON_APP_ID).toBe('_pwa_');
    expect(PWA_ICON_APP_ID.startsWith('_')).toBe(true);
  });
});

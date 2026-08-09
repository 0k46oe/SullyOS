// 自定义 PWA 应用图标：启动时把 `_pwa_` 图标注入 apple-touch-icon / manifest。
//
// 2026-08-04 真机验证（iOS 26.5.2 / Android 17 Chrome Pixel 8）：
//   - JS 动态注入的 apple-touch-icon 认 data: URI
//   - 动态替换的 manifest（blob: URL）也认 data: URI 图标
//   - 详情见 docs/superpowers/specs/2026-08-09-pwa-custom-icon-design.md
//
// 约束：图标只在「添加到主屏幕」那一刻固化，装完之后改不了。装成 App 的用户要看到
// 新图标得删掉重装（会丢 IndexedDB 数据），UI 上的警告由 AppIconEditor 负责。

import { isStandaloneDisplayMode } from './iosStandalone';
import { getBlobForRef, isBlobRef, blobToDataUrl } from './blobRef';

export const PWA_ICON_APP_ID = '_pwa_';

const ATI_SELECTOR = 'link[rel="apple-touch-icon"].sully-custom-pwa-icon';
const MANIFEST_SELECTOR = 'link[rel="manifest"]';

let originalManifestHref: string | null = null;
let dynamicManifestUrl: string | null = null;

// ── 公开 API ──────────────────────────────────────────────────────

/**
 * 把图标值（blobRef 令牌 / data: URI / http(s) URL）注入 DOM。
 * - 总是注入 apple-touch-icon（影响浏览器标签页 + iOS 主屏图标）
 * - standalone display-mode 下额外替换 manifest（影响 Android/Chrome 主屏图标）
 */
export async function injectPwaIcon(value: string): Promise<void> {
  const dataUrl = await resolveIconValue(value);
  if (!dataUrl) return;

  injectAppleTouchIcon(dataUrl);

  if (isStandaloneDisplayMode()) {
    await replaceManifest(dataUrl);
  }
}

/** 恢复默认图标：删掉注入的 link，manifest 指回原始文件。 */
export function clearPwaIcon(): void {
  clearAppleTouchIcon();

  const link = document.querySelector(MANIFEST_SELECTOR) as HTMLLinkElement | null;
  if (link && originalManifestHref) {
    link.href = originalManifestHref;
  }

  if (dynamicManifestUrl) {
    URL.revokeObjectURL(dynamicManifestUrl);
    dynamicManifestUrl = null;
  }
}

/** 启动时调用：customIcons 里有 `_pwa_` 就注入。 */
export async function initPwaIcon(customIcons: Record<string, string>): Promise<void> {
  const icon = customIcons[PWA_ICON_APP_ID];
  if (icon) {
    try {
      await injectPwaIcon(icon);
    } catch (e) {
      console.warn('[PWA Icon] 启动注入失败', e);
    }
  }
}

// ── 内部 ───────────────────────────────────────────────────────────

async function resolveIconValue(value: string): Promise<string | null> {
  if (isBlobRef(value)) {
    const blob = await getBlobForRef(value);
    if (!blob) {
      console.warn('[PWA Icon] blobRef 令牌解析失败，图标可能已被清理');
      return null;
    }
    return await blobToDataUrl(blob);
  }
  // data: URI 直接用；http(s) URL 也直接用（远程地址，manifest 图标由 Chrome 在安装时抓取）
  if (value.startsWith('data:') || /^https?:\/\//i.test(value)) {
    return value;
  }
  console.warn('[PWA Icon] 不支持的图标值:', value.substring(0, 50));
  return null;
}

function injectAppleTouchIcon(dataUrl: string): void {
  clearAppleTouchIcon();

  const link = document.createElement('link');
  link.rel = 'apple-touch-icon';
  link.setAttribute('sizes', '180x180');
  link.href = dataUrl;
  link.classList.add('sully-custom-pwa-icon');
  document.head.appendChild(link);
}

function clearAppleTouchIcon(): void {
  document.querySelector(ATI_SELECTOR)?.remove();
}

async function replaceManifest(iconDataUrl: string): Promise<void> {
  const link = document.querySelector(MANIFEST_SELECTOR) as HTMLLinkElement | null;
  if (!link) return;

  // 记下原始 href，clearPwaIcon 时恢复用
  if (!originalManifestHref) {
    originalManifestHref = link.href;
  }

  try {
    const resp = await fetch(originalManifestHref || link.href);
    if (!resp.ok) throw new Error(`Fetch manifest failed: ${resp.status}`);
    const manifest = await resp.json();

    // manifest 的 base URL —— 浏览器已把 ./manifest.webmanifest 解析为绝对地址，
    // 动态 manifest（blob: URL）的 base 会变成 blob:，所以所有相对路径必须折成绝对地址
    const base = link.href;

    manifest.icons = [
      { src: iconDataUrl, sizes: '192x192', type: 'image/png' },
      { src: iconDataUrl, sizes: '512x512', type: 'image/png' },
      { src: iconDataUrl, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ];

    const toAbs = (p: string): string => {
      if (!p || p.startsWith('data:') || /^https?:\/\//i.test(p)) return p;
      return new URL(p, base).href;
    };
    if (manifest.start_url) manifest.start_url = toAbs(manifest.start_url);
    if (manifest.scope) manifest.scope = toAbs(manifest.scope);

    // 换掉 blob URL（旧的先回收）
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
    if (dynamicManifestUrl) URL.revokeObjectURL(dynamicManifestUrl);
    dynamicManifestUrl = URL.createObjectURL(blob);

    link.href = dynamicManifestUrl;
  } catch (e) {
    console.warn('[PWA Icon] manifest 替换失败，apple-touch-icon 已注入', e);
  }
}

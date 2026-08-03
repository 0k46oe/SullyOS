/**
 * Shared Web Push subscribe helpers used by the Instant Push, Proactive Push
 * and 主动消息 2.0 paths. All of them hit the same browser race / encoding
 * quirks; this file is the single source of truth so a future browser-quirk
 * patch lands in one place instead of three.
 *
 * 同时也是「浏览器这一侧推送现状」的唯一读法（readBrowserPushState 及它下面那
 * 几个 detect*）——设置页的状态面板拿它显示，各层不用各写一份厂商判定。
 */

// unsubscribe() resolve 后 Chromium 内部 PushMessagingAppIdentifier 把当前
// 订阅标成 removed-sentinel; 这段时间里紧接着的 subscribe() 会直接吐
// `permanently-removed.invalid` 哨兵, 而不是去 FCM 拿新端点. 等一会再试就好.
// 桌面 Chrome ~ 300ms 够, 移动端 / iOS PWA 给 800ms 起步, 失败再线性退避.
export const SUBSCRIBE_SETTLE_MS = 800;
/** 总尝试次数 (含首次), 不是"重试次数". 当前: 1 次首试 + 2 次重试 = 3 次. */
export const SUBSCRIBE_ATTEMPTS_MAX = 3;

/** Convert base64url string to Uint8Array<ArrayBuffer> (for VAPID applicationServerKey). */
export function b64uToBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const padded = b64u.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (b64u.length % 4)) % 4);
  const bin = atob(padded);
  // 显式拿 ArrayBuffer 而不是默认 ArrayBufferLike, 否则 PushManager.subscribe 在
  // 严格 TS lib (ArrayBufferView<ArrayBuffer>) 下会判 SharedArrayBuffer 不兼容.
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(buf: ArrayBuffer | null | undefined): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * True if a subscription's endpoint is a Chrome-internal "permanently
 * removed" sentinel.  Browsers occasionally revoke subscriptions due to
 * long inactivity, abuse signals, or the site being visited too rarely;
 * `getSubscription()` then returns an object whose endpoint URL is
 * `https://permanently-removed.invalid/...`.  `.invalid` is an RFC 2606
 * reserved TLD that never resolves, so any push send would fail with a
 * generic upstream error (which Cloudflare Workers wraps as HTTP 530).
 */
export function isDeadPushEndpoint(endpoint: string | null | undefined): boolean {
  if (!endpoint) return false;
  return endpoint.includes('permanently-removed.invalid');
}

/**
 * Web Push 三件套能力检测: Service Worker / PushManager / Notification。
 * 全齐返回 null; 缺任何一个返回可直接展示给用户的原因文案。
 *
 * 为什么要细分: X浏览器 / Via 这类 WebView 壳浏览器常见「SW 能注册成功但没有
 * PushManager / Notification」(2026-07 用户实测: 诊断里 sw: active、notif:
 * unsupported, 却被报"不支持 Service Worker") —— 笼统文案会把用户引去查 SW /
 * 重装 PWA, 实际是内核没有 Web Push 能力, 只能换浏览器。Notification 也必须
 * 在这里查掉: 只查 PushManager 的话, 后续 `Notification.permission` 在没有该
 * API 的环境会直接 ReferenceError。
 */
export function describePushCapabilityGap(): string | null {
  const swSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const pushSupported = typeof window !== 'undefined' && 'PushManager' in window;
  const notifSupported = typeof Notification !== 'undefined';
  if (swSupported && pushSupported && notifSupported) return null;
  const missing = [
    !swSupported ? 'Service Worker' : '',
    !pushSupported ? 'Push API' : '',
    !notifSupported ? '系统通知接口 (Notification)' : '',
  ].filter(Boolean).join('、');
  return `当前浏览器缺少 ${missing}，内核没有网页推送能力（X浏览器 / Via 等 WebView 壳浏览器的通病）—— 请换 Chrome / Edge / Firefox 等完整内核浏览器`;
}

/**
 * 从订阅端点认出推送厂商。端点域名是各厂商写死的，认不出就说「未识别厂商」，
 * 不猜。设置页拿它显示「推送通道」那一行——用户排障时第一句话往往是「我用的
 * Chrome」，能直接对上 Google FCM 就省一轮来回。
 */
export function detectPushChannel(endpoint: string | null | undefined): string {
  if (!endpoint) return '未知';
  if (/fcm\.googleapis\.com|android\.googleapis\.com/i.test(endpoint)) return 'Google FCM (Chrome / Edge / 安卓)';
  if (/updates\.push\.services\.mozilla\.com/i.test(endpoint)) return 'Mozilla autopush (Firefox)';
  if (/notify\.windows\.com|wns2/i.test(endpoint)) return 'Windows WNS (Edge)';
  if (/web\.push\.apple\.com/i.test(endpoint)) return 'Apple APNs (Safari / iOS PWA)';
  return '未识别厂商';
}

/**
 * 页面是不是跑在 Capacitor 打包的原生壳里（安卓/iOS 的 WebView），而不是普通
 * 浏览器标签页。探全局而不 import `@capacitor/core`，这个文件才能继续被 SW
 * 侧的打包 tree-shake 掉。
 */
export function detectCapacitorNative(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as any).Capacitor;
  if (!cap) return false;
  if (typeof cap.isNativePlatform === 'function') {
    try { return !!cap.isNativePlatform(); } catch { /* ignore */ }
  }
  // 老版本 Capacitor 没有 isNativePlatform，退回读 platform。
  return cap.platform === 'android' || cap.platform === 'ios';
}

/**
 * 在 iOS Safari 里、但没走「添加到主屏幕」的 PWA 启动。iOS 的 Web Push 只在
 * 主屏 PWA 里可用，这种情况得先引导用户装到主屏，光讲权限没用。
 */
export function detectIosNeedsPwa(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in document);
  if (!isIos) return false;
  // iOS 老的 navigator.standalone 和 display-mode 媒体查询，任一为真都算已装主屏。
  const standalone =
    (navigator as any).standalone === true ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
  return !standalone;
}

/** 浏览器这一侧的推送现状。跟具体哪台 worker 无关，各推送层都能拿去显示。 */
export interface BrowserPushState {
  /** Web Push 三件套齐不齐（SW / Push API / Notification）。 */
  supported: boolean;
  /** 缺件时的整句说明，齐了是 null。取自 describePushCapabilityGap。 */
  capabilityGap: string | null;
  permission: NotificationPermission | 'unavailable';
  /** 已注册 SW 的 scope，没注册是 null。 */
  swScope: string | null;
  /** 'activated' | 'installing' | 'waiting' | 'redundant' | 'none' */
  swState: string;
  /** 当前浏览器订阅的端点，没订阅是 null。 */
  endpoint: string | null;
  /** 端点是不是 `permanently-removed.invalid` 僵尸哨兵。 */
  endpointDead: boolean;
  /** 推送厂商，见 detectPushChannel。 */
  channel: string;
  iosNeedsPwa: boolean;
  capacitorNative: boolean;
}

/**
 * 读一次浏览器侧的推送现状，给设置页的状态面板用。
 *
 * 全程只读、不请求权限、不建订阅、不碰任何 worker——面板刷新会反复调它，带副作用
 * 的话用户点一下「刷新」就可能被弹权限框。探测中途抛错按「读不到」处理，让面板
 * 显示得出「未注册 / 不存在」，比整块空着强。
 */
export async function readBrowserPushState(): Promise<BrowserPushState> {
  const capabilityGap = describePushCapabilityGap();
  const supported = capabilityGap === null;
  const permission: BrowserPushState['permission'] =
    typeof Notification === 'undefined' ? 'unavailable' : Notification.permission;

  let swScope: string | null = null;
  let swState = 'none';
  let endpoint: string | null = null;
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        swScope = reg.scope;
        const worker = reg.active || reg.waiting || reg.installing;
        swState = worker ? worker.state : 'none';
        // 壳浏览器可能有 SW 却没有 PushManager，这里不能无条件点下去。
        const sub = await reg.pushManager?.getSubscription();
        endpoint = sub?.endpoint || null;
      }
    } catch { /* 读不到就维持默认值 */ }
  }

  return {
    supported,
    capabilityGap,
    permission,
    swScope,
    swState,
    endpoint,
    endpointDead: isDeadPushEndpoint(endpoint),
    channel: detectPushChannel(endpoint),
    iosNeedsPwa: detectIosNeedsPwa(),
    capacitorNative: detectCapacitorNative(),
  };
}

/**
 * Translate the browser's raw subscribe() rejection into a Chinese,
 * end-user-actionable hint.  The common cases on Android phones without
 * Google Play Services (or in third-party Chromium-based browsers that
 * advertise `PushManager` but route through FCM internally) are
 * `AbortError` / generic network errors when the FCM endpoint cannot be
 * reached.  We surface those distinctly so the user knows it's not a
 * permission issue.
 */
export function explainSubscribeError(e: unknown): string {
  const err = e as { name?: string; message?: string } | null;
  const name = err?.name || '';
  const msg = err?.message || String(e || '未知错误');
  if (name === 'NotAllowedError') {
    return '浏览器拒绝创建订阅（NotAllowedError）——通常是站点权限被拦截或处于隐身模式';
  }
  if (name === 'NotSupportedError') {
    return '当前浏览器不支持网页推送——常见于没装谷歌服务的国行安卓手机（小米/华为/OPPO/vivo 大多默认就没有），或者手机自带的精简浏览器。换 Chrome / Edge / Firefox 桌面版试试';
  }
  if (name === 'AbortError' || /push service|FCM|network/i.test(msg)) {
    return '连不上推送服务器——这台设备的网页推送链路走不通。最常见两种情况：1) 国行安卓手机没装谷歌服务（小米/华为/OPPO/vivo 默认就没有），系统层面就推不了；2) 当前网络挡住了谷歌的推送服务器。建议：换台装了谷歌服务的设备，或者用电脑上的 Chrome / Edge / Firefox 试试';
  }
  if (name === 'InvalidStateError') {
    return '订阅状态冲突（InvalidStateError）——可能旧订阅没清干净，刷新页面或再点一次"重置订阅"';
  }
  return `订阅创建失败（${name || 'Error'}：${msg}）`;
}

/**
 * Subscribe with retry on zombie sentinel.  Wait between attempts is linear:
 * 800ms before attempt #2, 1600ms before attempt #3.  No wait before the
 * first attempt — caller is responsible for any required settle delay after
 * its own unsubscribe().
 */
export async function subscribeWithRetry(
  reg: ServiceWorkerRegistration,
  vapidPublicKey: string,
  logPrefix: string,
): Promise<{ sub: PushSubscription | null; reason?: string }> {
  for (let attempt = 0; attempt < SUBSCRIBE_ATTEMPTS_MAX; attempt++) {
    let sub: PushSubscription;
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64uToBytes(vapidPublicKey),
      });
    } catch (e) {
      console.warn(`${logPrefix} pushManager.subscribe failed`, e);
      return { sub: null, reason: explainSubscribeError(e) };
    }
    if (!isDeadPushEndpoint(sub.endpoint)) return { sub };
    try { await sub.unsubscribe(); } catch (e) {
      // 如果连 unsubscribe 都抛, 下一次 subscribe() 大概率还是同一个 zombie,
      // 但仍然兜底重试 (重试上限挡着不会死循环).
      console.warn(`${logPrefix} unsubscribe of zombie endpoint threw`, e);
    }
    const isLast = attempt === SUBSCRIBE_ATTEMPTS_MAX - 1;
    if (!isLast) {
      const wait = SUBSCRIBE_SETTLE_MS * (attempt + 1);
      console.warn(`${logPrefix} subscribe() returned zombie endpoint; retry #${attempt + 1} after ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  return {
    sub: null,
    reason: `浏览器持续返回 permanently-removed.invalid（已尝试 ${SUBSCRIBE_ATTEMPTS_MAX} 次）— 可能是由于站点参与度 (Site Engagement) 过低或浏览器内部数据残留导致。请尝试清理站点数据后重试，或更换设备/浏览器`,
  };
}

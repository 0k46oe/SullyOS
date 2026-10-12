import { Capacitor } from '@capacitor/core';

/**
 * 跨端取定位: 原生 (Capacitor) 优先用 @capacitor/geolocation 插件 (会弹原生权限申请),
 * 插件取坐标失败时回退到 WebView 的 navigator.geolocation; 浏览器直接走 navigator。
 *
 * 为什么这么绕:
 * - 插件的 requestPermissions 走的是标准 Android 运行时权限 (不依赖 GMS), 用它弹权限框最稳。
 * - 但官方 @capacitor/geolocation 取坐标底层用 Google Play Services 的 Fused Location Provider,
 *   设备没有 GMS (国产 ROM / 纯净系统 / 去谷歌机型) 会抛 "Google Play services unavailable"。
 *   这种情况回退到 navigator.geolocation —— 它在 Capacitor WebView 里走系统 LocationManager,
 *   不碰 GMS, 正是没谷歌的机器一直能用的那条路。
 * - 另外: 原生还需在 AndroidManifest 里声明 ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION,
 *   iOS 需在 Info.plist 加 NSLocationWhenInUseUsageDescription。
 */
export interface GeoResult { longitude: number; latitude: number; accuracy: number; }

export class DevicePositionError extends Error {
    constructor(message: string, public readonly code: number) { super(message); }
}

/** Fixed explanations only: never show the native/browser error's raw message. */
export function describeDevicePositionError(error: unknown): string {
    const code = (error as { code?: number } | undefined)?.code;
    if (code === 0) return '当前浏览器不支持设备定位，请换浏览器或在手机上使用。';
    if (code === 1) return '没有定位权限，请在浏览器或系统设置中允许定位。';
    if (code === 2) return '设备没有取得坐标，请检查系统定位是否开启，或在手机上重试。';
    if (code === 3) return '设备定位超时，请检查系统定位和网络，或在手机上重试。';
    return '没有取得设备坐标，请检查定位权限和系统定位，或在手机上重试。';
}

const getPositionViaNavigator = (): Promise<GeoResult> => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
        throw new DevicePositionError('当前环境不支持定位, 请选城市或手输坐标', 0);
    }
    return new Promise<GeoResult>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ longitude: pos.coords.longitude, latitude: pos.coords.latitude, accuracy: pos.coords.accuracy ?? 99999 }),
            (err) => reject(new DevicePositionError(err.message || '定位失败', err.code)),
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
        );
    });
};

export const getCurrentPositionSmart = async (options?: { quiet?: boolean }): Promise<GeoResult> => {
    // 原生: 先用插件弹权限, 取坐标失败再回退 navigator
    if (Capacitor.isNativePlatform()) {
        const { Geolocation } = await import('@capacitor/geolocation');
        try {
            const perm = await Geolocation.checkPermissions();
            if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
                const req = await Geolocation.requestPermissions({ permissions: ['location', 'coarseLocation'] as any });
                if (req.location !== 'granted' && (req as any).coarseLocation !== 'granted') {
                    throw new Error('定位权限被拒绝。请到 系统设置 → 应用 → 权限 里允许定位, 或直接选城市。');
                }
            }
        } catch (e: any) {
            // checkPermissions/requestPermissions 在个别机型会抛, 不阻塞, 直接尝试取位置
            if (!options?.quiet) console.warn('[geo] 权限检查异常, 继续尝试取位置:', e?.message || e);
        }
        try {
            const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
            return { longitude: pos.coords.longitude, latitude: pos.coords.latitude, accuracy: pos.coords.accuracy ?? 99999 };
        } catch (e: any) {
            // 没 GMS 的机器插件取坐标会抛 "Google Play services unavailable" —— 回退 WebView 定位 (走系统 LocationManager)
            if (!options?.quiet) console.warn('[geo] Capacitor 插件取位置失败, 回退 navigator.geolocation:', e?.message || e);
            return getPositionViaNavigator();
        }
    }

    // 浏览器: navigator.geolocation
    return getPositionViaNavigator();
};

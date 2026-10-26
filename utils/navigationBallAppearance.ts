import { useSyncExternalStore } from 'react';

export type NavigationBallShape = 'circle' | 'square' | 'rounded';
export type NavigationBallAppearance = { shape: NavigationBallShape; opacity: number; image: string; size: number };
export const NAVIGATION_BALL_SIZE_MIN = 24;
export const NAVIGATION_BALL_SIZE_MAX = 160;
export const NAVIGATION_BALL_APPEARANCE_KEY = 'sully_navigation_ball_appearance_v1';
export const DEFAULT_NAVIGATION_BALL_APPEARANCE: Readonly<NavigationBallAppearance> = Object.freeze({ shape: 'rounded', opacity: 1, image: '', size: 44 });
export const navigationBallShapeRadius: Record<NavigationBallShape, string> = { circle: '50%', square: '0px', rounded: '14px' };
const MAX_IMAGE_LENGTH = 800_000;
const isSafeImage = (image: unknown): image is string => typeof image === 'string'
  && image.length <= MAX_IMAGE_LENGTH && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image);

export function normalizeNavigationBallAppearance(value: unknown): NavigationBallAppearance {
  const source = value && typeof value === 'object' ? value as Partial<NavigationBallAppearance> : {};
  return {
    shape: source.shape === 'circle' || source.shape === 'square' ? source.shape : 'rounded',
    opacity: typeof source.opacity === 'number' && Number.isFinite(source.opacity) ? Math.min(1, Math.max(0.1, source.opacity)) : 1,
    image: isSafeImage(source.image) ? source.image : '',
    size: typeof source.size === 'number' && Number.isFinite(source.size)
      ? Math.round(Math.min(NAVIGATION_BALL_SIZE_MAX, Math.max(NAVIGATION_BALL_SIZE_MIN, source.size))) : 44,
  };
}

let appearance: NavigationBallAppearance | undefined;
const listeners = new Set<() => void>();
function snapshot(): NavigationBallAppearance {
  if (!appearance) {
    try { appearance = normalizeNavigationBallAppearance(JSON.parse(localStorage.getItem(NAVIGATION_BALL_APPEARANCE_KEY) || 'null')); }
    catch { appearance = { ...DEFAULT_NAVIGATION_BALL_APPEARANCE }; }
  }
  return appearance;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === NAVIGATION_BALL_APPEARANCE_KEY || event.key === null) {
      appearance = undefined; listeners.forEach(notify => notify());
    }
  };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}
export function setNavigationBallAppearance(patch: Partial<NavigationBallAppearance>) {
  if (patch.image && !isSafeImage(patch.image)) throw new Error('图片过大或格式不支持，请使用 PNG、JPEG 或 WebP 图片');
  const next = normalizeNavigationBallAppearance({ ...snapshot(), ...patch });
  // Persist before publishing: never claim that an upload survived a quota failure.
  try { localStorage.setItem(NAVIGATION_BALL_APPEARANCE_KEY, JSON.stringify(next)); }
  catch { throw new Error('外观保存失败，请检查浏览器本地存储空间后重试'); }
  appearance = next; listeners.forEach(notify => notify());
}
export function resetNavigationBallAppearance() {
  try { localStorage.removeItem(NAVIGATION_BALL_APPEARANCE_KEY); }
  catch { throw new Error('无法恢复默认外观，请检查浏览器本地存储权限'); }
  appearance = { ...DEFAULT_NAVIGATION_BALL_APPEARANCE }; listeners.forEach(notify => notify());
}
export function useNavigationBallAppearance() {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_NAVIGATION_BALL_APPEARANCE);
}

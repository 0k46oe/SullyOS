import { useEffect, useState, useSyncExternalStore } from 'react';

// Only this pinned public asset directory is used; never send credentials or chat data.
export const CLAWD_ASSET_BASE = 'https://raw.githubusercontent.com/0k46oe/clawd-on-desk/ea846be1182ed387cde628b28f53244edc840ce5/assets/gif/';
const CLAWD_CDN_BASE = 'https://cdn.jsdelivr.net/gh/0k46oe/clawd-on-desk@ea846be1182ed387cde628b28f53244edc840ce5/assets/gif/';
export const CLAWD_STANDARD_FORM_SCALE = 1.25;
export const CLAWD_FORM_SCALE_MIN = 0.25;
export const CLAWD_FORM_SCALE_MAX = 2;
export const CLAWD_FORMS = [
  ['idle', '待机'], ['thinking', '思考'], ['typing', '打字'], ['happy', '开心'],
  ['error', '出错'], ['sleeping', '睡觉'], ['notification', '提醒'], ['building', '搭建'],
  ['sweeping', '打扫'], ['carrying', '搬东西'], ['conducting', '指挥'],
  ['headphones-groove', '耳机律动'], ['idle-reading', '读书'], ['juggling', '杂耍'],
  ['debugger', '调试'], ['bubble', '泡泡'], ['react-annoyed', '生气'],
  ['react-double-jump', '跳跃'], ['mini-idle', '迷你待机'], ['mini-happy', '迷你开心'],
  ['mini-alert', '迷你提醒'], ['mini-crabwalk', '迷你横走'], ['mini-peek', '迷你探头'], ['mini-enter', '迷你登场'],
] as const;
export type ClawdForm = typeof CLAWD_FORMS[number][0];
export const CLAWD_FORM_DEFAULT_SCALES: Readonly<Record<ClawdForm, number>> = Object.freeze(
  Object.fromEntries(CLAWD_FORMS.map(([form]) => [form, form === 'idle' ? 0.5 : form === 'headphones-groove' ? 0.9 : 1])) as Record<ClawdForm, number>,
);
// Union of every composited frame's alpha bounds in the pinned GIFs above.
// Keep whole animations (including props) while removing only empty outer canvas.
export const CLAWD_FRAME_BOUNDS: Partial<Record<ClawdForm, readonly [number, number, number, number, number, number]>> = {
  idle: [302, 300, 99, 207, 201, 273],
  thinking: [302, 300, 80, 134, 199, 268],
  typing: [302, 300, 96, 126, 203, 275],
  happy: [302, 300, 50, 103, 243, 273],
  error: [302, 300, 90, 136, 217, 275],
  sleeping: [302, 300, 91, 139, 209, 273],
  notification: [302, 300, 61, 124, 200, 273],
  building: [303, 300, 94, 157, 247, 277],
  sweeping: [302, 300, 77, 184, 199, 283],
  carrying: [302, 300, 91, 177, 215, 274],
  conducting: [302, 300, 90, 133, 220, 270],
  'headphones-groove': [302, 300, 61, 180, 225, 273],
  'idle-reading': [302, 300, 92, 169, 201, 273],
  juggling: [302, 300, 95, 152, 205, 273],
  debugger: [302, 300, 93, 191, 222, 274],
  bubble: [302, 300, 100, 137, 258, 273],
  'react-annoyed': [302, 300, 100, 127, 236, 273],
  'react-double-jump': [302, 300, 89, 112, 213, 273],
};
function normalizeClawdScales(value: unknown): Record<ClawdForm, number> {
  const source = value && typeof value === 'object' ? value as Partial<Record<ClawdForm, unknown>> : {};
  return Object.fromEntries(CLAWD_FORMS.map(([form]) => {
    const raw = source[form];
    const fallback = CLAWD_FORM_DEFAULT_SCALES[form];
    const scale = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
    return [form, Math.min(CLAWD_FORM_SCALE_MAX, Math.max(CLAWD_FORM_SCALE_MIN, scale))];
  })) as Record<ClawdForm, number>;
}
export function clawdFrameStyle(form: ClawdForm, formScale = CLAWD_FORM_DEFAULT_SCALES[form] ?? 1) {
  const bounds = CLAWD_FRAME_BOUNDS[form];
  const scale = Math.min(CLAWD_FORM_SCALE_MAX, Math.max(CLAWD_FORM_SCALE_MIN, formScale));
  if (!bounds) return scale === 1 ? undefined : { transform: `scale(${scale})`, transformOrigin: 'right bottom' };
  const [width, height, left, top, right, bottom] = bounds;
  // Use the visible alpha height as the common scale. Props can extend
  // horizontally, but the character height stays comparable across forms.
  const span = Math.max(1, bottom - top);
  // Keep scaled forms anchored to the same bottom-right visible-pixel point.
  return { width: `${302 / span * scale * 100}%`, height: `${300 / span * scale * 100}%`,
    left: `${(1 - right / span * scale) * 100}%`, top: `${(1 - bottom / span * scale) * 100}%` };
}
export type NavigationPetSelection = 'auto' | ClawdForm;
export type NavigationPetPreferences = { enabled: boolean; selection: NavigationPetSelection; scales: Record<ClawdForm, number> };
export const NAVIGATION_PET_KEY = 'sully_navigation_ball_pet_v1';
const defaults: NavigationPetPreferences = Object.freeze({ enabled: false, selection: 'auto', scales: normalizeClawdScales(null) });
const validForm = (value: unknown): value is ClawdForm => CLAWD_FORMS.some(([form]) => form === value);
export function normalizeNavigationPet(value: unknown): NavigationPetPreferences {
  const source = value && typeof value === 'object' ? value as Partial<NavigationPetPreferences> : {};
  return { enabled: source.enabled === true, selection: validForm(source.selection) ? source.selection : 'auto', scales: normalizeClawdScales(source.scales) };
}
export function clawdImageUrl(form: ClawdForm): string { return `${CLAWD_ASSET_BASE}clawd-${validForm(form) ? form : 'idle'}.gif`; }
export function clawdFallbackUrl(form: ClawdForm): string { return `${CLAWD_CDN_BASE}clawd-${validForm(form) ? form : 'idle'}.gif`; }
let preferences: NavigationPetPreferences | undefined;
const preferenceListeners = new Set<() => void>();
function snapshot() {
  if (!preferences) {
    try { preferences = normalizeNavigationPet(JSON.parse(localStorage.getItem(NAVIGATION_PET_KEY) || 'null')); }
    catch { preferences = defaults; }
  }
  return preferences;
}
function subscribe(listener: () => void) {
  preferenceListeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (event.key === NAVIGATION_PET_KEY || event.key === null) {
      preferences = undefined; preferenceListeners.forEach(notify => notify());
    }
  };
  window.addEventListener('storage', storage);
  return () => { preferenceListeners.delete(listener); window.removeEventListener('storage', storage); };
}
export function setNavigationPet(patch: Partial<NavigationPetPreferences>) {
  const next = normalizeNavigationPet({ ...snapshot(), ...patch });
  try { localStorage.setItem(NAVIGATION_PET_KEY, JSON.stringify(next)); }
  catch { throw new Error('宠物设置保存失败，请检查浏览器本地存储空间'); }
  preferences = next; preferenceListeners.forEach(notify => notify());
}
export function setNavigationPetFormScale(form: ClawdForm, scale: number) {
  const nextScale = Math.min(CLAWD_FORM_SCALE_MAX, Math.max(CLAWD_FORM_SCALE_MIN, scale));
  setNavigationPet({ scales: { ...snapshot().scales, [form]: nextScale } });
}
export function useNavigationPetPreferences() { return useSyncExternalStore(subscribe, snapshot, () => defaults); }

type Phase = 'thinking' | 'typing';
type Activity = { phase: Phase | null; result: 'happy' | 'error' | null; at: number; revision: number };
const requests = new Map<symbol, Phase>();
const activityListeners = new Set<() => void>();
let activity: Activity = { phase: null, result: null, at: Date.now(), revision: 0 };
function publish(result: Activity['result'] = null) {
  activity = { phase: [...requests.values()].includes('typing') ? 'typing' : requests.size ? 'thinking' : null,
    result, at: Date.now(), revision: activity.revision + 1 };
  activityListeners.forEach(notify => notify());
}
/** One handle per ordinary-chat reply, including retries and tool continuations. */
export function beginNavigationPetChat() {
  const id = Symbol(); requests.set(id, 'thinking'); publish();
  return {
    phase(next: Phase) {
      if (requests.has(id) && requests.get(id) !== next) { requests.set(id, next); publish(); }
    },
    finish(outcome: 'success' | 'error' | 'cancelled') {
      if (requests.delete(id)) publish(outcome === 'success' ? 'happy' : outcome === 'error' ? 'error' : null);
    },
  };
}
export function resolveNavigationPetForm(current: Activity, now: number): ClawdForm {
  if (current.phase) return current.phase;
  const elapsed = Math.max(0, now - current.at);
  if (current.result && elapsed < (current.result === 'error' ? 6000 : 3500)) return current.result;
  return elapsed >= 60000 ? 'sleeping' : 'idle';
}
const subscribeActivity = (listener: () => void) => { activityListeners.add(listener); return () => { activityListeners.delete(listener); }; };
export function useNavigationPetForm(): ClawdForm {
  const current = useSyncExternalStore(subscribeActivity, () => activity, () => activity);
  const [, tick] = useState(0);
  useEffect(() => {
    if (current.phase) return;
    const elapsed = Math.max(0, Date.now() - current.at);
    const resultEnd = current.result === 'error' ? 6000 : current.result ? 3500 : 0;
    const next = elapsed < resultEnd ? resultEnd : elapsed < 60000 ? 60000 : null;
    if (next === null) return;
    const timer = setTimeout(() => tick(value => value + 1), Math.max(1, next - elapsed));
    return () => clearTimeout(timer);
  });
  return resolveNavigationPetForm(current, Date.now());
}

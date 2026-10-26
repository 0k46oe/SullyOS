import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { NAVIGATION_SLOT_APPS, NAVIGATION_BALL_POSITION_KEY, subscribeNavigationBallPositionReset, useNavigationBallEnabled, useNavigationBallSlots, useNavigationPickerOpen } from '../../utils/navigationBall';
import { AppID } from '../../types';
import { Icons } from '../../constants';
import { ArrowUUpLeft, GearSix, House, PlugsConnected, Plus, SlidersHorizontal, X } from '@phosphor-icons/react';
import { requestSettingsFocus } from '../../utils/settingsNavigation';
import { describeNavigationShortcut, type NavigationShortcut, type ShortcutCharacter } from '../../utils/navigationShortcuts';
import { launchNavigationShortcut } from '../../utils/navigationShortcutLaunch';
import { clampBubblePos, resolveSafeTopInset } from '../../utils/floatingBallBounds';
import { isIOSStandaloneWebApp, readSafeAreaInsets } from '../../utils/iosStandalone';
import { navigationBallShapeRadius, useNavigationBallAppearance } from '../../utils/navigationBallAppearance';
import NavigationBallFace from './NavigationBallFace';
import { CLAWD_STANDARD_FORM_SCALE, useNavigationPetForm, useNavigationPetPreferences } from '../../utils/navigationBallPet';
import NavigationPetControls from './NavigationPetControls';
import './NavigationBall.css';
const NavigationApiSwitcher = React.lazy(() => import('./NavigationApiSwitcher'));

const POSITION_KEY = NAVIGATION_BALL_POSITION_KEY;
const POSITION_MIGRATION_KEY = `${POSITION_KEY}_clawd_edge_v1`;
type Position = { x: number; y: number };
const alphaCanvases = new WeakMap<HTMLImageElement, HTMLCanvasElement>();

function isInsideBallShape(button: HTMLButtonElement, x: number, y: number) {
  const rect = button.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
  const radiusValue = getComputedStyle(button).borderTopLeftRadius;
  if (radiusValue.endsWith('%')) {
    const rx = rect.width / 2, ry = rect.height / 2;
    if (!rx || !ry) return false;
    return ((x - (rect.left + rx)) / rx) ** 2 + ((y - (rect.top + ry)) / ry) ** 2 <= 1;
  }
  const radius = Math.min(parseFloat(radiusValue) || 0, rect.width / 2, rect.height / 2);
  if (!radius) return true;
  const dx = Math.min(x - rect.left, rect.right - x);
  const dy = Math.min(y - rect.top, rect.bottom - y);
  return dx >= radius || dy >= radius || (dx - radius) ** 2 + (dy - radius) ** 2 <= radius ** 2;
}

/** Reads the currently displayed image/GIF frame to ignore transparent canvas pixels. */
function isOpaqueImagePoint(image: HTMLImageElement, x: number, y: number): boolean | null {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight) return null;
  const rect = image.getBoundingClientRect();
  if (!rect.width || !rect.height || x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;

  const style = getComputedStyle(image);
  const fit = style.objectFit;
  let contentLeft = rect.left, contentTop = rect.top, contentWidth = rect.width, contentHeight = rect.height;
  if (fit === 'contain' || fit === 'cover') {
    const scale = fit === 'contain'
      ? Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
      : Math.max(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    contentWidth = image.naturalWidth * scale;
    contentHeight = image.naturalHeight * scale;
    const position = style.objectPosition.split(/\s+/);
    const fraction = (value: string | undefined, farEdge: 'right' | 'bottom') => {
      if (value === farEdge) return 1;
      if (value === 'left' || value === 'top') return 0;
      const percent = value?.match(/(-?\d+(?:\.\d+)?)%/);
      return percent ? Number(percent[1]) / 100 : 0.5;
    };
    contentLeft += (rect.width - contentWidth) * fraction(position[0], 'right');
    contentTop += (rect.height - contentHeight) * fraction(position[1], 'bottom');
  }
  const sourceX = Math.floor((x - contentLeft) / contentWidth * image.naturalWidth);
  const sourceY = Math.floor((y - contentTop) / contentHeight * image.naturalHeight);
  if (sourceX < 0 || sourceX >= image.naturalWidth || sourceY < 0 || sourceY >= image.naturalHeight) return false;

  let canvas = alphaCanvases.get(image);
  if (!canvas) {
    canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    alphaCanvases.set(image, canvas);
  }
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return false;
  try {
    context.clearRect(0, 0, 1, 1);
    context.drawImage(image, sourceX, sourceY, 1, 1, 0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3] > 16;
  } catch {
    return false;
  }
}

function isNavigationBallHit(button: HTMLButtonElement, x: number, y: number, petEnabled: boolean) {
  const rect = button.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
  if (!petEnabled && !isInsideBallShape(button, x, y)) return false;
  const image = button.querySelector('img');
  if (!image) return petEnabled ? false : isInsideBallShape(button, x, y);
  // Unknown or cross-origin pixels should not turn the full transparent image box into a hit target.
  return isOpaqueImagePoint(image, x, y) ?? false;
}

function readPosition(): Position | null {
  try {
    const value = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) return value;
  } catch { /* Use the default position. */ }
  return null;
}
function measure(parent: HTMLElement, size: number, alignRight: boolean) {
  const rect = parent.getBoundingClientRect(), style = getComputedStyle(parent), safe = readSafeAreaInsets();
  const top = resolveSafeTopInset({
    standaloneSafeTop: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--standalone-safe-area-top')) || 0,
    probedSafeTop: safe.top, isIOSStandalone: isIOSStandaloneWebApp(),
  });
  return { rect, bounds: { parentW: rect.width, parentH: rect.height, bubble: size, ...(alignRight ? { padRight: 0 } : {}),
    insetTop: Math.max(parseFloat(style.paddingTop) || 0, top),
    insetBottom: Math.max(parseFloat(style.paddingBottom) || 0, safe.bottom) } };
}
function clampRenderedBallPosition(x: number, y: number, bounds: ReturnType<typeof measure>['bounds'], overflow: number) {
  const visible = clampBubblePos(x - overflow, y - overflow, bounds);
  return { x: visible.x + overflow, y: visible.y + overflow };
}
type NavigationActions = {
  onBack: () => void; onHome: () => void; onApi: () => void;
  onShortcut: (shortcut: NavigationShortcut) => void; onConfigure: () => void;
  characters?: readonly ShortcutCharacter[];
  apiLabel?: string;
};
export function DraggableNavigationBall({ onBack, onHome, onApi, onShortcut, onConfigure, characters = [], apiLabel = 'API 配置' }: NavigationActions) {
  const slots = useNavigationBallSlots();
  const appearance = useNavigationBallAppearance();
  const pet = useNavigationPetPreferences();
  const automaticPetForm = useNavigationPetForm();
  const petForm = pet.selection === 'auto' ? automaticPetForm : pet.selection;
  const enlargedPet = pet.enabled && !petForm.startsWith('mini-');
  const visualSize = appearance.size * (enlargedPet ? CLAWD_STANDARD_FORM_SCALE : 1);
  const visualOverflow = visualSize - appearance.size;
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position | null>(readPosition);
  const hasManualPosition = useRef(position !== null);
  const clawdPositionMigrated = useRef(false);
  const [open, setOpen] = useState(false);
  const [parentSize, setParentSize] = useState({ width: 0, height: 0, top: 0, bottom: 0 });
  const latest = useRef(position); latest.current = position;
  const suppressClick = useRef(false);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; origin: Position;
    bounds: ReturnType<typeof measure>['bounds']; overflow: number; moved: boolean } | null>(null);
  useLayoutEffect(() => {
    const parent = root.current?.parentElement;
    if (!parent) return;
    const constrain = () => {
      const { bounds } = measure(parent, visualSize, pet.enabled);
      setParentSize({ width: bounds.parentW, height: bounds.parentH, top: bounds.insetTop, bottom: bounds.insetBottom });
      let value = hasManualPosition.current && latest.current
        ? latest.current
        : { x: bounds.parentW - appearance.size - (pet.enabled ? 0 : 12), y: bounds.parentH - appearance.size - (pet.enabled ? 8 : 96) };
      if (pet.enabled && !clawdPositionMigrated.current) {
        clawdPositionMigrated.current = true;
        try {
          if (localStorage.getItem(POSITION_MIGRATION_KEY) !== '1') {
            if (hasManualPosition.current && latest.current) {
              value = { x: bounds.parentW - appearance.size, y: bounds.parentH - appearance.size - 8 };
              localStorage.setItem(POSITION_KEY, JSON.stringify(value));
            }
            localStorage.setItem(POSITION_MIGRATION_KEY, '1');
          }
        } catch { /* Keep the live position if storage is unavailable. */ }
      }
      const next = clampRenderedBallPosition(value.x, value.y, bounds, visualOverflow);
      latest.current = next; setPosition(next);
    };
    drag.current = null;
    constrain();
    const unsubscribeReset = subscribeNavigationBallPositionReset(() => {
      drag.current = null; suppressClick.current = false; setOpen(false);
      hasManualPosition.current = false;
      latest.current = null; constrain();
    });
    const observer = new ResizeObserver(constrain); observer.observe(parent);
    return () => { observer.disconnect(); unsubscribeReset(); };
  }, [appearance.size, enlargedPet, pet.enabled, visualOverflow, visualSize]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [open]);
  const finish = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    suppressClick.current = cancelled || drag.current.moved;
    if (drag.current.moved && latest.current) {
      hasManualPosition.current = true;
      try { localStorage.setItem(POSITION_KEY, JSON.stringify(latest.current)); } catch { /* Keep the current position. */ }
    }
    drag.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
  };
  const run = (action: () => void) => { setOpen(false); action(); };
  const panelWidth = Math.min(288, Math.max(144, parentSize.width - 24));
  const panelHeight = pet.enabled ? 374 : 288;
  const availableHeight = Math.max(44, parentSize.height - parentSize.top - parentSize.bottom - 24);
  const renderedLeft = (position?.x || 0) - visualOverflow;
  const renderedTop = (position?.y || 0) - visualOverflow;
  const panelLeft = (parentSize.width - panelWidth) / 2 - renderedLeft;
  const panelTop = parentSize.top + 12 + Math.max(0, (availableHeight - panelHeight) / 2) - renderedTop;
  const slotButton = (index: number) => {
    const shortcut = slots[index];
    const app = NAVIGATION_SLOT_APPS.find(item => item.id === shortcut?.appId);
    const label = describeNavigationShortcut(shortcut, characters);
    const Icon = app ? Icons[app.icon] || GearSix : Plus;
    return <button type="button" key={index} aria-label={app ? `打开${label.detail}` : `设置 App 槽位 ${index + 1}`} title={label.detail}
      onClick={() => run(() => shortcut ? onShortcut(shortcut) : onConfigure())}>
      <Icon className="navigation-ball-action-icon" /><span>{app ? label.name : `槽位 ${index + 1}`}
        {(shortcut?.characterId || shortcut?.worldId) && <small className="navigation-ball-target-kind">{label.detail.split(' › ').slice(0, -1).pop()}</small>}
      </span>
    </button>;
  };
  return <div ref={root} className="navigation-ball" style={{ ...(position ? { left: renderedLeft, top: renderedTop } : { right: pet.enabled ? 0 : 12, bottom: pet.enabled ? 8 : 96 }), '--navigation-ball-size': `${appearance.size}px`, '--navigation-ball-rendered-size': `${visualSize}px` } as React.CSSProperties & { '--navigation-ball-size': string; '--navigation-ball-rendered-size': string }}
    onPointerDown={event => {
      suppressClick.current = false;
      const button = root.current?.querySelector<HTMLButtonElement>('.navigation-ball-toggle');
      const panel = root.current?.querySelector<HTMLElement>('.navigation-ball-panel');
      if (event.button !== 0 || !root.current?.parentElement || !latest.current || panel?.contains(event.target as Node) || !button
        || !isNavigationBallHit(button, event.clientX, event.clientY, pet.enabled)) return;
      const { bounds } = measure(root.current.parentElement, visualSize, pet.enabled);
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: latest.current, bounds, overflow: visualOverflow, moved: false };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer events remain usable. */ }
    }}
    onPointerMove={event => {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const dx = event.clientX - state.startX, dy = event.clientY - state.startY;
      if (!state.moved && Math.hypot(dx, dy) <= 4) return;
      state.moved = true; setOpen(false);
      const next = clampRenderedBallPosition(state.origin.x + dx, state.origin.y + dy, state.bounds, state.overflow);
      latest.current = next; setPosition(next);
    }} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}
    onClick={event => {
      const button = root.current?.querySelector<HTMLButtonElement>('.navigation-ball-toggle');
      const panel = root.current?.querySelector<HTMLElement>('.navigation-ball-panel');
      if (!button || panel?.contains(event.target as Node)) return;
      if (event.detail !== 0 && suppressClick.current) { suppressClick.current = false; return; }
      if (event.detail !== 0 && !isNavigationBallHit(button, event.clientX, event.clientY, pet.enabled)) return;
      setOpen(value => !value);
    }}>
    <button type="button" className="navigation-ball-toggle" aria-label="快捷导航悬浮球" aria-expanded={open}
      data-custom-image={pet.enabled || !!appearance.image} data-pet={pet.enabled} data-pet-large={enlargedPet} data-pet-form={pet.enabled ? petForm : undefined} data-image-border={appearance.imageBorder} style={{ borderRadius: navigationBallShapeRadius[appearance.shape], opacity: appearance.opacity }}>
      <NavigationBallFace appearance={appearance} />
    </button>
    {open && <div className="navigation-ball-panel" role="group" aria-label="快捷导航"
      style={{ left: panelLeft, top: panelTop, width: panelWidth, maxHeight: availableHeight, overflowY: 'auto' }}>
      {slotButton(0)}
      <button type="button" onClick={() => run(onApi)}><PlugsConnected className="navigation-ball-action-icon" /><span>{apiLabel}</span></button>
      <button type="button" aria-label="返回上一级" onClick={() => run(onBack)}><ArrowUUpLeft className="navigation-ball-action-icon" /><span>上一级</span></button>
      {slotButton(1)}
      <button type="button" aria-label="回到桌面" onClick={() => run(onHome)}><House className="navigation-ball-action-icon" /><span>桌面</span></button>
      {slotButton(2)}
      {slotButton(3)}
      <button type="button" onClick={() => run(onConfigure)}><SlidersHorizontal className="navigation-ball-action-icon" /><span>自定义</span></button>
      <button type="button" onClick={() => setOpen(false)}><X className="navigation-ball-action-icon" /><span>收起</span></button>
      {pet.enabled && <NavigationPetControls compact />}
    </div>}
  </div>;
}
export default function NavigationBall() {
  const enabled = useNavigationBallEnabled();
  const pickerOpen = useNavigationPickerOpen();
  const { isLocked, handleBack, closeApp, openApp, characters = [], setActiveCharacterId, addToast, apiPresets = [], activeApp, activeCharacterId } = useOS();
  const [apiPickerOpen, setApiPickerOpen] = useState(false);
  useEffect(() => { setApiPickerOpen(false); }, [enabled, isLocked, pickerOpen, activeApp, activeCharacterId]);
  const openSettingsAt = (target: 'api' | 'navigation') => { requestSettingsFocus(target); openApp(AppID.Settings); };
  return enabled && !isLocked && !pickerOpen ? <><DraggableNavigationBall onBack={handleBack} onHome={closeApp}
    onApi={() => apiPresets.length ? setApiPickerOpen(true) : openSettingsAt('api')} characters={characters} apiLabel={apiPresets.length ? '切换 API' : 'API 配置'}
    onShortcut={shortcut => launchNavigationShortcut(shortcut, { characters, openApp, setActiveCharacterId,
      onMissingTarget: () => { addToast('这个角色已不存在，请重新设置槽位', 'error'); openSettingsAt('navigation'); } })}
    onConfigure={() => openSettingsAt('navigation')} />
    {apiPickerOpen && <React.Suspense fallback={<p role="status" className="absolute bottom-4 left-4 rounded-xl bg-white p-3 text-xs text-slate-500">正在打开 API 预设…</p>}>
      <NavigationApiSwitcher onClose={() => setApiPickerOpen(false)} onOpenSettings={() => { setApiPickerOpen(false); openSettingsAt('api'); }} />
    </React.Suspense>}
  </> : null;
}

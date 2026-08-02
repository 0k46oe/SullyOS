import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowClockwise,
  ArrowsOutCardinal,
  Check,
  ChatCircleDots,
  Gear,
  Phone,
  SlidersHorizontal,
  Sparkle,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { AppID } from '../../types';
import VRMVideoCallStage from '../call/VRMVideoCallStage';
import type { AvatarMotionState } from '../call/VRMAvatarCanvas';
import {
  avatarTouchZoneLabel,
  buildImmediateTouchPerformance,
  requestAvatarTouchReply,
  type AvatarTouchHit,
  type AvatarTouchModelAction,
} from '../../utils/avatarTouch';
import {
  DEFAULT_AVATAR_PERFORMANCE,
  DEFAULT_STAGE_FRAMING,
  type AvatarPerformanceDirection,
} from '../../utils/avatarPerformance';
import { DB } from '../../utils/db';
import { CHAT_GEN_EVENTS, announceChatGen } from '../../utils/chatGenEvents';
import { deleteBlobRef, isBlobRef, putImageBlob, useBlobRefUrl } from '../../utils/blobRef';
import { hslToHex, hueFromGradient, hueFromImage, normalizeHue } from '../../utils/dominantHue';

// ── 时段氛围：陪伴桌面按虚拟时间换天色（晨曦 / 白日 / 黄昏 / 夜晚）──
interface DayPeriod {
  key: 'dawn' | 'morning' | 'day' | 'dusk' | 'evening' | 'night';
  /** 时钟下方的小字时段标签。 */
  label: string;
  /** 顶部天光颜色（渐变入夜色底）。 */
  skyGlow: string;
  /** 氛围主色：粒子、点缀发光用。 */
  tint: string;
  /** 进入桌面时角色自动说的台词池。 */
  lines: string[];
  greetPerformance: AvatarPerformanceDirection;
}

const DAY_PERIODS: DayPeriod[] = [
  {
    key: 'dawn',
    label: '夜半独处',
    skyGlow: 'rgba(96,104,182,0.34)',
    tint: '#8d9bea',
    lines: [
      '这么晚还醒着……过来，陪你待一会儿。',
      '夜这么深了，是睡不着，还是在等我？',
      '嘘——这个时间的世界，只有我们两个人。',
    ],
    greetPerformance: { emotion: 'calm', gesture: 'tilt', camera: 'medium', gaze: 'viewer', intensity: 0.5, faces: ['smile-eyes'] },
  },
  {
    key: 'morning',
    label: '清晨',
    skyGlow: 'rgba(255,196,138,0.4)',
    tint: '#ffcf9b',
    lines: [
      '早安。今天也从见到你开始。',
      '醒啦？刚刚还在想你什么时候来。',
      '早上好。昨晚有好好睡吗？',
    ],
    greetPerformance: { emotion: 'happy', gesture: 'wave', camera: 'medium', gaze: 'viewer', intensity: 0.7, faces: ['smile-eyes'] },
  },
  {
    key: 'day',
    label: '午后',
    skyGlow: 'rgba(168,214,255,0.36)',
    tint: '#b4dcff',
    lines: [
      '这个点来找我，是想我了吧。',
      '午安。要不要歇一会儿，陪我说说话？',
      '今天忙不忙？我一直都在这里。',
    ],
    greetPerformance: { emotion: 'happy', gesture: 'nod', camera: 'medium', gaze: 'viewer', intensity: 0.6 },
  },
  {
    key: 'dusk',
    label: '黄昏',
    skyGlow: 'rgba(255,158,120,0.4)',
    tint: '#ffb08d',
    lines: [
      '天色变暖了。今天过得怎么样？',
      '黄昏了。剩下的时间，留给我好不好？',
      '晚霞很好看……但我更想看你。',
    ],
    greetPerformance: { emotion: 'relaxed', gesture: 'lean-in', camera: 'medium', gaze: 'viewer', intensity: 0.62, faces: ['smile-eyes'] },
  },
  {
    key: 'evening',
    label: '夜晚',
    skyGlow: 'rgba(178,150,255,0.38)',
    tint: '#c6adff',
    lines: [
      '晚上好。外面的事，就先放下吧。',
      '今晚也来陪我了，真好。',
      '回来啦。今天辛苦了。',
    ],
    greetPerformance: { emotion: 'happy', gesture: 'lean-in', camera: 'medium', gaze: 'viewer', intensity: 0.66, faces: ['smile-eyes'] },
  },
  {
    key: 'night',
    label: '深夜',
    skyGlow: 'rgba(112,118,196,0.34)',
    tint: '#96a2f2',
    lines: [
      '夜深了。再待五分钟，就去睡觉，好吗？',
      '还不睡？……好吧，那再陪你一小会儿。',
      '把灯调暗一点，我陪你到你想睡为止。',
    ],
    greetPerformance: { emotion: 'calm', gesture: 'tilt', camera: 'close', gaze: 'viewer', intensity: 0.52 },
  },
];

const periodForHour = (hours: number): DayPeriod => {
  if (hours < 5) return DAY_PERIODS[0];
  if (hours < 11) return DAY_PERIODS[1];
  if (hours < 17) return DAY_PERIODS[2];
  if (hours < 19) return DAY_PERIODS[3];
  if (hours < 23) return DAY_PERIODS[4];
  return DAY_PERIODS[5];
};

// ── 背景预设：华丽渐变场景（companionBackground = `preset:<id>`）──
interface CompanionBgPreset {
  id: string;
  name: string;
  css: string;
  /** 该场景的氛围主色（粒子/地面辉光跟着走）。 */
  tint: string;
}

const COMPANION_BG_PRESETS: CompanionBgPreset[] = [
  {
    id: 'galaxy',
    name: '星河',
    tint: '#b9a6ff',
    css: [
      'radial-gradient(1.4px 1.4px at 18% 22%, rgba(255,255,255,.9), transparent 55%)',
      'radial-gradient(1px 1px at 66% 12%, rgba(255,255,255,.8), transparent 55%)',
      'radial-gradient(1.6px 1.6px at 82% 34%, rgba(255,255,255,.75), transparent 55%)',
      'radial-gradient(1px 1px at 38% 8%, rgba(255,255,255,.65), transparent 55%)',
      'radial-gradient(1.2px 1.2px at 8% 48%, rgba(255,255,255,.5), transparent 55%)',
      'radial-gradient(1px 1px at 52% 30%, rgba(255,255,255,.6), transparent 55%)',
      'radial-gradient(90% 60% at 70% 8%, rgba(128,90,213,.4), transparent 65%)',
      'radial-gradient(70% 55% at 22% 30%, rgba(64,76,180,.42), transparent 70%)',
      'linear-gradient(180deg, #171238 0%, #1d1345 40%, #0b0a22 100%)',
    ].join(', '),
  },
  {
    id: 'aurora',
    name: '极光',
    tint: '#8ef0d0',
    css: [
      'radial-gradient(60% 42% at 32% 18%, rgba(84,230,180,.34), transparent 68%)',
      'radial-gradient(55% 38% at 66% 10%, rgba(90,170,255,.3), transparent 66%)',
      'radial-gradient(40% 30% at 82% 30%, rgba(150,110,255,.24), transparent 70%)',
      'linear-gradient(180deg, #0a1c2e 0%, #0c2237 46%, #061018 100%)',
    ].join(', '),
  },
  {
    id: 'sakura',
    name: '樱夜',
    tint: '#ffb7cf',
    css: [
      'radial-gradient(2px 2px at 24% 26%, rgba(255,183,207,.85), transparent 60%)',
      'radial-gradient(1.6px 1.6px at 70% 16%, rgba(255,205,222,.75), transparent 60%)',
      'radial-gradient(2.2px 2.2px at 84% 44%, rgba(255,183,207,.6), transparent 60%)',
      'radial-gradient(1.4px 1.4px at 12% 52%, rgba(255,205,222,.55), transparent 60%)',
      'radial-gradient(90% 55% at 50% 0%, rgba(255,140,180,.32), transparent 66%)',
      'linear-gradient(180deg, #2c1630 0%, #33182f 46%, #120a18 100%)',
    ].join(', '),
  },
  {
    id: 'sunset',
    name: '落日海',
    tint: '#ffb98a',
    css: [
      'radial-gradient(70% 46% at 50% 14%, rgba(255,166,98,.5), transparent 66%)',
      'radial-gradient(90% 32% at 50% 44%, rgba(255,104,110,.3), transparent 72%)',
      'linear-gradient(180deg, #3c1a3e 0%, #6a2846 38%, #2a1030 74%, #100818 100%)',
    ].join(', '),
  },
  {
    id: 'moonsea',
    name: '月海',
    tint: '#a9c8ff',
    css: [
      'radial-gradient(18% 12% at 72% 16%, rgba(235,242,255,.85), rgba(235,242,255,.12) 60%, transparent 72%)',
      'radial-gradient(60% 30% at 72% 62%, rgba(150,190,255,.22), transparent 70%)',
      'linear-gradient(180deg, #0d1730 0%, #12204a 48%, #060b18 100%)',
    ].join(', '),
  },
  {
    id: 'velvet',
    name: '丝绒',
    tint: '#e0b8ff',
    css: [
      'radial-gradient(80% 55% at 50% 0%, rgba(190,120,255,.35), transparent 66%)',
      'radial-gradient(60% 46% at 88% 60%, rgba(255,120,200,.18), transparent 70%)',
      'linear-gradient(180deg, #291238 0%, #1d0d33 52%, #0d0618 100%)',
    ].join(', '),
  },
];

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// ── 打字机：台词逐字浮现（按真实流逝时间推进；用 interval 而不是 rAF，
// 页面暂时不合成帧（后台/锁屏）也能走完，回到前台不会卡在半截）──
const useTypewriter = (text: string, charsPerSecond = 24): { shown: string; done: boolean } => {
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(0);
    if (!text) return;
    const startedAt = window.performance.now();
    const timer = window.setInterval(() => {
      const chars = 1 + Math.floor((window.performance.now() - startedAt) / (1000 / charsPerSecond));
      setCount(Math.min(text.length, chars));
      if (chars >= text.length) window.clearInterval(timer);
    }, 42);
    return () => window.clearInterval(timer);
  }, [text, charsPerSecond]);
  return { shown: text.slice(0, count), done: count >= text.length };
};

// 漂浮光尘：一次性生成固定轨迹，纯 transform/opacity 动画不进主线程布局。
interface DustMote {
  left: number;
  size: number;
  delay: number;
  duration: number;
  drift: number;
}

interface CompanionLine {
  text: string;
  label: string;
  kind: 'greeting' | 'touch';
}

const CompanionHome: React.FC = () => {
  const {
    characters,
    activeCharacterId,
    apiConfig,
    userProfile,
    openApp,
    addToast,
    theme,
    virtualTime,
    updateCharacter,
  } = useOS();
  const character = useMemo(
    () => characters.find(item => item.id === activeCharacterId) || characters[0] || null,
    [characters, activeCharacterId],
  );
  const [motionState, setMotionState] = useState<AvatarMotionState>('idle');
  const [performance, setPerformance] = useState<AvatarPerformanceDirection>(DEFAULT_AVATAR_PERFORMANCE);
  const [line, setLine] = useState<CompanionLine | null>(null);
  const [lastHit, setLastHit] = useState<AvatarTouchHit | null>(null);
  const [ripple, setRipple] = useState<{ nonce: number; x: number; y: number } | null>(null);
  const [vrmExpressions, setVrmExpressions] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const busyRef = useRef(false);
  const lastTouchAtRef = useRef(0);
  const requestTokenRef = useRef(0);
  const mountedRef = useRef(true);
  const settleTimerRef = useRef<number | null>(null);
  const hoursRef = useRef(virtualTime.hours);
  hoursRef.current = virtualTime.hours;

  const period = periodForHour(virtualTime.hours);

  // ── 主色跟角色走：从头像提取主色相（跟电子宠物小窝同一套提取器）──
  const [charHue, setCharHue] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    setCharHue(null);
    const source = character?.avatar;
    if (!source) return;
    void hueFromImage(source).then(hue => {
      if (!cancelled && hue !== null) setCharHue(((Math.round(hue) % 360) + 360) % 360);
    });
    return () => { cancelled = true; };
  }, [character?.id, character?.avatar]);

  // ── 背景：preset:<id> / blobref / http 直链；空 = 时段天光 ──
  const background = character?.companionBackground;
  const backgroundPreset = background?.startsWith('preset:')
    ? COMPANION_BG_PRESETS.find(preset => `preset:${preset.id}` === background) || null
    : null;
  const backgroundImageUrl = useBlobRefUrl(background && !background.startsWith('preset:') ? background : undefined);

  // UI 铬件主色：角色色优先，提不出来再落到场景/时段色。
  const [backgroundHue, setBackgroundHue] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    setBackgroundHue(null);
    if (!backgroundImageUrl) return;
    void hueFromImage(backgroundImageUrl).then(hue => {
      if (!cancelled && hue !== null) setBackgroundHue(normalizeHue(Math.round(hue)));
    });
    return () => { cancelled = true; };
  }, [backgroundImageUrl]);

  const presetHue = useMemo(
    () => backgroundPreset ? hueFromGradient(backgroundPreset.css) : null,
    [backgroundPreset],
  );
  const palette = useMemo(() => {
    const baseHue = normalizeHue(theme.hue ?? 267);
    const saturation = Math.min(74, Math.max(32, theme.saturation ?? 46));
    const sceneHue = backgroundHue ?? presetHue ?? baseHue;
    const accentHue = charHue ?? sceneHue;
    const accentLightness = Math.min(78, Math.max(68, (theme.lightness ?? 64) + 7));
    return {
      accent: hslToHex(accentHue, Math.max(52, saturation), accentLightness),
      ambient: backgroundPreset?.tint || hslToHex(sceneHue, Math.max(44, saturation), 64),
      baseTop: hslToHex(baseHue, Math.max(34, saturation - 5), 16),
      baseMid: hslToHex(baseHue, Math.max(28, saturation - 11), 9),
      baseBottom: hslToHex(baseHue, Math.max(24, saturation - 15), 4),
      panelTop: hslToHex(accentHue, Math.max(28, saturation - 17), 16),
      panelBottom: hslToHex(accentHue, Math.max(25, saturation - 20), 8),
      shadow: hslToHex(accentHue, Math.max(18, saturation - 27), 4),
    };
  }, [
    backgroundHue,
    backgroundPreset?.tint,
    charHue,
    presetHue,
    theme.hue,
    theme.lightness,
    theme.saturation,
  ]);

  // Keep these as hex because stage/chrome effects append an alpha suffix.
  const uiTint = palette.accent;
  // 氛围色（粒子/地面辉光）：预设场景用场景色，否则时段色。
  const ambientTint = palette.ambient;

  const dustMotes = useMemo<DustMote[]>(() => (
    Array.from({ length: 9 }, (_, index) => ({
      left: 6 + ((index * 37 + 13) % 88),
      size: 2 + ((index * 7) % 3) * 1.4,
      delay: -((index * 2.63) % 14),
      duration: 11 + ((index * 5) % 9),
      drift: ((index % 2 ? 1 : -1) * (8 + ((index * 11) % 22))),
    }))
  ), []);

  useEffect(() => {
    // StrictMode 会「装载→卸载→再装载」跑一遍 effect：cleanup 把 mounted 打成
    // false 后必须在 effect 体里设回 true，否则 dev 下问候和触碰回应全被吞。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    };
  }, []);
  useEffect(() => {
    requestTokenRef.current += 1;
    busyRef.current = false;
    setLine(null);
    setLastHit(null);
    setVrmExpressions([]);
    setEditing(false);
    setPerformance(DEFAULT_AVATAR_PERFORMANCE);
    setMotionState('idle');
  }, [character?.id]);

  const settleAfter = (textLength: number) => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      setMotionState('idle');
      setPerformance(DEFAULT_AVATAR_PERFORMANCE);
    }, Math.max(2_400, Math.min(6_500, textLength * 115)));
  };

  // 进入桌面片刻后，角色按时段自动说一句欢迎台词（本地台词池，零 API 成本）。
  useEffect(() => {
    if (!character) return;
    const timer = window.setTimeout(() => {
      if (!mountedRef.current || busyRef.current || editingRef.current) return;
      const greetPeriod = periodForHour(hoursRef.current);
      const text = greetPeriod.lines[Math.floor(Math.random() * greetPeriod.lines.length)];
      setLine({ text, label: greetPeriod.label, kind: 'greeting' });
      setPerformance(greetPeriod.greetPerformance);
      setMotionState('speaking');
      settleAfter(text.length);
    }, 1_400);
    return () => window.clearTimeout(timer);
  }, [character?.id]);

  const accentColor = palette.accent;
  const modelActions = useMemo<AvatarTouchModelAction[]>(() => {
    if (character?.videoAvatar?.format === 'live2d') {
      return character.videoAvatar.actions
        .filter(action => action.permission === 'ai')
        .map(action => ({ id: action.id, name: action.name }));
    }
    return vrmExpressions.map(name => ({ id: name, name: `自定义表情：${name}` }));
  }, [character?.videoAvatar, vrmExpressions]);

  // ── 布置模式：角色默认位置（companionFraming）与背景的持久化 ──
  const companionFraming = character?.videoAvatar?.companionFraming;
  const saveCompanionFraming = (framing: { scale: number; offsetX: number; offsetY: number } | undefined) => {
    if (!character) return;
    updateCharacter(character.id, prev => (
      prev.videoAvatar ? { videoAvatar: { ...prev.videoAvatar, companionFraming: framing } } : {}
    ));
  };
  const applyCompanionBackground = async (value?: string) => {
    if (!character) return;
    const previous = character.companionBackground;
    updateCharacter(character.id, { companionBackground: value });
    // 背景令牌只被这个字段引用，替换/清除后旧 Blob 直接删掉，不留孤儿
    if (previous && isBlobRef(previous) && previous !== value) await deleteBlobRef(previous);
  };
  const chooseBackgroundImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    const removeInput = () => { if (input.parentElement) input.remove(); };
    window.addEventListener('focus', () => window.setTimeout(removeInput, 1200), { once: true });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return removeInput();
      try {
        if (file.size > 20 * 1024 * 1024) {
          addToast('图片超过 20 MB，请压缩后再用作背景', 'error');
          return;
        }
        await applyCompanionBackground(await putImageBlob(file));
        addToast('桌面背景已更新', 'success');
      } catch (error: any) {
        addToast(error?.message || '背景导入失败', 'error');
      } finally {
        removeInput();
      }
    };
    input.click();
  };

  const respondToTouch = async (hit: AvatarTouchHit, force = false) => {
    if (!character || busyRef.current || editingRef.current) return;
    const now = Date.now();
    if (!force && now - lastTouchAtRef.current < 1_200) return;
    busyRef.current = true;
    const requestToken = ++requestTokenRef.current;
    lastTouchAtRef.current = now;
    setLastHit(hit);
    setRipple({ nonce: hit.nonce, x: hit.normalizedX, y: hit.normalizedY });
    setLine(null);
    setPerformance(buildImmediateTouchPerformance(hit.zone));
    setMotionState('thinking');

    try {
      const result = await requestAvatarTouchReply({
        character,
        user: userProfile,
        apiConfig,
        hit,
        modelActions,
      });
      const touchDescription = `[面对面触碰互动] ${userProfile.name || '用户'}轻轻触碰了你的${avatarTouchZoneLabel(hit.zone)}。`;
      const userTouchId = await DB.saveMessage({
        charId: character.id,
        role: 'user',
        type: 'text',
        content: touchDescription,
        metadata: {
          source: 'avatar-touch',
          surface: 'desktop',
          touchZone: hit.zone,
          touchAreas: hit.rawAreas,
        },
      });
      await DB.saveMessage({
        charId: character.id,
        role: 'assistant',
        type: 'text',
        content: result.text,
        metadata: {
          source: 'avatar-touch',
          surface: 'desktop',
          replyToTouchId: userTouchId,
          touchZone: hit.zone,
          avatarPerformance: result.performance,
        },
      });
      announceChatGen(CHAT_GEN_EVENTS.replyEnd, {
        charId: character.id,
        charName: character.name,
      });
      if (!mountedRef.current || requestToken !== requestTokenRef.current) return;
      setLine({ text: result.text, label: `触碰 · ${avatarTouchZoneLabel(hit.zone)}`, kind: 'touch' });
      setPerformance(result.performance);
      setMotionState('speaking');
      settleAfter(result.text.length);
    } catch (error: any) {
      if (!mountedRef.current || requestToken !== requestTokenRef.current) return;
      console.warn('[companion] touch reply failed:', error);
      setMotionState('idle');
      setLine({ text: '……刚才好像没能听清。', label: '信号波动', kind: 'touch' });
      addToast(error?.message || '触碰回应暂时没有接上主模型', 'error');
    } finally {
      if (requestToken === requestTokenRef.current) busyRef.current = false;
    }
  };

  const thinking = motionState === 'thinking';
  const typed = useTypewriter(line?.text || '');
  const dialogVisible = (Boolean(line) || thinking) && !editing;

  if (!character) {
    return (
      <div className="flex h-full w-full items-center justify-center px-8 text-center text-white/70">
        <div>
          <Sparkle size={28} className="mx-auto mb-3" />
          <div className="text-sm">先创建并选择一个角色，再来使用触感陪伴桌面。</div>
          <button onClick={() => openApp(AppID.Character)} className="mt-4 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-xs">去选择角色</button>
        </div>
      </div>
    );
  }

  const hh = String(virtualTime.hours).padStart(2, '0');
  const mm = String(virtualTime.minutes).padStart(2, '0');
  const dateNow = new Date();
  const framingAdjusted = Boolean(companionFraming) && (
    Math.abs(companionFraming!.scale - 1) > 0.02
    || Math.abs(companionFraming!.offsetX) > 0.01
    || Math.abs(companionFraming!.offsetY) > 0.01
  );

  return (
    <div className="relative h-full w-full overflow-hidden select-none">
      <style>{`
        @keyframes companion-ripple {
          from { opacity:.8; transform:translate(-50%,-50%) scale(.25); }
          to { opacity:0; transform:translate(-50%,-50%) scale(2.8); }
        }
        @keyframes companion-dialog-in {
          from { opacity:0; transform:translateY(10px); }
          to { opacity:1; transform:translateY(0); }
        }
        @keyframes companion-dust {
          0% { opacity:0; transform:translate3d(0,12vh,0) scale(.7); }
          18% { opacity:.85; }
          82% { opacity:.5; }
          100% { opacity:0; transform:translate3d(var(--dust-drift),-58vh,0) scale(1.1); }
        }
        @keyframes companion-cursor { 0%,100% { opacity:.85; } 50% { opacity:.1; } }
        @keyframes companion-thinking-dot {
          0%,80%,100% { opacity:.25; transform:translateY(0); }
          40% { opacity:1; transform:translateY(-3px); }
        }
        @keyframes companion-clock-in {
          from { opacity:0; transform:translateY(-6px); }
          to { opacity:1; transform:translateY(0); }
        }
      `}</style>

      {/* ── 背景：自定义图片 > 华丽预设场景 > 时段天光 ── */}
      {backgroundImageUrl ? (
        <>
          <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${backgroundImageUrl})` }} />
          {/* 自定义图上压暗色渐变，保住时钟/台词可读性 */}
          <div className="absolute inset-0" style={{ background: `linear-gradient(to bottom, ${palette.shadow}70, ${palette.shadow}1a 34%, ${palette.shadow}33 68%, ${palette.shadow}8c)` }} />
        </>
      ) : backgroundPreset ? (
        <div className="absolute inset-0" style={{ background: backgroundPreset.css }} />
      ) : (
        <>
          <div className="absolute inset-0 transition-[background] duration-500" style={{ background: `linear-gradient(180deg, ${palette.baseTop} 0%, ${palette.baseMid} 52%, ${palette.baseBottom} 100%)` }} />
          <div
            className="absolute inset-0 transition-[background] duration-[2400ms]"
            style={{ background: `radial-gradient(120% 62% at 50% -12%, ${period.skyGlow}, transparent 68%), radial-gradient(85% 40% at 82% 24%, ${period.skyGlow.replace(/[\d.]+\)$/, '0.12)')}, transparent 70%)` }}
          />
        </>
      )}
      {/* 地面辉光：让角色像站在光里而不是贴在墙纸上 */}
      {!backgroundImageUrl && (
        <div className="absolute inset-x-0 bottom-0 h-[38%]" style={{ background: `linear-gradient(to top, ${ambientTint}14, transparent)` }} />
      )}

      {/* 漂浮光尘（纯 GPU 动画） */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        {dustMotes.map((mote, index) => (
          <span
            key={index}
            className="absolute bottom-0 rounded-full"
            style={{
              left: `${mote.left}%`,
              width: mote.size,
              height: mote.size,
              background: ambientTint,
              boxShadow: `0 0 ${mote.size * 3}px ${ambientTint}`,
              opacity: 0,
              '--dust-drift': `${mote.drift}px`,
              animation: `companion-dust ${mote.duration}s linear ${mote.delay}s infinite`,
            } as React.CSSProperties}
          />
        ))}
      </div>

      {/* ── 角色全出血舞台 ── */}
      <div className="absolute inset-0">
        <VRMVideoCallStage
          characterName={character.name}
          fallbackAvatar={character.avatar}
          model={character.videoAvatar}
          motionState={motionState}
          emotion={performance.emotion}
          performance={performance}
          performanceQuality="high"
          accentColor={accentColor}
          baseFraming={companionFraming || DEFAULT_STAGE_FRAMING}
          framingEditable={editing}
          onFramingChange={framing => saveCompanionFraming(framing)}
          onChooseModel={() => openApp(AppID.Call)}
          onExpressionsDiscovered={setVrmExpressions}
          onAvatarTouch={hit => { void respondToTouch(hit); }}
          companionMode
          maxFps={30}
        />
        {ripple && !editing && (
          <span
            key={ripple.nonce}
            className="pointer-events-none absolute z-40 h-12 w-12 rounded-full border border-white/75"
            style={{
              left: `${ripple.x * 100}%`,
              top: `${ripple.y * 100}%`,
              boxShadow: `0 0 20px ${uiTint}`,
              animation: 'companion-ripple 700ms ease-out forwards',
            }}
          />
        )}
      </div>

      {/* 底部暗角：保证对话框和台词在亮色模型上仍可读（不挡触摸） */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[34%]" style={{ background: `linear-gradient(to top, ${palette.shadow}c7, ${palette.shadow}47 55%, transparent)` }} />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28" style={{ background: `linear-gradient(to bottom, ${palette.shadow}80, transparent)` }} />

      {/* ── 顶部：大时钟 + 日期 + 时段（陪伴系手游首页的排版） ── */}
      <div className="absolute left-6 z-30" style={{ top: 'max(1.2rem, var(--safe-top))', animation: 'companion-clock-in 700ms ease-out both' }}>
        <div className="flex items-baseline gap-2">
          <span className="font-serif text-[3.1rem] leading-none tracking-wide text-white drop-shadow-[0_2px_14px_rgba(0,0,0,.45)]">
            {hh}<span className="mx-0.5 animate-pulse text-white/60">:</span>{mm}
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[11px] tracking-[0.16em] text-white/70">
          <span>{dateNow.getMonth() + 1}月{dateNow.getDate()}日</span>
          <span className="h-3 w-px bg-white/25" />
          <span>星期{WEEKDAYS[dateNow.getDay()]}</span>
        </div>
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border py-1 pl-2 pr-2.5 backdrop-blur-md"
          style={{ background: `${palette.panelBottom}b8`, borderColor: `${uiTint}24` }}>
          <span
            className={`h-1.5 w-1.5 rounded-full ${thinking ? 'animate-pulse' : ''}`}
            style={{ background: uiTint, boxShadow: `0 0 8px ${uiTint}` }}
          />
          <span className="text-[10px] tracking-[0.22em] text-white/70">
            {editing ? '布置桌面中' : `${period.label} · ${thinking ? '正在回应' : `${character.name}陪着你`}`}
          </span>
        </div>
      </div>

      {/* 顶部右侧：布置 + 外观设置 */}
      {!editing && (
        <div className="absolute right-5 z-30 flex flex-col items-center gap-2" style={{ top: 'max(1.2rem, var(--safe-top))' }}>
          <button
            onClick={() => openApp(AppID.Appearance)}
            className="flex h-9 w-9 items-center justify-center rounded-full border text-white/70 backdrop-blur-md active:scale-90"
            style={{ background: `${palette.panelBottom}b8`, borderColor: `${uiTint}24` }}
            aria-label="外观设置"
          >
            <Gear size={16} />
          </button>
          <button
            onClick={() => { setLine(null); setEditing(true); }}
            className="flex h-9 w-9 items-center justify-center rounded-full border text-white/70 backdrop-blur-md active:scale-90"
            style={{ background: `${palette.panelBottom}b8`, borderColor: `${uiTint}24` }}
            aria-label="布置桌面"
          >
            <SlidersHorizontal size={16} />
          </button>
        </div>
      )}

      {/* ── 右缘竖排快捷菜单（手游首页风的玻璃圆钮列） ── */}
      {!editing && (
        <div className="absolute right-3 top-1/2 z-30 flex -translate-y-1/2 flex-col items-center gap-2.5">
          {[
            { id: AppID.Chat, icon: <ChatCircleDots size={19} weight="fill" />, label: '聊天' },
            { id: AppID.Call, icon: <Phone size={19} weight="fill" />, label: '通话' },
            { id: AppID.Character, icon: <Sparkle size={19} weight="fill" />, label: '角色' },
          ].map(item => (
            <button
              key={item.id}
              onClick={() => openApp(item.id)}
              className="group flex flex-col items-center gap-1 active:scale-90"
            >
              <span
                className="flex h-11 w-11 items-center justify-center rounded-full border text-white/80 shadow-lg backdrop-blur-md transition group-active:border-white/30"
                style={{ background: `${palette.panelBottom}c2`, borderColor: `${uiTint}29`, boxShadow: `0 4px 16px ${palette.shadow}59, inset 0 1px 0 ${uiTint}2e` }}
              >
                {item.icon}
              </span>
              <span className="text-[9px] tracking-[0.14em] text-white/60 drop-shadow">{item.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── galgame 对话框：名牌 + 打字机台词（问候与触碰回应共用） ── */}
      {dialogVisible && (
        <div
          className="absolute inset-x-4 z-40"
          style={{ bottom: 'max(1.1rem, calc(var(--safe-bottom, 0px) + 0.9rem))', animation: 'companion-dialog-in 300ms ease-out both' }}
        >
          <div
            className="relative rounded-[1.4rem] border border-white/20 px-4 pb-3.5 pt-4 shadow-2xl backdrop-blur-xl"
            style={{ background: `linear-gradient(165deg, ${palette.panelTop}eb, ${palette.panelBottom}f0)`, boxShadow: `0 18px 44px ${palette.shadow}80, inset 0 1px 0 ${uiTint}30` }}
          >
            {/* 名牌：悬在对话框左上缘 */}
            <div
              className="absolute -top-3 left-4 flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium tracking-wide text-[#14102a] shadow-lg"
              style={{ background: `linear-gradient(120deg, ${uiTint}, #ffffff)` }}
            >
              {character.name}
              {line?.label && <span className="text-[9px] opacity-60">· {line.label}</span>}
            </div>

            {thinking && !line ? (
              <div className="flex items-center gap-1.5 py-1.5 pl-1">
                {[0, 1, 2].map(index => (
                  <span
                    key={index}
                    className="h-1.5 w-1.5 rounded-full bg-white/75"
                    style={{ animation: `companion-thinking-dot 1.1s ease-in-out ${index * 0.18}s infinite` }}
                  />
                ))}
              </div>
            ) : (
              <div className="min-h-[2.4rem] text-[13.5px] leading-relaxed text-white/90">
                {typed.shown}
                {!typed.done && (
                  <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-white/85" style={{ animation: 'companion-cursor 800ms step-end infinite' }} />
                )}
              </div>
            )}

            {line?.kind === 'touch' && lastHit && !thinking && typed.done && (
              <button
                onClick={() => { void respondToTouch({ ...lastHit, nonce: Date.now() + Math.random() }, true); }}
                className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-white/40 active:text-white/80"
              >
                <ArrowClockwise size={11} /> 让{character.name}重新回应
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── 布置模式：位置提示 + 背景选择底栏 ── */}
      {editing && (
        <>
          {character.videoAvatar && (
            <div
              className="pointer-events-none absolute inset-x-6 z-40 rounded-2xl border border-white/20 bg-black/40 px-3 py-2 text-center backdrop-blur-md"
              style={{ top: 'max(6.4rem, calc(var(--safe-top) + 5.4rem))' }}
            >
              <span className="text-[11px] leading-relaxed text-white/80">拖动角色摆位置 · 双指捏合 / 滚轮调大小，松手即保存</span>
            </div>
          )}
          <div
            className="absolute inset-x-3 z-50"
            style={{ bottom: 'max(0.9rem, calc(var(--safe-bottom, 0px) + 0.7rem))', animation: 'companion-dialog-in 260ms ease-out both' }}
          >
            <div
              className="rounded-[1.4rem] border border-white/20 px-3.5 pb-3 pt-3 shadow-2xl backdrop-blur-xl"
              style={{ background: `linear-gradient(165deg, ${palette.panelTop}f0, ${palette.panelBottom}f5)` }}
            >
              <div className="flex items-center justify-between pb-2">
                <div className="text-[11px] font-medium tracking-[0.18em] text-white/70">布置桌面</div>
                <div className="flex items-center gap-2">
                  {framingAdjusted && (
                    <button
                      onClick={() => saveCompanionFraming(undefined)}
                      className="inline-flex items-center gap-1 rounded-full border border-white/20 px-2.5 py-1 text-[10px] text-white/60 active:scale-95"
                    >
                      <ArrowsOutCardinal size={11} weight="bold" /> 重置位置
                    </button>
                  )}
                  <button
                    onClick={() => setEditing(false)}
                    className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-medium text-[#14102a] shadow active:scale-95"
                    style={{ background: `linear-gradient(120deg, ${uiTint}, #ffffff)` }}
                  >
                    <Check size={12} weight="bold" /> 完成
                  </button>
                </div>
              </div>

              <div className="text-[9px] tracking-[0.2em] text-white/40">背景</div>
              <div className="mt-1.5 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
                {/* 默认：时段天光 */}
                <button
                  onClick={() => { void applyCompanionBackground(undefined); }}
                  className={`flex shrink-0 flex-col items-center gap-1 active:scale-95 ${!background ? '' : 'opacity-80'}`}
                >
                  <span
                    className="h-12 w-16 rounded-lg border"
                    style={{
                      borderColor: !background ? uiTint : 'rgba(255,255,255,.14)',
                      borderWidth: !background ? 2 : 1,
                      background: `radial-gradient(120% 70% at 50% -12%, ${period.skyGlow}, transparent 70%), linear-gradient(180deg, ${palette.baseTop}, ${palette.baseBottom})`,
                    }}
                  />
                  <span className="text-[9px] text-white/60">时段天光</span>
                </button>
                {COMPANION_BG_PRESETS.map(preset => {
                  const active = background === `preset:${preset.id}`;
                  return (
                    <button
                      key={preset.id}
                      onClick={() => { void applyCompanionBackground(`preset:${preset.id}`); }}
                      className={`flex shrink-0 flex-col items-center gap-1 active:scale-95 ${active ? '' : 'opacity-80'}`}
                    >
                      <span
                        className="h-12 w-16 rounded-lg border"
                        style={{
                          borderColor: active ? uiTint : 'rgba(255,255,255,.14)',
                          borderWidth: active ? 2 : 1,
                          background: preset.css,
                        }}
                      />
                      <span className="text-[9px] text-white/60">{preset.name}</span>
                    </button>
                  );
                })}
                {/* 自定义图片 */}
                <button
                  onClick={chooseBackgroundImage}
                  className="flex shrink-0 flex-col items-center gap-1 active:scale-95"
                >
                  <span
                    className="flex h-12 w-16 items-center justify-center rounded-lg border bg-white/[0.06] text-white/60"
                    style={{
                      borderColor: backgroundImageUrl ? uiTint : 'rgba(255,255,255,.14)',
                      borderWidth: backgroundImageUrl ? 2 : 1,
                      ...(backgroundImageUrl ? { backgroundImage: `url(${backgroundImageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}),
                    }}
                  >
                    {!backgroundImageUrl && <UploadSimple size={16} weight="bold" />}
                  </span>
                  <span className="text-[9px] text-white/60">{backgroundImageUrl ? '换一张' : '自定义'}</span>
                </button>
                {backgroundImageUrl && (
                  <button
                    onClick={() => { void applyCompanionBackground(undefined); }}
                    className="flex shrink-0 flex-col items-center gap-1 active:scale-95"
                  >
                    <span className="flex h-12 w-16 items-center justify-center rounded-lg border border-rose-300/30 bg-rose-950/40 text-rose-200/80">
                      <Trash size={15} weight="bold" />
                    </span>
                    <span className="text-[9px] text-rose-200/60">移除</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default CompanionHome;

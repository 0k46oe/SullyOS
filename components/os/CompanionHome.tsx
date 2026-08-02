import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowClockwise,
  ArrowsOutCardinal,
  Check,
  Gear,
  SlidersHorizontal,
  Sparkle,
  SpeakerHigh,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import { AppID, type CompanionTouchReaction, type DailySchedule } from '../../types';
import { Icons } from '../../constants';
import VRMVideoCallStage from '../call/VRMVideoCallStage';
import type { AvatarMotionState } from '../call/VRMAvatarCanvas';
import {
  applyAvatarTouchForce,
  avatarTouchZoneLabel,
  avatarTouchZoneToastLabel,
  buildImmediateTouchPerformance,
  DEFAULT_COMPANION_TOUCH_ZONES,
  normalizeCompanionDialogue,
  requestAvatarTouchReactionPack,
  resolveAvatarTouchForce,
  type AvatarTouchHit,
  type AvatarTouchModelAction,
  type AvatarTouchZone,
} from '../../utils/avatarTouch';
import {
  DEFAULT_AVATAR_PERFORMANCE,
  DEFAULT_STAGE_FRAMING,
  type AvatarPerformanceDirection,
} from '../../utils/avatarPerformance';
import { deleteBlobRef, isBlobRef, putImageBlob, useBlobRefUrl } from '../../utils/blobRef';
import { hslToHex, hueFromGradient, hueFromImage, normalizeHue } from '../../utils/dominantHue';
import { characterHasVoice } from '../../utils/ttsRouter';
import {
  cleanupAvatarTouchVoiceAssets,
  collectAvatarTouchVoiceAssetIds,
  createAvatarTouchVoiceUrl,
  generateAvatarTouchVoicePack,
} from '../../utils/avatarTouchVoice';
import { DB } from '../../utils/db';
import { getLastInnerState } from '../../utils/emotionApply';
import { getFlowNarrativeKey } from '../../utils/scheduleFeature';
import { getDailyScheduleForChar } from '../../utils/dailySchedule';
import { useLocalDateKey } from '../../hooks/useLocalDateKey';
import { resolveCharTimeZone } from '../../utils/timezone';
import { getCurrentScheduleSlotIndex, getScheduleWallClock } from '../../utils/scheduleTime';

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

const compactCompanionHudText = (value: string | undefined, fallback: string, limit = 54): string => {
  const clean = (value || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return fallback;
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
};

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

interface CompanionLine {
  text: string;
  label: string;
  kind: 'greeting' | 'touch';
}

const COMPANION_STAR_APPS: Array<{
  id: AppID;
  label: string;
  icon: keyof typeof Icons;
}> = [
  { id: AppID.Chat, label: '聊天', icon: 'Chat' },
  { id: AppID.Call, label: '通话', icon: 'Call' },
  { id: AppID.Character, label: '角色', icon: 'Character' },
  { id: AppID.Appearance, label: '换装', icon: 'Appearance' },
  { id: AppID.Schedule, label: '日程', icon: 'Schedule' },
  { id: AppID.Music, label: '音乐', icon: 'Music' },
  { id: AppID.Journal, label: '日记', icon: 'Journal' },
  { id: AppID.Room, label: '房间', icon: 'Room' },
  { id: AppID.MemoryPalace, label: '记忆', icon: 'MemoryPalace' },
  { id: AppID.CheckPhone, label: '手机', icon: 'CheckPhone' },
  { id: AppID.Social, label: '动态', icon: 'Social' },
  { id: AppID.Gallery, label: '相册', icon: 'Gallery' },
  { id: AppID.Worldbook, label: '世界书', icon: 'Worldbook' },
  { id: AppID.Study, label: '自习室', icon: 'Study' },
  { id: AppID.VRWorld, label: '彼方', icon: 'VRWorld' },
  { id: AppID.Settings, label: '设置', icon: 'Settings' },
];

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
    isDataLoaded,
    lastMsgTimestamp,
  } = useOS();
  const character = useMemo(
    () => characters.find(item => item.id === activeCharacterId) || characters[0] || null,
    [characters, activeCharacterId],
  );
  const [motionState, setMotionState] = useState<AvatarMotionState>('idle');
  const [performance, setPerformance] = useState<AvatarPerformanceDirection>(DEFAULT_AVATAR_PERFORMANCE);
  const [line, setLine] = useState<CompanionLine | null>(null);
  const [lastHit, setLastHit] = useState<AvatarTouchHit | null>(null);
  const [ripple, setRipple] = useState<{ nonce: number; x: number; y: number; force: number } | null>(null);
  const [touchBanner, setTouchBanner] = useState<{ nonce: number; text: string; x: number; y: number } | null>(null);
  const [touchSettingsOpen, setTouchSettingsOpen] = useState(false);
  const [appStarOpen, setAppStarOpen] = useState(false);
  const [touchGenerating, setTouchGenerating] = useState(false);
  const [touchGenerateVoice, setTouchGenerateVoice] = useState(false);
  const [touchVoiceProgress, setTouchVoiceProgress] = useState<{ completed: number; total: number } | null>(null);
  const [touchDraftZones, setTouchDraftZones] = useState<AvatarTouchZone[]>(DEFAULT_COMPANION_TOUCH_ZONES);
  const [vrmExpressions, setVrmExpressions] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const busyRef = useRef(false);
  const lastTouchAtRef = useRef(0);
  const requestTokenRef = useRef(0);
  const touchCursorRef = useRef<Partial<Record<AvatarTouchZone, number>>>({});
  const mountedRef = useRef(true);
  const settleTimerRef = useRef<number | null>(null);
  const touchBannerTimerRef = useRef<number | null>(null);
  const touchDialogueTimerRef = useRef<number | null>(null);
  const touchVoiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const touchVoiceUrlRef = useRef<string | null>(null);
  const touchVoiceNonceRef = useRef(0);
  const hoursRef = useRef(virtualTime.hours);
  hoursRef.current = virtualTime.hours;

  const period = periodForHour(virtualTime.hours);
  const characterDateKey = useLocalDateKey(resolveCharTimeZone(character));
  const [hudContent, setHudContent] = useState<{ thought: string; recentChat: string; schedule: DailySchedule | null }>({
    thought: '',
    recentChat: '',
    schedule: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!isDataLoaded || !character) {
      setHudContent({ thought: '', recentChat: '', schedule: null });
      return () => { cancelled = true; };
    }
    void Promise.all([
      DB.getRecentMessagesByCharId(character.id, 12, true),
      getDailyScheduleForChar(character),
    ]).then(([messages, schedule]) => {
      if (cancelled) return;
      const latestAssistant = [...messages].reverse().find(message =>
        message.role === 'assistant'
        && (!message.type || message.type === 'text')
        && typeof message.content === 'string'
        && message.content.trim(),
      );
      const scheduleThought = schedule?.flowNarrative?.[
        getFlowNarrativeKey(getScheduleWallClock(character).getHours())
      ];
      setHudContent({
        thought: compactCompanionHudText(getLastInnerState(character.id) || scheduleThought, period.lines[0]),
        recentChat: compactCompanionHudText(latestAssistant?.content, '还没有聊天记录'),
        schedule,
      });
    }).catch(() => {
      if (!cancelled) {
        setHudContent({ thought: period.lines[0], recentChat: '还没有聊天记录', schedule: null });
      }
    });
    return () => { cancelled = true; };
  }, [character?.id, character?.customTimezoneEnabled, character?.customTimezone, characterDateKey, isDataLoaded, lastMsgTimestamp, period.key]);

  const currentScheduleSlot = useMemo(() => {
    const slots = hudContent.schedule?.slots || [];
    if (!slots.length) return null;
    const index = getCurrentScheduleSlotIndex(slots, character);
    return slots[index >= 0 ? index : 0] || null;
  }, [character, hudContent.schedule, virtualTime.hours, virtualTime.minutes]);

  const stopTouchVoice = () => {
    if (touchVoiceAudioRef.current) {
      touchVoiceAudioRef.current.pause();
      touchVoiceAudioRef.current.src = '';
      touchVoiceAudioRef.current = null;
    }
    if (touchVoiceUrlRef.current) {
      URL.revokeObjectURL(touchVoiceUrlRef.current);
      touchVoiceUrlRef.current = null;
    }
  };

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

  useEffect(() => {
    // StrictMode 会「装载→卸载→再装载」跑一遍 effect：cleanup 把 mounted 打成
    // false 后必须在 effect 体里设回 true，否则 dev 下问候和触碰回应全被吞。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      if (touchBannerTimerRef.current !== null) window.clearTimeout(touchBannerTimerRef.current);
      if (touchDialogueTimerRef.current !== null) window.clearTimeout(touchDialogueTimerRef.current);
      touchVoiceNonceRef.current = 0;
      stopTouchVoice();
    };
  }, []);
  useEffect(() => {
    requestTokenRef.current += 1;
    busyRef.current = false;
    setLine(null);
    setLastHit(null);
    setTouchBanner(null);
    setTouchSettingsOpen(false);
    setAppStarOpen(false);
    if (touchDialogueTimerRef.current !== null) window.clearTimeout(touchDialogueTimerRef.current);
    setTouchGenerating(false);
    setTouchVoiceProgress(null);
    setTouchGenerateVoice(Boolean(character?.companionTouchSettings?.voiceEnabled));
    setTouchDraftZones((character?.companionTouchSettings?.enabledZones as AvatarTouchZone[] | undefined) || DEFAULT_COMPANION_TOUCH_ZONES);
    touchVoiceNonceRef.current = 0;
    stopTouchVoice();
    touchCursorRef.current = {};
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

  const showTouchBanner = (hit: AvatarTouchHit, text: string) => {
    setTouchBanner({ nonce: hit.nonce, text, x: hit.normalizedX, y: hit.normalizedY });
    if (touchBannerTimerRef.current !== null) window.clearTimeout(touchBannerTimerRef.current);
    touchBannerTimerRef.current = window.setTimeout(() => setTouchBanner(null), 1_650);
  };

  const openTouchSettings = () => {
    setAppStarOpen(false);
    setTouchDraftZones(
      (character?.companionTouchSettings?.enabledZones as AvatarTouchZone[] | undefined)
      || DEFAULT_COMPANION_TOUCH_ZONES,
    );
    setTouchGenerateVoice(Boolean(character?.companionTouchSettings?.voiceEnabled));
    setTouchVoiceProgress(null);
    setTouchSettingsOpen(true);
  };

  const toggleTouchZone = (zone: AvatarTouchZone) => {
    setTouchDraftZones(current => (
      current.includes(zone)
        ? current.filter(item => item !== zone)
        : [...current, zone]
    ));
  };

  const generateTouchReactionPack = async () => {
    if (!character || touchGenerating) return;
    if (!touchDraftZones.length) {
      addToast('请至少选择一个可触摸部位', 'error');
      return;
    }
    if (touchGenerateVoice && !characterHasVoice(character, apiConfig)) {
      addToast('这个角色还没有配置可用音色，先关闭语音勾选或去语音设置配置', 'error');
      return;
    }
    const requestToken = ++requestTokenRef.current;
    busyRef.current = true;
    setTouchGenerating(true);
    setTouchVoiceProgress(null);
    setMotionState('thinking');
    setLine(null);
    try {
      let reactions = await requestAvatarTouchReactionPack({
        character,
        user: userProfile,
        apiConfig,
        zones: touchDraftZones,
        modelActions,
      });
      if (!mountedRef.current || requestToken !== requestTokenRef.current) return;

      let voiceGenerated = 0;
      let voiceTotal = 0;
      let voiceFailures = 0;
      if (touchGenerateVoice) {
        voiceTotal = Object.values(reactions).reduce((total, items) => total + (items?.length || 0), 0);
        setTouchVoiceProgress({ completed: 0, total: voiceTotal });
        const voiceResult = await generateAvatarTouchVoicePack({
          reactions,
          character,
          apiConfig,
          onProgress: (completed, total) => {
            if (mountedRef.current && requestToken === requestTokenRef.current) {
              setTouchVoiceProgress({ completed, total });
            }
          },
        });
        if (!mountedRef.current || requestToken !== requestTokenRef.current) return;
        reactions = voiceResult.reactions;
        voiceGenerated = voiceResult.generated;
        voiceTotal = voiceResult.total;
        voiceFailures = voiceResult.failures.length;
      }

      updateCharacter(character.id, {
        companionTouchSettings: {
          enabledZones: touchDraftZones,
          reactions,
          voiceEnabled: touchGenerateVoice,
          voiceGeneratedCount: voiceGenerated,
          generatedAt: Date.now(),
        },
      });
      const keepVoiceIds = collectAvatarTouchVoiceAssetIds(reactions);
      void cleanupAvatarTouchVoiceAssets(character.companionTouchSettings?.reactions, keepVoiceIds);
      touchCursorRef.current = {};
      const voiceSummary = touchGenerateVoice ? ` · 本地语音 ${voiceGenerated}/${voiceTotal}` : '';
      addToast(`已为 ${touchDraftZones.length} 个部位准备本地反馈包${voiceSummary}`, 'success');
      if (voiceFailures) {
        addToast(`${voiceFailures} 条语音未能保存，触摸时只演动作与台词，不会临时调用 TTS`, 'info');
      }
    } catch (error: any) {
      if (!mountedRef.current || requestToken !== requestTokenRef.current) return;
      console.warn('[companion] touch reaction pack failed:', error);
      addToast(error?.message || '触摸反馈包生成失败', 'error');
    } finally {
      if (requestToken === requestTokenRef.current) {
        busyRef.current = false;
        setTouchGenerating(false);
        setTouchVoiceProgress(null);
        setMotionState('idle');
        setPerformance(DEFAULT_AVATAR_PERFORMANCE);
      }
    }
  };

  const playTouchReactionVoice = async (reaction: CompanionTouchReaction, nonce: number) => {
    if (!reaction.voiceAssetId) return;
    const url = await createAvatarTouchVoiceUrl(reaction);
    if (!url) return;
    if (!mountedRef.current || touchVoiceNonceRef.current !== nonce) {
      URL.revokeObjectURL(url);
      return;
    }
    stopTouchVoice();
    const audio = new Audio(url);
    touchVoiceAudioRef.current = audio;
    touchVoiceUrlRef.current = url;
    const release = () => {
      if (touchVoiceAudioRef.current === audio) touchVoiceAudioRef.current = null;
      if (touchVoiceUrlRef.current === url) {
        URL.revokeObjectURL(url);
        touchVoiceUrlRef.current = null;
      }
    };
    audio.onended = release;
    audio.onerror = release;
    try {
      await audio.play();
    } catch (error) {
      console.warn('[companion] local touch voice playback skipped:', error);
      release();
    }
  };

  const respondToTouch = (hit: AvatarTouchHit, force = false) => {
    if (!character || touchGenerating || editingRef.current) return;
    const now = Date.now();
    if (!force && now - lastTouchAtRef.current < 420) return;
    lastTouchAtRef.current = now;
    if (touchDialogueTimerRef.current !== null) window.clearTimeout(touchDialogueTimerRef.current);
    setAppStarOpen(false);
    setLine(null);
    touchVoiceNonceRef.current = hit.nonce;
    stopTouchVoice();
    setLastHit(hit);
    const touchForce = resolveAvatarTouchForce(hit);
    setRipple({ nonce: hit.nonce, x: hit.normalizedX, y: hit.normalizedY, force: touchForce });
    showTouchBanner(hit, `你戳了戳${character.name}的${avatarTouchZoneToastLabel(hit.zone)}`);
    setPerformance(applyAvatarTouchForce(buildImmediateTouchPerformance(hit.zone), hit));
    setMotionState('speaking');

    const settings = character.companionTouchSettings;
    const enabled = settings?.enabledZones?.includes(hit.zone);
    const reactions = settings?.reactions?.[hit.zone] || [];
    if (!enabled || !reactions.length) {
      settleAfter(18);
      addToast(`“${avatarTouchZoneLabel(hit.zone)}”还没有本地反馈，点右侧触摸设置生成一次即可`, 'info');
      return;
    }

    const cursor = touchCursorRef.current[hit.zone] || 0;
    const reaction = reactions[cursor % reactions.length];
    touchCursorRef.current[hit.zone] = (cursor + 1) % reactions.length;
    const text = normalizeCompanionDialogue(reaction.text, character.name);
    if (!text) {
      settleAfter(18);
      addToast('这条缓存台词为空，请在触摸设置中补生成反馈包', 'error');
      return;
    }

    // Let the fast local touch impulse land before the cached dialogue takes
    // over. This timer never calls the API; repeated taps simply replace it.
    touchDialogueTimerRef.current = window.setTimeout(() => {
      if (!mountedRef.current) return;
      setLine({ text, label: `触摸 · ${avatarTouchZoneLabel(hit.zone)}`, kind: 'touch' });
      setPerformance(applyAvatarTouchForce(
        reaction.performance || buildImmediateTouchPerformance(hit.zone),
        hit,
      ));
      setMotionState('speaking');
      if (settings?.voiceEnabled && reaction.voiceAssetId) {
        void playTouchReactionVoice(reaction, hit.nonce);
      }
      settleAfter(text.length);
    }, 420);
  };
  const thinking = motionState === 'thinking';
  const displayLineText = normalizeCompanionDialogue(line?.text || '', character?.name || '');
  const typed = useTypewriter(displayLineText);
  const dialogVisible = (Boolean(line) || thinking) && !editing && !touchSettingsOpen && !appStarOpen;

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

  const framingAdjusted = Boolean(companionFraming) && (
    Math.abs(companionFraming!.scale - 1) > 0.02
    || Math.abs(companionFraming!.offsetX) > 0.01
    || Math.abs(companionFraming!.offsetY) > 0.01
  );
  const savedTouchSettings = character.companionTouchSettings;
  const preparedReactionCount = Object.values(savedTouchSettings?.reactions || {})
    .reduce((total, reactions) => total + (reactions?.length || 0), 0);
  const preparedVoiceCount = Object.values(savedTouchSettings?.reactions || {})
    .reduce((total, reactions) => total + (reactions?.filter(item => item.voiceAssetId).length || 0), 0);
  const touchVoiceAvailable = characterHasVoice(character, apiConfig);
  const launchCompanionApp = (id: AppID) => {
    setAppStarOpen(false);
    openApp(id);
  };

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
        @keyframes companion-cursor { 0%,100% { opacity:.85; } 50% { opacity:.1; } }
        @keyframes companion-thinking-dot {
          0%,80%,100% { opacity:.25; transform:translateY(0); }
          40% { opacity:1; transform:translateY(-3px); }
        }
        @keyframes companion-clock-in {
          from { opacity:0; transform:translateY(-6px); }
          to { opacity:1; transform:translateY(0); }
        }
        @keyframes companion-hud-in {
          from { opacity:0; transform:translateY(-10px) scale(.98); }
          to { opacity:1; transform:translateY(0) scale(1); }
        }
        @keyframes companion-touch-banner {
          0% { opacity:0; transform:translate(-50%, 4px) scale(.86); }
          18% { opacity:1; transform:translate(-50%, -8px) scale(1); }
          78% { opacity:1; transform:translate(-50%, -30px) scale(1); }
          100% { opacity:0; transform:translate(-50%, -46px) scale(.96); }
        }
        @keyframes companion-heart-pop {
          0% { opacity:0; transform:translate(-50%,-50%) scale(.2) rotate(-10deg); }
          35% { opacity:1; transform:translate(-50%,-90%) scale(1.12) rotate(6deg); }
          100% { opacity:0; transform:translate(-50%,-180%) scale(.76) rotate(16deg); }
        }
        @keyframes companion-star-open {
          from { opacity:0; transform:translateY(18px) scale(.94); }
          to { opacity:1; transform:translateY(0) scale(1); }
        }
        @keyframes companion-drawer-up {
          from { opacity:0; transform:translateY(28px); }
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

      {/* ── 角色全出血舞台 ── */}
      {!backgroundImageUrl && (
        <div className="pointer-events-none absolute inset-0 z-[1] overflow-hidden" aria-hidden>
          <div
            className="absolute left-1/2 top-[31%] h-[48vw] max-h-[22rem] min-h-[13rem] w-[48vw] max-w-[22rem] min-w-[13rem] -translate-x-1/2 rounded-full border border-white/[0.07]"
            style={{ boxShadow: `inset 0 0 24px ${uiTint}0b` }}
          />
          <div
            className="absolute left-1/2 top-[34%] h-[34vw] max-h-[16rem] min-h-[10rem] w-[62vw] max-w-[28rem] min-w-[18rem] -translate-x-1/2 rotate-[-17deg] rounded-[50%] border"
            style={{ borderColor: `${uiTint}20` }}
          />
          <span className="absolute left-[18%] top-[30%] text-[10px] opacity-45" style={{ color: uiTint }}>✦</span>
          <span className="absolute right-[19%] top-[27%] text-[8px] opacity-35" style={{ color: uiTint }}>✦</span>
          <span className="absolute right-[16%] top-[59%] text-[7px] opacity-30" style={{ color: uiTint }}>✦</span>
        </div>
      )}

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
          touchImpulseNonce={lastHit?.nonce}
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
              width: `${38 + ripple.force * 18}px`,
              height: `${38 + ripple.force * 18}px`,
              boxShadow: `0 0 ${10 + ripple.force * 22}px ${uiTint}`,
              animation: `companion-ripple ${580 + ripple.force * 260}ms ease-out forwards`,
            }}
          />
        )}
        {touchBanner && !editing && (
          <div
            key={touchBanner.nonce}
            className="pointer-events-none absolute z-50 whitespace-nowrap rounded-full border border-white/40 bg-[#120d25]/88 px-3 py-1.5 text-[11px] font-medium tracking-wide text-white shadow-2xl"
            style={{
              left: `${touchBanner.x * 100}%`,
              top: `${touchBanner.y * 100}%`,
              animation: 'companion-touch-banner 1.65s ease-out forwards',
              boxShadow: `0 8px 26px ${palette.shadow}99, 0 0 20px ${uiTint}45`,
            }}
          >
            <span className="mr-1 text-pink-200">~❤</span>{touchBanner.text}<span className="ml-1 text-pink-200">❤~</span>
          </div>
        )}
        {touchBanner && !editing && [0, 1, 2].map(index => (
          <span
            key={`${touchBanner.nonce}-heart-${index}`}
            className="pointer-events-none absolute z-50 text-[15px] text-pink-200 drop-shadow"
            style={{
              left: `calc(${touchBanner.x * 100}% + ${(index - 1) * 18}px)`,
              top: `calc(${touchBanner.y * 100}% - ${index % 2 ? 2 : 12}px)`,
              animation: `companion-heart-pop 1.15s ease-out ${index * 90}ms forwards`,
            }}
          >♡</span>
        ))}
      </div>

      {/* 底部暗角：保证对话框和台词在亮色模型上仍可读（不挡触摸） */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[34%]" style={{ background: `linear-gradient(to top, ${palette.shadow}c7, ${palette.shadow}47 55%, transparent)` }} />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28" style={{ background: `linear-gradient(to bottom, ${palette.shadow}80, transparent)` }} />

      {/* ── 顶部：统一尺寸的角色内容 HUD。真实心声、聊天和日程直接出现在桌面。 ── */}
      {!editing && (
        <div
          className="absolute inset-x-3 z-30"
          style={{ top: 'max(2rem, calc(var(--safe-top, 0px) + 0.55rem))', animation: 'companion-hud-in 520ms ease-out both' }}
          data-testid="companion-game-hud"
        >
          <section
            className="overflow-hidden border border-white/20 text-white"
            style={{ background: `linear-gradient(135deg, ${palette.panelTop}ef, ${palette.panelBottom}f4)`, boxShadow: `0 10px 30px ${palette.shadow}73, inset 0 1px 0 ${uiTint}35`, clipPath: 'polygon(0 10px, 10px 0, calc(100% - 10px) 0, 100% 10px, 100% calc(100% - 10px), calc(100% - 10px) 100%, 10px 100%, 0 calc(100% - 10px))' }}
            data-testid="companion-context-hud"
            data-ui-scale="medium"
          >
            <header className="flex h-12 items-center justify-between gap-3 px-3 sm:h-14 sm:px-4">
              <button onClick={() => openApp(AppID.Character)} className="flex min-w-0 items-center gap-2 text-left active:scale-[.98]">
                <span className="relative h-8 w-8 shrink-0 overflow-hidden border bg-black/20 p-0.5 sm:h-10 sm:w-10" style={{ borderColor: `${uiTint}c9`, clipPath: 'polygon(20% 0, 80% 0, 100% 20%, 100% 80%, 80% 100%, 20% 100%, 0 80%, 0 20%)' }}>
                  <img src={character.avatar} alt="" className="h-full w-full object-cover" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold tracking-wide sm:text-[15px]">{character.name}</span>
                  <span className="block text-[8px] tracking-[0.14em] text-white/50 sm:text-[9px]">{period.label} · {character.videoAvatar ? '动作同步中' : '等待模型'}</span>
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-[11px] tabular-nums tracking-[0.14em] text-white/75 sm:text-[13px]">{hh}:{mm}</span>
                <button onClick={() => openApp(AppID.Appearance)} className="flex h-9 w-9 items-center justify-center border bg-black/20 text-white/80 active:scale-[.96] sm:h-11 sm:w-11" style={{ borderColor: `${uiTint}70` }} aria-label="外观设置">
                  <Gear size={18} />
                </button>
              </div>
            </header>
            <div className="grid grid-cols-3 border-t border-white/10">
              <button onClick={() => openApp(AppID.Schedule)} className="min-w-0 border-r border-white/10 px-3 py-2 text-left active:bg-white/5 sm:px-4 sm:py-2.5" data-testid="companion-hud-thought">
                <span className="flex items-center gap-1 text-[8px] font-semibold tracking-[0.14em] sm:text-[9px]" style={{ color: uiTint }}><Sparkle size={11} weight="fill" />当前心声</span>
                <span className="mt-1 block h-8 overflow-hidden text-[9px] leading-4 text-white/80 sm:h-9 sm:text-[11px]" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{hudContent.thought || period.lines[0]}</span>
              </button>
              <button onClick={() => openApp(AppID.Chat)} className="min-w-0 border-r border-white/10 px-3 py-2 text-left active:bg-white/5 sm:px-4 sm:py-2.5" data-testid="companion-hud-chat">
                <span className="flex items-center gap-1 text-[8px] font-semibold tracking-[0.14em] sm:text-[9px]" style={{ color: uiTint }}><Icons.Chat className="h-[11px] w-[11px] sm:h-[13px] sm:w-[13px]" />最近聊天</span>
                <span className="mt-1 block h-8 overflow-hidden text-[9px] leading-4 text-white/80 sm:h-9 sm:text-[11px]" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{hudContent.recentChat || '还没有聊天记录'}</span>
              </button>
              <button onClick={() => openApp(AppID.Schedule)} className="min-w-0 px-3 py-2 text-left active:bg-white/5 sm:px-4 sm:py-2.5" data-testid="companion-hud-schedule">
                <span className="flex items-center gap-1 text-[8px] font-semibold tracking-[0.14em] sm:text-[9px]" style={{ color: uiTint }}><Icons.Schedule className="h-[11px] w-[11px] sm:h-[13px] sm:w-[13px]" />此刻日程</span>
                <span className="mt-1 block h-8 overflow-hidden text-[9px] leading-4 text-white/80 sm:h-9 sm:text-[11px]" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {currentScheduleSlot ? `${currentScheduleSlot.emoji || '◌'} ${currentScheduleSlot.startTime} ${currentScheduleSlot.activity}` : '今天还没有日程'}
                </span>
              </button>
            </div>
          </section>
        </div>
      )}

      {/* ── 角色旁边的手游快捷入口。与底栏共用 40px 控制尺寸。 ── */}
      {!editing && !touchSettingsOpen && !appStarOpen && (
        <aside
          className="absolute right-1 top-[28%] z-30 flex w-16 flex-col items-center gap-1.5 pb-3 pt-3 text-white sm:w-20"
          aria-label="角色快捷轨道"
          data-testid="companion-ornate-action-rail"
          data-visual-style="ornate-flat"
          data-ui-scale="medium"
        >
          <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 82 356" preserveAspectRatio="none" aria-hidden>
            <path d="M14 1H67L80 14V338L69 355H13L2 340V13Z" fill={`${palette.panelBottom}9e`} stroke={`${uiTint}68`} strokeWidth="1" />
            <path d="M8 24V326M74 21V329" fill="none" stroke={`${uiTint}48`} strokeWidth="0.7" />
            <path d="M13 1H34M48 1H67M13 355H33M49 355H69" fill="none" stroke={`${uiTint}b8`} strokeWidth="0.8" />
            <path d="M41 39V319" fill="none" stroke={`${uiTint}58`} strokeWidth="0.7" strokeDasharray="2 5" />
            <path d="M3 78H10M72 63H79M3 274H9M73 292H80" fill="none" stroke={`${uiTint}94`} strokeWidth="0.8" />
          </svg>
          <span className="pointer-events-none absolute right-1 top-0 text-[8px] leading-none" style={{ color: uiTint }} aria-hidden>✦</span>

          <button onClick={openTouchSettings} className="group relative z-10 flex flex-col items-center gap-1 active:scale-[.97]" data-testid="companion-touch-settings-button">
            {!preparedReactionCount && <span className="absolute right-0 top-0 z-20 h-1.5 w-1.5 rounded-full bg-[#ff5d9e] ring-2 ring-[#1a1028]" aria-label="尚未生成触摸反馈" />}
            <span className="relative flex h-10 w-10 rotate-45 items-center justify-center rounded-[0.72rem] border sm:h-12 sm:w-12" style={{ background: `${uiTint}50`, borderColor: `${uiTint}ec` }}>
              <span className="absolute inset-[3px] rounded-[0.55rem] border" style={{ borderColor: `${uiTint}78` }} />
              <span className="relative -rotate-45 text-[17px] text-white sm:text-[20px]">☝</span>
            </span>
            <span className="text-[8px] tracking-[0.08em] text-white/95 sm:text-[9px]">触摸</span>
          </button>

          {[
            { id: AppID.Chat, icon: 'Chat' as const, label: '聊天' },
            { id: AppID.Call, icon: 'Call' as const, label: '通话' },
            { id: AppID.Appearance, icon: 'Appearance' as const, label: '换装' },
            { id: AppID.Character, icon: 'Character' as const, label: '角色' },
          ].map(item => {
            const Icon = Icons[item.icon];
            return (
              <button key={item.id} onClick={() => openApp(item.id)} className="group relative z-10 flex flex-col items-center gap-1 active:scale-[.97]">
                <span className="relative flex h-10 w-10 rotate-45 items-center justify-center rounded-[0.72rem] border bg-[#171023]/64 sm:h-12 sm:w-12" style={{ borderColor: `${uiTint}88` }}>
                  <span className="absolute inset-[3px] rounded-[0.55rem] border" style={{ borderColor: `${uiTint}2f` }} />
                  <Icon className="relative h-[17px] w-[17px] -rotate-45 text-white/95 sm:h-5 sm:w-5" />
                </span>
                <span className="text-[8px] tracking-[0.08em] text-white/90 sm:text-[9px]">{item.label}</span>
              </button>
            );
          })}
        </aside>
      )}

      {/* ── 触摸设置抽屉：选部位，一次生成，之后只本地轮播。 ── */}
      {touchSettingsOpen && !editing && (
        <div
          className="absolute inset-0 z-[70] flex items-end bg-black/45 backdrop-blur-[2px]"
          onClick={() => { if (!touchGenerating) setTouchSettingsOpen(false); }}
          data-testid="companion-touch-settings"
        >
          <section
            className="max-h-[88vh] w-full overflow-y-auto rounded-t-[2rem] border-t border-white/20 px-4 pb-5 pt-3 text-white shadow-[0_-24px_60px_rgba(0,0,0,.5)] backdrop-blur-2xl"
            style={{ background: `linear-gradient(165deg, ${palette.panelTop}f7, ${palette.panelBottom}fc)`, animation: 'companion-drawer-up 260ms ease-out both', paddingBottom: 'max(1.25rem, calc(var(--safe-bottom, 0px) + 1rem))' }}
            onClick={event => event.stopPropagation()}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20" />
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-lg">☝</span>
                  <h2 className="text-[15px] font-semibold tracking-wide text-white">触摸设置</h2>
                </div>
                <p className="mt-1 max-w-[24rem] text-[10px] leading-relaxed text-white/50">
                  先选可触摸部位，再一次生成整包反馈。以后每次戳戳只轮播本地台词和动作，不会逐次调用 API。
                </p>
              </div>
              <button
                onClick={() => setTouchSettingsOpen(false)}
                disabled={touchGenerating}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/20 bg-white/[0.06] text-white/70 disabled:opacity-30"
                aria-label="关闭触摸设置"
              ><Check size={15} /></button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              {(['head', 'face', 'hand', 'body', 'other'] as AvatarTouchZone[]).map(zone => {
                const selected = touchDraftZones.includes(zone);
                const count = savedTouchSettings?.reactions?.[zone]?.length || 0;
                return (
                  <button
                    key={zone}
                    onClick={() => toggleTouchZone(zone)}
                    disabled={touchGenerating}
                    aria-pressed={selected}
                    data-testid={`companion-touch-zone-${zone}`}
                    className="flex items-center justify-between rounded-2xl border px-3 py-2.5 text-left transition active:scale-[.98] disabled:opacity-50"
                    style={{
                      background: selected ? `${uiTint}20` : 'rgba(255,255,255,.035)',
                      borderColor: selected ? `${uiTint}8c` : 'rgba(255,255,255,.11)',
                    }}
                  >
                    <span>
                      <span className="block text-[11px] font-medium text-white/90">{avatarTouchZoneLabel(zone)}</span>
                      <span className="mt-0.5 block text-[8px] text-white/40">{count ? `已有 ${count} 条` : '尚未生成'}</span>
                    </span>
                    <span
                      className="flex h-5 w-5 items-center justify-center rounded-full border text-[10px]"
                      style={{ borderColor: selected ? uiTint : 'rgba(255,255,255,.18)', background: selected ? uiTint : 'transparent', color: selected ? '#151023' : 'transparent' }}
                    >✓</span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={touchGenerateVoice}
              disabled={touchGenerating || !touchVoiceAvailable}
              data-testid="companion-touch-generate-voice"
              onClick={() => setTouchGenerateVoice(current => !current)}
              className="mt-3 flex w-full items-center gap-3 border px-3 py-2.5 text-left transition active:scale-[.99] disabled:opacity-45"
              style={{
                borderColor: touchGenerateVoice ? `${uiTint}9f` : 'rgba(255,255,255,.12)',
                background: touchGenerateVoice ? `${uiTint}12` : 'rgba(255,255,255,.025)',
                clipPath: 'polygon(0 7px, 7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%)',
              }}
            >
              <SpeakerHigh size={17} style={{ color: touchGenerateVoice ? uiTint : 'rgba(255,255,255,.55)' }} />
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-medium text-white/90">同时生成语音</span>
                <span className="mt-0.5 block text-[8px] leading-relaxed text-white/42">
                  {touchVoiceAvailable
                    ? '勾选后预先合成并保存在本地；触摸时不会临时调用 TTS'
                    : '角色尚未配置可用音色，当前只生成台词与动作'}
                </span>
              </span>
              <span
                className="flex h-[18px] w-[18px] shrink-0 items-center justify-center border"
                style={{
                  borderColor: touchGenerateVoice ? uiTint : 'rgba(255,255,255,.25)',
                  background: touchGenerateVoice ? uiTint : 'transparent',
                  color: touchGenerateVoice ? palette.panelBottom : 'transparent',
                }}
              >
                <Check size={12} weight="bold" />
              </span>
            </button>

            <button
              onClick={() => { void generateTouchReactionPack(); }}
              disabled={touchGenerating || !touchDraftZones.length}
              data-testid="companion-generate-touch-pack"
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-[12px] font-semibold tracking-wide text-[#171126] shadow-lg transition active:scale-[.98] disabled:opacity-45"
              style={{ background: `linear-gradient(110deg, ${uiTint}, #ffd8ef 58%, #ffffff)` }}
            >
              <Sparkle size={15} weight="fill" />
              {touchGenerating
                ? touchVoiceProgress
                  ? `正在合成本地语音 ${touchVoiceProgress.completed}/${touchVoiceProgress.total}…`
                  : '正在生成台词与动作…'
                : preparedReactionCount ? '重新生成反馈包' : '一次生成反馈包'}
            </button>
            <div className="mt-2 text-center text-[8px] tracking-wide text-white/30">
              {savedTouchSettings?.generatedAt
                ? `上次生成 ${new Date(savedTouchSettings.generatedAt).toLocaleString()} · 台词 ${preparedReactionCount} 条 · 语音 ${preparedVoiceCount} 条`
                : '台词动作正常只请求一次；语音仅在勾选时批量预生成'}
            </div>
          </section>
        </div>
      )}
      {/* ── galgame 对话框：亮色台词板，不再像聊天消息卡。 ── */}
      {dialogVisible && (
        <div
          className="absolute inset-x-4 z-40"
          style={{ bottom: 'max(6.5rem, calc(var(--safe-bottom, 0px) + 6.3rem))', animation: 'companion-dialog-in 280ms ease-out both' }}
          data-testid="companion-dialogue"
        >
          <div className="relative isolate overflow-visible px-4 pb-3 pt-4 text-white" data-testid="companion-dialogue-surface">
            <div
              className="pointer-events-none absolute inset-0 -z-10 border shadow-2xl"
              style={{
                background: `linear-gradient(145deg, ${palette.panelTop}f0, ${palette.panelBottom}f7)`,
                borderColor: `${uiTint}9c`,
                boxShadow: `0 18px 44px ${palette.shadow}b8, inset 0 1px 0 ${uiTint}36`,
                clipPath: 'polygon(0 12px, 12px 0, calc(100% - 14px) 0, 100% 14px, 100% calc(100% - 10px), calc(100% - 10px) 100%, 16px 100%, 0 calc(100% - 16px))',
              }}
            />
            <div className="absolute inset-x-5 top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${uiTint}, transparent)` }} />
            <div className="pointer-events-none absolute bottom-3 right-4 flex h-4 items-end gap-[2px] opacity-35" aria-hidden>
              {[5, 9, 4, 12, 7, 14, 8, 5, 10, 4].map((height, index) => (
                <span key={index} className="w-px" style={{ height, background: uiTint }} />
              ))}
            </div>
            <div
              className="absolute -top-3 left-4 flex items-center gap-1.5 border border-white/20 px-3 py-1 text-[10px] font-semibold tracking-wide text-white shadow-lg"
              style={{ background: `linear-gradient(120deg, ${palette.panelTop}, ${uiTint}c9)`, boxShadow: `0 5px 16px ${palette.shadow}66`, clipPath: 'polygon(0 6px, 7px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 7px) 100%, 0 100%)' }}
            >
              {character.name}
              {line?.label && <span className="text-[8px] font-normal text-white/60">· {line.label}</span>}
            </div>

            {thinking && !line ? (
              <div className="flex items-center gap-1.5 py-1.5 pl-1">
                {[0, 1, 2].map(index => (
                  <span
                    key={index}
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: uiTint, animation: `companion-thinking-dot 1.1s ease-in-out ${index * 0.18}s infinite` }}
                  />
                ))}
              </div>
            ) : (
              <div className="min-h-[2.5rem] whitespace-pre-line text-[13px] font-medium leading-[1.72] text-white/90">
                {typed.shown}
                {!typed.done && (
                  <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px]" style={{ background: uiTint, animation: 'companion-cursor 800ms step-end infinite' }} />
                )}
              </div>
            )}

            {line?.kind === 'touch' && lastHit && !thinking && typed.done && (
              <button
                onClick={() => respondToTouch({ ...lastHit, nonce: Date.now() + Math.random() }, true)}
                className="mt-1.5 inline-flex items-center gap-1 text-[9px] font-medium active:scale-95"
                style={{ color: uiTint }}
                data-testid="companion-next-cached-reaction"
              >
                <ArrowClockwise size={11} /> 换一句 · 本地轮播
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── 手游底部主导航：角色仍是主页主体，功能入口只占一条短栏。 ── */}
      {!editing && !touchSettingsOpen && appStarOpen && (
        <>
          <button
            className="absolute inset-0 z-[35] bg-black/25 backdrop-blur-[1px]"
            onClick={() => setAppStarOpen(false)}
            aria-label="关闭功能星盘"
          />
          <section
            className="absolute inset-x-3 z-40 max-h-[52vh] overflow-hidden border border-white/20 shadow-2xl backdrop-blur-2xl"
            style={{
              bottom: 'max(6.4rem, calc(var(--safe-bottom, 0px) + 6.2rem))',
              background: `linear-gradient(155deg, ${palette.panelTop}f4, ${palette.panelBottom}fa)`,
              boxShadow: `0 24px 64px ${palette.shadow}d9, inset 0 1px 0 ${uiTint}45`,
              clipPath: 'polygon(0 12px, 12px 0, calc(100% - 12px) 0, 100% 12px, 100% calc(100% - 12px), calc(100% - 12px) 100%, 12px 100%, 0 calc(100% - 12px))',
              animation: 'companion-star-open 240ms ease-out both',
            }}
            data-testid="companion-app-star-panel"
          >
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div>
                <div className="flex items-center gap-2 text-[13px] font-semibold tracking-[0.16em] text-white">
                  <Sparkle size={15} weight="fill" style={{ color: uiTint }} /> 功能星盘
                </div>
                <div className="mt-0.5 text-[8px] tracking-[0.18em] text-white/35">SULLYOS · 全部真实功能</div>
              </div>
              <button onClick={() => setAppStarOpen(false)} className="h-7 w-7 border border-white/15 text-[12px] text-white/60 active:scale-90">×</button>
            </div>
            <div className="max-h-[calc(52vh-3.4rem)] overflow-y-auto px-3 py-3 no-scrollbar">
              <div className="grid grid-cols-4 gap-x-2 gap-y-3">
                {COMPANION_STAR_APPS.map(item => {
                  const Icon = Icons[item.icon];
                  return (
                    <button
                      key={item.id}
                      onClick={() => launchCompanionApp(item.id)}
                      className="group flex min-w-0 flex-col items-center gap-1.5 text-white/70 active:scale-90"
                    >
                      <span
                        className="relative flex h-10 w-10 items-center justify-center border border-white/15 bg-white/[0.055] transition group-active:bg-white/15"
                        style={{ color: uiTint, boxShadow: `inset 0 0 16px ${uiTint}12, 0 0 14px ${uiTint}0d`, clipPath: 'polygon(0 8px, 8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%)' }}
                      >
                        <Icon className="h-[19px] w-[19px]" />
                      </span>
                      <span className="max-w-full truncate text-[9px] tracking-wide">{item.label}</span>
                    </button>
                  );
                })}
                <button onClick={openTouchSettings} className="flex min-w-0 flex-col items-center gap-1.5 text-white/70 active:scale-90">
                  <span className="flex h-10 w-10 items-center justify-center border border-white/15 bg-white/[0.055] text-[17px]" style={{ color: uiTint }}>☝</span>
                  <span className="text-[9px] tracking-wide">触摸设置</span>
                </button>
                <button
                  onClick={() => { setAppStarOpen(false); setLine(null); setEditing(true); }}
                  className="flex min-w-0 flex-col items-center gap-1.5 text-white/70 active:scale-90"
                >
                  <span className="flex h-10 w-10 items-center justify-center border border-white/15 bg-white/[0.055]" style={{ color: uiTint }}><SlidersHorizontal size={19} /></span>
                  <span className="text-[9px] tracking-wide">布置桌面</span>
                </button>
              </div>
            </div>
          </section>
        </>
      )}

      {!editing && !touchSettingsOpen && (
        <nav
          className="absolute inset-x-3 z-40 h-[5.65rem] overflow-visible"
          style={{ bottom: 'max(0.5rem, calc(var(--safe-bottom, 0px) + 0.35rem))' }}
          aria-label="陪伴桌面导航"
          data-testid="companion-ornate-dock"
          data-visual-style="ornate-flat"
        >
          <div
            className="pointer-events-none absolute inset-0 border"
            style={{
              background: `linear-gradient(180deg, ${palette.panelTop}e8 0%, ${palette.panelBottom}f6 100%)`,
              borderColor: `${uiTint}70`,
              clipPath: 'polygon(0 12px, 12px 0, 37% 0, 42% 9px, 58% 9px, 63% 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 0 100%)',
            }}
          />
          <div className="pointer-events-none absolute inset-x-[7%] top-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${uiTint}b8 24%, ${uiTint}b8 76%, transparent)` }} />
          <div className="pointer-events-none absolute inset-x-[12%] bottom-0 h-px" style={{ background: `linear-gradient(90deg, transparent, ${uiTint}52, transparent)` }} />
          <span className="pointer-events-none absolute left-[7%] top-2 text-[6px]" style={{ color: uiTint }} aria-hidden>✦</span>
          <span className="pointer-events-none absolute right-[7%] top-2 text-[5px] text-white/60" aria-hidden>✦</span>
          <div className="relative z-10 grid h-full grid-cols-5 items-center gap-1 px-2">
            {[
              { id: AppID.Chat, icon: Icons.Chat, label: '聊天' },
              { id: AppID.Schedule, icon: Icons.Schedule, label: '日程' },
            ].map(item => (
              <button key={item.id} onClick={() => launchCompanionApp(item.id)} className="flex h-full flex-col items-center justify-center gap-1 text-white/90 active:scale-[.97]">
                <span className="flex h-10 w-10 rotate-45 items-center justify-center rounded-[0.7rem] border bg-black/15 sm:h-12 sm:w-12" style={{ borderColor: `${uiTint}72` }}>
                  <item.icon className="h-5 w-5 -rotate-45 sm:h-6 sm:w-6" />
                </span>
                <span className="text-[9px] tracking-[0.12em] sm:text-[10px]">{item.label}</span>
              </button>
            ))}
            <button
              onClick={() => setAppStarOpen(open => !open)}
              className="relative flex h-full flex-col items-center justify-center gap-0.5 text-white active:scale-[.97]"
              aria-expanded={appStarOpen}
              data-testid="companion-app-star-button"
            >
              <span className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full border sm:h-[4.25rem] sm:w-[4.25rem]" style={{ borderColor: `${uiTint}c4`, background: `${palette.panelBottom}f5` }}>
                <span className="absolute inset-[5px] rounded-full border" style={{ borderColor: `${uiTint}60` }} />
                <span className="relative flex h-10 w-10 items-center justify-center rounded-full border sm:h-12 sm:w-12" style={{ borderColor: `${uiTint}df`, background: `${uiTint}36` }}>
                  <Sparkle className="relative" size={23} weight="fill" />
                  <span className="absolute right-0.5 top-0.5 text-[6px] text-white/90">✦</span>
                </span>
              </span>
              <span className="text-[9px] font-semibold tracking-[0.18em] sm:text-[10px]" style={{ color: uiTint }}>功能</span>
            </button>
            {[
              { id: AppID.Music, icon: Icons.Music, label: '音乐' },
              { id: AppID.Settings, icon: Icons.Settings, label: '设置' },
            ].map(item => (
              <button key={item.id} onClick={() => launchCompanionApp(item.id)} className="flex h-full flex-col items-center justify-center gap-1 text-white/90 active:scale-[.97]">
                <span className="flex h-10 w-10 rotate-45 items-center justify-center rounded-[0.7rem] border bg-black/15 sm:h-12 sm:w-12" style={{ borderColor: `${uiTint}72` }}>
                  <item.icon className="h-5 w-5 -rotate-45 sm:h-6 sm:w-6" />
                </span>
                <span className="text-[9px] tracking-[0.12em] sm:text-[10px]">{item.label}</span>
              </button>
            ))}
          </div>
        </nav>
      )}
      {/* ── 布置模式：位置提示 + 背景选择底栏 ── */}
      {editing && (
        <>
          {character.videoAvatar && (
            <div
              className="pointer-events-none absolute inset-x-6 z-40 rounded-2xl border border-white/20 bg-black/40 px-3 py-2 text-center"
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

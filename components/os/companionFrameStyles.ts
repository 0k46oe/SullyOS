export type CompanionFrameStyleId = 'tech' | 'mobilegame' | 'storycard' | 'editorial';

export type CompanionFrameStyleOption = {
  id: CompanionFrameStyleId;
  name: string;
  description: string;
  swatch: string;
};

export const COMPANION_FRAME_STYLE_KEY = 'companion_frame_style_v1';
export const COMPANION_FRAME_STYLE_EVENT = 'sullyos:companion-frame-style';

export const COMPANION_FRAME_STYLES: CompanionFrameStyleOption[] = [
  {
    id: 'tech',
    name: '星轨终端',
    description: '当前科技风 · 切角细线 · 菱形控制',
    swatch: 'linear-gradient(145deg,#111827 0%,#1f2940 55%,#8fa9d7 100%)',
  },
  {
    id: 'mobilegame',
    name: '星愿手游',
    description: '二次元手游风 · 亮紫徽章 · 星芒圆框',
    swatch: 'linear-gradient(145deg,#2b173d 0%,#8c5bc6 52%,#ffd1f0 100%)',
  },
  {
    id: 'storycard',
    name: '绮夜卡面',
    description: '角色卡片风 · 双层描边 · 章节角标',
    swatch: 'linear-gradient(145deg,#171328 0%,#49335e 55%,#e4c38e 100%)',
  },
  {
    id: 'editorial',
    name: '夜刊画报',
    description: '平面杂志风 · 细线分栏 · 克制留白',
    swatch: 'linear-gradient(145deg,#0d1018 0%,#222536 62%,#d9d7e7 100%)',
  },
];

const isCompanionFrameStyle = (value: string | null): value is CompanionFrameStyleId =>
  COMPANION_FRAME_STYLES.some(style => style.id === value);

export const loadCompanionFrameStyle = (): CompanionFrameStyleId => {
  if (typeof window === 'undefined') return 'tech';
  try {
    const stored = window.localStorage.getItem(COMPANION_FRAME_STYLE_KEY);
    return isCompanionFrameStyle(stored) ? stored : 'tech';
  } catch {
    return 'tech';
  }
};

export const saveCompanionFrameStyle = (style: CompanionFrameStyleId): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COMPANION_FRAME_STYLE_KEY, style);
  } catch {
    // Storage can be unavailable in private WebViews; the live preview still works.
  }
  window.dispatchEvent(new CustomEvent<CompanionFrameStyleId>(COMPANION_FRAME_STYLE_EVENT, { detail: style }));
};

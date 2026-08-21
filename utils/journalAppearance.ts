import type { JournalAppearance, JournalAppearancePresetId } from '../types';

export interface JournalAppearancePreset {
    id: JournalAppearancePresetId;
    name: string;
    description: string;
    colors: [string, string, string];
    css: string;
}

export const JOURNAL_CSS_SCOPE_REGEX = /^\.sully-journal(?:\b|-)/;
export const JOURNAL_CSS_SCOPE_HINT = '.sully-journal-root / .sully-journal-*';

export const JOURNAL_APPEARANCE_PRESETS: JournalAppearancePreset[] = [
    {
        id: 'original',
        name: '原本琥珀',
        description: '保留现在的交换日记界面',
        colors: ['#f59e0b', '#fffbeb', '#1a1a1a'],
        css: '',
    },
    {
        id: 'letterpress',
        name: '旧信笺',
        description: '奶油纸张与深棕油墨',
        colors: ['#8b6b50', '#f4ecdc', '#40342c'],
        css: `.sully-journal-root{background:#f4ecdc!important;color:#4b3a2e!important;font-family:"Songti SC","Noto Serif SC",serif!important;}
.sully-journal-header,.sully-journal-toolbar{background:rgba(244,236,220,.94)!important;border-color:rgba(107,78,55,.14)!important;color:#4b3a2e!important;}
.sully-journal-calendar-hero{background:#8b6b50!important;box-shadow:0 14px 32px rgba(76,53,37,.2)!important;}
.sully-journal-notebook,.sully-journal-entry{background:#fffaf0!important;border-color:rgba(107,78,55,.13)!important;box-shadow:0 8px 24px rgba(76,53,37,.09)!important;}
.sully-journal-new-entry{border-color:#b99777!important;color:#7a5d45!important;background:rgba(255,250,240,.55)!important;}
.sully-journal-write{background:#40342c!important;}
.sully-journal-editor-header,.sully-journal-bottom-controls{background:rgba(52,42,35,.96)!important;}
.sully-journal-paper{border-radius:10px!important;box-shadow:0 18px 45px rgba(17,12,9,.3)!important;}
.sully-journal-textarea{font-family:"Songti SC","Noto Serif SC",serif!important;letter-spacing:.035em!important;}`,
    },
    {
        id: 'sakura',
        name: '樱花邮局',
        description: '柔粉信封与莓果印章',
        colors: ['#d97791', '#fff3f6', '#4a3039'],
        css: `.sully-journal-root{background:#fff3f6!important;color:#603b49!important;}
.sully-journal-header{background:rgba(255,243,246,.94)!important;border-color:#f8d8e1!important;}
.sully-journal-header-title,.sully-journal-notebook-name{color:#7d4055!important;}
.sully-journal-calendar-hero{background:linear-gradient(145deg,#e995aa,#c96a86)!important;box-shadow:0 16px 38px rgba(181,80,111,.22)!important;}
.sully-journal-notebook,.sully-journal-entry{background:#fffafb!important;border-color:#f5d5df!important;box-shadow:0 10px 26px rgba(175,79,109,.1)!important;}
.sully-journal-notebook{border-left-color:#c85f7d!important;}
.sully-journal-entry-accent{background:#df819b!important;}
.sully-journal-new-entry{border-color:#e7a4b7!important;color:#b85572!important;background:rgba(255,255,255,.54)!important;}
.sully-journal-write{background:#4a3039!important;}
.sully-journal-editor-header,.sully-journal-bottom-controls{background:rgba(58,36,44,.96)!important;}
.sully-journal-tab-active{background:#d97791!important;color:white!important;}
.sully-journal-sticker-button{background:linear-gradient(145deg,#ef9eb2,#c75d7c)!important;}`,
    },
    {
        id: 'forest',
        name: '林间手记',
        description: '鼠尾草绿与木色书脊',
        colors: ['#66806a', '#f0f4ea', '#29362d'],
        css: `.sully-journal-root{background:#f0f4ea!important;color:#33473a!important;}
.sully-journal-header{background:rgba(240,244,234,.94)!important;border-color:#d4dfce!important;}
.sully-journal-header-title,.sully-journal-notebook-name{color:#37533f!important;}
.sully-journal-calendar-hero{background:linear-gradient(145deg,#78957d,#536e59)!important;box-shadow:0 16px 36px rgba(49,78,57,.2)!important;}
.sully-journal-notebook,.sully-journal-entry{background:#fbfdf8!important;border-color:#dbe5d5!important;box-shadow:0 9px 25px rgba(51,76,57,.09)!important;}
.sully-journal-notebook{border-left-color:#765d43!important;}
.sully-journal-entry-accent{background:#7b987f!important;}
.sully-journal-new-entry{border-color:#9ab19a!important;color:#55745d!important;background:rgba(255,255,255,.48)!important;}
.sully-journal-write{background:#29362d!important;}
.sully-journal-editor-header,.sully-journal-bottom-controls{background:rgba(32,45,36,.96)!important;}
.sully-journal-tab-active{background:#66806a!important;color:white!important;}
.sully-journal-sticker-button{background:linear-gradient(145deg,#87a18b,#55705b)!important;}`,
    },
    {
        id: 'midnight',
        name: '午夜蓝墨',
        description: '深蓝书页与银色月光',
        colors: ['#7186c7', '#151a2b', '#eef1ff'],
        css: `.sully-journal-root{background:#151a2b!important;color:#e7eaff!important;}
.sully-journal-header{background:rgba(21,26,43,.94)!important;border-color:rgba(169,180,230,.14)!important;}
.sully-journal-header-title,.sully-journal-back{color:#eef1ff!important;}
.sully-journal-back svg,.sully-journal-appearance-button{color:#eef1ff!important;}
.sully-journal-calendar-hero{background:linear-gradient(145deg,#35446f,#202943)!important;box-shadow:0 18px 44px rgba(5,8,20,.42)!important;}
.sully-journal-notebook,.sully-journal-entry{background:#20273d!important;border-color:rgba(154,169,222,.16)!important;box-shadow:0 12px 30px rgba(4,7,17,.28)!important;}
.sully-journal-notebook{border-left-color:#7186c7!important;}
.sully-journal-notebook-name,.sully-journal-entry-text{color:#eef1ff!important;}
.sully-journal-notebook-label{background:rgba(113,134,199,.15)!important;color:#b9c5ef!important;}
.sully-journal-entry-year{color:#9ca9d6!important;}
.sully-journal-entry-date{background:#2b3554!important;border-color:#40507d!important;color:#e7eaff!important;}
.sully-journal-entry-accent{background:#7186c7!important;}
.sully-journal-new-entry{border-color:#536696!important;color:#b9c5ef!important;background:rgba(113,134,199,.07)!important;}
.sully-journal-write{background:#0f1320!important;}
.sully-journal-editor-header,.sully-journal-bottom-controls{background:rgba(15,19,32,.96)!important;}
.sully-journal-tab-active{background:#7186c7!important;color:white!important;}
.sully-journal-sticker-button{background:linear-gradient(145deg,#7186c7,#46598f)!important;}`,
    },
];

export const resolveJournalPreset = (preset?: JournalAppearancePresetId) =>
    JOURNAL_APPEARANCE_PRESETS.find(candidate => candidate.id === (preset || 'original'))
    || JOURNAL_APPEARANCE_PRESETS[0];

export const resolveJournalAppearanceCss = (appearance?: JournalAppearance) => {
    const presetCss = resolveJournalPreset(appearance?.preset).css;
    const customCss = appearance?.customCss?.trim() || '';
    return [presetCss, customCss].filter(Boolean).join('\n');
};

/** 将“内置主题 + 用户覆盖”拍平成一份不依赖主题 ID 的独立 CSS。 */
export const flattenJournalAppearance = (appearance?: JournalAppearance): JournalAppearance => ({
    preset: 'original',
    customCss: resolveJournalAppearanceCss(appearance),
});

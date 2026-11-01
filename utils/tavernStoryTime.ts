/**
 * 酒馆导入角色的剧情时间。
 *
 * 规则（2026-11-01 与用户确认）：
 *  - 只对 tavernImport 存在、且 tavernStoryTime.enabled 的角色生效；其它角色一律返回 null，调用方走原有现实时间逻辑。
 *  - 用户只填一个初始年份文字（3777年、星历2077年、庚辰年、天启三年……）。
 *    月、日、时、分全部跟现实一致；现实每跨一年，剧情年份也往后推一年。
 *  - 年份推算：阿拉伯数字直接加；「年」前面的中文数字（三年、二〇七七年、元年）按中文数字加；
 *    天干地支按六十年一轮往下排。认不出数字的文字（太初纪元）保持原样。
 *  - 不提星期几：古代、修仙这类背景说「周一」会出戏。
 *  - 数据库里的真实时间戳永远不改；这里只负责换算给模型看的文字。
 */
import type { CharacterProfile, TavernStoryTimeConfig } from '../types';
import { nowInTimeZone, resolveCharTimeZone } from './timezone';

const DAY_MS = 24 * 60 * 60 * 1000;

export type StoryTimeSource = Pick<CharacterProfile, 'tavernImport' | 'tavernStoryTime' | 'customTimezoneEnabled' | 'customTimezone'> | null | undefined;

/** 生效中的剧情时间：初始年份文字 + 填写那一年的现实年份 + 角色时区（没设自定义时区为 undefined） */
export interface ActiveStoryTime {
    yearLabel: string;
    baseRealYear: number;
    tz?: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const wall = (story: ActiveStoryTime, ts: number) => nowInTimeZone(story.tz, new Date(ts));

// ─── 旧格式兼容 ─────────────────────────────────────

/**
 * 第一版（同日早些时候）存的是 segments：标准日期或纪年文字 + 时刻。
 * 读到旧格式时取最后一段换成年份文字：标准日期取年份，纪年取原文。
 */
export function normalizeTavernStoryTime(config: TavernStoryTimeConfig | undefined): { enabled: boolean; yearLabel: string; baseRealYear: number } | null {
    if (!config) return null;
    if (typeof config.yearLabel === 'string' && Number.isFinite(config.baseRealYear)) {
        return { enabled: config.enabled === true, yearLabel: config.yearLabel, baseRealYear: config.baseRealYear! };
    }
    const segments = Array.isArray(config.segments) ? config.segments.filter(s => s && Number.isFinite(s.realAnchor)) : [];
    const last = segments.sort((a, b) => a.realAnchor - b.realAnchor)[segments.length - 1];
    if (!last) return { enabled: config.enabled === true, yearLabel: config.yearLabel || '', baseRealYear: new Date().getFullYear() };
    const year = last.mode === 'calendar' ? /^(\d{1,6})-/.exec(last.storyDate || '')?.[1] : undefined;
    const yearLabel = year ? `${Number(year)}年` : (last.label || '').trim();
    return { enabled: config.enabled === true, yearLabel, baseRealYear: new Date(last.realAnchor).getFullYear() };
}

export function getActiveTavernStoryTime(char: StoryTimeSource): ActiveStoryTime | null {
    if (!char?.tavernImport) return null;
    const config = normalizeTavernStoryTime(char.tavernStoryTime);
    if (!config?.enabled || !config.yearLabel.trim()) return null;
    return { yearLabel: config.yearLabel.trim(), baseRealYear: config.baseRealYear, tz: resolveCharTimeZone(char) };
}

// ─── 年份推算 ───────────────────────────────────────

const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
const CN_DIGITS = '〇一二三四五六七八九';
const CN_DIGIT_VALUE: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT_VALUE: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

function shiftGanzhi(text: string, offset: number): string {
    return text.replace(/([甲乙丙丁戊己庚辛壬癸])([子丑寅卯辰巳午未申酉戌亥])/g, (pair, stem: string, branch: string) => {
        const s = STEMS.indexOf(stem), b = BRANCHES.indexOf(branch);
        if (s % 2 !== b % 2) return pair; // 不是合法的干支组合（如「甲丑」），不动
        let index = 0;
        while (index % 10 !== s || index % 12 !== b) index++;
        const next = (((index + offset) % 60) + 60) % 60;
        return STEMS[next % 10] + BRANCHES[next % 12];
    });
}

/** 中文数字 → 数值。认不出返回 null */
export function parseChineseNumber(text: string): number | null {
    if (text === '元') return 1;
    if (!text || /[^〇零一二两三四五六七八九十百千万]/.test(text)) return null;
    // 逐位写法：二〇七七
    if (!/[十百千万]/.test(text)) {
        return text.length > 1 || text in CN_DIGIT_VALUE ? Number([...text].map(ch => CN_DIGIT_VALUE[ch]).join('')) : null;
    }
    let total = 0, section = 0, digit = 0;
    for (const ch of text) {
        if (ch in CN_DIGIT_VALUE) { digit = CN_DIGIT_VALUE[ch]; continue; }
        const unit = CN_UNIT_VALUE[ch];
        if (unit === 10000) { total += (section + digit) * 10000; section = 0; digit = 0; continue; }
        section += (digit || 1) * unit; // 「十二」的十前面没有数字，按一十算
        digit = 0;
    }
    return total + section + digit;
}

function formatChineseUnder10000(n: number, leadingTen: boolean): string {
    const units = ['千', '百', '十', ''];
    const digits = String(n).padStart(4, '0').split('').map(Number);
    let out = '', zero = false, started = false;
    digits.forEach((d, i) => {
        if (d === 0) { if (started) zero = true; return; }
        if (zero) { out += '零'; zero = false; }
        out += (leadingTen && !started && d === 1 && units[i] === '十') ? '十' : CN_DIGITS[d] + units[i];
        started = true;
    });
    return out;
}

/** 数值 → 中文数字。style 跟随原文：逐位写法（二〇七七）或带单位写法（一百零五） */
export function formatChineseNumber(n: number, style: 'digits' | 'units'): string {
    if (style === 'digits') return String(n).split('').map(d => CN_DIGITS[Number(d)]).join('');
    if (n === 0) return '零';
    if (n < 10000) return formatChineseUnder10000(n, n < 20);
    const high = Math.floor(n / 10000), low = n % 10000;
    return formatChineseUnder10000(high, high < 20) + '万' + (low === 0 ? '' : (low < 1000 ? '零' : '') + formatChineseUnder10000(low, false));
}

/** 把年份文字往后推 offset 年（offset 可为负）。推不动的部分保持原样 */
export function shiftYearLabel(label: string, offset: number): string {
    if (!offset) return label;
    let result = label;
    const arabic = [...label.matchAll(/\d+/g)].pop();
    if (arabic) {
        const next = Number(arabic[0]) + offset;
        if (next >= 0) {
            const text = String(next).padStart(arabic[0].length, '0');
            result = label.slice(0, arabic.index!) + text + label.slice(arabic.index! + arabic[0].length);
        }
    } else {
        const chinese = [...label.matchAll(/([〇零一二两三四五六七八九十百千万]+|元)(?=年)/g)].pop();
        const value = chinese ? parseChineseNumber(chinese[1]) : null;
        if (chinese && value !== null && value + offset >= 1) {
            const next = value + offset;
            const style = chinese[1] !== '元' && !/[十百千万]/.test(chinese[1]) && chinese[1].length > 1 ? 'digits' : 'units';
            const text = next === 1 && chinese[1] === '元' ? '元' : formatChineseNumber(next, style);
            result = label.slice(0, chinese.index!) + text + label.slice(chinese.index! + chinese[1].length);
        }
    }
    return shiftGanzhi(result, offset);
}

/** 某个现实时间点对应的剧情年份文字 */
export function storyYearAt(story: ActiveStoryTime, realTs: number): string {
    return shiftYearLabel(story.yearLabel, wall(story, realTs).getFullYear() - story.baseRealYear);
}

// ─── 显示 ───────────────────────────────────────────

/** 「3777年11月1日」「庚辰年11月1日」；年份文字不以「年」结尾时用空格隔开：「太初纪元 11月1日」 */
export function formatStoryDate(story: ActiveStoryTime, realTs: number): string {
    const d = wall(story, realTs);
    const year = storyYearAt(story, realTs);
    return `${year}${year.endsWith('年') ? '' : ' '}${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatStoryClock(story: ActiveStoryTime, realTs: number): string {
    const d = wall(story, realTs);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 「3777年11月1日 14:50」 */
export function formatStoryDateTime(story: ActiveStoryTime, realTs: number): string {
    return `${formatStoryDate(story, realTs)} ${formatStoryClock(story, realTs)}`;
}

/** 日序号（按角色那边的日历日），用于记忆提取时给同一天的消息编 D1、D2 */
export function storyDayNumber(story: ActiveStoryTime, realTs: number): number {
    const d = wall(story, realTs);
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** 召回时的记忆日期，对应普通角色的 formatMemoryDateWithDistance：「3777年11月1日（距今约3天）」 */
export function formatStoryMemoryDate(story: ActiveStoryTime, createdAt: number, now: number = Date.now()): string {
    if (!Number.isFinite(createdAt) || !Number.isFinite(now)) return '日期不详';
    const distance = storyDayNumber(story, now) - storyDayNumber(story, createdAt);
    const relative = distance === 0 ? '今天' : distance > 0 ? `距今约${distance}天` : `约${Math.abs(distance)}天后`;
    return `${formatStoryDate(story, createdAt)}（${relative}）`;
}

// ─── 设置页 ─────────────────────────────────────────

/** 设置页输入框要显示的「现在的剧情年份」 */
export function currentYearLabel(char: StoryTimeSource, now: number = Date.now()): string {
    const config = normalizeTavernStoryTime(char?.tavernStoryTime);
    if (!config?.yearLabel) return '';
    return storyYearAt({ yearLabel: config.yearLabel, baseRealYear: config.baseRealYear, tz: resolveCharTimeZone(char) }, now);
}

/** 用户改了年份或开关：以今年为起点重新保存 */
export function buildTavernStoryTimeConfig(char: StoryTimeSource, patch: { enabled?: boolean; yearLabel?: string }, now: number = Date.now()): TavernStoryTimeConfig {
    const config = normalizeTavernStoryTime(char?.tavernStoryTime);
    return {
        enabled: patch.enabled ?? config?.enabled ?? false,
        yearLabel: patch.yearLabel ?? currentYearLabel(char, now),
        baseRealYear: nowInTimeZone(resolveCharTimeZone(char), new Date(now)).getFullYear(),
    };
}

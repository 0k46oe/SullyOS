/**
 * 酒馆导入角色的剧情时间换算。
 *
 * 规则：
 *  - 只对 tavernImport 存在、且 tavernStoryTime.enabled 的角色生效；其它角色一律返回 null，调用方走原有现实时间逻辑。
 *  - 数据库里的真实时间戳永远不改；这里只负责「真实时间 → 剧情时间」的换算。
 *  - 剧情时间按段计算：每段从用户保存时的现实时间起，剧情时间从用户填写的值开始 1:1 流逝。
 *    用户手动跳日就追加新段，旧段不动，所以跳日之前的消息和记忆仍显示原来的剧情日期。
 *  - calendar 模式按标准年月日推进；label 模式（庚辰年、星际纪年等）纪年文本固定，只推进时分和天数。
 *  - 剧情时钟全部用 UTC 字段计算，避免本机夏令时让剧情时间多/少一小时。
 */
import type { CharacterProfile, TavernStoryTimeConfig, TavernStoryTimeSegment } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^(\d{1,6})-(\d{1,2})-(\d{1,2})$/;
const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;
/** label 模式没有真实历法，用固定基准日只为推进时分、区分「第几天」 */
const LABEL_BASE = { y: 2000, m: 1, d: 1 };
const MAX_SEGMENTS = 200;

export type StoryTimeSource = Pick<CharacterProfile, 'tavernImport' | 'tavernStoryTime'> | null | undefined;

const pad2 = (n: number) => String(n).padStart(2, '0');

function parseClock(clock: string | undefined): { h: number; mi: number } | null {
    const match = CLOCK_RE.exec((clock || '').trim());
    if (!match) return null;
    const h = Number(match[1]);
    const mi = Number(match[2]);
    if (h > 23 || mi > 59) return null;
    return { h, mi };
}

/** 解析 YYYY-MM-DD（年份 1–999999）；不存在的日期（如 2 月 30 日）返回 null */
export function parseStoryDate(value: string | undefined): { y: number; m: number; d: number } | null {
    const match = DATE_RE.exec((value || '').trim());
    if (!match) return null;
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    if (y < 1 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const probe = new Date(0);
    probe.setUTCFullYear(y, m - 1, d);
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    return { y, m, d };
}

function utcMs(date: { y: number; m: number; d: number }, clock: { h: number; mi: number }): number {
    const result = new Date(0);
    // 用 setUTCFullYear 而不是 Date.UTC：Date.UTC 会把 0–99 年当成 1900+ 年
    result.setUTCFullYear(date.y, date.m - 1, date.d);
    result.setUTCHours(clock.h, clock.mi, 0, 0);
    return result.getTime();
}

function segmentBaseMs(segment: TavernStoryTimeSegment): number | null {
    if (!Number.isFinite(segment?.realAnchor)) return null;
    const clock = parseClock(segment.storyClock);
    if (!clock) return null;
    if (segment.mode === 'label') return segment.label?.trim() ? utcMs(LABEL_BASE, clock) : null;
    if (segment.mode !== 'calendar') return null;
    const date = parseStoryDate(segment.storyDate);
    return date ? utcMs(date, clock) : null;
}

function validSegments(config: TavernStoryTimeConfig | undefined): TavernStoryTimeSegment[] {
    if (!Array.isArray(config?.segments)) return [];
    return config!.segments
        .filter(segment => segmentBaseMs(segment) !== null)
        .sort((a, b) => a.realAnchor - b.realAnchor);
}

/** 生效中的剧情时间。普通角色、未开启或没有合法设置时返回 null */
export interface ActiveStoryTime {
    segments: TavernStoryTimeSegment[];
}

export function getActiveTavernStoryTime(char: StoryTimeSource): ActiveStoryTime | null {
    const config = char?.tavernStoryTime;
    if (!char?.tavernImport || !config?.enabled) return null;
    const segments = validSegments(config);
    return segments.length > 0 ? { segments } : null;
}

/** 某个现实时间点属于哪一段：最后一个 realAnchor ≤ ts 的段；早于第一段的旧消息按第一段往回推 */
function segmentAt(story: ActiveStoryTime, realTs: number): TavernStoryTimeSegment {
    let current = story.segments[0];
    for (const segment of story.segments) {
        if (segment.realAnchor <= realTs) current = segment;
        else break;
    }
    return current;
}

function storyMs(story: ActiveStoryTime, realTs: number): { ms: number; segment: TavernStoryTimeSegment } {
    const segment = segmentAt(story, realTs);
    return { ms: segmentBaseMs(segment)! + (realTs - segment.realAnchor), segment };
}

/** 剧情日序号：同一剧情日的时间点序号相同，用于分组 */
export function storyDayNumber(story: ActiveStoryTime, realTs: number): number {
    return Math.floor(storyMs(story, realTs).ms / DAY_MS);
}

/** 剧情日期文本：calendar →「3777年11月1日」，label →「庚辰年」 */
export function formatStoryDate(story: ActiveStoryTime, realTs: number): string {
    const { ms, segment } = storyMs(story, realTs);
    if (segment.mode === 'label') return segment.label!.trim();
    const d = new Date(ms);
    return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

export function formatStoryClock(story: ActiveStoryTime, realTs: number): string {
    const d = new Date(storyMs(story, realTs).ms);
    return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** 「3777年11月1日 14:50」或「庚辰年 14:50」 */
export function formatStoryDateTime(story: ActiveStoryTime, realTs: number): string {
    return `${formatStoryDate(story, realTs)} ${formatStoryClock(story, realTs)}`;
}

/** 两个时间点之间相隔几个剧情日。两端模式不同（日历和纪年混用）时没法比较，退回现实经过的天数 */
function storyDayDistance(story: ActiveStoryTime, fromTs: number, toTs: number): number {
    const from = storyMs(story, fromTs);
    const to = storyMs(story, toTs);
    if (from.segment.mode !== to.segment.mode) return Math.floor(toTs / DAY_MS) - Math.floor(fromTs / DAY_MS);
    return Math.floor(to.ms / DAY_MS) - Math.floor(from.ms / DAY_MS);
}

/**
 * 召回时给酒馆角色看的记忆日期，对应普通角色的 formatMemoryDateWithDistance。
 * calendar →「3777年11月1日（距今约3天）」；label →「庚辰年 · 3天前」。
 */
export function formatStoryMemoryDate(story: ActiveStoryTime, createdAt: number, now: number = Date.now()): string {
    if (!Number.isFinite(createdAt) || !Number.isFinite(now)) return '日期不详';
    const text = formatStoryDate(story, createdAt);
    const distance = storyDayDistance(story, createdAt, now);
    if (segmentAt(story, createdAt).mode === 'label') {
        const relative = distance === 0 ? '今天' : distance > 0 ? `${distance}天前` : `${Math.abs(distance)}天后`;
        return `${text} · ${relative}`;
    }
    const relative = distance === 0 ? '今天' : distance > 0 ? `距今约${distance}天` : `约${Math.abs(distance)}天后`;
    return `${text}（${relative}）`;
}

// ─── 设置页 ─────────────────────────────────────────

export interface StoryTimeDraft {
    mode: 'calendar' | 'label';
    storyDate: string;
    storyClock: string;
    label: string;
}

/** 设置页初始值：把「此刻」的剧情时间拆回可编辑字段；没有设置过时用现实此刻作起点 */
export function currentStoryDraft(config: TavernStoryTimeConfig | undefined, now: number = Date.now()): StoryTimeDraft {
    const segments = validSegments(config);
    if (segments.length === 0) {
        const d = new Date(now);
        return {
            mode: 'calendar',
            storyDate: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
            storyClock: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
            label: '',
        };
    }
    const story = { segments };
    const { ms, segment } = storyMs(story, now);
    const d = new Date(ms);
    return {
        mode: segment.mode,
        storyDate: segment.mode === 'calendar'
            ? `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
            : '',
        storyClock: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`,
        label: segment.mode === 'label' ? segment.label!.trim() : '',
    };
}

/** 草稿是否能保存；不能时返回给用户看的原因 */
export function validateStoryDraft(draft: StoryTimeDraft): string | null {
    if (!parseClock(draft.storyClock)) return '时刻请填成 14:20 这样的格式';
    if (draft.mode === 'calendar' && !parseStoryDate(draft.storyDate)) return '日期请填成 3777-11-01 这样的格式，且必须是真实存在的日期';
    if (draft.mode === 'label' && !draft.label.trim()) return '请填写纪年文字，例如：庚辰年';
    return null;
}

/** 保存剧情时间：以「现在」为起点追加一段，旧段保留，返回新的配置；草稿不合法返回 null */
export function appendStorySegment(
    config: TavernStoryTimeConfig | undefined,
    draft: StoryTimeDraft,
    now: number = Date.now(),
): TavernStoryTimeConfig | null {
    if (validateStoryDraft(draft)) return null;
    const segment: TavernStoryTimeSegment = draft.mode === 'calendar'
        ? { realAnchor: now, mode: 'calendar', storyDate: draft.storyDate.trim(), storyClock: draft.storyClock.trim() }
        : { realAnchor: now, mode: 'label', label: draft.label.trim(), storyClock: draft.storyClock.trim() };
    const previous = validSegments(config).filter(item => item.realAnchor < now);
    return {
        enabled: config?.enabled ?? true,
        segments: [...previous, segment].slice(-MAX_SEGMENTS),
    };
}

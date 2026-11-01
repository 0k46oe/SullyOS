import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import {
    appendStorySegment,
    currentStoryDraft,
    formatStoryDate,
    formatStoryDateTime,
    formatStoryMemoryDate,
    getActiveTavernStoryTime,
    validateStoryDraft,
} from './tavernStoryTime';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const T0 = new Date(2026, 10, 1, 14, 20).getTime();
const tavern = { firstMessage: '', alternateGreetings: [], creatorNotes: '', creator: '', characterVersion: '', tags: [] };

function calendarChar(date = '3777-11-01', clock = '14:20'): Pick<CharacterProfile, 'tavernImport' | 'tavernStoryTime'> {
    return {
        tavernImport: tavern,
        tavernStoryTime: appendStorySegment(undefined, { mode: 'calendar', storyDate: date, storyClock: clock, label: '' }, T0)!,
    };
}

describe('剧情时间只对开启的酒馆角色生效', () => {
    it('普通角色、未开启、没有合法设置时返回 null', () => {
        const config = calendarChar().tavernStoryTime;
        expect(getActiveTavernStoryTime({ tavernStoryTime: config })).toBeNull();
        expect(getActiveTavernStoryTime({ tavernImport: tavern, tavernStoryTime: { ...config!, enabled: false } })).toBeNull();
        expect(getActiveTavernStoryTime({ tavernImport: tavern })).toBeNull();
        expect(getActiveTavernStoryTime({ tavernImport: tavern, tavernStoryTime: { enabled: true, segments: [] } })).toBeNull();
        expect(getActiveTavernStoryTime(null)).toBeNull();
    });
});

describe('标准日期 1:1 跟着现实走', () => {
    const story = getActiveTavernStoryTime(calendarChar())!;

    it('现实过 30 分钟、跨过午夜、过一个月', () => {
        expect(formatStoryDateTime(story, T0)).toBe('3777年11月1日 14:20');
        expect(formatStoryDateTime(story, T0 + 30 * MIN)).toBe('3777年11月1日 14:50');
        expect(formatStoryDateTime(story, T0 + 10 * 60 * MIN)).toBe('3777年11月2日 00:20');
        expect(formatStoryDate(story, T0 + 30 * DAY)).toBe('3777年12月1日');
    });

    it('早于设置时间的旧消息往回推', () => {
        expect(formatStoryDate(story, T0 - DAY)).toBe('3777年10月31日');
    });

    it('两位数年份不会被当成 19xx 年', () => {
        const early = getActiveTavernStoryTime(calendarChar('0042-01-01', '00:00'))!;
        expect(formatStoryDate(early, T0)).toBe('42年1月1日');
    });

    it('召回日期显示剧情年份和距今天数，不出现现实年份', () => {
        const label = formatStoryMemoryDate(story, T0, T0 + 3 * DAY);
        expect(label).toBe('3777年11月1日（距今约3天）');
        expect(label).not.toContain('2026');
    });
});

describe('手动跳日只影响之后的时间', () => {
    it('改日期后旧时间点保持原剧情日期', () => {
        const char = calendarChar();
        const jumpAt = T0 + 2 * 60 * MIN; // 现实 16:20，剧情 3777-11-01 16:20
        const jumped = appendStorySegment(char.tavernStoryTime, { mode: 'calendar', storyDate: '3777-11-03', storyClock: '08:00', label: '' }, jumpAt)!;
        const story = getActiveTavernStoryTime({ tavernImport: tavern, tavernStoryTime: jumped })!;
        expect(formatStoryDateTime(story, T0 + 60 * MIN)).toBe('3777年11月1日 15:20');
        expect(formatStoryDateTime(story, jumpAt + 10 * MIN)).toBe('3777年11月3日 08:10');
        // 跳日前的记忆，在跳日后召回：按剧情日算相隔 2 天
        expect(formatStoryMemoryDate(story, T0, jumpAt + 10 * MIN)).toBe('3777年11月1日（距今约2天）');
        expect(currentStoryDraft(jumped, jumpAt + 10 * MIN)).toMatchObject({ mode: 'calendar', storyDate: '3777-11-03', storyClock: '08:10' });
    });
});

describe('自定义纪年', () => {
    const config = appendStorySegment(undefined, { mode: 'label', storyDate: '', storyClock: '09:00', label: '庚辰年' }, T0)!;
    const story = getActiveTavernStoryTime({ tavernImport: tavern, tavernStoryTime: config })!;

    it('纪年文字不变，只推进时分', () => {
        expect(formatStoryDateTime(story, T0 + 20 * 60 * MIN)).toBe('庚辰年 05:00');
    });

    it('召回显示「庚辰年 · N天前」', () => {
        expect(formatStoryMemoryDate(story, T0, T0 + 3 * DAY)).toBe('庚辰年 · 3天前');
        expect(formatStoryMemoryDate(story, T0, T0 + 60 * MIN)).toBe('庚辰年 · 今天');
    });
});

describe('设置页校验', () => {
    it.each([
        [{ mode: 'calendar', storyDate: '3777-02-30', storyClock: '14:20', label: '' }],
        [{ mode: 'calendar', storyDate: '3777/11/01', storyClock: '14:20', label: '' }],
        [{ mode: 'calendar', storyDate: '3777-11-01', storyClock: '25:00', label: '' }],
        [{ mode: 'label', storyDate: '', storyClock: '14:20', label: '  ' }],
    ] as const)('不合法的输入不能保存 %#', draft => {
        expect(validateStoryDraft(draft)).not.toBeNull();
        expect(appendStorySegment(undefined, draft, T0)).toBeNull();
    });
});

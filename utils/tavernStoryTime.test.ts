import { describe, expect, it } from 'vitest';
import type { CharacterProfile } from '../types';
import {
    buildTavernStoryTimeConfig,
    currentYearLabel,
    formatChineseNumber,
    formatStoryDate,
    formatStoryDateTime,
    formatStoryMemoryDate,
    getActiveTavernStoryTime,
    parseChineseNumber,
    shiftYearLabel,
} from './tavernStoryTime';

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date(2026, 10, 1, 14, 20).getTime();
const NEXT_YEAR = new Date(2027, 0, 1, 9, 5).getTime();
const tavern = { firstMessage: '', alternateGreetings: [], creatorNotes: '', creator: '', characterVersion: '', tags: [] };
type Char = Pick<CharacterProfile, 'tavernImport' | 'tavernStoryTime'>;
const char = (yearLabel: string, enabled = true): Char => ({ tavernImport: tavern, tavernStoryTime: { enabled, yearLabel, baseRealYear: 2026 } });

describe('只对开启的酒馆角色生效', () => {
    it('普通角色、未开启、没填年份返回 null', () => {
        expect(getActiveTavernStoryTime({ tavernStoryTime: char('3777年').tavernStoryTime })).toBeNull();
        expect(getActiveTavernStoryTime(char('3777年', false))).toBeNull();
        expect(getActiveTavernStoryTime(char('  '))).toBeNull();
        expect(getActiveTavernStoryTime(null)).toBeNull();
    });
});

describe('年份换成用户填的，月日时分跟现实一致', () => {
    const story = getActiveTavernStoryTime(char('3777年'))!;
    it('同一年', () => {
        expect(formatStoryDateTime(story, T0)).toBe('3777年11月1日 14:20');
        expect(formatStoryDate(story, T0 + DAY)).toBe('3777年11月2日');
    });
    it('现实跨年，剧情年份加 1', () => {
        expect(formatStoryDateTime(story, NEXT_YEAR)).toBe('3778年1月1日 09:05');
    });
    it('没有「年」字的写法用空格隔开', () => {
        expect(formatStoryDate(getActiveTavernStoryTime(char('太初纪元'))!, T0)).toBe('太初纪元 11月1日');
    });
    it('召回日期不出现现实年份', () => {
        const label = formatStoryMemoryDate(story, T0, T0 + 3 * DAY);
        expect(label).toBe('3777年11月1日（距今约3天）');
        expect(label).not.toContain('2026');
    });
});

describe('年份推算', () => {
    it.each([
        ['3777年', 1, '3778年'],
        ['星历2077年', 1, '星历2078年'],
        ['公元0099年', 1, '公元0100年'],
        ['庚辰年', 1, '辛巳年'],
        ['癸亥年', 1, '甲子年'],
        ['庚辰年', 60, '庚辰年'],
        ['天启三年', 1, '天启四年'],
        ['天启九年', 1, '天启十年'],
        ['天启十九年', 1, '天启二十年'],
        ['贞观元年', 1, '贞观二年'],
        ['星历二〇七七年', 1, '星历二〇七八年'],
        ['开元九十九年', 1, '开元一百年'],
        ['太初纪元', 5, '太初纪元'],
        ['3777年', 0, '3777年'],
    ])('%s 过 %i 年 → %s', (label, offset, expected) => {
        expect(shiftYearLabel(label, offset)).toBe(expected);
    });

    it('中文数字互转', () => {
        expect(parseChineseNumber('十二')).toBe(12);
        expect(parseChineseNumber('一百零五')).toBe(105);
        expect(parseChineseNumber('二〇七七')).toBe(2077);
        expect(formatChineseNumber(105, 'units')).toBe('一百零五');
        expect(formatChineseNumber(12, 'units')).toBe('十二');
        expect(formatChineseNumber(10001, 'units')).toBe('一万零一');
    });
});

describe('设置页', () => {
    it('输入框显示今年的剧情年份；改年份以今年为起点重新保存', () => {
        const old = char('3777年');
        expect(currentYearLabel(old, NEXT_YEAR)).toBe('3778年');
        const saved = buildTavernStoryTimeConfig(old, { yearLabel: '庚辰年' }, NEXT_YEAR);
        expect(saved).toEqual({ enabled: true, yearLabel: '庚辰年', baseRealYear: 2027 });
        // 关开关不丢年份
        expect(buildTavernStoryTimeConfig(old, { enabled: false }, T0)).toMatchObject({ enabled: false, yearLabel: '3777年' });
    });

    it('第一版的分段格式自动换成年份', () => {
        const legacy = { tavernImport: tavern, tavernStoryTime: { enabled: true, segments: [{ realAnchor: T0, mode: 'calendar' as const, storyDate: '3777-11-01', storyClock: '14:20' }] } };
        expect(formatStoryDateTime(getActiveTavernStoryTime(legacy)!, T0)).toBe('3777年11月1日 14:20');
        const label = { tavernImport: tavern, tavernStoryTime: { enabled: true, segments: [{ realAnchor: T0, mode: 'label' as const, label: '庚辰年', storyClock: '09:00' }] } };
        expect(formatStoryDate(getActiveTavernStoryTime(label)!, T0)).toBe('庚辰年11月1日');
    });
});

import { ContextBuilder } from './context';
import { ChatPrompts } from './chatPrompts';

describe('提示词里的当前时间和历史时间戳', () => {
    const base = { id: 'c', name: '角色', memories: [] } as unknown as CharacterProfile;
    const tavernChar = { ...base, ...char('庚辰年') } as CharacterProfile;

    it('酒馆角色在聊天/见面/查手机里看到剧情年份，不提星期几', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(tavernChar, { tavernStoryTime: true });
        expect(block).toMatch(/现在是 庚辰年\d+月\d+日 /);
        expect(block).not.toMatch(/周[一二三四五六日]/);
        expect(block).not.toContain(String(new Date().getFullYear()));
    });

    it('其他 App 不传开关时仍是现实时间；普通角色传了开关也不变', () => {
        const year = String(new Date().getFullYear());
        expect(ContextBuilder.buildTimeAwarenessBlock(tavernChar)).toContain(year);
        expect(ContextBuilder.buildTimeAwarenessBlock(base, { tavernStoryTime: true })).toContain(year);
    });

    it('历史消息时间戳换成剧情年份', () => {
        const messages = [{ id: 1, charId: 'c', role: 'user', type: 'text', content: '你好', timestamp: T0 }] as any;
        const story = ChatPrompts.buildMessageHistory(messages, 10, tavernChar, { name: '我' } as any, [], undefined, { tavernStoryTime: true });
        expect(JSON.stringify(story.apiMessages)).toContain('庚辰年11月1日 14:20');
        const plain = ChatPrompts.buildMessageHistory(messages, 10, base, { name: '我' } as any, []);
        expect(JSON.stringify(plain.apiMessages)).toContain('2026-11-01 14:20');
    });
});

/**
 * realtimeWorldCore 回归测试。
 *
 * 这份叶子被浏览器聊天和主动消息到点生成共用，所以守两件事：
 * 渲染函数按「手上真有什么」裁剪（半截的一段比没有更容易让角色现编），
 * 以及热榜时段 key 按指定时区算（worker 跑在 UTC 上，不指定就跟用户差好几个时段）。
 */

import { describe, expect, it } from 'vitest';
import {
    getHotNewsSlot,
    pickRandomNews,
    renderRealtimeWorldBlock,
    resolveHotNewsPlatforms,
    sameHotNewsPlatforms,
    DEFAULT_HOTNEWS_PLATFORMS,
    type NewsItem,
    type WeatherData,
} from './realtimeWorldCore';

const weather: WeatherData = {
    temp: 31, feelsLike: 35, humidity: 60,
    description: '小雨', icon: '10d', city: '上海',
};
const news: NewsItem[] = [{ title: '某某官宣', source: '微博', desc: '一句简介' }];

describe('renderRealtimeWorldBlock', () => {
    it('四样都空 → 返回空串（不留一个什么都没有的抬头）', () => {
        expect(renderRealtimeWorldBlock({})).toBe('');
        expect(renderRealtimeWorldBlock({ specialDates: [], news: [], weather: null })).toBe('');
    });

    it('不传 timeLine 就不出「当前真实时间」那一行', () => {
        // 主动消息到点生成时时间由 fire_pack 的 AMSG_SLOT_CURRENT_TIME 填，
        // 这一段再出一次，同一份提示词里就有了两个钟。
        const out = renderRealtimeWorldBlock({ weather, news });
        expect(out).toContain('真实世界感知系统');
        expect(out).not.toContain('当前真实时间');

        const withTime = renderRealtimeWorldBlock({ timeLine: '2026年8月2日 周日 晚上 21:30', weather });
        expect(withTime).toContain('📅 当前真实时间: 2026年8月2日 周日 晚上 21:30');
    });

    it('节日单独给，天气热搜没开也照样成段', () => {
        const out = renderRealtimeWorldBlock({ specialDates: ['七夕'] });
        expect(out).toContain('🎉 今日特殊: 七夕');
        expect(out).not.toContain('实时天气');
        expect(out).not.toContain('最近真实发生的热点');
    });

    it('天气没拉到 → 连带撤掉「天气是真实的」那条用法提示', () => {
        // 留着的话等于在教角色聊一个它手上根本没有的读数。
        const withWeather = renderRealtimeWorldBlock({ weather });
        expect(withWeather).toContain('🌤️ 【上海实时天气】');
        expect(withWeather).toContain('你的建议: ');
        expect(withWeather).toContain('天气是真实的');

        const without = renderRealtimeWorldBlock({ weather: null, news });
        expect(without).not.toContain('天气是真实的');
    });

    it('热点带来源与简介，并教一遍新闻卡片的写法', () => {
        const out = renderRealtimeWorldBlock({ news });
        expect(out).toContain('- 某某官宣（微博）：一句简介');
        expect(out).toContain('[[NEWS_CARD: 来源|标题]]');
    });
});

describe('getHotNewsSlot', () => {
    it('按指定时区分时段：同一时刻在不同时区落在不同段', () => {
        // 2026-08-02T23:30Z = 上海 8/3 07:30（清晨，slot 1）、纽约 8/2 19:30（傍晚，slot 4）
        const at = new Date('2026-08-02T23:30:00Z');
        expect(getHotNewsSlot({ tz: 'Asia/Shanghai', now: at })).toMatchObject({
            id: '2026-08-03#1', date: '2026-08-03', slot: 1, label: '清晨',
        });
        expect(getHotNewsSlot({ tz: 'America/New_York', now: at })).toMatchObject({
            id: '2026-08-02#4', slot: 4, label: '傍晚',
        });
    });
});

describe('平台清单', () => {
    it('留空用内置默认，配了就用配的', () => {
        expect(resolveHotNewsPlatforms()).toEqual(DEFAULT_HOTNEWS_PLATFORMS);
        expect(resolveHotNewsPlatforms([])).toEqual(DEFAULT_HOTNEWS_PLATFORMS);
        expect(resolveHotNewsPlatforms(['weibo'])).toEqual(['weibo']);
    });

    it('比对与顺序无关（快照能不能复用看它）', () => {
        expect(sameHotNewsPlatforms(['a', 'b'], ['b', 'a'])).toBe(true);
        expect(sameHotNewsPlatforms(['a'], ['a', 'b'])).toBe(false);
    });
});

describe('pickRandomNews', () => {
    it('抽的条数不超过池子，且都来自池子', () => {
        const pool = Array.from({ length: 3 }, (_, i) => ({ title: `t${i}` }));
        const picks = pickRandomNews(pool, 5);
        expect(picks).toHaveLength(3);
        expect(pickRandomNews(pool, 2)).toHaveLength(2);
        for (const p of picks) expect(pool).toContainEqual(p);
        // 原池子不能被打乱（调用方还拿着它做别的事）
        expect(pool.map(p => p.title)).toEqual(['t0', 't1', 't2']);
    });
});

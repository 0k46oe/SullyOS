/**
 * 记忆宫殿 × 酒馆剧情时间的接入点。
 *
 * 记忆宫殿内部（createdAt、排序、衰减、置顶期限、事件盒）一律保持真实时间；
 * 只有发给模型看的日期文本，在酒馆角色开启剧情时间时换成剧情日期。
 * 普通角色这里全部返回 null / 原格式，行为与改动前完全一致。
 */
import { DB } from '../db';
import { getLocalDateKey } from '../localDate';
import { formatMemoryDateWithDistance } from './memoryDate';
import { formatStoryDate, formatStoryMemoryDate, getActiveTavernStoryTime, type ActiveStoryTime } from '../tavernStoryTime';

/** 按角色 ID 读取生效中的剧情时间；读不到角色（剧情演绎线程等）或普通角色返回 null */
export async function loadStoryTimeForChar(charId: string): Promise<ActiveStoryTime | null> {
    try {
        return getActiveTavernStoryTime(await DB.getCharacter(charId));
    } catch {
        return null;
    }
}

/** 召回注入里的记忆日期：普通角色「2026年11月1日（距今约0天）」，酒馆角色换成剧情日期 */
export function memoryDateLabel(story: ActiveStoryTime | null, createdAt: number, now: number = Date.now()): string {
    return story ? formatStoryMemoryDate(story, createdAt, now) : formatMemoryDateWithDistance(createdAt, now);
}

/** 写进记忆正文的短日期（纠正记录等）：普通角色 YYYY-MM-DD，酒馆角色剧情日期 */
export function memoryShortDate(story: ActiveStoryTime | null, ts: number = Date.now()): string {
    return story ? formatStoryDate(story, ts) : getLocalDateKey(new Date(ts));
}

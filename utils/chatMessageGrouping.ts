import type { Message } from '../types';
import { getCalendarDayDifference, getLocalDateKey } from './localDate';

export const CHAT_TIME_SEGMENT_GAP_MS = 5 * 60 * 1000;

export function startsNewMessageGroup(previous: Pick<Message, 'role' | 'timestamp'> | null, current: Pick<Message, 'role' | 'timestamp'>): boolean {
    // 只要角色不同，或者超过2分钟，就是新的一组
    return !previous || previous.role !== current.role || Math.abs(current.timestamp - previous.timestamp) >= 2 * 60 * 1000;
}

export function startsNewTimeSegment(previous: Pick<Message, 'timestamp'> | null, current: Pick<Message, 'timestamp'>): boolean {
    return !previous || Math.abs(current.timestamp - previous.timestamp) >= CHAT_TIME_SEGMENT_GAP_MS;
}

/** 线上动描角色的顶部时间条按 AI / 用户发言组切换，而不是按时间间隔切换。 */
export function startsNewRoleSegment(previous: Pick<Message, 'role'> | null, current: Pick<Message, 'role'>): boolean {
    return !previous || previous.role !== current.role;
}

export function computeTimeSegmentStarts(
    messages: ReadonlyArray<Pick<Message, 'role' | 'timestamp'>>,
    splitByRole = false,
): boolean[] {
    const starts: boolean[] = new Array(messages.length).fill(false);
    let lastNonSystem: Pick<Message, 'role' | 'timestamp'> | null = null;
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.role === 'system') continue;
        starts[i] = splitByRole
            ? startsNewRoleSegment(lastNonSystem, message)
            : startsNewTimeSegment(lastNonSystem, message);
        lastNonSystem = message;
    }
    return starts;
}

export function formatChatTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function formatChatTimeDivider(timestamp: number, now: Date = new Date()): string {
    const date = new Date(timestamp);
    const time = formatChatTimestamp(timestamp);
    const messageDay = getLocalDateKey(date);
    const nowDay = getLocalDateKey(now);
    if (messageDay === nowDay) return time;
    if (getCalendarDayDifference(messageDay, nowDay) === 1) return `昨天 ${time}`;
    const monthDay = `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
    return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}年${monthDay}`;
}

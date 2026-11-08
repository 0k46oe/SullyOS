import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { formatChatElapsed, meetingHistoryByNextChat } from './chatMeetingHistory';

const row = (id: number, minute: number, source?: string): Message => ({ id, charId: 'c', role: id % 2 ? 'user' : 'assistant', type: 'text', content: String(id), timestamp: minute * 60000, metadata: source ? { source } : {} });
describe('chat meeting display', () => {
    it('groups meeting messages between online conversations without duplicating them', () => {
        const groups = meetingHistoryByNextChat([row(1, 10), row(2, 20, 'date'), row(3, 50, 'date'), row(4, 70), row(5, 90, 'date'), row(6, 120)]);
        expect(groups.get(4)?.map(m => m.id)).toEqual([2, 3]);
        expect(groups.get(6)?.map(m => m.id)).toEqual([5]);
        expect(groups.has(null)).toBe(false);
    });
    it('formats half-hour and multi-day intervals', () => {
        expect(formatChatElapsed(30 * 60000)).toBe('30 分钟');
        expect(formatChatElapsed(25 * 3600000)).toBe('1 天 1 小时');
    });
});

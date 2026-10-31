// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_ACTION_ORDER_CHANGED, CHAT_ACTION_ORDER_KEY, loadChatActionOrder, moveChatAction, normalizeChatActionOrder, saveChatActionOrder } from './chatActionOrder';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('chat tool ordering', () => {
    it('preserves positions, removes invalid/duplicate tools and appends new ones', () => {
        expect(normalizeChatActionOrder(['b', 'retired', 'b', 4, 'a'], ['a', 'b', 'search'])).toEqual(['b', 'a', 'search']);
        expect(normalizeChatActionOrder({}, ['a', 'b'])).toEqual(['a', 'b']);
    });
    it('moves tools across pages without holes or duplication', () => {
        const order = Array.from({ length: 22 }, (_, i) => `tool-${i}`);
        const moved = moveChatAction(order, 'tool-21', 'tool-0');
        expect(moved[0]).toBe('tool-21');
        expect(new Set(moved).size).toBe(22);
        expect(moveChatAction(moved, 'tool-21', 'tool-20')).toEqual(order);
        expect(order[0]).toBe('tool-0');
    });
    it('persists to the device and broadcasts to other mounted private chats', () => {
        const listener = vi.fn();
        window.addEventListener(CHAT_ACTION_ORDER_CHANGED, listener);
        try {
            expect(saveChatActionOrder(['search', 'json'])).toBe(true);
            expect(loadChatActionOrder()).toEqual(['search', 'json']);
            expect(listener.mock.calls[0][0].detail).toEqual(['search', 'json']);
            localStorage.setItem(CHAT_ACTION_ORDER_KEY, 'broken');
            expect(loadChatActionOrder()).toEqual([]);
        } finally { window.removeEventListener(CHAT_ACTION_ORDER_CHANGED, listener); }
    });
    it('reports storage failures but still broadcasts the session order', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
        expect(saveChatActionOrder(['search'])).toBe(false);
    });
});

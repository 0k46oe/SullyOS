import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../types';
import MessageItem from '../components/chat/MessageItem';

const now = Date.now();
const msg: Message = { id: 1, charId: 'c', role: 'assistant', type: 'text', content: '你好', timestamp: now } as Message;
const story = { yearLabel: '庚辰年', baseRealYear: new Date(now).getFullYear() };
const render = (extra: Record<string, unknown>) => renderToStaticMarkup(React.createElement(MessageItem, {
    msg, isFirstInGroup: true, isLastInGroup: true, activeTheme: { id: 't', name: 't', user: {}, ai: {} } as any,
    charAvatar: '', charName: '角色', userAvatar: '', onLongPress: vi.fn(), onReply: vi.fn(),
    selectionMode: false, isSelected: false, onToggleSelect: vi.fn(), ...extra,
} as any));

describe('酒馆角色聊天时间戳', () => {
    it('默认显示剧情年份，今天的消息也带年份，可以点', () => {
        const html = render({ storyTime: story, onToggleTimeMode: vi.fn() });
        expect(html).toMatch(/庚辰年\d+月\d+日 \d{2}:\d{2}/);
        expect(html).toContain('<button');
        expect(html).toContain('点一下切到现实时间');
    });

    it('切到现实时间后不再出现剧情年份', () => {
        const html = render({ storyTime: story, showRealTime: true, onToggleTimeMode: vi.fn() });
        expect(html).not.toContain('庚辰年');
        expect(html).toContain('点一下切回剧情时间');
    });

    it('普通角色时间戳不变，也不能点', () => {
        const html = render({});
        expect(html).not.toContain('<button');
        expect(html).not.toContain('庚辰年');
    });
});

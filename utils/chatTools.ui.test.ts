// @vitest-environment jsdom
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChatRecordSearch from '../components/chat/ChatRecordSearch';
import ChatActionOrderEditor from '../components/chat/ChatActionOrderEditor';
import { DB } from './db';
import { handleLocalBack } from './localBackHandlers';
import type { Message } from '../types';

let host: HTMLDivElement, root: Root;
const click = async (node: HTMLElement) => { await act(async () => { node.click(); }); };
const button = (label: string) => host.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!;
const byText = (text: string) => [...host.querySelectorAll('button')].find(node => node.textContent === text)!;
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };
const input = async (node: HTMLInputElement, value: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); });
};
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('local tools must not fetch'); }));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('chat search and calendar UI', () => {
    const onJump = vi.fn(), onClose = vi.fn();
    const rows: Message[] = [
        { id: 1, charId: 'search-ui', role: 'user', type: 'text', content: '去年苹果', timestamp: new Date(2025, 8, 18, 10).getTime() },
        { id: 2, charId: 'search-ui', role: 'assistant', type: 'text', content: '今天苹果', timestamp: new Date(2026, 9, 31, 10).getTime() },
        { id: 3, charId: 'search-ui', role: 'user', type: 'text', content: '今天香蕉', timestamp: new Date(2026, 9, 31, 11).getTime() },
        { id: 4, charId: 'search-ui', role: 'assistant', type: 'text', content: '见面苹果不展示', timestamp: new Date(2026, 9, 30).getTime(), metadata: { source: 'date' } },
    ];
    const mount = async (messages = rows) => {
        vi.spyOn(DB, 'getMessagesByCharId').mockResolvedValue(messages);
        await act(async () => { root.render(React.createElement(ChatRecordSearch, { charId: 'search-ui', characterName: '角色', userName: '玩家', onClose, onJump })); });
        await flush();
    };

    it('filters body text and sender, highlights hits and only passes an ID to navigation', async () => {
        await mount();
        expect(DB.getMessagesByCharId).toHaveBeenCalledWith('search-ui', true);
        expect(host.textContent).toContain('共 3 条');
        await input(host.querySelector('input')!, '苹果'); await flush();
        expect(host.querySelectorAll('mark')).toHaveLength(2);
        await click(byText('角色')); await flush();
        expect(host.textContent).toContain('共 1 条');
        await click(host.querySelector<HTMLElement>('[aria-label^="查看原消息"]')!);
        expect(onJump).toHaveBeenLastCalledWith(2);
        expect(fetch).not.toHaveBeenCalled();
        expect(rows[0].content).toBe('去年苹果');
    });

    it('marks active dates, disables empty dates and supports direct year/month selection', async () => {
        await mount();
        await click(byText('按日期'));
        expect(button('2026-10-30，无聊天记录').getAttribute('disabled')).not.toBeNull();
        expect(button('2026-10-31，2 条聊天记录').getAttribute('disabled')).toBeNull();
        await click(button('2026-10-31，2 条聊天记录')); await flush();
        expect(host.textContent).toContain('共 2 条 · 按当天时间顺序');
        expect(host.querySelector('[aria-label="聊天日期日历"]')).toBeNull();
        await click(button('清除日期筛选')); await click(byText('按日期'));
        for (const [label, value] of [['聊天年份', '2025'], ['聊天月份', '9']]) {
            await act(async () => { const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });
        }
        expect(button('2025-09-18，1 条聊天记录')).toBeTruthy();
        await click(button('2025-09-18，1 条聊天记录')); await flush();
        expect(host.textContent).toContain('去年苹果');
        expect(host.textContent).not.toContain('今天苹果');
    });

    it('paginates every match beyond 200 and exposes a later page', async () => {
        await mount(Array.from({ length: 241 }, (_, i) => ({ ...rows[0], id: i + 1, content: `苹果 ${i + 1}`, timestamp: rows[0].timestamp + i })));
        expect(host.textContent).toContain('共 241 条');
        expect(host.querySelectorAll('[aria-label^="查看原消息"]')).toHaveLength(40);
        await click(byText('下一页')); await flush();
        expect(host.querySelector('[aria-label="聊天结果分页"]')?.textContent).toContain('2 / 7');
        expect(host.querySelector('[aria-label^="查看原消息"]')?.textContent).toContain('苹果 201');
    });

    it('recovers from read errors; local back first leaves input and then closes search', async () => {
        const read = vi.spyOn(DB, 'getMessagesByCharId').mockRejectedValueOnce(new Error('read failed')).mockResolvedValue(rows);
        await act(async () => { root.render(React.createElement(ChatRecordSearch, { charId: 'search-ui', characterName: '角色', userName: '玩家', onClose, onJump })); });
        await flush();
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('读取失败');
        await click(byText('重试')); await flush();
        expect(read).toHaveBeenCalledTimes(2);
        expect(host.textContent).toContain('共 3 条');
        const search = host.querySelector('input')!;
        act(() => search.focus());
        act(() => { expect(handleLocalBack()).toBe(true); });
        expect(document.activeElement).not.toBe(search);
        const before = onClose.mock.calls.length;
        act(() => { handleLocalBack(); });
        expect(onClose).toHaveBeenCalledTimes(before + 1);
    });

    it('does not apply a late result after switching to another character', async () => {
        let release: (value: Message[]) => void = () => {};
        vi.spyOn(DB, 'getMessagesByCharId').mockImplementation(charId => charId === 'slow'
            ? new Promise(resolve => { release = resolve; }) : Promise.resolve([{ ...rows[0], charId: 'next', content: '新的角色记录' }]));
        const props = { characterName: '角色', userName: '玩家', onClose, onJump };
        await act(async () => { root.render(React.createElement(ChatRecordSearch, { ...props, key: 'slow', charId: 'slow' })); });
        await act(async () => { root.render(React.createElement(ChatRecordSearch, { ...props, key: 'next', charId: 'next' })); });
        await flush();
        await act(async () => { release([{ ...rows[0], charId: 'slow', content: '旧角色记录不得回流' }]); });
        await flush();
        expect(host.textContent).toContain('新的角色记录');
        expect(host.textContent).not.toContain('旧角色记录不得回流');
    });
});

describe('tool organizer UI', () => {
    it('reorders via keyboard and pointer across pages; saving and abandoning are separate', async () => {
        const items = Array.from({ length: 12 }, (_, i) => ({ id: `tool-${i}`, label: `工具${i}`, content: React.createElement('span', {}, `工具${i}`) }));
        const save = vi.fn(), close = vi.fn();
        await act(async () => { root.render(React.createElement(ChatActionOrderEditor, { items, initialOrder: [], onSave: save, onClose: close })); });
        const moving = button('移动工具11');
        await act(async () => { moving.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
        expect(host.querySelectorAll('[data-tool-id]')[7].getAttribute('data-tool-id')).toBe('tool-11');
        // Pointer capture stays on the handle; hit testing identifies a tile on another page.
        Object.defineProperty(moving, 'setPointerCapture', { value: vi.fn() });
        Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => host.querySelector('[data-tool-id="tool-0"]') });
        const pointer = (type: string) => {
            const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 20, clientY: 90 });
            Object.defineProperty(event, 'pointerId', { value: 1 }); moving.dispatchEvent(event);
        };
        await act(async () => { pointer('pointerdown'); pointer('pointermove'); pointer('pointerup'); });
        expect(host.querySelector('[data-tool-id]')?.getAttribute('data-tool-id')).toBe('tool-11');
        expect(save).not.toHaveBeenCalled();
        await click(byText('完成'));
        expect(save.mock.calls[0][0][0]).toBe('tool-11');
        await click(byText('恢复默认')); await click(byText('完成'));
        expect(save.mock.calls[1][0]).toEqual(items.map(item => item.id));
        await click(button('关闭整理工具'));
        expect(close).toHaveBeenCalledOnce();
        expect(save).toHaveBeenCalledTimes(2);
    });
});

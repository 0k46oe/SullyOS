import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { buildChatSearchRecords, chatSearchDates, chatSearchSnippet, filterChatSearchRecords } from './chatRecordSearch';
import { getLocalDateKey } from './localDate';

const message = (id: number, patch: Partial<Message> = {}): Message => ({ id, charId: 'one', role: 'assistant', type: 'text', content: `记录 ${id}`, timestamp: new Date(2026, 9, 30, 23, 59).getTime() + id * 1000, ...patch });

describe('independent local chat search', () => {
    it('reads archived visible private history without exposing other sources, hidden notes or reasoning', async () => {
        const rows = [message(1, { role: 'user', content: '保留原文' }), message(2, { content: '<think>secret</think>ＡＢＣ 苹果', metadata: { thinkingChain: 'private' } }),
            ...['date', 'call', 'home', 'story_theater_memory'].map((source, i) => message(3 + i, { metadata: { source } })),
            message(9, { type: 'secret_note' }), message(10, { groupId: 'group' }), message(11, { role: 'system' }), message(12, { charId: 'other' })];
        const records = await buildChatSearchRecords(rows, 'one', new AbortController().signal);
        expect(records.map(row => row.id)).toEqual([2, 1]);
        expect(JSON.stringify(records)).not.toMatch(/secret|private/);
        expect(filterChatSearchRecords(records, 'abc', 'assistant', '').map(row => row.id)).toEqual([2]);
        expect(filterChatSearchRecords(records, '原文', 'user', '').map(row => row.id)).toEqual([1]);
        expect(rows[1].content).toContain('<think>');
    });

    it('uses device calendar days across midnight and sorts a chosen day chronologically', async () => {
        const rows = [message(1), message(2), message(70)];
        const records = await buildChatSearchRecords(rows, 'one', new AbortController().signal);
        const dates = chatSearchDates(records);
        expect([...dates.values()].sort()).toEqual([1, 2]);
        expect(filterChatSearchRecords(records, '', 'all', getLocalDateKey(new Date(rows[0].timestamp))).map(row => row.id)).toEqual([1, 2]);
    });

    it('does not truncate matches at 200; supports cancellation between batches', async () => {
        const rows = Array.from({ length: 700 }, (_, i) => message(i + 1, { content: '苹果' }));
        const records = await buildChatSearchRecords(rows, 'one', new AbortController().signal);
        expect(filterChatSearchRecords(records, '苹果', 'all', '')).toHaveLength(700);
        const abort = new AbortController();
        const pending = buildChatSearchRecords(rows, 'one', abort.signal);
        abort.abort();
        expect(await pending).toEqual([]);
    });

    it('shows media placeholders and filenames instead of URLs or file scripts', async () => {
        const records = await buildChatSearchRecords([message(1, { type: 'image', content: 'data:image/png;base64,secret' }), message(2, { type: 'collaboration_file', content: 'script-secret', metadata: { fileName: '预设.json' } })], 'one', new AbortController().signal);
        expect(records.map(row => row.text)).toEqual(['[文件] 预设.json', '[图片]']);
        expect(JSON.stringify(records)).not.toContain('secret');
    });

    it('highlights original width/case and finds hits well beyond the initial preview', () => {
        const text = '前'.repeat(300) + 'ＡＢＣ\n  苹果' + '后'.repeat(300);
        const snippet = chatSearchSnippet(text, 'abc 苹果');
        expect(snippet.match).toBe('ＡＢＣ\n  苹果');
        expect(snippet.before).toHaveLength(43);
        expect(snippet.after).toHaveLength(101);
        expect(chatSearchSnippet('🫶ＡBC', 'abc').match).toBe('ＡBC');
    });
});

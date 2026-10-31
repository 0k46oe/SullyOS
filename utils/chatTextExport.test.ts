import { expect, it } from 'vitest';
import type { Message } from '../types';
import { formatChatTextExport } from './chatTextExport';

const message = (id: number, patch: Partial<Message> = {}): Message => ({
    id, charId: 'char', role: 'user', type: 'text', content: '用户正文', timestamp: id * 1000, ...patch,
});

it('retains the upstream timestamped TXT format, ordering, archived dialogue and media placeholders', () => {
    const records = [message(3, { type: 'image', content: 'data:image/png;base64,secret' }),
        message(2, { role: 'assistant', content: '回复正文' }), message(1), message(4, { role: 'system', content: '系统记录' })];
    const result = formatChatTextExport(records);
    expect(result.startsWith('\uFEFF[')).toBe(true);
    expect(result.indexOf('User: 用户正文')).toBeLessThan(result.indexOf('AI: 回复正文'));
    expect(result).toContain('User: [图片]');
    expect(result).not.toContain('base64');
    expect(result).not.toContain('系统记录');
    expect(records[0].id).toBe(3);
});

it('exports dialogue in both modes and adds saved and inline thinking only when selected', () => {
    const records = [message(1, { content: '<think>用户字面量</think>用户正文' }), message(2, {
        role: 'assistant', content: '<think>内联思考</think>回复正文', metadata: { thinkingChain: '保存的思考' },
    }), message(3, { role: 'assistant', content: '第二条回复<thinking>未闭合思考' }),
    message(4, { role: 'assistant', type: 'image', content: 'data:image/png;base64,secret', metadata: { thinkingChain: '图片回复附带的思考' } })];
    const original = JSON.stringify(records);
    const plain = formatChatTextExport(records);
    const withThought = formatChatTextExport(records, { includeThinking: true });
    for (const result of [plain, withThought]) {
        expect(result).toContain('User: <think>用户字面量</think>用户正文');
        expect(result).toContain('回复正文');
        expect(result).toContain('第二条回复');
    }
    for (const thought of ['内联思考', '保存的思考', '未闭合思考', '图片回复附带的思考']) {
        expect(plain).not.toContain(thought);
        expect(withThought).toContain(thought);
    }
    expect(withThought).toContain('【思考内容】');
    expect(JSON.stringify(records)).toBe(original);
});

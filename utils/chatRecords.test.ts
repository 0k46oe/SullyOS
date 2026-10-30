import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { buildChatExport, chatExportFileName, chatExportToText, getChatWordInputs } from './chatRecords';
import { countChatWords } from './chatWordFrequency';

const message = (id: number, patch: Partial<Message> = {}): Message => ({
    id, charId: 'char', role: 'user', type: 'text', content: '你好', timestamp: id, ...patch,
});
const char = { id: 'char', name: '人物' };

describe('complete private chat export', () => {
    it('keeps all persisted turns, card payloads, quotes and original timestamps without mutating them', () => {
        const messages = [message(3, { role: 'assistant', type: 'collaboration_file', metadata: { extractedText: '{"script":"source"}' } }),
            message(1), message(2, { role: 'assistant', metadata: { thinkingChain: '已保存的思考' },
                replyTo: { id: 1, name: '玩家', content: '引用原文' } }),
            message(4, { charId: 'other' }), message(5, { groupId: 'group' }), message(6, { role: 'system' })];
        const original = JSON.stringify(messages);
        const exported = buildChatExport(messages, char, '玩家', true);
        expect(exported.messages.map(m => m.id)).toEqual([1, 2, 3]);
        expect(exported.messages[1].metadata.thinkingChain).toBe('已保存的思考');
        expect(exported.messages[1].replyTo?.content).toBe('引用原文');
        expect(exported.messages[1].timestamp).toBe(2);
        expect(chatExportToText(exported)).toContain('已保存的思考');
        expect(chatExportToText(exported)).toContain('extractedText');
        expect(chatExportToText(exported)).toContain('source');
        expect(JSON.stringify(messages)).toBe(original);
    });

    it('excludes saved reasoning, legacy inline thoughts and nested raw responses when disabled', () => {
        const data = buildChatExport([message(1, { role: 'assistant', content: '<think>绝密思考</think>正文<thought>未闭合思考',
            metadata: { thinkingChain: '保存思考', nested: { reasoning_content: '深层思考' }, rawResponse: { message: '原始思考' }, source: 'chat' },
            replyTo: { id: 0, name: '人物', content: '<thinking>引用思考</thinking>引用正文' } })], char, '玩家', false);
        const json = JSON.stringify(data);
        for (const secret of ['绝密思考', '未闭合思考', '保存思考', '深层思考', '原始思考', '引用思考', 'thinkingChain', 'reasoning_content']) {
            expect(json).not.toContain(secret);
            expect(chatExportToText(data)).not.toContain(secret);
        }
        expect(data.messages[0].content).toBe('正文');
        expect(data.messages[0].metadata.source).toBe('chat');
        expect(data.messages[0].replyTo?.content).toBe('引用正文');
    });

    it('preserves stored voice transcripts and creates safe file names', () => {
        const data = buildChatExport([message(1, { type: 'voice', content: 'blob:audio', metadata: { transcript: '完整语音文字' } })], char, '玩家', false);
        expect(chatExportToText(data)).toContain('完整语音文字');
        expect(chatExportFileName('测试/角色:一', 'json')).toBe('测试_角色_一_聊天记录.json');
    });
    it('does not strip literal thought tags from attachment scripts or user-provided source text', () => {
        const script = '{"script":"<think>literal source</think>"}';
        const data = buildChatExport([message(1, { content: '<think>用户原文</think>' }),
            message(2, { role: 'assistant', type: 'collaboration_file', metadata: { extractedText: script } })], char, '玩家', false);
        expect(data.messages[0].content).toBe('<think>用户原文</think>');
        expect(data.messages[1].metadata.extractedText).toBe(script);
    });
});

describe('local chat frequency', () => {
    it('keeps roles apart and excludes scripts, reasoning, cards, duplicates and media', () => {
        const inputs = getChatWordInputs([
            message(1, { content: '苹果 苹果%%BILINGUAL%%apple apple' }),
            message(2, { role: 'assistant', content: '<think>隐藏词</think>香蕉 香蕉 [[SEND_EMOJI:noise]] https://example.com/noise' }),
            message(3, { type: 'voice', metadata: { transcript: '苹果' }, content: 'blob:abc' }),
            message(4, { type: 'collaboration_file', content: '脚本', metadata: { extractedText: '脚本' } }),
            message(5, { type: 'html_card', content: '卡片噪声' }), message(6, { role: 'system', content: '系统噪声' }),
            message(7, { type: 'image', content: 'data:image/png;base64,abc' }),
            message(8, { charId: 'other', content: '别人的正文' }),
        ], char.id);
        const result = countChatWords(inputs, { hideStopWords: true, includeSingleCharacter: false });
        expect(result.method).toBe('words');
        expect(result.user.words).toEqual([{ word: '苹果', count: 3 }]);
        expect(result.assistant.words).toEqual([{ word: '香蕉', count: 2 }]);
        expect(result.user.messages).toBe(2);
        expect(result.assistant.messages).toBe(1);
    });

    it('supports stop-word and single-character choices and normalizes English case', () => {
        const input = [{ role: 'user' as const, text: '我 我 you YOU Love LOVE 猫 猫' }];
        const filtered = countChatWords(input, { hideStopWords: true, includeSingleCharacter: false });
        expect(filtered.user.words).toEqual([{ word: 'love', count: 2 }]);
        const all = countChatWords(input, { hideStopWords: false, includeSingleCharacter: true });
        expect(all.user.words).toEqual(expect.arrayContaining([{ word: '我', count: 2 }, { word: 'you', count: 2 }, { word: '猫', count: 2 }]));
    });

    it('uses an explicit adjacent-pair fallback without Intl.Segmenter', () => {
        // A null constructor exercises the older-browser path without touching global Intl.
        const result = countChatWords([{ role: 'assistant', text: '苹果香蕉 苹果' }],
            { hideStopWords: true, includeSingleCharacter: false }, null as never);
        expect(result.method).toBe('pairs');
        expect(result.assistant.words[0]).toEqual({ word: '苹果', count: 2 });
        expect(result.assistant.words).toContainEqual({ word: '香蕉', count: 1 });
    });

    it('returns only the top 30 and does not modify its input', () => {
        const input = [{ role: 'user' as const, text: Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') }];
        const snapshot = JSON.stringify(input);
        expect(countChatWords(input, { hideStopWords: false, includeSingleCharacter: false }).user.words).toHaveLength(30);
        expect(JSON.stringify(input)).toBe(snapshot);
    });
});

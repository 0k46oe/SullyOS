import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { getChatWordInputs } from './chatWordInputs';
import { countChatWords } from './chatWordFrequency';

const message = (id: number, patch: Partial<Message> = {}): Message => ({
    id, charId: 'char', role: 'user', type: 'text', content: '你好', timestamp: id, ...patch,
});
const char = { id: 'char', name: '人物' };

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

import { describe, expect, it } from 'vitest';
import { countChatWords } from './chatWordFrequency';

describe('meaningful local word frequency', () => {
    it.each([true, false])('filters conversational filler with native segmentation = %s', native => {
        const input = [{ role: 'user' as const, text: '这是 那是 那么 这么 于是 其实 好的 苹果 苹果 星空' }];
        const options = { hideStopWords: true, includeSingleCharacter: false };
        const result = native ? countChatWords(input, options) : countChatWords(input, options, null as never);
        expect(result.user.words).toEqual(expect.arrayContaining([{ word: '苹果', count: 2 }, { word: '星空', count: 1 }]));
        expect(result.user.words.some(({ word }) => ['这是', '那是', '那么', '这么', '于是', '其实', '好的'].includes(word))).toBe(false);
        expect(result.assistant.words).toEqual([]);
    });
    it('keeps the user choice to include filler words', () => {
        const result = countChatWords([{ role: 'assistant', text: '那么 那么 苹果' }],
            { hideStopWords: false, includeSingleCharacter: false }, null as never);
        expect(result.assistant.words).toContainEqual({ word: '那么', count: 2 });
    });
});

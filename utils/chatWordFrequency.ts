export interface WordFrequencyInput { role: 'user' | 'assistant'; text: string }
export interface WordFrequencyOptions { hideStopWords: boolean; includeSingleCharacter: boolean }
export interface WordCount { word: string; count: number }
export interface WordFrequencyResult {
    method: 'words' | 'pairs';
    user: { messages: number; total: number; words: WordCount[] };
    assistant: { messages: number; total: number; words: WordCount[] };
}

const STOP_WORDS = new Set(('的 了 着 过 我 你 您 他 她 它 我们 你们 他们 她们 它们 自己 这个 那个 这些 那些 这 那 是 在 和 与 或 也 都 就 才 又 很 更 最 还 有 没有 一个 一些 什么 怎么 为什么 但是 不过 然后 因为 所以 如果 还是 不是 可以 可能 这样 那样 已经 一下 一点 现在 时候 觉得 知道 真的 其实 一直 一起 呢 吗 啊 吧 哦 嗯 ' +
    'a an the and or but if then so to of in on at for with from as by is am are was were be been being i me my mine we us our you your he him his she her it its they them their this that these those do does did not no yes have has had will would can could should may might just very').split(/\s+/));

type WordSegment = { segment: string; isWordLike?: boolean };
type SegmenterConstructor = new (locale: string, options: { granularity: 'word' }) => { segment(text: string): Iterable<WordSegment> };

/** Native ICU segmentation is entirely local; older engines fall back to Chinese two-character phrases. */
export function countChatWords(inputs: readonly WordFrequencyInput[], options: WordFrequencyOptions,
    Segmenter: SegmenterConstructor | undefined = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter): WordFrequencyResult {
    const segmenter = Segmenter ? new Segmenter('zh', { granularity: 'word' }) : undefined;
    const counts = { user: new Map<string, number>(), assistant: new Map<string, number>() };
    const totals = { user: 0, assistant: 0 };
    const messages = { user: 0, assistant: 0 };
    const add = (role: WordFrequencyInput['role'], raw: string) => {
        const word = raw.normalize('NFKC').toLowerCase().trim();
        if (!/\p{L}/u.test(word) || (!options.includeSingleCharacter && Array.from(word).length < 2)
            || (options.hideStopWords && STOP_WORDS.has(word))) return;
        counts[role].set(word, (counts[role].get(word) || 0) + 1);
        totals[role]++;
    };
    for (const { role, text } of inputs) {
        messages[role]++;
        if (segmenter) {
            for (const item of segmenter.segment(text.normalize('NFKC'))) if (item.isWordLike) add(role, item.segment);
        } else {
            for (const match of text.normalize('NFKC').matchAll(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu)) {
                const token = match[0];
                if (/^\p{Script=Han}+$/u.test(token)) {
                    const chars = Array.from(token);
                    for (let i = 0; i + 1 < chars.length; i++) add(role, chars[i] + chars[i + 1]);
                    if (options.includeSingleCharacter) for (const char of chars) add(role, char);
                } else add(role, token);
            }
        }
    }
    const result = (role: WordFrequencyInput['role']) => ({
        messages: messages[role], total: totals[role],
        words: [...counts[role]].map(([word, count]) => ({ word, count }))
            .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, 'zh')).slice(0, 30),
    });
    return { method: segmenter ? 'words' : 'pairs', user: result('user'), assistant: result('assistant') };
}

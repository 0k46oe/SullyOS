import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types';
import type { MemoryNode } from './types';
import { extractMemoriesFromBuffer } from './extraction';
import { expandAndFormat } from './formatter';
import { MemoryNodeDB } from './db';
import { safeFetchJson } from '../safeApi';
import { getActiveTavernStoryTime } from '../tavernStoryTime';

vi.mock('../safeApi', () => ({ safeFetchJson: vi.fn() }));
const fetchJson = vi.mocked(safeFetchJson);

const HOUR = 60 * 60 * 1000;
const T0 = new Date(2026, 10, 1, 14, 20).getTime();
const tavern = { firstMessage: '', alternateGreetings: [], creatorNotes: '', creator: '', characterVersion: '', tags: [] };
const story = getActiveTavernStoryTime({
    tavernImport: tavern,
    tavernStoryTime: { enabled: true, yearLabel: '3777年', baseRealYear: 2026 },
})!;
const config = { baseUrl: 'https://memory.test/v1', apiKey: 'test', model: 'test' };
// 第一条在剧情 11月1日，第二条在现实 12 小时后 = 剧情 11月2日 02:20
const messages: Message[] = [0, 12].map((offset, index) => ({
    id: index + 1, charId: 'story-char', role: 'user', type: 'text', content: `第${index + 1}条`,
    timestamp: T0 + offset * HOUR,
}));

function reply(date: string) {
    return { choices: [{ message: { content: JSON.stringify([{ content: '一起看了星港的烟火。', room: 'bedroom', date }]) } }] } as any;
}
function sentPrompt(): string {
    const body = JSON.parse(String((fetchJson.mock.calls[0][1] as RequestInit).body));
    return `${body.messages[0].content}\n${body.messages[1].content}`;
}

beforeEach(() => { localStorage.clear(); fetchJson.mockReset(); });

describe('酒馆角色提取：副 API 看不到现实日期', () => {
    it('消息行首是剧情日编号 + 剧情时间，提示词要求填 D 编号', async () => {
        fetchJson.mockResolvedValue(reply('D2'));
        const { memories } = await extractMemoriesFromBuffer(messages, 'story-char', '角色', config, undefined, undefined, [], [], story);
        const prompt = sentPrompt();
        expect(prompt).toContain('[D1 · 3777年11月1日 14:20]');
        expect(prompt).toContain('[D2 · 3777年11月2日 02:20]');
        expect(prompt).not.toMatch(/2026/);
        expect(prompt).not.toContain('YYYY-MM-DD');
        // D2 映射回第二条消息的真实时间，createdAt 仍是现实时间戳
        expect(memories[0].createdAt).toBe(messages[1].timestamp);
    });

    it('副 API 填了非法编号时回到批次中点，不会丢记忆', async () => {
        fetchJson.mockResolvedValue(reply('3777-11-02'));
        const { memories } = await extractMemoriesFromBuffer(messages, 'story-char', '角色', config, undefined, undefined, [], [], story);
        expect(memories[0].createdAt).toBe(Math.round((messages[0].timestamp + messages[1].timestamp) / 2));
    });

    it('普通角色提示词保持现实日期格式', async () => {
        fetchJson.mockResolvedValue(reply('2026-11-01'));
        const { memories } = await extractMemoriesFromBuffer(messages, 'story-char', '角色', config);
        const prompt = sentPrompt();
        expect(prompt).toContain('[2026-11-01 14:20]');
        expect(prompt).not.toContain('D1');
        expect(memories[0].createdAt).toBe(new Date(2026, 10, 1, 12).getTime());
    });
});

describe('酒馆角色召回：只显示剧情日期', () => {
    const node: MemoryNode = {
        id: 'story-node', charId: 'story-format-char', content: '一起看了星港的烟火。', room: 'bedroom', tags: [],
        importance: 6, mood: 'happy', embedded: true, createdAt: T0, lastAccessedAt: T0, accessCount: 0,
    };

    it('剧情模式显示剧情日期，普通模式不变', async () => {
        await MemoryNodeDB.save(node);
        const results = [{ node, finalScore: 1 } as any];
        const storyText = await expandAndFormat(results, node.charId, [], '用户', 15, story);
        expect(storyText).toContain('3777年11月');
        expect(storyText).not.toMatch(/2026年/);
        const plainText = await expandAndFormat(results, node.charId, [], '用户');
        expect(plainText).toContain('2026年11月1日');
    });
});

import { describe, expect, it, vi } from 'vitest';
import type { CharacterProfile } from '../types';
import { DB } from './db';
import { buildStoryHistory, compileStoryPreset, createStoryTheaterDraft, normalizeStoryTheater, storyTheaterThreadId } from './storyTheater';
import { getStoryCardGreetings, saveStoryTheaterWithCardOpening } from './storyTheaterOpening';

const draft = () => ({
    ...createStoryTheaterDraft(), title: '雨夜', characterIds: ['rain'], openingMode: 'card' as const,
    cardOpening: { characterId: 'rain', characterName: '小雨', greetingIndex: 1, content: '{{char}}看向{{user}}：你好。' },
});
const messages = (id: string) => DB.getMessagesByCharId(storyTheaterThreadId(id), true);

describe('酒馆卡剧情开场白', () => {
    it('列出主/备选开场白，跳过空白但保留原始编号', () => {
        const actor = { id: 'rain', name: '小雨', tavernImport: { firstMessage: '主开场', alternateGreetings: ['', '备选二'] } } as CharacterProfile;
        expect(getStoryCardGreetings([actor]).map(item => [item.greetingIndex, item.content])).toEqual([[0, '主开场'], [2, '备选二']]);
        expect(getStoryCardGreetings([{ id: 'native', name: '原生角色' } as CharacterProfile])).toEqual([]);
    });

    it('保存后直接成为 assistant 第一楼，按当前面具替换宏，并在下一轮进入模型历史', async () => {
        const entry = draft();
        const saved = await saveStoryTheaterWithCardOpening(entry, '$&面具');
        const rows = await messages(entry.id);
        expect(saved.cardOpeningConsumed).toBe(true);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ role: 'assistant', content: '小雨看向$&面具：你好。', metadata: { source: 'story_theater', theaterCardOpening: true } });
        const compiled = compileStoryPreset({ historyMessages: buildStoryHistory(rows), slots: { actors: '', persona: '', scenario: '', worldBefore: '', worldAfter: '' }, userName: '$&面具', characterNames: ['小雨'] });
        expect(compiled.messages.some(message => message.role === 'assistant' && message.content.includes('小雨看向$&面具：你好。'))).toBe(true);
        expect((await DB.getStoryTheaters()).find(item => item.id === entry.id)?.cardOpening?.content).toBe(entry.cardOpening.content);
        expect((await DB.getMessagesByCharId('rain', true)).some(message => message.metadata?.theaterId === entry.id)).toBe(false);
    });

    it('并发保存、重进和过时草稿重试都只插入一次；删除首楼不自动复活', async () => {
        const entry = draft();
        const saved = await Promise.all([saveStoryTheaterWithCardOpening(entry, '面具'), saveStoryTheaterWithCardOpening(entry, '面具')]);
        expect(await messages(entry.id)).toHaveLength(1);
        await DB.deleteMessages((await messages(entry.id)).map(message => message.id));
        await saveStoryTheaterWithCardOpening(entry, '面具');
        await saveStoryTheaterWithCardOpening(saved[0], '面具');
        expect(await messages(entry.id)).toHaveLength(0);
    });

    it('已有正文或归档时不插入新的第一楼', async () => {
        const entry = draft();
        await DB.saveMessage({ charId: storyTheaterThreadId(entry.id), role: 'user', type: 'text', content: '已开始', metadata: { source: 'story_theater' } });
        await saveStoryTheaterWithCardOpening(entry, '你');
        expect((await messages(entry.id)).map(message => message.content)).toEqual(['已开始']);
        const archived = draft();
        archived.archives = [{ id: 'archive', strategy: 'summary', fromMessageId: 1, toMessageId: 2, messageCount: 2, createdAt: 1 }];
        await DB.saveStoryTheater(archived);
        await saveStoryTheaterWithCardOpening(archived, '你');
        expect(await messages(archived.id)).toEqual([]);
    });

    it('事务失败不留下孤立首楼或已消费回执，之后能够重试', async () => {
        const entry = draft();
        const originalPut = IDBObjectStore.prototype.put;
        const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
            if (this.name === 'story_theaters') {
                this.transaction.abort();
                return {} as IDBRequest;
            }
            return originalPut.apply(this, args);
        });
        try { await expect(saveStoryTheaterWithCardOpening(entry, '你')).rejects.toThrow(); }
        finally { spy.mockRestore(); }
        expect(await messages(entry.id)).toEqual([]);
        expect((await DB.getStoryTheaters()).find(item => item.id === entry.id)).toBeUndefined();
        await saveStoryTheaterWithCardOpening(entry, '你');
        expect(await messages(entry.id)).toHaveLength(1);
    });

    it('真实陪伴不能用卡片开场白；空白或不属于演员的开场白不能开场', async () => {
        const entry = draft();
        await expect(saveStoryTheaterWithCardOpening({ ...entry, writesToCharacterMemory: true }, '你')).rejects.toThrow('虚构剧场');
        await expect(saveStoryTheaterWithCardOpening({ ...entry, characterIds: [] }, '你')).rejects.toThrow('请选择');
        await expect(saveStoryTheaterWithCardOpening({ ...entry, cardOpening: { ...entry.cardOpening, content: ' ' } }, '你')).rejects.toThrow('请选择');
        expect(normalizeStoryTheater({ ...entry, writesToCharacterMemory: true }).openingMode).toBe('user');
        expect(await messages(entry.id)).toEqual([]);
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { DB } from './db';
import { describeRecentStickers } from './visionApi';

// 表情包画面描述存在表情包库里：一张只识别一次，手动改过的不被覆盖，换图后作废。
const config = { enabled: true, baseUrl: 'https://vision.test/v1', apiKey: 'k', model: 'v' };
const sticker = (id: number, role: string, url: string) => ({ id, charId: 'c', role, type: 'emoji', content: url, timestamp: id * 1000 }) as any;

describe('表情包画面描述', () => {
    beforeEach(async () => {
        for (const e of await DB.getEmojis()) await DB.deleteEmoji(e.name);
        await new Promise(r => setTimeout(r, 0));
    });

    it('只识别一次并存回表情包库，用户和角色发的共用', async () => {
        await DB.saveEmoji('狗', 'https://img.test/dog.png');
        const fetchMock = vi.fn(async () => Response.json({ choices: [{ message: { content: '一只柴犬' } }] }));
        vi.stubGlobal('fetch', fetchMock);
        const emojis = await describeRecentStickers([sticker(1, 'user', 'https://img.test/dog.png'), sticker(2, 'assistant', 'https://img.test/dog.png')], await DB.getEmojis(), config);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(emojis[0].visionDescription).toBe('一只柴犬');
        expect((await DB.getEmojis())[0].visionDescription).toBe('一只柴犬');
        // 已有描述不再识别
        await describeRecentStickers([sticker(3, 'user', 'https://img.test/dog.png')], await DB.getEmojis(), config);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });

    it('手动修改、清空，以及换图后描述作废', async () => {
        await DB.saveEmoji('猫', 'https://img.test/cat.png');
        await DB.setEmojiDescription('猫', '一只橘猫');
        // 改分类、同一张图：保留
        await DB.saveEmoji('猫', 'https://img.test/cat.png', 'cat-folder');
        expect((await DB.getEmojis())[0].visionDescription).toBe('一只橘猫');
        // 换了图：作废
        await DB.saveEmoji('猫', 'https://img.test/cat2.png');
        expect((await DB.getEmojis())[0].visionDescription).toBeUndefined();
        await DB.setEmojiDescription('猫', '黑猫');
        await DB.setEmojiDescription('猫', '  ');
        expect((await DB.getEmojis())[0]).not.toHaveProperty('visionDescription');
    });

    it('识别失败不阻断聊天，这张只给名字', async () => {
        await DB.saveEmoji('兔', 'https://img.test/rabbit.png');
        vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 500 })));
        const emojis = await describeRecentStickers([sticker(1, 'user', 'https://img.test/rabbit.png')], await DB.getEmojis(), config);
        expect(emojis[0].visionDescription).toBeUndefined();
        vi.unstubAllGlobals();
    });
});

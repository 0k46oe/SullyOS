import { describe, it, expect } from 'vitest';
import { stickerNameFromUrl } from './messageFormat';
import { ChatPrompts } from './chatPrompts';
import type { Emoji } from '../types';

// 锁住「表情包在上下文里看得见名字」的修复。
//
// 表情包消息的 content 只存图床 URL，本身不带名字。非识图模型看不到图，只能靠
// 反查表情名（关键字）才知道对方发了什么表情。私聊主历史一直查名字，但群聊主历史
// (GroupChat.triggerDirector) 漏查，只给死占位 [表情包]，导致群里角色"看不见"用户
// 发的表情。修复把查名收口到 stickerNameFromUrl，私聊 / 群聊共用同一个点。
//
// 群聊那段序列化内联在 React 组件闭包里、未导出，无法单测；这里改为钉住共用的收口
// helper 本身 + 私聊集成路径——helper 正确，两条调用路径就都正确。

const DOGE_URL = 'https://img.example/doge.png';
const emojis: Emoji[] = [{ name: '柴犬贴贴', url: DOGE_URL }];

describe('stickerNameFromUrl 表情名反查', () => {
    it('URL 命中时返回当初设的表情名', () => {
        expect(stickerNameFromUrl(emojis, DOGE_URL)).toBe('柴犬贴贴');
    });

    it('URL 查不到时兜底为 未知表情, 不抛错', () => {
        expect(stickerNameFromUrl(emojis, 'https://img.example/none.png')).toBe('未知表情');
        expect(stickerNameFromUrl([], DOGE_URL)).toBe('未知表情');
    });
});

describe('buildMessageHistory 私聊表情包带名字', () => {
    const char = { id: 'c1', name: '小角色' } as any;
    const userProfile = { name: '我' } as any;
    const t0 = Date.now() - 60_000;

    it('用户发表情包时上下文带出表情名, 不是光秃秃的占位 (退化即挂)', () => {
        const history = [
            { id: 1, charId: 'c1', role: 'user', type: 'emoji', content: DOGE_URL, timestamp: t0 },
        ] as any[];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 10, char, userProfile, emojis);
        const userMsg = apiMessages.find((m: any) => m.role === 'user');
        const content = JSON.stringify(userMsg!.content);
        expect(content).toContain('柴犬贴贴');
        expect(content).toContain('发送了表情包');
    });
});

describe('表情包上下文只用名称或识图文字', () => {
    const char = { id: 'c1', name: '小角色' } as any;
    const userProfile = { name: '我' } as any;
    const t0 = Date.now() - 600_000;
    const sticker = (id: number, role: 'user' | 'assistant', url = DOGE_URL) =>
        ({ id, charId: 'c1', role, type: 'emoji', content: url, timestamp: t0 + id * 1000 });

    const images = (content: any) => Array.isArray(content) ? content.filter((p: any) => p.type === 'image_url').map((p: any) => p.image_url.url) : [];

    it('识图关闭时，用户和角色发的表情包都只传名称，不传图片', () => {
        const history = [
            sticker(1, 'user'),
            sticker(2, 'assistant'),
            { id: 3, charId: 'c1', role: 'user', type: 'text', content: '哈哈，收到', timestamp: t0 + 3000 },
        ] as any[];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 20, char, userProfile, [{ ...emojis[0], visionDescription: '缓存的详细画面不得泄漏' }]);
        expect(apiMessages.every((m: any) => images(m.content).length === 0)).toBe(true);
        expect(JSON.stringify(apiMessages)).not.toContain('缓存的详细画面不得泄漏');
        expect(JSON.stringify(apiMessages)).not.toContain(DOGE_URL);
        expect(JSON.stringify(apiMessages)).toContain('柴犬贴贴');
        expect(JSON.stringify(apiMessages)).toContain('收到');
    });

    it('角色发的表情包不会附到下一条用户消息，也不发送原图', () => {
        const history = [
            ...[1, 2, 3, 4, 5, 6].map(id => sticker(id, 'assistant', `https://img.example/a${id}.png`)),
            { id: 9, charId: 'c1', role: 'user', type: 'text', content: '哈哈', timestamp: t0 + 9000 },
            sticker(10, 'assistant'),
        ] as any[];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 20, char, userProfile, emojis);
        // assistant 消息不带图
        expect(apiMessages.filter((m: any) => m.role === 'assistant').every((m: any) => typeof m.content === 'string')).toBe(true);
        const userMsg = apiMessages.find((m: any) => m.role === 'user')!;
        expect(images(userMsg.content)).toEqual([]);
        expect(typeof userMsg.content).toBe('string');
        expect(JSON.stringify(userMsg.content)).toContain('哈哈');
        expect(JSON.stringify(apiMessages)).toContain('柴犬贴贴');
    });

    it('开了识图 API 时用表情包库里的画面描述，不附原图，也不用消息上的旧描述', () => {
        const library: Emoji[] = [{ name: '柴犬贴贴', url: DOGE_URL, visionDescription: '一只柴犬歪头' }];
        const history = [
            { ...sticker(1, 'user'), metadata: { visionDescription: '认错的旧描述' } },
            sticker(2, 'assistant'),
        ] as any[];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 10, char, userProfile, library, undefined, { useVisionDescriptions: true });
        for (const m of apiMessages) {
            expect(m.content).toContain('一只柴犬歪头');
            expect(m.content).not.toContain('认错的旧描述');
            expect(images(m.content)).toEqual([]);
        }
    });
});

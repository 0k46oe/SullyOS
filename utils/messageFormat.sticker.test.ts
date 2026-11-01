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

describe('用户发的表情包给模型看图', () => {
    const char = { id: 'c1', name: '小角色' } as any;
    const userProfile = { name: '我' } as any;
    const t0 = Date.now() - 600_000;
    const sticker = (id: number, role: 'user' | 'assistant', url = DOGE_URL) =>
        ({ id, charId: 'c1', role, type: 'emoji', content: url, timestamp: t0 + id * 1000 });

    it('只给最近 5 张用户表情包附图，更早的和角色自己发的只给名字', () => {
        const history = [
            ...[1, 2, 3, 4, 5, 6, 7].map(id => sticker(id, 'user', `https://img.example/${id}.png`)),
            sticker(8, 'assistant'),
        ] as any[];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 20, char, userProfile, emojis);
        const withImage = apiMessages.map((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'));
        expect(withImage).toEqual([false, false, true, true, true, true, true, false]);
        expect(JSON.stringify(apiMessages[2].content)).toContain('https://img.example/3.png');
        expect(apiMessages[7].content).toContain('柴犬贴贴');
    });

    it('开了识图 API 时用识图描述，不附原图', () => {
        const history = [{ ...sticker(1, 'user'), metadata: { visionDescription: '一只柴犬歪头' } }] as any[];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 10, char, userProfile, emojis, undefined, { useVisionDescriptions: true });
        expect(apiMessages[0].content).toContain('柴犬贴贴');
        expect(apiMessages[0].content).toContain('一只柴犬歪头');
    });
});

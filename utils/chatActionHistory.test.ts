import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';

// 酒馆角色的线上动描存在回复的 metadata 里，界面显示；开着动描时也要回到角色的上下文里。
const tavern = { firstMessage: '', alternateGreetings: [], creatorNotes: '' };
const user = { name: '我' } as any;
const t0 = Date.now() - 60_000;
const rows = [
    { id: 1, charId: 'c', role: 'user', type: 'text', content: '在吗', timestamp: t0 },
    { id: 2, charId: 'c', role: 'assistant', type: 'text', content: '在', timestamp: t0 + 1000, metadata: { chatActionDescription: '他放下水杯，笑了笑。' } },
    { id: 3, charId: 'c', role: 'assistant', type: 'text', content: '怎么了', timestamp: t0 + 2000 },
] as any[];
const build = (char: any) => ChatPrompts.buildMessageHistory(rows, 10, { id: 'c', name: '角色', ...char }, user, []).apiMessages;

describe('线上动描进入角色上下文', () => {
    it('开着动描时按原标签放在那条回复前面，只放一次', () => {
        const api = build({ tavernImport: tavern, chatActionDescriptionEnabled: true });
        expect(api[1].content).toMatch(/^<线上动描>他放下水杯，笑了笑。<\/线上动描>\n.*在$/s);
        expect(api[2].content).not.toContain('线上动描');
        expect(api[0].content).not.toContain('线上动描');
    });

    it('关掉动描或不是酒馆角色时不发旧动描', () => {
        expect(JSON.stringify(build({ tavernImport: tavern, chatActionDescriptionEnabled: false }))).not.toContain('线上动描');
        expect(JSON.stringify(build({ chatActionDescriptionEnabled: true }))).not.toContain('线上动描');
    });
});

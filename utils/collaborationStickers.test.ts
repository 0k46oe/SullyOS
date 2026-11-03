import { describe, expect, it, vi } from 'vitest';
import { prepareCollaborationStickerContext } from '../features/collaboration/stickers';
import { describeRecentStickers } from './visionApi';
vi.mock('./visionApi', () => ({ describeRecentStickers: vi.fn(async (_history, emojis) => emojis) }));
const library = [{ name: '贴贴', url: 'https://example.test/sticker.png', visionDescription: '小猫抱住另一只小猫' }];
const history = ['user', 'assistant'].map((role, i) => ({ id: String(i), sessionId: 's', role, content: '[[SEND_EMOJI: 贴贴]]', createdAt: i })) as any;
describe('协同双方表情包的主模型输入', () => {
  it('关闭识图时不读取缓存描述、不识图、不发送原图', async () => {
    vi.mocked(describeRecentStickers).mockClear();
    const output = JSON.stringify(await prepareCollaborationStickerContext(history, library));
    expect(output).toContain('贴贴');
    expect(output).not.toContain('小猫');
    expect(output).not.toContain(library[0].url);
    expect(describeRecentStickers).not.toHaveBeenCalled();
  });
  it('开启识图时双方只附文字描述，原消息不变', async () => {
    const output = await prepareCollaborationStickerContext(history, library, [], { enabled: true, baseUrl: '', apiKey: '', model: '' });
    expect(output.every(message => message.content.includes('小猫抱住另一只小猫'))).toBe(true);
    expect(JSON.stringify(output)).not.toContain(library[0].url);
    expect(history[0].content).toBe('[[SEND_EMOJI: 贴贴]]');
  });
  it('描述缺失或表情已删除时只提供名字', async () => {
    const output = await prepareCollaborationStickerContext(history, [], [], { enabled: true, baseUrl: '', apiKey: '', model: '' });
    expect(output.every(message => message.content.includes('表情包：贴贴'))).toBe(true);
    expect(JSON.stringify(output)).not.toContain('表情包画面');
  });
});

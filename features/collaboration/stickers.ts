import type { Emoji, EmojiCategory, Message, VisionApiConfig } from '../../types';
import { describeRecentStickers } from '../../utils/visionApi';
import { resolveCollaborationEmoji } from './richOutput';
import type { CollaborationMessage } from './types';

/** Sticker artwork is for UI / the separate vision API, never the main model. */
export async function prepareCollaborationStickerContext(
  messages: CollaborationMessage[],
  emojis: Emoji[] = [],
  categories: EmojiCategory[] = [],
  visionApiConfig?: VisionApiConfig,
): Promise<CollaborationMessage[]> {
  const pattern = /\[\[SEND_EMOJI\s*[:：]\s*([^\]\r\n]+?)\s*\]\]/gi;
  const history: Message[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    for (const match of message.content.matchAll(pattern)) {
      const sticker = resolveCollaborationEmoji(match[1], emojis, categories);
      if (sticker) history.push({ id: history.length + 1, charId: '', role: message.role,
        type: 'emoji', content: sticker.url, timestamp: message.createdAt });
    }
  }
  const enabled = visionApiConfig?.enabled === true;
  const library = enabled ? await describeRecentStickers(history, emojis, visionApiConfig) : emojis;
  return messages.map(message => ({
    ...message,
    content: message.content.replace(pattern, (_tag, rawName: string) => {
      const sticker = resolveCollaborationEmoji(rawName, library, categories);
      const description = enabled ? sticker?.visionDescription?.trim() : '';
      return `[${message.role === 'user' ? '用户' : '你'}发送了表情包：${sticker?.name || rawName.trim()}]`
        + (description ? `\n[表情包画面：${description}]` : '');
    }),
  }));
}

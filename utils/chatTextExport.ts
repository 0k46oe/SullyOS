import type { Message } from '../types';
import { stripStoredThinking } from './savedThinking';
import { isVisibleChatMessage } from './chatMessageVisibility';

/** Export persisted dialogue, including archived history; never export prompts or media payloads. */
export function formatChatTextExport(messages: Message[], options: { includeThinking?: boolean } = {}): string {
    return '\uFEFF' + [...messages]
        .filter(message => isVisibleChatMessage(message) && (message.role === 'user' || message.role === 'assistant'))
        .sort((a, b) => a.timestamp - b.timestamp || a.id - b.id)
        .map(message => {
            const date = new Date(message.timestamp);
            const time = Number.isFinite(date.getTime()) ? date.toLocaleString('sv-SE', { hour12: false }) : '时间未知';
            let content = message.type === 'image' ? '[图片]'
                : message.type === 'emoji' ? '[表情]'
                : /^(?:blobref:|blob:|data:)/i.test(message.content || '') ? '[附件]'
                : message.type === 'voice' ? `[语音] ${message.content || ''}` : message.content || '';
            if (message.role === 'assistant') {
                if (!options.includeThinking && (message.type === 'text' || message.type === 'voice')) content = stripStoredThinking(content);
                if (options.includeThinking && typeof message.metadata?.thinkingChain === 'string' && message.metadata.thinkingChain.trim()) {
                    content += '\n【思考内容】\n' + message.metadata.thinkingChain;
                }
            }
            return `[${time}] ${message.role === 'user' ? 'User' : 'AI'}: ${content}`;
        }).join('\n\n');
}

import type { CharacterProfile, Message } from '../types';
import { getVoiceTranscript, normalizeMessageContent } from './messageFormat';
import { stripEmojiDirectivesFromSearchText } from './chatMessageSearch';
import type { WordFrequencyInput } from './chatWordFrequency';

const REASONING_KEYS = /^(?:thinking_?chain|reasoning(?:_?content|_?details)?|thinking|thoughts?|analysis|raw(?:_?response|_?content)|api_?response)$/i;

/** Includes legacy inline blocks and unfinished streaming blocks. Never mutates stored messages. */
export function stripStoredThinking(text: string): string {
    return text.replace(/<(think|thinking|thought)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<(?:think|thinking|thought)\b[^>]*>[\s\S]*$/gi, '');
}

function exportValue(value: unknown, includeThinking: boolean): unknown {
    if (Array.isArray(value)) return value.map(item => exportValue(item, includeThinking));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).filter(([key]) => includeThinking || !REASONING_KEYS.test(key))
            .map(([key, item]) => [key, exportValue(item, includeThinking)]));
    }
    return value;
}

/** Full persisted private history, independent of screen pagination, context limits and watermarks. */
export function selectChatRecords(messages: readonly Message[], charId: string): Message[] {
    return messages.filter(message => message.charId === charId && !message.groupId
        && (message.role === 'user' || message.role === 'assistant'))
        .slice().sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
}

export function buildChatExport(messages: readonly Message[], char: Pick<CharacterProfile, 'id' | 'name'>,
    userName: string, includeThinking: boolean) {
    const records = selectChatRecords(messages, char.id).map(message => {
        const exported = exportValue(message, includeThinking) as Message;
        if (!includeThinking) {
            if (exported.role === 'assistant' && (exported.type === 'text' || exported.type === 'voice')) {
                exported.content = stripStoredThinking(exported.content);
            }
            if (exported.replyTo) exported.replyTo.content = stripStoredThinking(exported.replyTo.content);
        }
        const readableText = normalizeMessageContent(exported, char.name, userName);
        return { ...exported, speaker: message.role === 'user' ? userName : char.name, readableText };
    });
    return {
        format: 'sully_chat_history', version: 1, character: { id: char.id, name: char.name },
        userName, includesThinking: includeThinking, count: records.length, messages: records,
    };
}

export type ChatExport = ReturnType<typeof buildChatExport>;

export function chatExportToText(data: ChatExport): string {
    return [
        `${data.userName} 与 ${data.character.name} 的聊天记录`,
        `共 ${data.count} 条 · ${data.includesThinking ? '包含已保存的思考内容' : '不含思考内容'}`,
        '图片、音频及附件以文字说明或原始引用保留，不打包资源文件。',
        ...data.messages.map(message => {
            const time = new Date(message.timestamp).toLocaleString();
            const lines = [`[${time}] ${message.speaker} (${message.role} / ${message.type})`];
            if (message.replyTo) lines.push(`引用 ${message.replyTo.name}：${message.replyTo.content}`);
            lines.push(message.readableText || message.content || `[${message.type}]`);
            if (message.type !== 'text' && message.type !== 'voice') {
                if (message.content && message.content !== message.readableText) lines.push(`【原始内容 / 资源引用】\n${message.content}`);
                const { thinkingChain: _thinkingChain, ...details } = message.metadata || {};
                if (Object.keys(details).length) lines.push(`【卡片 / 附件详情】\n${JSON.stringify(details, null, 2)}`);
            }
            if (data.includesThinking && typeof message.metadata?.thinkingChain === 'string') {
                lines.push(`【已保存的思考内容】\n${message.metadata.thinkingChain}`);
            }
            return lines.join('\n');
        }),
    ].join('\n\n');
}

export function chatExportFileName(name: string, extension: 'json' | 'txt'): string {
    const safeName = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 60) || '角色';
    return `${safeName}_聊天记录.${extension}`;
}

/** Count only spoken text, never attachment JSON/scripts, card payloads or stored reasoning. */
export function getChatWordInputs(messages: readonly Message[], charId: string): WordFrequencyInput[] {
    return selectChatRecords(messages, charId).flatMap(message => {
        if (message.type !== 'text' && message.type !== 'voice') return [];
        const raw = message.type === 'voice' ? getVoiceTranscript(message) : message.content;
        const text = stripEmojiDirectivesFromSearchText(stripStoredThinking(raw.split('%%BILINGUAL%%')[0]))
            .replace(/```[\s\S]*?(?:```|$)/g, ' ')
            .replace(/\[\[[\s\S]*?\]\]/g, ' ')
            .replace(/(?:https?:\/\/|blob:|data:|blobref:)[^\s<>]+/gi, ' ')
            .replace(/<[^>]+>/g, ' ');
        return text.trim() ? [{ role: message.role as 'user' | 'assistant', text }] : [];
    });
}

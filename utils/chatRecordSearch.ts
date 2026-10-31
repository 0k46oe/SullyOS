import type { Message } from '../types';
import { normalizeChatSearchText, stripEmojiDirectivesFromSearchText } from './chatMessageSearch';
import { isVisibleChatMessage } from './chatMessageVisibility';
import { getLocalDateKey } from './localDate';
import { getVoiceTranscript } from './messageFormat';
import { stripStoredThinking } from './savedThinking';

export interface ChatSearchRecord {
    id: number; role: 'user' | 'assistant'; timestamp: number; date: string; text: string; searchable: string;
}
export type ChatSearchRole = 'all' | 'user' | 'assistant';

/** Search only what can be opened in private chat. Never display raw media URLs or card JSON. */
export function chatRecordText(message: Message): string {
    switch (message.type) {
        case 'text': return stripEmojiDirectivesFromSearchText(message.role === 'assistant' ? stripStoredThinking(message.content) : message.content).trim();
        case 'voice': return `[语音] ${stripStoredThinking(getVoiceTranscript(message))}`;
        case 'image': return '[图片]';
        case 'emoji': return '[表情]';
        case 'collaboration_file': return `[文件] ${String(message.metadata?.fileName || 'JSON 文件')}`;
        case 'interaction': return message.content;
        case 'transfer': return '[转账]';
        default: return '[卡片消息]';
    }
}

/** Yield between batches so long histories can be cancelled and do not freeze the phone. */
export async function buildChatSearchRecords(messages: readonly Message[], charId: string, signal: AbortSignal): Promise<ChatSearchRecord[]> {
    const records: ChatSearchRecord[] = [];
    for (let start = 0; start < messages.length; start += 256) {
        if (signal.aborted) return [];
        for (const message of messages.slice(start, start + 256)) {
            if (message.charId !== charId || !isVisibleChatMessage(message) || message.role === 'system' || !Number.isFinite(message.timestamp)) continue;
            const date = new Date(message.timestamp);
            if (!Number.isFinite(date.getTime())) continue;
            const text = chatRecordText(message);
            records.push({ id: message.id, role: message.role, timestamp: message.timestamp, date: getLocalDateKey(date), text, searchable: normalizeChatSearchText(text) });
        }
        if (start + 256 < messages.length) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return records.sort((a, b) => b.timestamp - a.timestamp || b.id - a.id);
}

export function filterChatSearchRecords(records: readonly ChatSearchRecord[], query: string, role: ChatSearchRole, date: string): ChatSearchRecord[] {
    const keyword = normalizeChatSearchText(query);
    const hits = records.filter(record => (role === 'all' || record.role === role) && (!date || record.date === date) && (!keyword || record.searchable.includes(keyword)));
    return date ? hits.slice().reverse() : hits;
}

export function chatSearchDates(records: readonly ChatSearchRecord[]): Map<string, number> {
    const dates = new Map<string, number>();
    for (const record of records) dates.set(record.date, (dates.get(record.date) || 0) + 1);
    return dates;
}

/** A bounded plain-text preview. Offsets preserve case/width in the displayed original. */
export function chatSearchSnippet(text: string, query: string): { before: string; match: string; after: string } {
    const keyword = normalizeChatSearchText(query);
    if (!keyword) return { before: text.slice(0, 160) + (text.length > 160 ? '…' : ''), match: '', after: '' };
    let normalized = '', offset = 0;
    const starts: number[] = [], ends: number[] = [];
    for (const char of text) {
        for (const unit of char.normalize('NFKC').toLocaleLowerCase()) {
            const value = /\s/u.test(unit) ? ' ' : unit;
            if (value === ' ' && (!normalized || normalized.endsWith(' '))) continue;
            normalized += value;
            for (let i = 0; i < value.length; i++) { starts.push(offset); ends.push(offset + char.length); }
        }
        offset += char.length;
    }
    const found = normalized.indexOf(keyword);
    if (found < 0) return { before: text.slice(0, 160), match: '', after: text.length > 160 ? '…' : '' };
    const start = starts[found], end = ends[found + keyword.length - 1];
    const left = Math.max(0, start - 42), right = Math.min(text.length, end + 100);
    return { before: (left ? '…' : '') + text.slice(left, start), match: text.slice(start, end), after: text.slice(end, right) + (right < text.length ? '…' : '') };
}

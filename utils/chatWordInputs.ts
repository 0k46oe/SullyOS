import type { Message } from '../types';
import { getVoiceTranscript } from './messageFormat';
import { stripEmojiDirectivesFromSearchText } from './chatMessageSearch';
import type { WordFrequencyInput } from './chatWordFrequency';

import { stripStoredThinking } from './savedThinking';

/** Full persisted private history, independent of screen pagination, context limits and watermarks. */
export function selectChatRecords(messages: readonly Message[], charId: string): Message[] {
    return messages.filter(message => message.charId === charId && !message.groupId
        && (message.role === 'user' || message.role === 'assistant'))
        .slice().sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
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

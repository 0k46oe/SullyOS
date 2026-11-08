import type { Message } from '../types';
import { isVisibleChatMessage } from './chatMessageVisibility';

/** Group meeting messages between successive visible online messages. */
export function meetingHistoryByNextChat(messages: Message[], hideSystemLogs = false): Map<number | null, Message[]> {
    const ordered = [...messages].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
    const groups = new Map<number | null, Message[]>();
    let pending: Message[] = [];
    for (const message of ordered) {
        if (!message.groupId && message.metadata?.source === 'date' && (message.role === 'user' || message.role === 'assistant')) pending.push(message);
        else if ((message.role === 'user' || message.role === 'assistant') && isVisibleChatMessage(message, hideSystemLogs)) {
            if (pending.length) groups.set(message.id, pending);
            pending = [];
        }
    }
    if (pending.length) groups.set(null, pending);
    return groups;
}

export function formatChatElapsed(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`;
    const days = Math.floor(hours / 24);
    return `${days} 天${hours % 24 ? ` ${hours % 24} 小时` : ''}`;
}

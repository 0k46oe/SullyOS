import type { Message } from '../types';

export function startsNewMessageGroup(previous: Pick<Message, 'role' | 'timestamp'> | null, current: Pick<Message, 'role' | 'timestamp'>): boolean {
    // 只要角色不同，或者超过2分钟，就是新的一组
    return !previous || previous.role !== current.role || Math.abs(current.timestamp - previous.timestamp) >= 2 * 60 * 1000;
}

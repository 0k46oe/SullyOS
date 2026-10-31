export const CHAT_ACTION_ORDER_KEY = 'sully-chat-action-order-v1';
export const CHAT_ACTION_ORDER_CHANGED = 'sully-chat-action-order-changed';

/** Retired tools disappear; newly available tools are appended without disturbing saved positions. */
export function normalizeChatActionOrder(saved: unknown, available: readonly string[]): string[] {
    const known = new Set(available);
    const result = Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === 'string' && known.has(id)))] : [];
    return [...result, ...available.filter(id => !result.includes(id))];
}

export function loadChatActionOrder(): string[] {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(CHAT_ACTION_ORDER_KEY) || '[]');
        return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    } catch { return []; }
}

export function saveChatActionOrder(order: readonly string[]): boolean {
    let persisted = true;
    try { localStorage.setItem(CHAT_ACTION_ORDER_KEY, JSON.stringify(order)); }
    catch { persisted = false; }
    window.dispatchEvent(new CustomEvent(CHAT_ACTION_ORDER_CHANGED, { detail: [...order] }));
    return persisted;
}

export function moveChatAction(order: readonly string[], id: string, target: string): string[] {
    const from = order.indexOf(id), to = order.indexOf(target);
    if (from < 0 || to < 0 || from === to) return [...order];
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, id);
    return next;
}

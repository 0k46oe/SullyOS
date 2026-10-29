/** Shared with worker/stream preview: no persistence or repaired JSON. */
export const FRIEND_FEED_MAIN_PROMPT_PREFIX = '【顺便回好友圈】';

export function extractFriendFeedReplyTags(raw: string, namespace:'FRIEND_FEED_REPLY'|'HOME_VISIT_REPLY'='FRIEND_FEED_REPLY'): {text: string; actions: unknown[]} {
    const marker = new RegExp('\\[\\['+namespace+'\\s*:','gi');
    const actions: unknown[] = [];
    let text = '', cursor = 0, match: RegExpExecArray | null;
    while ((match = marker.exec(raw))) {
        text += raw.slice(cursor, match.index);
        let start = marker.lastIndex;
        while (start < raw.length && /\s/.test(raw[start])) start++;
        let depth = 0, quoted = false, escaped = false, end = -1;
        if (raw[start] === '{') for (let i = start; i < raw.length; i++) {
            const c = raw[i];
            if (quoted) {
                if (escaped) escaped = false;
                else if (c === '\\') escaped = true;
                else if (c === '"') quoted = false;
            } else if (c === '"') quoted = true;
            else if (c === '{') depth++;
            else if (c === '}' && --depth === 0) {end = i + 1; break;}
        }
        const close = end >= 0 ? /^\s*\]\]/.exec(raw.slice(end)) : null;
        if (close) {
            try {actions.push(JSON.parse(raw.slice(start, end)));} catch { /* malformed actions stay hidden */ }
            cursor = end + close[0].length;
        } else {
            const fallback = raw[start] === '{' && end < 0 ? -1 : raw.indexOf(']]', end >= 0 ? end : start);
            cursor = fallback < 0 ? raw.length : fallback + 2;
        }
        marker.lastIndex = cursor;
    }
    return {text: text + raw.slice(cursor), actions};
}

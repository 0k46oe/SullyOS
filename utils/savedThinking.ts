/** Includes legacy inline blocks and unfinished streaming blocks. Never mutates stored messages. */
export function stripStoredThinking(text: string): string {
    return text.replace(/<(think|thinking|thought)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<(?:think|thinking|thought)\b[^>]*>[\s\S]*$/gi, '');
}

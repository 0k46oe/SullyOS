/** Pure format parsing shared by the browser and background worker. */
export function extractChatExtras(source: string): { text: string; action?: string; image?: string } {
    let action: string | undefined, image: string | undefined;
    // Code samples and thoughts must never become paid image commands.
    const text = source.split(/(```[\s\S]*?(?:```|$)|<(?:think|thinking|thought)>[\s\S]*?(?:<\/(?:think|thinking|thought)>|$))/gi).map((part, index) => {
        if (index % 2) return part;
        return part.replace(/<(线上动描|生成图片)>([\s\S]*?)<\/\1>/g, (_, tag: string, value: string) => {
            if (tag === '线上动描') action ||= value.trim(); else image ||= value.trim();
            return '';
        }).replace(/<(?:线上动描|生成图片)>[\s\S]*$/g, '');
    }).join('');
    return { text: text.trim(), action, image };
}

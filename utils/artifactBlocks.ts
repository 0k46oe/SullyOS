export interface ArtifactFileRequest { title: string; format: string; content: string }

/** Shared envelope parser. File bodies remain data; never scan their tags as chat actions. */
export function parseArtifactFileBlocks(response: string, options: {
    formats: ReadonlySet<string>; defaultTitle: string; validateJson?: boolean; reportTruncation?: boolean;
}): { visibleText: string; artifacts: ArtifactFileRequest[] } {
    const artifacts: ArtifactFileRequest[] = [];
    const pattern = /<(think|thinking|thought)>[\s\S]*?<\/\1>|^```artifact[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*(?=\r?$)/gim;
    let visibleText = response.replace(pattern, (block, thinkingTag: string | undefined, raw: string) => {
        if (thinkingTag) return block;
        let format = '';
        try {
            let parsed: any;
            try { parsed = JSON.parse(raw.trim()); } catch {
                const separator = raw.match(/\r?\n---[^\S\r\n]*(?:\r?\n|$)/);
                if (!separator || separator.index == null) {
                    if (options.validateJson && /"format"\s*:\s*"json"/i.test(raw)) throw Error('invalid JSON envelope');
                    return block;
                }
                const header = raw.slice(0, separator.index);
                parsed = { title: header.match(/^title\s*:\s*(.+)$/im)?.[1]?.trim(),
                    format: header.match(/^format\s*:\s*([a-z0-9]+)\s*$/im)?.[1],
                    content: raw.slice(separator.index + separator[0].length).trimEnd() };
            }
            format = String(parsed?.format || '').toLowerCase();
            if (!options.formats.has(format)) return block;
            if (typeof parsed.content !== 'string') throw Error('missing file content');
            if (options.validateJson && format === 'json') JSON.parse(parsed.content);
            artifacts.push({ title: typeof parsed.title === 'string' ? parsed.title : options.defaultTitle,
                format, content: parsed.content });
            return '';
        } catch {
            return options.validateJson && (!format || format === 'json')
                ? '[JSON 文件未生成：内容不是合法 JSON，请重新生成完整文件。]' : block;
        }
    }).trim();
    if (options.reportTruncation) {
        const openings = [...visibleText.matchAll(/^```artifact[^\S\r\n]*(?:\r?\n|$)/gim)];
        const last = openings.at(-1);
        if (last?.index != null && !/^```[^\S\r\n]*\r?$/m.test(visibleText.slice(last.index + last[0].length))) {
            visibleText = visibleText.slice(0, last.index).trimEnd()
                + '\n[JSON 文件未生成：输出被截断或文件块没有结束，请重新生成完整文件。]';
        }
    }
    return { visibleText, artifacts };
}

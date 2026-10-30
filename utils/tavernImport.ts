import type { CharacterExportData, Worldbook } from '../types';
import { parseStandardWorldbook, toMountedWorldbook } from './worldbook';
import { extractPngTextChunks, extractShareFromPng, isPng, MAX_SHARE_BYTES, pngHasShare } from './pngShare';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => (
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
);
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string') : [];
const decoder = new TextDecoder('utf-8', { fatal: true });
const defaultAvatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#ede9fe"/><circle cx="50" cy="36" r="18" fill="#a78bfa"/><path d="M16 100v-12a34 34 0 0168 0v12" fill="#a78bfa"/></svg>');

function parseJson(raw: string): unknown {
    try { return JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch { throw new Error('文件中的 JSON 无效，请重新获取原文件'); }
}

/** Normalize standalone World Info and the character-card character_book schema. */
export function parseImportedWorldbook(raw: string, category: string, now = Date.now()): Worldbook[] {
    const root = object(parseJson(raw));
    const book = root.spec === 'lorebook_v3' ? object(root.data) : root;
    if (!book.entries || typeof book.entries !== 'object') {
        throw new Error('不是受支持的世界书文件：缺少 entries');
    }
    const entries = (Array.isArray(book.entries) ? book.entries : Object.values(book.entries)).map(value => {
        const entry = object(value);
        const ext = object(entry.extensions);
        const rawPosition = ext.position ?? entry.position;
        const position = rawPosition === 'before_char' ? 0 : rawPosition === 'after_char' ? 1 : rawPosition;
        return {
            ...entry,
            uid: entry.uid ?? entry.id,
            key: entry.key ?? entry.keys,
            keysecondary: entry.keysecondary ?? entry.secondary_keys,
            comment: entry.comment || entry.name,
            selective: entry.selective ?? strings(entry.secondary_keys).length > 0,
            selectiveLogic: entry.selectiveLogic ?? ext.selectiveLogic,
            disable: entry.disable ?? entry.enabled === false,
            order: entry.order ?? entry.insertion_order,
            position,
            depth: entry.depth ?? ext.depth,
            role: entry.role ?? ext.role,
            probability: entry.probability ?? ext.probability,
            useProbability: entry.useProbability ?? ext.useProbability,
            scanDepth: entry.scanDepth ?? ext.scan_depth ?? ext.scanDepth ?? book.scan_depth,
            caseSensitive: entry.caseSensitive ?? entry.case_sensitive ?? ext.case_sensitive,
            matchWholeWords: entry.matchWholeWords ?? ext.match_whole_words ?? ext.matchWholeWords,
        };
    });
    return parseStandardWorldbook(JSON.stringify({ entries }), category, now);
}

export function parseImportedCharacterCard(raw: string, now = Date.now()): CharacterExportData {
    const root = object(parseJson(raw));
    if (root.type === 'sully_character_card') {
        if (typeof root.name !== 'string' || typeof root.systemPrompt !== 'string') {
            throw new Error('糯米机角色卡缺少名称或核心指令');
        }
        const info = object(root.tavernImport);
        return {
            ...root,
            ...(root.tavernImport ? { tavernImport: {
                firstMessage: text(info.firstMessage), alternateGreetings: strings(info.alternateGreetings),
                creatorNotes: text(info.creatorNotes), creator: text(info.creator),
                characterVersion: text(info.characterVersion), tags: strings(info.tags),
            } } : {}),
        } as unknown as CharacterExportData;
    }
    if (root.spec !== undefined && root.spec !== 'chara_card_v2' && root.spec !== 'chara_card_v3') {
        throw new Error('暂不支持此角色卡版本');
    }
    const data = root.spec ? object(root.data) : root;
    if (!text(data.name).trim() || data.entries || ![
        'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    ].some(key => typeof data[key] === 'string')) {
        throw new Error('不是受支持的酒馆角色卡，请选择 PNG / JSON 角色卡原文件');
    }
    const name = text(data.name).trim();
    const sections = [
        ['角色指令', data.system_prompt],
        ['角色描述', data.description],
        ['性格', data.personality],
        ['对话示例', data.mes_example],
        ['补充对话指令', data.post_history_instructions],
    ].filter(([, value]) => text(value).trim()).map(([label, value]) => `### ${label}\n${text(value)}`);
    const characterBook = object(data.character_book);
    const hasEntries = characterBook.entries && typeof characterBook.entries === 'object'
        && Object.keys(characterBook.entries).length > 0;
    const books = hasEntries
        ? parseImportedWorldbook(JSON.stringify(characterBook), text(characterBook.name).trim() || `${name} 的世界书`, now)
        : [];

    return {
        type: 'sully_character_card',
        version: 1,
        name,
        avatar: defaultAvatar,
        description: '',
        systemPrompt: sections.join('\n\n'),
        worldview: text(data.scenario),
        mountedWorldbooks: books.map(toMountedWorldbook),
        tavernImport: {
            firstMessage: text(data.first_mes),
            alternateGreetings: strings(data.alternate_greetings),
            creatorNotes: text(data.creator_notes),
            creator: text(data.creator),
            characterVersion: text(data.character_version),
            tags: strings(data.tags),
        },
    };
}

/** The native PNG format keeps its existing validation and wrong-kind errors. */
export async function readImportedCharacterCard(file: File): Promise<{ card: CharacterExportData; avatarFile?: File }> {
    const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (!isPng(signature) && !/\.png$/i.test(file.name) && file.type !== 'image/png') {
        if (file.size > MAX_SHARE_BYTES) throw new Error('角色卡超过 64 MB，请使用较小的文件');
        return { card: parseImportedCharacterCard(await file.text()) };
    }
    if (file.size > MAX_SHARE_BYTES + 32 * 1024 * 1024) throw new Error('PNG 角色卡过大，请使用较小的文件');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (pngHasShare(bytes)) {
        return { card: parseImportedCharacterCard(decoder.decode(extractShareFromPng(bytes, 'character').payload)) };
    }
    const chunks = extractPngTextChunks(bytes);
    const keyword = chunks.some(item => item.keyword === 'ccv3') ? 'ccv3' : 'chara';
    const candidates = chunks.filter(chunk => chunk.keyword === keyword);
    if (candidates.length === 0) throw new Error('图片中没有酒馆角色卡数据，请使用 PNG 原文件，不要截图或压缩');
    if (candidates.length !== 1) throw new Error('PNG 含有重复角色卡数据，请重新获取原文件');
    let json: string;
    try { json = decoder.decode(Uint8Array.from(atob(candidates[0].text.trim()), char => char.charCodeAt(0))); }
    catch { throw new Error('PNG 角色卡数据已损坏，请重新获取原文件'); }
    return { card: parseImportedCharacterCard(json), avatarFile: file };
}

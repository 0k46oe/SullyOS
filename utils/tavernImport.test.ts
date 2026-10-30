import { File } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { embedShareInPng, type ShareCardMetadata } from './pngShare';
import { stripSensitiveCardFields } from './characterCard';
import { parseImportedCharacterCard, parseImportedWorldbook, readImportedCharacterCard } from './tavernImport';

const png = new Uint8Array(readFileSync(new URL('../public/icons/icon-192.png', import.meta.url)));
const encoder = new TextEncoder();
const base = {
    name: '月 🌙', description: '一位旅人', personality: '温柔', scenario: '山间的小屋',
    first_mes: '你好，{{user}}！', mes_example: '{{char}}: 晚安。',
    creator_notes: '只供读者查看的备注', alternate_greetings: ['又见面了'],
    creator: '作者', tags: ['日常'], character_version: '1.2',
};
const file = (bytes: Uint8Array, name = '角色.png', type = 'image/png') => (
    new File([new Uint8Array(bytes).buffer], name, { type }) as unknown as globalThis.File
);
const cardJson = (spec = 'chara_card_v2', data = base) => JSON.stringify({ spec, spec_version: spec.endsWith('v3') ? '3.0' : '2.0', data });

// Build real tEXt chunks around an existing image; exercise the byte/file boundary.
function withText(input: Uint8Array, keyword: string, value: string): Uint8Array {
    const data = encoder.encode(`${keyword}\0${value}`);
    const chunk = new Uint8Array(data.length + 12);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(encoder.encode('tEXt'), 4);
    chunk.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of chunk.subarray(4, chunk.length - 4)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    view.setUint32(chunk.length - 4, (crc ^ 0xffffffff) >>> 0);
    const result = new Uint8Array(input.length + chunk.length);
    result.set(input.subarray(0, -12));
    result.set(chunk, input.length - 12);
    result.set(input.subarray(-12), result.length - 12);
    return result;
}
const encoded = (json: string) => Buffer.from(json, 'utf8').toString('base64');

describe('SillyTavern character import', () => {
    it.each(['v1', 'chara_card_v2', 'chara_card_v3'])('maps %s identity into editable native fields', version => {
        const card = parseImportedCharacterCard(version === 'v1' ? JSON.stringify(base) : cardJson(version));
        expect(card).toMatchObject({ type: 'sully_character_card', name: base.name, worldview: base.scenario, description: '' });
        expect(card.systemPrompt).toContain(base.description);
        expect(card.systemPrompt).toContain(base.personality);
        expect(card.systemPrompt).toContain(base.mes_example);
        expect(card.systemPrompt).not.toContain(base.creator_notes);
        expect(card.systemPrompt).not.toContain(base.first_mes);
        expect(card.tavernImport).toMatchObject({ firstMessage: base.first_mes, creatorNotes: base.creator_notes, alternateGreetings: base.alternate_greetings });
    });
    it('keeps character instructions while excluding foreign credentials and executable extensions', () => {
        const card = parseImportedCharacterCard(cardJson('chara_card_v2', {
            ...base, system_prompt: '原卡指令', post_history_instructions: '额外规则',
            dialogueApi: { apiKey: 'never-import' }, extensions: { script: '<script>run()</script>' },
        } as typeof base));
        expect(card.systemPrompt).toContain('原卡指令');
        expect(card.systemPrompt).toContain('额外规则');
        expect(JSON.stringify(card)).not.toContain('never-import');
        expect(JSON.stringify(card)).not.toContain('<script>');
    });
    it.each(['chara', 'ccv3'])('reads UTF-8 JSON from PNG %s metadata and retains the avatar file', async keyword => {
        const source = file(withText(png, keyword, encoded(cardJson(keyword === 'ccv3' ? 'chara_card_v3' : 'chara_card_v2'))));
        const result = await readImportedCharacterCard(source);
        expect(result.card.name).toBe(base.name);
        expect(result.card.tavernImport?.firstMessage).toBe(base.first_mes);
        expect(result.avatarFile).toBe(source);
    });
    it('prefers V3 data over an older V2 compatibility chunk', async () => {
        const image = withText(withText(png, 'chara', encoded(cardJson())), 'ccv3', encoded(cardJson('chara_card_v3', { ...base, name: '新版' })));
        expect((await readImportedCharacterCard(file(image))).card.name).toBe('新版');
    });
    it('rejects plain images, damaged PNGs, duplicate card data and invalid Base64', async () => {
        await expect(readImportedCharacterCard(file(png))).rejects.toThrow('PNG 原文件');
        const image = withText(png, 'chara', encoded(cardJson()));
        const damaged = image.slice(); damaged[damaged.length - 20] ^= 1;
        await expect(readImportedCharacterCard(file(damaged))).rejects.toThrow('校验失败');
        await expect(readImportedCharacterCard(file(withText(image, 'chara', encoded(cardJson()))))).rejects.toThrow('重复');
        await expect(readImportedCharacterCard(file(withText(png, 'chara', '%%%')))).rejects.toThrow('已损坏');
    });
    it('continues importing native JSON/PNG and checking native share resource kinds', async () => {
        const native = { type: 'sully_character_card', version: 1, name: '本机卡', systemPrompt: '设定', avatar: '', dialogueApi: { apiKey: 'strip-me' } };
        const json = JSON.stringify(native);
        const metadata: ShareCardMetadata = { format: 'sullyos-share', version: 1, kind: 'character', title: '本机卡', author: '', restrictions: '', style: 'paper', fileName: 'card.json', mimeType: 'application/json' };
        const jsonResult = await readImportedCharacterCard(file(encoder.encode('\uFEFF' + json), 'card.json', 'application/json'));
        const pngResult = await readImportedCharacterCard(file(embedShareInPng(png, metadata, encoder.encode(json))));
        expect(jsonResult.card).toEqual(pngResult.card);
        expect(pngResult.avatarFile).toBeUndefined();
        expect(stripSensitiveCardFields(pngResult.card)).not.toHaveProperty('dialogueApi');
        await expect(readImportedCharacterCard(file(embedShareInPng(png, { ...metadata, kind: 'worldbook' }, encoder.encode(json))))).rejects.toThrow('世界书');
    });
    it('normalizes native imported metadata before displaying it', () => {
        const card = parseImportedCharacterCard(JSON.stringify({ type: 'sully_character_card', name: '原生卡', systemPrompt: '', tavernImport: { firstMessage: {}, alternateGreetings: ['有效', 12] } }));
        expect(card.tavernImport).toMatchObject({ firstMessage: '', alternateGreetings: ['有效'], creatorNotes: '' });
    });
    it('rejects unrelated JSON and unsupported versions', () => {
        expect(() => parseImportedCharacterCard('{')).toThrow('JSON');
        expect(() => parseImportedCharacterCard(JSON.stringify({ name: '世界书', description: '设定', entries: {} }))).toThrow('角色卡');
        expect(() => parseImportedCharacterCard(cardJson('chara_card_v4'))).toThrow('版本');
    });
});

describe('SillyTavern worldbook import', () => {
    it('retains standalone World Info trigger, order, depth, role and disable settings', () => {
        const [entry] = parseImportedWorldbook(JSON.stringify({ entries: { 7: {
            uid: 7, key: ['月亮'], keysecondary: ['夜晚'], comment: '天空', content: '月亮是蓝色的',
            constant: false, selective: true, selectiveLogic: 2, disable: true, order: 180,
            position: 4, depth: 2, role: 1, scanDepth: 8, probability: 40, useProbability: true,
        } } }), '星空', 123);
        expect(entry).toMatchObject({ category: '星空', sourceUid: 7, key: ['月亮'], keysecondary: ['夜晚'], selectiveLogic: 2, disable: true, position: 4, depth: 2, role: 1, order: 180, scanDepth: 8, probability: 40, useProbability: true });
    });
    it('imports embedded Character Book aliases and mounts the exact converted entry IDs', () => {
        const raw = { ...base, character_book: { name: '小屋设定', scan_depth: 6, entries: [{
            id: 12, name: '旅人', keys: ['旅人'], secondary_keys: ['小屋'], content: '欢迎回家',
            enabled: false, constant: false, insertion_order: 60, position: 'after_char', case_sensitive: true,
            extensions: { position: 4, depth: 3, role: 2, selectiveLogic: 1, probability: 70, useProbability: true },
        }] } };
        const card = parseImportedCharacterCard(cardJson('chara_card_v2', raw), 999);
        const [entry] = card.mountedWorldbooks!;
        expect(entry).toMatchObject({ title: '旅人', category: '小屋设定', sourceUid: 12, key: ['旅人'], keysecondary: ['小屋'], selective: true, selectiveLogic: 1, disable: true, order: 60, position: 4, depth: 3, role: 2, scanDepth: 6, caseSensitive: true });
        expect(entry.id).toMatch(/^wb-999-/);
        const second = parseImportedCharacterCard(cardJson('chara_card_v2', raw), 999);
        expect(second.mountedWorldbooks![0].id).not.toBe(entry.id);
    });
    it('maps before/after-character positions, constant entries and V3 lorebook wrappers', () => {
        const entries = [{ keys: [], content: '常驻', constant: true, enabled: true, position: 'before_char' }, { keys: ['夜'], content: '夜晚', enabled: true, position: 'after_char' }];
        const result = parseImportedWorldbook(JSON.stringify({ spec: 'lorebook_v3', data: { entries } }), '世界');
        expect(result[0]).toMatchObject({ position: 0, constant: true, disable: false });
        expect(result[1]).toMatchObject({ position: 1, constant: false, key: ['夜'] });
    });
    it('accepts an empty embedded book but rejects empty or unrelated standalone files', () => {
        expect(parseImportedCharacterCard(cardJson('chara_card_v2', { ...base, character_book: { entries: [] } } as typeof base)).mountedWorldbooks).toEqual([]);
        expect(() => parseImportedWorldbook('{}', '测试')).toThrow('entries');
        expect(() => parseImportedWorldbook('{"entries":{}}', '测试')).toThrow('有效条目');
    });
});

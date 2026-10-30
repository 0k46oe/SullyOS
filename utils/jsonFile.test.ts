import { describe, expect, it } from 'vitest';
import { classifyJsonValue, isJsonFile, MAX_JSON_CONTEXT_CHARS, MAX_JSON_FILE_BYTES, parseJsonArtifactBlocks, parseJsonFile, requiresLocalJsonFiles } from './jsonFile';
import type { Message } from '../types';

const file = (text: string, name = 'preset.json', type = 'application/json') => new File([text], name, { type });
const fence = (content: string) => ['```artifact', 'title: 预设.json', 'format: json', '---', content, '```'].join('\n');

describe('JSON attachments', () => {
  it('recognizes a Tavern Chat Completion preset and retains every prompt', async () => {
    const text = JSON.stringify({ temperature: 0.8, prompts: [{ identifier: 'main', content: '{{char}} / [[ACTION:POKE]]' }], prompt_order: [{ character_id: 100001, order: [] }] });
    const parsed = await parseJsonFile(file(text));
    expect(parsed.kind).toBe('tavern-preset');
    expect(parsed.summary).toContain('SillyTavern Chat Completion 预设');
    expect(parsed.summary).toContain('提示词条目：1 个');
    expect(parsed.text).toBe(text);
  });

  it.each([
    [{ spec: 'chara_card_v2', data: { name: '名字' } }, 'character-card'],
    [{ name: '名字', description: '描述', first_mes: '开场白' }, 'character-card'],
    [{ entries: { 0: { content: '世界书' } } }, 'worldbook'],
    [{ entries: [{ content: '世界书' }] }, 'worldbook'],
    [{ temperature: 0.4 }, 'generic-json'],
    [null, 'generic-json'],
    [[1, 2], 'generic-json'],
  ])('classifies %j as %s', (value, kind) => expect(classifyJsonValue(value)).toBe(kind));

  it('accepts extension-only, MIME-only and UTF-8 BOM files', async () => {
    expect(isJsonFile({ name: 'data', type: 'application/json;charset=utf-8' })).toBe(true);
    expect((await parseJsonFile(file('\uFEFF{"ok":true}', 'data', 'application/json'))).value).toEqual({ ok: true });
    expect((await parseJsonFile(file('{}', 'data.JSON', ''))).kind).toBe('generic-json');
    await expect(parseJsonFile(file('{}', 'data.txt', 'text/plain'))).rejects.toThrow('这不是 JSON');
  });

  it('rejects malformed input and oversized input before reading', async () => {
    await expect(parseJsonFile(file('{broken}'))).rejects.toThrow('JSON 格式无效');
    const huge = file('{}');
    Object.defineProperty(huge, 'size', { value: MAX_JSON_FILE_BYTES + 1 });
    await expect(parseJsonFile(huge)).rejects.toThrow('超过 20MB');
  });

  it('labels context truncation while retaining the downloadable original', async () => {
    const text = JSON.stringify({ long: '长'.repeat(MAX_JSON_CONTEXT_CHARS) });
    const original = file(text);
    const parsed = await parseJsonFile(original);
    expect(parsed.text).toContain('已截断');
    expect(await original.text()).toBe(text);
    expect(parsed.value).toEqual(JSON.parse(text));
  });
});

describe('JSON file output', () => {
  it('accepts header and JSON-envelope protocols without changing content', () => {
    const content = JSON.stringify({ prompt: 'literal ``` fences and {{char}}', unicode: '你好', tags: '<think>保留</think> [[ACTION:POKE]]' }, null, 2);
    const envelope = ['```artifact', JSON.stringify({ title: '预设.json', format: 'json', content }), '```'].join('\n');
    for (const block of [fence(content), envelope, fence(content).replaceAll('\n', '\r\n')]) {
      const parsed = parseJsonArtifactBlocks('完成\n' + block + '\n末尾');
      expect(parsed.artifacts).toHaveLength(1);
      expect(parsed.artifacts[0].title).toBe('预设');
      expect(JSON.parse(parsed.artifacts[0].content)).toEqual(JSON.parse(content));
      expect(parsed.visibleText).toBe('完成\n\n末尾');
    }
  });

  it('does not create a corrupt JSON file or expose its action tags', () => {
    const parsed = parseJsonArtifactBlocks(fence('{"prompt":"[[ACTION:POKE]]",}'));
    expect(parsed.artifacts).toHaveLength(0);
    expect(parsed.visibleText).toContain('JSON 文件未生成');
    expect(parsed.visibleText).not.toContain('[[ACTION:POKE]]');
  });

  it('keeps non-JSON artifact formats outside the ordinary-chat feature', () => {

    const hidden = '<think>\n' + fence('{}') + '\n</think>';
    expect(parseJsonArtifactBlocks(hidden).artifacts).toHaveLength(0);

    const source = fence('plain').replace('format: json', 'format: txt');
    expect(parseJsonArtifactBlocks(source)).toEqual({ visibleText: source, artifacts: [] });
  });

  it('reports truncated JSON without exposing its partial content as chat actions', () => {
    const source = fence('{"prompt":"[[ACTION:POKE]]"}').slice(0, -3);
    const parsed = parseJsonArtifactBlocks(source);
    expect(parsed.artifacts).toHaveLength(0);
    expect(parsed.visibleText).toContain('JSON 文件未生成');
    expect(parsed.visibleText).not.toContain('[[ACTION:POKE]]');
  });

  it('keeps JSON turns local while leaving ordinary chat routing alone', () => {
    const row = { role: 'user', type: 'text', content: '你好' } as Message;
    expect(requiresLocalJsonFiles([row])).toBe(false);
    expect(requiresLocalJsonFiles([{ ...row, content: '请导出 JSON 文件' }])).toBe(true);
    expect(requiresLocalJsonFiles([{ ...row, type: 'collaboration_file', metadata: { fileName: 'preset.json' } }, row])).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { StoryTheaterPresetPrompt } from '../types';
import { compileStoryPreset, parseStoryTheaterPreset, type StoryApiMessage } from './storyTheater';
import { injectStoryPresetDepth } from './storyPresetDepth';

const marker = (identifier: string) => ({ identifier, name: identifier, marker: true });
const fixture = () => ({
    temperature: 0.8, top_p: 0.7, frequency_penalty: 0.2, presence_penalty: -0.3, openai_max_tokens: 4096,
    assistant_prefill: '{{char}}：', api_key: 'must-not-copy', custom_url: 'https://example.invalid',
    extensions: { scripts: ['must-not-copy'] },
    prompts: [
        { identifier: 'main', role: 'system', content: '为 {{user}} 写故事' },
        marker('worldInfoBefore'), marker('charDescription'), marker('charPersonality'), marker('personaDescription'),
        marker('worldInfoAfter'), marker('scenario'), marker('dialogueExamples'), marker('chatHistory'),
        { identifier: 'off', content: '关闭的规则' }, { identifier: 'unlisted', content: '未排序规则' },
    ],
    prompt_order: [
        { character_id: 100000, order: [{ identifier: 'off', enabled: true }] },
        { character_id: 100001, order: [
            'main', 'charDescription', 'charPersonality', 'worldInfoBefore', 'personaDescription',
            'worldInfoAfter', 'scenario', 'dialogueExamples', 'chatHistory', 'off',
        ].map(identifier => ({ identifier, enabled: identifier !== 'off' })) },
    ],
});
const parse = (data: unknown = fixture()) => parseStoryTheaterPreset(JSON.stringify(data), '夜航.json', 123);
const slots = { actors: '完整角色上下文', persona: '面具身份', scenario: '剧情和归档', worldBefore: '前世界书', worldAfter: '后世界书', examples: '' };

describe('酒馆 Chat Completion 预设导入', () => {
    it('选择 100001 默认顺序，保留开关并停用未排序项；只转换白名单字段', () => {
        const preset = parse();
        expect(preset.document.prompts.slice(0, 4).map(prompt => prompt.id)).toEqual(['main', 'charDescription', 'charPersonality', 'worldInfoBefore']);
        expect(preset.document.prompts.find(prompt => prompt.id === 'off')?.enabled).toBe(false);
        expect(preset.document.prompts.find(prompt => prompt.id === 'unlisted')?.enabled).toBe(false);
        expect(preset.document.generation).toEqual({ temperature: 0.8, topP: 0.7, frequencyPenalty: 0.2, presencePenalty: -0.3, maxTokens: 4096 });
        expect(JSON.stringify(preset)).not.toMatch(/must-not-copy|example.invalid|api_key|extensions/);
        expect(preset.document.importNotes?.join('')).toContain('不执行或模拟');
        expect(preset.document.assistantPrefill).toBe('{{char}}：');
    });

    it('发送时保持酒馆世界书顺序，合并角色槽且保留历史的 role 与对象引用', () => {
        const history: StoryApiMessage[] = [{ role: 'assistant', content: '原卡开场白' }, { role: 'user', content: '上一轮推进' }];
        const compiled = compileStoryPreset({ preset: parse(), slots, historyMessages: history, userName: '面具', characterNames: ['小雨'] });
        expect(compiled.messages.map(message => message.content)).toEqual(['为 面具 写故事', '完整角色上下文', '前世界书', '面具身份', '后世界书', '剧情和归档', '原卡开场白', '上一轮推进']);
        expect(compiled.messages[6]).toBe(history[0]);
        expect(compiled.assistantPrefill).toEqual({ role: 'assistant', content: '小雨：' });
    });

    it('不偷偷开启关闭的 marker 或不在顺序内的 marker', () => {
        const data = fixture();
        data.prompt_order[1].order = data.prompt_order[1].order.filter(item => item.identifier !== 'chatHistory').map(item => ({ ...item, enabled: item.identifier !== 'worldInfoBefore' }));
        const preset = parse(data);
        const compiled = compileStoryPreset({ preset, slots, historyMessages: [{ role: 'assistant', content: '隐藏历史' }], userName: '你', characterNames: ['他'] });
        expect(compiled.messages.map(message => message.content).join('')).not.toMatch(/前世界书|隐藏历史/);
    });

    it('支持只有一个旧顺序的文件，歧义、重复和坏引用必须报错', () => {
        const data = fixture();
        data.prompt_order = [data.prompt_order[1]];
        data.prompt_order[0].character_id = 17;
        expect(parse(data).name).toBe('夜航');
        data.prompt_order.push({ character_id: 18, order: [{ identifier: 'main', enabled: true }] });
        expect(() => parse(data)).toThrow('唯一的默认');
        data.prompt_order = [{ character_id: 100001, order: [{ identifier: 'missing', enabled: true }] }];
        expect(() => parse(data)).toThrow('不存在的条目');
        data.prompt_order[0].order = [{ identifier: 'main', enabled: true }, { identifier: 'main', enabled: false }];
        expect(() => parse(data)).toThrow('重复条目');
    });

    it('未知占位符和专属触发条件停用并展示说明，缺少的连接位显式补全', () => {
        const preset = parse({ prompts: [marker('unknown'), { identifier: 'conditional', content: '有条件', injection_trigger: ['quiet'] }], prompt_order: [{ character_id: 100001, order: [{ identifier: 'unknown', enabled: true }, { identifier: 'conditional', enabled: true }] }] });
        expect(preset.document.prompts.slice(0, 2).every(prompt => !prompt.enabled)).toBe(true);
        expect(preset.document.prompts.some(prompt => prompt.marker === 'history' && prompt.enabled)).toBe(true);
        expect(preset.document.importNotes?.join('')).toMatch(/未识别占位符.*专属触发条件.*补入缺失/s);
    });

    it('导入生成参数会归一化，导出再导入保留转换说明、布局与插入字段', () => {
        const data = fixture() as any;
        data.temperature = 9; data.openai_max_tokens = 999999;
        data.prompts[0].injection_position = 1; data.prompts[0].injection_depth = 2; data.prompts[0].injection_order = 30;
        const first = parse(data);
        const second = parse(first.document);
        expect(second.document).toEqual(first.document);
        expect(first.document.generation.temperature).toBe(2);
        expect(first.document.generation.maxTokens).toBe(32000);
        expect(first.document.prompts[0].injection).toEqual({ depth: 2, order: 30 });
    });

    it('拒绝错误格式、未知插入位置和需要深度的占位符', () => {
        expect(() => parse(null)).toThrow('请选择');
        expect(() => parse({ messages: [], model: 'x' })).toThrow('请选择');
        const data = fixture() as any;
        data.prompts[0].injection_position = 2;
        expect(() => parse(data)).toThrow('插入位置不受支持');
        data.prompts[0].injection_position = 0;
        data.prompts[1].injection_position = 1;
        expect(() => parse(data)).toThrow('改为相对位置');
    });
});

describe('剧情预设聊天深度发送', () => {
    const prompt = (id: string, depth: number, order = 100, role: StoryTheaterPresetPrompt['role'] = 'system'): StoryTheaterPresetPrompt => ({ id, name: id, enabled: true, role, content: id + '{{user}}', injection: { depth, order } });
    it('按真实消息计数，包含本轮输入，深度 0 在用户之后、预填之前', () => {
        const preset = parse();
        preset.document.prompts.push(prompt('d0', 0), prompt('d1', 1), prompt('d2', 2), prompt('d9', 9));
        const history: StoryApiMessage[] = [{ role: 'assistant', content: '开场白' }, { role: 'user', content: '推进' }];
        const rules: StoryApiMessage = { role: 'system', content: '规则' };
        const prefill: StoryApiMessage = { role: 'assistant', content: '预填' };
        const assembled = [rules, ...history, prefill];
        const result = injectStoryPresetDepth(assembled, preset.document, history, '$&', ['角色']);
        expect(result.map(message => message.content)).toEqual(['规则', 'd9$&', 'd2$&', '开场白', 'd1$&', '推进', 'd0$&', '预填']);
        expect(assembled).toHaveLength(4);
    });

    it('同深度按 order、酒馆消息角色优先级与原顺序；关闭项不发送', () => {
        const preset = parse();
        preset.document.prompts = [prompt('late', 1, 200), prompt('sys', 1, 100), prompt('asst', 1, 100, 'assistant'), { ...prompt('off', 1), enabled: false }, prompt('early', 1, 10)];
        const history: StoryApiMessage[] = [{ role: 'user', content: '本轮' }];
        const compiled = compileStoryPreset({ preset, slots: { ...slots, worldBefore: '' }, historyMessages: [], userName: '你', characterNames: [] });
        expect(compiled.messages).toEqual([]);
        expect(injectStoryPresetDepth(history, preset.document, history, '你', []).map(message => message.content)).toEqual(['early你', 'asst你', 'sys你', 'late你', '本轮']);
    });
});

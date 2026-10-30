import type { StoryTheaterPresetDocument, StoryTheaterPresetPrompt } from '../types';

const MARKERS: Record<string, StoryTheaterPresetPrompt['marker']> = {
    charDescription: 'characters', charPersonality: 'characters', personaDescription: 'user',
    scenario: 'scenario', dialogueExamples: 'examples', chatHistory: 'history',
    worldInfoBefore: 'world_before', worldInfoAfter: 'world_after',
};

/** Only allow prompt data and supported generation settings across the import boundary. */
export function convertTavernPreset(value: any, fallbackName: string): StoryTheaterPresetDocument {
    if (!value || !Array.isArray(value.prompts) || !value.prompts.length || !Array.isArray(value.prompt_order)) {
        throw new Error('请选择糯米机剧情预设或酒馆 Chat Completion 预设 JSON（需含 prompts 和 prompt_order）');
    }
    const orders = value.prompt_order.filter((item: any) => Array.isArray(item?.order) && item.order.length);
    const selected = orders.find((item: any) => Number(item.character_id) === 100001) || (orders.length === 1 ? orders[0] : null);
    if (!selected) throw new Error('酒馆预设没有唯一的默认提示词顺序，请在酒馆中选好预设后重新导出');
    const byId = new Map<string, any>();
    for (const prompt of value.prompts) {
        if (!prompt || typeof prompt.identifier !== 'string' || !prompt.identifier || byId.has(prompt.identifier)) {
            throw new Error('酒馆预设包含缺失或重复的提示词 identifier');
        }
        byId.set(prompt.identifier, prompt);
    }
    const notes = new Set<string>([
        '已转换为糯米机预设：角色描述、性格、卡片场景和对话示例仍使用整份角色上下文，不分别拆分；多个角色槽只发送一次。',
        '支持 {{user}}、{{char}}、{{group}}；其他酒馆宏、变量、正则、脚本、工具及专属采样参数不执行或模拟。请检查预设正文后使用。',
    ]);
    const seen = new Set<string>();
    const prompts: StoryTheaterPresetPrompt[] = [];
    const add = (source: any, enabled: boolean) => {
        const id = source.identifier;
        if (seen.has(id)) throw new Error('酒馆预设的提示词顺序包含重复条目');
        seen.add(id);
        const marker = source.marker === true ? MARKERS[id] : undefined;
        if (source.marker === true && !marker) {
            notes.add(`未识别占位符「${String(source.name || id)}」，已停用。`);
            enabled = false;
        }
        if (Array.isArray(source.injection_trigger) && source.injection_trigger.length) {
            notes.add(`「${String(source.name || id)}」有酒馆专属触发条件，已停用，请在制作器中检查后手动启用。`);
            enabled = false;
        }
        const position = Number(source.injection_position ?? 0);
        if (position !== 0 && position !== 1) throw new Error(`提示词「${String(source.name || id)}」的插入位置不受支持`);
        if (source.marker === true && position === 1) throw new Error(`占位符「${String(source.name || id)}」使用了聊天深度，请先在酒馆中改为相对位置再导出`);
        const numeric = (input: unknown, fallback: number) => Number.isFinite(Number(input)) ? Number(input) : fallback;
        prompts.push({
            id, name: String(source.name || id), enabled,
            role: source.role === 'user' || source.role === 'assistant' ? source.role : 'system',
            content: source.marker === true ? '' : String(source.content || ''),
            ...(marker ? { marker } : {}),
            ...(!source.marker && position === 1 ? { injection: {
                depth: Math.max(0, Math.min(10000, Math.round(numeric(source.injection_depth, 4)))),
                order: numeric(source.injection_order, 100),
            } } : {}),
        });
    };
    for (const item of selected.order) {
        const source = byId.get(item?.identifier);
        if (!source) throw new Error(`提示词顺序引用了不存在的条目「${String(item?.identifier || '')}」`);
        add(source, item.enabled === true);
    }
    // Unlisted prompts remain editable but must never become enabled accidentally.
    for (const [id, source] of byId) if (!seen.has(id)) add(source, false);
    const required: Array<[NonNullable<StoryTheaterPresetPrompt['marker']>, string]> = [
        ['world_before', '世界书（角色前）'], ['characters', '完整角色设定'], ['user', '当前身份'],
        ['world_after', '世界书（角色后）'], ['scenario', '当前剧情与归档'], ['history', '剧情历史'],
    ];
    const missing = required.filter(([marker]) => !prompts.some(prompt => prompt.marker === marker));
    if (missing.length) {
        notes.add(`已补入缺失的剧情连接位：${missing.map(([, name]) => name).join('、')}。原文件明确关闭的连接位保持关闭。`);
        const historyIndex = prompts.findIndex(prompt => prompt.marker === 'history');
        prompts.splice(historyIndex < 0 ? prompts.length : historyIndex, 0, ...missing.map(([marker, name]) => {
            let id = `sully-slot-${marker}`;
            while (byId.has(id)) id += '-extra';
            return { id, name, enabled: true, role: 'system' as const, content: '', marker };
        }));
    }
    return {
        schema: 'sullyos.story-preset', version: 1, name: String(value.name || fallbackName), layout: 'tavern',
        importNotes: [...notes],
        generation: {
            temperature: value.temperature, topP: value.top_p,
            frequencyPenalty: value.frequency_penalty, presencePenalty: value.presence_penalty,
            maxTokens: value.openai_max_tokens,
        },
        prompts, assistantPrefill: typeof value.assistant_prefill === 'string' ? value.assistant_prefill : '',
    };
}

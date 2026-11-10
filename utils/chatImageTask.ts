import type { ApiPreset, CharacterProfile, ImageGenerationConfig, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { createDialogueFetch } from './dialogueTransport';
import { extractContent } from './safeApi';
import { imageInstruction, readImageGenerationConfig, resolveImageSelection, resolveImageTextApi } from './chatImageConfig';
import { buildImageRequest, generateChatImage } from './chatImageGeneration';
import { saveGeneratedChatImage } from './chatImageLibrary';

const pending = new Set<string>();
export async function generateAndSaveChatImage(char: CharacterProfile, user: UserProfile, requirement: string, options: {
    config?: ImageGenerationConfig; presets?: ApiPreset[]; signal?: AbortSignal; imagePresetId?: string;
    onProgress?: (text: string) => void;
} = {}) {
    if (pending.has(char.id)) throw new Error('这个角色已有图片正在生成，请等待完成');
    const config = structuredClone(options.config || readImageGenerationConfig());
    const selection = resolveImageSelection(config, char);
    if (!selection?.api || selection.missingPreset) throw new Error('请在神经链接选择有效的生图接口与提示词版本');
    buildImageRequest(selection.provider, selection.api, requirement); // Validate before any paid text call.
    let presets = options.presets;
    if (!presets) { try { presets = JSON.parse(localStorage.getItem('os_api_presets') || '[]'); } catch { presets = []; } }
    const api = resolveImageTextApi(config, char, presets || []);
    const instructions = imageInstruction(config, char);
    pending.add(char.id);
    try {
        options.signal?.throwIfAborted(); options.onProgress?.('正在整理图片提示词…');
        const messages = await ContextBuilder.buildCharacterRequest({ char, user, instructions:
            '本次是独立的图片提示词整理任务，不是聊天回复。只输出可直接提交给 ' + selection.provider.toUpperCase() + ' 的图片提示词，不要解释、标签或代码块。\n用户选择的生图规则：\n' + instructions },
            [{ role: 'user', content: requirement.trim() }]);
        options.signal?.throwIfAborted();
        const data = await createDialogueFetch(api)(api.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
            method: 'POST', signal: options.signal,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + api.apiKey },
            body: JSON.stringify({ model: api.model, messages, stream: false, max_tokens: 1600, ...(typeof api.temperature === 'number' ? { temperature: api.temperature } : {}) }),
        }, 0, 0, { appName: '消息', charId: char.id, charName: char.name, purpose: '生图提示词整理' });
        const prompt = extractContent(data).trim();
        if (!prompt) throw new Error('生图文字 API 返回了空提示词，未调用生图接口');
        options.signal?.throwIfAborted(); options.onProgress?.('正在生成图片…');
        const imageRef = await generateChatImage(char, prompt, { config, signal: options.signal, presetId: selection.provider === 'oai' ? options.imagePresetId : undefined });
        options.onProgress?.('正在保存到本机…');
        return await saveGeneratedChatImage({ characterId: char.id, provider: selection.provider, requirement: requirement.trim(), prompt, imageRef });
    } finally { pending.delete(char.id); }
}

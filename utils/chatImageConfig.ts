import type { ApiPreset, CharacterProfile, ImageGenerationConfig } from '../types';
import { configFromPreset } from './apiPresetSwitch';

export const DEFAULT_IMAGE_CAPABILITY = '你可以在合适时机生成并发送图片，例如自拍、眼前景色或对话中提到的画面。只在确实适合时发图，不要每轮都发。';
export const DEFAULT_IMAGE_INSTRUCTION = '根据当前角色与聊天情境，写出具体、清晰的图片生成提示词，明确人物、动作、场景、构图和画风。不要在提示词里写聊天回复。';
export function readImageGenerationConfig(): ImageGenerationConfig {
    try { return JSON.parse(localStorage.getItem('os_api_config') || '{}').imageGeneration || {}; }
    catch { return {}; }
}
export function resolveImageSelection(config: ImageGenerationConfig, char: CharacterProfile) {
    const provider = char.imageGenerationSelection?.provider;
    if (provider !== 'oai' && provider !== 'nai') return undefined;
    const presetId = char.imageGenerationSelection?.presetId;
    const preset = config.presets?.[provider]?.find(item => item.id === presetId);
    return { provider, api: config[provider], preset, missingPreset: !!presetId && !preset };
}
export function imageInstruction(config: ImageGenerationConfig, char: CharacterProfile): string {
    const selection = resolveImageSelection(config, char);
    if (!selection || selection.missingPreset) throw new Error('请在神经链接重新选择生图提示词版本');
    if (selection.provider === 'oai') return '根据当前角色与情境，用中文写出具体、清晰的画面描述，包含人物、动作和场景。不要拼接、翻译或改写风格预设。';
    return selection.preset?.content?.trim() || DEFAULT_IMAGE_INSTRUCTION;
}
export function resolveImageTextApi(config: ImageGenerationConfig, char: CharacterProfile, presets: ApiPreset[]) {
    const id = char.imageTextApiPresetId || config.textApiPresetId;
    const preset = presets.find(p => p.id === id);
    if (!preset) throw new Error(id ? '生图文字 API 预设已删除，请重新选择' : '请先在设置中选择生图专用文字 API 预设');
    const api = configFromPreset(preset);
    if (!api.baseUrl || !api.model) throw new Error('生图文字 API 预设缺少地址或模型');
    return api;
}
export function buildChatImagePrompt(char: CharacterProfile, config = readImageGenerationConfig()): string {
    const selection = resolveImageSelection(config, char);
    if (!char.chatImageGenerationEnabled || !selection?.api?.apiKey?.trim() || !selection.api.model.trim() || selection.missingPreset) return '';
    const faceRouting = selection.provider === 'oai' && char.imageGenerationSelection?.faceRouting;
    return '\n\n[图片生成能力]\n' + (config.systemPrompt?.trim() || DEFAULT_IMAGE_CAPABILITY)
        + '\n当前生图服务：' + selection.provider.toUpperCase()
        + '\n图片生成要求：\n' + imageInstruction(config, char)
        + (faceRouting ? '\n发图时必须在标签内容开头标明构图：[露脸] 或 [不露脸]，紧接具体画面描述。例如 <生成图片>[露脸]在窗边拍一张自拍</生成图片>。自拍、人物照或拍自己的照片默认露脸；明确只拍手、背影、遮住脸或其他没有脸的画面用不露脸。' : '')
        + '\n需要发图时，每轮最多输出一次完整标签 <生成图片>想展示的画面、人物、动作和场景要求</生成图片>，放在普通聊天正文之外。标签只用于实际生成图片，不要只声称已经发图。不要把标签写在代码块里。';
}
export const CHAT_ACTION_PROMPT = '\n\n[线上聊天动作描写]\n每轮回复可以附带一段第三人称的动作与神态描写，使用 <线上动描>描写文字</线上动描>，放在聊天正文之前。每轮最多一段。描写应自然且有实际内容，不必强行添加；没有值得描写的动作或反应时，可以省略整个标签。\n\n**描写要求：**\n1. 结合角色当前的环境、生活状态、正在进行的事情和情绪进行描写。线上聊天不意味着角色始终盯着手机或围绕用户做动作，应保持角色自身生活的连续性。\n2. 主动参考近期已经出现的动描，避免重复相同或相似的动作、神态、词语、句式及叙述结构。尤其不要反复套用固定的「看到消息—神态变化—拿起手机回复」模式。\n3. 去重不能只靠替换近义词。应真正改变描写角度和内容，可以描写姿态、行为、环境、情绪变化或正在进行的事情，也可以直接省略不必要的动作。\n4. 不要把挑眉、轻笑、垂眼、靠椅背、敲击桌面、低头打字等动作当成默认素材。避免为了丰富描写而堆砌无意义的小动作和修饰词。自然、具体、符合情境优先于华丽。\n5. 使用第三人称，不代写用户的动作、神态、心理或反应。每段动描首次提及角色时，主语使用角色的名字，之后可根据语境使用合适的代称。\n\n不加括号，不把动作混进聊天台词。与双语、语音或其他输出格式并用时，该标签独立放在其外部。';

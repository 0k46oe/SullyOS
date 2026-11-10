import type { CharacterProfile, ImageGenerationConfig, ImageGenerationProvider, ImagePromptPreset } from '../types';
import { getProxyWorkerUrl } from './proxyWorker';
import { putImageBlob } from './blobRef';
import { readImageGenerationConfig, resolveImageSelection } from './chatImageConfig';
import { buildNaiRequest, buildOaiRequest, oaiImageMime } from './imageGenerationParams';
export class ImageGenerationFailure extends Error {}
function imageEndpoint(provider: ImageGenerationProvider, base: string): string {
    const raw = base.trim() || (provider === 'oai' ? 'https://api.openai.com/v1' : 'https://image.novelai.net');
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('生图地址请填写不含查询参数的 HTTPS 地址');
    const suffix = provider === 'oai' ? '/images/generations' : '/ai/generate-image';
    const path = url.pathname.replace(/\/+$/, '');
    if (!path.endsWith(suffix)) url.pathname = path + suffix;
    // Same fixed-host relay as TTS; custom CORS-enabled gateways are contacted directly.
    if ((provider === 'nai' && url.origin === 'https://image.novelai.net') || (provider === 'oai' && url.origin === 'https://api.openai.com')) {
        return getProxyWorkerUrl() + '/image-generation/' + provider;
    }
    return url.href;
}
export function buildImageRequest(provider: ImageGenerationProvider, api: NonNullable<ImageGenerationConfig['oai']>, prompt: string) {
    if (!prompt.trim()) throw new Error('请填写图片生成要求');
    if (!api.apiKey.trim() || !api.model.trim()) throw new Error('请先在设置中填写所选生图接口的 Key 和模型');
    return provider === 'oai'
        ? buildOaiRequest(api, prompt)
        : buildNaiRequest(api, prompt.trim(), () => crypto.getRandomValues(new Uint32Array(1))[0]);
}
export function composeOaiImagePrompt(prompt: string, preset?: ImagePromptPreset): string {
    if (!preset) return prompt;
    const positive = preset.positivePrompt ?? preset.content ?? '';
    const negative = preset.negativePrompt ?? '';
    if (!positive.trim() && !negative.trim()) return prompt;
    return ['角色画面描述：\n' + prompt, ...(positive.trim() ? ['正向提示词：\n' + positive] : []), ...(negative.trim() ? ['反向约束：\n' + negative] : [])].join('\n\n');
}
export async function generateChatImage(char: CharacterProfile, prompt: string, options: { config?: ImageGenerationConfig; signal?: AbortSignal; presetId?: string } = {}): Promise<string> {
    const config = options.config || readImageGenerationConfig();
    const selection = resolveImageSelection(config, char);
    if (!selection?.api) throw new Error('请先在神经链接选择生图接口和提示词');
    if (selection.missingPreset && options.presetId === undefined) throw new Error('选择的生图提示词已删除，请重新选择');
    if (!prompt.trim()) throw new Error('请填写图片生成要求');
    const preset = options.presetId === undefined ? selection.preset : config.presets?.[selection.provider]?.find(p => p.id === options.presetId);
    if (options.presetId !== undefined && !preset) throw new Error('所选生图预设已删除，请重新选择');
    const body = buildImageRequest(selection.provider, selection.api, selection.provider === 'oai' ? composeOaiImagePrompt(prompt, preset) : prompt);
    const endpoint = imageEndpoint(selection.provider, selection.api.baseUrl);
    options.signal?.throwIfAborted();
    let response: Response;
    try {
        response = await fetch(endpoint, {
            method: 'POST', signal: options.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + selection.api.apiKey.trim() }, body: JSON.stringify(body),
        });
    } catch (error) {
        options.signal?.throwIfAborted();
        throw new ImageGenerationFailure('生图连接失败，请检查接口与网络；官方接口需要已更新的网络代理，自定义接口需要允许跨域。');
    }
    if (!response.ok) throw new ImageGenerationFailure('生图失败（HTTP ' + response.status + '），请检查模型、额度和接口配置；未自动重试。');
    let blob: Blob;
    try {
    if (selection.provider === 'nai') {
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(await response.arrayBuffer());
        const entry = Object.values(zip.files).find(file => !file.dir && /\.png$/i.test(file.name));
        if (!entry) throw new Error('NAI 没有返回有效的 PNG 图片');
        blob = new Blob([await entry.async('uint8array')], { type: 'image/png' });
    } else {
        const data = await response.json();
        const item = data?.data?.[0];
        if (typeof item?.b64_json === 'string' && item.b64_json) {
            const binary = atob(item.b64_json);
            const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
            blob = new Blob([bytes], { type: oaiImageMime(selection.api) });
        } else if (typeof item?.url === 'string' && /^https:\/\//i.test(item.url)) {
            const download = await fetch(item.url, { signal: options.signal, credentials: 'omit' });
            if (!download.ok) throw new Error('图片已生成，但下载失败；未重新发起生图');
            blob = await download.blob();
        } else throw new Error('OAI 没有返回图片数据或 HTTPS 图片地址');
    }
    if (!blob.size || blob.size > 32 * 1024 * 1024) throw new Error('图片为空或超过 32 MB');
    } catch (error) {
        options.signal?.throwIfAborted();
        throw new ImageGenerationFailure(error instanceof Error ? error.message : '生图返回的图片无法读取');
    }
    options.signal?.throwIfAborted();
    return putImageBlob(blob);
}

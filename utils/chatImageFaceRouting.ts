import type { CharacterProfile, ImageGenerationConfig } from '../types';

export function parseImageFaceMarker(text: string): { prompt: string; kind?: 'face' | 'noFace' } {
    const match = text.match(/^\s*[\[【](露脸|不露脸)[\]】]\s*/);
    if (!match) return { prompt: text.trim() };
    return { prompt: text.slice(match[0].length).trim(), kind: match[1] === '露脸' ? 'face' : 'noFace' };
}

export async function resolveAutomaticImagePreset(char: CharacterProfile, config: ImageGenerationConfig, text: string, signal?: AbortSignal): Promise<{ prompt: string; presetId?: string } | null> {
    const routing = char.imageGenerationSelection?.provider === 'oai' ? char.imageGenerationSelection.faceRouting : undefined;
    if (!routing && !char.fixedImageFacePrompt?.trim()) return { prompt: text };
    const presets = config.presets?.oai || [];
    const face = presets.find(p => p.id === routing?.facePresetId);
    const noFace = presets.find(p => p.id === routing?.noFacePresetId);
    if (routing && (!face || !noFace)) throw new Error('请在神经链接为自动发图选择有效的露脸与不露脸预设');
    const scene = await resolveFaceScene(char, text, signal, face?.name, noFace?.name);
    if (!scene) return null;
    return { prompt: scene.prompt, ...(routing ? { presetId: scene.kind === 'face' ? face!.id : noFace!.id } : {}) };
}

export async function resolveFaceScene(char: CharacterProfile, text: string, signal?: AbortSignal, faceName = '使用固定五官', noFaceName = '不使用固定五官') {
    const parsed = parseImageFaceMarker(text);
    if (!parsed.prompt) throw new Error('角色没有提供图片画面描述');
    signal?.throwIfAborted();
    const kind = parsed.kind ?? await chooseFaceKind(parsed.prompt, faceName, noFaceName, signal);
    if (!kind) return null;
    const fixed = char.fixedImageFacePrompt;
    const prompt = kind === 'face' && fixed?.trim()
        ? (char.imageGenerationSelection?.provider === 'nai' ? `${fixed}, ${parsed.prompt}` : `当前角色的固定五官：${fixed}\n画面：${parsed.prompt}`)
        : parsed.prompt;
    return { kind, prompt };
}

function chooseFaceKind(prompt: string, faceName: string, noFaceName: string, signal?: AbortSignal): Promise<'face' | 'noFace' | null> {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px';
        const panel = document.createElement('div');
        panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', '确认角色是否露脸');
        panel.style.cssText = 'background:#fffcf7;color:#4f493f;border-radius:20px;padding:22px;max-width:480px;width:100%;max-height:80vh;overflow:auto;box-shadow:0 8px 30px #0003';
        const title = document.createElement('h2'); title.textContent = '这张图里，当前角色露脸吗？'; title.style.cssText = 'font-size:18px;font-weight:bold;margin:0 0 10px';
        const info = document.createElement('p'); info.textContent = '角色没有给出可识别的露脸标记，请查看画面描述并选择。'; info.style.cssText = 'font-size:14px;line-height:1.6;margin:0 0 12px';
        const description = document.createElement('div'); description.textContent = prompt; description.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f1e8;border-radius:12px;padding:12px;margin-bottom:14px;max-height:40vh;overflow:auto';
        panel.append(title, info, description);
        const finish = (value: 'face' | 'noFace' | null) => { signal?.removeEventListener('abort', abort); document.removeEventListener('keydown', escape); overlay.remove(); resolve(value); };
        const abort = () => finish(null);
        const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') finish(null); };
        for (const [label, value] of [[`露脸 · ${faceName}`, 'face'], [`不露脸 · ${noFaceName}`, 'noFace'], ['取消生图', null]] as const) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
            button.style.cssText = 'display:block;width:100%;padding:12px;margin-top:8px;border:1px solid #ddd3c3;border-radius:12px;background:#fff;color:#4f493f;text-align:center;cursor:pointer';
            button.onclick = () => finish(value); panel.append(button);
        }
        overlay.append(panel); document.body.append(overlay); signal?.addEventListener('abort', abort, { once: true }); document.addEventListener('keydown', escape);
        panel.querySelector('button')?.focus();
    });
}

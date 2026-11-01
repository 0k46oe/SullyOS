/**
 * 聊天生图的接口参数：选项列表、按模型的校验、请求体构建。
 *
 * OAI：参数与取值来自 OpenAI 官方 SDK（openai 7.47.0 resources/images.d.ts 的 ImageGenerateParams）。
 *   用户没改的参数一律不发送，交给接口默认值，这样第三方 OAI 兼容中转也不会因为不认识的字段报错。
 * NAI：官方文档（image.novelai.net/docs）当前网络无法访问，按 NovelAI 网页版公开的参数整理；
 *   参数名与默认值需要以网页版实际请求为准，改动前先对照。
 */
import type { ImageGenerationApi } from '../types';

export interface ParamOption<T extends string | number = string> { value: T; label: string }

// ─── OAI ─────────────────────────────────────────────

export const DEFAULT_OAI_MODEL = 'gpt-image-2.5-flare';
export const OAI_MODEL_SUGGESTIONS = [
    'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini', 'chatgpt-image-latest', 'dall-e-3', 'dall-e-2',
];
/** 官方已停用的模型（2026-10-23 停用 gpt-image-1） */
export const OAI_RETIRED_MODELS: Record<string, string> = {
    'gpt-image-1': 'gpt-image-1 已于 2026 年 10 月 23 日被 OpenAI 停用，请改用 gpt-image-2.5-flare 或 gpt-image-2.5-sunburst。',
};

type OaiFamily = 'flexible' | 'gpt-image' | 'dall-e-3' | 'dall-e-2' | 'other';

/** 按模型名判断参数规则。第三方中转里的其它模型名归为 other，只做最宽松的检查 */
export function oaiModelFamily(model: string): OaiFamily {
    const m = model.trim().toLowerCase();
    if (/^gpt-image-2(\.5-(sunburst|flare))?(-\d{4}-\d{2}-\d{2})?$/.test(m)) return 'flexible';
    if (/^gpt-image-|^chatgpt-image/.test(m)) return 'gpt-image';
    if (m === 'dall-e-3') return 'dall-e-3';
    if (m === 'dall-e-2') return 'dall-e-2';
    return 'other';
}
const isGptImage = (family: OaiFamily) => family === 'flexible' || family === 'gpt-image' || family === 'other';
const is25 = (model: string) => /^gpt-image-2\.5-/.test(model.trim().toLowerCase());

/** 尺寸下拉：每个模型官方支持的固定档位；flexible / other 还可以自定义宽高 */
export function oaiSizeOptions(model: string): ParamOption[] {
    const family = oaiModelFamily(model);
    if (family === 'dall-e-2') return ['256x256', '512x512', '1024x1024'].map(value => ({ value, label: value }));
    if (family === 'dall-e-3') return [
        { value: '1024x1024', label: '1024x1024 方图' }, { value: '1792x1024', label: '1792x1024 横图' }, { value: '1024x1792', label: '1024x1792 竖图' },
    ];
    const base = [
        { value: 'auto', label: '自动' },
        { value: '1024x1024', label: '1024x1024 方图' },
        { value: '1536x1024', label: '1536x1024 横图' },
        { value: '1024x1536', label: '1024x1536 竖图' },
    ];
    return family === 'gpt-image' ? base : [...base, { value: 'custom', label: '自定义宽高' }];
}

export function oaiQualityOptions(model: string): ParamOption[] {
    const family = oaiModelFamily(model);
    if (family === 'dall-e-3') return [{ value: 'standard', label: '标准' }, { value: 'hd', label: '高清 hd' }];
    if (family === 'dall-e-2') return [{ value: 'standard', label: '标准' }];
    const options = [{ value: 'auto', label: '自动' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }];
    return is25(model) || family === 'other'
        ? [...options, { value: 'xhigh', label: '更高 xhigh（仅 2.5 系列）' }, { value: 'max', label: '最高 max（仅 2.5 系列）' }]
        : options;
}

/** 当前模型是否支持这些 GPT Image 专属参数（背景、格式、压缩、审核） */
export function oaiSupportsGptImageOptions(model: string): boolean {
    return isGptImage(oaiModelFamily(model));
}

/**
 * 尺寸下拉当前应选中的值。旧配置没有 size 只有 width/height：能对上档位就用档位，
 * 模型允许自定义就当自定义；都不行（或换了模型后旧档位不再支持）回到 1024x1024。
 * 界面显示和实际发送都走这里，保证两边一致。
 */
export function oaiSizeChoice(api: ImageGenerationApi): string {
    const options = oaiSizeOptions(api.model).map(option => option.value);
    if (api.size && options.includes(api.size)) return api.size;
    const legacy = `${api.width ?? 1024}x${api.height ?? 1024}`;
    if (!api.size && options.includes(legacy)) return legacy;
    if ((!api.size || api.size === 'custom') && options.includes('custom')) return 'custom';
    return options.includes('1024x1024') ? '1024x1024' : options[0];
}

/** 实际发送的 size 字符串 */
export function resolveOaiSize(api: ImageGenerationApi): string {
    const choice = oaiSizeChoice(api);
    return choice === 'custom' ? `${api.width ?? 1024}x${api.height ?? 1024}` : choice;
}

export function oaiSizeError(model: string, size: string): string | null {
    const family = oaiModelFamily(model);
    const fixed = oaiSizeOptions(model).map(option => option.value).filter(value => value !== 'custom');
    if (size === 'auto') return fixed.includes('auto') ? null : '这个模型不支持自动尺寸';
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match) return '尺寸格式应为 宽x高，例如 1536x864';
    const width = Number(match[1]), height = Number(match[2]);
    if (family === 'flexible') {
        if (width % 16 || height % 16) return '宽和高都必须是 16 的倍数';
        if (width / height > 3 || height / width > 3) return '长宽比必须在 1:3 到 3:1 之间';
        if (Math.max(width, height) > 3840 || width * height > 3840 * 2160) return '最大支持 3840x2160';
        return null;
    }
    if (family === 'other') return width > 0 && height > 0 && width <= 4096 && height <= 4096 ? null : '宽和高须在 1～4096 之间';
    return fixed.includes(size) ? null : `这个模型只支持：${fixed.filter(value => value !== 'auto').join('、')}`;
}

export function buildOaiRequest(api: ImageGenerationApi, prompt: string): Record<string, unknown> {
    const model = api.model.trim();
    if (OAI_RETIRED_MODELS[model]) throw new Error(OAI_RETIRED_MODELS[model]);
    const size = resolveOaiSize(api);
    const sizeError = oaiSizeError(model, size);
    if (sizeError) throw new Error(sizeError);
    const body: Record<string, unknown> = { model, prompt, n: 1, size };
    if (api.quality && oaiQualityOptions(model).some(option => option.value === api.quality)) body.quality = api.quality;
    if (oaiSupportsGptImageOptions(model)) {
        if (api.background && api.background !== 'auto') {
            if (api.background === 'transparent' && api.outputFormat === 'jpeg') throw new Error('透明背景需要 PNG 或 WebP 格式');
            body.background = api.background;
        }
        if (api.outputFormat) body.output_format = api.outputFormat;
        if (api.outputCompression != null && (api.outputFormat === 'jpeg' || api.outputFormat === 'webp')) {
            if (!Number.isInteger(api.outputCompression) || api.outputCompression < 0 || api.outputCompression > 100) throw new Error('压缩率须为 0～100 的整数');
            body.output_compression = api.outputCompression;
        }
        if (api.moderation === 'low') body.moderation = 'low';
    }
    return body;
}

export function oaiImageMime(api: ImageGenerationApi): string {
    return api.outputFormat === 'jpeg' ? 'image/jpeg' : api.outputFormat === 'webp' ? 'image/webp' : 'image/png';
}

// ─── NAI ─────────────────────────────────────────────

export const DEFAULT_NAI_MODEL = 'nai-diffusion-4-5-full';
export const NAI_MODEL_OPTIONS: ParamOption[] = [
    { value: 'nai-diffusion-4-5-full', label: 'NAI Diffusion V4.5 Full' },
    { value: 'nai-diffusion-4-5-curated', label: 'NAI Diffusion V4.5 Curated' },
    { value: 'nai-diffusion-4-full', label: 'NAI Diffusion V4 Full' },
    { value: 'nai-diffusion-4-curated-preview', label: 'NAI Diffusion V4 Curated' },
    { value: 'nai-diffusion-3', label: 'NAI Diffusion Anime V3' },
    { value: 'nai-diffusion-furry-3', label: 'NAI Diffusion Furry V3' },
];
export const NAI_SAMPLER_OPTIONS: ParamOption[] = [
    { value: 'k_euler_ancestral', label: 'Euler Ancestral（默认）' },
    { value: 'k_euler', label: 'Euler' },
    { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
    { value: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
    { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
    { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
];
export const NAI_UC_PRESET_OPTIONS: ParamOption<number>[] = [
    { value: 0, label: '强（Heavy）' },
    { value: 1, label: '轻（Light）' },
];
export const NAI_SIZE_PRESETS: ParamOption[] = [
    { value: '832x1216', label: '832x1216 竖图' },
    { value: '1216x832', label: '1216x832 横图' },
    { value: '1024x1024', label: '1024x1024 方图' },
];

export const isNaiV4 = (model: string) => /^nai-diffusion-4/.test(model.trim());

/** V4 系列没有 native 噪声调度 */
export function naiNoiseScheduleOptions(model: string): ParamOption[] {
    const options = [
        { value: 'karras', label: 'Karras' },
        { value: 'exponential', label: 'Exponential' },
        { value: 'polyexponential', label: 'Polyexponential' },
    ];
    return isNaiV4(model) ? options : [{ value: 'native', label: 'Native' }, ...options];
}

export const NAI_DEFAULTS = { width: 832, height: 1216, steps: 28, scale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral', qualityToggle: true, ucPreset: 0 };
/** Opus 订阅免费额度：单张、28 步以内、不超过 1024x1024 的像素数 */
export const NAI_FREE_LIMIT = { steps: 28, pixels: 1024 * 1024 };
export const NAI_MAX_SEED = 4294967295;

export function naiNoiseSchedule(api: ImageGenerationApi): string {
    const options = naiNoiseScheduleOptions(api.model).map(option => option.value);
    return api.noiseSchedule && options.includes(api.noiseSchedule) ? api.noiseSchedule : (isNaiV4(api.model) ? 'karras' : 'native');
}

/** 超出 Opus 免费额度时提示会消耗 Anlas；没超出返回 null */
export function naiCostWarning(api: ImageGenerationApi): string | null {
    const width = api.width ?? NAI_DEFAULTS.width, height = api.height ?? NAI_DEFAULTS.height;
    const steps = api.steps ?? NAI_DEFAULTS.steps;
    return width * height > NAI_FREE_LIMIT.pixels || steps > NAI_FREE_LIMIT.steps
        ? '超过 1024x1024 的像素数或超过 28 步，Opus 会员也会消耗 Anlas 点数。'
        : null;
}

export function naiParamError(api: ImageGenerationApi): string | null {
    const width = api.width ?? NAI_DEFAULTS.width, height = api.height ?? NAI_DEFAULTS.height;
    if (![width, height].every(n => Number.isSafeInteger(n) && n >= 64 && n <= 4096 && n % 64 === 0)) return '宽和高须为 64～4096 内的 64 倍数';
    const steps = api.steps ?? NAI_DEFAULTS.steps;
    if (!Number.isInteger(steps) || steps < 1 || steps > 50) return '步数须为 1～50 的整数';
    const scale = api.scale ?? NAI_DEFAULTS.scale;
    if (!Number.isFinite(scale) || scale < 0 || scale > 10) return '提示词引导须在 0～10 之间';
    const rescale = api.cfgRescale ?? NAI_DEFAULTS.cfgRescale;
    if (!Number.isFinite(rescale) || rescale < 0 || rescale > 1) return '引导缩放须在 0～1 之间';
    if (api.seed != null && (!Number.isSafeInteger(api.seed) || api.seed < 0 || api.seed > NAI_MAX_SEED)) return `种子须为 0～${NAI_MAX_SEED} 的整数`;
    if (api.sampler && !NAI_SAMPLER_OPTIONS.some(option => option.value === api.sampler)) return '不支持的采样器';
    return null;
}

export function buildNaiRequest(api: ImageGenerationApi, prompt: string, randomSeed: () => number): Record<string, unknown> {
    const error = naiParamError(api);
    if (error) throw new Error(error);
    const model = api.model.trim();
    const v4 = isNaiV4(model);
    const negative = api.negativePrompt || '';
    const sampler = api.sampler || NAI_DEFAULTS.sampler;
    const parameters: Record<string, unknown> = {
        params_version: 3,
        width: api.width ?? NAI_DEFAULTS.width,
        height: api.height ?? NAI_DEFAULTS.height,
        scale: api.scale ?? NAI_DEFAULTS.scale,
        cfg_rescale: api.cfgRescale ?? NAI_DEFAULTS.cfgRescale,
        sampler,
        steps: api.steps ?? NAI_DEFAULTS.steps,
        n_samples: 1,
        seed: api.seed ?? randomSeed(),
        ucPreset: api.ucPreset ?? NAI_DEFAULTS.ucPreset,
        qualityToggle: api.qualityToggle ?? NAI_DEFAULTS.qualityToggle,
        negative_prompt: negative,
        noise_schedule: naiNoiseSchedule(api),
        dynamic_thresholding: false,
        prefer_brownian: true,
        deliberate_euler_ancestral_bug: false,
    };
    if (v4) {
        parameters.v4_prompt = { caption: { base_caption: prompt, char_captions: [] }, use_coords: false, use_order: true };
        parameters.v4_negative_prompt = { caption: { base_caption: negative, char_captions: [] }, legacy_uc: false };
        parameters.use_coords = false;
        parameters.characterPrompts = [];
    } else {
        // SMEA 只有 V3 有
        parameters.sm = api.smea === true;
        parameters.sm_dyn = api.smea === true && api.smeaDyn === true;
    }
    return { input: prompt, model, action: 'generate', parameters };
}

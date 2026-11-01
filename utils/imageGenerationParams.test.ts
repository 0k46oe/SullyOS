import { describe, expect, it } from 'vitest';
import type { ImageGenerationApi } from '../types';
import { buildNaiRequest, buildOaiRequest, naiCostWarning, naiNoiseScheduleOptions, oaiSizeChoice, oaiSizeError } from './imageGenerationParams';

const oai = (patch: Partial<ImageGenerationApi> = {}): ImageGenerationApi => ({ baseUrl: '', apiKey: 'k', model: 'gpt-image-2.5-flare', ...patch });
const nai = (patch: Partial<ImageGenerationApi> = {}): ImageGenerationApi => ({ baseUrl: '', apiKey: 'k', model: 'nai-diffusion-4-5-full', ...patch });

describe('OAI 请求', () => {
    it('没改的参数不发送', () => {
        expect(buildOaiRequest(oai(), '猫')).toEqual({ model: 'gpt-image-2.5-flare', prompt: '猫', n: 1, size: '1024x1024' });
    });

    it('发送用户选的画质、背景、格式、压缩、审核', () => {
        expect(buildOaiRequest(oai({ size: '1536x1024', quality: 'max', background: 'transparent', outputFormat: 'webp', outputCompression: 80, moderation: 'low' }), '猫'))
            .toMatchObject({ size: '1536x1024', quality: 'max', background: 'transparent', output_format: 'webp', output_compression: 80, moderation: 'low' });
    });

    it('压缩率只在 JPEG / WebP 时发送', () => {
        expect(buildOaiRequest(oai({ outputFormat: 'png', outputCompression: 50 }), '猫')).not.toHaveProperty('output_compression');
    });

    it('透明背景配 JPEG、已停用模型直接报错', () => {
        expect(() => buildOaiRequest(oai({ background: 'transparent', outputFormat: 'jpeg' }), '猫')).toThrow('透明背景');
        expect(() => buildOaiRequest(oai({ model: 'gpt-image-1' }), '猫')).toThrow('停用');
    });

    it('xhigh 只发给 2.5 系列，dall-e-3 不发 GPT Image 专属参数', () => {
        expect(buildOaiRequest(oai({ model: 'gpt-image-2', quality: 'xhigh' }), '猫')).not.toHaveProperty('quality');
        const dalle = buildOaiRequest(oai({ model: 'dall-e-3', size: '1792x1024', quality: 'hd', background: 'opaque', outputFormat: 'png' }), '猫');
        expect(dalle).toMatchObject({ size: '1792x1024', quality: 'hd' });
        expect(dalle).not.toHaveProperty('background');
        expect(dalle).not.toHaveProperty('output_format');
    });

    it('尺寸按模型校验', () => {
        expect(oaiSizeError('gpt-image-2', '1536x864')).toBeNull();
        expect(oaiSizeError('gpt-image-2', '1530x864')).toContain('16');
        expect(oaiSizeError('gpt-image-2', '3840x960')).toContain('1:3');
        expect(oaiSizeError('gpt-image-2', '4096x2160')).toContain('3840');
        expect(oaiSizeError('gpt-image-1.5', '1536x864')).toContain('只支持');
        expect(oaiSizeError('dall-e-3', 'auto')).not.toBeNull();
    });

    it('旧配置只有宽高时，能对上档位用档位，否则自定义', () => {
        expect(oaiSizeChoice(oai({ width: 1536, height: 1024 }))).toBe('1536x1024');
        expect(oaiSizeChoice(oai({ width: 1536, height: 864 }))).toBe('custom');
        expect(buildOaiRequest(oai({ width: 1536, height: 864 }), '猫').size).toBe('1536x864');
        // 换成只认固定档位的模型，旧的自定义尺寸回到 1024x1024
        expect(oaiSizeChoice(oai({ model: 'gpt-image-1.5', size: 'custom', width: 1536, height: 864 }))).toBe('1024x1024');
    });
});

describe('NAI 请求', () => {
    it('默认参数与 V4 提示词结构', () => {
        const body = buildNaiRequest(nai({ negativePrompt: 'lowres' }), '1girl', () => 7) as any;
        expect(body).toMatchObject({ input: '1girl', model: 'nai-diffusion-4-5-full', action: 'generate' });
        expect(body.parameters).toMatchObject({
            width: 832, height: 1216, steps: 28, scale: 5, cfg_rescale: 0, sampler: 'k_euler_ancestral',
            noise_schedule: 'karras', seed: 7, n_samples: 1, qualityToggle: true, ucPreset: 0, negative_prompt: 'lowres',
        });
        expect(body.parameters.v4_prompt.caption.base_caption).toBe('1girl');
        expect(body.parameters.v4_negative_prompt.caption.base_caption).toBe('lowres');
        expect(body.parameters).not.toHaveProperty('sm');
    });

    it('发送用户填的步数、引导、采样器、种子', () => {
        const body = buildNaiRequest(nai({ steps: 40, scale: 6.5, cfgRescale: 0.2, sampler: 'k_dpmpp_2m', noiseSchedule: 'exponential', seed: 123 }), 'x', () => 7) as any;
        expect(body.parameters).toMatchObject({ steps: 40, scale: 6.5, cfg_rescale: 0.2, sampler: 'k_dpmpp_2m', noise_schedule: 'exponential', seed: 123 });
    });

    it('V3 有 SMEA 和 native，V4 没有', () => {
        const v3 = buildNaiRequest(nai({ model: 'nai-diffusion-3', smea: true, smeaDyn: true }), 'x', () => 1) as any;
        expect(v3.parameters).toMatchObject({ sm: true, sm_dyn: true, noise_schedule: 'native' });
        expect(v3.parameters).not.toHaveProperty('v4_prompt');
        expect(naiNoiseScheduleOptions('nai-diffusion-4-5-full').map(o => o.value)).not.toContain('native');
        // V4 选了 native（从 V3 切过来的旧值）时回到 karras
        expect((buildNaiRequest(nai({ noiseSchedule: 'native' }), 'x', () => 1) as any).parameters.noise_schedule).toBe('karras');
    });

    it.each([
        [{ width: 830 }], [{ steps: 0 }], [{ steps: 51 }], [{ scale: 11 }], [{ cfgRescale: 1.5 }], [{ seed: -1 }], [{ sampler: 'ddim' }],
    ])('不合法参数报错 %o', patch => {
        expect(() => buildNaiRequest(nai(patch), 'x', () => 1)).toThrow();
    });

    it('超出 Opus 免费额度时提示', () => {
        expect(naiCostWarning(nai())).toBeNull();
        expect(naiCostWarning(nai({ steps: 29 }))).not.toBeNull();
        expect(naiCostWarning(nai({ width: 1216, height: 1216 }))).not.toBeNull();
    });
});

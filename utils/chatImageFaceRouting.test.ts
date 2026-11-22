// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseImageFaceMarker, resolveAutomaticImagePreset } from './chatImageFaceRouting';

const char: any = { imageGenerationSelection: { provider: 'oai', faceRouting: { facePresetId: 'a', noFacePresetId: 'b' } } };
const config: any = { presets: { oai: [{ id: 'a', name: '露脸' }, { id: 'b', name: '不露脸' }] } };
describe('automatic image preset routing', () => {
    it('角色自动发图时按露脸标记加入原文，兼容两种接口', async () => {
        const fixedImageFacePrompt = '灰瞳，左眼下有痣';
        expect(await resolveAutomaticImagePreset({ ...char, fixedImageFacePrompt }, config, '[露脸] 靠窗微笑'))
            .toEqual({ prompt: `当前角色的固定五官：${fixedImageFacePrompt}\n画面：靠窗微笑`, presetId: 'a' });
        const nai = { ...char, fixedImageFacePrompt, imageGenerationSelection: { provider: 'nai' } };
        expect(await resolveAutomaticImagePreset(nai, {}, '[露脸] smiling')).toEqual({ prompt: `${fixedImageFacePrompt}, smiling` });
        expect(await resolveAutomaticImagePreset(nai, {}, '[不露脸] landscape')).toEqual({ prompt: 'landscape' });
    });
    it('uses the marker and removes it from the prompt', async () => {
        expect(await resolveAutomaticImagePreset(char, config, '[露脸] 拍一张自拍')).toEqual({ prompt: '拍一张自拍', presetId: 'a' });
        expect(await resolveAutomaticImagePreset(char, config, '【不露脸】手部特写')).toEqual({ prompt: '手部特写', presetId: 'b' });
        expect(parseImageFaceMarker('只拍手')).toEqual({ prompt: '只拍手' });
    });
    it('asks the user for a missing marker and supports cancellation', async () => {
        const result = resolveAutomaticImagePreset(char, config, '窗边的人');
        expect(document.querySelector('[role=dialog]')?.textContent).toContain('窗边的人');
        const buttons = document.querySelectorAll<HTMLButtonElement>('[role=dialog] button');
        buttons[1].click();
        expect(await result).toEqual({ prompt: '窗边的人', presetId: 'b' });
        const cancelled = resolveAutomaticImagePreset(char, config, '窗边的人');
        document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')[2].click();
        expect(await cancelled).toBeNull();
    });
    it('refuses missing presets and leaves existing configurations unchanged', async () => {
        await expect(resolveAutomaticImagePreset(char, { presets: { oai: [] } }, '[露脸]自拍')).rejects.toThrow('预设');
        expect(await resolveAutomaticImagePreset({ imageGenerationSelection: { provider: 'oai' } } as any, config, '自拍')).toEqual({ prompt: '自拍' });
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateImageWithFallback } from './chatImageWithFallback';
import { generateChatImage, ImageGenerationFailure } from './chatImageGeneration';
import { saveImageTextCard } from './chatImageTextCard';

vi.mock('./chatImageGeneration', () => ({ ImageGenerationFailure: class ImageGenerationFailure extends Error {}, generateChatImage: vi.fn() }));
vi.mock('./chatImageTextCard', () => ({ saveImageTextCard: vi.fn() }));
const char = {} as any, options = { config: {} };
describe('image generation fallback', () => {
    beforeEach(() => vi.resetAllMocks());
    it('keeps successful results', async () => {
        vi.mocked(generateChatImage).mockResolvedValue('image');
        expect(await generateImageWithFallback(char, '画面', options)).toEqual({ imageRef: 'image', failed: false });
        expect(saveImageTextCard).not.toHaveBeenCalled();
    });
    it('creates a description image when generation fails', async () => {
        vi.mocked(generateChatImage).mockRejectedValue(new ImageGenerationFailure('接口失败'));
        vi.mocked(saveImageTextCard).mockResolvedValue('text-image');
        expect(await generateImageWithFallback(char, '画面', options)).toEqual({ imageRef: 'text-image', failed: true, error: '接口失败' });
        expect(saveImageTextCard).toHaveBeenCalledWith('画面');
    });
    it('does not hide configuration errors or cancelled operations', async () => {
        vi.mocked(generateChatImage).mockRejectedValue(new Error('配置错误'));
        await expect(generateImageWithFallback(char, '画面', options)).rejects.toThrow('配置错误');
        const controller = new AbortController(); controller.abort();
        vi.mocked(generateChatImage).mockRejectedValue(new ImageGenerationFailure('failed'));
        await expect(generateImageWithFallback(char, '画面', { config: {}, signal: controller.signal })).rejects.toThrow();
        expect(saveImageTextCard).not.toHaveBeenCalled();
    });
});

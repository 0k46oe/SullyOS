import { describe, expect, it, vi } from 'vitest';
import { generateAndSaveChatImage } from './chatImageTask';

const mocks = vi.hoisted(() => ({ build: vi.fn(async (..._args: any[]) => []), text: vi.fn(async () => ({ choices: [{ message: { content: '中文画面' } }] })), image: vi.fn(async () => ({ imageRef: 'image-ref', failed: false })), save: vi.fn(async () => 'saved') }));
vi.mock('./context', () => ({ ContextBuilder: { buildCharacterRequest: mocks.build } }));
vi.mock('./dialogueTransport', () => ({ createDialogueFetch: () => mocks.text }));
vi.mock('./chatImageGeneration', () => ({ buildImageRequest: vi.fn() }));
vi.mock('./chatImageWithFallback', () => ({ generateImageWithFallback: mocks.image }));
vi.mock('./chatImageLibrary', () => ({ saveGeneratedChatImage: mocks.save }));
vi.mock('./chatImageConfig', async importOriginal => ({ ...(await importOriginal<typeof import('./chatImageConfig')>()), resolveImageTextApi: () => ({ baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'text' }) }));

describe('manual OAI image generation', () => {
  it('keeps the preset from the text model and passes the description to image generation', async () => {
    const config: any = { oai: { baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'image' }, presets: { oai: [{ id: 'p', name: 'style', positivePrompt: '正向秘密', negativePrompt: '反向秘密' }] } };
    const char: any = { id: 'c', name: '角色', imageGenerationSelection: { provider: 'oai', presetId: 'p' } };
    await generateAndSaveChatImage(char, {} as any, '需求', { config, presets: [] });
    const instructions = (mocks.build.mock.calls[0][0] as any).instructions;
    expect(instructions).not.toMatch(/正向秘密|反向秘密/);
    expect(instructions).toContain('中文');
    expect(mocks.image).toHaveBeenCalledWith(char, '中文画面', expect.objectContaining({ config }));
  });
});

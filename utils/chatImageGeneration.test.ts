import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeOaiImagePrompt, generateChatImage } from './chatImageGeneration';

vi.mock('./blobRef', () => ({ putImageBlob: vi.fn(async () => 'image-ref') }));

describe('OAI image preset composition', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('preserves all text, handles empty fields, and reads legacy content', () => {
    const prompt = ' 原始中文画面\n描述 ';
    expect(composeOaiImagePrompt(prompt)).toBe(prompt);
    expect(composeOaiImagePrompt(prompt, { id: 'p', name: '旧', content: ' 旧内容 ' })).toBe('角色画面描述：\n' + prompt + '\n\n正向提示词：\n 旧内容 ');
    expect(composeOaiImagePrompt(prompt, { id: 'p', name: '空', positivePrompt: '', negativePrompt: ' 模糊 ' })).toBe('角色画面描述：\n' + prompt + '\n\n反向约束：\n 模糊 ');
  });
  it('sends the selected preset in the ordinary prompt field', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: 'YQ==' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config: any = { oai: { baseUrl: 'https://example.com/v1', apiKey: 'key', model: 'gpt-image-2.5-flare' }, presets: { oai: [{ id: 'p', name: '风格', positivePrompt: ' 正向 ', negativePrompt: ' 反向 ' }] } };
    const char: any = { imageGenerationSelection: { provider: 'oai', presetId: 'p' } };
    await expect(generateChatImage(char, '  ', { config })).rejects.toThrow('请填写图片生成要求');
    await expect(generateChatImage(char, ' 中文画面 ', { config })).resolves.toBe('image-ref');
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.prompt).toBe('角色画面描述：\n 中文画面 \n\n正向提示词：\n 正向 \n\n反向约束：\n 反向 ');
    expect(body).not.toHaveProperty('negative_prompt');
  });
  it('sends the explicitly selected preset rather than the character default', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: 'YQ==' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config: any = { oai: { baseUrl: 'https://example.com/v1', apiKey: 'key', model: 'gpt-image-2.5-flare' }, presets: { oai: [{ id: 'a', name: '露脸', positivePrompt: 'PRESET_A' }, { id: 'b', name: '不露脸', positivePrompt: 'PRESET_B' }] } };
    await generateChatImage({ imageGenerationSelection: { provider: 'oai', presetId: 'a' } } as any, '手部特写', { config, presetId: 'b' });
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.prompt).toContain('PRESET_B');
    expect(body.prompt).not.toContain('PRESET_A');
  });
});

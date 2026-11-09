import { describe, expect, it } from 'vitest';
import { buildChatImagePrompt, imageInstruction, resolveImageSelection } from './chatImageConfig';
const char = (extra: any = {}) => ({ id: 'c', name: '角色', chatImageGenerationEnabled: true, imageGenerationSelection: { provider: 'oai' }, ...extra } as any);
describe('chat image prompt config', () => {
  it('does not enable image output until API is complete', () => {
    expect(buildChatImagePrompt(char(), { oai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-image-1' } })).toBe('');
  });
  it('keeps OAI preset content out of both text prompts, including legacy data', () => {
    const config: any = { oai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-image-1' }, presets: { oai: [{ id: 'p', name: '电影', positivePrompt: '正向秘密', negativePrompt: '反向秘密', content: '旧版秘密' }] } };
    expect(resolveImageSelection(config, char({ imageGenerationSelection: { provider: 'oai', presetId: 'p' } }))?.preset?.name).toBe('电影');
    const selected = char({ imageGenerationSelection: { provider: 'oai', presetId: 'p' } });
    for (const text of [buildChatImagePrompt(selected, config), imageInstruction(config, selected)]) {
      expect(text).not.toMatch(/正向秘密|反向秘密|旧版秘密/);
      expect(text).toContain('中文');
    }
  });
  it('retains NAI preset instructions', () => {
    const config: any = { nai: { baseUrl: 'https://image.novelai.net', apiKey: 'k', model: 'nai' }, presets: { nai: [{ id: 'p', name: 'NAI', content: 'NAI 原有规则' }] } };
    const selected = char({ imageGenerationSelection: { provider: 'nai', presetId: 'p' } });
    expect(buildChatImagePrompt(selected, config)).toContain('NAI 原有规则');
  });
});


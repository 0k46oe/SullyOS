import { describe, expect, it } from 'vitest';
import { buildChatImagePrompt, resolveImageSelection } from './chatImageConfig';
const char = (extra: any = {}) => ({ id: 'c', name: '角色', chatImageGenerationEnabled: true, imageGenerationSelection: { provider: 'oai' }, ...extra } as any);
describe('chat image prompt config', () => {
  it('does not enable image output until API is complete', () => {
    expect(buildChatImagePrompt(char(), { oai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-image-1' } })).toBe('');
  });
  it('uses selected provider and named preset', () => {
    const config: any = { oai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-image-1' }, presets: { oai: [{ id: 'p', name: '电影', content: '写实电影感' }] } };
    expect(resolveImageSelection(config, char({ imageGenerationSelection: { provider: 'oai', presetId: 'p' } })).preset?.name).toBe('电影');
    expect(buildChatImagePrompt(char({ imageGenerationSelection: { provider: 'oai', presetId: 'p' } }), config)).toContain('写实电影感');
  });
});


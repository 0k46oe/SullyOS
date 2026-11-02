import { describe, expect, it } from 'vitest';
import { decorateOpenAIPromptCache } from './openaiPromptCache';

describe('OpenAI-compatible prompt caching', () => {
  const scope = { endpoint: 'https://oai.test/v1/chat/completions', model: 'gpt-test', charId: 'char-a', purpose: 'chat' };
  it('adds only the OAI prompt_cache_key and keeps the original message shape', async () => {
    const input = { model: 'gpt-test', messages: [
      { role: 'system', content: 'stable character prompt' },
      { role: 'user', content: 'hello' },
    ] };
    const result = await decorateOpenAIPromptCache(input, scope);
    expect(result.body.prompt_cache_key).toMatch(/^oai-[0-9a-f]+$/);
    expect(result.body.messages).toEqual(input.messages);
    expect(JSON.stringify(result.body)).not.toContain('cache_control');
    expect(result.diagnostic?.comparison).toBe('first');
  });

  it('reports a stable prefix on repeated requests and a changed prefix after edits', async () => {
    const scope = { endpoint: 'https://comparison.test/v1/chat/completions', model: 'gpt-test', charId: 'char-a', purpose: 'chat' };
    const first = { model: 'gpt-test', messages: [{ role: 'system', content: 'a'.repeat(9000) }, { role: 'user', content: 'one' }] };
    const second = { model: 'gpt-test', messages: [{ role: 'system', content: 'a'.repeat(9000) }, { role: 'user', content: 'two' }] };
    const changed = { model: 'gpt-test', messages: [{ role: 'system', content: 'b'.repeat(9000) }, { role: 'user', content: 'three' }] };
    expect((await decorateOpenAIPromptCache(first, scope)).diagnostic?.comparison).toBe('first');
    expect((await decorateOpenAIPromptCache(second, scope)).diagnostic?.comparison).toBe('same');
    expect((await decorateOpenAIPromptCache(changed, scope)).diagnostic?.comparison).toBe('changed');
  });

  it('does not decorate requests without a leading system prompt', async () => {
    const result = await decorateOpenAIPromptCache({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] }, scope);
    expect(result.body).not.toHaveProperty('prompt_cache_key');
    expect(result.diagnostic).toBeUndefined();
  });

  it('keeps one cache key per character while the system prompt changes', async () => {
    const scope = { endpoint: 'https://api.example.com/v1/chat/completions', model: 'gpt-x', charId: 'char-1', purpose: 'chat' };
    const a = await decorateOpenAIPromptCache({ model: 'gpt-x', messages: [{ role: 'system', content: '人设 A' }, { role: 'user', content: 'hi' }] }, scope);
    const b = await decorateOpenAIPromptCache({ model: 'gpt-x', messages: [{ role: 'system', content: '人设 A，世界书更新了' }, { role: 'user', content: 'hi' }] }, scope);
    const other = await decorateOpenAIPromptCache({ model: 'gpt-x', messages: [{ role: 'system', content: '人设 A' }, { role: 'user', content: 'hi' }] }, { ...scope, charId: 'char-2' });
    expect(b.body.prompt_cache_key).toBe(a.body.prompt_cache_key);
    expect(other.body.prompt_cache_key).not.toBe(a.body.prompt_cache_key);
  });
});

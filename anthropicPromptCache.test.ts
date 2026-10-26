import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { compareAnthropicCachePrefix, formatAnthropicCacheDiagnostic, splitAnthropicCacheText } from './anthropicPromptCache';
import { createDialogueFetch, toAnthropicBody } from './dialogueTransport';
import { DB } from './db';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const source = 'a'.repeat(40000);
const request = (text = source) => toAnthropicBody({ model: '【渠道】custom-model', messages: [
  { role: 'system', content: text }, { role: 'user', content: 'current message' }, { role: 'system', content: 'volatile context' },
] });
const scope = (name: string) => ({ endpoint: `https://${name}.test/v1/messages`, credential: 'fake-secret', charId: 'role-a', purpose: '聊天回复' });

it.each(['', '短人设', source, 'a'.repeat(8191) + '🙂' + '\n\n' + '后文'.repeat(18000)])('keeps exact prompt text and whole Unicode characters when segmenting', text => {
  const parts = splitAnthropicCacheText(text);
  expect(parts.join('')).toBe(text); expect(parts.length).toBeLessThanOrEqual(4);
  for (const part of parts) {
    expect(part).not.toMatch(/^[\uDC00-\uDFFF]/); expect(part).not.toMatch(/[\uD800-\uDBFF]$/);
  }
});

it('uses at most four stable checkpoints and keeps all volatile system blocks outside them', () => {
  const payload = request();
  expect(payload.system.filter((part: any) => part.cache_control)).toHaveLength(4);
  expect(payload.system.slice(0, -1).map((part: any) => part.text).join('')).toBe(source);
  expect(payload.system.at(-1)).toEqual({ type: 'text', text: 'volatile context' });
  const changed = request(source.slice(0, -1) + 'b');
  expect(changed.system.slice(0, 3)).toEqual(payload.system.slice(0, 3));
});

it('preserves original multi-block system boundaries and whitespace', () => {
  const blocks = [{ type: 'text', text: ' first\n' }, { type: 'text', text: '\nsecond ' }];
  const payload = toAnthropicBody({ messages: [{ role: 'system', content: blocks }, { role: 'user', content: 'hi' }] });
  expect(payload.system).toEqual([blocks[0], { ...blocks[1], cache_control: { type: 'ephemeral' } }]);
  expect(blocks[1]).not.toHaveProperty('cache_control');
});

it('compares only actual cached prefixes, including native tools and thinking, without exporting secrets or hashes', async () => {
  const key = scope('comparison');
  expect((await compareAnthropicCachePrefix(key, request()))?.comparison).toBe('first');
  const next = request(); next.system.at(-1).text = 'new clock'; next.messages[0].content[0].text = 'new user message';
  const same = await compareAnthropicCachePrefix(key, next);
  expect(same).toMatchObject({ comparison: 'same', breakpoints: 4, matchedPrefixChars: source.length });
  const partial = await compareAnthropicCachePrefix(key, request(source.slice(0, -1) + 'b'));
  expect(partial).toMatchObject({ comparison: 'partial', matchedPrefixChars: 32768 });
  expect((await compareAnthropicCachePrefix(key, request('b' + source.slice(1))))?.comparison).toBe('changed');
  const withTools = { ...request('b' + source.slice(1)), tools: [{ name: 'tool', input_schema: { type: 'object' } }] };
  expect((await compareAnthropicCachePrefix(key, withTools))?.comparison).toBe('changed');
  expect((await compareAnthropicCachePrefix(key, { ...withTools, thinking: { type: 'enabled', budget_tokens: 4000 } }))?.comparison).toBe('changed');
  expect(JSON.stringify(same)).not.toContain(key.credential); expect(JSON.stringify(same)).not.toContain('aaaa');
  expect(formatAnthropicCacheDiagnostic(same!)).toContain('不代表上游已命中');
});

it('separates endpoints, credentials, roles, purposes and exact model IDs', async () => {
  const key = scope('separation'); await compareAnthropicCachePrefix(key, request());
  for (const patch of [{ endpoint: 'https://different.test' }, { credential: 'different-key' }, { charId: 'role-b' }, { purpose: '测试连接' }]) {
    expect((await compareAnthropicCachePrefix({ ...key, ...patch }, request()))?.comparison).toBe('first');
  }
  expect((await compareAnthropicCachePrefix(key, { ...request(), model: '【另一个渠道】custom-model' }))?.comparison).toBe('first');
});

it('skips disabled caches and treats unavailable hashing as optional diagnostics', async () => {
  expect(await compareAnthropicCachePrefix(scope('disabled'), { system: 'uncached' })).toBeUndefined();
  expect(await compareAnthropicCachePrefix(scope('disabled'), { system: [{ type: 'text', text: 'uncached' }] })).toBeUndefined();
  vi.stubGlobal('crypto', {});
  expect(await compareAnthropicCachePrefix(scope('no-crypto'), request())).toBeUndefined();
});

it('reports same local prefix alongside provider-reported zero reads, without turning it into a hit', async () => {
  const append = vi.spyOn(DB, 'appendApiCallLog').mockResolvedValue(undefined as any);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000 } })))));
  const send = createDialogueFetch({ protocol: 'anthropic', baseUrl: 'https://zero-read.test', apiKey: 'fake-only', model: 'prefixed-model' });
  for (let i = 0; i < 2; i++) await send('unused', { body: JSON.stringify({ model: 'prefixed-model', messages: [{ role: 'system', content: source }, { role: 'user', content: String(i) }] }) }, 0);
  await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(2));
  expect(append.mock.calls[1][0]).toMatchObject({ cacheReadTokens: 0, cacheCreationTokens: 5000, cacheDiagnostic: { comparison: 'same' } });
  expect(JSON.stringify(append.mock.calls)).not.toContain('fake-only'); expect(JSON.stringify(append.mock.calls)).not.toContain(source);
});

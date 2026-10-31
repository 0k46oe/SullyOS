import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { compareAnthropicCachePrefix, formatAnthropicCacheDiagnostic } from './anthropicPromptCache';
import { createDialogueFetch } from './dialogueTransport';
import { toAnthropicRequest as toAnthropicBody } from './anthropicApi';
import { DB } from './db';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const source = 'a'.repeat(40000);
const request = (text = source) => toAnthropicBody({ model: '【渠道】custom-model', messages: [
  { role: 'system', content: text }, { role: 'user', content: 'current message' }, { role: 'system', content: 'volatile context' },
] });
const scope = (name: string) => ({ endpoint: `https://${name}.test/v1/messages`, credential: 'fake-secret', charId: 'role-a', purpose: '聊天回复' });

it('keeps volatile system reminders after history outside the cached system', () => {
  const payload = request();
  expect(payload.system.filter((part: any) => part.cache_control)).toHaveLength(1);
  expect(payload.system[0].text).toBe(source);
  expect(payload.messages.at(-1).content.at(-1).text).toContain('volatile context');
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
  const next = request(); next.messages.at(-1).content.at(-1).text = 'new clock'; next.messages[0].content[0].text = 'new user message';
  const same = await compareAnthropicCachePrefix(key, next);
  expect(same).toMatchObject({ comparison: 'same', breakpoints: 1 });
  const changed = await compareAnthropicCachePrefix(key, request(source.slice(0, -1) + 'b'));
  expect(changed).toMatchObject({ comparison: 'changed' });
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
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ type:'message', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000 } })))));
  const send = createDialogueFetch({ protocol: 'anthropic', baseUrl: 'https://zero-read.test', apiKey: 'fake-only', model: 'prefixed-model' });
  for (let i = 0; i < 2; i++) await send('unused', { method:'POST', body: JSON.stringify({ model: 'prefixed-model', messages: [{ role: 'system', content: source }, { role: 'user', content: String(i) }] }) }, 0);
  await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(2));
  expect(append.mock.calls[1][0]).toMatchObject({ cacheReadTokens: 0, cacheCreationTokens: 5000, cacheDiagnostic: { comparison: 'same' } });
  expect(JSON.stringify(append.mock.calls)).not.toContain('fake-only'); expect(JSON.stringify(append.mock.calls)).not.toContain(source);
});

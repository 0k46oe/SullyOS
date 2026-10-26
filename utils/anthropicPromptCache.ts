export interface AnthropicCacheDiagnostic {
  comparison: 'first' | 'same' | 'partial' | 'changed';
  breakpoints: number;
  prefixChars: number;
  matchedPrefixChars: number;
  elapsedMs?: number;
}

/** Fixed leading boundaries keep earlier checkpoints stable when a later part
 * of the prompt changes. Text order, whitespace and surrogate pairs survive.
 * These are character boundaries, never a claim about provider token limits. */
export function splitAnthropicCacheText(text: string): string[] {
  if (!text) return [];
  const parts: string[] = [];
  let start = 0;
  for (const target of [8192, 16384, 32768]) {
    if (target >= text.length) break;
    const newline = text.lastIndexOf('\n', target - 1);
    let end = newline >= target - 1024 ? newline + 1 : target;
    if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    if (end > start) { parts.push(text.slice(start, end)); start = end; }
  }
  parts.push(text.slice(start));
  return parts;
}

// Session-only, bounded comparison. No prompt, API key or digest is persisted
// in normal logs. Only the comparison and character counts leave this module.
const recent = new Map<string, { hashes: string[]; at: number }>();
const digest = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
};

export async function compareAnthropicCachePrefix(
  scope: { endpoint: string; credential: string; charId?: string; purpose?: string },
  body: Record<string, any>,
): Promise<AnthropicCacheDiagnostic | undefined> {
  try {
    if (!Array.isArray(body.system)) return undefined;
    const checkpoints = body.system.flatMap((block: any, index: number) => block?.cache_control?.type === 'ephemeral' ? [index] : []);
    if (!checkpoints.length) return undefined;
    const key = await digest(JSON.stringify([scope.endpoint, scope.credential, body.model, scope.charId, scope.purpose]));
    const hashes = await Promise.all(checkpoints.map(index => digest(JSON.stringify({
      model: body.model, tools: body.tools, tool_choice: body.tool_choice, thinking: body.thinking,
      system: body.system.slice(0, index + 1),
    }))));
    const previous = recent.get(key);
    const at = Date.now();
    let matched = -1;
    if (previous) for (let i = 0; i < hashes.length; i++) {
      if (previous.hashes[i] !== hashes[i]) break;
      matched = i;
    }
    const charsThrough = (index: number) => body.system.slice(0, index + 1).reduce((sum: number, block: any) => sum + (typeof block.text === 'string' ? block.text.length : 0), 0);
    recent.delete(key); recent.set(key, { hashes, at });
    if (recent.size > 64) recent.delete(recent.keys().next().value!);
    return {
      comparison: !previous ? 'first' : matched === hashes.length - 1 && hashes.length === previous.hashes.length ? 'same' : matched >= 0 ? 'partial' : 'changed',
      breakpoints: hashes.length, prefixChars: charsThrough(checkpoints[checkpoints.length - 1]),
      matchedPrefixChars: matched < 0 ? 0 : charsThrough(checkpoints[matched]),
      ...(previous ? { elapsedMs: Math.max(0, at - previous.at) } : {}),
    };
  } catch {
    // Missing WebCrypto or diagnostics failure must never block a conversation.
    return undefined;
  }
}

export function formatAnthropicCacheDiagnostic(value: AnthropicCacheDiagnostic): string {
  const detail = value.comparison === 'first' ? '本页首次请求，暂无前缀对比'
    : value.comparison === 'same' ? '缓存前缀与本页上次请求相同'
      : value.comparison === 'partial' ? `前 ${value.matchedPrefixChars.toLocaleString('en-US')} 字符所在断点未变，后段有变化`
        : '缓存前缀在首个断点前已有变化';
  return `${detail} · ${value.breakpoints} 个断点${value.elapsedMs == null ? '' : ` · 间隔 ${Math.floor(value.elapsedMs / 1000)} 秒`}。仅比较本地请求，不代表上游已命中。`;
}

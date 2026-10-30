import type { AnthropicCacheDiagnostic } from './anthropicPromptCache';

/**
 * OpenAI-compatible prompt-cache request decoration.
 *
 * The request body already uses a stable leading system message. We only add
 * the OAI routing hint; Anthropic's content-block cache_control never crosses
 * this boundary.
 */
export type OpenAIPromptCacheDiagnostic = AnthropicCacheDiagnostic;

type Scope = { endpoint: string; credential?: string; model?: string; charId?: string; purpose?: string };
type PrefixSnapshot = { hashes: string[]; at: number; prefixChars: number };

const recent = new Map<string, PrefixSnapshot>();

function stableText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text)
    .join('');
}

function fallbackDigest(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function digest(value: string): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const bytes = await subtle.digest('SHA-256', new TextEncoder().encode(value));
      return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // A deterministic fallback still keeps the routing key stable.
  }
  return fallbackDigest(value);
}

function prefixCheckpoints(text: string): number[] {
  const checkpoints = [8192, 16384, 32768].filter(target => target < text.length);
  checkpoints.push(text.length);
  return checkpoints;
}

/** Add prompt_cache_key and return a local-only prefix comparison diagnostic. */
export async function decorateOpenAIPromptCache(
  body: Record<string, any>,
  scope: Scope,
): Promise<{ body: Record<string, any>; diagnostic?: OpenAIPromptCacheDiagnostic }> {
  const first = body.messages?.[0];
  if (!first || (first.role !== 'system' && first.role !== 'developer')) return { body };
  const prefix = stableText(first.content);
  if (!prefix) return { body };

  const signature = JSON.stringify({
    endpoint: scope.endpoint,
    model: body.model || scope.model || '',
    prefix,
    tools: body.tools || null,
    tool_choice: body.tool_choice || null,
  });
  const cacheKey = `oai-${(await digest(signature)).slice(0, 60)}`;
  const checkpoints = prefixCheckpoints(prefix);
  const stableRequestShape = {
    model: body.model || scope.model || '',
    tools: body.tools || null,
    tool_choice: body.tool_choice || null,
  };
  const hashes = await Promise.all(checkpoints.map(index => digest(JSON.stringify({
    ...stableRequestShape, prefix: prefix.slice(0, index),
  }))));
  const scopeKey = await digest(JSON.stringify([scope.endpoint, scope.credential || '', scope.model || body.model || '', scope.charId || '', scope.purpose || '']));
  const previous = recent.get(scopeKey);
  const at = Date.now();
  let matched = -1;
  if (previous) {
    for (let i = 0; i < hashes.length; i++) {
      if (previous.hashes[i] !== hashes[i]) break;
      matched = i;
    }
  }
  recent.delete(scopeKey);
  recent.set(scopeKey, { hashes, at, prefixChars: prefix.length });
  if (recent.size > 64) recent.delete(recent.keys().next().value!);

  return {
    body: { ...body, prompt_cache_key: cacheKey },
    diagnostic: {
      comparison: !previous ? 'first' : matched === hashes.length - 1 && hashes.length === previous.hashes.length ? 'same' : matched >= 0 ? 'partial' : 'changed',
      breakpoints: hashes.length,
      prefixChars: prefix.length,
      matchedPrefixChars: matched < 0 ? 0 : checkpoints[matched],
      ...(previous ? { elapsedMs: Math.max(0, at - previous.at) } : {}),
    },
  };
}

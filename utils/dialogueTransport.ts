import type { DialogueApiConfig } from '../types';
import { llmApiType, normalizeLlmBaseUrl } from './llmEndpoint';
import { safeFetchJson } from './safeApi';
import { normalizeApiCredential } from './apiConfigNormalize';
import { captureApiRequestOnce, getApiCallAmbientContext, MAX_API_RAW_USAGE_EVENTS, snapshotApiRawUsage, updateApiRequestCaptureUsage, type ApiRawUsageEvent } from './apiCallLog';
import { compareAnthropicCachePrefix } from './anthropicPromptCache';
import { decorateOpenAIPromptCache } from './openaiPromptCache';

/** Settings only. The shared upstream transport performs all native conversion. */
export function anthropicRequestOptions(api: DialogueApiConfig) {
  return { cache: api.anthropicPromptCache !== false, ttl: api.anthropicPromptCacheTtl === '1h' ? '1h' : '5m', customTemperature: api.anthropicCustomTemperature === true };
}

export function createDialogueFetch(api: DialogueApiConfig): typeof safeFetchJson {
  return async (url, options, retries, timeout, meta, hooks) => {
    const native = llmApiType(api) === 'anthropic';
    const requestMeta = { ...(meta || getApiCallAmbientContext()) };
    let body = typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
    if (!native && body && api.openaiPromptCache !== false) {
      const decorated = await decorateOpenAIPromptCache(body, { endpoint: url, credential: normalizeApiCredential(api.apiKey), model: api.model, charId: requestMeta.charId, purpose: requestMeta.purpose });
      body = decorated.body;
      if (decorated.diagnostic) requestMeta.cacheDiagnostic = decorated.diagnostic;
    }
    if (native && body) body.__sullyAnthropicOptions = anthropicRequestOptions(api);
    let captureId: string | null = null;
    const rawUsageEvents: ApiRawUsageEvent[] = [];
    let rawUsageEventsDropped = 0;
    const rawUsageSummary: Record<string, unknown> = {};
    const observer = native ? {
      onRequest: async (endpoint: string, payload: Record<string, any>) => {
        requestMeta.cacheDiagnostic = await compareAnthropicCachePrefix({ endpoint, credential: normalizeApiCredential(api.apiKey), charId: requestMeta.charId, purpose: requestMeta.purpose }, payload);
        captureId = captureApiRequestOnce({ url: endpoint, body: JSON.stringify(payload), meta: requestMeta });
      },
      onUsage: (source: ApiRawUsageEvent['source'], usage: unknown) => {
        if (!captureId) return;
        const event = snapshotApiRawUsage(source, usage);
        if (!event) return;
        Object.assign(rawUsageSummary, event.usage);
        if (rawUsageEvents.length < MAX_API_RAW_USAGE_EVENTS) rawUsageEvents.push(event); else rawUsageEventsDropped++;
      },
    } : undefined;
    try {
      options.signal?.throwIfAborted();
      const headers = new Headers(options.headers);
      if (native) headers.set('Authorization', 'Bearer ' + normalizeApiCredential(api.apiKey));
      const endpoint = normalizeLlmBaseUrl(api.baseUrl, llmApiType(api)) + '/chat/completions';
      const result = await safeFetchJson(native ? endpoint : url, { ...options, headers, ...(native && body && !options.method ? { method: 'POST' } : {}), ...(body ? { body: JSON.stringify(body) } : {}), ...(observer ? { __sullyAnthropicObserver: observer } : {}) } as RequestInit, retries, timeout, requestMeta, hooks);
      options.signal?.throwIfAborted();
      updateApiRequestCaptureUsage({ captureId, ok: true, response: native ? { ...result, usage: rawUsageSummary } : result, rawUsageEvents, rawUsageEventsDropped });
      return result;
    } catch (error) {
      updateApiRequestCaptureUsage({ captureId, ok: false, rawUsageEvents, rawUsageEventsDropped });
      throw error;
    }
  };
}

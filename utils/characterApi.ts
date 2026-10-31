import type { APIConfig, CharacterProfile, DialogueApiConfig } from '../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel } from './apiConfigNormalize';
import { normalizeLlmBaseUrl, llmApiType } from './llmEndpoint';

export function normalizeDialogueMaxTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function dialogueMaxTokens(api: Pick<APIConfig, 'maxTokens'>): number {
  return normalizeDialogueMaxTokens(api.maxTokens) ?? 8000;
}

/** Only dialogue calls opt in. Directors, memory, vision and TTS keep their own routes. */
export function resolveDialogueApi(
  globalApi: APIConfig,
  character?: Pick<CharacterProfile, 'dialogueApi'> | null,
  appApi?: DialogueApiConfig | null,
): APIConfig {
  const source = appApi ?? character?.dialogueApi;
  if (!source) return globalApi;
  // Credentials are atomic; never fill a missing key/model from a different provider.
  const openaiPromptCache = source.openaiPromptCache ?? globalApi.openaiPromptCache;
  return { ...globalApi, ...pickDialogueApi(source), apiType: llmApiType(source),
    ...(llmApiType(source) === 'anthropic' ? { anthropicPromptCacheTtl: source.anthropicPromptCacheTtl === '1h' ? '1h' : '5m' } : {}),
    ...((globalApi.anthropicPromptCache !== undefined || source.anthropicPromptCache !== undefined)
      ? { anthropicPromptCache: source.anthropicPromptCache !== false } : {}),
    ...((globalApi.anthropicCustomTemperature !== undefined || source.anthropicCustomTemperature !== undefined)
      ? { anthropicCustomTemperature: source.anthropicCustomTemperature === true } : {}),
    ...(openaiPromptCache !== undefined ? { openaiPromptCache: openaiPromptCache !== false } : {}),
  };
}

export function pickDialogueApi(api: DialogueApiConfig): DialogueApiConfig {
  return {
    baseUrl: normalizeLlmBaseUrl(normalizeApiBaseUrl(api.baseUrl), llmApiType(api)),
    apiType: llmApiType(api),
    apiKey: normalizeApiCredential(api.apiKey),
    model: normalizeApiModel(api.model),
    ...(typeof api.stream === 'boolean' ? { stream: api.stream } : {}),
    ...(typeof api.temperature === 'number' ? { temperature: api.temperature } : {}),
    ...(api.anthropicPromptCacheTtl ? { anthropicPromptCacheTtl: api.anthropicPromptCacheTtl } : {}),
    ...(typeof api.anthropicPromptCache === 'boolean' ? { anthropicPromptCache: api.anthropicPromptCache } : {}),
    ...(typeof api.anthropicCustomTemperature === 'boolean' ? { anthropicCustomTemperature: api.anthropicCustomTemperature } : {}),
    ...(typeof api.openaiPromptCache === 'boolean' ? { openaiPromptCache: api.openaiPromptCache } : {}),
    ...(normalizeDialogueMaxTokens(api.maxTokens) !== undefined ? { maxTokens: api.maxTokens } : {}),
  };
}

export function describeDialogueApi(api: DialogueApiConfig): string {
  let host = '';
  try { host = new URL(api.baseUrl).host; } catch { /* Unconfigured/invalid URL. Never display credentials. */ }
  return [host, api.model || '未设置模型'].filter(Boolean).join(' · ');
}

import type { APIConfig, CharacterProfile, DialogueApiConfig } from '../types';
import { normalizeApiBaseUrl, normalizeApiCredential, normalizeApiModel, normalizeApiProtocol } from './apiConfigNormalize';

/** Only dialogue calls opt in. Directors, memory, vision and TTS keep their own routes. */
export function resolveDialogueApi(
  globalApi: APIConfig,
  character?: Pick<CharacterProfile, 'dialogueApi'> | null,
  appApi?: DialogueApiConfig | null,
): APIConfig {
  const source = appApi ?? character?.dialogueApi;
  if (!source) return globalApi;
  // Credentials are atomic; never fill a missing key/model from a different provider.
  return { ...globalApi, ...pickDialogueApi(source), protocol: normalizeApiProtocol(source.protocol),
    ...((globalApi.anthropicPromptCache !== undefined || source.anthropicPromptCache !== undefined)
      ? { anthropicPromptCache: source.anthropicPromptCache !== false } : {}),
    ...((globalApi.anthropicCustomTemperature !== undefined || source.anthropicCustomTemperature !== undefined)
      ? { anthropicCustomTemperature: source.anthropicCustomTemperature === true } : {}),
  };
}

export function pickDialogueApi(api: DialogueApiConfig): DialogueApiConfig {
  return {
    baseUrl: normalizeApiBaseUrl(api.baseUrl),
    apiKey: normalizeApiCredential(api.apiKey),
    model: normalizeApiModel(api.model),
    ...(api.protocol !== undefined ? { protocol: normalizeApiProtocol(api.protocol) } : {}),
    ...(typeof api.stream === 'boolean' ? { stream: api.stream } : {}),
    ...(typeof api.temperature === 'number' ? { temperature: api.temperature } : {}),
    ...(typeof api.anthropicPromptCache === 'boolean' ? { anthropicPromptCache: api.anthropicPromptCache } : {}),
    ...(typeof api.anthropicCustomTemperature === 'boolean' ? { anthropicCustomTemperature: api.anthropicCustomTemperature } : {}),
  };
}

export function describeDialogueApi(api: DialogueApiConfig): string {
  let host = '';
  try { host = new URL(api.baseUrl).host; } catch { /* Unconfigured/invalid URL. Never display credentials. */ }
  return [host, api.model || '未设置模型'].filter(Boolean).join(' · ');
}

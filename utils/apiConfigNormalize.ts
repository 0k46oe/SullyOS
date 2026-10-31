import type { APIConfig, ApiPreset, ApiProtocol } from '../types';

export const normalizeApiProtocol = (value: unknown): ApiProtocol =>
  value === 'anthropic' ? 'anthropic' : 'openai';
import { normalizeLlmBaseUrl, llmApiType } from './llmEndpoint';

// Clipboard contents can carry zero-width characters that String.trim() does not
// remove. They are never valid at the edges of an API URL, token, or model id.
const EDGE_INVISIBLE_CHARS = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

const cleanEdgeCharacters = (value: unknown): string =>
  String(value ?? '').replace(EDGE_INVISIBLE_CHARS, '');

export const normalizeApiBaseUrl = (value: unknown): string =>
  cleanEdgeCharacters(value).replace(/\/+$/, '');

export const normalizeApiCredential = (value: unknown): string =>
  cleanEdgeCharacters(value);

export const normalizeApiModel = (value: unknown): string =>
  cleanEdgeCharacters(value);

export function normalizeApiConfig(config: APIConfig): APIConfig {
  const visionApi = config.visionApi;
  return {
    ...config,
    apiType: llmApiType(config),
    baseUrl: normalizeLlmBaseUrl(normalizeApiBaseUrl(config.baseUrl), llmApiType(config)),
    apiKey: normalizeApiCredential(config.apiKey),
    model: normalizeApiModel(config.model),
    ...(config.protocol !== undefined ? { protocol: normalizeApiProtocol(config.protocol) } : {}),
    ...(config.anthropicPromptCache !== undefined ? { anthropicPromptCache: config.anthropicPromptCache !== false } : {}),
    ...(config.anthropicPromptCacheTtl === '1h' ? { anthropicPromptCacheTtl: '1h' as const } : config.anthropicPromptCacheTtl === '5m' ? { anthropicPromptCacheTtl: '5m' as const } : {}),
    ...(config.anthropicCustomTemperature !== undefined ? { anthropicCustomTemperature: config.anthropicCustomTemperature === true } : {}),
    ...(config.openaiPromptCache !== undefined ? { openaiPromptCache: config.openaiPromptCache !== false } : {}),
    ...(visionApi ? {
      visionApi: {
        enabled: visionApi.enabled === true,
        baseUrl: normalizeApiBaseUrl(visionApi.baseUrl),
        apiKey: normalizeApiCredential(visionApi.apiKey),
        model: normalizeApiModel(visionApi.model),
      },
    } : {}),
  };
}

export function normalizeApiPreset(preset: ApiPreset): ApiPreset {
  return {
    ...preset,
    name: String(preset.name ?? '').trim(),
    config: normalizeApiConfig(preset.config),
  };
}

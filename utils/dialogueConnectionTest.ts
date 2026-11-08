import type { DialogueApiConfig } from '../types';
import { dialogueMaxTokens, pickDialogueApi } from './characterApi';
import { createDialogueFetch } from './dialogueTransport';
import { extractContent } from './safeApi';

/** Probe the selected draft through the same transport and generation settings as dialogue. */
export async function testDialogueConnection(source: DialogueApiConfig): Promise<string> {
  const api = pickDialogueApi(source);
  const response = await createDialogueFetch(api)(api.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (api.apiKey || 'sk-none') },
    body: JSON.stringify({
      model: api.model, messages: [{ role: 'user', content: 'Hi' }],
      temperature: api.temperature ?? 0.85, max_tokens: dialogueMaxTokens(api),
      stream: api.stream ?? false, ...(api.stream ? { stream_options: { include_usage: true } } : {}),
    }),
  }, 0, 60000);
  return extractContent(response);
}

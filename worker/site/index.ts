/**
 * Cloudflare Workers entry for the SullyOS website.
 *
 * Static files are served by the ASSETS binding. Only /api/* requests invoke
 * this Worker, keeping normal page and asset requests on the free static path.
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  MINIMAX_API_KEY?: string;
  MINIMAX_GROUP_ID?: string;
  MINIMAX_REGION?: string;
  FISH_API_KEY?: string;
  FISH_MODEL?: string;
}

const DOMESTIC_MINIMAX_BASE = 'https://api.minimaxi.com';
const OVERSEAS_MINIMAX_BASE = 'https://api.minimax.io';
const FISH_UPSTREAM = 'https://api.fish.audio/v1/tts';
const DEFAULT_FISH_MODEL = 's2.1-pro';

const MINIMAX_JSON_ROUTES: Record<string, string> = {
  '/api/minimax/t2a': '/v1/t2a_v2',
  '/api/minimax/get-voice': '/v1/get_voice',
  '/api/minimax/music': '/v1/music_generation',
  '/api/minimax/voice-clone': '/v1/voice_clone',
};

const CLONE_SOURCE_TEXT = '在一个阳光明媚的早晨，小鸟在枝头欢快地歌唱，微风轻轻拂过脸庞，带来了花朵的芬芳。远处的山峦在薄雾中若隐若现，宛如一幅水墨画。人们漫步在林荫小道上，享受着这难得的宁静时光。孩子们在草地上奔跑嬉戏，笑声回荡在空气中，让人感到无比温暖和幸福。';

const corsHeaders = (): Headers => new Headers({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,model,X-MiniMax-API-Key,X-MiniMax-Group-Id,X-MiniMax-Region',
  'Access-Control-Max-Age': '86400',
});

function jsonResponse(body: unknown, status = 200): Response {
  const headers = corsHeaders();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

function upstreamResponse(response: Response, fallbackContentType = 'application/json'): Response {
  const headers = corsHeaders();
  headers.set('Content-Type', response.headers.get('Content-Type') || fallbackContentType);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalizeApiKey(raw: string | null | undefined): string {
  return String(raw || '').trim().replace(/^Bearer\s+/i, '').trim();
}

function minimaxBase(request: Request, env: Env, bodyRegion?: unknown): string {
  const region = [
    typeof bodyRegion === 'string' ? bodyRegion : '',
    request.headers.get('X-MiniMax-Region') || '',
    env.MINIMAX_REGION || '',
  ].map(value => value.trim().toLowerCase()).find(Boolean);
  return region === 'overseas' ? OVERSEAS_MINIMAX_BASE : DOMESTIC_MINIMAX_BASE;
}

function minimaxApiKey(request: Request, env: Env, bodyKey?: unknown): string {
  return [
    typeof bodyKey === 'string' ? bodyKey : '',
    request.headers.get('Authorization') || '',
    request.headers.get('X-MiniMax-API-Key') || '',
    env.MINIMAX_API_KEY || '',
  ].map(normalizeApiKey).find(Boolean) || '';
}

async function requireJson(request: Request): Promise<Record<string, any>> {
  const parsed = await request.json();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object body');
  }
  return parsed as Record<string, any>;
}

async function handleMinimaxJson(request: Request, env: Env, upstreamPath: string): Promise<Response> {
  const apiKey = minimaxApiKey(request, env);
  if (!apiKey) {
    return jsonResponse({ error: 'Missing API key. Provide Authorization, X-MiniMax-API-Key, or MINIMAX_API_KEY.' }, 400);
  }

  const body = await requireJson(request);
  if (upstreamPath === '/v1/t2a_v2' && !body.group_id) {
    body.group_id = [
      request.headers.get('X-MiniMax-Group-Id') || '',
      env.MINIMAX_GROUP_ID || '',
    ].map(value => value.trim()).find(Boolean) || undefined;
    if (!body.group_id) delete body.group_id;
  }

  const upstream = await fetch(`${minimaxBase(request, env)}${upstreamPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  return upstreamResponse(upstream);
}

async function handleMinimaxUpload(request: Request, env: Env): Promise<Response> {
  const apiKey = minimaxApiKey(request, env);
  if (!apiKey) return jsonResponse({ error: 'Missing API key.' }, 400);

  const contentType = request.headers.get('Content-Type') || '';
  const upstream = await fetch(`${minimaxBase(request, env)}/v1/files/upload`, {
    method: 'POST',
    headers: {
      ...(contentType ? { 'Content-Type': contentType } : {}),
      Authorization: `Bearer ${apiKey}`,
    },
    body: await request.arrayBuffer(),
  });
  return upstreamResponse(upstream);
}

function hexToBytes(raw: string): Uint8Array {
  const hex = raw.trim().replace(/^0x/i, '');
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('T2A returned invalid audio data');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function handleBakeVoice(request: Request, env: Env): Promise<Response> {
  const body = await requireJson(request);
  const { voiceId, model, ttsPayload, groupId, region } = body;
  const apiKey = minimaxApiKey(request, env, body.apiKey);

  if (!apiKey) throw new Error('Missing apiKey');
  if (!voiceId) throw new Error('Missing voiceId');
  if (!ttsPayload || typeof ttsPayload !== 'object') throw new Error('Missing ttsPayload');

  const base = minimaxBase(request, env, region);
  const t2aBody: Record<string, any> = {
    ...ttsPayload,
    text: CLONE_SOURCE_TEXT,
    stream: false,
    output_format: 'url',
    audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
  };
  if (groupId) t2aBody.group_id = groupId;

  const t2aResponse = await fetch(`${base}/v1/t2a_v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(t2aBody),
  });
  const t2aData = await t2aResponse.json() as any;
  if (!t2aResponse.ok || (typeof t2aData?.base_resp?.status_code === 'number' && t2aData.base_resp.status_code !== 0)) {
    throw new Error(`T2A failed: ${t2aData?.base_resp?.status_msg || `HTTP ${t2aResponse.status}`}`);
  }

  const audioRaw = t2aData?.data?.audio;
  if (typeof audioRaw !== 'string' || !audioRaw.trim()) throw new Error('T2A returned no audio');

  let audioBytes: Uint8Array;
  if (/^https?:\/\//i.test(audioRaw.trim())) {
    const audioResponse = await fetch(audioRaw.trim());
    if (!audioResponse.ok) throw new Error(`Audio download failed: HTTP ${audioResponse.status}`);
    audioBytes = new Uint8Array(await audioResponse.arrayBuffer());
  } else {
    audioBytes = hexToBytes(audioRaw);
  }

  const form = new FormData();
  const audioBuffer = new ArrayBuffer(audioBytes.byteLength);
  new Uint8Array(audioBuffer).set(audioBytes);
  form.append('file', new File([audioBuffer], 'voice_sample.mp3', { type: 'audio/mpeg' }));
  form.append('purpose', 'voice_clone');
  const uploadResponse = await fetch(`${base}/v1/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const uploadData = await uploadResponse.json() as any;
  const fileId = uploadData?.file?.file_id;
  if (!uploadResponse.ok || !fileId) {
    throw new Error(`Upload failed: ${uploadData?.base_resp?.status_msg || `HTTP ${uploadResponse.status}`}`);
  }

  const cloneResponse = await fetch(`${base}/v1/voice_clone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      file_id: fileId,
      voice_id: voiceId,
      model: model || 'speech-2.8-hd',
      text: '你好，这是固定后的声音，听听看效果怎么样？',
      need_noise_reduction: false,
      need_volumn_normalization: true,
    }),
  });
  const cloneData = await cloneResponse.json() as any;
  if (!cloneResponse.ok || (typeof cloneData?.base_resp?.status_code === 'number' && cloneData.base_resp.status_code !== 0)) {
    throw new Error(`Clone failed: ${cloneData?.base_resp?.status_msg || `HTTP ${cloneResponse.status}`}`);
  }

  return jsonResponse({ success: true, file_id: fileId, voice_id: voiceId, clone_data: cloneData });
}

async function handleFishAudio(request: Request, env: Env): Promise<Response> {
  const apiKey = normalizeApiKey(request.headers.get('Authorization')) || normalizeApiKey(env.FISH_API_KEY);
  if (!apiKey) {
    return jsonResponse({ error: 'Missing API key. Provide Authorization or FISH_API_KEY.' }, 400);
  }

  const url = new URL(request.url);
  const model = request.headers.get('model')?.trim()
    || url.searchParams.get('model')?.trim()
    || env.FISH_MODEL?.trim()
    || DEFAULT_FISH_MODEL;

  const upstream = await fetch(FISH_UPSTREAM, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      model,
    },
    body: await request.text(),
  });
  return upstreamResponse(upstream, upstream.ok ? 'audio/mpeg' : 'text/plain; charset=utf-8');
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method Not Allowed' }, 405);

  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  try {
    const minimaxPath = MINIMAX_JSON_ROUTES[path];
    if (minimaxPath) return await handleMinimaxJson(request, env, minimaxPath);
    if (path === '/api/minimax/upload') return await handleMinimaxUpload(request, env);
    if (path === '/api/minimax/bake-voice') return await handleBakeVoice(request, env);
    if (path === '/api/fishaudio/tts') return await handleFishAudio(request, env);
    return jsonResponse({ error: 'Not Found' }, 404);
  } catch (error: any) {
    return jsonResponse({ error: error?.message || 'Proxy request failed' }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/api' || path.startsWith('/api/')) return handleApi(request, env);
    return env.ASSETS.fetch(request);
  },
};

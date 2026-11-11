import { isGeminiEndpoint } from './llmEndpoint';

type Part = Record<string, any>;
type Content = { role: 'user' | 'model'; parts: Part[] };

function contentParts(value: unknown): Part[] {
    if (value == null || value === '') return [];
    if (typeof value === 'string') return [{ text: value }];
    if (!Array.isArray(value)) throw Error('Gemini 消息内容必须为文本或内容块');
    return value.flatMap((part: any): Part[] => {
        if (part.type === 'text') return typeof part.text === 'string' ? [{ text: part.text }] : [];
        if (part.type === 'image_url') {
            const uri = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            const data = typeof uri === 'string' && uri.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i);
            if (data) return [{ inlineData: { mimeType: data[1].toLowerCase(), data: data[2] } }];
            // Uploaded Gemini files and cloud storage references are passed by URI, never fetched by the client.
            if (typeof uri === 'string' && /^(https:\/\/|gs:\/\/)/i.test(uri)) {
                const ext = uri.split(/[?#]/)[0].match(/\.(png|jpe?g|webp|gif)$/i)?.[1].toLowerCase();
                const mimeType = part.image_url?.mime_type || (ext ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : undefined);
                if (!mimeType) throw Error('Gemini URI 图片缺少 MIME 类型，请使用 base64 图片或带类型的文件 URI');
                return [{ fileData: { mimeType, fileUri: uri } }];
            }
            throw Error('Gemini 图片需为 base64 图片或受支持的文件 URI');
        }
        throw Error(`Gemini 暂不支持内容块：${String(part.type)}`);
    });
}

/** Preserve the stable prefix verbatim in the first user Content; keep reminders in place. */
export function toGeminiRequest(body: any): any {
    if (!Array.isArray(body.messages)) throw Error('Gemini 请求缺少 messages');
    const contents: Content[] = [];
    const calls = new Map<string, { name: string; id?: string }>();
    let leading = true;
    const append = (role: Content['role'], parts: Part[]) => {
        if (!parts.length) return;
        const last = contents.at(-1);
        if (last?.role === role) last.parts.push(...parts);
        else contents.push({ role, parts });
    };
    for (const message of body.messages) {
        if (message.role === 'system' || message.role === 'developer') {
            const parts = contentParts(message.content);
            if (leading) append('user', parts);
            else { append('user', [{ text: `<system-reminder>\n${parts.map(p => p.text).join('\n')}\n</system-reminder>` }]); }
            continue;
        }
        leading = false;
        if (message.role === 'tool') {
            const call = calls.get(message.tool_call_id);
            if (!call) throw Error('Gemini 工具结果缺少对应的工具调用');
            // Keep tool output verbatim, including JSON strings: no parsing or rewriting of user data.
            append('user', [{ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: { result: message.content ?? '' } } }]);
            continue;
        }
        if (message.role !== 'assistant' && message.role !== 'user') throw Error(`Gemini 不支持消息角色：${String(message.role)}`);
        const nativeParts = message.gemini_content;
        const parts = message.role === 'assistant' && Array.isArray(nativeParts) ? structuredClone(nativeParts) : contentParts(message.content);
        for (const [index, call] of (message.tool_calls || []).entries()) {
            if (!call.id || !call.function?.name) throw Error('Gemini 工具调用缺少 ID 或名称');
            const nativeCall = Array.isArray(nativeParts) ? nativeParts.filter(p => p.functionCall)[index]?.functionCall : undefined;
            calls.set(call.id, { name: call.function.name, ...(nativeCall?.id ? { id: nativeCall.id } : {}) });
            if (Array.isArray(nativeParts)) continue;
            const args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function.arguments || {};
            const signature = call.extra_content?.google?.thought_signature;
            parts.push({ functionCall: { name: call.function.name, args }, ...(signature ? { thoughtSignature: signature } : {}) });
        }
        append(message.role === 'assistant' ? 'model' : 'user', parts);
    }
    if (!contents.length) throw Error('Gemini 请求没有对话内容');
    const generationConfig: Record<string, any> = {};
    for (const [from, to] of [['temperature', 'temperature'], ['top_p', 'topP'], ['top_k', 'topK'], ['max_completion_tokens', 'maxOutputTokens'], ['max_tokens', 'maxOutputTokens']] as const) {
        if (typeof body[from] === 'number') generationConfig[to] = body[from];
    }
    if (body.stop) generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
    if (body.response_format?.type === 'json_object' || body.response_format?.type === 'json_schema') generationConfig.responseMimeType = 'application/json';
    if (body.response_format?.type === 'json_schema') generationConfig.responseJsonSchema = body.response_format.json_schema?.schema;
    // Let the selected Gemini model choose its own thinking budget; only ask for summaries when requested.
    if (body.thinking?.type === 'enabled' || body.reasoning_effort && body.reasoning_effort !== 'none') generationConfig.thinkingConfig = { includeThoughts: true };
    const request: any = { contents, ...(Object.keys(generationConfig).length ? { generationConfig } : {}) };
    if (body.tools?.length) {
        request.tools = [{ functionDeclarations: body.tools.map((tool: any) => {
            if (tool.type !== 'function' || !tool.function?.name) throw Error('Gemini 暂仅支持 function 工具');
            return { name: tool.function.name, description: tool.function.description || '', parametersJsonSchema: tool.function.parameters || { type: 'object', properties: {} } };
        }) }];
        const choice = body.tool_choice;
        request.toolConfig = { functionCallingConfig: { mode: choice === 'none' ? 'NONE' : choice === 'required' || choice?.type === 'function' ? 'ANY' : 'AUTO', ...(choice?.type === 'function' ? { allowedFunctionNames: [choice.function.name] } : {}) } };
    }
    return request;
}

/** Gemini promptTokenCount already includes cached input; thinking belongs to output usage. */
export function geminiUsage(usage: any = {}): any {
    const prompt = usage.promptTokenCount ?? 0;
    const completion = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
    return { ...usage, prompt_tokens: prompt, completion_tokens: completion, total_tokens: usage.totalTokenCount ?? prompt + completion,
        ...(typeof usage.cachedContentTokenCount === 'number' ? { prompt_tokens_details: { cached_tokens: usage.cachedContentTokenCount } } : {}),
        ...(typeof usage.thoughtsTokenCount === 'number' ? { completion_tokens_details: { reasoning_tokens: usage.thoughtsTokenCount } } : {}),
    };
}

const finishReason = (reason?: string, tools = false) => reason === 'MAX_TOKENS' ? 'length' : tools ? 'tool_calls' : 'stop';
const blocked = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'IMAGE_SAFETY']);
function checkResponse(data: any): void {
    if (data.error) throw Error(data.error.message || 'Gemini 返回错误');
    if (data.promptFeedback?.blockReason) throw Error(`Gemini 拒绝了请求：${data.promptFeedback.blockReason}`);
    const reason = data.candidates?.[0]?.finishReason;
    if (blocked.has(reason)) throw Error(`Gemini 未完成回复：${reason}`);
}
function toolCalls(parts: Part[]): any[] {
    return parts.filter(p => p.functionCall).map((part, index) => ({
        id: part.functionCall.id || `call_gemini_${index}`, type: 'function',
        function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
        ...(part.thoughtSignature ? { extra_content: { google: { thought_signature: part.thoughtSignature } } } : {}),
    }));
}
export function fromGeminiResponse(data: any): any {
    checkResponse(data);
    const candidate = data.candidates?.[0];
    if (!candidate || !Array.isArray(candidate.content?.parts)) throw Error('Gemini 返回了无效的生成响应');
    const parts = candidate.content.parts, calls = toolCalls(parts);
    const reasoning = parts.filter((p: Part) => p.thought).map((p: Part) => p.text || '').join('');
    return { id: data.responseId || 'gemini-response', object: 'chat.completion', model: data.modelVersion || '', choices: [{ index: 0, finish_reason: finishReason(candidate.finishReason, calls.length > 0), message: {
        role: 'assistant', content: parts.filter((p: Part) => !p.thought).map((p: Part) => p.text || '').join(''),
        gemini_content: parts, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}),
    } }], ...(data.usageMetadata ? { usage: geminiUsage(data.usageMetadata) } : {}) };
}

/** Parse UTF-8/SSE incrementally, retain signed parts for continuation, and reject truncated streams. */
function convertGeminiStream(response: Response, signal?: AbortSignal | null): Response {
    if (!response.body) throw Error('Gemini 返回了空流');
    const reader = response.body.getReader(), decoder = new TextDecoder(), encoder = new TextEncoder();
    let pending = '', eventData: string[] = [], finished = false, ended = false, callCount = 0;
    let id = 'gemini-stream', model = '', reason = 'STOP', emitted = 0;
    const parts: Part[] = [];
    let cancellation: Promise<void> | undefined;
    const cancel = (reason?: unknown) => cancellation ??= reader.cancel(reason).catch(() => {});
    const onAbort = () => { void cancel(signal?.reason); };
    const detach = () => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const emit = (value: any) => { emitted++; controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); };
            const flush = () => {
                if (!eventData.length) return;
                const raw = eventData.join('\n'); eventData = [];
                if (raw === '[DONE]') return;
                const data = JSON.parse(raw); checkResponse(data);
                id = data.responseId || id; model = data.modelVersion || model;
                const candidate = data.candidates?.[0];
                const delta: any = {};
                for (const part of candidate?.content?.parts || []) {
                    const last = parts.at(-1);
                    if (typeof part.text === 'string' && typeof last?.text === 'string' && !!last.thought === !!part.thought && !last.thoughtSignature) Object.assign(last, { text: last.text + part.text }, part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {});
                    else parts.push(structuredClone(part));
                    if (typeof part.text === 'string') {
                        const field = part.thought ? 'reasoning_content' : 'content';
                        delta[field] = (delta[field] || '') + part.text;
                    }
                    if (part.functionCall) {
                        const call = toolCalls([part])[0];
                        if (!part.functionCall.id) call.id = `call_gemini_${callCount}`;
                        (delta.tool_calls ||= []).push({ ...call, index: callCount++ });
                    }
                }
                if (candidate?.finishReason) { finished = true; reason = candidate.finishReason; }
                emit({ id, model, choices: candidate ? [{ index: 0, delta, finish_reason: null }] : [], ...(data.usageMetadata ? { usage: geminiUsage(data.usageMetadata) } : {}) });
            };
            const line = (value: string) => {
                if (!value) flush();
                else if (value.startsWith('data:')) eventData.push(value.slice(5).replace(/^ /, ''));
            };
            try {
                const before = emitted;
                while (!ended && emitted === before) {
                    signal?.throwIfAborted();
                    const next = await reader.read();
                    signal?.throwIfAborted();
                    pending += decoder.decode(next.value, { stream: !next.done });
                    let index: number;
                    while ((index = pending.indexOf('\n')) >= 0) { line(pending.slice(0, index).replace(/\r$/, '')); pending = pending.slice(index + 1); }
                    if (next.done) {
                        if (pending) line(pending.replace(/\r$/, ''));
                        flush();
                        if (!finished) throw Error('Gemini 流式响应提前结束，未收到完成标记');
                        ended = true; detach();
                        emit({ id, model, choices: [{ index: 0, delta: { gemini_content: parts }, finish_reason: finishReason(reason, callCount > 0) }] });
                        controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
                    }
                }
            } catch (error) { ended = true; detach(); controller.error(error); await cancel(error); }
        },
        async cancel(reason) { if (!ended) { ended = true; detach(); await cancel(reason); } },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: { 'content-type': 'text/event-stream' } });
}

export async function fetchGemini(resource: RequestInfo | URL, init: RequestInit | undefined, transport: typeof fetch): Promise<Response> {
    const request = resource instanceof Request ? resource : undefined;
    const input = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
    const requestHeaders = new Headers(init?.headers || request?.headers);
    const explicitlyGemini = requestHeaders.has('x-sully-gemini-auth-mode') || requestHeaders.has('x-sully-gemini-api-key');
    if (!explicitlyGemini && !isGeminiEndpoint(input)) return transport(resource, init);
    const url = new URL(input), method = (init?.method || request?.method || 'GET').toUpperCase();
    const inherited: RequestInit = request ? { credentials: request.credentials, cache: request.cache, mode: request.mode, redirect: request.redirect, signal: request.signal } : {};
    const headers = requestHeaders;
    const key = headers.get('x-sully-gemini-api-key') || headers.get('x-goog-api-key') || headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
    const configuredMode = headers.get('x-sully-gemini-auth-mode');
    const authMode = configuredMode === 'auto' || configuredMode === 'bearer' || configuredMode === 'query' ? configuredMode : 'header';
    headers.delete('x-sully-gemini-auth-mode'); headers.delete('x-sully-gemini-api-key');
    headers.delete('authorization'); headers.delete('x-goog-api-key'); headers.delete('x-api-key'); headers.delete('anthropic-version'); headers.delete('anthropic-dangerous-direct-browser-access');
    const options: RequestInit = { ...inherited, ...init, method, headers };
    const sendWithAuth = async (target: URL): Promise<Response> => {
        const modes = authMode === 'auto' ? ['header', 'bearer', 'query'] as const : [authMode] as const;
        let response: Response | undefined;
        for (const mode of modes) {
            const attemptUrl = new URL(target.href);
            attemptUrl.searchParams.delete('key');
            const attemptHeaders = new Headers(headers);
            attemptHeaders.delete('authorization'); attemptHeaders.delete('x-goog-api-key');
            if (mode === 'header') attemptHeaders.set('x-goog-api-key', key);
            else if (mode === 'bearer') attemptHeaders.set('Authorization', `Bearer ${key}`);
            else attemptUrl.searchParams.set('key', key);
            response = await transport(attemptUrl.href, { ...options, headers: attemptHeaders });
            if (response.status !== 401 && response.status !== 403) return response;
        }
        return response!;
    };
    // Strip only synthetic application suffixes; never build endpoints by string concatenation after a query.
    url.pathname = url.pathname.replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)\/?$/, '/models').replace(/\/(?:chat\/completions|models)\/?$/, '');
    if (!url.pathname.endsWith('/models')) url.pathname += '/models';
    if (method === 'GET' && /\/models(?:\/models)?\/?$/.test(new URL(input).pathname)) {
        const models: any[] = [], pages = new Set<string>();
        for (;;) {
            const response = await sendWithAuth(url);
            if (!response.ok) return response;
            const data = await response.json();
            if (!Array.isArray(data.models)) throw Error('Gemini 返回了无效模型列表');
            models.push(...data.models.filter((m: any) =>
                typeof m?.name === 'string' && m.name.trim() &&
                (m.supportedGenerationMethods == null || (Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent')))
            ).map((m: any) => ({ ...m, id: m.name.trim().replace(/^models\//, '') })).filter((m: any) => m.id));
            if (!data.nextPageToken) break;
            if (pages.has(data.nextPageToken)) throw Error('Gemini 模型列表分页重复');
            pages.add(data.nextPageToken); url.searchParams.set('pageToken', data.nextPageToken);
        }
        return new Response(JSON.stringify({ object: 'list', data: models }), { headers: { 'content-type': 'application/json' } });
    }
    if (method !== 'POST') return transport(resource, init);
    const raw = init?.body ?? (request ? await request.clone().text() : undefined);
    let body: any;
    try { body = typeof raw === 'string' ? JSON.parse(raw) : undefined; } catch { /* Unrelated request is left to its original transport. */ }
    if (typeof body?.model !== 'string' || !Array.isArray(body.messages)) return transport(resource, init);
    const model = body.model.replace(/^models\//, '').trim();
    if (!model || /[/?#]/.test(model)) throw Error('Gemini 模型名称无效');
    url.pathname += `/${encodeURIComponent(model)}:${body.stream ? 'streamGenerateContent' : 'generateContent'}`;
    if (body.stream) url.searchParams.set('alt', 'sse'); else url.searchParams.delete('alt');
    headers.set('content-type', 'application/json'); headers.delete('content-length');
    options.body = JSON.stringify(toGeminiRequest(body));
    const response = await sendWithAuth(url);
    if (!response.ok) return response;
    if (response.headers.get('content-type')?.includes('text/event-stream')) return convertGeminiStream(response, options.signal);
    return new Response(JSON.stringify(fromGeminiResponse(await response.json())), { status: response.status, statusText: response.statusText, headers: { 'content-type': 'application/json' } });
}

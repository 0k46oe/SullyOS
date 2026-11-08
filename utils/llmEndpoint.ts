export type LlmApiType = 'openai' | 'anthropic' | 'gemini';

/** Native endpoints are self-describing, including in the legacy three-field amsg credential. */
export function isAnthropicEndpoint(value: string): boolean {
    try { return /\/messages(?:\/(?:chat\/completions|models))?\/?$/.test(new URL(value).pathname); }
    catch { return false; }
}

/** Canonical native base also survives the three-field background credential format. */
export function isGeminiEndpoint(value: string): boolean {
    try { return /\/v1(?:beta)?\/models(?:\/(?:chat\/completions|models|[^/]+:(?:streamGenerateContent|generateContent)))?\/?$/.test(new URL(value).pathname); }
    catch { return false; }
}

export function normalizeLlmBaseUrl(value: string, type?: LlmApiType): string {
    const base = value.trim().replace(/\/+$/, '');
    if (!base) return base;
    if (!type) return base;
    try {
        const url = new URL(base);
        if (type === 'gemini') {
            url.pathname = url.pathname.replace(/\/models\/[^/]+:(?:streamGenerateContent|generateContent)\/?$/, '/models')
                .replace(/\/(?:chat\/completions|messages(?:\/chat\/completions)?)\/?$/, '').replace(/\/+$/, '');
            if (url.pathname.endsWith('/openai')) url.pathname = url.pathname.slice(0, -7);
            if (!url.pathname || url.pathname === '/') url.pathname = '/v1beta';
            if (!/\/v1(?:beta)?(?:\/models)?$/.test(url.pathname)) url.pathname += '/v1beta';
            if (!url.pathname.endsWith('/models')) url.pathname += '/models';
        } else if (type === 'anthropic') {
            url.pathname = url.pathname.replace(/\/(?:messages(?:\/chat\/completions)?|chat\/completions|models)\/?$/, '').replace(/\/+$/, '');
            if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
            url.pathname += '/messages';
        } else {
            url.pathname = url.pathname.replace(/\/messages(?:\/chat\/completions)?\/?$/, '').replace(/\/v1(?:beta)?\/models\/?$/, '/v1');
        }
        return url.href.replace(/\/$/, '');
    } catch { return base; }
}

export function nativeRequestUrl(value: string): string {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/messages\/chat\/completions\/?$/, '/messages').replace(/\/messages\/models\/?$/, '/models');
    return url.href;
}

export const llmApiType = (api: {apiType?: LlmApiType; protocol?: LlmApiType; baseUrl: string}): LlmApiType =>
    api.apiType ?? api.protocol ?? (isAnthropicEndpoint(api.baseUrl) ? 'anthropic' : isGeminiEndpoint(api.baseUrl) ? 'gemini' : 'openai');

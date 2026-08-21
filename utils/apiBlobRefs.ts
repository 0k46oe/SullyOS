// 令牌不出门：发往模型的请求体里不该出现 `blobref:<id>`。
//
// 图片改存 Blob 之后，字段里躺的是一个只有本机认得的短令牌（见 utils/blobRef.ts）。
// 渲染那头有 useBlobRefUrl 兜着，漏改一处顶多是「这里不显示图」，看得见也改得回来；
// 送模型这头没有对应的东西——令牌原样发出去，对面只会看到一串它读不懂的字符，
// 然后一本正经地说「我没看到图片」。没有报错、没有破图，从外面完全看不出哪里坏了。
//
// 所以在网络出口统一还原：请求体里凡是令牌，一律换成 data URL 再发。这样各处构造
// 请求的代码（聊天、群聊、相册看图、活动、通用识图）不用各记一遍这件事，将来新加的
// 出口也自动被覆盖。
//
// 三条边界：
//   · 只认字符串 body（模型请求都是 JSON 文本）。FormData / stream 原样放行。
//   · 先 indexOf 探一下有没有令牌，没有就一个字节都不动——绝大多数请求走这条路。
//   · 替换后的 data URL 只含 base64 字母表和 `:;,/=+`，在 JSON 字符串里无需转义，
//     所以直接做文本替换是安全的，不必把整个请求体 parse 一遍再 stringify
//     （聊天历史动辄几 MB，来回一趟纯属浪费）。
//
// 图已经丢了的令牌换成空串，跟 resolveBlobRefsDeep 的既有语义一致：宁可发一个空 url
// 让对面明确报错，也不要把内部令牌泄漏给第三方。

import { BLOBREF_PREFIX } from './blobRef';

/** 令牌的字面形态：前缀 + SDK 的 id 字符集。与 utils/blobDedupe.ts 的同名常量同源。 */
const TOKEN_PATTERN = new RegExp(
    `${BLOBREF_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[A-Za-z0-9_]+`,
    'g',
);

/**
 * 把请求体里的 blobref 令牌换成 data URL。
 * 非字符串 body / 不含令牌的 body 原样返回（同一个引用，调用方可以直接判等）。
 */
export async function resolveBlobRefsInRequestBody<T extends BodyInit | null | undefined>(
    body: T,
): Promise<T | string> {
    if (typeof body !== 'string') return body;
    if (!body.includes(BLOBREF_PREFIX)) return body;

    const tokens = new Set(body.match(TOKEN_PATTERN) ?? []);
    if (tokens.size === 0) return body;

    const { resolveRefToDataUrl } = await import('./blobRef');
    const resolved = new Map<string, string>();
    for (const token of tokens) {
        try {
            resolved.set(token, await resolveRefToDataUrl(token));
        } catch {
            resolved.set(token, ''); // 读不出来就当图丢了，别把令牌发出去
        }
    }

    return body.replace(TOKEN_PATTERN, m => resolved.get(m) ?? '');
}

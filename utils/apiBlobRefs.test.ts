import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { resolveBlobRefsInRequestBody } from './apiBlobRefs';
import { putImageBlob, dataUrlToBlob, BLOBREF_PREFIX } from './blobRef';
import { safeFetchJson } from './safeApi';

// 令牌是本机存储的内部形态，发给模型对面读不懂——只会得到「我没看到图片」这种
// 不报错也不破图的静默失败。这组用例钉住网络出口一定会把它还原成 data URL。

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_JPEG = 'data:image/jpeg;base64,AQIDBAUG';

describe('令牌不出门：请求体里的 blobref 还原成 data URL', () => {
    it('image_url 里的令牌换成可用的 data URL，JSON 结构完好', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const body = JSON.stringify({
            model: 'x',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: '看看这张图' },
                    { type: 'image_url', image_url: { url: token } },
                ],
            }],
        });

        const out = await resolveBlobRefsInRequestBody(body);

        expect(out).not.toContain(BLOBREF_PREFIX);
        const parsed = JSON.parse(out as string);   // 替换后仍是合法 JSON
        const url = parsed.messages[0].content[1].image_url.url;
        expect(url.startsWith('data:image/')).toBe(true);
        expect(parsed.messages[0].content[0].text).toBe('看看这张图');
    });

    it('多个不同令牌各换各的，不会串图', async () => {
        const a = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const b = await putImageBlob(dataUrlToBlob(TINY_JPEG));
        const out = await resolveBlobRefsInRequestBody(JSON.stringify({ a, b })) as string;

        const parsed = JSON.parse(out);
        expect(parsed.a).toContain('image/png');
        expect(parsed.b).toContain('image/jpeg');
        expect(parsed.a).not.toBe(parsed.b);
    });

    it('图已经丢了的令牌换成空串——宁可发空 url 也不把令牌泄漏出去', async () => {
        const dead = `${BLOBREF_PREFIX}b_deadbeef_1_zzzzzz`;
        const out = await resolveBlobRefsInRequestBody(JSON.stringify({ url: dead })) as string;

        expect(out).not.toContain(BLOBREF_PREFIX);
        expect(JSON.parse(out).url).toBe('');
    });

    it('不含令牌的请求体一个字节都不动（原样返回同一引用）', async () => {
        const body = JSON.stringify({ messages: [{ role: 'user', content: '普通文字' }] });
        expect(await resolveBlobRefsInRequestBody(body)).toBe(body);
    });

    it('非字符串 body 原样放行', async () => {
        const fd = new FormData();
        expect(await resolveBlobRefsInRequestBody(fd)).toBe(fd);
        expect(await resolveBlobRefsInRequestBody(undefined)).toBeUndefined();
        expect(await resolveBlobRefsInRequestBody(null)).toBeNull();
    });

    it('令牌旁边的普通文本不受影响（只吃令牌那一段）', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        const out = await resolveBlobRefsInRequestBody(
            JSON.stringify({ text: `前面 ${token} 后面` }),
        ) as string;

        const value = JSON.parse(out).text;
        expect(value.startsWith('前面 data:image/')).toBe(true);
        expect(value.endsWith(' 后面')).toBe(true);
    });
});

describe('接线守卫：safeFetchJson 真的发不出令牌', () => {
    let sent: string | null = null;

    beforeEach(() => {
        sent = null;
        vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
            sent = typeof init?.body === 'string' ? init.body : null;
            return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        }));
    });

    afterEach(() => { vi.unstubAllGlobals(); });

    it('带令牌的聊天请求，发到网络上的 body 里已经是 data URL', async () => {
        const token = await putImageBlob(dataUrlToBlob(TINY_PNG));
        await safeFetchJson('https://example.com/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify({ messages: [{ content: [{ type: 'image_url', image_url: { url: token } }] }] }),
        });

        expect(sent).not.toBeNull();
        expect(sent).not.toContain(BLOBREF_PREFIX);
        expect(sent).toContain('data:image/png;base64,');
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    normalizeNote,
    XHS_SPIDER_V3_EXPERIMENT,
    XhsMcpClient,
    normalizeXhsLiteDetail,
    parseXhsCount,
} from './xhsMcpClient';

describe('parseXhsCount', () => {
    it('parses compact Chinese and English counters without truncating decimals', () => {
        expect(parseXhsCount('1.2万')).toBe(12_000);
        expect(parseXhsCount('3万+')).toBe(30_000);
        expect(parseXhsCount('2.5k')).toBe(2_500);
        expect(parseXhsCount('1,234')).toBe(1_234);
    });
});

describe('normalizeNote', () => {
    it('reads compact likes from Lite detail data', () => {
        expect(normalizeNote({
            note_id: 'note-1',
            title: '标题',
            interact_info: { liked_count: '1.2万' },
        })).toMatchObject({
            noteId: 'note-1',
            title: '标题',
            likes: 12_000,
        });
    });
});

describe('normalizeXhsLiteDetail', () => {
    it('keeps comments returned by the Lite bridge', () => {
        const payload = {
            data: {
                note: {
                    note_id: 'note-1',
                    title: '标题',
                    interact_info: { liked_count: '1.2万' },
                },
                comments: {
                    list: [{
                        nickname: '甲',
                        content: '一级评论',
                        like_count: '1.2万',
                        sub_comments: [{
                            nickname: '乙',
                            content: '回复内容',
                            like_count: '2',
                        }],
                    }],
                },
            },
        };

        expect(normalizeXhsLiteDetail(payload)).toMatchObject({
            noteId: 'note-1',
            title: '标题',
            likes: 12_000,
            comments: [
                { author: '甲', content: '一级评论', likes: 12_000 },
                { author: '乙', content: '回复内容', likes: 2 },
            ],
        });
    });
});
describe('Spider v3 hidden client patch', () => {
    let values: Map<string, string>;

    beforeEach(() => {
        values = new Map();
        vi.stubGlobal('localStorage', {
            get length() { return values.size; },
            clear: () => values.clear(),
            getItem: (key: string) => values.get(key) ?? null,
            key: (index: number) => Array.from(values.keys())[index] ?? null,
            removeItem: (key: string) => values.delete(key),
            setItem: (key: string, value: string) => values.set(key, String(value)),
        });
        XhsMcpClient.setCookie(`a1=${'a'.repeat(52)}; web_session=test-session`);
    });

    afterEach(() => {
        XhsMcpClient.setCookie('');
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    const unavailableDetail = () => ({
        success: true,
        data: {
            note: { note_id: 'a'.repeat(24), title: 'test' },
            comments: { list: [] },
            comments_status: 'unavailable',
            comments_error: { code: 'COMMENT_PROVIDER_NOT_CONFIGURED' },
        },
    });


    it('persists opaque session state and merges comments by default', async () => {
        localStorage.setItem('os_realtime_config', JSON.stringify({ xhsMcpConfig: { rnoteApiKey: 'legacy-paid-key' } }));
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const url = String(input);
            if (url.endsWith('/api/get-feed-detail')) {
                const safeHeaders = new Headers(init?.headers);
                expect(safeHeaders.has('x-rnote-api-key')).toBe(false);
                return new Response(JSON.stringify(unavailableDetail()), {
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.endsWith('/api/xhs-experimental-comments')) {
                const headers = new Headers(init?.headers);
                expect(headers.get('x-xhs-experiment-ack')).toBe(XHS_SPIDER_V3_EXPERIMENT.optInValue);
                expect(headers.get('x-xhs-cookie')).toContain('web_session=test-session');
                const body = JSON.parse(String(init?.body));
                expect(body.acknowledge_risk).toBe(true);
                expect(body.strategy).toBe('no-client-hints');
                return new Response(JSON.stringify({
                    success: true,
                    data: {
                        comments: { list: [{ comment_id: 'comment-1', content: 'patched' }] },
                        comments_status: 'loaded',
                        comments_provider: 'spider-session-v3',
                    },
                    session_state: {
                        version: 1,
                        a1Tag: '6c1b3dc7a706b9dc',
                        loadts: 1785079999000,
                        dsllt: 1785079999000,
                        mnsSeq: 1,
                        signCount: 1,
                        b1Seed: 1,
                        timeOrigin: 1785079998000,
                        webBuild: '6.32.2',
                    },
                }), { headers: { 'content-type': 'application/json' } });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        const result = await XhsMcpClient.getNoteDetail(
            'https://worker.test/api',
            `https://www.xiaohongshu.com/explore/${'a'.repeat(24)}`,
            'token',
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.success).toBe(true);
        expect(result.data.data.comments_provider).toBe('spider-session-v3');
        expect(result.data.data.comments.list[0].content).toBe('patched');
        expect(JSON.parse(localStorage.getItem(XHS_SPIDER_V3_EXPERIMENT.sessionKey) || '{}')).toMatchObject({
            version: 1,
            mnsSeq: 1,
            signCount: 1,
        });
    });

    it('persists a per-cookie circuit break after one 406 result', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = String(input);
            if (url.endsWith('/api/get-feed-detail')) {
                return new Response(JSON.stringify(unavailableDetail()), {
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.endsWith('/api/xhs-experimental-comments')) {
                return new Response(JSON.stringify({
                    success: false,
                    error_code: 'XHS_EXPERIMENT_HTTP_406',
                    session_state: {
                        version: 1,
                        a1Tag: '6c1b3dc7a706b9dc',
                        loadts: 1785079999000,
                        dsllt: 1785079999000,
                        mnsSeq: 1,
                        signCount: 1,
                        b1Seed: 1,
                        timeOrigin: 1785079998000,
                        webBuild: '6.32.2',
                    },
                }), { headers: { 'content-type': 'application/json' } });
            }
            throw new Error(`unexpected request: ${url}`);
        });

        const first = await XhsMcpClient.getNoteDetail(
            'https://worker.test/api',
            `https://www.xiaohongshu.com/explore/${'a'.repeat(24)}`,
            'token',
            { loadAllComments: true },
        );
        const second = await XhsMcpClient.getNoteDetail(
            'https://worker.test/api',
            `https://www.xiaohongshu.com/explore/${'a'.repeat(24)}`,
            'token',
            { loadAllComments: true },
        );

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(first.data.data.comments_error.code).toBe('SPIDER_V3_CIRCUIT_OPEN');
        expect(second.data.data.comments_error.code).toBe('SPIDER_V3_CIRCUIT_OPEN');
        expect(JSON.parse(localStorage.getItem(XHS_SPIDER_V3_EXPERIMENT.circuitKey) || '{}')).toMatchObject({
            reason: 'XHS_EXPERIMENT_HTTP_406',
        });
    });
});

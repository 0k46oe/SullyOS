import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../index.js';

const COOKIE = `a1=${'a'.repeat(52)}; web_session=test-session`;

const callLite = (
  command: string,
  body: Record<string, unknown> = {},
  env: Record<string, unknown> = {},
  rnoteApiKey = '',
) =>
  worker.fetch(
    new Request(`https://local.test/api/${command}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-xhs-cookie': COOKIE,
        ...(rnoteApiKey ? { 'x-rnote-api-key': rnoteApiKey } : {}),
      },
      body: JSON.stringify(body),
    }),
    env,
    { waitUntil() {} },
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('XHS Lite session-risk headers', () => {
  it('keeps search on the previously stable request shape', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: { items: [] } }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await callLite('search', { keyword: '小猫' });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const [, init] = upstream.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.has('x-rap-param')).toBe(false);
    expect(headers.has('xy-direction')).toBe(false);
    expect(headers.get('user-agent')).toContain('Chrome/138.0.0.0');
    expect(headers.get('sec-ch-ua')).toContain('Chromium";v="138"');
  });

  it('does not call the protected XHS comment endpoint when no managed provider is configured', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/sns/web/v1/feed')) {
        return new Response(JSON.stringify({
          success: true,
          data: { items: [{ note_card: { title: 'test', desc: 'body' } }] },
        }));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const response = await callLite('get-feed-detail', {
      feed_id: 'note-id',
      xsec_token: 'token',
      xsec_source: 'pc_share',
      load_all_comments: true,
    });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);

    const [, detailInit] = upstream.mock.calls[0];
    const detailHeaders = new Headers(detailInit?.headers);
    expect(detailHeaders.has('x-rap-param')).toBe(false);
    expect(detailHeaders.get('xy-direction')).toBe('13');

    const body = await response.json();
    expect(body.data.comments.list).toEqual([]);
    expect(body.data.comments_status).toBe('unavailable');
    expect(body.data.comments_error.code).toBe('COMMENT_PROVIDER_NOT_CONFIGURED');
  });

  it('loads real comments through the managed provider without forwarding the user cookie', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/sns/web/v1/feed')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            items: [{
              note_card: {
                title: 'test',
                desc: 'body',
                interact_info: { comment_count: '1' },
              },
            }],
          },
        }));
      }
      if (url.startsWith('https://rnote.dev/api/v2/crawler/note/comments')) {
        const headers = new Headers(init?.headers);
        expect(headers.get('X-API-Key')).toBe('provider-key');
        expect(headers.has('cookie')).toBe(false);
        expect(headers.has('x-xhs-cookie')).toBe(false);
        expect(headers.has('x-s')).toBe(false);
        return new Response(JSON.stringify({
          success: true,
          data: {
            data: {
              comments: [{
                comment_id: 'comment-1',
                content: '真实评论',
                like_count: '12',
                user_info: { user_id: 'user-1', nickname: '甲' },
              }],
            },
          },
        }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const response = await callLite('get-feed-detail', {
      feed_id: 'note-id',
      xsec_token: 'token',
      xsec_source: 'pc_share',
      load_all_comments: true,
    }, { RNOTE_API_KEY: 'provider-key' });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    const body = await response.json();
    expect(body.data.comments_status).toBe('loaded');
    expect(body.data.comments_provider).toBe('rnote');
    expect(body.data.comments.list).toEqual([expect.objectContaining({
      comment_id: 'comment-1',
      content: '真实评论',
      nickname: '甲',
    })]);
  });

  it('uses a per-user Rnote key without storing it in Worker env', async () => {
    const upstream = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/sns/web/v1/feed')) {
        return new Response(JSON.stringify({
          success: true,
          data: { items: [{ note_card: { title: 'test', desc: 'body' } }] },
        }));
      }
      if (url.startsWith('https://rnote.dev/api/v2/crawler/note/comments')) {
        const headers = new Headers(init?.headers);
        expect(headers.get('X-API-Key')).toBe('user-owned-key');
        expect(headers.has('cookie')).toBe(false);
        expect(headers.has('x-xhs-cookie')).toBe(false);
        return new Response(JSON.stringify({
          success: true,
          data: {
            comments: [{
              comment_id: 'comment-user-key',
              content: '用户 Key 读取的真实评论',
              user_info: { nickname: '乙' },
            }],
          },
        }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const response = await callLite('get-feed-detail', {
      feed_id: 'note-id',
      xsec_token: 'token',
      load_all_comments: true,
    }, {}, 'user-owned-key');

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    const body = await response.json();
    expect(body.data.comments_status).toBe('loaded');
    expect(body.data.comments_provider).toBe('rnote');
    expect(body.data.comments.list[0].content).toBe('用户 Key 读取的真实评论');
  });
});

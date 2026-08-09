import { describe, it, expect } from 'vitest';
import {
  resolveObservability,
  handleSelfUpdate,
  rebuildBindings,
  resolveScriptName,
} from './selfUpdate';

describe('rebuildBindings', () => {
  // Cloudflare 的上传接口是整体替换：这一发没带的 binding 等于删掉。
  // 而读回来的密钥只有名字没有值，所以必须从 env 补——补漏了就是把用户的密钥抹了。
  it('把密钥的值从运行时补回去', () => {
    const result = rebuildBindings(
      [
        { type: 'secret_text', name: 'AMSG_MASTER_KEY' },
        { type: 'secret_text', name: 'VAPID_PRIVATE_KEY' },
      ],
      { AMSG_MASTER_KEY: 'mk', VAPID_PRIVATE_KEY: 'pk' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bindings).toEqual([
      { type: 'secret_text', name: 'AMSG_MASTER_KEY', text: 'mk' },
      { type: 'secret_text', name: 'VAPID_PRIVATE_KEY', text: 'pk' },
    ]);
  });

  it('非密钥的 binding 原样搬过去', () => {
    const d1 = { type: 'd1', name: 'DB', id: 'db-uuid' };
    const plain = { type: 'plain_text', name: 'SOME_VAR', text: 'v' };
    const result = rebuildBindings([d1, plain], {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // D1 的 id 必须原样带回，否则新版本会丢掉数据库绑定
    expect(result.bindings).toEqual([d1, plain]);
  });

  it('补不到值时整体中止，不能悄悄少传一条', () => {
    const result = rebuildBindings(
      [
        { type: 'secret_text', name: 'AMSG_MASTER_KEY' },
        { type: 'secret_text', name: 'VAPID_PRIVATE_KEY' },
      ],
      { AMSG_MASTER_KEY: 'mk' }, // VAPID_PRIVATE_KEY 读不到
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(['VAPID_PRIVATE_KEY']);
  });

  it('值是空字符串也算读不到——传上去等于把密钥清空', () => {
    const result = rebuildBindings([{ type: 'secret_text', name: 'AMSG_SERVER_TOKEN' }], {
      AMSG_SERVER_TOKEN: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.missing).toEqual(['AMSG_SERVER_TOKEN']);
  });
});

describe('resolveScriptName', () => {
  it('从 workers.dev 域名反推 worker 名', () => {
    expect(resolveScriptName({}, 'https://sullyos-amsg.someone.workers.dev/self-update')).toBe(
      'sullyos-amsg',
    );
  });

  it('配了 CF_SCRIPT_NAME 就以它为准', () => {
    expect(
      resolveScriptName({ CF_SCRIPT_NAME: '  my-worker  ' }, 'https://other.workers.dev/self-update'),
    ).toBe('my-worker');
  });

  // 国内会在 workers.dev 外面套一层 Deno 门面。那时请求进来挂的是代理域名，
  // 照着反推会得出一个不存在的 worker 名，然后去更新「别的东西」。宁可认不出来。
  it('不是 workers.dev 域名就认不出来，交给 CF_SCRIPT_NAME', () => {
    expect(resolveScriptName({}, 'https://my-proxy.deno.net/self-update')).toBeNull();
    expect(resolveScriptName({}, 'https://amsg.example.com/self-update')).toBeNull();
  });
});

describe('resolveObservability', () => {
  // 上传是整体覆盖：metadata 里不带 observability，之前开着的实时日志就没了
  // （实测确认：开成 enabled:true 之后不带这个字段重传一次，再读回来就没有）。
  it('读回来是什么就带上什么', () => {
    const current = { enabled: true, logs: { enabled: true, invocation_logs: false } };
    expect(resolveObservability(current)).toEqual(current);
  });

  it('用户明确关掉的也照样尊重，不强行开', () => {
    expect(resolveObservability({ enabled: false })).toEqual({ enabled: false });
  });

  it('读不到就按开启兜底——仓库里的 wrangler.toml 声明的就是开', () => {
    const fallback = { enabled: true, logs: { enabled: true } };
    expect(resolveObservability(undefined)).toEqual(fallback);
    expect(resolveObservability(null)).toEqual(fallback);
  });
});

describe('handleSelfUpdate 上传时带的 metadata', () => {
  const FAKE_BUNDLE = `// src_default as default\n${'x'.repeat(200 * 1024)}`;

  /** 把这次自更新打到 Cloudflare 的每一发都记下来。 */
  const runSelfUpdate = async (observability?: unknown) => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any = {}) => {
      const url = String(input);
      if (url.includes('raw.githubusercontent.com')) return new Response(FAKE_BUNDLE);
      const path = new URL(url).pathname;
      const method = init.method ?? 'GET';
      let body: unknown = null;
      if (init.body instanceof FormData) {
        const part = init.body.get('settings') ?? init.body.get('metadata');
        body = part instanceof Blob ? JSON.parse(await part.text()) : null;
      }
      calls.push({ method, path, body });
      if (method === 'GET' && path.endsWith('/settings')) {
        return Response.json({
          success: true,
          result: {
            bindings: [{ type: 'secret_text', name: 'AMSG_MASTER_KEY' }],
            compatibility_date: '2026-01-01',
            observability,
          },
        });
      }
      return Response.json({ success: true, result: {} });
    }) as typeof fetch;

    try {
      const result = await handleSelfUpdate(
        new Request('https://amsg.test.workers.dev/self-update', {
          method: 'POST',
          headers: { 'X-Client-Token': 'shared' },
        }),
        {
          AMSG_SERVER_TOKEN: 'shared',
          CF_API_TOKEN: 'cf-token',
          CF_SCRIPT_NAME: 'sullyos-amsg',
          CF_ACCOUNT_ID: 'acc-1',
          AMSG_MASTER_KEY: 'mk',
        } as any,
      );
      return { result, calls };
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  const uploadMetadata = (calls: Array<{ method: string; body: any }>) =>
    calls.find((c) => c.method === 'PUT')?.body;

  it('上传时带上实时日志开关，否则每更新一次就把它打回默认关', async () => {
    const observability = { enabled: true, logs: { enabled: true } };
    const { result, calls } = await runSelfUpdate(observability);

    expect(result.ok).toBe(true);
    expect(uploadMetadata(calls)?.observability).toEqual(observability);
  });

  it('原本没设过的，上传时按开启兜底', async () => {
    const { calls } = await runSelfUpdate(undefined);

    expect(uploadMetadata(calls)?.observability).toEqual({ enabled: true, logs: { enabled: true } });
  });

  it('用户明确关掉的，更新不会替他打开', async () => {
    const { calls } = await runSelfUpdate({ enabled: false });

    expect(uploadMetadata(calls)?.observability).toEqual({ enabled: false });
  });
});

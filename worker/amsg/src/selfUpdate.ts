/**
 * 自更新：在 SullyOS 里点一下，worker 自己去取最新代码覆盖自己。
 *
 * 为什么要有这个：后端有三条安装路，更新体验差得很远——
 *   - 照手册 fork 一份再连仓库：GitHub 上点一下 Sync fork 就自动重新部署
 *   - 「Deploy to Cloudflare」按钮：它给你的是 clone 出来的独立仓库、不是 fork，
 *     没有 Sync fork 可点，只能自己往仓库里传新的 worker.bundle.js
 *   - 找人代配：每次更新都得再找一次
 * 有了这条，三条路的更新都变成「在 SullyOS 里点一下」，手机上尤其省事。
 *
 * 浏览器为什么不能直接干这事：api.cloudflare.com 不返回 CORS 头，前端 fetch 一律被拦。
 * 而 worker 自己跑在 Cloudflare 上，调 API 没这个问题，所以这活儿只能落在这一侧。
 *
 * 安全上的三条底线：
 *   1. 必须配了共享密钥并校验通过才让动——没有密钥的实例直接拒绝，不给「谁都能触发」的口子
 *   2. 新代码先校验再上传，任何一项不对就原样不动（把自己刷挂了就没法再自更新了）
 *   3. token 只出现在发往 Cloudflare 的请求头里，任何响应体都不回显它
 */

import { constantTimeEqual } from './instantChat';

const CF_API = 'https://api.cloudflare.com/client/v4';

/** 官方成品代码。跟代配脚本、手册附录指的是同一份。 */
const BUNDLE_URL =
  'https://raw.githubusercontent.com/Tosd0/sullyos-workers/main/amsg/worker.bundle.js';

/** 上传时用的模块名，同时也是 metadata.main_module，两处必须一致。 */
const MAIN_MODULE = 'worker.bundle.js';

/** 兜底用的运行时配置，只在读不到现有配置时才用，跟 wrangler.toml 保持一致。 */
const FALLBACK_COMPATIBILITY_DATE = '2026-01-01';
const FALLBACK_COMPATIBILITY_FLAGS = ['global_fetch_strictly_public'];

/** 成品包实测 400 KB 出头。低于这个数基本就是拿到错误页了。 */
const MIN_BUNDLE_BYTES = 100 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

/** 成品包必须带的导出标记，用来认「这确实是 amsg 的 worker」。 */
const BUNDLE_FINGERPRINT = 'src_default as default';

export interface SelfUpdateEnv {
  AMSG_SERVER_TOKEN?: string;
  /** Cloudflare API Token，只需要 Workers Scripts → Edit。没配就用不了自更新。 */
  CF_API_TOKEN?: string;
  /** 可选：不配就拿 token 去问 Cloudflare。只有一个账号时能问出来。 */
  CF_ACCOUNT_ID?: string;
  /** 可选：不配就从 workers.dev 域名反推。套了代理域名时必须配。 */
  CF_SCRIPT_NAME?: string;
}

export interface SelfUpdateResult {
  ok: boolean;
  code: string;
  message: string;
  /** 新代码的指纹（sha-256 前 12 位），给前端显示「现在跑的是哪一版」。 */
  bundleHash?: string;
  bundleBytes?: number;
  scriptName?: string;
}

const fail = (code: string, message: string): SelfUpdateResult => ({ ok: false, code, message });

/** 调 Cloudflare API，把 {success, errors, result} 那层信封拆掉。 */
async function cf(
  token: string,
  path: string,
  init: { method?: string; body?: FormData } = {},
): Promise<{ ok: true; result: any } | { ok: false; detail: string }> {
  let res: Response;
  try {
    res = await fetch(`${CF_API}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}` },
      body: init.body,
    });
  } catch (err) {
    return { ok: false, detail: `连不上 Cloudflare API：${(err as Error).message}` };
  }

  const text = await res.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, detail: `Cloudflare 返回了非 JSON（HTTP ${res.status}）` };
  }
  if (!res.ok || payload?.success === false) {
    const detail =
      (payload?.errors ?? []).map((e: any) => `${e.code}: ${e.message}`).join('；') ||
      `HTTP ${res.status}`;
    return { ok: false, detail };
  }
  return { ok: true, result: payload.result };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 定位「我是谁」。
 *
 * 域名反推只在 *.workers.dev 上成立：国内套了 Deno 门面之后请求进来时挂的是代理域名，
 * 照着推会得出一个不存在的 worker 名，那就必须让 CF_SCRIPT_NAME 说了算。
 */
export function resolveScriptName(env: SelfUpdateEnv, requestUrl: string): string | null {
  const configured = env.CF_SCRIPT_NAME?.trim();
  if (configured) return configured;
  let host: string;
  try {
    host = new URL(requestUrl).hostname;
  } catch {
    return null;
  }
  if (!host.endsWith('.workers.dev')) return null;
  const name = host.split('.')[0];
  return name || null;
}

/**
 * 找出「我住在哪个账号下」，顺带把这个账号的配置读回来。
 *
 * `GET /accounts` 是用户级端点，返回的是这个人名下的**所有**账号，跟 token 限定了哪个账号
 * 没关系。所以同时有工作号和个人号的人在这儿会拿到好几条，光看列表分不出该更新哪个。
 * 办法是挨个问一句「你这儿有没有这个 Worker」——能读出配置的那个就是。
 */
async function locateScript(
  env: SelfUpdateEnv,
  token: string,
  scriptName: string,
): Promise<{ ok: true; accountId: string; settings: any } | { ok: false; message: string }> {
  const settingsPath = (accountId: string) =>
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`;

  const configured = env.CF_ACCOUNT_ID?.trim();
  if (configured) {
    const settings = await cf(token, settingsPath(configured));
    if (!settings.ok) {
      return {
        ok: false,
        message: `在 CF_ACCOUNT_ID 指定的账号里读不到这个 Worker 的配置（${settings.detail}）。`,
      };
    }
    return { ok: true, accountId: configured, settings: settings.result };
  }

  const listed = await cf(token, '/accounts');
  if (!listed.ok) {
    return {
      ok: false,
      message: `问不到账号列表（${listed.detail}）。给 Worker 加一条 CF_ACCOUNT_ID 变量即可跳过这一步。`,
    };
  }
  const accounts: any[] = Array.isArray(listed.result) ? listed.result : [];
  if (!accounts.length) {
    return { ok: false, message: '这枚 token 一个账号都读不到，多半是权限没给全或者已经过期。' };
  }

  for (const account of accounts) {
    const settings = await cf(token, settingsPath(account.id));
    if (settings.ok) return { ok: true, accountId: account.id, settings: settings.result };
  }
  return {
    ok: false,
    message:
      `在这枚 token 能碰到的 ${accounts.length} 个账号里都没找到名为 ${scriptName} 的 Worker。` +
      '要么 token 的权限没覆盖到它所在的账号，要么 Worker 名字对不上（可用 CF_SCRIPT_NAME 指定）。',
  };
}

/** 取回最新成品包，并确认它确实是 amsg 的 worker 而不是一张错误页。 */
async function fetchLatestBundle(): Promise<
  { ok: true; code: string } | { ok: false; message: string }
> {
  let res: Response;
  try {
    res = await fetch(BUNDLE_URL, { headers: { 'User-Agent': 'sullyos-amsg-self-update' } });
  } catch (err) {
    return { ok: false, message: `取不到最新代码：${(err as Error).message}` };
  }
  if (!res.ok) return { ok: false, message: `取最新代码失败（HTTP ${res.status}）` };

  const code = await res.text();
  const bytes = new TextEncoder().encode(code).length;
  if (bytes < MIN_BUNDLE_BYTES || bytes > MAX_BUNDLE_BYTES) {
    return { ok: false, message: `取回来的文件大小不对（${bytes} 字节），没有覆盖，当前版本不动。` };
  }
  if (!code.includes(BUNDLE_FINGERPRINT)) {
    return { ok: false, message: '取回来的文件不像 amsg 的 worker 代码，没有覆盖，当前版本不动。' };
  }
  return { ok: true, code };
}

/**
 * 把现有 binding 原样搬到新版本上。
 *
 * Cloudflare 的上传接口是整体替换：这一发没带的 binding 等于删掉。D1 那条能从接口原样读回，
 * 但密钥只回名字不回值——值得从 env 里补。补不齐就中止，不能带着残缺的 binding 上传，
 * 那等于把用户的密钥抹了。
 */
export function rebuildBindings(
  existing: any[],
  env: Record<string, unknown>,
): { ok: true; bindings: any[] } | { ok: false; missing: string[] } {
  const bindings: any[] = [];
  const missing: string[] = [];

  for (const binding of existing) {
    if (binding?.type === 'secret_text') {
      const value = env[binding.name];
      if (typeof value !== 'string' || !value) {
        missing.push(binding.name);
        continue;
      }
      bindings.push({ type: 'secret_text', name: binding.name, text: value });
    } else {
      bindings.push(binding);
    }
  }

  if (missing.length) return { ok: false, missing };
  return { ok: true, bindings };
}

export async function handleSelfUpdate(
  request: Request,
  env: SelfUpdateEnv,
): Promise<SelfUpdateResult> {
  // ① 没设共享密钥的实例一律不给自更新：那种实例的地址等于全公开，
  //    留这个口子相当于谁都能让别人的后端重新部署一次。
  const serverToken = env.AMSG_SERVER_TOKEN?.trim();
  if (!serverToken) {
    return fail(
      'SERVER_TOKEN_REQUIRED',
      '这个 Worker 没设共享密钥（AMSG_SERVER_TOKEN），出于安全考虑不开放自更新。先补上再试。',
    );
  }
  // 常时比较：这个端点能让 worker 覆盖自己的代码，密钥校验不能从耗时上漏字。
  const clientToken = request.headers.get('X-Client-Token');
  if (!clientToken || !(await constantTimeEqual(clientToken, serverToken))) {
    return fail('UNAUTHORIZED', '共享密钥对不上。');
  }

  const token = env.CF_API_TOKEN?.trim();
  if (!token) {
    return fail(
      'CF_TOKEN_MISSING',
      '没配 CF_API_TOKEN，没法自己更新。去 Cloudflare 建一枚只勾 Workers Scripts → Edit 的 API Token，加进这个 Worker 的变量里。',
    );
  }

  const scriptName = resolveScriptName(env, request.url);
  if (!scriptName) {
    return fail(
      'SCRIPT_NAME_UNKNOWN',
      '认不出这个 Worker 叫什么（多半是套了代理域名）。给它加一条 CF_SCRIPT_NAME 变量，值填 Worker 的名字。',
    );
  }

  // ② 定位自己住在哪个账号下，同时把现有配置读回来：binding、兼容性日期都照搬，
  //    免得自更新顺手改了运行时行为。
  const located = await locateScript(env, token, scriptName);
  if (!located.ok) return fail('SCRIPT_NOT_LOCATED', located.message);
  const account = { id: located.accountId };
  const settings = { result: located.settings };

  // ③ 新代码先拿到手并验明正身，再碰线上的东西。
  const bundle = await fetchLatestBundle();
  if (!bundle.ok) return fail('BUNDLE_INVALID', bundle.message);

  // 密钥的名字要到运行时才知道（读回来的 binding 列表说了算），所以这里按名取值，
  // 类型上就只能当成一袋 key-value 看。
  const rebuilt = rebuildBindings(
    settings.result?.bindings ?? [],
    env as unknown as Record<string, unknown>,
  );
  if (!rebuilt.ok) {
    return fail(
      'BINDING_VALUE_MISSING',
      `这几项密钥在运行时读不到值：${rebuilt.missing.join('、')}。` +
        '照原样传上去会把它们抹掉，所以没有覆盖，当前版本不动。',
    );
  }

  const metadata = {
    main_module: MAIN_MODULE,
    compatibility_date: settings.result?.compatibility_date || FALLBACK_COMPATIBILITY_DATE,
    compatibility_flags: settings.result?.compatibility_flags?.length
      ? settings.result.compatibility_flags
      : FALLBACK_COMPATIBILITY_FLAGS,
    bindings: rebuilt.bindings,
  };

  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set(
    MAIN_MODULE,
    new Blob([bundle.code], { type: 'application/javascript+module' }),
    MAIN_MODULE,
  );

  // ④ 覆盖自己。这一刻之后的请求就走新代码了，本次响应仍由旧代码发出。
  const uploaded = await cf(
    token,
    `/accounts/${account.id}/workers/scripts/${encodeURIComponent(scriptName)}`,
    { method: 'PUT', body: form },
  );
  if (!uploaded.ok) {
    return fail('UPLOAD_FAILED', `上传失败（${uploaded.detail}）。当前版本不动。`);
  }

  const hash = (await sha256Hex(bundle.code)).slice(0, 12);
  const bytes = new TextEncoder().encode(bundle.code).length;
  return {
    ok: true,
    code: 'UPDATED',
    message: '已经更新到最新版本。',
    bundleHash: hash,
    bundleBytes: bytes,
    scriptName,
  };
}

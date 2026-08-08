/**
 * 一键部署主动消息后端：用户只提供一枚 Cloudflare API Token，剩下的全在这里做完。
 *
 * 做的事按顺序是：验 token → 找出能用的账号 → 建 D1 → 确认 workers.dev 子域 →
 * 拉最新 bundle → 上传 Worker（密钥和 D1 绑定一次带齐）→ 加 cron → 开 workers.dev。
 * 密钥（Master Key / VAPID / Server Token）在浏览器本地生成，用户全程不用复制粘贴。
 *
 * 为什么要绕一层代理：api.cloudflare.com 一个 CORS 头都不返回，浏览器直接调不通，
 * 所有请求都得过中心 worker 的 /cf-api（见 worker/index.js）。
 *
 * 跟「更新后端」的分工：那条路是 worker 拿自己 env 里的 token 覆盖自己
 * （worker/amsg/src/selfUpdate.ts），能保住密钥；这里是从零装，密钥是新生成的。
 */

import { getProxyWorkerUrl } from './proxyWorker';
import { generateVapidKeyPair, generateClientToken } from './vapidGen';

/** 部署出来的 Worker / D1 默认叫这个，跟 worker/amsg/wrangler.toml 对齐。 */
export const AMSG_SCRIPT_NAME = 'sullyos-amsg';
export const AMSG_D1_NAME = 'sullyos-amsg';

/** 上传时的模块名，同时是 metadata.main_module，两处必须一致。 */
const MAIN_MODULE = 'worker.bundle.js';

const BUNDLE_BASE = 'https://raw.githubusercontent.com/Tosd0/sullyos-workers/main/amsg';
const BUNDLE_URL = `${BUNDLE_BASE}/${MAIN_MODULE}`;
const WRANGLER_URL = `${BUNDLE_BASE}/wrangler.toml`;

/**
 * 读不到线上 wrangler.toml 时用的兜底，值抄自 worker/amsg/wrangler.toml。
 * 正常路径是现拉现解析，免得这边的常量和 worker 那边慢慢漂开——
 * compatibility_flags 少一个 global_fetch_strictly_public，角色调自配 MCP 就会 1042。
 */
const FALLBACK_CONFIG: WorkerDeployConfig = {
  compatibilityDate: '2026-01-01',
  compatibilityFlags: ['global_fetch_strictly_public'],
  crons: ['* * * * *'],
  d1Binding: 'DB',
};

/** bundle 的合理体积区间。太小多半是拉到了 404 页面，太大是打包出了岔子。 */
const MIN_BUNDLE_BYTES = 100 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export interface WorkerDeployConfig {
  compatibilityDate: string;
  compatibilityFlags: string[];
  crons: string[];
  d1Binding: string;
}

export interface CfAccount {
  id: string;
  name: string;
}

export type ProvisionStepId =
  | 'relay'
  | 'token'
  | 'account'
  | 'database'
  | 'subdomain'
  | 'bundle'
  | 'upload'
  | 'cron'
  | 'expose'
  | 'done';

export interface ProvisionProgress {
  step: ProvisionStepId;
  message: string;
}

export interface AmsgSecrets {
  AMSG_MASTER_KEY: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_EMAIL: string;
  AMSG_SERVER_TOKEN: string;
}

export interface ProvisionInput {
  token: string;
  /** 多账号时由界面选定；只有一个能用就自动选。 */
  accountId?: string;
  /** 账号还没有 workers.dev 子域时，由界面问出来再传进来。 */
  desiredSubdomain?: string;
  scriptName?: string;
  /** 复用已有密钥（重装时传，避免换掉 Master Key 让旧任务解不开）。 */
  secrets?: Partial<AmsgSecrets>;
  onProgress?: (p: ProvisionProgress) => void;
}

export type ProvisionFailureCode =
  | 'RELAY_UNSUPPORTED'
  | 'TOKEN_INVALID'
  | 'NO_USABLE_ACCOUNT'
  | 'ACCOUNT_AMBIGUOUS'
  | 'SUBDOMAIN_MISSING'
  | 'SUBDOMAIN_TAKEN'
  | 'BUNDLE_INVALID'
  | 'SCRIPT_EXISTS'
  | 'UPLOAD_FAILED'
  | 'CF_ERROR'
  | 'NETWORK';

export interface ProvisionFailure {
  ok: false;
  code: ProvisionFailureCode;
  message: string;
  /** ACCOUNT_AMBIGUOUS 时给界面挑。 */
  accounts?: CfAccount[];
}

export interface ProvisionSuccess {
  ok: true;
  workerUrl: string;
  scriptName: string;
  accountId: string;
  databaseId: string;
  /** 用的是已经存在的同名数据库（不是新建的），界面要提醒一句。 */
  reusedDatabase: boolean;
  secrets: AmsgSecrets;
  /** observability 是尽力而为，没开成不影响功能，但值得说一声。 */
  warnings: string[];
}

export type ProvisionResult = ProvisionSuccess | ProvisionFailure;

// ---------------------------------------------------------------------------
// 纯函数部分（可单测，不碰网络）
// ---------------------------------------------------------------------------

/**
 * 从 wrangler.toml 里挑出部署要用的四项。不是通用 TOML 解析器，只认这几个键；
 * 任何一项没匹配上就用兜底值，绝不返回半份配置——少一个 compat flag 比整个失败更难查。
 */
export function parseWranglerConfig(toml: string): WorkerDeployConfig {
  const stripComments = (line: string) => line.replace(/#.*$/, '').trim();
  const lines = toml.split('\n').map(stripComments);

  const findScalar = (key: string): string | null => {
    for (const line of lines) {
      const m = line.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"$`));
      if (m) return m[1];
    }
    return null;
  };
  const findArray = (key: string): string[] | null => {
    for (const line of lines) {
      const m = line.match(new RegExp(`^${key}\\s*=\\s*\\[(.*)\\]$`));
      if (!m) continue;
      const items = m[1]
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
      return items;
    }
    return null;
  };

  // binding 名在 [[d1_databases]] 段里，跟顶层的同名键区分开：取该段之后第一个 binding。
  let d1Binding: string | null = null;
  const d1SectionIdx = lines.findIndex((l) => l === '[[d1_databases]]');
  if (d1SectionIdx >= 0) {
    for (let i = d1SectionIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('[')) break;
      const m = lines[i].match(/^binding\s*=\s*"([^"]*)"$/);
      if (m) {
        d1Binding = m[1];
        break;
      }
    }
  }

  return {
    compatibilityDate: findScalar('compatibility_date') || FALLBACK_CONFIG.compatibilityDate,
    compatibilityFlags: findArray('compatibility_flags') || FALLBACK_CONFIG.compatibilityFlags,
    crons: findArray('crons') || FALLBACK_CONFIG.crons,
    d1Binding: d1Binding || FALLBACK_CONFIG.d1Binding,
  };
}

/**
 * 拼上传用的 bindings。D1 一条 + 每个非空密钥一条。
 *
 * 空值一律不写：Cloudflare 会原样收下空字符串，而 worker 侧
 * 「配了 AMSG_SERVER_TOKEN 就强制校验 X-Client-Token」判断的是有没有这一项——
 * 塞个空串进去，等于打开了一道永远对不上的门。
 */
export function buildBindings(
  d1Binding: string,
  databaseId: string,
  secrets: AmsgSecrets,
  extras: Record<string, string> = {},
): Array<Record<string, string>> {
  const bindings: Array<Record<string, string>> = [
    { type: 'd1', name: d1Binding, id: databaseId },
  ];
  for (const [name, value] of Object.entries(secrets)) {
    if (typeof value === 'string' && value.trim()) {
      bindings.push({ type: 'secret_text', name, text: value });
    }
  }
  for (const [name, value] of Object.entries(extras)) {
    if (typeof value === 'string' && value.trim()) {
      bindings.push({ type: 'secret_text', name, text: value });
    }
  }
  return bindings;
}

/** workers.dev 的地址就是「脚本名.账号子域.workers.dev」。 */
export function deriveWorkerUrl(scriptName: string, subdomain: string): string {
  return `https://${scriptName}.${subdomain}.workers.dev`;
}

/**
 * 把 Cloudflare 的报错翻译成能照着做的话。
 * 权限类的最常见——用户建 token 时少勾一项，光看「Unauthorized」根本不知道少了哪个。
 */
export function explainCfError(status: number, body: unknown): string {
  const errors = (body as { errors?: Array<{ code?: number; message?: string }> } | null)?.errors;
  const first = Array.isArray(errors) && errors.length ? errors[0] : null;
  const code = first?.code;
  const raw = first?.message || '';

  const PERMISSION_HINT =
    'Token 权限不够。建 token 时这三项都要勾上：Account → Workers Scripts:Edit、'
    + 'Account → D1:Edit、Account → Account Settings:Read。';

  if (code === 6003 || code === 6111) return 'Token 格式不对，多半是复制时多带了空格或换行。';
  if (code === 9109 || code === 10000 || status === 401 || status === 403) return PERMISSION_HINT;
  if (code === 10016) return `Worker 名字不合法：${raw}`;
  if (code === 10027) return 'Worker 代码超过 Cloudflare 的体积上限，装不上去。';
  if (code === 10037) return '这个账号的 Worker 数量已经到上限了，先去面板删掉不用的。';
  if (code === 10054 || code === 10055) return `密钥数量或长度超限：${raw}`;
  if (code === 7003) return '请求路径不对（多半是代理那边的问题，不是你的 token）。';
  return raw ? `Cloudflare 返回：${raw}（code ${code ?? '?'}）` : `Cloudflare 返回 HTTP ${status}`;
}

/**
 * 校验用户想要的 workers.dev 子域。CF 的规矩是小写字母数字和连字符，
 * 不能以连字符开头结尾。这里先挡一道，省得为一个明显不合法的名字跑一趟网络。
 */
export function validateSubdomain(name: string): string | null {
  const s = name.trim().toLowerCase();
  if (!s) return '子域名不能为空。';
  if (s.length < 3 || s.length > 63) return '子域名长度要在 3~63 个字符之间。';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s)) {
    return '子域名只能用小写字母、数字和连字符，且不能以连字符开头或结尾。';
  }
  return null;
}

// ---------------------------------------------------------------------------
// 网络层：所有 CF 请求都过中心 worker 的 /cf-api
// ---------------------------------------------------------------------------

interface CfResponse<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
  /** 已经翻成人话的错误，ok 为 false 时有值。 */
  error?: string;
}

const relayUrl = (apiPath: string): string =>
  `${getProxyWorkerUrl()}/cf-api?path=${encodeURIComponent(apiPath)}`;

async function cfApi<T = unknown>(
  token: string,
  apiPath: string,
  init: { method?: string; body?: FormData | string; contentType?: string } = {},
): Promise<CfResponse<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'X-CF-Method': init.method || 'GET',
  };
  // FormData 交给浏览器自己带 Content-Type（里面有 multipart 的 boundary），别手写。
  if (init.contentType && !(init.body instanceof FormData)) {
    headers['Content-Type'] = init.contentType;
  }
  let res: Response;
  try {
    res = await fetch(relayUrl(apiPath), { method: 'POST', headers, body: init.body });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: `连不上代理（${String((e as Error)?.message || e)}）。检查网络，或在设置里换一个网络代理 Worker。`,
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON（代理层的纯文本错误）就留 null，下面按状态码处理 */
  }
  const success = res.ok && (body as { success?: boolean } | null)?.success !== false;
  return {
    ok: success,
    status: res.status,
    body: body as T,
    error: success ? undefined : explainCfError(res.status, body),
  };
}

/** 当前生效的网络代理 Worker 支不支持一键部署（老版本没有 /cf-api 这条路由）。 */
export async function checkRelayAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${getProxyWorkerUrl()}/cf-api`, { method: 'GET' });
    if (!res.ok) return false;
    const body = (await res.json()) as { relay?: string };
    return body?.relay === 'cf-api';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 编排
// ---------------------------------------------------------------------------

interface CfListEnvelope<T> {
  result?: T[];
}
interface CfItemEnvelope<T> {
  result?: T;
}

/**
 * 找出这枚 token 真正能用的账号。
 *
 * GET /accounts 是用户级端点，返回这人名下所有账号，跟 token 授权了哪个无关，
 * 所以不能直接拿第一个用。挨个问「这个账号下能不能列 Worker」，能列的才算数。
 */
async function findUsableAccounts(token: string): Promise<CfResponse<CfAccount[]>> {
  const listed = await cfApi<CfListEnvelope<CfAccount>>(token, '/accounts?per_page=50');
  if (!listed.ok) return { ...listed, body: null } as CfResponse<CfAccount[]>;
  const all = listed.body?.result ?? [];
  const usable: CfAccount[] = [];
  for (const acc of all) {
    const probe = await cfApi(token, `/accounts/${acc.id}/workers/scripts`);
    if (probe.ok) usable.push({ id: acc.id, name: acc.name });
  }
  return { ok: true, status: 200, body: usable };
}

async function ensureDatabase(
  token: string,
  accountId: string,
): Promise<{ ok: true; id: string; reused: boolean } | { ok: false; error: string }> {
  const existing = await cfApi<CfListEnvelope<{ uuid?: string; name?: string }>>(
    token,
    `/accounts/${accountId}/d1/database?name=${encodeURIComponent(AMSG_D1_NAME)}`,
  );
  if (existing.ok) {
    const hit = (existing.body?.result ?? []).find((db) => db.name === AMSG_D1_NAME && db.uuid);
    if (hit?.uuid) return { ok: true, id: hit.uuid, reused: true };
  }
  const created = await cfApi<CfItemEnvelope<{ uuid?: string }>>(
    token,
    `/accounts/${accountId}/d1/database`,
    { method: 'POST', body: JSON.stringify({ name: AMSG_D1_NAME }), contentType: 'application/json' },
  );
  const uuid = created.body?.result?.uuid;
  if (!created.ok || !uuid) {
    return { ok: false, error: created.error || '建数据库失败，Cloudflare 没有返回数据库 id。' };
  }
  return { ok: true, id: uuid, reused: false };
}

/**
 * 拿账号的 workers.dev 子域；没有就用 desiredSubdomain 注册一个。
 * 全新的 Cloudflare 账号是没有子域的，而它决定了最终的 Worker 地址，绕不过去。
 */
async function ensureSubdomain(
  token: string,
  accountId: string,
  desired?: string,
): Promise<{ ok: true; subdomain: string } | { ok: false; code: ProvisionFailureCode; error: string }> {
  const current = await cfApi<CfItemEnvelope<{ subdomain?: string }>>(
    token,
    `/accounts/${accountId}/workers/subdomain`,
  );
  const existing = current.body?.result?.subdomain;
  if (current.ok && existing) return { ok: true, subdomain: existing };

  if (!desired) {
    return {
      ok: false,
      code: 'SUBDOMAIN_MISSING',
      error: '这个 Cloudflare 账号还没有 workers.dev 子域名，需要先起一个。',
    };
  }
  const invalid = validateSubdomain(desired);
  if (invalid) return { ok: false, code: 'SUBDOMAIN_MISSING', error: invalid };

  const registered = await cfApi(token, `/accounts/${accountId}/workers/subdomain`, {
    method: 'PUT',
    body: JSON.stringify({ subdomain: desired.trim().toLowerCase() }),
    contentType: 'application/json',
  });
  if (!registered.ok) {
    return {
      ok: false,
      code: 'SUBDOMAIN_TAKEN',
      error: `${desired} 这个子域名注册不下来（多半被别人占了）。换一个再试。${registered.error ? `\n${registered.error}` : ''}`,
    };
  }
  return { ok: true, subdomain: desired.trim().toLowerCase() };
}

async function fetchBundle(): Promise<{ ok: true; code: string; config: WorkerDeployConfig } | { ok: false; error: string }> {
  let code: string;
  try {
    const res = await fetch(BUNDLE_URL, { cache: 'no-store' });
    if (!res.ok) return { ok: false, error: `拉取 Worker 代码失败（HTTP ${res.status}）。` };
    code = await res.text();
  } catch (e) {
    return { ok: false, error: `拉取 Worker 代码失败：${String((e as Error)?.message || e)}` };
  }
  const bytes = new TextEncoder().encode(code).length;
  if (bytes < MIN_BUNDLE_BYTES || bytes > MAX_BUNDLE_BYTES) {
    return { ok: false, error: `拉到的 Worker 代码大小不对（${bytes} 字节），没敢往上传。` };
  }
  if (!code.includes('src_default as default')) {
    return { ok: false, error: '拉到的文件不像是打包好的 Worker，没敢往上传。' };
  }

  // 配置跟着 bundle 一起从线上拿，拿不到就用兜底，不因为这个中断部署。
  let config = FALLBACK_CONFIG;
  try {
    const res = await fetch(WRANGLER_URL, { cache: 'no-store' });
    if (res.ok) config = parseWranglerConfig(await res.text());
  } catch {
    /* 用兜底 */
  }
  return { ok: true, code, config };
}

/**
 * 等新部署的 Worker 真的能响应。
 *
 * 刚建好的 workers.dev 地址要过一会儿才解析得到，上传成功的下一秒去连它多半连不上。
 * 任何 HTTP 响应都算活了（401/404 也说明请求确实打到 Worker 上了）。
 * 超时返回 false 而不是抛错——没等到不代表装失败，让调用方提示「过会儿点连接」即可。
 */
export async function waitForWorkerReady(workerUrl: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let delay = 1000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${workerUrl}/config-check`, { method: 'GET', cache: 'no-store' });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 5000);
    }
  }
  return false;
}

/** 生成这套后端要的全部密钥。已有的原样保留（重装时不换 Master Key）。 */
export async function generateAmsgSecrets(existing: Partial<AmsgSecrets> = {}): Promise<AmsgSecrets> {
  const vapid = existing.VAPID_PUBLIC_KEY && existing.VAPID_PRIVATE_KEY
    ? { publicKey: existing.VAPID_PUBLIC_KEY, privateKey: existing.VAPID_PRIVATE_KEY }
    : await generateVapidKeyPair();
  const masterKey = existing.AMSG_MASTER_KEY
    || Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  return {
    AMSG_MASTER_KEY: masterKey,
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_EMAIL: existing.VAPID_EMAIL || '',
    AMSG_SERVER_TOKEN: existing.AMSG_SERVER_TOKEN || generateClientToken(),
  };
}

/**
 * 全流程。任何一步失败都直接返回，不做回滚——半途失败会留下已经建好的 D1 或 Worker，
 * 但每一步都是「先查后建」，把同样的参数再跑一遍能接着往下走，不会建出第二份。
 */
export async function provisionAmsgBackend(input: ProvisionInput): Promise<ProvisionResult> {
  const scriptName = input.scriptName?.trim() || AMSG_SCRIPT_NAME;
  const token = input.token.trim();
  const report = (step: ProvisionStepId, message: string) => input.onProgress?.({ step, message });
  const warnings: string[] = [];

  report('relay', '检查中转是否可用…');
  if (!(await checkRelayAvailable())) {
    return {
      ok: false,
      code: 'RELAY_UNSUPPORTED',
      message:
        '当前的网络代理 Worker 不支持一键部署（缺 /cf-api）。'
        + '如果你在设置里换过代理地址，把它改回默认的，或者把代理 Worker 更新到最新版。',
    };
  }

  report('token', '验证 Token…');
  const verified = await cfApi(token, '/user/tokens/verify');
  if (!verified.ok) {
    return { ok: false, code: 'TOKEN_INVALID', message: verified.error || 'Token 验证不通过。' };
  }

  report('account', '查找可用的 Cloudflare 账号…');
  let accountId = input.accountId?.trim() || '';
  if (!accountId) {
    const accounts = await findUsableAccounts(token);
    if (!accounts.ok) {
      return { ok: false, code: 'CF_ERROR', message: accounts.error || '读取账号列表失败。' };
    }
    const usable = accounts.body ?? [];
    if (usable.length === 0) {
      return {
        ok: false,
        code: 'NO_USABLE_ACCOUNT',
        message:
          '这枚 token 在你名下任何一个账号里都没有 Workers 权限。'
          + '重新建一枚，把 Account → Workers Scripts:Edit 勾上。',
      };
    }
    if (usable.length > 1) {
      return {
        ok: false,
        code: 'ACCOUNT_AMBIGUOUS',
        message: '这枚 token 能用在多个账号上，选一个装到哪儿。',
        accounts: usable,
      };
    }
    accountId = usable[0].id;
  }

  report('database', '准备数据库…');
  const db = await ensureDatabase(token, accountId);
  if (!db.ok) return { ok: false, code: 'CF_ERROR', message: db.error };
  if (db.reused) {
    warnings.push(`用的是账号里已有的同名数据库 ${AMSG_D1_NAME}。如果之前装过一套，两边会共用同一个库。`);
  }

  report('subdomain', '确认 workers.dev 地址…');
  const sub = await ensureSubdomain(token, accountId, input.desiredSubdomain);
  if (!sub.ok) return { ok: false, code: sub.code, message: sub.error };

  report('bundle', '下载最新的后端代码…');
  const bundle = await fetchBundle();
  if (!bundle.ok) return { ok: false, code: 'BUNDLE_INVALID', message: bundle.error };

  report('upload', '上传 Worker…');
  const secrets = await generateAmsgSecrets(input.secrets);
  const metadata = {
    main_module: MAIN_MODULE,
    compatibility_date: bundle.config.compatibilityDate,
    compatibility_flags: bundle.config.compatibilityFlags,
    // CF_API_TOKEN / CF_SCRIPT_NAME 是留给「更新后端」用的：worker 以后拿它自己
    // 覆盖自己，就不用再经过浏览器和中转了。
    bindings: buildBindings(bundle.config.d1Binding, db.id, secrets, {
      CF_API_TOKEN: token,
      CF_SCRIPT_NAME: scriptName,
    }),
  };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set(
    MAIN_MODULE,
    new Blob([bundle.code], { type: 'application/javascript+module' }),
    MAIN_MODULE,
  );
  const uploaded = await cfApi(token, `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`, {
    method: 'PUT',
    body: form,
  });
  if (!uploaded.ok) {
    return { ok: false, code: 'UPLOAD_FAILED', message: uploaded.error || '上传 Worker 失败。' };
  }

  report('cron', '设置定时触发…');
  const schedules = await cfApi(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/schedules`,
    {
      method: 'PUT',
      body: JSON.stringify(bundle.config.crons.map((cron) => ({ cron }))),
      contentType: 'application/json',
    },
  );
  if (!schedules.ok) {
    // 这条不能降级成警告：cron 是主动消息唯一的投递触发方式，没有它整个功能不动。
    return {
      ok: false,
      code: 'CF_ERROR',
      message: `定时触发没设上（${schedules.error}）。主动消息全靠它，先解决这个再用。`,
    };
  }

  report('expose', '开启访问地址…');
  const exposed = await cfApi(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`,
    {
      method: 'POST',
      body: JSON.stringify({ enabled: true, previews_enabled: false }),
      contentType: 'application/json',
    },
  );
  if (!exposed.ok) {
    return { ok: false, code: 'CF_ERROR', message: `开启 workers.dev 地址失败（${exposed.error}）。` };
  }

  // 实时日志是排障用的，开不上不影响功能，所以只记一句警告。
  const observability = await cfApi(
    token,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
    {
      method: 'PATCH',
      body: JSON.stringify({ observability: { enabled: true, logs: { enabled: true } } }),
      contentType: 'application/json',
    },
  );
  if (!observability.ok) {
    warnings.push('实时日志没能自动打开，排障时要去 Cloudflare 面板手动开一下。');
  }

  report('done', '部署完成。');
  return {
    ok: true,
    workerUrl: deriveWorkerUrl(scriptName, sub.subdomain),
    scriptName,
    accountId,
    databaseId: db.id,
    reusedDatabase: db.reused,
    secrets,
    warnings,
  };
}

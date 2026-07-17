/**
 * SullyOS 主动消息 2.0（amsg2）— 单用户 Cloudflare Worker 入口。
 *
 * 定时任务存 D1（binding 名固定 `DB`），到点投递由 Cron Trigger 触发
 * scheduled()，没有 send-notifications 这类 HTTP 投递端点。
 *
 * 部署走「Dashboard 粘贴」：`pnpm build:workers` 把这份入口打成
 * worker/amsg/worker.bundle.js（+ public/amsg-worker.bundle.js 供设置页
 * 「复制 Worker 代码」按钮读取），整份粘进 CF Dashboard 的 Edit code 即可。
 * amsg-server 2.6.0-next.2 起全 Web Crypto，无需 nodejs_compat flag。
 *
 * Worker 侧要配的东西（都在 CF Dashboard 的 Settings 里）：
 *   - D1 binding:  变量名 `DB`（库随便建一个，表由前端「连接」时 POST /init-tenant 幂等创建）
 *   - Cron Trigger: `* * * * *`（每分钟查一次到点任务，UTC）
 *   - env: AMSG_MASTER_KEY（64 位 hex）+ VAPID_EMAIL / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
 *          + 可选 AMSG_SERVER_TOKEN（配了则所有端点强制校验 X-Client-Token）
 *
 * VAPID 必须和 SullyOS「推送凭据 (VAPID)」面板里的是同一对：整个站点
 * 共用一个浏览器 push 订阅，worker 用别的密钥对签推送会 403。
 */

import {
  createSingleUserCloudflareWorker,
  createWebCryptoWebPush,
} from '@rei-standard/amsg-server/cloudflare';
import { stripReasoningTags } from '@rei-standard/amsg-shared';
import {
  AMSG_FIRE_PACK_KEY,
  amsgStateNamespace,
  parseFirePack,
  renderFirePack,
} from '../../../utils/amsgFirePack';

interface Env {
  AMSG_MASTER_KEY: string;
  VAPID_EMAIL: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  /** 可选共享密钥；配了才校验 X-Client-Token，不配则端点全开。 */
  AMSG_SERVER_TOKEN?: string;
  /** D1 binding（factory 默认 createD1Adapter(env.DB)，这里只是标注存在）。 */
  DB: unknown;
}

// ─── 满血 fire-time hooks（amsg-server 2.6.0-next.3+） ───────────────────────
//
// AI 任务到点不再吃排程时冻结的 completePrompt，而是读前端平时同步上来的
// fire_pack（client_state 表，见 utils/amsgFirePack.ts + utils/amsgStateSync.ts），
// 在 fire 时刻现算时间填槽 → 上下文永远是「用户最后一次聊天时」的状态。
// 读不到 fire_pack（老任务 / 从没同步过 / 数据坏了）→ onBeforeFire 返回 null，
// 库自动回退冻结 prompt 老链路，行为和 2.6.0-next.2 完全一致。
//
// v1 刻意只发 content push、不发 reasoning push：hook 路径的 sendHookPushPayloads
// 会把 pushPayloads 数组整体编号（messageIndex/totalMessages），reasoning 一旦混进
// 数组，第一条 content 的 messageIndex 就变 2，前端 activeMsgRuntime「index<=1 才
// claim reasoning」的判定会静默丢 thinking chain 卡片。content-only 时编号和老链路
// 完全一致，收侧（与 instant push 共用）零改动。reasoning 内容直接丢弃，正文里的
// <think> 标签照旧 strip 防泄漏。

/** 和 amsg-server message-processor 的默认分句保持一致（SullyOS 不用 splitPattern）。 */
const DEFAULT_SPLIT_REGEX = /([。！？!?]+)/;
const splitMessageIntoSentences = (content: string): string[] => {
  const out = content
    .split(DEFAULT_SPLIT_REGEX)
    .reduce<string[]>((acc, part, i, arr) => {
      if (i % 2 === 0 && part.trim()) {
        acc.push(part.trim() + (arr[i + 1] || ''));
      }
      return acc;
    }, [])
    .filter((s) => s.length > 0);
  return out.length > 0 ? out : [content];
};

interface FireCtx {
  task: { metadata?: Record<string, unknown> };
  userId: string;
  readState: (namespace: string) => Promise<Array<{ key: string; value: string }>>;
  now: Date;
}

interface SessionCtx {
  sessionId: string;
  llmResponse: unknown;
  llmOutputText: string;
  contactName: string;
  avatarUrl?: string;
  metadata: Record<string, unknown>;
}

const amsgHooks = {
  async onBeforeFire(ctx: FireCtx) {
    const charId = ctx.task?.metadata?.charId;
    if (typeof charId !== 'string' || !charId) return null;

    const rows = await ctx.readState(amsgStateNamespace(charId));
    const row = rows.find((r) => r.key === AMSG_FIRE_PACK_KEY);
    if (!row) return null;

    const pack = parseFirePack(row.value);
    if (!pack) return null;

    const prompt = renderFirePack(pack, ctx.now.getTime());
    return [{ role: 'user' as const, content: prompt }];
  },

  async onLLMOutput(ctx: SessionCtx) {
    // v1 无服务端工具：每轮直接 finish。空回复走 skip-push（任务记送达，不推空气泡）。
    const content = stripReasoningTags(ctx.llmOutputText || '').trim();
    if (!content) return { decision: 'skip-push' as const };

    // 老链路 push 带 taskId=任务行 id；sessionCtx 没有它，但 sessionId 是文档化的
    // `sess_task_<id>` 格式（agentic-fire 与老链路同 scheme），从这里拆；拆不出置 null。
    const taskId = ctx.sessionId.startsWith('sess_task_')
      ? ctx.sessionId.slice('sess_task_'.length)
      : null;
    const messageType = typeof ctx.metadata?.amsgMode === 'string' ? ctx.metadata.amsgMode : 'auto';

    const sentences = splitMessageIntoSentences(content);
    // messageId/sessionId/timestamp/messageIndex/totalMessages 由库的
    // sendHookPushPayloads 统一补齐/覆写，这里只填业务字段。
    const pushPayloads = sentences.map((sentence) => ({
      messageKind: 'content' as const,
      messageType,
      source: 'scheduled' as const,
      message: sentence,
      title: `来自 ${ctx.contactName}`,
      contactName: ctx.contactName,
      avatarUrl: ctx.avatarUrl ?? null,
      messageSubtype: 'chat',
      taskId,
      metadata: ctx.metadata,
    }));

    return { decision: 'finish' as const, pushPayloads };
  },
};

export default createSingleUserCloudflareWorker((env: Env) => ({
  // db 缺省时 factory 自动用 createD1Adapter(env.DB)
  masterKey: env.AMSG_MASTER_KEY,
  serverToken: env.AMSG_SERVER_TOKEN,
  vapid: {
    email: env.VAPID_EMAIL,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  },
  webpush: createWebCryptoWebPush({
    email: env.VAPID_EMAIL,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  }),
  // 前端和 Worker 不同源，带自定义头的请求会先发 CORS 预检，必须放行。
  // 单用户自用默认全开；想收紧就把 '*' 换成自己的 SullyOS 站点 origin。
  cors: { origin: '*' },
  // 满血 fire-time hooks；v1 无服务端工具（不配 executeToolCalls），轮数/超时用库默认。
  hooks: amsgHooks,
}));

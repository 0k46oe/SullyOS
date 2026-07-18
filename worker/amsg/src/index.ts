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
import type { CharacterProfile, RealtimeConfig, UserProfile } from '../../../types';
import {
  AMSG_FIRE_PACK_KEY,
  amsgStateNamespace,
  parseFirePack,
  renderFirePack,
} from '../../../utils/amsgFirePack';
import {
  AMSG_GLOBAL_NAMESPACE,
  AMSG_TOOL_CONFIG_KEY,
  AMSG_TOOL_PACK_KEY,
  parseToolConfig,
  parseToolPack,
} from '../../../utils/amsgToolPack';
import { dispatchAgenticTool, type AgenticToolCtx } from '../../../utils/agenticTools';
import { setProxyWorkerUrlOverride } from '../../../utils/proxyWorker';
import { XhsMcpClient } from '../../../utils/xhsMcpClient';
import {
  createFireSessionState,
  processLLMRound,
  type FireSessionState,
} from './agentic';

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

// ─── 满血 fire-time hooks（amsg-server 2.6.0-next.4+：含 ctx.scratch / 存储层大值分块） ───
//
// AI 任务到点不再吃排程时冻结的 completePrompt，而是读前端平时同步上来的
// fire_pack（client_state 表，见 utils/amsgFirePack.ts + utils/amsgStateSync.ts），
// 在 fire 时刻现算时间填槽 → 上下文永远是「用户最后一次聊天时」的状态。
// 读不到 fire_pack（老任务 / 从没同步过 / 数据坏了）→ onBeforeFire 返回 null，
// 库自动回退冻结 prompt 老链路，行为和 2.6.0-next.2 完全一致。
//
// v2 服务端工具循环：LLM 输出经 instant 同款业务标签 classifier 分类
// （见 ./agentic.ts），数据标签由 executeToolCalls 在 worker 内就地执行
// （recall 读 tool_pack 里的月度总结，搜索 / Notion / 飞书 / XHS 用 tool_config
// 里的凭据直调，全程不需要客户端在线）；副作用标签结构化成 directives 挂
// 最后一条 push，客户端收到时重放。tool_pack / tool_config 缺失时工具会以
// not_configured / no_logs 之类的正常失败回给 LLM 圆场，fire 链不会断。
//
// 刻意只发 content push、不发 reasoning push：hook 路径的 sendHookPushPayloads
// 会把 pushPayloads 数组整体编号（messageIndex/totalMessages），reasoning 一旦混进
// 数组，第一条 content 的 messageIndex 就变 2，前端 activeMsgRuntime「index<=1 才
// claim reasoning」的判定会静默丢 thinking chain 卡片。content-only 时编号和老链路
// 完全一致，收侧（与 instant push 共用）零改动。reasoning 内容直接丢弃，正文里的
// <think> 标签照旧 strip 防泄漏。

interface FireCtx {
  task: {
    id?: string | number | null;
    contactName?: string;
    metadata?: Record<string, unknown>;
  };
  userId: string;
  readState: (namespace: string) => Promise<Array<{ key: string; value: string }>>;
  now: Date;
  /**
   * 单次 fire 的宿主便签（amsg-server 2.6.0-next.4+）：与同一次 fire 每轮的
   * sessionCtx.scratch 是同一个对象引用，fire 结束随调用栈丢弃，库不读不写。
   */
  scratch: Record<string, unknown>;
}

interface SessionCtx {
  sessionId: string;
  llmResponse: unknown;
  llmOutputText: string;
  contactName: string;
  avatarUrl?: string;
  metadata: Record<string, unknown>;
  scratch?: Record<string, unknown>;
}

/** 一次 fire 的跨轮状态：工具执行上下文 + 旁白累积。挂在 ctx.scratch.fire 上。 */
interface FireStash {
  session: FireSessionState;
  toolCtx: AgenticToolCtx;
  proxyWorkerUrl: string | null;
  xhsCookie: string;
}

const getFireStash = (scratch: Record<string, unknown> | undefined): FireStash | undefined =>
  scratch?.fire as FireStash | undefined;

/**
 * 用云端 tool_pack / tool_config 拼 dispatchAgenticTool 要的 ctx。
 * 两份数据都可能缺（老前端 / 没同步过）——缺了就给空壳，工具自己会走
 * not_configured / no_logs 的正常失败路径回给 LLM。
 */
const buildToolCtx = (
  toolPackRaw: string | undefined,
  toolConfigRaw: string | undefined,
  fallbackCharName: string,
): { toolCtx: AgenticToolCtx; proxyWorkerUrl: string | null; xhsCookie: string } => {
  const pack = toolPackRaw ? parseToolPack(toolPackRaw) : null;
  const config = toolConfigRaw ? parseToolConfig(toolConfigRaw) : null;

  // agenticTools 只读这些字段（runRecall / resolveXhsConfig / 日记按角色名查），
  // 其余 CharacterProfile 字段在 worker 侧不存在也不会被碰。
  const char = {
    name: pack?.charName || fallbackCharName,
    xhsEnabled: pack?.xhsEnabled ?? false,
    activeMemoryMonths: pack?.activeMemoryMonths ?? [],
    memories: pack?.memories ?? [],
  } as unknown as CharacterProfile;

  const realtimeConfig = config
    ? ({
        newsEnabled: config.newsEnabled,
        newsApiKey: config.newsApiKey,
        notionEnabled: config.notionEnabled,
        notionApiKey: config.notionApiKey,
        notionDatabaseId: config.notionDatabaseId,
        notionNotesDatabaseId: config.notionNotesDatabaseId,
        feishuEnabled: config.feishuEnabled,
        feishuAppId: config.feishuAppId,
        feishuAppSecret: config.feishuAppSecret,
        feishuBaseId: config.feishuBaseId,
        feishuTableId: config.feishuTableId,
        xhsMcpConfig: config.xhsMcpConfig,
      } as unknown as RealtimeConfig)
    : undefined;

  return {
    toolCtx: {
      char,
      userProfile: {} as UserProfile,
      realtimeConfig,
      // XHS 多步流程（search → detail 的 xsecToken 缓存）在同一次 fire 内共享。
      xhsCaches: {
        xsecTokenCache: new Map(),
        noteTitleCache: new Map(),
        commentUserIdCache: new Map(),
        commentAuthorNameCache: new Map(),
        commentParentIdCache: new Map(),
      },
      lastXhsNotesRef: { current: [] },
    },
    proxyWorkerUrl: config?.proxyWorkerUrl ?? null,
    xhsCookie: config?.xhsMcpConfig?.cookie ?? '',
  };
};

const amsgHooks = {
  async onBeforeFire(ctx: FireCtx) {
    const charId = ctx.task?.metadata?.charId;
    if (typeof charId !== 'string' || !charId) return null;

    const charRows = await ctx.readState(amsgStateNamespace(charId));
    const packRow = charRows.find((r) => r.key === AMSG_FIRE_PACK_KEY);
    if (!packRow) return null;

    // 大值分块由 amsg-server 2.6.0-next.4+ 在存储层透明处理，readState 拿到的
    // 已是拼回的原文。（更早的应用层分块格式落库的旧数据 parse 不过 → null →
    // 照旧退冻结提示词，下轮聊天同步会用新格式覆盖。）
    const pack = parseFirePack(packRow.value);
    if (!pack) return null;

    // 工具数据与 prompt 同拍装好，挂 ctx.scratch 给同一次 fire 的
    // onLLMOutput / executeToolCalls（库保证同引用、fire 结束即丢，
    // 不需要自维护 sessionId → 状态的 Map 和防泄漏水位）。
    let toolConfigRaw: string | undefined;
    try {
      const globalRows = await ctx.readState(AMSG_GLOBAL_NAMESPACE);
      toolConfigRaw = globalRows.find((r) => r.key === AMSG_TOOL_CONFIG_KEY)?.value;
    } catch (error) {
      console.warn('[amsg:agentic] 读 tool_config 失败，工具按未配置继续', error);
    }
    const { toolCtx, proxyWorkerUrl, xhsCookie } = buildToolCtx(
      charRows.find((r) => r.key === AMSG_TOOL_PACK_KEY)?.value,
      toolConfigRaw,
      typeof ctx.task.contactName === 'string' ? ctx.task.contactName : '',
    );
    ctx.scratch.fire = {
      session: createFireSessionState(),
      toolCtx,
      proxyWorkerUrl,
      xhsCookie,
    } satisfies FireStash;

    const prompt = renderFirePack(pack, ctx.now.getTime());
    return [{ role: 'user' as const, content: prompt }];
  },

  async onLLMOutput(ctx: SessionCtx) {
    const content = stripReasoningTags(ctx.llmOutputText || '').trim();

    // 老链路 push 带 taskId=任务行 id；sessionCtx 没有它，但 sessionId 是文档化的
    // `sess_task_<id>` 格式（agentic-fire 与老链路同 scheme），从这里拆；拆不出置 null。
    const taskId = ctx.sessionId.startsWith('sess_task_')
      ? ctx.sessionId.slice('sess_task_'.length)
      : null;
    const messageType = typeof ctx.metadata?.amsgMode === 'string' ? ctx.metadata.amsgMode : 'auto';

    const stash = getFireStash(ctx.scratch);
    const session = stash?.session ?? createFireSessionState();

    const decision = processLLMRound(session, content, {
      contactName: ctx.contactName,
      avatarUrl: ctx.avatarUrl ?? null,
      taskId,
      messageType,
      metadata: ctx.metadata,
      // round 1 XHS 工具抓到的笔记 / xsecToken 快照：finish 时按 directive 引用
      // 挑选后随最后一条 push 带回客户端（客户端离线跑不了 round 1，缺这份
      // [[XHS_SHARE]] / 点赞 / 评论重放必然 available:0 掉卡片）。
      xhsNotes: stash?.toolCtx.lastXhsNotesRef?.current,
      xhsXsecTokens: stash?.toolCtx.xhsCaches
        ? Array.from(stash.toolCtx.xhsCaches.xsecTokenCache.entries())
        : undefined,
    });

    if (decision.decision === 'tool-request') {
      console.log('[amsg:agentic]', {
        type: 'tool_request',
        sessionId: ctx.sessionId,
        tools: decision.toolCalls.map((tc) => tc.function.name),
      });
    } else {
      // finish / skip-push：这次 fire 到头，scratch 随调用栈丢弃，无需手动回收。
      console.log('[amsg:agentic]', {
        type: decision.decision,
        sessionId: ctx.sessionId,
        pushes: decision.decision === 'finish' ? decision.pushPayloads.length : 0,
      });
    }

    return decision;
  },

  /**
   * 服务端工具执行：客户端在 fire 时刻离线，数据工具全部在 worker 内跑完。
   * 单个工具失败（含抛错）都以失败 JSON 回填给 LLM 让它圆场，不失败整条链。
   */
  async executeToolCalls(
    toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>,
    ctx: SessionCtx,
  ) {
    const stash = getFireStash(ctx.scratch);
    // 搜索/Notion/飞书经代理 worker 转发；地址来自前端同步的 tool_config
    //（没同步则回默认公共实例）。XHS Lite cookie 同拍注入。
    setProxyWorkerUrlOverride(stash?.proxyWorkerUrl ?? null);
    XhsMcpClient.setCookie(stash?.xhsCookie || '');

    const results = [];
    for (const toolCall of toolCalls) {
      const name = toolCall?.function?.name || '';
      let content: string;
      try {
        const args = toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
        const result = stash
          ? await dispatchAgenticTool(name, args, stash.toolCtx)
          : { ok: false, reason: 'no_tool_state', message: '云端没有这个角色的工具数据（tool_pack 未同步）' };
        content = JSON.stringify(result);
        console.log('[amsg:agentic]', { type: 'tool_done', sessionId: ctx.sessionId, tool: name });
      } catch (error) {
        content = JSON.stringify({
          ok: false,
          reason: 'tool_error',
          message: error instanceof Error ? error.message : String(error),
        });
        console.warn('[amsg:agentic]', { type: 'tool_failed', sessionId: ctx.sessionId, tool: name, error: String(error) });
      }
      results.push({ tool_call_id: toolCall.id, role: 'tool' as const, content });
    }
    return results;
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
  // 满血 fire-time hooks（onBeforeFire 现场填槽 + onLLMOutput 分类 +
  // executeToolCalls 服务端工具循环）；轮数/超时用库默认（5 轮 / 240s）。
  hooks: amsgHooks,
}));

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
  measurePushPayload,
} from '@rei-standard/amsg-server/cloudflare';
import { stripReasoningTags } from '@rei-standard/amsg-shared';
import type { UserProfile } from '../../../types';
import {
  AMSG_FIRE_PACK_KEY,
  AMSG_LAST_SKIP_KEY,
  AMSG_SELF_LOG_KEY,
  type AmsgLastSkip,
  type AmsgSelfLog,
  type AmsgTzRef,
  amsgStateNamespace,
  amsgXhsSessionKey,
  appendSelfLogEntry,
  appendSelfLogTask,
  createSelfLog,
  parseFirePack,
  parseSelfLog,
  renderFirePack,
  selfLogMatchesPack,
  unpackStateValue,
} from '../../../utils/amsgFirePack';
import { shouldExpireFire } from '../../../utils/amsg2ExpireGuard';
import { buildFireTaskListBlock, MAX_ACTIVE_TASKS_PER_CHAR } from '../../../utils/amsg2Tasks';
import {
  AMSG_FIRE_SCHEDULE_TOOL,
  buildFireScheduleBlock,
  buildFireScheduleTool,
  MAX_FIRE_SCHEDULES,
  parseFireScheduleArgs,
  buildTaskInstruction,
} from '../../../utils/amsgFireSchedule';
import {
  AMSG_CHAT_PRESENCE_KEY,
  isFreshChatPresence,
  parseAmsgChatPresence,
} from '../../../utils/amsgChatPresence';
import {
  AMSG_GLOBAL_NAMESPACE,
  AMSG_TOOL_CONFIG_KEY,
  AMSG_TOOL_PACK_KEY,
  parseToolConfig,
  parseToolPack,
  type AmsgToolConfig,
  type AmsgToolPack,
} from '../../../utils/amsgToolPack';
import {
  buildMcpDirectHeaders,
  buildMcpFireBlock,
  buildMcpFireTools,
  buildMcpNameMap,
  callMcpToolCore,
  createMcpSessionState,
  filterMcpServersForChar,
  formatMcpToolResult,
  MCP_FIRE_NAME_BUDGET,
  MCP_FIRE_NAME_PREFIX,
  type McpResolvedToolCore,
  type McpSessionState,
} from '../../../utils/mcpFireCore';
import { dispatchAgenticTool, type AgenticToolChar, type AgenticToolCtx } from '../../../utils/agenticTools';
import {
  buildDuplicateToolMessage,
  buildToolResultMessage,
  toolCallFingerprint,
} from '../../../utils/agenticToolFeedback';
import { setProxyWorkerUrlOverride } from '../../../utils/proxyWorker';
import { XhsMcpClient } from '../../../utils/xhsMcpClient';
// type-only：编译期擦除，classifier 的实现不会因为这行被拉进 bundle。
import type { ToolCall } from '../../instant-push/src/classifier';
import {
  createFireSessionState,
  processLLMRound,
  type FireSessionState,
} from './agentic';
import type { ActiveMsg2TaskRecord } from '../../../types';

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
// AI 任务的 prompt 到点才组装：读前端同步上来的 fire_pack（client_state 表，见
// utils/amsgFirePack.ts + utils/amsgStateSync.ts），在 fire 时刻现算时间填槽 →
// 上下文永远是「用户最后一次聊天时」的状态。任务体里没有第二份 prompt——排程链保证
// 「先传云端状态、成功了再建任务」（activeMsgClient 的 putClientStateOrThrow），
// 所以读不到 fire_pack 就是异常，直接抛错，不降级（见 fireStateError）。
//
// v2 服务端工具循环：LLM 输出经 instant 同款业务标签 classifier 分类
// （见 ./agentic.ts），数据标签由 executeToolCalls 在 worker 内就地执行
// （recall 读 tool_pack 里的月度总结，搜索 / Notion / 飞书 / XHS 用 tool_config
// 里的凭据直调，全程不需要客户端在线）；副作用标签结构化成 directives 挂
// 最后一条 push，客户端收到时重放。tool_pack / tool_config 与 fire_pack 同批上传，
// 所以和它一样按「读不到就是异常」处理；没配凭据的工具自己会回 not_configured。
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
    /** 任务行 uuid（客户端清单里的那个）；跳过时留痕要拿它对上是哪一条。 */
    uuid?: string | null;
    contactName?: string;
    recurrenceType?: string;
    nextSendAt?: string | null;
    metadata?: Record<string, unknown>;
  };
  userId: string;
  readState: (namespace: string) => Promise<Array<{ key: string; value: string }>>;
  /** 与每轮 sessionCtx 上那个是同一套写口（防穿帮闸跳过时用它留一句原因）。 */
  writeState?: WriteState;
  scheduleTask?: ScheduleTask;
  now: Date;
  /**
   * 单次 fire 的宿主便签（amsg-server 2.6.0-next.4+）：与同一次 fire 每轮的
   * sessionCtx.scratch 是同一个对象引用，fire 结束随调用栈丢弃，库不读不写。
   */
  scratch: Record<string, unknown>;
}

/** client_state 的写入口（amsg-server 2.6.0-next.7+）；value 传 null 即删除该 key。 */
type WriteState = (
  namespace: string,
  entries: Array<{ key: string; value: string | null; updatedAt?: number }>,
) => Promise<{ upserted: number; skipped: number; deleted: number }>;

/**
 * 在这次 fire 里再建一条定时任务（amsg-server 2.6.0-next.9+）。
 * 凭据与投递配置由库从当前任务继承，这里只说「什么时候、说什么方向」。
 * uuid 撞车不抛错，回 { created: false }——fire 重跑时靠确定性 uuid 天然幂等。
 */
type ScheduleTask = (options: {
  firstSendTime: string;
  recurrenceType?: string;
  messageType?: string;
  metadata?: Record<string, unknown>;
  uuid?: string;
}) => Promise<
  | { created: true; id: number | null; uuid: string; nextSendAt: string }
  | { created: false; reason: 'duplicate'; uuid: string }
>;

interface SessionCtx {
  sessionId: string;
  llmResponse: unknown;
  llmOutputText: string;
  contactName: string;
  avatarUrl?: string;
  metadata: Record<string, unknown>;
  scratch?: Record<string, unknown>;
  writeState?: WriteState;
  scheduleTask?: ScheduleTask;
}

/** 一次 fire 的跨轮状态：工具执行上下文 + 旁白累积。挂在 ctx.scratch.fire 上。 */
interface FireStash {
  session: FireSessionState;
  toolCtx: AgenticToolCtx;
  proxyWorkerUrl: string | null;
  xhsCookie: string;
  /** 本次触发时刻（任务行 next_send_at）；透传给每条 push 的 metadata.amsgOccurrenceMs。 */
  occurrenceMs: number;
  /**
   * 「角色自己发过什么」的当前版本（已跟本次 fire_pack 对齐过；对不上就是空的一份）。
   * onBeforeFire 读进来注入 prompt，onLLMOutput 发完在它上面追加一条写回云端。
   */
  selfLog: AmsgSelfLog;
  /** 通用 MCP：暴露名 → 服务器/工具。tool_config 里没配（或对该角色不可见）时为 null。 */
  mcpResolve: Map<string, McpResolvedToolCore> | null;
  /** 每服务器一份连接会话，单次 fire 内跨轮复用，fire 结束随 scratch 丢弃。 */
  mcpSessions: Map<string, McpSessionState>;
  /** 本次 fire 已经花在 MCP 调用上的毫秒数，见 MCP_TOTAL_BUDGET_MS。 */
  mcpSpentMs: number;
  /** 打包那一刻客户端已知的待触发任务，用来算「还能不能再排」。 */
  pendingTaskCount: number;
  /** 角色本次 fire 已经排成功的任务（也是要随 push 带回客户端认领的那些）。 */
  scheduledTasks: ActiveMsg2TaskRecord[];
  /** 本次触发用到的角色 id / 任务归属键，排程时要写进新任务的 metadata。 */
  charId: string;
  /** 防穿帮闸锚点：这份 fire_pack 记的「用户最后一次开口」。 */
  anchorMs: number;
  /**
   * 角色的时间参照系（fire_pack 的 tzId）。worker 里一切「给角色看的时间」
   * ——当前时间槽、self_log 时间戳、排程清单、send_at 解析与打回文案——都从这一份出。
   */
  tz: AmsgTzRef;
  /** 任务行 uuid（skip 留痕要对上是哪一条；拿不到为 null）。 */
  taskUuid: string | null;
  /** 任务行 id（字符串化）。onAfterSend 按它对回本次 fire 的 stash，见 pendingSelfLogs。 */
  taskRowId: string | null;
}

const getFireStash = (scratch: Record<string, unknown> | undefined): FireStash | undefined =>
  scratch?.fire as FireStash | undefined;

/**
 * 用云端 tool_pack / tool_config 拼 dispatchAgenticTool 要的 ctx。
 *
 * 纯构造：解析与「解析不出来怎么办」都留在 onBeforeFire（它才知道 taskId / charId 这些
 * 报错上下文），这里只管把两份已经验好的数据装成 ctx。
 */
const buildToolCtx = (
  pack: AmsgToolPack,
  config: AmsgToolConfig,
): { toolCtx: AgenticToolCtx; proxyWorkerUrl: string | null; xhsCookie: string } => {
  // AgenticToolChar 就是 agenticTools 真正会读的那几个字段（runRecall / resolveXhsConfig /
  // 日记按角色名查）。用它当类型而不是硬转 CharacterProfile：那边多读一个字段这里就编译不过，
  // 不会等到 worker 到点才拿到 undefined。
  const char: AgenticToolChar = {
    name: pack.charName,
    xhsEnabled: pack.xhsEnabled,
    activeMemoryMonths: pack.activeMemoryMonths,
    memories: pack.memories,
  };

  return {
    toolCtx: {
      char,
      userProfile: {} as UserProfile,
      // AmsgToolConfig 的凭据字段就是 AgenticToolRealtimeConfig，结构化直接满足——
      // 不用逐字段抄一遍再强转，那样 buildToolConfig 加字段这里不会报错。
      realtimeConfig: config,
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
    proxyWorkerUrl: config.proxyWorkerUrl ?? null,
    xhsCookie: config.xhsMcpConfig?.cookie ?? '',
  };
};

/**
 * fire 前置状态不完整时抛这个 —— 不降级。
 *
 * 排程链已经保证「先传云端状态、成功了再建任务」（见 activeMsgClient 的
 * putClientStateOrThrow），所以到点读不到 fire_pack 只有三种可能：云端状态被删了、
 * 数据坏了、任务是开发期的旧格式。都是异常，不是能悄悄降级的正常分支。
 *
 * 为什么抛错而不是 { skip: true }：skip 是「这次故意不发」的出口（防穿帮闸在用），
 * 用它表达「坏了」会把两件事混在一起，而且循环任务会天天静默不响、只有 worker 日志
 * 里看得见。抛错走库的投递失败路径（重试 3 次后把任务标 failed），至少留下痕迹。
 */
const fireStateError = (reason: string, detail: Record<string, unknown>): Error => {
  console.error('[amsg:fire-state-missing]', { reason, ...detail });
  return new Error(`AMSG2_FIRE_STATE_MISSING: ${reason}`);
};

/**
 * 体积判定要留的余量。
 *
 * 这里量的是 hook 交还给库的那份 payload，而库在这之后还会补 messageId / sessionId /
 * timestamp / messageIndex / totalMessages（见 sendHookPushPayloads）——实测多出一百多
 * 字节。卡着上限判定的话，量出来「刚好装得下」的那一档补完字段就超了：既没走旁路存储、
 * 也发不出去，整条消息丢掉，而且每次重试都在同一处失败。
 *
 * 取 256 是实际增量的两倍冗余，上游哪天再多补一两个字段也吃得下。代价是本来卡在这
 * 一档里的消息会多绕一次旁路存储（一次读写，用户无感），比发不出去划算得多。
 */
const PUSH_BUDGET_RESERVE_BYTES = 256;

/**
 * 一条 push 装不下时，把 XHS 会话数据旁路存进 client_state，payload 里只留引用键。
 *
 * Web Push 的 payload 上限是 4096 字节密文（明文 3993，见 measurePushPayload），
 * 一张笔记连标题带摘要就六七百字节。过去的做法是硬砍到 4 张，于是角色说「分享了 6 张」
 * 而只出来 4 张卡——话和内容对不上，一眼假。现在改成按真实字节算：装得下就照装
 * （日常 1-3 张走的就是这条，行为不变），装不下才把整份挪到 client_state，
 * 客户端上线后按 `metadata.xhsSessionRef` 取回，一张不少。
 *
 * 存不进去时**抛错**而不是砍内容：抛错走投递失败重试，砍内容则是当场穿帮且无从察觉。
 */
export const offloadOversizedPush = async (
  payload: Record<string, unknown>,
  writeState: WriteState | undefined,
  charId: string,
  clientTaskId: string,
): Promise<Record<string, unknown>> => {
  if (measurePushPayload(JSON.stringify(payload)).remainingBytes >= PUSH_BUDGET_RESERVE_BYTES) {
    return payload;
  }

  const meta = (payload.metadata ?? {}) as Record<string, unknown>;
  if (!meta.xhsSession) return payload;   // 没有可旁路的东西，交给库抛 PUSH_PAYLOAD_TOO_LARGE

  if (typeof writeState !== 'function') {
    // 老部署（amsg-server < 2.6.0-next.7）没有写入口。不静默砍卡片——抛错让这次投递
    // 失败重试，设置页的版本门槛会提示用户重新粘贴部署。
    throw new Error('AMSG2_WRITE_STATE_UNSUPPORTED: push 超限需要旁路存储，请在设置页重新粘贴部署 worker');
  }

  const key = amsgXhsSessionKey(clientTaskId);
  await writeState(amsgStateNamespace(charId), [
    { key, value: JSON.stringify(meta.xhsSession) },
  ]);
  const { xhsSession: _offloaded, ...restMeta } = meta;
  const slimmed = { ...payload, metadata: { ...restMeta, xhsSessionRef: key } };
  console.log('[amsg:agentic] XHS 会话数据旁路存储', {
    key,
    charId,
    beforeBytes: measurePushPayload(JSON.stringify(payload)).bytes,
    afterBytes: measurePushPayload(JSON.stringify(slimmed)).bytes,
  });
  return slimmed;
};

/**
 * 防穿帮闸跳过一次触发时，留一句「为什么没响」给客户端。
 *
 * 闸是静默工作的：判定该让路就直接跳过，一条 push 都不发，而远端那行任务两种情况下
 * （真发出去了 / 被闸拦下）都会被消费掉。客户端事后看到的一模一样，用户只会觉得
 * 「说好的消息呢」。留一条记录，面板就能照实说明。
 *
 * best-effort：写不进去不能连累这次 skip 本身——闸该拦还是要拦，少一句解释而已。
 */
const writeLastSkip = async (
  writeState: WriteState | undefined,
  charId: string,
  skip: AmsgLastSkip,
): Promise<void> => {
  if (typeof writeState !== 'function') return;
  try {
    await writeState(amsgStateNamespace(charId), [
      { key: AMSG_LAST_SKIP_KEY, value: JSON.stringify(skip) },
    ]);
  } catch (error) {
    console.warn('[amsg:skip] 跳过原因写入失败（跳过本身照常生效，只是面板少一句说明）', error);
  }
};

const recordSkip = async (
  ctx: FireCtx,
  charId: string,
  reason: AmsgLastSkip['reason'],
  occurrenceMs: number,
): Promise<void> =>
  writeLastSkip(ctx.writeState, charId, {
    v: 1,
    taskUuid: typeof ctx.task.uuid === 'string' ? ctx.task.uuid : null,
    occurrenceMs,
    reason,
    skippedAt: ctx.now.getTime(),
  });

// ─── self_log 的发送后回写（⑥）───
//
// 过去 recordSelfLog 在 onLLMOutput 里、推送发出**之前**调用——LLM 成功但推送全挂时
// 云端记了「说过」而用户一个字没收到，下次 fire 角色会接着一句不存在的话往下说。
// 现在改成：onLLMOutput 只把各段正文暂存进 pendingSelfLogs，等库发完（或发挂）后调
// config 级 hook onAfterSend({ task, sentCount, total, error })（amsg-server
// 2.6.0-next.10 起；task 是 D1 任务行原样），只把**前 sentCount 段**写进 self_log，
// entry.at 用实际发送时刻。sentCount=0（一段都没出去）不写——重试的下一条 fire 会
// 重新生成、重新登记。
//
// 并发隔离：worker 单 isolate 内最多并发 8 个 fire，登记表按任务行 id 一格一格分开，
// onAfterSend 拿 task.id 对号——绝不能做成「谁先到算谁的」的单例。

interface PendingSelfLog {
  charId: string;
  clientTaskId: string;
  occurrenceMs: number;
  /** 各段正文（与 pushPayloads 一一对应），onAfterSend 按 sentCount 截取。 */
  texts: string[];
  /** 本次 fire 的 stash（selfLog 的当前版本挂在上面，写完要更新回去）。 */
  stash: FireStash;
  writeState: WriteState;
  registeredAt: number;
}

/** 任务行 id（字符串化）→ 待写的 self_log。export 只为单测。 */
export const pendingSelfLogs = new Map<string, PendingSelfLog>();

/** 登记表兜底清扫线：fire 总预算 240s，远超它还没被认领的条目就是泄漏，别攒着。 */
const PENDING_SELF_LOG_TTL_MS = 15 * 60_000;

const prunePendingSelfLogs = (nowMs: number): void => {
  for (const [key, entry] of pendingSelfLogs) {
    if (nowMs - entry.registeredAt > PENDING_SELF_LOG_TTL_MS) pendingSelfLogs.delete(key);
  }
};

/**
 * 推送发出（或发挂）之后把真正送出去的正文写进云端自述日志（config 级 hook，
 * 见 buildWorkerConfig）。best-effort：写不进去不能连累投递结果，只是下一次到点
 * 角色不知道自己说过这句，所以失败要吼一声。
 *
 * entry.at 用实际发送时刻（不是名义 occurrenceMs）：日志给角色读的是「我几点几分
 * 真的说了这句」，cron 延迟半小时时名义时刻是句谎话。id 仍是
 * `clientTaskId@occurrenceMs`——去重语义（同一次触发重跑同 id 覆盖）靠它，不动。
 *
 * 参数按 amsg-server 2.6.0-next.10 的实参形状收：{ task, sentCount, total, error }，task 是 D1 任务行原样
 * （encrypted_payload 是密文、不含明文凭据），并发对号用 task.id。
 */
export const amsgAfterSend = async (
  info: { task?: { id?: unknown } | null; sentCount?: number; total?: number; error?: unknown },
): Promise<void> => {
  const taskRowId = info?.task?.id != null ? String(info.task.id) : null;
  if (taskRowId == null) {
    // 载荷缺 task.id 就没法对号入座（登记表按任务行 id 分格）——宁可不写也不能猜。
    console.warn('[amsg:self-log] onAfterSend 载荷缺 task.id，无法对号入座，这次不写自述');
    return;
  }
  const entry = pendingSelfLogs.get(taskRowId);
  if (!entry) return;   // 本次 fire 没登记（无正文/缺 charId），或已被认领过
  pendingSelfLogs.delete(taskRowId);

  const sentCount = typeof info.sentCount === 'number' ? info.sentCount : 0;
  if (sentCount <= 0) return;   // 一段都没送出去 = 用户什么都没收到，不能记「说过」

  // 多段消息在用户那边是连着的几条气泡，对角色而言是一次「我说了这些」，合成一条记。
  // 只取前 sentCount 段：部分失败时没送出去的正文绝不能进日志。
  const text = entry.texts
    .slice(0, sentCount)
    .filter((message) => message.trim())
    .join('\n');
  const next = appendSelfLogEntry(entry.stash.selfLog, {
    id: `${entry.clientTaskId || 'task'}@${entry.occurrenceMs}`,
    at: Date.now(),
    text,
  });
  // 整段只有副作用标签（正文为空）时 append 原样返回——没有话可记，也就不必写一次库。
  if (next === entry.stash.selfLog) return;
  entry.stash.selfLog = next;

  try {
    await entry.writeState(amsgStateNamespace(entry.charId), [
      { key: AMSG_SELF_LOG_KEY, value: JSON.stringify(next) },
    ]);
  } catch (error) {
    console.warn('[amsg:self-log] 写入失败（这次照常发送，但下一次到点角色不会知道说过这句）', error);
  }
};

// ─── stale 守卫的消费端（⑥）───
//
// 上游 run-tick 的补发新鲜度守卫：一次性任务错过触发时刻太久（服务停摆后恢复）不再
// 补发，任务标 failed 并调 config 级 hook onStaleSkip(task, { reason: 'stale',
// metadata })。不接这个 hook 的话，用户看到的就是「说好的消息凭空消失」——这里把它
// 写成 last_skip，面板照实说明（describeLastSkip 的 stale 文案）。
//
// 两个现实限制（都 best-effort，写不进去只是少一句解释）：
//   - task 是 D1 任务行原样，charId 在 encrypted_payload 里解不开。上游把解密后的
//     payload.metadata 递进第二参（只透传 metadata，凭据不外漏），charId 从那里取；
//     两条排程路径（客户端排 / 角色自排）建任务时都写了 metadata.charId，取不到
//     就是真异常，只能放弃留痕。
//   - config 级 hook 拿不到 writeState，用最近一次 fire 缓存的那份（单用户 worker
//     里 writeState 对谁都是同一个用户键，跨 fire 复用语义相同）；isolate 冷启动后
//     一次 fire 都没跑过时缓存为空，只好放弃留痕。

let cachedWriteState: WriteState | null = null;

/** config 级 stale 回执 hook（见 buildWorkerConfig）。export 只为单测。 */
export const amsgStaleSkip = async (
  task: { id?: unknown; uuid?: unknown; next_send_at?: unknown } | null | undefined,
  info?: { reason?: string; metadata?: unknown },
): Promise<void> => {
  const meta = (info?.metadata ?? {}) as Record<string, unknown>;
  const charId = typeof meta.charId === 'string' && meta.charId ? meta.charId : null;
  if (!charId) {
    console.warn('[amsg:stale-skip] 任务 metadata 缺 charId，这次过期跳过没法留痕', { taskId: task?.id ?? null });
    return;
  }
  if (!cachedWriteState) {
    console.warn('[amsg:stale-skip] 还没有可用的 writeState（isolate 冷启动），这次过期跳过没法留痕', { charId });
    return;
  }
  const occurrenceMs = Date.parse(String(task?.next_send_at ?? ''));
  await writeLastSkip(cachedWriteState, charId, {
    v: 1,
    taskUuid: typeof task?.uuid === 'string' ? task.uuid : null,
    occurrenceMs: Number.isFinite(occurrenceMs) ? occurrenceMs : Date.now(),
    reason: 'stale',
    skippedAt: Date.now(),
  });
};

/**
 * 把角色这次给自己排下的任务挂到最后一条 push 上，客户端收到时补进本地清单。
 *
 * 为什么要带回去：任务是在 D1 里建的，客户端那份清单并不知道它存在——面板不显示、
 * 用户想取消也找不到。任务本身照常触发（这正是自排的意义：不依赖客户端在线），
 * 客户端上线认领只是把账对上。
 *
 * 挂在**最后一条**：与 directives 同一个位置，收侧的 isLastChunk 守卫保证只重放一次。
 * 一条 push 都没有（整段被判空）时原样返回——那种情况下这次本来也没东西发出去。
 */
export const attachScheduledTasks = (
  pushPayloads: Array<Record<string, unknown>>,
  tasks: ActiveMsg2TaskRecord[],
): Array<Record<string, unknown>> => {
  if (tasks.length === 0 || pushPayloads.length === 0) return pushPayloads;
  const lastIdx = pushPayloads.length - 1;
  return pushPayloads.map((payload, i) => (i === lastIdx
    ? {
      ...payload,
      metadata: { ...(payload.metadata as Record<string, unknown> ?? {}), amsgSelfScheduled: tasks },
    }
    : payload));
};

/**
 * 执行一次「给自己排下一条」。永不抛错——参数写歪、排满了都以 ok:false 回喂让模型改口，
 * 跟别的工具一个语义（fire 抛错 = 整条任务重跑 = 用户这次一个字都收不到）。
 *
 * 幂等：任务 uuid 由「本次触发 + 第几条」推出来，fire 重跑时上游认出撞车、回 created:false，
 * 不会每重试一次多排一条。
 */
export const runFireScheduleTool = async (
  stash: FireStash,
  scheduleTask: ScheduleTask | undefined,
  args: Record<string, unknown>,
  nowMs: number,
): Promise<Record<string, unknown>> => {
  if (typeof scheduleTask !== 'function') {
    // 老 worker 部署（amsg-server < 2.6.0-next.9）没有这个口子。设置页的版本门槛会提示
    // 重新粘贴，这里只需要让角色别以为排上了。
    return { ok: false, reason: 'not_supported', message: '当前后台版本还不支持给自己排后续，这次就把话说完吧。' };
  }
  if (stash.scheduledTasks.length >= MAX_FIRE_SCHEDULES) {
    return {
      ok: false,
      reason: 'fire_limit',
      message: `这次已经排了 ${MAX_FIRE_SCHEDULES} 条，够了，剩下的话直接写进这条消息里。`,
    };
  }
  const live = stash.pendingTaskCount + stash.scheduledTasks.length;
  if (live >= MAX_ACTIVE_TASKS_PER_CHAR) {
    return {
      ok: false,
      reason: 'task_limit',
      message: `你同时挂着的任务已经有 ${live} 个（上限 ${MAX_ACTIVE_TASKS_PER_CHAR}），这次别再排了。`,
    };
  }

  // 裸 send_at 按角色的时间参照系解析（③）：角色在 prompt 里看到的钟是它自己时区的，
  // worker 跑在 UTC，不带 tz 的话「明早 9 点」会整整差一个时差。
  const parsed = parseFireScheduleArgs(args, nowMs, stash.tz);
  if ('ok' in parsed) return parsed as unknown as Record<string, unknown>;

  // 同一次触发内第几条 —— 连同触发时刻构成确定性 uuid，重跑对得上。
  const seq = stash.scheduledTasks.length;
  const uuid = `amsgself-${stash.charId}-${stash.occurrenceMs}-${seq}`;
  const clientTaskId = `${uuid}-c`;

  let result;
  try {
    result = await scheduleTask({
      firstSendTime: parsed.sendAt,
      recurrenceType: parsed.recurrence,
      messageType: parsed.mode,
      uuid,
      metadata: {
        charId: stash.charId,
        source: 'active_msg_2',
        amsgMode: parsed.mode,
        amsgClientTaskId: clientTaskId,
        amsgExpirePolicy: parsed.expirePolicy,
        // 防穿帮闸锚点：这条排下去之后，用户再开口就算「对话往前走了」。
        amsgAnchorMs: stash.anchorMs,
        amsgTaskInstruction: buildTaskInstruction(parsed.mode, parsed.promptHint),
      },
    });
  } catch (error) {
    // 上游的护栏（时间太近、类型不对、超上限）都抛错。转成回喂，让模型换个时间再试。
    return {
      ok: false,
      reason: 'schedule_rejected',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (!result.created) {
    // 撞车 = 这一条上次重跑时已经建过了。对模型来说结果一样（那条确实排上了）。
    return { ok: true, already_scheduled: true, send_at: parsed.sendAt };
  }

  const record: ActiveMsg2TaskRecord = {
    taskUuid: result.uuid,
    clientTaskId,
    mode: parsed.mode,
    firstSendTime: parsed.sendAt,
    recurrenceType: parsed.recurrence,
    ...(parsed.promptHint ? { promptHint: parsed.promptHint } : {}),
    expirePolicy: parsed.expirePolicy,
    anchorLastUserMsgAt: stash.anchorMs,
    source: 'character',
    status: 'scheduled',
    createdAt: nowMs,
  };
  stash.scheduledTasks.push(record);
  stash.selfLog = appendSelfLogTask(stash.selfLog, record);
  console.log('[amsg:self-schedule]', { uuid: result.uuid, sendAt: parsed.sendAt, mode: parsed.mode });

  return {
    ok: true,
    task_id: result.uuid.slice(0, 8),
    send_at: parsed.sendAt,
    message: '排好了。到点你会知道自己这次说了什么，接着说就行，现在不用剧透。',
  };
};

/**
 * 单个 MCP 调用的超时。总 fire 预算 240s / 最多 5 轮，一个慢服务器不能吃光
 * 整条链（浏览器侧是 60s，那边没有轮次预算压力）。
 *
 * 单次上限之外还有下面那条共享总预算：native FC 一轮可以吐好几个调用，
 * executeToolCalls 是串行 await 的，只卡单次的话 25s × N 照样能顶穿 240s。
 */
const MCP_CALL_TIMEOUT_MS = 25_000;

/**
 * 单次 fire 内全部 MCP 调用共享的时间预算。总 fire 240s，扣掉 LLM 往返，
 * MCP 最多吃一半——预算尽了让后续调用早退（ok:false 回喂），比转到轮次上限
 * 整条任务重跑便宜得多（重跑的代价见 agenticToolFeedback 头注释）。
 */
const MCP_TOTAL_BUDGET_MS = 120_000;

/**
 * 执行一个带 MCP_FIRE_NAME_PREFIX 的工具调用。永不抛错——失败也以 ok:false 回喂给 LLM
 * 圆场（与 dispatchAgenticTool 的失败语义对齐，见 executeToolCalls 注释）。
 * export 只为单测。
 */
export const runMcpFireTool = async (
  stash: Pick<FireStash, 'mcpResolve' | 'mcpSessions' | 'mcpSpentMs'>,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const exposed = name.slice(MCP_FIRE_NAME_PREFIX.length);
  const hit = stash.mcpResolve?.get(exposed);
  if (!hit) {
    return { ok: false, reason: 'unknown_tool', message: `未配置的 MCP 工具: ${exposed}` };
  }
  // 预算尽了就不再发请求，直接把「别调了，收尾吧」回喂给模型——继续排队等超时只会
  // 把 fire 拖过总预算，那是整条任务重跑，比少查一次贵得多。
  const remaining = MCP_TOTAL_BUDGET_MS - stash.mcpSpentMs;
  if (remaining <= 0) {
    return {
      ok: false,
      reason: 'mcp_budget_exhausted',
      source: hit.server.name,
      message: 'MCP 调用时间预算已用完，这轮别再调外部工具了，用手上已有的信息收尾。',
    };
  }
  // 每台服务器一份会话，单次 fire 内跨轮复用：一次 fire 最多五轮，每轮重握手就是白烧往返。
  let session = stash.mcpSessions.get(hit.server.id);
  if (!session) {
    session = createMcpSessionState();
    stash.mcpSessions.set(hit.server.id, session);
  }
  const started = Date.now();
  const result = await callMcpToolCore(
    // worker 侧 fetch 没有 CORS，直连用户配的地址，不经代理。
    { url: hit.server.url, headers: (sid) => buildMcpDirectHeaders(hit.server, sid) },
    session,
    hit.toolName,
    args as Record<string, any>,
    {
      // 剩余预算比单次上限还少时按剩余的来，最后一个调用不会越过总线。
      timeoutMs: Math.min(MCP_CALL_TIMEOUT_MS, remaining),
      inputSchema: hit.tool.inputSchema,
      serverLabel: hit.server.name,
    },
  );
  // 失败/超时的耗时同样记账——烧掉的墙钟时间不因为结果不好就不算。
  stash.mcpSpentMs += Date.now() - started;
  return result.success
    ? { ok: true, source: hit.server.name, data: formatMcpToolResult(result.data) }
    : { ok: false, reason: 'mcp_error', source: hit.server.name, message: result.error };
};

// export 只为单测（见 index.test.ts）：onBeforeFire 的四道门顺序是这个功能最关键的
// 决策路径，一个判断写错位就是「该拦的没拦」或「全都不发」，必须有回归守卫钉住。
export const amsgHooks = {
  async onBeforeFire(ctx: FireCtx) {
    const charId = ctx.task?.metadata?.charId;
    if (typeof charId !== 'string' || !charId) {
      throw fireStateError('task metadata 缺 charId', { taskId: ctx.task.id });
    }
    // 下面每道门的报错都带同一套定位信息，绑一次就好——逐处手抄 detail 的话，
    // 加一道门就要再抄一遍，漏了就是一条查不到是谁的错误日志。
    const fail = (reason: string, extra?: Record<string, unknown>) =>
      fireStateError(reason, { taskId: ctx.task.id, charId, ...extra });

    const charRows = await ctx.readState(amsgStateNamespace(charId));

    const taskMeta = (ctx.task.metadata ?? {}) as Record<string, unknown>;
    const policy = typeof taskMeta.amsgExpirePolicy === 'string'
      ? taskMeta.amsgExpirePolicy : undefined;

    // 同角色活跃会话租约：一轮对话生成期间客户端每 15s 续租，45s TTL。
    // 这是 worker 防通知的第一道快速门；缺失/过期/坏数据就继续走 fire_pack 规则。
    // 保持在 fire_pack 检查之前：用户正在聊天时应该直接 skip，既省一次状态读，
    // 也让「状态不完整」的异常任务在用户正忙时安静跳过、而不是抛错刷失败计数。
    const presence = parseAmsgChatPresence(
      charRows.find((r) => r.key === AMSG_CHAT_PRESENCE_KEY)?.value,
    );
    if (policy === 'expire' && isFreshChatPresence(presence, charId, ctx.now.getTime())) {
      console.log('[amsg:expire-skip]', {
        taskId: ctx.task.id,
        reason: 'active-chat-presence',
        presenceActiveAt: presence?.activeAt,
      });
      // 这道门在解析 fire_pack 之前，拿不到 occurrenceMs，用任务行的名义时刻。
      await recordSkip(
        ctx, charId, 'active-chat-presence',
        Date.parse(String(ctx.task.nextSendAt)) || ctx.now.getTime(),
      );
      return { skip: true } as const;
    }

    const packRow = charRows.find((r) => r.key === AMSG_FIRE_PACK_KEY);
    if (!packRow) throw fail('云端没有这个角色的 fire_pack');

    // 大值分块由 amsg-server 2.6.0-next.4+ 在存储层透明处理，readState 拿到的已是拼回的原文。
    // 前端压过之后值以 gz1: 开头，unpackStateValue 按前缀解；内容太短没压的原样穿过去。
    let packJson: string;
    try {
      packJson = await unpackStateValue(packRow.value);
    } catch (error) {
      throw fail('fire_pack 解压失败（数据损坏）', { error: String(error) });
    }
    const pack = parseFirePack(packJson);
    if (!pack) throw fail('fire_pack 解析失败（格式不对或数据损坏）');

    // 本次触发时刻：任务行 next_send_at（NOT NULL，buildHookTask 已摊平提供）。防穿帮闸的
    // 循环判定要拿它当窗口锚点，之后又经 scratch 透传给每条 push 的 metadata.amsgOccurrenceMs
    // （客户端兜底闸的循环判定与吞放缓存键都要它）。解析不出来说明上游任务行的时间格式变了，
    // 按状态异常硬失败。
    const occurrenceMs = Date.parse(String(ctx.task.nextSendAt));
    if (!Number.isFinite(occurrenceMs)) {
      throw fail('任务行 next_send_at 解析不出触发时刻', { nextSendAt: ctx.task.nextSendAt });
    }

    // 防穿帮闸·worker 主判定：一次性任务创建后对话已前进 / 循环任务到点时用户
    // 正在热聊 → { skip: true } 跳过本次 fire（amsg-server skip 出口，任务照常
    // 推进/删除），一个生成 token 都不花。fire_pack.lastUserMessageAt 随
    // amsgStateSync 去抖同步、最多滞后十几秒；剩余竞态由客户端送达兜底闸兜住
    // （activeMsgRuntime 的 runtime-expire-swallow）。缺策略字段的任务不拦。
    const expireInput = {
      policy,
      recurrenceType: ctx.task.recurrenceType,
      anchorMs: typeof taskMeta.amsgAnchorMs === 'number' ? taskMeta.amsgAnchorMs : null,
      lastUserMessageAt: pack.lastUserMessageAt ?? null,
      nowMs: ctx.now.getTime(),
      occurrenceMs,
    };
    if (shouldExpireFire(expireInput)) {
      console.log('[amsg:expire-skip]', { taskId: ctx.task.id, ...expireInput });
      await recordSkip(ctx, charId, 'conversation-moved-on', occurrenceMs);
      return { skip: true } as const;
    }

    // 任务指令缺失（开发期旧格式任务）：不能用默认 auto 指令凑一个渲染——那会把
    // prompted 任务的方向偷换掉，发出去的内容和用户当初排的不是一回事。
    if (typeof taskMeta.amsgTaskInstruction !== 'string') {
      throw fail('任务 metadata 缺 amsgTaskInstruction（旧格式任务）');
    }

    // 工具数据与 prompt 同拍装好，挂 ctx.scratch 给同一次 fire 的
    // onLLMOutput / executeToolCalls（库保证同引用、fire 结束即丢，
    // 不需要自维护 sessionId → 状态的 Map 和防泄漏水位）。
    const globalRows = await ctx.readState(AMSG_GLOBAL_NAMESPACE);
    const toolPackRow = charRows.find((r) => r.key === AMSG_TOOL_PACK_KEY);
    const toolConfigRow = globalRows.find((r) => r.key === AMSG_TOOL_CONFIG_KEY);
    if (!toolPackRow) throw fail('云端没有这个角色的 tool_pack');
    if (!toolConfigRow) throw fail('云端没有 tool_config');

    // 两份数据和 fire_pack 同批原子上传（activeMsgClient 的 putClientStateOrThrow），
    // 所以走到这里必然都在；解析不出来就是云端状态坏了，硬失败不降级。
    const toolPack = parseToolPack(toolPackRow.value);
    if (!toolPack) throw fail('tool_pack 解析失败（格式不对或数据损坏）');
    const toolConfig = parseToolConfig(toolConfigRow.value);
    if (!toolConfig) throw fail('tool_config 解析失败（格式不对或数据损坏）');

    // 通用 MCP：提示词块 / tools 数组与凭据同源同拍（都来自这一行 tool_config），
    // 不存在「教了角色用、凭据却没到」的窗口。charIds 过滤与前台同语义。
    // mcpUseNativeTools=false = 用户的中转拒 tools（前台兼容模式同款开关），
    // 请求不带 tools 参数、提示词块教正文协议，识别走 processLLMRound 第二层。
    const mcpServers = filterMcpServersForChar(toolConfig.mcpServers, charId);
    // 暴露名后面要拼 MCP_FIRE_NAME_PREFIX，长度预算得先把前缀那几个字符扣掉。
    const mcpResolve = mcpServers.length
      ? buildMcpNameMap(mcpServers, { maxNameLen: MCP_FIRE_NAME_BUDGET })
      : null;
    const mcpNative = toolConfig.mcpUseNativeTools !== false;

    // 角色上次到点自己说了什么：跟这份 fire_pack 对得上才算数，对不上就当没有、从空的一份
    // 重新开始攒。判定与「丢弃」的理由见 amsgFirePack 的 selfLogMatchesPack。
    const storedSelfLog = parseSelfLog(charRows.find((r) => r.key === AMSG_SELF_LOG_KEY)?.value ?? '');
    const selfLog = selfLogMatchesPack(storedSelfLog, pack)
      ? storedSelfLog as AmsgSelfLog
      : createSelfLog(pack.builtAt);

    // 客户端记录的（打包那一刻的快照）+ 角色自己在之前几次 fire 里排下、客户端还没认领的。
    // 后者不补上的话，角色排完一条、下次到点又看不见它，很容易把同一件事再排一遍。
    const livePendingTasks = [...pack.pendingTasks, ...selfLog.tasks];

    // 老 worker 部署（amsg-server < 2.6.0-next.9）没有这个口子。教了也排不成，
    // 只会让角色说「我等下再找你」然后没有下文——干脆不教。
    const canSelfSchedule = typeof ctx.scheduleTask === 'function';

    // stale 守卫回执要用的写口缓存（config 级 hook 拿不到 writeState，见 amsgStaleSkip）。
    if (typeof ctx.writeState === 'function') cachedWriteState = ctx.writeState;

    // 角色的时间参照系：fire_pack 的 tzId（parseFirePack 保证非空，Intl 管夏令时）。
    const tz: AmsgTzRef = { tzId: pack.tzId };

    const { toolCtx, proxyWorkerUrl, xhsCookie } = buildToolCtx(toolPack, toolConfig);
    ctx.scratch.fire = {
      session: createFireSessionState(),
      toolCtx,
      proxyWorkerUrl,
      xhsCookie,
      occurrenceMs,
      selfLog,
      mcpResolve,
      mcpSessions: new Map(),
      mcpSpentMs: 0,
      // 「还能不能再排」按客户端已知的 + 角色自己排过还没被认领的一起算，
      // 不然角色离线期间连排几次就能绕过每角色的任务上限。
      pendingTaskCount: livePendingTasks.length,
      scheduledTasks: [],
      charId,
      anchorMs: pack.lastUserMessageAt ?? 0,
      tz,
      taskUuid: typeof ctx.task.uuid === 'string' ? ctx.task.uuid : null,
      taskRowId: ctx.task.id != null ? String(ctx.task.id) : null,
    } satisfies FireStash;

    // 「你还挂着这些排程」：客户端记录的（打包那一刻的快照）+ 角色自己在之前几次 fire 里
    // 排下、客户端还没认领的那些。后者不补上的话，角色排完一条、下次到点又看不见它，
    // 很容易把同一件事再排一遍。
    const taskListBlock = buildFireTaskListBlock(livePendingTasks, {
      nowMs: ctx.now.getTime(),
      tzId: pack.tzId,
      excludeClientTaskId: typeof taskMeta.amsgClientTaskId === 'string'
        ? taskMeta.amsgClientTaskId : undefined,
    });

    // fire_pack v3：「本次任务」指令随任务 metadata 走，这里填槽。
    // MCP 块拼在渲染好的 prompt 之后（同一条 user 消息）。
    const prompt = renderFirePack(pack, ctx.now.getTime(), taskMeta.amsgTaskInstruction, {
      selfLog,
      taskListBlock,
    })
      + (mcpResolve ? buildMcpFireBlock(mcpResolve, { mode: mcpNative ? 'native' : 'text' }) : '')
      // 「给自己排下一条」的说明。跟 MCP 共用一个 native/text 判断：用户的中转拒 tools 时
      // 两边都得改教正文协议，不然一边声明成 tools、一边教语法，模型会两种都写一遍。
      // 时间上下文让 send_at 的示例是「明天这个点」的裸墙钟，别再教模型写 offset。
      + (canSelfSchedule
        ? buildFireScheduleBlock(mcpNative ? 'native' : 'text', { nowMs: ctx.now.getTime(), tz })
        : '');
    const fireTools = [
      ...(mcpResolve && mcpNative ? buildMcpFireTools(mcpResolve) : []),
      ...(canSelfSchedule && mcpNative
        ? [buildFireScheduleTool({ nowMs: ctx.now.getTime(), tz })]
        : []),
    ];
    return {
      messages: [{ role: 'user' as const, content: prompt }],
      // amsg-server 带 agentic-fire-tools feature 的版本起透传给每轮 LLM 请求；
      // 老 bundle 里不会走到这（tools 是随本次 bundle 一起升上去的）。
      ...(fireTools.length ? { tools: fireTools } : {}),
    };
  },

  async onLLMOutput(ctx: SessionCtx) {
    const content = stripReasoningTags(ctx.llmOutputText || '').trim();

    // 老链路 push 带 taskId=任务行 id；sessionCtx 没有它，但 sessionId 是文档化的
    // `sess_task_<id>` 格式（agentic-fire 与老链路同 scheme），从这里拆；拆不出置 null。
    const taskId = ctx.sessionId.startsWith('sess_task_')
      ? ctx.sessionId.slice('sess_task_'.length)
      : null;
    if (taskId == null) {
      // 拆不出说明上游 sessionId 格式变了，而后果是静默的：送达消息的
      // metadata.activeMsg2.taskId 会是 null → 客户端 hasDeliveredProactiveNear 判定
      // 「这次没送达过」→ 排程现状块给角色注入一条假的「已作废」回执，角色可能把已经
      // 发出去的事又当没发生。留个日志，别让它只能靠猜。
      console.warn('[amsg:agentic] sessionId 不是 sess_task_<id> 格式，taskId 置空（送达归属会失效）', ctx.sessionId);
    }
    const messageType = typeof ctx.metadata?.amsgMode === 'string' ? ctx.metadata.amsgMode : 'auto';

    // onBeforeFire 要么抛错、要么 skip、要么在返回 messages 之前把 stash 挂上，所以
    // 走到这里 stash 必然存在（库保证 fireCtx.scratch 与每轮 sessionCtx.scratch 同引用）。
    // 真缺了就是这个前提被打破（比如库不再共享 scratch）——响亮地失败，别静默丢旁白。
    const stash = getFireStash(ctx.scratch);
    if (!stash) {
      throw new Error('AMSG2_FIRE_STASH_MISSING: onLLMOutput 读不到 ctx.scratch.fire，检查 amsg-server 是否仍共享 scratch');
    }
    const session = stash.session;

    // native tool_calls：只认 tools 数组里声明过的 MCP 名字。模型幻觉出的
    // 未声明调用（比如给 tag 工具编一个 native 调用）丢弃并留日志——直接透传
    // 会让 executeToolCalls 撞上没有 stash 映射的名字。日志带上当时声明了哪些，
    // 「模型编的」和「名字映射建歪了」一眼能分开。
    const rawToolCalls = (ctx.llmResponse as { choices?: Array<{ message?: { tool_calls?: unknown } }> })
      ?.choices?.[0]?.message?.tool_calls;
    const allNativeCalls = (Array.isArray(rawToolCalls) ? rawToolCalls : []) as ToolCall[];
    const nativeScheduleCalls = allNativeCalls.filter(
      (tc) => tc?.function?.name === AMSG_FIRE_SCHEDULE_TOOL,
    );
    const nativeMcpCalls = allNativeCalls.filter((tc): tc is ToolCall => {
      const n = (tc as ToolCall | undefined)?.function?.name;
      if (n === AMSG_FIRE_SCHEDULE_TOOL) return false;   // 排程工具走上面那条，不算 MCP
      const hit = typeof n === 'string'
        && n.startsWith(MCP_FIRE_NAME_PREFIX)
        && !!stash.mcpResolve?.has(n.slice(MCP_FIRE_NAME_PREFIX.length));
      if (!hit) {
        console.warn('[amsg:agentic] 丢弃未声明的 native tool_call', {
          sessionId: ctx.sessionId,
          name: n ?? null,
          declared: [...(stash.mcpResolve?.keys() ?? [])],
        });
      }
      return hit;
    });

    let decision = processLLMRound(session, content, {
      contactName: ctx.contactName,
      avatarUrl: ctx.avatarUrl ?? null,
      taskId,
      messageType,
      metadata: ctx.metadata,
      occurrenceMs: stash.occurrenceMs,
      // round 1 XHS 工具抓到的笔记 / xsecToken 快照：finish 时按 directive 引用
      // 挑选后随最后一条 push 带回客户端（客户端离线跑不了 round 1，缺这份
      // [[XHS_SHARE]] / 点赞 / 评论重放必然 available:0 掉卡片）。
      xhsNotes: stash.toolCtx.lastXhsNotesRef?.current,
      xhsXsecTokens: stash.toolCtx.xhsCaches
        ? Array.from(stash.toolCtx.xhsCaches.xsecTokenCache.entries())
        : undefined,
    },
    stash.mcpResolve ? { resolve: stash.mcpResolve, nativeToolCalls: nativeMcpCalls } : null,
    // 传 null = 这次不认排程（老部署没这口子），正文里写了也不当调用。
    typeof ctx.scheduleTask === 'function' ? { nativeToolCalls: nativeScheduleCalls } : null);

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

    if (decision.decision === 'skip-push') {
      // ⑤ 空生成也留痕：模型返回空/纯拒答时上游把任务当成功消费，用户看到的就是
      // 「说好的消息凭空消失」。写一条 last_skip，面板能照实解释。best-effort，
      // 写不进去不影响 skip 本身。
      await writeLastSkip(ctx.writeState, stash.charId, {
        v: 1,
        taskUuid: stash.taskUuid,
        occurrenceMs: stash.occurrenceMs,
        reason: 'empty-generation',
        skippedAt: Date.now(),
      });
    }

    if (decision.decision === 'finish') {
      // 发之前按真实字节预算过一遍：装不下的 XHS 会话数据旁路存起来，push 只留引用键。
      // clientTaskId 当存储键（每任务一份、下次触发覆盖），缺了就没法旁路——那时超限会
      // 由库抛 PUSH_PAYLOAD_TOO_LARGE，照样不会静默丢消息。
      const clientTaskId = typeof ctx.metadata?.amsgClientTaskId === 'string'
        ? ctx.metadata.amsgClientTaskId : '';
      const charId = typeof ctx.metadata?.charId === 'string' ? ctx.metadata.charId : '';

      // 「我这次说了什么」不再在这里写库（那是推送发出前，见 pendingSelfLogs 头注释），
      // 只把各段正文登记进按任务行隔离的登记表，等 onAfterSend 按真送出去的段数落盘。
      if (charId && typeof ctx.writeState === 'function' && stash.taskRowId != null) {
        prunePendingSelfLogs(Date.now());
        pendingSelfLogs.set(stash.taskRowId, {
          charId,
          clientTaskId,
          occurrenceMs: stash.occurrenceMs,
          texts: decision.pushPayloads.map((p) => (typeof p.message === 'string' ? p.message : '')),
          stash,
          writeState: ctx.writeState,
          registeredAt: Date.now(),
        });
      }

      // 角色这次给自己排的任务，随最后一条 push 带回客户端认领——不然它们只活在 D1 里，
      // 面板看不到、用户也没法取消。任务本身照常触发，客户端上线补进清单即可。
      const withScheduled = attachScheduledTasks(decision.pushPayloads, stash.scheduledTasks);
      decision = { ...decision, pushPayloads: withScheduled };

      if (clientTaskId && charId) {
        const budgeted = [];
        for (const payload of decision.pushPayloads) {
          budgeted.push(await offloadOversizedPush(payload, ctx.writeState, charId, clientTaskId));
        }
        return { ...decision, pushPayloads: budgeted };
      }
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
    if (!stash) {
      throw new Error('AMSG2_FIRE_STASH_MISSING: executeToolCalls 读不到 ctx.scratch.fire，检查 amsg-server 是否仍共享 scratch');
    }
    // 搜索/Notion/飞书经代理 worker 转发；地址来自前端同步的 tool_config。XHS Lite cookie 同拍注入。
    //
    // 这两个注入写的是 isolate 级全局，而库到点最多并发跑 8 个任务（MAX_CONCURRENT=8）。
    // 现在安全的前提是：两个值都来自全局 namespace 的 tool_config，所有角色同一份，
    // 并发写的是同一个值。缺值时不覆盖——tool_config 瞬时读失败的那个 fire 不该把并发中
    // 另一个 fire 已经注入好的值清成空。
    //
    // TODO(按角色配凭据)：应用层目前不支持（realtimeConfig 是全局单份，按角色的只有
    // char.xhsEnabled 这个开关）。哪天凭据改成按角色配，这里必须改成显式传参——否则
    // 同一分钟并发的两个角色会互相串凭据，而且不会报错。
    if (stash.proxyWorkerUrl) setProxyWorkerUrlOverride(stash.proxyWorkerUrl);
    if (stash.xhsCookie) XhsMcpClient.setCookie(stash.xhsCookie);

    const results = [];
    for (const toolCall of toolCalls) {
      const name = toolCall?.function?.name || '';
      let content: string;
      try {
        const args = toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
        const fingerprint = toolCallFingerprint(name, args);

        // 同名同参第二次直接打回，一次请求都不发。软提示（下面那段回喂）挡不住时靠它兜底：
        // 转满上限会抛 AGENTIC_LOOP_EXCEEDED，任务不出清、下一分钟整条从头重跑，代价远大于
        // 少查一次。只拦完全一样的调用——换月份、换关键词照常放行，多轮能力不受影响。
        if (stash.session.toolCalls.some((r) => r.fingerprint === fingerprint)) {
          // 计数交给 processLLMRound：连着重复到阈值就直接收尾，不陪它转到轮次上限
          // （上限一到整条任务失败重跑，用户一个字都收不到）。
          stash.session.duplicateToolCalls += 1;
          console.log('[amsg:agentic]', {
            type: 'tool_duplicate',
            sessionId: ctx.sessionId,
            tool: name,
            count: stash.session.duplicateToolCalls,
          });
          results.push({
            tool_call_id: toolCall.id,
            role: 'tool' as const,
            content: buildDuplicateToolMessage(name),
          });
          continue;
        }

        // 三条去处，失败语义一致（都回 ok:false，不抛），回喂 / 记账 / 日志共用下面这段：
        //   排程 → 在 D1 里建下一条任务；MCP → 直连用户配的服务器；其余 → 内置数据工具。
        const result = name === AMSG_FIRE_SCHEDULE_TOOL
          ? await runFireScheduleTool(stash, ctx.scheduleTask, args, Date.now())
          : name.startsWith(MCP_FIRE_NAME_PREFIX)
            ? await runMcpFireTool(stash, name, args)
            : await dispatchAgenticTool(name, args, stash.toolCtx);
        stash.session.toolCalls.push({ name, fingerprint });
        // 不再回裸 JSON：模型从裸 JSON 里看不出「这一步已经做完了」，提示词里但凡有一句
        // 常驻的「先去查 X」就会每轮照做。这段话跟前台说的是同一套（见 agenticToolFeedback）。
        content = buildToolResultMessage({ name, result, history: stash.session.toolCalls });
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

/**
 * VAPID JWT 的 sub 字段：推送服务只要求它是个合法的 mailto: / https: 联系方式，
 * 内容不参与签名校验。但 scheduled() 一旦发现 email 为空就会整轮 return（一条任务
 * 都不处理、前端毫无提示），而「推送凭据」面板复制出来的 env 里 VAPID_EMAIL 是注释
 * 掉的可选项——照着部署必然缺它。所以这里给个缺省值兜底，配了就用用户配的。
 * （instant-push worker 一直是这个做法。）
 */
export const resolveVapidEmail = (raw: string | undefined): string =>
  raw?.trim() || 'mailto:noreply@sullyos.app';

/** worker 运行配置；导出便于单测钉住 VAPID 兜底。 */
export const buildWorkerConfig = (env: Env) => {
  // vapid 与 webpush 必须同源同一份：两处各读一次 env 时，改了一处漏另一处
  // 会变成「签名用兜底、校验用空值」这类只在真发推送时才暴露的坑。
  const vapid = {
    email: resolveVapidEmail(env.VAPID_EMAIL),
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  return {
    // db 缺省时 factory 自动用 createD1Adapter(env.DB)
    masterKey: env.AMSG_MASTER_KEY,
    serverToken: env.AMSG_SERVER_TOKEN,
    vapid,
    webpush: createWebCryptoWebPush(vapid),
    // 前端和 Worker 不同源，带自定义头的请求会先发 CORS 预检，必须放行。
    // 单用户自用默认全开；想收紧就把 '*' 换成自己的 SullyOS 站点 origin。
    cors: { origin: '*' },
    // 满血 fire-time hooks（onBeforeFire 现场填槽 + onLLMOutput 分类 +
    // executeToolCalls 服务端工具循环）；轮数/超时用库默认（5 轮 / 240s）。
    hooks: amsgHooks,
    // 发送后回执 + 过期跳过回执（amsg-server 2.6.0-next.10 的 config 级 hook）。
    // onAfterSend: 只把真送出去的段写进 self_log（见 amsgAfterSend / pendingSelfLogs）。
    // onStaleSkip: 过期不补发时给面板留一句「为什么没响」（见 amsgStaleSkip）。
    onAfterSend: amsgAfterSend,
    onStaleSkip: amsgStaleSkip,
  };
};

export default createSingleUserCloudflareWorker(buildWorkerConfig);

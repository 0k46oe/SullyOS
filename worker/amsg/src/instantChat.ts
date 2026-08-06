/**
 * 即时对话（instant chat）：把「用户按下发送」这一轮聊天当成一条立刻执行的任务。
 *
 * 客户端只发一个请求就自由了——切后台、杀进程都行，生成在这台 worker 里跑完，
 * 结果走 Web Push 回去。这份模块管三件事：
 *   1. `POST /instant-chat` 这条包装层路由（鉴权 → 内部转发 → 202 → 立刻起一跳）
 *   2. 即时对话那条 fire 用的「时效信息」块（当前时间 / 实时世界 / 排程说明拼一起）
 *   3. 收件兜底 outbox 的推送信封定稿（push 丢了客户端能按 messageId 补收）
 *
 * 为什么要在包装层做而不是直接调上游的三个端点：这三步有严格的先后和「前面失败就
 * 不能落任务」的语义（云端状态没传上去，到点的 fire 读到的还是上一轮的上下文，
 * 角色会对着旧对话回话）。放在客户端串三个请求的话，中间断网就会留下一条注定答错
 * 的任务；放在这里，客户端只有一次「成了 / 没成」。
 *
 * 加密由客户端做完，这里只搬运：两个信封原样转发给上游，上游照常解密和鉴权，
 * 它仍然是权威。包装层不碰用户密钥，也解不开这两个信封。
 *
 * 零浏览器依赖（这份代码会被打进 worker bundle）。
 */

import {
  AMSG_CHAT_OUTBOX_KEY,
  amsgStateNamespace,
  appendChatOutbox,
  buildUserClockHint,
  formatFireTimeFull,
  type AmsgChatOutbox,
  type AmsgChatOutboxEntry,
  type AmsgTzRef,
} from '../../../utils/amsgFirePack';

// ─── 时间参数 ───

/**
 * 客户端算 `firstSendTime` 时要往后留的提前量（毫秒）。
 *
 * 上游 `/schedule-message` 校验「firstSendTime 必须在未来」（严格大于收到请求的那一刻），
 * 而 cron 捡任务的条件是「next_send_at 已经到了」——两个条件互斥，所以先留一点提前量
 * 让校验过得去，落库之后包装层再把这一行拉到「此刻」（见 pullTaskDue）。
 *
 * 留 30 秒是给两样东西共用的余量：一是上行——这一个请求要背着整包云端状态
 * （chat 段可到几 MB）上传，慢网下走完「上传 + 写 client_state」才轮到校验；
 * 二是设备时钟——firstSendTime 用的是设备的钟，钟偏慢多少就吃掉多少余量。
 * 余量不够就会被打回「时间必须在未来」。拉到期这一步成功的话，这 30 秒一秒都
 * 不会等；代价只在拉到期失败的兜底路上（见 INSTANT_TICK_FALLBACK_WAIT_MS）。
 */
export const INSTANT_SCHEDULE_LEAD_MS = 30_000;

/**
 * 拉到期那一步没成时，起跳前先等多久。
 *
 * 任务行还挂在客户端给的那个时刻上，早跳一步只会空跑一轮，等过那个点再跳。
 * 再兜底还有每分钟的 cron。
 */
export const INSTANT_TICK_FALLBACK_WAIT_MS = INSTANT_SCHEDULE_LEAD_MS + 1_000;

/**
 * 即时对话这条 fire 的总时长上限（毫秒），由 onBeforeFire 单条返回、只对即时对话生效。
 *
 * 定时任务那条路仍用库默认的 240s：它到点没跑完还有下一分钟的 cron 接着来，
 * 而用户正盯着「正在输入…」等回复，多给点时间跑完工具循环比让他重发一遍强。
 * 上限压在 cron 的墙钟预算（15 分钟）之内。
 */
export const INSTANT_TOTAL_TIMEOUT_MS = 600_000;

/**
 * 任务认领租期（毫秒）。上游默认是 `max(10 分钟, totalTimeoutMs + 2 分钟)`，
 * 而它算的是全局那个 240s，看不见即时对话单条抬上去的 600s——租约会在 fire 还没
 * 跑完时就过期，下一跳 cron 把同一条又捡起来跑一遍，用户收到两份回复。
 *
 * 所以按即时对话那档显式配一份：600s + 2 分钟。代价是任何一条任务（含定时任务）
 * 中途连 isolate 一起没了之后，要多等 2 分钟才会被别的跳接手。
 */
export const INSTANT_CLAIM_LEASE_MS = INSTANT_TOTAL_TIMEOUT_MS + 120_000;

/** 合成 cron 事件的标记；wrangler tail 里一眼能看出这一跳是谁起的。 */
export const INSTANT_TICK_CRON = 'instant-chat';

// ─── 任务身份 ───

/** 任务 metadata 里标即时对话的那个键（客户端排任务时写、worker 到点读）。 */
export const AMSG_INSTANT_CHAT_FLAG = 'amsgInstantChat';

/** 这条任务是不是即时对话（客户端刚发完消息在等回复）。 */
export const isInstantChatTask = (metadata: Record<string, unknown> | undefined | null): boolean =>
  !!metadata && metadata[AMSG_INSTANT_CHAT_FLAG] === true;

// ─── fire 时追加的「时效信息」块 ───

/**
 * 即时对话的请求消息 = 客户端打包的那串对话原样 + 末尾追加这一块。
 *
 * 追加而不是重渲染模板：这一轮要答的是用户刚说的话，本地生成那条路发出去的是什么，
 * 云端就该发一模一样的，不然同一句话在两条路上会得到两种口吻。时效内容（现在几点、
 * 外面在下雨、还挂着哪些排程）只有到点才知道，所以留到这里补。
 *
 * blocks 里的每一块自带前导空行 / 分隔线（各自的渲染函数已经处理），空串直接跳过。
 */
export const buildInstantTimelyBlock = (args: {
  nowMs: number;
  tz: AmsgTzRef;
  userTzId: string;
  targetName: string;
  /**
   * 角色的「时间感知」开关（tool_pack.timeAwarenessEnabled）。关掉的角色在前台连今天
   * 几号都读不到，云端这条路也一个钟都不给——两条路是同一个开关，不能各行其是。
   * 主动消息那条路的做法一样（打包时时间行整段不进模板，见 activeMsgClient 的 timeAware）。
   */
  timeAwarenessEnabled: boolean;
  /** 其余按顺序拼上去的块：实时世界、自述日志、排程清单、MCP、给自己排下一条。 */
  blocks: string[];
}): string => {
  const blocks = args.blocks.filter((block) => block.trim());
  // 关了时间感知、其余几块又都是空的（没日程没排程没 MCP、实时世界也没拉到）——
  // 这一块就没有任何内容可说了，整块不要。空块整块跳过是这里一贯的做法，只剩一行
  // 光秃秃的标题挂在对话末尾，模型只会当成没说完的乱码。
  if (!args.timeAwarenessEnabled && blocks.length === 0) return '';
  const head = args.timeAwarenessEnabled
    ? [
        '【此刻的系统信息·仅你可见】',
        `现在是 ${formatFireTimeFull(args.nowMs, args.tz)}。`,
        // buildUserClockHint 自带前导换行，没时差时返回空串。
        buildUserClockHint(args.nowMs, args.tz, { tzId: args.userTzId }, args.targetName),
      ].join('\n')
    : '【此刻的系统信息·仅你可见】';
  return [head, ...blocks].join('\n');
};

// ─── 收件兜底 outbox ───

/**
 * 前台可见时别弹系统通知（SW 的 shouldRenderNotification 认这个值）。
 *
 * 用户正盯着聊天窗口等这条回复，锁屏横幅在这时候弹出来纯属打扰——页面自己会把消息
 * 上屏。窗口不可见（切后台、锁屏、关了标签页）时照弹，不然「发完就自由了」这件事
 * 就没人来叫他。判定在 SW 那边按真实的窗口可见性做，worker 只负责表态。
 *
 * 只给即时对话用：主动消息是「到点找人说话」，前台可见时更该弹。
 */
const NOTIFICATION_WHEN_HIDDEN = 'when-hidden';

/**
 * 把定稿的推送载荷补齐成「客户端真正会收到的那一份」。
 *
 * 库在发之前还会补 messageId / sessionId / timestamp / messageIndex / totalMessages
 * 和四个任务身份字段。其中前三个是「没有才补」，所以这里先按库的同一套规则算好写进去，
 * 库那边就会原样沿用——outbox 里留的那份和真发出去的那份于是逐字一致，客户端补收时
 * 按 messageId 对账不会错位。
 *
 * 顺带把 notification.show 表态成 when-hidden（见上）。载荷本来就没有 notification 时
 * 不凭空造一个：SW 拿不到 title / body 只能弹一条空白横幅，而「没有 notification」这件事
 * 本身在 SW 那边有按 messageKind 的默认行为，替它做主只会把默认行为弄坏。
 */
export const finalizeInstantPush = (
  payload: Record<string, unknown>,
  index: number,
  total: number,
  ids: {
    /** 任务行 id（字符串化）；没有时用随机串，跟库的兜底同语义。 */
    taskRowId: string | null;
    taskUuid: string | null;
    occurrenceMs: number;
    nowMs: number;
    randomId: string;
  },
): Record<string, unknown> => {
  const suffix = `@${ids.occurrenceMs}`;
  const messageIdBase = ids.taskRowId != null
    ? `msg_task_${ids.taskRowId}${suffix}`
    : `msg_${ids.randomId}`;
  const sessionId = ids.taskRowId != null
    ? `sess_task_${ids.taskRowId}${suffix}`
    : `sess_${ids.randomId}`;
  const notification = payload.notification;
  const hasNotification = !!notification && typeof notification === 'object' && !Array.isArray(notification);
  return {
    ...payload,
    ...(hasNotification
      ? { notification: { ...(notification as Record<string, unknown>), show: NOTIFICATION_WHEN_HIDDEN } }
      : {}),
    messageId: `${messageIdBase}_hook_${index}`,
    sessionId,
    timestamp: new Date(ids.nowMs).toISOString(),
    messageIndex: index + 1,
    totalMessages: total,
    // 库的 stampTaskIdentity 会原样覆写这四个，写成一样的值只是让 outbox 那份也带上。
    // 任务行 id 在 D1 里是整数，转不出数字就照实报 null，别塞一个 NaN 出去。
    taskId: ids.taskRowId != null && Number.isFinite(Number(ids.taskRowId))
      ? Number(ids.taskRowId)
      : null,
    taskUuid: ids.taskUuid,
    recurrenceType: 'none',
    occurrenceMs: ids.occurrenceMs,
  };
};

/** 定稿后的载荷 → outbox 条目（messageId / sessionId 已经在载荷上了）。 */
export const toOutboxEntries = (
  payloads: Array<Record<string, unknown>>,
  nowMs: number,
): AmsgChatOutboxEntry[] =>
  payloads.map((payload) => ({
    messageId: String(payload.messageId ?? ''),
    sessionId: String(payload.sessionId ?? ''),
    at: nowMs,
    payload,
  }));

/**
 * 把这一轮的产物写进角色的 outbox。**不论 push 发得出去发不出去都写**——
 * push 静默丢失正是它要兜的那件事。
 *
 * best-effort：写不进去不能连累这次发送，只是丢了兜底能力，吼一声。
 */
export const writeChatOutbox = async (
  writeState: ((
    namespace: string,
    entries: Array<{ key: string; value: string | null; updatedAt?: number }>,
  ) => Promise<unknown>) | undefined,
  charId: string,
  current: AmsgChatOutbox | null,
  entries: AmsgChatOutboxEntry[],
): Promise<AmsgChatOutbox | null> => {
  if (typeof writeState !== 'function' || entries.length === 0) return current;
  const next = appendChatOutbox(current, entries);
  try {
    await writeState(amsgStateNamespace(charId), [
      { key: AMSG_CHAT_OUTBOX_KEY, value: JSON.stringify(next) },
    ]);
    return next;
  } catch (error) {
    console.warn('[amsg:instant-chat] outbox 写入失败（这次照常发送，但推送丢了客户端补不回来）', error);
    return current;
  }
};

// ─── POST /instant-chat ───

/** 上游 worker 的两个入口（注入进来只为单测能替身）。 */
export interface InstantChatUpstream {
  fetch(request: Request, env: unknown): Promise<Response>;
  scheduled(event: { scheduledTime: number; cron: string }, env: unknown): Promise<void>;
}

/** CF 给 fetch 的第三个参数，这里只用 waitUntil。 */
export interface InstantChatExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}

interface InstantChatEnv {
  AMSG_SERVER_TOKEN?: string;
  DB?: unknown;
}

/** 只用得上「跑一条带参数的 UPDATE」这一种能力，不为它引 workers-types。 */
type D1RunLike = {
  prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
};

/** 上游的 UUID v4 判定（照抄它的正则，前端拿同一个 X-User-Id 跑两边）。 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 常时比较（照抄上游 constantTimeEqual 的做法）：两边各做一次随机密钥的 HMAC 再逐字节比，
 * 长度和内容都不会从耗时上漏出来。
 */
const constantTimeEqual = async (a: string, b: string): Promise<boolean> => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const da = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(a)));
  const db = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < da.length; i += 1) diff |= da[i] ^ db[i];
  return diff === 0;
};

/** 客户端预加密的信封形状（上游 parseEncryptedBody 认的就是这三个字段）。 */
const isEncryptedEnvelope = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const env = value as Record<string, unknown>;
  return typeof env.iv === 'string'
    && typeof env.authTag === 'string'
    && typeof env.encryptedData === 'string';
};

/**
 * 把刚落库的任务行拉到「此刻到期」。
 *
 * 客户端给的 firstSendTime 必须落在未来（上游校验），而 cron 只捡已经到期的行——
 * 不拉这一下，最快也要等到那个提前量过去才会开跑。next_send_at 是明文列，
 * 拉动它就是这条任务真正的语义：用户已经把话说完了，现在就该答。
 *
 * best-effort：拉不动（D1 抽风、行已被别的跳认领）就返回 false，调用方改成等过
 * 那个时刻再起跳，消息不会丢。
 */
export const pullTaskDue = async (
  db: unknown,
  uuid: string,
  userId: string,
  nowMs: number,
): Promise<boolean> => {
  const d1 = db as D1RunLike | undefined;
  if (typeof d1?.prepare !== 'function') return false;
  const iso = new Date(nowMs).toISOString();
  try {
    await d1
      .prepare(
        `UPDATE scheduled_messages SET next_send_at = ?, updated_at = ?
          WHERE uuid = ? AND user_id = ? AND status = 'pending' AND next_send_at > ?`,
      )
      .bind(iso, iso, uuid, userId, iso)
      .run();
    return true;
  } catch (error) {
    console.warn('[amsg:instant-chat] 任务行拉到期失败（改成等到点再起跳）', error);
    return false;
  }
};

const delay = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `POST /instant-chat` 的处理：鉴权 → 严格顺序转发 → 202 → 立刻起一跳。
 *
 * 顺序不能换：云端状态先落地，任务才允许存在。反过来的话，状态那一步失败时 D1 里
 * 已经躺着一条注定拿旧上下文答话的任务，而且没人拦得住它。
 */
export const handleInstantChat = async (args: {
  request: Request;
  env: InstantChatEnv;
  ctx: InstantChatExecutionCtx | undefined;
  upstream: InstantChatUpstream;
  /** 带 CORS 头的 JSON 响应器（CORS 头只在 index.ts 存一份）。 */
  json: (status: number, body: unknown) => Response;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Response> => {
  const { request, env, ctx, upstream, json } = args;
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? delay;

  const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>) =>
    json(status, { success: false, error: { code, message, ...(extra ?? {}) } });

  // ── 鉴权：跟上游同一套判据。上游转发时还会再验一次（它才是权威），
  //    这里先挡一道是为了「口令不对」时一个字节的云端状态都别写进去。
  const token = (env.AMSG_SERVER_TOKEN ?? '').trim();
  const clientToken = request.headers.get('X-Client-Token') ?? '';
  if (token) {
    if (!clientToken || !(await constantTimeEqual(clientToken, token))) {
      return fail(401, 'INVALID_CLIENT_TOKEN', '共享密钥无效或缺失');
    }
  }
  const userId = request.headers.get('X-User-Id') ?? '';
  if (!userId) return fail(400, 'USER_ID_REQUIRED', '缺少用户标识符');
  if (!UUID_V4_RE.test(userId)) return fail(400, 'INVALID_USER_ID_FORMAT', 'X-User-Id 必须是 UUID v4 格式');

  // ── 外壳是明文 JSON，里头两个信封是客户端加密好的，包装层只搬不看。
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return fail(400, 'INVALID_JSON', '请求体不是合法的 JSON 对象');
  }
  if (!isEncryptedEnvelope(body.statePayload)) {
    return fail(400, 'INVALID_STATE_PAYLOAD', 'statePayload 必须是加密信封（iv / authTag / encryptedData）');
  }
  if (!isEncryptedEnvelope(body.taskPayload)) {
    return fail(400, 'INVALID_TASK_PAYLOAD', 'taskPayload 必须是加密信封（iv / authTag / encryptedData）');
  }
  const supersedesUuid = typeof body.supersedesUuid === 'string' ? body.supersedesUuid.trim() : '';

  // ── 内部转发：路径跟着本次请求的挂载点走（上游按后缀匹配，worker 可能挂在子路径下）。
  const requestUrl = new URL(request.url);
  const mountPath = requestUrl.pathname.replace(/\/+$/, '').replace(/\/instant-chat$/, '');
  const internalUrl = (path: string, search = ''): string => {
    const url = new URL(request.url);
    url.pathname = `${mountPath}${path}`;
    url.search = search;
    return url.toString();
  };
  // 上游自己的头约定原样带上（含客户端给的口令），它会再验一遍。
  const encryptedHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-User-Id': userId,
    'X-Payload-Encrypted': 'true',
    'X-Encryption-Version': '1',
    ...(clientToken ? { 'X-Client-Token': clientToken } : {}),
  };

  const readBody = async (response: Response): Promise<unknown> => {
    try { return await response.json(); } catch { return null; }
  };

  // ① 云端状态必须先落地：这一步失败就绝不落任务（否则任务到点会拿旧上下文答话）。
  const stateResponse = await upstream.fetch(
    new Request(internalUrl('/client-state'), {
      method: 'PUT',
      headers: encryptedHeaders,
      body: JSON.stringify(body.statePayload),
    }),
    env,
  );
  if (!stateResponse.ok) {
    return json(stateResponse.status, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_STATE_FAILED',
        message: '云端状态没传上去，这条没发出去',
        step: 'client-state',
        upstream: await readBody(stateResponse),
      },
    });
  }

  // ② 顶掉上一条还没被认领的任务（连发两条时合并成一起回）。尽力而为：
  //    404（已经跑掉了 / 本来就不存在）一律忽略，它不该拦住这一条。
  //    和 ③ 并行跑：取消的目标是另一行、结果本就不影响主流程，串行 await 只是给
  //    连发场景（正是用户在等的场景）的 202 多背一个上游往返。返回 202 前仍会
  //    等它 settle——立即跳在 202 之后才起，取消先落地的语义不变。
  const cancelPromise = supersedesUuid
    ? (async () => {
      try {
        const cancelled = await upstream.fetch(
          new Request(internalUrl('/cancel-message', `?id=${encodeURIComponent(supersedesUuid)}`), {
            method: 'DELETE',
            headers: {
              'X-User-Id': userId,
              ...(clientToken ? { 'X-Client-Token': clientToken } : {}),
            },
          }),
          env,
        );
        if (!cancelled.ok) {
          console.log('[amsg:instant-chat] 顶替上一条没成（照常继续）', {
            uuid: supersedesUuid, status: cancelled.status,
          });
        }
      } catch (error) {
        console.log('[amsg:instant-chat] 顶替上一条抛错（照常继续）', error);
      }
    })()
    : null;

  // ③ 任务落库 = 受理。到这一步返回 202 之前，行已经在 D1 里了，
  //    下面那一跳只是让它快点跑起来，跑不成还有每分钟的 cron。
  const taskResponse = await upstream.fetch(
    new Request(internalUrl('/schedule-message'), {
      method: 'POST',
      headers: encryptedHeaders,
      body: JSON.stringify(body.taskPayload),
    }),
    env,
  );
  if (cancelPromise) await cancelPromise;
  const taskBody = await readBody(taskResponse);
  if (!taskResponse.ok) {
    return json(taskResponse.status, {
      success: false,
      error: {
        code: 'INSTANT_CHAT_TASK_FAILED',
        message: '任务没建起来，这条没发出去',
        step: 'schedule-message',
        upstream: taskBody,
      },
    });
  }
  const uuid = (taskBody as { data?: { uuid?: unknown } } | null)?.data?.uuid;
  if (typeof uuid !== 'string' || !uuid) {
    return fail(502, 'INSTANT_CHAT_TASK_UUID_MISSING', '上游没有回任务 uuid，无法跟踪这一轮', {
      step: 'schedule-message',
    });
  }

  // ④ 立刻起一跳把它捡走。isolate 被回收就退回 cron 兜底，正确性两头都在。
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil((async () => {
      try {
        const due = await pullTaskDue(env.DB, uuid, userId, now());
        if (!due) await sleep(INSTANT_TICK_FALLBACK_WAIT_MS);
        await upstream.scheduled({ scheduledTime: now(), cron: INSTANT_TICK_CRON }, env);
      } catch (error) {
        // 这一跳只是「快」，跑挂了下一分钟的 cron 照样会捡起来，不该影响已经回出去的 202。
        console.warn('[amsg:instant-chat] 立即触发失败（等 cron 兜底）', error);
      }
    })());
  } else {
    console.warn('[amsg:instant-chat] 运行时没给 ctx，跳过立即触发，等 cron 兜底');
  }

  return json(202, { status: 'accepted', uuid });
};

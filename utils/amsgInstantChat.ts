/**
 * 即时对话（instant chat）的客户端这一半。
 *
 * 一轮聊天在这条路上的样子：按下发送 → 一个 POST 上云（受理即 202）→ 界面挂着
 * 「正在输入…」→ 云端跑完把回复推回来 → 收件箱同一条管线入库、指示灯灭。
 * 客户端发完那一刻就自由了，切后台、杀进程都行。
 *
 * 这份模块管五件事：
 *   1. 开关（唯一门槛在设置页，运行时只读这一份存下来的配置）；
 *   2. 「这一轮还欠着一条回复」的待收记录——它得**扛得住重启**，不然重开 App
 *      指示灯就没了，用户以为消息丢了；
 *   3. 「这一轮还欠着哪几条作废回执」的台账：回执随 chat 段上了云，但要等回复真的
 *      落库才销账，云端整轮失败时它们得退回未告知、下轮重注；
 *   4. 推送丢了的兜底：拉云端 outbox，把没收到的塞回收件箱走原路入库；
 *   5. 收尾：云端点名说这条任务已经失败（或那行已经没了）时，先拉一次 outbox，
 *      还是没有才算这一轮失败、允许重发。等了多久本身不构成结论。
 *
 * 刻意不在这里 flush 收件箱：flushInboxToChat 住在 activeMsgRuntime，那边反过来要用
 * 这里的记录，互相 import 会成环。所以这里只管「写进收件箱」，冲刷由调用方接着做。
 */

import { ActiveMsg2InboxMessage, CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { AMSG_CHAT_OUTBOX_KEY, amsgStateNamespace, parseChatOutbox } from './amsgFirePack';
import { trackEvent } from './analytics';
import { announceEmotionDone } from './chatGenEvents';
import { DB } from './db';
import type { AmsgEmotionEvalSpec } from '../worker/amsg/src/emotionEval';

const HEADER = '[AmsgInstantChat]';

/** 还欠着回复时，前台每隔这么久去云端点名问一次任务状态。不到明确报错不放弃。 */
export const INSTANT_CHAT_STATUS_CHECK_INTERVAL_MS = 60_000;

/** 待收记录的落盘位置。存 localStorage 而不是内存：重启后指示灯要还在。 */
export const AMSG_INSTANT_CHAT_PENDING_LS_KEY = 'amsg2_instant_chat_pending';

/** 待收记录变动时广播；Chat 界面据此点亮/熄灭「正在输入…」。detail 只带 charId。 */
export const AMSG_INSTANT_CHAT_PENDING_EVENT = 'amsg-instant-chat-pending';

export interface AmsgInstantChatPending {
  charId: string;
  /** 这一轮在云端那条任务的 uuid；连发下一条时用它顶掉未认领的这条。 */
  uuid: string;
  /** 受理时刻（epoch ms），排查时看「这一轮等了多久」用。 */
  acceptedAt: number;
  /** 角色名快照（全局横幅显示用）。必填：唯一写入方恒定带上（角色名为空就是空串）。 */
  charName: string;
}

type PendingMap = Record<string, AmsgInstantChatPending>;

const readPendingMap = (): PendingMap => {
  try {
    const parsed = JSON.parse(localStorage.getItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: PendingMap = {};
    for (const [charId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as Partial<AmsgInstantChatPending> | null;
      if (record && typeof record.uuid === 'string' && typeof record.acceptedAt === 'number') {
        // charName 的形状防御是「防 localStorage 损坏/手改」，不是兼容什么旧记录——
        // 这个 key 与写入方同一次发布上线，缺名就按空串补齐。
        result[charId] = {
          charId,
          uuid: record.uuid,
          acceptedAt: record.acceptedAt,
          charName: typeof record.charName === 'string' ? record.charName : '',
        };
      }
    }
    return result;
  } catch {
    return {};
  }
};

const writePendingMap = (map: PendingMap) => {
  // 存储满 / 隐私模式写不进去就算了：指示灯没了比整轮聊天挂掉好。
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY);
    else localStorage.setItem(AMSG_INSTANT_CHAT_PENDING_LS_KEY, JSON.stringify(map));
  } catch { /* 见上 */ }
};

const announcePendingChanged = (charId: string) => {
  try {
    window.dispatchEvent(new CustomEvent(AMSG_INSTANT_CHAT_PENDING_EVENT, { detail: { charId } }));
  } catch { /* SSR / 单测环境没有 window */ }
};

/** 这个角色此刻还欠着一条云端回复吗（没有 = null）。 */
export const getInstantChatPending = (charId: string): AmsgInstantChatPending | null =>
  readPendingMap()[charId] ?? null;

export const listInstantChatPendings = (): AmsgInstantChatPending[] => Object.values(readPendingMap());

/** 受理成功后记一笔。同角色只留最新一条——顶替之后旧 uuid 已经没人认领了。 */
export const setInstantChatPending = (
  charId: string,
  uuid: string,
  acceptedAt = Date.now(),
  charName = '',
): void => {
  const map = readPendingMap();
  map[charId] = { charId, uuid, acceptedAt, charName };
  writePendingMap(map);
  announcePendingChanged(charId);
};

/** 回复到了（或这一轮判定失败）→ 销账。没有记录时是幂等 no-op。 */
export const clearInstantChatPending = (charId: string): boolean => {
  const map = readPendingMap();
  if (!map[charId]) return false;
  delete map[charId];
  writePendingMap(map);
  announcePendingChanged(charId);
  return true;
};

// ─── 随这一轮上云的作废回执 ───

/**
 * 防穿帮闸作废掉的任务，要在下一轮聊天里告诉角色一声（「那条任务没了」）。这些回执
 * 随即时对话的 chat 段冻进云端那一轮，但**回复真的落库之前不能销账**：云端整轮失败
 * （模型空输出被判 skip-push、fire 重试打光）时回执不会重来，角色永远不知道自己许下
 * 的那件事已经作废，既不会续期也不会解释。
 *
 * 所以这里只是个「这一轮欠着哪几条回执」的台账，落 localStorage（跨得过刷新，
 * 云端那一轮本来就可能横跨一次重启）。真正销账（写 notifiedAt）由落库那一侧点名调
 * settleInstantChatExpiredNotices；判定失败走 discard，回执退回未告知、下轮重注。
 */
export const AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY = 'amsg2_instant_chat_staged_notices';

interface StagedNotices {
  charId: string;
  /** 这些回执跟着云端哪一轮走的。销账时对不上就不动——那是上一轮的账。 */
  uuid: string;
  ids: string[];
}

type StagedNoticesMap = Record<string, StagedNotices>;

const readStagedNotices = (): StagedNoticesMap => {
  try {
    const parsed = JSON.parse(localStorage.getItem(AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: StagedNoticesMap = {};
    for (const [charId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const record = value as Partial<StagedNotices> | null;
      if (record && typeof record.uuid === 'string' && Array.isArray(record.ids)) {
        const ids = record.ids.filter((id): id is string => typeof id === 'string' && !!id);
        if (ids.length) result[charId] = { charId, uuid: record.uuid, ids };
      }
    }
    return result;
  } catch {
    return {};
  }
};

const writeStagedNotices = (map: StagedNoticesMap) => {
  // 写不进去（存储满 / 隐私模式）就当这一轮没记：回执会在下一轮重新注入，不会丢。
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY);
    else localStorage.setItem(AMSG_INSTANT_CHAT_STAGED_NOTICES_LS_KEY, JSON.stringify(map));
  } catch { /* 见上 */ }
};

/**
 * 记一笔「这几条回执跟着 uuid 这一轮上云了，还没销账」。同角色只留最新一轮：
 * 连发时新那一轮会把老回执连同新的一起重新注入（它们还没被标记告知过）。
 */
export const stageInstantChatExpiredNotices = (charId: string, uuid: string, ids: string[]): void => {
  const kept = ids.filter(Boolean);
  const map = readStagedNotices();
  if (kept.length === 0) delete map[charId];
  else map[charId] = { charId, uuid, ids: kept };
  writeStagedNotices(map);
};

/** 这个角色此刻欠着哪一轮的哪几条回执（没有 = null）。排查和测试用。 */
export const getStagedInstantChatExpiredNotices = (charId: string): StagedNotices | null =>
  readStagedNotices()[charId] ?? null;

/** 从台账里取出并删掉这一轮的记录；uuid 对不上（已经是新一轮了）返回空数组、不动记录。 */
const popStagedNotices = (charId: string, uuid?: string): string[] => {
  const map = readStagedNotices();
  const record = map[charId];
  if (!record) return [];
  if (uuid && record.uuid !== uuid) return [];
  delete map[charId];
  writeStagedNotices(map);
  return record.ids;
};

/**
 * 这一轮的回复真的落库了 → 把随它上云的作废回执销账（写 notifiedAt，下轮不再注入）。
 *
 * **由落库那一侧调**：即时对话的回复是走推送、经收件箱冲刷管线进 DB 的，销账时机只有
 * 那边知道（activeMsgRuntime 认末段到齐、销掉待收记录的同一处）。uuid 传这一轮的
 * taskUuid，对不上就什么都不做——那是上一轮的账，销掉等于把新一轮的回执也吞了。
 *
 * 返回真正销掉的 id（没有可销的返回空数组）。写库失败只 warn：台账已经取走，
 * 最坏情况是这几条回执下轮再说一遍，比反复销不掉卡住整条路强。
 */
export const settleInstantChatExpiredNotices = async (charId: string, uuid?: string): Promise<string[]> => {
  const ids = popStagedNotices(charId, uuid);
  if (ids.length === 0) return [];
  try {
    await ActiveMsgStore.markExpiredNoticesNotified(charId, ids);
  } catch (error) {
    console.warn(`${HEADER} 作废回执销账失败（下一轮会再说一遍）`, { charId, ids, error });
  }
  return ids;
};

/** 这一轮没成 → 台账作废、回执退回「未告知」，下一轮重新注入（回执不丢）。 */
export const discardInstantChatExpiredNotices = (charId: string, uuid?: string): string[] =>
  popStagedNotices(charId, uuid);

// ─── 开关 ───

/**
 * ready=false 时卡在哪一道。两档不是「用户没开」，调用方要分开收场：
 *   config-unreadable  这一刻问不出来（明确报错等重发，绝不悄悄退回本地）
 *   worker-outdated    开着，但那台 Worker 跑不动（退回本地生成，且必须留痕）
 */
export type InstantChatReadinessReason =
  | 'disabled'
  | 'char-disabled'
  | 'no-worker-url'
  | 'worker-outdated'
  | 'config-unreadable';

export interface InstantChatReadiness {
  ready: boolean;
  reason?: InstantChatReadinessReason;
}

/**
 * 即时对话此刻走不走得通，外加「走不通是因为什么」。
 *
 * 门槛四道：角色没单独关（传了 char 才查）、设置页开了、那台 Worker 跑得动、Worker
 * 地址填着。
 *
 * 「跑得动」读的是**存量**（config.instantChatSupported），不是现探——这里现探的话每发
 * 一条消息都要多一次网络往返，而且探测失败时到底算「不支持」还是「网络抖了一下」没有
 * 正确答案。存量由 probeInstantChatSupport 每次探测时刷新（设置页打开时、握手时各一次），
 * 用户更新完 Worker 会自己翻回来，不用手动重开开关。undefined = 还没探过，放行——那一
 * 档说明我们不知道，不是知道它不行。
 *
 * 为什么这道门非要有：跑不动的 Worker 上这条路是**发一条挂一条**（老 bundle 被 waitUntil
 * 砍在 30 秒，新 bundle 少了起跳器则直接 503），而开关还写着「已开启」。让位给本地生成
 * 顶多是少一个后台能力，比让用户对着「正在输入」干等强。
 *
 * 配置读不出来（IndexedDB 被别的标签页 versionchange 卡住、iOS 存储压力…）单独成一档：
 * 它不等于「用户没开」。当成没开的话这一轮会悄悄退回本地直连生成——用户按完发送随手
 * 锁屏，本地 fetch 被系统掐掉，回来时既没有回复也没有报错，设置页还写着「已开启」。
 * 所以这里就地 warn 一声，调用方按这个 reason 单独收场（useChatAI 里这一档会留一条
 * trace，并且明确报错等用户重发，不发起本地生成）。
 */
export const resolveInstantChatReadiness = async (
  char?: Pick<CharacterProfile, 'activeMsg2Config'>,
): Promise<InstantChatReadiness> => {
  // 角色自己关了 → 这一轮回到本地前台生成。这是用户的主动选择，跟「全局没开」同一
  // 待遇：静默走本地，不 warn 不留 trace。undefined = 跟随全局默认开，只认显式 false；
  // 全局配置都不用读——读出什么这一轮都不上云。
  if (char?.activeMsg2Config?.instantChatEnabled === false) {
    return { ready: false, reason: 'char-disabled' };
  }
  let config: Awaited<ReturnType<typeof ActiveMsgStore.getGlobalConfig>>;
  try {
    config = await ActiveMsgStore.getGlobalConfig();
  } catch (error) {
    console.warn(`${HEADER} 全局配置读不出来，这一轮判断不了即时对话开没开（按走不通处理，但这不是「没开」）`, error);
    return { ready: false, reason: 'config-unreadable' };
  }
  if (!config.instantChatEnabled) return { ready: false, reason: 'disabled' };
  // 地址排在能力前面：没填地址时那份能力位多半是上一台 Worker 留下的存量，
  // 报「Worker 太旧」会把人指去点一个根本没连上的东西。
  if (!config.workerUrl?.trim()) return { ready: false, reason: 'no-worker-url' };
  // 开着、地址也在，但那台 Worker 上这条路是坏的。静默让位正是「静默分流」那个老坑，
  // 所以就地 warn 一声，调用方还会额外留一条 trace——用户至少查得到「为什么开了却走本地」。
  if (config.instantChatSupported === false) {
    console.warn(`${HEADER} 开关是开的，但那台 Worker 跑不动即时对话（缺起跳器或还是旧 bundle）：这一轮本地生成。去设置页点「更新 Worker」`);
    return { ready: false, reason: 'worker-outdated' };
  }
  return { ready: true };
};

/** 只关心「走不走得通」的调用点用这个（设置页的互斥门）。要区分原因走上面那个。 */
export const isInstantChatReady = async (): Promise<boolean> =>
  (await resolveInstantChatReadiness()).ready;

// ─── 发这一轮 ───

// POST /instant-chat 在飞（发出到 202 之间）的角色。待收记录要等 202 才写，而挂起
// fire_pack 常规上传的那道挡板（amsgStateSync）原本只认待收记录——慢网上传几 MB 的
// 那几秒里，别处打脏触发的常规包（没有 chat 段）可能晚于 POST 内部那次 client-state
// 写入落地，把带 chat 段的包盖掉，worker 到点只会硬失败。所以从按下发送那一刻起就
// 占位，挡板认「占位或待收」，202 后由待收记录接棒，失败则释放。
const inFlightSends = new Set<string>();

/** POST /instant-chat 正在飞（还没等到 202/失败）吗。amsgStateSync 的挂起挡板用。 */
export const isInstantChatSendInFlight = (charId: string): boolean => inFlightSends.has(charId);

export interface InstantChatSendResult {
  ok: boolean;
  uuid?: string;
  /** 失败时给用户看的整句（已经是能照着做的话）。 */
  error?: string;
}

/**
 * 把这一轮交给云端。**只有 202 才算发出去**，别的一律 ok:false，由调用方明确报错、
 * 允许重发，绝不悄悄退回本地生成。
 *
 * 连发两条时带上一条还没销账的 uuid：包装层会尽力取消那条未认领的任务，两句话合成
 * 一次回复。上一条已经在跑了（取消不掉）也不影响这一条，最多两句相近的回复。
 */
export const sendInstantChatTurn = async (params: {
  char: CharacterProfile;
  chatMessages: Array<{ role: string; content: unknown }>;
  /** 本地生成这一轮会用的凭据（effectiveApi），云端必须用同一份。 */
  api: { baseUrl: string; apiKey: string; model: string };
  /** 本地这一轮会发的采样温度；开思考时本地不发温度，这里也就不传。 */
  temperature?: number;
  maxTokens?: number;
  /**
   * 本地这一轮会额外塞进请求体的字段（现在只有思考链那三件：thinking /
   * reasoning_effort / extra_body，见 useChatAI 的 shouldSendThinkingParams 分支）。
   * 原样带给 worker 展开——云端发出去的请求体必须和本地一字不差，不然开思考的
   * 角色一开即时对话心象卡片就静默消失。不传就是本地也不发。
   */
  extraBody?: Record<string, unknown>;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
  /**
   * 这一轮的情绪评估，一起交给云端跑（提示词模板 + 副 API 凭据）。
   * 不传就是这一轮不评估（角色没开情绪评估 / 本轮跳过）。
   */
  emotionEval?: AmsgEmotionEvalSpec;
}): Promise<InstantChatSendResult> => {
  const supersedes = getInstantChatPending(params.char.id);
  inFlightSends.add(params.char.id);
  try {
    const { uuid } = await ActiveMsgClient.sendInstantChat({
      char: params.char,
      chatMessages: params.chatMessages,
      api: params.api,
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(params.maxTokens ? { maxTokens: params.maxTokens } : {}),
      ...(params.extraBody ? { extraBody: params.extraBody } : {}),
      userProfile: params.userProfile,
      groups: params.groups,
      realtimeConfig: params.realtimeConfig,
      ...(params.emotionEval ? { emotionEval: params.emotionEval } : {}),
      ...(supersedes ? { supersedesUuid: supersedes.uuid } : {}),
    });
    // 先记待收再释放占位（finally），挡板的两个信号无缝交接，不留「都不认」的空窗。
    setInstantChatPending(params.char.id, uuid, Date.now(), params.char.name);
    return { ok: true, uuid };
  } catch (error: any) {
    // 只报失败、只有事件名（跟送达端那几条同一条口径）：失败原因里带着 HTTP 状态和
    // 上游报文，不进上报。用户侧同一时刻已经有明确的报错提示，这里只记「发生过」。
    trackEvent('即时对话发送失败');
    return { ok: false, error: error?.message || String(error) };
  } finally {
    inFlightSends.delete(params.char.id);
  }
};

// ─── 推送丢了的兜底：拉 outbox ───

// 正在冲刷管线里处理中的收件箱消息（先 ack 后处理的那几秒，它们既不在收件箱也不在
// 聊天记录）。对账时并进「已收」，不然拟人打字延迟期间撞上 60s 点名，同一条会被
// 当成「没收到」二次入库。登记/撤销由 activeMsgRuntime 的 flush 管线负责。
const inFlightInboxIds = new Set<string>();

export const trackInFlightInboxMessageIds = (ids: string[]): void => {
  for (const id of ids) if (id) inFlightInboxIds.add(id);
};

export const untrackInFlightInboxMessageIds = (ids: string[]): void => {
  for (const id of ids) inFlightInboxIds.delete(id);
};

/**
 * 云端那份推送副本 → 收件箱记录。
 *
 * 字段映射必须和 SW 收到真推送时写的那一份一致（worker/sw-keep-alive.ts 的
 * saveContentToInbox），否则同一条消息经两条路进来会长得不一样：时间戳口径、
 * 多段等齐守卫、防穿帮闸读的全是这些字段。
 */
export const chatOutboxPayloadToInbox = (
  payload: Record<string, any>,
  receivedAt: number,
): ActiveMsg2InboxMessage | null => {
  const charId = payload?.metadata?.charId;
  if (typeof charId !== 'string' || !charId) return null;
  const body = String(payload?.message || payload?.body || '').trim();
  const notificationBody = typeof payload?.notification?.body === 'string'
    ? payload.notification.body.trim()
    : '';
  const parsedSentAt = payload?.timestamp ? new Date(payload.timestamp).getTime() : NaN;
  return {
    messageId: String(payload?.messageId || `${charId}-outbox-${receivedAt}`),
    charId,
    charName: payload?.contactName || payload?.metadata?.charName || '主动消息',
    body,
    previewBody: notificationBody || body,
    avatarUrl: payload?.avatarUrl,
    source: payload?.source,
    messageType: payload?.messageType,
    messageSubtype: payload?.messageSubtype,
    taskId: payload?.taskId ?? null,
    taskUuid: payload?.taskUuid ?? null,
    recurrenceType: payload?.recurrenceType ?? null,
    occurrenceMs: payload?.occurrenceMs ?? null,
    metadata: {
      ...(payload?.metadata || {}),
      sessionId: payload?.sessionId,
      messageIndex: payload?.messageIndex,
      totalMessages: payload?.totalMessages,
      // 走到这里 = 真推送没送到、从云端副本捡回来的。销账那边靠它决定要不要顺手
      // 取消还挂在重试队列里的任务行（正常送达的路没这个标记，一个多余请求不发）。
      // SW 那份映射（saveContentToInbox）刻意没有这个键：它只在补收路径为真。
      amsgOutboxBackfill: true,
    },
    sentAt: Number.isFinite(parsedSentAt) ? parsedSentAt : receivedAt,
    receivedAt,
  };
};

/**
 * 这个角色已经收过哪些 messageId。
 *
 * 两处都要看，缺一条就会重复上屏：
 *   - 聊天记录里落过的（后处理管线把 push 的 messageId 抄进了 metadata.activeMsg2，
 *     降级存原稿那条路也一样）——**它就是重启后仍然作数的那份账**；
 *   - 收件箱里还没冲刷的（推送刚到、这一刻正排队）。
 *
 * 用现成的数据对账、不另攒一份「已收 id」缓存：缓存会和真实落库情况漂移，而漂移的
 * 那一侧恰好是「以为收过、其实没有」——消息就此永久丢失。
 */
const collectReceivedMessageIds = async (charId: string): Promise<Set<string>> => {
  const seen = new Set<string>();
  try {
    for (const message of await DB.getRecentMessagesByCharId(charId, 200)) {
      const id = (message.metadata as any)?.activeMsg2?.messageId;
      if (typeof id === 'string' && id) seen.add(id);
    }
  } catch (error) {
    // 读不到近史就没法对账。宁可这次不补收（下次还会再拉），也别把已经上过屏的再放一遍。
    console.warn(`${HEADER} 读聊天记录失败，这次跳过补收`, error);
    throw error;
  }
  try {
    for (const message of await ActiveMsgStore.listInboxMessages()) {
      if (message.charId === charId) seen.add(message.messageId);
    }
  } catch (error) {
    console.warn(`${HEADER} 读收件箱失败（只按聊天记录对账）`, error);
  }
  // 冲刷管线正处理中的那批（先 ack 后处理的空窗）也算已收。
  for (const id of inFlightInboxIds) seen.add(id);
  return seen;
};

/**
 * 拉一次这个角色的 outbox，把没收到的写进收件箱。返回补收了几条；
 * **对不了账时返回 null**（云端 outbox 读失败，或 outbox 里有东西但本地近史读不出来）。
 * 「没读到」和「读到了、确实没有」是两个结论：调用方要拿它下「回复取不回」的判决时
 * 只能认后者——catch 不许直接变成送达判定（docs/instant-push-dual-channel.md 那条铁律）。
 *
 * 只对账**指定轮次**的条目（opts.uuids，缺省 = 这个角色当前欠着的那一轮）：outbox 是
 * 跨轮保留的环形数组，旧轮的条目永远躺在里面——不按轮过滤的话，被用户重 roll / 手动
 * 删掉的回复会因为「本地查无此 id」被判成没收到、原样复活。没有目标轮直接返回 0，
 * 连近史对账都不用跑。
 *
 * 调用方拿到 >0 之后要自己 flush 一次收件箱（见文件头注：不在这里 flush 是为了避免
 * 和 activeMsgRuntime 成环）。
 */
export const drainChatOutboxForChar = async (
  charId: string,
  opts?: { uuids?: string[] },
): Promise<number | null> => {
  const targetUuids = new Set(
    opts?.uuids ?? (getInstantChatPending(charId) ? [getInstantChatPending(charId)!.uuid] : []),
  );
  if (targetUuids.size === 0) return 0;

  let raw: string | null;
  try {
    raw = await ActiveMsgClient.readClientStateValue(amsgStateNamespace(charId), AMSG_CHAT_OUTBOX_KEY);
  } catch (error) {
    console.warn(`${HEADER} 读云端 outbox 失败（这次没补收）`, { charId, error });
    return null;
  }
  const outbox = parseChatOutbox(raw);
  if (!outbox || outbox.entries.length === 0) return 0;

  const candidates = outbox.entries.filter((entry) => {
    const uuid = (entry.payload as Record<string, any>)?.taskUuid;
    return typeof uuid === 'string' && targetUuids.has(uuid);
  });
  if (candidates.length === 0) return 0;

  let seen: Set<string>;
  try {
    seen = await collectReceivedMessageIds(charId);
  } catch {
    // outbox 里有条目、但本地近史读不出来——分不清哪条是新的，宁可这次不补收，
    // 也不重复上屏。对外同样报 null：这时说「outbox 里没有」一样站不住。
    return null;
  }

  const missing = candidates.filter((entry) => entry.messageId && !seen.has(entry.messageId));
  if (missing.length === 0) return 0;

  const now = Date.now();
  let written = 0;
  for (const entry of missing) {
    const message = chatOutboxPayloadToInbox(entry.payload as Record<string, any>, now);
    if (!message) continue;
    try {
      await ActiveMsgStore.saveInboxMessage(message);
      written += 1;
    } catch (error) {
      console.warn(`${HEADER} 补收写入收件箱失败`, { messageId: entry.messageId, error });
    }
  }
  if (written > 0) console.log(`${HEADER} 从 outbox 补收 ${written} 条（推送多半是丢了）`, { charId });
  return written;
};

/** 所有还欠着回复的角色各拉一次。没有待收记录时一个请求都不发。 */
export const drainChatOutboxForPending = async (): Promise<number> => {
  const pendings = listInstantChatPendings();
  if (pendings.length === 0) return 0;
  let written = 0;
  // 串行：并发拉会同时开多条连接读 IndexedDB 近史，正是 instant push 那次超时的连接风暴成因。
  for (const pending of pendings) {
    // 批量拉是尽力而为（冷启动 / 回前台），单个角色对不了账（null）当 0 记；
    // 要按「读没读成」下结论的地方走的是单角色那条（runInstantChatStatusCheck）。
    written += (await drainChatOutboxForChar(pending.charId)) ?? 0;
  }
  return written;
};

/**
 * 这一轮收尾成「没等到回复」：销账 + 在聊天流里留一条说明。
 *
 * 只在云端给了明确结论之后调（任务行已失败 / 行没了而 outbox 里也没有），所以这里
 * 不再去 cancel 那条任务——失败的行不会再跑，没了的行也没什么可取消的。
 *
 * `uuid` 是这个结论说的是哪一轮，**必传**：从查到结论到落这条说明之间隔着网络往返
 * （查失败原因要去云端点名读一份 chat_fail 留痕），这期间用户完全可能
 * 又发了一条，待收记录已经换成新的 uuid 了。不认 uuid 就动手的话，销掉的是新那一轮
 * 的账——「正在输入」当场熄灭，聊天流里还多一条它其实没失败的说明。对不上就直接走人，
 * 让新那一轮自己走完它的判定。
 *
 * `reason` 是云端记下的失败原因（有就带给用户看）。沿用本地路径失败时那条系统消息的
 * 形态（`[…]` 的方括号系统消息），用户能直接看到发生了什么、也知道可以重发。
 * 写库失败只 warn——指示灯该灭还是得灭。
 */
export const failInstantChatPending = async (
  charId: string,
  uuid: string,
  reason?: string,
): Promise<void> => {
  if (getInstantChatPending(charId)?.uuid !== uuid) return;
  if (!clearInstantChatPending(charId)) return;
  // 这一轮随 chat 段上云的作废回执跟着作废：没销账 = 还是「未告知」，下一轮会重新
  // 注入。销掉的话角色永远不知道那条任务被作废过，聊天里许下的承诺就这么没了。
  discardInstantChatExpiredNotices(charId, uuid);
  // 「情绪更新中」那盏灯也在这里熄。
  //
  // 平时它的熄灭信号搭在最后一条回复的推送上（metadata.amsgEmotionDone，见
  // activeMsgRuntime 收侧）。可这一轮要是一条推送都没有——模型空输出/纯拒答被 worker
  // 判成 skip-push，或者整条 fire 硬失败——那个信号永远不会到，灯只能干等十来分钟的
  // 安全网（useChatAI 的 cloudEvalTimeoutMs，按 worker fire 上限推导），中途还会弹一句
  // 「worker 可能是旧版」的误导提示。云端已经点名说这一轮没成，就是最确定的熄灯时机。
  //
  // 派在写库之前：写库失败只 warn，灯不该被它连累（同上面那句注释的口径）。
  announceEmotionDone(charId);
  // 只报失败、只有事件名：云端点名说这一轮没成（或回复取不回来）。这一格涨起来说明
  // 云端生成或推送链路在掉队，比用户来报「一直在输入」早得多。
  trackEvent('即时对话云端任务失败');
  try {
    await DB.saveMessage({
      charId,
      role: 'system',
      type: 'text',
      content: reason
        ? `[即时对话没能完成：${reason}。可以重新发一次。]`
        : '[即时对话没能完成：云端已处理这条消息，但回复没能取回（推送和云端副本都没拿到）。可以重新发一次。]',
    });
    window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId } }));
  } catch (error) {
    console.warn(`${HEADER} 失败说明写入失败`, { charId, error });
  }
};

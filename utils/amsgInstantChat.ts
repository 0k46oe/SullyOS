/**
 * 即时对话（instant chat）的客户端这一半。
 *
 * 一轮聊天在这条路上的样子：按下发送 → 一个 POST 上云（受理即 202）→ 界面挂着
 * 「正在输入…」→ 云端跑完把回复推回来 → 收件箱同一条管线入库、指示灯灭。
 * 客户端发完那一刻就自由了，切后台、杀进程都行。
 *
 * 这份模块管四件事：
 *   1. 开关（唯一门槛在设置页，运行时只读这一份存下来的配置）；
 *   2. 「这一轮还欠着一条回复」的待收记录——它得**扛得住重启**，不然重开 App
 *      指示灯就没了，用户以为消息丢了；
 *   3. 推送丢了的兜底：拉云端 outbox，把没收到的塞回收件箱走原路入库；
 *   4. 收尾：云端点名说这条任务已经失败（或那行已经没了）时，先拉一次 outbox，
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
import { DB } from './db';

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
        result[charId] = { charId, uuid: record.uuid, acceptedAt: record.acceptedAt };
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
export const setInstantChatPending = (charId: string, uuid: string, acceptedAt = Date.now()): void => {
  const map = readPendingMap();
  map[charId] = { charId, uuid, acceptedAt };
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

// ─── 开关 ───

/**
 * 即时对话此刻走不走得通：设置页开了、而且 Worker 地址填着。
 *
 * 版本门槛（worker 支不支持这个端点）只在设置页那一处探测——开发期规矩是门槛只留一处，
 * 不做逐调用 capability 预检。这里再探一次的话，每发一条消息都要多一次网络往返，
 * 而且探测失败时到底算「不支持」还是「网络抖了一下」没有正确答案。
 */
export const isInstantChatReady = async (): Promise<boolean> => {
  try {
    const config = await ActiveMsgStore.getGlobalConfig();
    return !!config.instantChatEnabled && !!config.workerUrl?.trim();
  } catch {
    return false;
  }
};

// ─── 发这一轮 ───

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
  maxTokens?: number;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig: RealtimeConfig;
}): Promise<InstantChatSendResult> => {
  const supersedes = getInstantChatPending(params.char.id);
  try {
    const { uuid } = await ActiveMsgClient.sendInstantChat({
      char: params.char,
      chatMessages: params.chatMessages,
      api: params.api,
      ...(params.maxTokens ? { maxTokens: params.maxTokens } : {}),
      userProfile: params.userProfile,
      groups: params.groups,
      realtimeConfig: params.realtimeConfig,
      ...(supersedes ? { supersedesUuid: supersedes.uuid } : {}),
    });
    setInstantChatPending(params.char.id, uuid);
    return { ok: true, uuid };
  } catch (error: any) {
    // 只报失败、只有事件名（跟送达端那几条同一条口径）：失败原因里带着 HTTP 状态和
    // 上游报文，不进上报。用户侧同一时刻已经有明确的报错提示，这里只记「发生过」。
    trackEvent('即时对话发送失败');
    return { ok: false, error: error?.message || String(error) };
  }
};

// ─── 推送丢了的兜底：拉 outbox ───

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
  return seen;
};

/**
 * 拉一次这个角色的 outbox，把没收到的写进收件箱。返回补收了几条。
 *
 * 调用方拿到 >0 之后要自己 flush 一次收件箱（见文件头注：不在这里 flush 是为了避免
 * 和 activeMsgRuntime 成环）。
 */
export const drainChatOutboxForChar = async (charId: string): Promise<number> => {
  let raw: string | null;
  try {
    raw = await ActiveMsgClient.readClientStateValue(amsgStateNamespace(charId), AMSG_CHAT_OUTBOX_KEY);
  } catch (error) {
    console.warn(`${HEADER} 读云端 outbox 失败（这次没补收）`, { charId, error });
    return 0;
  }
  const outbox = parseChatOutbox(raw);
  if (!outbox || outbox.entries.length === 0) return 0;

  let seen: Set<string>;
  try {
    seen = await collectReceivedMessageIds(charId);
  } catch {
    return 0;
  }

  const missing = outbox.entries.filter((entry) => entry.messageId && !seen.has(entry.messageId));
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
    written += await drainChatOutboxForChar(pending.charId);
  }
  return written;
};

/**
 * 这一轮收尾成「没等到回复」：销账 + 在聊天流里留一条说明。
 *
 * 只在云端给了明确结论之后调（任务行已失败 / 行没了而 outbox 里也没有），所以这里
 * 不再去 cancel 那条任务——失败的行不会再跑，没了的行也没什么可取消的。
 *
 * `reason` 是云端记下的失败原因（有就带给用户看）。沿用本地路径失败时那条系统消息的
 * 形态（`[…]` 的方括号系统消息），用户能直接看到发生了什么、也知道可以重发。
 * 写库失败只 warn——指示灯该灭还是得灭。
 */
export const failInstantChatPending = async (charId: string, reason?: string): Promise<void> => {
  if (!clearInstantChatPending(charId)) return;
  // 只报失败、只有事件名：云端点名说这一轮没成（或回复取不回来）。这一格涨起来说明
  // 云端生成或推送链路在掉队，比用户来报「一直在输入」早得多。
  trackEvent('即时对话云端任务失败');
  try {
    await DB.saveMessage({
      charId,
      role: 'system',
      type: 'text',
      content: reason
        ? `[即时对话失败：云端报告 ${reason}。可以重新发一次。]`
        : '[即时对话失败：云端已处理这条消息，但回复没能取回（推送和云端副本都没拿到）。可以重新发一次。]',
    });
    window.dispatchEvent(new CustomEvent('active-msg-progress', { detail: { charId } }));
  } catch (error) {
    console.warn(`${HEADER} 失败说明写入失败`, { charId, error });
  }
};

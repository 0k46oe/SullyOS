/**
 * 主动消息 2.0「满血」的前端状态同步层。
 *
 * 一轮聊完时 useChatAI 调 markAmsgStateDirty 打脏标记（带拼模板所需的数据快照），
 * 去抖后把所有脏角色的 fire_pack 批量上传 worker 的 client_state；切后台
 * （visibilitychange→hidden）立即冲刷——iOS 只给几秒存活窗口，必须一次请求写完。
 *
 * 只对「已排程 AI 模式 amsg2 任务」的角色生效，其余 markDirty 直接忽略。
 * 上传失败只 warn 不重试：任务里始终冻结着排程时的 completePrompt，worker 读不到
 * 云端状态就走老链路，功能不缺、只是上下文停在排程那一刻。
 */

import { CharacterProfile, GroupProfile, RealtimeConfig, UserProfile } from '../types';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { hasActiveAiTask } from './amsg2Tasks';
import { AmsgChatPresence, CHAT_PRESENCE_HEARTBEAT_MS } from './amsgChatPresence';

const SYNC_DEBOUNCE_MS = 15_000;
const HEADER = '[AmsgStateSync]';

export interface AmsgSyncSnapshot {
  char: CharacterProfile;
  userProfile: UserProfile;
  groups: GroupProfile[];
  realtimeConfig?: RealtimeConfig;
}

// charId → 最新快照。同角色多轮聊天只留最后一份，flush 永远用最新状态拼模板。
const dirty = new Map<string, AmsgSyncSnapshot>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let lifecycleBound = false;

const bindLifecycleListener = () => {
  if (lifecycleBound || typeof document === 'undefined') return;
  lifecycleBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && dirty.size > 0) {
      void flushAmsgState('hidden');
    }
  });
};

/** 一轮聊完（或角色资料变更后）打脏标记；非 amsg2 AI 任务角色直接忽略。 */
export const markAmsgStateDirty = (snapshot: AmsgSyncSnapshot) => {
  const config = snapshot.char.activeMsg2Config;
  if (!config?.enabled || !hasActiveAiTask(config)) return;

  dirty.set(snapshot.char.id, snapshot);
  bindLifecycleListener();
  if (debounceTimer != null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { void flushAmsgState('debounce'); }, SYNC_DEBOUNCE_MS);
};

/** 把所有脏角色的 fire_pack 批量上传。失败静默（冻结 prompt 兜底），不清回 dirty 防止重试轰炸。 */
export const flushAmsgState = async (reason: string): Promise<void> => {
  if (flushing || dirty.size === 0) return;
  if (debounceTimer != null) { clearTimeout(debounceTimer); debounceTimer = null; }
  flushing = true;
  try {
    const globalConfig = await ActiveMsgStore.getGlobalConfig();
    if (!globalConfig.workerUrl?.trim()) {
      dirty.clear();
      return;
    }

    const batch = [...dirty.values()];
    dirty.clear();
    await ActiveMsgClient.syncCharFirePacks(batch.map((snapshot) => ({
      char: snapshot.char,
      config: snapshot.char.activeMsg2Config!,
      userProfile: snapshot.userProfile,
      groups: snapshot.groups,
      realtimeConfig: snapshot.realtimeConfig,
    })));
  } catch (error) {
    console.warn(`${HEADER} flush(${reason}) 失败（任务里有冻结 prompt 兜底）`, error);
  } finally {
    flushing = false;
  }
};

// ─── 同角色活跃会话租约（Heartbeat）───
// 一轮真实用户消息进入生成流程时启动：立即写一次 chat_presence，之后每 15s 续租，
// 成功/失败/中断后停止本地续租，远端值靠 45s TTL 自然失效。它只代表「正在和这个角色
// 交互」，不是 App 在线状态——切后台就停续租，别让一个闲置可见标签页无限续租。

interface ChatPresenceLease {
  timer: ReturnType<typeof setInterval>;
  /** 本轮最新的「最近一条真实用户消息」时间戳；续租时读它，不吃闭包里的陈旧值。 */
  lastUserMessageAt: number | null;
}

// charId → 心跳租约。同一 char 只保留一个 timer（重入只刷新 lastUserMessageAt）。
const chatPresenceLeases = new Map<string, ChatPresenceLease>();

const writeChatPresence = (charId: string, lastUserMessageAt: number | null) => {
  const presence: AmsgChatPresence = {
    v: 1,
    charId,
    activeAt: Date.now(),
    lastUserMessageAt,
  };
  // 写入失败只 warn：心跳故障不能打断正常聊天，下一次 interval 继续尝试；远端 45s TTL 兜底。
  ActiveMsgClient.syncChatPresence(charId, presence).catch((error) => {
    console.warn(`${HEADER} 活跃会话租约写入失败（45s TTL 自然失效）`, error);
  });
};

/** 一轮真实用户消息进入生成流程时启动租约：立即写一次，之后每 15s 续租。 */
export const startAmsgChatPresence = (charId: string, lastUserMessageAt: number | null) => {
  writeChatPresence(charId, lastUserMessageAt);

  const existing = chatPresenceLeases.get(charId);
  if (existing) {
    // 已有 timer：只刷新本轮最新的 lastUserMessageAt，复用同一个心跳。
    existing.lastUserMessageAt = lastUserMessageAt;
    return;
  }

  const timer = setInterval(() => {
    // 切后台不再续租：一个闲置可见标签页不该无限续租；回前台下一轮真实消息重建。
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const lease = chatPresenceLeases.get(charId);
    if (!lease) return;
    writeChatPresence(charId, lease.lastUserMessageAt);
  }, CHAT_PRESENCE_HEARTBEAT_MS);
  chatPresenceLeases.set(charId, { timer, lastUserMessageAt });
};

/** 停止本地续租（不发「离线」写入，远端靠 45s TTL 自然失效）。 */
export const stopAmsgChatPresence = (charId: string) => {
  const lease = chatPresenceLeases.get(charId);
  if (lease) {
    clearInterval(lease.timer);
    chatPresenceLeases.delete(charId);
  }
};

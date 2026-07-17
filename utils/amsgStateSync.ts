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
  if (!config?.enabled || !config.taskUuid || config.mode === 'fixed') return;

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

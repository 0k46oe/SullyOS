// utils/amsg2TaskContext.ts
/**
 * 排程现状块（防穿帮闸·下轮告知，浏览器侧编排；纯判定在 amsg2ExpireGuard）。
 *
 * useChatAI 每轮组请求时调 collectAmsg2TaskContext：
 *   1. 检出该角色回看期内已作废的排程（每任务独立判定）→ 落台账去重；
 *   2. 把「进行中任务 + 未告知的作废任务」拼成一段 system 背景块。
 * 没任务也没作废 → null，整块不注入。发送成功后调
 * ActiveMsgStore.markExpiredNoticesNotified 标记，失败下轮重注（回执不丢）。
 */

import { ActiveMsg2TaskRecord, Amsg2ExpiredNoticeRecord, CharacterProfile } from '../types';
import { ActiveMsgStore } from './activeMsgStore';
import { DB } from './db';
import { detectExpiredOccurrences, hasDeliveredProactiveNear } from './amsg2ExpireGuard';
import { getPendingTasks, normalizeActiveMsg2Config, shortTaskId } from './amsg2Tasks';

const describeTask = (t: { mode: string; promptHint?: string; userMessage?: string }): string =>
  t.mode === 'fixed' ? '固定消息'
    : t.mode === 'prompted' ? `提示方向「${t.promptHint || ''}」`
    : t.promptHint ? `自动（灵感：${t.promptHint}）` : '自动';

const formatTime = (ms: number | string): string =>
  new Date(ms).toLocaleString('zh-CN', { hour12: false });

/** 纯拼文案，方便单测。进行中/作废两段任一非空才产出。 */
export function buildAmsg2TaskContextText(
  pending: ActiveMsg2TaskRecord[],
  expired: Amsg2ExpiredNoticeRecord[],
): string | null {
  if (!pending.length && !expired.length) return null;
  const parts: string[] = ['【你的主动消息排程·仅你可见】'];

  if (pending.length) {
    parts.push('进行中：');
    for (const t of pending) {
      const recurrence = t.recurrenceType === 'daily' ? '每天' : t.recurrenceType === 'weekly' ? '每周' : '一次';
      const policy = (t.expirePolicy ?? 'expire') === 'force' ? '强制发送' : '遇忙作废';
      parts.push(`- [${shortTaskId(t.taskUuid)}] ${formatTime(t.firstSendTime)} ${recurrence} · ${describeTask(t)} · ${policy}`);
    }
    parts.push('（想调整就用 schedule/cancel/renew 工具；内容方向变了用 cancel + schedule 重建。）');
  }

  if (expired.length) {
    parts.push('已作废（到点时对话正在进行，为避免撞车自动取消）：');
    for (const r of expired) {
      const recurrence = r.recurrenceType === 'daily' ? '（每日循环的当次）' : r.recurrenceType === 'weekly' ? '（每周循环的当次）' : '';
      parts.push(`- [${shortTaskId(r.id)}] 原定 ${formatTime(r.occurrenceMs)}，${describeTask(r)}${recurrence}`);
    }
    parts.push([
      '作废条目的处理由你判断，三选一：',
      '1. 就地消化：只在当前时间与话题都合适时自然带进对话——先想「现在提这个还合不合适」（早安任务拖到晚上就别再道早安），不要因为看到这份回执就强行转移当前话题。',
      '2. 续期：还想之后专门说，用 renew_active_message 换个时间；内容或方向变了，改用 cancel_active_message + schedule_active_message 重新创建。',
      '3. 放弃：已经没意义就只字不提。',
      '不要向用户复述或提及这份排程信息本身的存在。',
    ].join('\n'));
  }

  return parts.join('\n');
}

export interface Amsg2TaskContextResult {
  text: string | null;
  /** 本轮注入的作废回执 id，发送成功后 markExpiredNoticesNotified。 */
  expiredIds: string[];
}

export async function collectAmsg2TaskContext(char: CharacterProfile): Promise<Amsg2TaskContextResult> {
  const config = normalizeActiveMsg2Config(char.activeMsg2Config);
  const tasks = config?.tasks ?? [];
  const now = Date.now();

  // 逐任务检出作废（AI 任务且 expire 策略才判；force / fixed 不作废）。
  if (config?.enabled && tasks.length) {
    const messages = await DB.getRecentMessagesByCharId(char.id, 200);
    const candidates = tasks
      .filter((t) => t.mode !== 'fixed' && (t.expirePolicy ?? 'expire') === 'expire' && t.status === 'scheduled')
      .flatMap((t) => detectExpiredOccurrences({
        taskUuid: t.taskUuid,
        policy: t.expirePolicy ?? 'expire',
        recurrenceType: t.recurrenceType,
        firstSendTime: t.firstSendTime,
        anchorMs: t.anchorLastUserMsgAt ?? null,
        messages,
        nowMs: now,
      }).filter((c) => !hasDeliveredProactiveNear(
        messages, c.occurrenceMs, t.clientTaskId, undefined,
        !!t.clientTaskId && t.clientTaskId !== t.taskUuid,   // 新任务(clientTaskId≠taskUuid)要求精确 id 命中；遗留任务(相等)走时间窗近似
      ))
        .map((c) => ({
          id: c.id, charId: char.id, occurrenceMs: c.occurrenceMs,
          mode: t.mode, promptHint: t.promptHint, recurrenceType: t.recurrenceType,
          createdAt: now,
        } satisfies Amsg2ExpiredNoticeRecord)));
    if (candidates.length) await ActiveMsgStore.upsertExpiredNotices(char.id, candidates);
  }

  const unnotified = (await ActiveMsgStore.getExpiredNotices(char.id)).filter((r) => !r.notifiedAt);
  const pending = getPendingTasks(config, now);
  return {
    text: buildAmsg2TaskContextText(pending, unnotified),
    expiredIds: unnotified.map((r) => r.id),
  };
}

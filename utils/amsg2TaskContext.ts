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
import { resolveCharTimeZone } from './timezone';
import { detectExpiredOccurrences, hasDeliveredProactiveNear } from './amsg2ExpireGuard';
import {
  canExpire, currentOccurrenceMs, describeExpirePolicy, describeRecurrence,
  describeTaskMode, formatTaskTime, getPendingTasks, shortTaskId,
} from './amsg2Tasks';

/** 纯拼文案，方便单测。进行中/作废两段任一非空才产出。 */
export function buildAmsg2TaskContextText(
  pending: ActiveMsg2TaskRecord[],
  expired: Amsg2ExpiredNoticeRecord[],
  nowMs: number = Date.now(),
  /**
   * 角色的时间参照系（没开自定义时区时为 undefined，跟着设备走）。
   * 位置参数不设默认值：这一段是给角色看的，调用方必须显式想过时间该按谁的钟写。
   */
  charTz: string | undefined,
): string | null {
  if (!pending.length && !expired.length) return null;
  const parts: string[] = ['【你的主动消息排程·仅你可见】'];

  if (pending.length) {
    parts.push('进行中：');
    for (const t of pending) {
      // 循环任务写「下一次」的时间。写 firstSendTime 的话，一条每天的任务在角色眼里
      // 是个好几天前的时刻，它会当成已经过去的排程，然后在对话里说漏嘴或重复排一条。
      const occurrenceMs = currentOccurrenceMs(t, nowMs);
      parts.push(`- [${shortTaskId(t.taskUuid)}] ${formatTaskTime(occurrenceMs ?? t.firstSendTime, charTz)} ${describeRecurrence(t.recurrenceType)}`
        + ` · ${describeTaskMode(t)} · ${describeExpirePolicy(t.expirePolicy)}`);
    }
    parts.push('（想调整就用 schedule/cancel/renew 工具；内容方向变了用 cancel + schedule 重建。）');
  }

  if (expired.length) {
    parts.push('已作废（到点时对话正在进行，为避免撞车自动取消）：');
    for (const r of expired) {
      const recurrence = r.recurrenceType === 'daily' ? '（每日循环的当次）' : r.recurrenceType === 'weekly' ? '（每周循环的当次）' : '';
      parts.push(`- [${shortTaskId(r.id)}] 原定 ${formatTaskTime(r.occurrenceMs, charTz)}，${describeTaskMode(r)}${recurrence}`);
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
  const config = char.activeMsg2Config;
  const tasks = config?.tasks ?? [];
  const now = Date.now();

  // 逐任务检出作废（AI 任务且 expire 策略才判；force / fixed 不作废）。
  if (config?.enabled && tasks.length) {
    const messages = await DB.getRecentMessagesByCharId(char.id, 200);
    const candidates = tasks
      .filter(canExpire)
      .flatMap((t) => detectExpiredOccurrences({
        taskUuid: t.taskUuid,
        policy: t.expirePolicy,
        recurrenceType: t.recurrenceType,
        firstSendTime: t.firstSendTime,
        anchorMs: t.anchorLastUserMsgAt ?? null,
        messages,
        nowMs: now,
      }).filter((c) => !hasDeliveredProactiveNear(messages, c.occurrenceMs, t.clientTaskId))
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
    // 时间按角色的钟写：这一段是给角色看的，到点 worker 渲染的那份也是角色时区，
    // 两边对不上的话，纽约角色会在同一轮里读到差一个时差的两个「同一条任务」。
    text: buildAmsg2TaskContextText(pending, unnotified, now, resolveCharTimeZone(char)),
    expiredIds: unnotified.map((r) => r.id),
  };
}

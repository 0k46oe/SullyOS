/**
 * amsg2 多任务清单的读取/派生工具集（浏览器侧；worker 不需要它）。
 *
 * 状态设计：清单只存 'scheduled'（取消即移除记录）。到点后的一次性任务不回写
 * 状态——「已发送 / 已作废」由消息历史现场推导（amsg2TaskContext），避免
 * React 之外（push 送达路径）写角色数据引发状态竞争。过点 48h 的一次性任务
 * 由 pruneStaleTasks 在下一次任务变更落盘时顺手清掉。
 */

import {
  ActiveMsg2CharacterConfig,
  ActiveMsg2TaskRecord,
} from '../types';
import { FIRE_GRACE_MS } from './amsg2ExpireGuard';

export const MAX_ACTIVE_TASKS_PER_CHAR = 5;

export const shortTaskId = (taskUuid: string): string => taskUuid.slice(0, 8);

/**
 * 把任意可解析的时间折成 datetime-local 输入框认的本地墙钟 'YYYY-MM-DDTHH:mm'。
 * 任务的 firstSendTime 有两种来源：面板建的本就是 datetime-local，角色用工具建的是
 * 完整 ISO 8601（带时区）——编辑角色任务时不折算会导致时间框空白。已是该格式的原样
 * 返回（幂等）；无法解析（空 / 坏值）也原样返回，不抛错。
 */
export const toDatetimeLocalValue = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
};

export const findTaskByShortId = (
  tasks: ActiveMsg2TaskRecord[],
  shortId: string,
): ActiveMsg2TaskRecord | undefined =>
  tasks.find((t) => shortTaskId(t.taskUuid) === shortId || t.taskUuid === shortId);

/** 待触发 = 还会响的任务：循环任务恒真；一次性任务触发点（含宽限）未过。 */
export const isPendingTask = (task: ActiveMsg2TaskRecord, nowMs: number): boolean => {
  if (task.status !== 'scheduled') return false;
  if (task.recurrenceType !== 'none') return true;
  const fireAt = new Date(task.firstSendTime).getTime();
  return Number.isFinite(fireAt) && fireAt + FIRE_GRACE_MS > nowMs;
};

export const getPendingTasks = (
  config: ActiveMsg2CharacterConfig | undefined,
  nowMs: number,
): ActiveMsg2TaskRecord[] =>
  (config?.tasks ?? []).filter((t) => isPendingTask(t, nowMs));

/** 有没有还会响的 AI 任务（amsgStateSync 的同步门用：fixed 不需要 fire_pack）。 */
export const hasActiveAiTask = (
  config: ActiveMsg2CharacterConfig | undefined,
  nowMs = Date.now(),
): boolean => getPendingTasks(config, nowMs).some((t) => t.mode !== 'fixed');

/** 过点超过 48h 的一次性任务出清单（排程现状块的回看期也是 48h，一致）。 */
export const pruneStaleTasks = (
  tasks: ActiveMsg2TaskRecord[],
  nowMs: number,
): ActiveMsg2TaskRecord[] =>
  tasks.filter((t) => {
    if (t.recurrenceType !== 'none') return true;
    const fireAt = new Date(t.firstSendTime).getTime();
    return !Number.isFinite(fireAt) || fireAt > nowMs - 48 * 3600_000;
  });

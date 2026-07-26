/**
 * amsg2 调试面板的纯派生层：把角色数据摊成「一条任务一行、带状态标注」的视图。
 *
 * 这里不碰 React、不碰 IndexedDB，全是可单测的纯函数——面板显示错了很容易把排查
 * 带偏（「面板说还没到点，实际早就作废了」），所以判定口径必须钉死并测出来。
 *
 * 两条口径跟系统其它地方对齐，别在这里另起一套：
 *   1. 活/死的分界完全等于 amsg2Tasks.isPendingTask（pending + firing = 它为真）；
 *   2. 人读文案一律用 amsg2Tasks 的 describeXxx，跟角色上下文块、list 工具、设置面板说同一套词。
 */

import { ActiveMsg2TaskRecord, CharacterProfile } from '../types';
import { currentOccurrenceMs, isPendingTask } from './amsg2Tasks';

const MINUTE_MS = 60_000;

/**
 * pending  还没到点，倒计时往下走
 * firing   已过名义时间但还在送达宽限内——正在发或正在被闸拦，这会儿最值得盯
 * expired  一次性任务过点超过宽限还没动静
 * cancelled 已取消（清单里短暂存在，取消后就被移除）
 */
export type Amsg2DebugTaskState = 'pending' | 'firing' | 'expired' | 'cancelled';

export interface Amsg2DebugTaskView {
  task: ActiveMsg2TaskRecord;
  charId: string;
  charName: string;
  /** 该角色的主动消息总开关。关着的话任务再正常也不会响。 */
  charEnabled: boolean;
  state: Amsg2DebugTaskState;
  /** 当前这一次触发的名义时刻；循环任务已按周期推算。时间串坏掉时为 null。 */
  occurrenceMs: number | null;
  /** cron 每整分才跑，这是这一次实际最晚会被捞走的时刻。 */
  cronTickMs: number | null;
}

/**
 * 这一次触发实际最晚会被 cron 捞走的时刻。
 *
 * worker 的触发器是 "* * * * *"（见 worker/amsg/wrangler.toml），任务不会在名义时间
 * 那一刻就发，得等下一个整分。压在整分上的名义时间也进位到下一分钟——那一刻的 cron
 * 能不能正好赶上取决于毫秒级先后，报晚了只是白等一分钟，报早了会让人误判成「漏发」。
 */
export const nextCronTickMs = (occurrenceMs: number): number =>
  Math.ceil((occurrenceMs + 1) / MINUTE_MS) * MINUTE_MS;

/** 倒计时文案：未到点 T-4m12s，已过点 T+30s。 */
export const formatCountdown = (deltaMs: number): string => {
  const sign = deltaMs < 0 ? 'T+' : 'T-';
  const total = Math.floor(Math.abs(deltaMs) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${sign}${h ? `${h}h` : ''}${h || m ? `${m}m` : ''}${s}s`;
};

const resolveState = (
  task: ActiveMsg2TaskRecord,
  occurrenceMs: number | null,
  nowMs: number,
): Amsg2DebugTaskState => {
  if (task.status !== 'scheduled') return 'cancelled';
  // 活/死一律问 isPendingTask，别在这里重写判定——两边一旦走岔，面板就会骗人。
  if (!isPendingTask(task, nowMs)) return 'expired';
  return occurrenceMs != null && nowMs >= occurrenceMs ? 'firing' : 'pending';
};

const STATE_ORDER: Record<Amsg2DebugTaskState, number> = {
  firing: 0,
  pending: 1,
  expired: 2,
  cancelled: 3,
};

/**
 * 全部角色的 amsg2 任务摊平成一张表。失效的任务照样留着（置灰显示）——
 * 排查「怎么没响」时，看得见那条死任务比它凭空消失有用得多。
 */
export const buildAmsg2DebugTasks = (
  characters: CharacterProfile[],
  nowMs: number,
): Amsg2DebugTaskView[] => {
  const views: Amsg2DebugTaskView[] = [];
  for (const char of characters) {
    const config = char?.activeMsg2Config;
    if (!config || !Array.isArray(config.tasks)) continue;
    for (const task of config.tasks) {
      const occurrenceMs = currentOccurrenceMs(task, nowMs);
      views.push({
        task,
        charId: char.id,
        charName: char.name || char.id,
        charEnabled: config.enabled !== false,
        state: resolveState(task, occurrenceMs, nowMs),
        occurrenceMs,
        cronTickMs: occurrenceMs == null ? null : nextCronTickMs(occurrenceMs),
      });
    }
  }
  // 正在发的最要紧，其次是快到点的；失效的沉底，越近失效的越靠前。
  return views.sort((a, b) => {
    const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (byState !== 0) return byState;
    const at = a.occurrenceMs ?? Number.MAX_SAFE_INTEGER;
    const bt = b.occurrenceMs ?? Number.MAX_SAFE_INTEGER;
    const dead = a.state === 'expired' || a.state === 'cancelled';
    return dead ? bt - at : at - bt;
  });
};

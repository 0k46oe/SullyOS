// utils/amsg2Tasks.test.ts
import { describe, it, expect } from 'vitest';
import {
  MAX_ACTIVE_TASKS_PER_CHAR,
  findTaskByShortId,
  getPendingTasks,
  hasActiveAiTask,
  isPendingTask,
  normalizeActiveMsg2Config,
  pruneStaleTasks,
  shortTaskId,
} from './amsg2Tasks';
import type { ActiveMsg2TaskRecord } from '../types';

const H = 3600_000;
const task = (extra: Partial<ActiveMsg2TaskRecord> = {}): ActiveMsg2TaskRecord => ({
  taskUuid: 'aabbccdd-0000-0000-0000-000000000000',
  clientTaskId: 'cid-aabb',
  mode: 'auto', firstSendTime: new Date(Date.now() + H).toISOString(),
  recurrenceType: 'none', source: 'character', status: 'scheduled', createdAt: Date.now(),
  ...extra,
});

describe('amsg2Tasks helpers', () => {
  it('shortTaskId 取 uuid 前 8 位；findTaskByShortId 按短 id 找', () => {
    const t = task();
    expect(shortTaskId(t.taskUuid)).toBe('aabbccdd');
    expect(findTaskByShortId([t], 'aabbccdd')).toBe(t);
    expect(findTaskByShortId([t], 'ffffffff')).toBeUndefined();
  });

  it('isPendingTask：未来一次性/循环任务算待触发，过点一次性不算', () => {
    const now = Date.now();
    expect(isPendingTask(task(), now)).toBe(true);
    expect(isPendingTask(task({ firstSendTime: new Date(now - H).toISOString() }), now)).toBe(false);
    expect(isPendingTask(task({ firstSendTime: new Date(now - H).toISOString(), recurrenceType: 'daily' }), now)).toBe(true);
  });

  it('pruneStaleTasks 清掉过点超过 48h 的一次性任务，循环任务保留', () => {
    const now = Date.now();
    const stale = task({ taskUuid: 'stale000-0000-0000-0000-000000000000', firstSendTime: new Date(now - 49 * H).toISOString() });
    const recent = task({ taskUuid: 'recent00-0000-0000-0000-000000000000', firstSendTime: new Date(now - H).toISOString() });
    const daily = task({ taskUuid: 'daily000-0000-0000-0000-000000000000', firstSendTime: new Date(now - 100 * H).toISOString(), recurrenceType: 'daily' });
    expect(pruneStaleTasks([stale, recent, daily], now).map((t) => shortTaskId(t.taskUuid)))
      .toEqual(['recent00', 'daily000']);
  });

  it('normalizeActiveMsg2Config：旧单任务字段自愈成 tasks[0]', () => {
    const legacy = {
      enabled: true, mode: 'prompted', firstSendTime: '2026-07-20T09:00',
      recurrenceType: 'daily', promptHint: '道早安', taskUuid: 'legacy00-0000-0000-0000-000000000000',
      remoteStatus: 'scheduled', maxTokens: 120,
    };
    const out = normalizeActiveMsg2Config(legacy)!;
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks![0]).toMatchObject({
      taskUuid: 'legacy00-0000-0000-0000-000000000000',
      mode: 'prompted', promptHint: '道早安', recurrenceType: 'daily',
      source: 'user', status: 'scheduled',
    });
    expect(out.maxTokens).toBe(120);
    expect((out as any).taskUuid).toBeUndefined();
  });

  it('normalizeActiveMsg2Config：新结构原样返回、undefined 原样返回', () => {
    const fresh = { enabled: true, tasks: [task()] };
    expect(normalizeActiveMsg2Config(fresh)).toBe(fresh);
    expect(normalizeActiveMsg2Config(undefined)).toBeUndefined();
  });

  it('封顶常量为 5', () => {
    expect(MAX_ACTIVE_TASKS_PER_CHAR).toBe(5);
  });

  // 同步门（amsgStateSync）依赖 hasActiveAiTask：只要还有「待触发的非 fixed 任务」才同步 fire_pack。
  // 钉住这条，防止后续改动把它悄悄改死——静默分流杀主动消息是踩过的坑。
  it('getPendingTasks 只留待触发任务；hasActiveAiTask 排除 fixed，无待触发 AI 任务时为 false', () => {
    const now = Date.now();
    const ai = task();
    const fixed = task({ taskUuid: 'fixed000-0000-0000-0000-000000000000', mode: 'fixed' });
    const past = task({ taskUuid: 'past0000-0000-0000-0000-000000000000', firstSendTime: new Date(now - H).toISOString() });
    const config = { enabled: true, tasks: [ai, fixed, past] };
    expect(getPendingTasks(config, now).map((t) => shortTaskId(t.taskUuid))).toEqual(['aabbccdd', 'fixed000']);
    expect(hasActiveAiTask(config, now)).toBe(true);
    expect(hasActiveAiTask({ enabled: true, tasks: [fixed, past] }, now)).toBe(false);
    expect(hasActiveAiTask(undefined, now)).toBe(false);
  });
});

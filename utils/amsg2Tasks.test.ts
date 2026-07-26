// utils/amsg2Tasks.test.ts
import { describe, it, expect } from 'vitest';
import {
  MAX_ACTIVE_TASKS_PER_CHAR,
  REPLACE_CANCEL_FAILED_NOTE,
  applyRemoteTaskDelta,
  applyScheduledTask,
  currentOccurrenceMs,
  describeTaskProgress,
  findTaskByShortId,
  getPendingTasks,
  hasActiveAiTask,
  isPendingTask,
  isRemoteMissingTask,
  keepUncancelledTasks,
  pruneStaleTasks,
  shortTaskId,
  toDatetimeLocalValue,
} from './amsg2Tasks';
import type { ActiveMsg2TaskRecord } from '../types';

const H = 3600_000;
const task = (extra: Partial<ActiveMsg2TaskRecord> = {}): ActiveMsg2TaskRecord => ({
  taskUuid: 'aabbccdd-0000-0000-0000-000000000000',
  clientTaskId: 'cid-aabb',
  mode: 'auto', firstSendTime: new Date(Date.now() + H).toISOString(),
  recurrenceType: 'none', expirePolicy: 'expire',
  source: 'character', status: 'scheduled', createdAt: Date.now(),
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

// 防坑：角色用工具建的任务 firstSendTime 是完整 ISO 8601，datetime-local 输入框只认
// 'YYYY-MM-DDTHH:mm'——不折算编辑角色任务时时间框会空白。断言全部与本机时区无关。
describe('toDatetimeLocalValue', () => {
  it('已是 datetime-local 格式 → 原样返回（跨时区恒成立）', () => {
    expect(toDatetimeLocalValue('2026-07-21T09:00')).toBe('2026-07-21T09:00');
  });
  it('完整 ISO（带 Z / 秒 / 毫秒）→ 折成 16 位 YYYY-MM-DDTHH:mm（无 Z 无秒）', () => {
    const out = toDatetimeLocalValue('2026-07-21T01:00:00.000Z');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(out).not.toContain('Z');
  });
  it('再折一次结果不变（幂等，防重复编辑时间漂移）', () => {
    const once = toDatetimeLocalValue('2026-07-21T01:00:00.000Z');
    expect(toDatetimeLocalValue(once)).toBe(once);
  });
  it('无法解析 / 空串 → 原样返回，不抛错', () => {
    expect(toDatetimeLocalValue('')).toBe('');
    expect(toDatetimeLocalValue('not-a-date')).toBe('not-a-date');
  });
});

// ─── 并清单 / 关闭时保留 —— 面板与角色工具共用的规则 ───
// 这两个函数的存在意义是「绝不留下本地看不见、远端却会触发的幽灵任务」，
// 所以每条都按这个标准钉：什么情况下记录必须留下来。

describe('applyScheduledTask', () => {
  const A = task({ taskUuid: 'aaaaaaaa-0000-0000-0000-000000000000' });
  const B = task({ taskUuid: 'bbbbbbbb-0000-0000-0000-000000000000' });
  const fresh = task({ taskUuid: 'cccccccc-0000-0000-0000-000000000000' });

  it('纯新建：并到清单末尾，其它任务不动', () => {
    const out = applyScheduledTask([A, B], fresh, {}, Date.now());
    expect(out.map((t) => t.taskUuid)).toEqual([A.taskUuid, B.taskUuid, fresh.taskUuid]);
  });

  it('替换成功：旧记录移除，新记录进来', () => {
    const out = applyScheduledTask([A, B], fresh, { replaceTaskUuid: A.taskUuid }, Date.now());
    expect(out.map((t) => t.taskUuid)).toEqual([B.taskUuid, fresh.taskUuid]);
  });

  it('替换时远端取消失败：旧记录必须保留并标错（远端新旧并存，本地不能只剩新的）', () => {
    const out = applyScheduledTask(
      [A, B], fresh,
      { replaceTaskUuid: A.taskUuid, replacedCancelFailed: true },
      Date.now(),
    );
    expect(out.map((t) => t.taskUuid)).toEqual([A.taskUuid, B.taskUuid, fresh.taskUuid]);
    expect(out.find((t) => t.taskUuid === A.taskUuid)?.lastError).toBe(REPLACE_CANCEL_FAILED_NOTE);
    // 没被替换的那条不该被牵连打标
    expect(out.find((t) => t.taskUuid === B.taskUuid)?.lastError).toBeUndefined();
  });

  it('顺手清掉过点 48h 的一次性任务，但循环任务不清', () => {
    const stale = task({ taskUuid: 'dddddddd-0000-0000-0000-000000000000', firstSendTime: new Date(Date.now() - 72 * H).toISOString() });
    const oldDaily = task({ taskUuid: 'eeeeeeee-0000-0000-0000-000000000000', recurrenceType: 'daily', firstSendTime: new Date(Date.now() - 72 * H).toISOString() });
    const out = applyScheduledTask([stale, oldDaily], fresh, {}, Date.now());
    expect(out.map((t) => t.taskUuid)).toEqual([oldDaily.taskUuid, fresh.taskUuid]);
  });
});

describe('keepUncancelledTasks', () => {
  const notes = { failed: '取消失败', appeared: '关闭时新出现' };
  const A = task({ taskUuid: 'aaaaaaaa-0000-0000-0000-000000000000' });
  const B = task({ taskUuid: 'bbbbbbbb-0000-0000-0000-000000000000' });
  const C = task({ taskUuid: 'cccccccc-0000-0000-0000-000000000000' });

  it('全部取消成功 → 清单清空', () => {
    const attempted = new Set([A.taskUuid, B.taskUuid]);
    expect(keepUncancelledTasks([A, B], attempted, new Set(), notes)).toEqual([]);
  });

  it('取消失败的留下并标错（远端还活着，用户得能再试）', () => {
    const attempted = new Set([A.taskUuid, B.taskUuid]);
    const out = keepUncancelledTasks([A, B], attempted, new Set([B.taskUuid]), notes);
    expect(out.map((t) => t.taskUuid)).toEqual([B.taskUuid]);
    expect(out[0].lastError).toBe(notes.failed);
  });

  it('取消期间才出现的任务留下（压根没被尝试过，跟着清掉就成幽灵任务）', () => {
    // C 是关闭流程跑到一半时角色在聊天里刚排的，不在 attempted 里
    const attempted = new Set([A.taskUuid, B.taskUuid]);
    const out = keepUncancelledTasks([A, B, C], attempted, new Set(), notes);
    expect(out.map((t) => t.taskUuid)).toEqual([C.taskUuid]);
    expect(out[0].lastError).toBe(notes.appeared);
  });
});

// 回归守卫：面板打开时抓的远端底账是「那一刻」的快照，之后新建的任务当然不在里面。
// 曾经每建一条任务，卡片下面就立刻冒一行「⚠ 远端不存在」，关掉面板重开才消失——
// 第一次用的人会以为排程失败了。
describe('远端对账（applyRemoteTaskDelta / isRemoteMissingTask）', () => {
  const now = Date.now();
  const A = task({ taskUuid: 'aaaaaaaa-0000-0000-0000-000000000000' });
  const NEW = task({ taskUuid: 'nnnnnnnn-0000-0000-0000-000000000000' });

  it('新建成功后记进底账 → 不再误标「远端不存在」', () => {
    const opened = new Set([A.taskUuid]);            // 打开面板时远端只有 A
    expect(isRemoteMissingTask(NEW, opened, now)).toBe(true);   // 不记账就是这个错觉

    const after = applyRemoteTaskDelta(opened, { present: [NEW.taskUuid] });
    expect(isRemoteMissingTask(NEW, after, now)).toBe(false);
    expect(isRemoteMissingTask(A, after, now)).toBe(false);     // 别牵连原有任务
  });

  it('编辑 = 新建 + 取消旧的：新 uuid 进账、旧 uuid 出账', () => {
    const after = applyRemoteTaskDelta(new Set([A.taskUuid]), {
      present: [NEW.taskUuid],
      gone: [A.taskUuid],
    });
    expect(after).toEqual(new Set([NEW.taskUuid]));
  });

  it('替换时旧任务取消失败 → 旧 uuid 留在账上（远端新旧并存，别标成不存在）', () => {
    const after = applyRemoteTaskDelta(new Set([A.taskUuid]), { present: [NEW.taskUuid] });
    expect(isRemoteMissingTask(A, after, now)).toBe(false);
  });

  it('底账没拉到（null）→ 一直保持 null，整个徽标不显示', () => {
    expect(applyRemoteTaskDelta(null, { present: [NEW.taskUuid] })).toBeNull();
    expect(isRemoteMissingTask(A, null, now)).toBe(false);
  });

  it('已过点的一次性任务不标：它本来就该从远端消失', () => {
    const fired = task({
      taskUuid: 'ffffffff-0000-0000-0000-000000000000',
      firstSendTime: new Date(now - 24 * H).toISOString(),
    });
    expect(isRemoteMissingTask(fired, new Set(), now)).toBe(false);
  });

  it('待触发的任务确实从远端消失了 → 照标（这才是徽标存在的意义）', () => {
    expect(isRemoteMissingTask(A, new Set(), now)).toBe(true);
  });
});

// 回归守卫：循环任务的 firstSendTime 是「第一次」的锚点，可能在好几天前。
// 直接把它显示出来，一条每天的任务看着就像「过点了还没触发」——设置面板、角色查到的
// 清单、注入角色的排程现状块三处都栽在这上面，所以时间一律走 currentOccurrenceMs。
describe('currentOccurrenceMs（清单显示的「这一次」）', () => {
  const NOW = new Date('2026-07-26T14:00:00.000Z').getTime();
  const at = (iso: string) => new Date(iso).getTime();

  it('一次性任务恒为 firstSendTime，过没过点都一样', () => {
    const future = task({ firstSendTime: '2026-07-27T09:00:00.000Z' });
    const past = task({ firstSendTime: '2026-07-20T09:00:00.000Z' });
    expect(currentOccurrenceMs(future, NOW)).toBe(at('2026-07-27T09:00:00.000Z'));
    expect(currentOccurrenceMs(past, NOW)).toBe(at('2026-07-20T09:00:00.000Z'));
  });

  it('每天：几天前建的任务推到今天/明天的那一次，而不是原始锚点', () => {
    const daily = task({ recurrenceType: 'daily', firstSendTime: '2026-07-20T09:00:00.000Z' });
    // 今天 09:00 已经过了（现在 14:00），下一次是明天 09:00
    expect(currentOccurrenceMs(daily, NOW)).toBe(at('2026-07-27T09:00:00.000Z'));
  });

  it('每周：按 7 天推，跨月也不迭代', () => {
    const weekly = task({ recurrenceType: 'weekly', firstSendTime: '2026-05-04T09:00:00.000Z' });
    const next = currentOccurrenceMs(weekly, NOW)!;
    expect(next).toBeGreaterThan(NOW);
    expect((next - at('2026-05-04T09:00:00.000Z')) % (7 * 24 * H)).toBe(0);
  });

  it('时间串坏掉 → null（调用方退回原值显示，不抛错）', () => {
    expect(currentOccurrenceMs(task({ firstSendTime: '不是时间' }), NOW)).toBeNull();
  });
});

// 「已到点」这三个字对一次性任务等于没说——发过了还是卡住了，用户分不出来。
// 远端底账正好能分辨，这里钉住三档口径。
describe('describeTaskProgress', () => {
  const now = Date.now();
  const pending = task({ taskUuid: 'aaaaaaaa-0000-0000-0000-000000000000' });
  const fired = task({
    taskUuid: 'ffffffff-0000-0000-0000-000000000000',
    firstSendTime: new Date(now - 24 * H).toISOString(),
  });

  it('还没到点 → 待触发（底账有没有都一样）', () => {
    expect(describeTaskProgress(pending, new Set([pending.taskUuid]), now)).toBe('待触发');
    expect(describeTaskProgress(pending, null, now)).toBe('待触发');
  });

  it('过点了、远端那行还在 → cron 还没消费', () => {
    expect(describeTaskProgress(fired, new Set([fired.taskUuid]), now)).toBe('已到点·待处理');
  });

  it('过点了、远端已经没有 → worker 处理完了（发出去或被闸作废）', () => {
    expect(describeTaskProgress(fired, new Set(), now)).toBe('已触发');
  });

  it('底账没拉到 → 不猜，给中性文案', () => {
    expect(describeTaskProgress(fired, null, now)).toBe('已到点');
  });
});

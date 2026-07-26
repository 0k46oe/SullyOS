// utils/amsg2DebugView.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildAmsg2DebugTasks,
  formatCountdown,
  nextCronTickMs,
} from './amsg2DebugView';
import { currentOccurrenceMs, isPendingTask } from './amsg2Tasks';
import { FIRE_GRACE_MS } from './amsg2ExpireGuard';
import type { ActiveMsg2TaskRecord, CharacterProfile } from '../types';

const MIN = 60_000;
const H = 3600_000;
const DAY = 24 * H;

// 时钟写死，不碰 Date.now()：这里断言的全是「相对某一刻算出什么状态」，
// 默认值要是跟着真实时间飘，状态分界的用例会随跑测试的时间点时灵时不灵。
const NOW = new Date('2026-07-26T14:00:00.000Z').getTime();

const task = (extra: Partial<ActiveMsg2TaskRecord> = {}): ActiveMsg2TaskRecord => ({
  taskUuid: 'aabbccdd-0000-0000-0000-000000000000',
  clientTaskId: 'cid-aabb',
  mode: 'auto',
  firstSendTime: new Date(NOW + H).toISOString(),
  recurrenceType: 'none',
  expirePolicy: 'expire',
  source: 'character',
  status: 'scheduled',
  createdAt: NOW,
  ...extra,
});

const char = (tasks: ActiveMsg2TaskRecord[], extra: Record<string, unknown> = {}): CharacterProfile =>
  ({
    id: 'char-1',
    name: '楚小南',
    activeMsg2Config: { enabled: true, tasks },
    ...extra,
  }) as unknown as CharacterProfile;

describe('nextCronTickMs', () => {
  // worker 的 cron 是 "* * * * *"（每整分），任务不会在名义时间那一刻发，
  // 而是等下一个整分。面板显示的「实际最晚」就靠这个。
  it('名义时间落在分钟中间时进位到下一个整分', () => {
    const fire = new Date('2026-07-26T14:07:39.000Z').getTime();
    expect(nextCronTickMs(fire)).toBe(new Date('2026-07-26T14:08:00.000Z').getTime());
  });

  it('名义时间正好压在整分上也进位（保守估计，宁可报晚不报早）', () => {
    const fire = new Date('2026-07-26T14:07:00.000Z').getTime();
    expect(nextCronTickMs(fire)).toBe(new Date('2026-07-26T14:08:00.000Z').getTime());
  });
});

describe('currentOccurrenceMs', () => {
  // 回归守卫：循环任务的 firstSendTime 是「第一次」的时间，可能是几天前。
  // 直接拿它算倒计时会显示一个早就过去的负数——面板必须按周期推到当前这一次。
  it('每天循环：firstSendTime 在三天前时推到今天/明天的那一次，而不是原地不动', () => {
    const first = new Date('2026-07-23T09:00:00.000Z').getTime();
    const now = new Date('2026-07-26T14:00:00.000Z').getTime();
    const occurrence = currentOccurrenceMs(
      task({ firstSendTime: new Date(first).toISOString(), recurrenceType: 'daily' }),
      now,
    );
    expect(occurrence).toBe(new Date('2026-07-27T09:00:00.000Z').getTime());
    expect(occurrence).toBeGreaterThan(now);
  });

  it('每周循环按 7 天推', () => {
    const first = new Date('2026-07-05T09:00:00.000Z').getTime();
    const now = new Date('2026-07-26T14:00:00.000Z').getTime();
    expect(
      currentOccurrenceMs(
        task({ firstSendTime: new Date(first).toISOString(), recurrenceType: 'weekly' }),
        now,
      ),
    ).toBe(new Date('2026-08-02T09:00:00.000Z').getTime());
  });

  it('刚过点但还在送达宽限内时，停在这一次而不是跳到下一次', () => {
    const first = new Date('2026-07-26T09:00:00.000Z').getTime();
    const now = first + FIRE_GRACE_MS - 1_000;
    expect(
      currentOccurrenceMs(
        task({ firstSendTime: new Date(first).toISOString(), recurrenceType: 'daily' }),
        now,
      ),
    ).toBe(first);
  });

  it('一次性任务恒为 firstSendTime，过点也不推', () => {
    const first = new Date('2026-07-20T09:00:00.000Z').getTime();
    const now = new Date('2026-07-26T14:00:00.000Z').getTime();
    expect(currentOccurrenceMs(task({ firstSendTime: new Date(first).toISOString() }), now)).toBe(first);
  });

  it('时间串解析不了时返回 null，不抛错也不返回 NaN', () => {
    expect(currentOccurrenceMs(task({ firstSendTime: '不是时间' }), NOW)).toBeNull();
  });
});

describe('formatCountdown', () => {
  it('未到点显示 T-，已过点显示 T+', () => {
    expect(formatCountdown(4 * MIN + 12_000)).toBe('T-4m12s');
    expect(formatCountdown(-30_000)).toBe('T+30s');
  });

  it('不足一分钟不带 m，超过一小时带 h', () => {
    expect(formatCountdown(12_000)).toBe('T-12s');
    expect(formatCountdown(2 * H + 3 * MIN + 4_000)).toBe('T-2h3m4s');
  });
});

describe('buildAmsg2DebugTasks', () => {
  const now = NOW;

  it('把每个角色的任务摊平，带上角色名和该角色的主动消息总开关', () => {
    const views = buildAmsg2DebugTasks(
      [char([task()], { id: 'c1', name: '楚小南' })],
      now,
    );
    expect(views).toHaveLength(1);
    expect(views[0].charName).toBe('楚小南');
    expect(views[0].charEnabled).toBe(true);
  });

  it('角色关掉主动消息时 charEnabled 为 false，但任务照样列出来', () => {
    const views = buildAmsg2DebugTasks(
      [char([task()], { activeMsg2Config: { enabled: false, tasks: [task()] } })],
      now,
    );
    expect(views).toHaveLength(1);
    expect(views[0].charEnabled).toBe(false);
  });

  // 回归守卫：状态分类必须跟 isPendingTask 完全同口径。
  // 面板说「待触发」而系统认为已失效（或反过来），排查时会把人带沟里。
  it('pending / firing 两态之和恰好等于 isPendingTask 为真的集合', () => {
    const cases = [
      task({ taskUuid: 'future00-0000-0000-0000-000000000000', firstSendTime: new Date(now + H).toISOString() }),
      task({ taskUuid: 'ingrace0-0000-0000-0000-000000000000', firstSendTime: new Date(now - 30_000).toISOString() }),
      task({ taskUuid: 'expired0-0000-0000-0000-000000000000', firstSendTime: new Date(now - H).toISOString() }),
      task({ taskUuid: 'daily000-0000-0000-0000-000000000000', firstSendTime: new Date(now - 3 * DAY).toISOString(), recurrenceType: 'daily' }),
      task({ taskUuid: 'cancel00-0000-0000-0000-000000000000', status: 'cancelled' }),
    ];
    const views = buildAmsg2DebugTasks([char(cases)], now);
    for (const view of views) {
      const live = view.state === 'pending' || view.state === 'firing';
      expect(live).toBe(isPendingTask(view.task, now));
    }
  });

  it('已取消的任务标成 cancelled，不会混进待触发里', () => {
    const views = buildAmsg2DebugTasks([char([task({ status: 'cancelled' })])], now);
    expect(views[0].state).toBe('cancelled');
  });

  it('一次性任务过点超过送达宽限后标成 expired', () => {
    const fire = now - FIRE_GRACE_MS - 1_000;
    const views = buildAmsg2DebugTasks([char([task({ firstSendTime: new Date(fire).toISOString() })])], now);
    expect(views[0].state).toBe('expired');
  });

  it('一次性任务刚过点、还在送达宽限内时标成 firing', () => {
    const fire = now - 30_000;
    const views = buildAmsg2DebugTasks([char([task({ firstSendTime: new Date(fire).toISOString() })])], now);
    expect(views[0].state).toBe('firing');
  });

  it('活的任务排在失效的前面；活的按触发时间由近到远', () => {
    const soon = task({ taskUuid: 'soon0000-0000-0000-0000-000000000000', firstSendTime: new Date(now + 5 * MIN).toISOString() });
    const later = task({ taskUuid: 'later000-0000-0000-0000-000000000000', firstSendTime: new Date(now + H).toISOString() });
    const dead = task({ taskUuid: 'dead0000-0000-0000-0000-000000000000', firstSendTime: new Date(now - 5 * H).toISOString() });
    const views = buildAmsg2DebugTasks([char([later, dead, soon])], now);
    expect(views.map((v) => v.task.taskUuid.slice(0, 8))).toEqual(['soon0000', 'later000', 'dead0000']);
  });

  it('没配 amsg2 的角色直接跳过，不报错', () => {
    const plain = { id: 'c9', name: '路人' } as unknown as CharacterProfile;
    expect(buildAmsg2DebugTasks([plain], now)).toEqual([]);
  });
});

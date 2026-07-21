import { describe, it, expect } from 'vitest';
import {
  AMSG_SLOT_AWAY_HINT,
  AMSG_SLOT_CURRENT_TIME,
  AMSG_SLOT_TASK_INSTRUCTION,
  AMSG_SLOT_TIME_SINCE_USER,
  AmsgFirePack,
  buildAwayHint,
  DEFAULT_TASK_INSTRUCTION,
  formatLocalTime,
  formatTimeSinceUser,
  parseFirePack,
  renderFirePack,
} from './amsgFirePack';

// 回归守卫：这些期望值抄的是 activeMsgClient 拆槽位前（buildTimeGapHint /
// buildLegacyStyleProactiveHint 内联时代）的旧文案。渲染产出必须和排程时冻结
// completePrompt 的老链路一字不差，改文案前先想清楚两条链路要一起变。

describe('formatTimeSinceUser', () => {
  it('没有聊天记录（null）', () => {
    expect(formatTimeSinceUser(null)).toBe('你们最近没有新的聊天记录。');
  });

  it('小于 1 小时按分钟', () => {
    expect(formatTimeSinceUser(0)).toBe('距离用户上次主动发消息大约 0 分钟。');
    expect(formatTimeSinceUser(59)).toBe('距离用户上次主动发消息大约 59 分钟。');
  });

  it('小于 1 天按小时（整点不带分钟尾巴）', () => {
    expect(formatTimeSinceUser(60)).toBe('距离用户上次主动发消息大约 1 小时。');
    expect(formatTimeSinceUser(90)).toBe('距离用户上次主动发消息大约 1 小时 30 分钟。');
    expect(formatTimeSinceUser(1439)).toBe('距离用户上次主动发消息大约 23 小时 59 分钟。');
  });

  it('超过 1 天按天（整天不带小时尾巴）', () => {
    expect(formatTimeSinceUser(1440)).toBe('距离用户上次主动发消息大约 1 天。');
    expect(formatTimeSinceUser(1440 + 300)).toBe('距离用户上次主动发消息大约 1 天 5 小时。');
  });

  it('负数钳到 0（时钟回拨防线）', () => {
    expect(formatTimeSinceUser(-5)).toBe('距离用户上次主动发消息大约 0 分钟。');
  });
});

describe('buildAwayHint', () => {
  it('无记录 → 「最近没有主动来找你说话」', () => {
    expect(buildAwayHint('楪同学', '你们最近没有新的聊天记录。'))
      .toBe('楪同学最近没有主动来找你说话。');
  });

  it('有记录 → 「距离用户」换成「已经」', () => {
    expect(buildAwayHint('小明', '距离用户上次主动发消息大约 3 小时。'))
      .toBe('小明已经上次主动发消息大约 3 小时。');
  });

  it('空名字回退「对方」', () => {
    expect(buildAwayHint('', '你们最近没有新的聊天记录。'))
      .toBe('对方最近没有主动来找你说话。');
  });
});

describe('formatLocalTime', () => {
  it('按 tzOffsetMin 换算本地时间（UTC+8 → offset -480）', () => {
    // 2026-07-17T12:00:00Z 在 UTC+8 是 20:00
    expect(formatLocalTime(Date.UTC(2026, 6, 17, 12, 0), -480)).toBe('2026-07-17 20:00');
  });

  it('offset 0 即 UTC', () => {
    expect(formatLocalTime(Date.UTC(2026, 6, 17, 12, 34), 0)).toBe('2026-07-17 12:34');
  });
});

describe('renderFirePack', () => {
  const basePack: AmsgFirePack = {
    v: 2,
    template: [
      `当前本地时间：${AMSG_SLOT_CURRENT_TIME}`,
      AMSG_SLOT_TIME_SINCE_USER,
      `现在是 ${AMSG_SLOT_CURRENT_TIME}。`,
      AMSG_SLOT_AWAY_HINT,
      AMSG_SLOT_TASK_INSTRUCTION,
    ].join('\n'),
    lastUserMessageAt: null,
    tzOffsetMin: 0,
    targetName: '楪同学',
  };

  it('填满全部槽位，currentTime 出现多次也全部替换', () => {
    const now = Date.UTC(2026, 6, 17, 8, 30);
    const rendered = renderFirePack(basePack, now);
    expect(rendered).toBe([
      '当前本地时间：2026-07-17 08:30',
      '你们最近没有新的聊天记录。',
      '现在是 2026-07-17 08:30。',
      '楪同学最近没有主动来找你说话。',
      DEFAULT_TASK_INSTRUCTION,
    ].join('\n'));
    expect(rendered).not.toContain('{{');
  });

  it('lastUserMessageAt 用渲染时刻现算时间差', () => {
    const now = Date.UTC(2026, 6, 17, 8, 0);
    const rendered = renderFirePack(
      { ...basePack, lastUserMessageAt: now - 90 * 60_000 },
      now,
    );
    expect(rendered).toContain('距离用户上次主动发消息大约 1 小时 30 分钟。');
    expect(rendered).toContain('楪同学已经上次主动发消息大约 1 小时 30 分钟。');
  });
});

describe('parseFirePack', () => {
  const valid: AmsgFirePack = {
    v: 2, template: 'x', lastUserMessageAt: null, tzOffsetMin: -480, targetName: 'A',
  };

  it('合法 JSON 原样返回', () => {
    expect(parseFirePack(JSON.stringify(valid))).toEqual(valid);
  });

  it('lastUserMessageAt 数字也合法', () => {
    expect(parseFirePack(JSON.stringify({ ...valid, lastUserMessageAt: 123 }))?.lastUserMessageAt).toBe(123);
  });

  it('坏形状 → null（worker 借此回退老链路）', () => {
    expect(parseFirePack('not json')).toBeNull();
    expect(parseFirePack('{}')).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, v: 1 }))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, template: '' }))).toBeNull();
    expect(parseFirePack(JSON.stringify({ ...valid, tzOffsetMin: 'x' }))).toBeNull();
  });
});

describe('fire_pack v2 任务指令槽', () => {
  const pack: AmsgFirePack = {
    v: 2,
    template: `头部\n${AMSG_SLOT_TASK_INSTRUCTION}\n尾部 ${AMSG_SLOT_CURRENT_TIME}`,
    lastUserMessageAt: null, tzOffsetMin: -480, targetName: '楪同学',
  };

  it('renderFirePack 用传入的任务指令填槽', () => {
    const out = renderFirePack(pack, Date.UTC(2026, 6, 21, 1, 0), { taskInstruction: '围绕"问考试"发起私聊' });
    expect(out).toContain('围绕"问考试"发起私聊');
    expect(out).not.toContain(AMSG_SLOT_TASK_INSTRUCTION);
  });

  it('没给指令时填默认自动指令（旧任务 metadata 缺指令的兜底）', () => {
    const out = renderFirePack(pack, Date.UTC(2026, 6, 21, 1, 0));
    expect(out).toContain(DEFAULT_TASK_INSTRUCTION);
  });

  it('parseFirePack 只认 v2；v1 旧包 parse 失败（回退冻结 prompt，下轮同步自愈）', () => {
    expect(parseFirePack(JSON.stringify(pack))).not.toBeNull();
    expect(parseFirePack(JSON.stringify({ ...pack, v: 1 }))).toBeNull();
  });
});

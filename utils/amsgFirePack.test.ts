import { describe, it, expect } from 'vitest';
import {
  AMSG_SLOT_AWAY_HINT,
  AMSG_SLOT_CURRENT_TIME,
  AMSG_SLOT_TASK_INSTRUCTION,
  AMSG_SLOT_TIME_SINCE_USER,
  AmsgFirePack,
  buildAwayHint,
  formatLocalTime,
  formatTimeSinceUser,
  parseFirePack,
  packStateValue,
  renderFirePack,
  unpackStateValue,
} from './amsgFirePack';

// 回归守卫：这些期望值抄的是 activeMsgClient 拆槽位前（buildTimeGapHint /
// buildLegacyStyleProactiveHint 内联时代）的旧文案。模板在前端维护、填槽在 worker 里跑，
// 改文案时这份测试会挡住手滑——期望值和文案要一起改。

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
    const rendered = renderFirePack(basePack, now, '本次任务指令');
    expect(rendered).toBe([
      '当前本地时间：2026-07-17 08:30',
      '你们最近没有新的聊天记录。',
      '现在是 2026-07-17 08:30。',
      '楪同学最近没有主动来找你说话。',
      '本次任务指令',
    ].join('\n'));
    expect(rendered).not.toContain('{{');
  });

  it('lastUserMessageAt 用渲染时刻现算时间差', () => {
    const now = Date.UTC(2026, 6, 17, 8, 0);
    const rendered = renderFirePack(
      { ...basePack, lastUserMessageAt: now - 90 * 60_000 },
      now,
      '本次任务指令',
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

  it('坏形状 → null（worker 借此抛 fire-state 错）', () => {
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
    const out = renderFirePack(pack, Date.UTC(2026, 6, 21, 1, 0), '围绕"问考试"发起私聊');
    expect(out).toContain('围绕"问考试"发起私聊');
    expect(out).not.toContain(AMSG_SLOT_TASK_INSTRUCTION);
  });

  it('parseFirePack 只认 v2；v1 旧包 parse 失败（worker 抛 fire-state 错）', () => {
    expect(parseFirePack(JSON.stringify(pack))).not.toBeNull();
    expect(parseFirePack(JSON.stringify({ ...pack, v: 1 }))).toBeNull();
  });
});

describe('client_state 值压缩', () => {
  // fire_pack 有几万字，随手编一小段压不出效果也测不出真问题，拿重复的中文段落凑量。
  const bigJson = JSON.stringify({
    v: 2,
    template: '【角色系统设定】你是一个会在深夜突然想起对方的人。\n'.repeat(400),
    lastUserMessageAt: 1_700_000_000_000,
    tzOffsetMin: -480,
    targetName: '楪',
  });

  it('压完再解回来，一个字都不差', async () => {
    const packed = await packStateValue(bigJson);
    expect(packed.startsWith('gz1:')).toBe(true);
    expect(await unpackStateValue(packed)).toBe(bigJson);
  });

  it('压完确实变小了（不然这整套机制没有意义）', async () => {
    const packed = await packStateValue(bigJson);
    expect(packed.length).toBeLessThan(bigJson.length / 2);
  });

  // 内容太短时 packStateValue 会原样返回（压完更大），读侧必须认得这种没前缀的值。
  it('压完反而更大的短内容保持原样，读回来也认', async () => {
    const tiny = '{"v":2}';
    expect(await packStateValue(tiny)).toBe(tiny);
    expect(await unpackStateValue(tiny)).toBe(tiny);
  });

  // 回归守卫：上面那份 repeat 出来的样本压缩率 20 倍以上，怎么比都划算，测不出口径错误。
  // 真实 fire_pack 是中文散文，压缩率只有 2~3 倍，恰好落在「按字符数比不划算、按字节比
  // 划算」的缺口里——线上就是这么一份都没压成的：13977 字节的提示词压完 base64 约 7000
  // 字符，拿它跟原文 5849 个**字符**比，7000 > 5849 判定「压完更大」直接放弃，而实际
  // 字节数是 7000 < 13977，省了一半。
  //
  // 下面这段用固定序列从常用字里取，压缩率 2.8 倍，跟真实提示词一个量级。
  it('中文按字节算划算就要压（不能拿字符数比）', async () => {
    const CHARS = '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感';
    const prose = Array.from(
      { length: 400 },
      (_, i) => CHARS[(i * 37 + (i >> 4) * 11) % CHARS.length],
    ).join('');
    const rawBytes = new TextEncoder().encode(prose).length;
    // 前提：这段内容按字符数比是「不划算」的，正是旧口径会放弃的那一类。
    expect(rawBytes).toBeGreaterThan(prose.length * 2);

    const packed = await packStateValue(prose);
    expect(packed.startsWith('gz1:'), '按字节算划算就该压').toBe(true);
    expect(packed.length).toBeLessThan(rawBytes);
    expect(packed.length).toBeGreaterThan(prose.length); // 按字符数比反而更长
    expect(await unpackStateValue(packed)).toBe(prose);
  });

  it('压过的值解出来还能正常 parse 成 fire_pack', async () => {
    const packed = await packStateValue(bigJson);
    const pack = parseFirePack(await unpackStateValue(packed));
    expect(pack?.targetName).toBe('楪');
    expect(pack?.tzOffsetMin).toBe(-480);
  });

  it('数据损坏时解压抛错，不会把半截内容当正常值放过去', async () => {
    await expect(unpackStateValue('gz1:bm90LWd6aXAtYXQtYWxs')).rejects.toThrow();
  });
});

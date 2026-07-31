import { describe, it, expect } from 'vitest';
import {
  AMSG_FIRE_SCHEDULE_TOOL,
  EXPIRE_POLICY_DESCRIPTION,
  MIN_SCHEDULE_LEAD_MS,
  buildFireScheduleBlock,
  buildFireScheduleTool,
  buildTaskInstruction,
  extractFireScheduleTextCalls,
  parseFireScheduleArgs,
} from './amsgFireSchedule';

const NOW = Date.UTC(2026, 6, 30, 12, 0);
const inMinutes = (n: number) => new Date(NOW + n * 60_000).toISOString();

// 参数是模型现写的，写歪是常态。这里每一条打回都必须是「能照着改」的一句话——
// 回一个裸错误码的话，模型下一轮多半原样再试一次，白烧一轮预算。
describe('parseFireScheduleArgs', () => {
  it('只给 send_at 时其余走默认（auto / 一次性 / 遇忙作废）', () => {
    const out = parseFireScheduleArgs({ send_at: inMinutes(90) }, NOW);
    expect(out).toEqual({
      sendAt: new Date(NOW + 90 * 60_000).toISOString(),
      mode: 'auto',
      recurrence: 'none',
      expirePolicy: 'expire',
    });
  });

  it('默认是 expire 而不是 force——大多数「接着说」用户回来了就该让路', () => {
    const out = parseFireScheduleArgs({ send_at: inMinutes(90) }, NOW) as any;
    expect(out.expirePolicy).toBe('expire');
  });

  it('force 是合法选择（角色自己许下的具体承诺该照发）', () => {
    const out = parseFireScheduleArgs(
      { send_at: inMinutes(120), expire_policy: 'force', mode: 'prompted', prompt_hint: '汤炖好了叫他' },
      NOW,
    ) as any;
    expect(out.expirePolicy).toBe('force');
    expect(out.promptHint).toBe('汤炖好了叫他');
  });

  it('太近的时间打回：cron 一分钟一跳，排得更近等于让下一跳立刻捡走', () => {
    const justUnder = parseFireScheduleArgs({ send_at: inMinutes(0.5) }, NOW) as any;
    expect(justUnder.ok).toBe(false);
    expect(justUnder.reason).toBe('send_at_too_soon');
    // 边界：正好卡在最小提前量上要放行
    expect(parseFireScheduleArgs(
      { send_at: new Date(NOW + MIN_SCHEDULE_LEAD_MS).toISOString() },
      NOW,
    )).not.toHaveProperty('ok');
  });

  it('过去的时间打回', () => {
    expect((parseFireScheduleArgs({ send_at: inMinutes(-60) }, NOW) as any).ok).toBe(false);
  });

  it('send_at 缺失 / 不是时间 → 打回并说清该写成什么', () => {
    expect((parseFireScheduleArgs({}, NOW) as any).message).toContain('ISO 8601');
    expect((parseFireScheduleArgs({ send_at: '明天晚上' }, NOW) as any).message).toContain('ISO 8601');
  });

  it('prompted 缺方向 → 打回（不然到点那条不知道该说什么）', () => {
    const out = parseFireScheduleArgs({ send_at: inMinutes(90), mode: 'prompted' }, NOW) as any;
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('missing_prompt_hint');
  });

  it('枚举写错都各自打回', () => {
    expect((parseFireScheduleArgs({ send_at: inMinutes(90), mode: 'fixed' }, NOW) as any).reason).toBe('invalid_mode');
    expect((parseFireScheduleArgs({ send_at: inMinutes(90), recurrence: 'hourly' }, NOW) as any).reason).toBe('invalid_recurrence');
    expect((parseFireScheduleArgs({ send_at: inMinutes(90), expire_policy: 'maybe' }, NOW) as any).reason).toBe('invalid_expire_policy');
  });
});

// 用户的中转拒 tools 时走这层。认得太宽会把「我等下用 schedule_active_message 提醒你」
// 这种叙述当成真调用，直接排出一条任务。
describe('extractFireScheduleTextCalls', () => {
  it('认括号带 JSON 的写法', () => {
    const calls = extractFireScheduleTextCalls(
      `好，我等下再找你\n${AMSG_FIRE_SCHEDULE_TOOL}({"send_at":"2026-07-30T23:30:00Z","prompt_hint":"接着说猫"})`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ send_at: '2026-07-30T23:30:00Z', prompt_hint: '接着说猫' });
  });

  it('叙述里提到工具名但没有括号调用 → 不算', () => {
    expect(extractFireScheduleTextCalls(`我等下用 ${AMSG_FIRE_SCHEDULE_TOOL} 提醒你`)).toHaveLength(0);
    expect(extractFireScheduleTextCalls(`${AMSG_FIRE_SCHEDULE_TOOL}: 两小时后`)).toHaveLength(0);
  });

  it('参数写坏了仍算一次调用（交给 parse 回一句该怎么写，别把语法漏进正文）', () => {
    const calls = extractFireScheduleTextCalls(`${AMSG_FIRE_SCHEDULE_TOOL}({送两小时后})`);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({});
  });

  it('matched 是原始串，剥语法时靠它', () => {
    const text = `晚安\n${AMSG_FIRE_SCHEDULE_TOOL}({"send_at":"x"})`;
    const [call] = extractFireScheduleTextCalls(text);
    expect(text.split(call.matched).join('').trim()).toBe('晚安');
  });
});

describe('工具与说明块', () => {
  it('工具名与前台一致（角色不用学第二套）', () => {
    expect(buildFireScheduleTool().function.name).toBe('schedule_active_message');
  });

  it('native 模式不教正文语法，text 模式才教', () => {
    expect(buildFireScheduleBlock('native')).not.toContain('({"send_at"');
    expect(buildFireScheduleBlock('text')).toContain('({"send_at"');
  });

  it('expire_policy 描述把「角色自己许下的承诺」算进 force', () => {
    expect(EXPIRE_POLICY_DESCRIPTION).toContain('你自己许下的');
    expect(buildFireScheduleTool().function.parameters).toMatchObject({
      properties: { expire_policy: { description: EXPIRE_POLICY_DESCRIPTION } },
    });
  });
});

// 排程有三个入口（面板 / 前台工具 / fire 里的工具），指令必须一模一样，
// 否则同一个 mode 在不同入口生成出来的消息方向会不一样。
describe('buildTaskInstruction', () => {
  it('prompted 带上方向', () => {
    expect(buildTaskInstruction('prompted', '问问吃了没')).toContain('额外提示：问问吃了没');
  });

  it('auto 无灵感时写「无」，不留空', () => {
    expect(buildTaskInstruction('auto')).toContain('可选灵感补充：无');
  });
});

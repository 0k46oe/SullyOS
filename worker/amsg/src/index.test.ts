// worker/amsg/src/index.test.ts
// onBeforeFire 的四道门 —— 这个功能最关键的决策路径，一个判断写错位就是「该拦的没拦」
// 或者「全都不发」。门的顺序本身也是行为的一部分（注释里专门写过），一起钉住。
//
// 顺序：charId 校验 → 活跃会话租约(skip) → fire_pack 存在(否则抛) → 防穿帮闸(skip)
//      → 任务指令存在(否则抛) → 挂 scratch + 填槽返回
import { describe, it, expect, vi } from 'vitest';

import { amsgHooks, buildWorkerConfig, offloadOversizedPush, resolveVapidEmail } from './index';
import { MAX_PUSH_PAYLOAD_BYTES } from '@rei-standard/amsg-server/cloudflare';
import {
  AMSG_FIRE_PACK_KEY,
  AMSG_SLOT_CURRENT_TIME,
  AMSG_SLOT_TASK_INSTRUCTION,
  amsgStateNamespace,
  amsgXhsSessionKey,
  packStateValue,
} from '../../../utils/amsgFirePack';
import { AMSG_CHAT_PRESENCE_KEY } from '../../../utils/amsgChatPresence';
import { AMSG_TOOL_CONFIG_KEY, AMSG_TOOL_PACK_KEY } from '../../../utils/amsgToolPack';

const CHAR_ID = 'preset-nyah';
const NOW = new Date('2026-07-25T12:00:00.000Z');

const firePackValue = (lastUserMessageAt: number | null = null) => JSON.stringify({
  v: 2,
  template: `现在是 ${AMSG_SLOT_CURRENT_TIME}。\n${AMSG_SLOT_TASK_INSTRUCTION}`,
  lastUserMessageAt,
  tzOffsetMin: -480,
  targetName: '楪',
});

const presenceValue = (activeAt: number) => JSON.stringify({
  v: 1, charId: CHAR_ID, activeAt, lastUserMessageAt: activeAt,
});

// tool_pack / tool_config 与 fire_pack 同批原子上传，所以默认造齐——缺任何一份都是
// 云端状态异常，走抛错路径（见下面「缺 tool_pack → 抛错」那条）。
const toolPackValue = JSON.stringify({
  v: 1, charName: 'Nyah', xhsEnabled: false, activeMemoryMonths: [], memories: [],
});
const toolConfigValue = JSON.stringify({
  v: 1, proxyWorkerUrl: '', newsEnabled: false, notionEnabled: false, feishuEnabled: false,
});

/** 造一个 FireCtx；rows 是 readState 按 namespace 返回的内容。 */
const makeCtx = (opts: {
  metadata?: Record<string, unknown>;
  charRows?: Array<{ key: string; value: string }>;
  globalRows?: Array<{ key: string; value: string }>;
  recurrenceType?: string;
  nextSendAt?: string | null;
}) => {
  const charRows = opts.charRows ?? [
    { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
    { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
  ];
  const globalRows = opts.globalRows ?? [{ key: AMSG_TOOL_CONFIG_KEY, value: toolConfigValue }];
  const readState = vi.fn(async (namespace: string) =>
    namespace.startsWith('amsg:char:') ? charRows : globalRows);
  const scratch: Record<string, unknown> = {};
  return {
    ctx: {
      task: {
        id: 42,
        contactName: 'Nyah',
        recurrenceType: opts.recurrenceType ?? 'none',
        nextSendAt: opts.nextSendAt ?? '2026-07-25T12:00:00.000Z',
        metadata: {
          charId: CHAR_ID,
          amsgExpirePolicy: 'expire',
          amsgTaskInstruction: '问问对方吃了没',
          ...opts.metadata,
        },
      },
      userId: 'u1',
      readState,
      now: NOW,
      scratch,
    } as any,
    scratch,
    readState,
  };
};

describe('onBeforeFire 四道门', () => {
  it('正常路径：填好槽返回 prompt，并把工具状态挂上 scratch', async () => {
    const { ctx, scratch } = makeCtx({});
    const result = await amsgHooks.onBeforeFire(ctx);

    expect(Array.isArray(result)).toBe(true);
    const messages = result as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    // 槽位必须被填掉，不能把 {{AMSG_*}} 原样发给 LLM
    expect(messages[0].content).not.toContain(AMSG_SLOT_CURRENT_TIME);
    expect(messages[0].content).not.toContain(AMSG_SLOT_TASK_INSTRUCTION);
    expect(messages[0].content).toContain('问问对方吃了没');
    // scratch.fire 必须在返回 messages 之前挂好——onLLMOutput / executeToolCalls 全靠它
    expect(scratch.fire).toBeTruthy();
    expect((scratch.fire as any).occurrenceMs).toBe(Date.parse('2026-07-25T12:00:00.000Z'));
  });

  it('活跃会话租约新鲜 → skip，而且排在 fire_pack 检查之前（缺 fire_pack 也照样 skip）', async () => {
    const { ctx } = makeCtx({
      // 故意不给 fire_pack：如果 presence 门被挪到后面，这里会变成抛错而不是 skip
      charRows: [{ key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) }],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  it('force 策略不吃活跃租约这道门（闹钟型照发）', async () => {
    const { ctx } = makeCtx({
      metadata: { amsgExpirePolicy: 'force' },
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 5_000) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(Array.isArray(result)).toBe(true);
  });

  it('租约过期（超 TTL）不拦', async () => {
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_CHAT_PRESENCE_KEY, value: presenceValue(NOW.getTime() - 120_000) },
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue() },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(Array.isArray(result)).toBe(true);
  });

  it('防穿帮闸：一次性任务在锚点之后有新用户消息 → skip', async () => {
    const anchor = NOW.getTime() - 3600_000;
    const { ctx } = makeCtx({
      metadata: { amsgAnchorMs: anchor },
      // fire_pack 里的 lastUserMessageAt 晚于锚点 = 排程后用户又说话了
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(anchor + 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  it('防穿帮闸：锚点之后没有新用户消息 → 照发', async () => {
    const anchor = NOW.getTime() - 3600_000;
    const { ctx } = makeCtx({
      metadata: { amsgAnchorMs: anchor },
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: firePackValue(anchor - 60_000) },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(Array.isArray(result)).toBe(true);
  });

  // ─── 不降级：状态不完整一律抛错，不再退回排程时冻结的 prompt ───

  it('云端没有 fire_pack → 抛错（不降级）', async () => {
    const { ctx } = makeCtx({ charRows: [] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/AMSG2_FIRE_STATE_MISSING/);
  });

  it('fire_pack 解析失败 → 抛错（不降级）', async () => {
    const { ctx } = makeCtx({ charRows: [{ key: AMSG_FIRE_PACK_KEY, value: '{"v":1,"template":"老格式"}' }] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/AMSG2_FIRE_STATE_MISSING/);
  });

  // ─── 值压缩：前端压过的 fire_pack 要能读出来，没压过的老数据也要照常读 ───

  it('前端压过的 fire_pack 照常读出来', async () => {
    // 真实的 fire_pack 是几万字的角色设定加聊天记录，这里也得凑到那个量级：
    // 太短的内容压完反而更大，packStateValue 会按设计原样返回、测不到解压路径。
    const bulky = JSON.stringify({
      ...JSON.parse(firePackValue()),
      template: `${'【角色系统设定】你是一个会在深夜突然想起对方的人。\n'.repeat(400)}`
        + `现在是 ${AMSG_SLOT_CURRENT_TIME}。\n${AMSG_SLOT_TASK_INSTRUCTION}`,
    });
    const packed = await packStateValue(bulky);
    expect(packed.startsWith('gz1:'), '这个量级应该压得动').toBe(true);
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: packed },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    const messages = await amsgHooks.onBeforeFire(ctx) as Array<{ content: string }>;
    expect(messages[0].content).toContain('问问对方吃了没');
    expect(messages[0].content).not.toContain(AMSG_SLOT_CURRENT_TIME);
  });

  it('压过的值坏掉 → 抛错，不拿半截内容当 prompt 发出去', async () => {
    const { ctx } = makeCtx({
      charRows: [
        { key: AMSG_FIRE_PACK_KEY, value: 'gz1:bm90LWd6aXAtYXQtYWxs' },
        { key: AMSG_TOOL_PACK_KEY, value: toolPackValue },
      ],
    });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/AMSG2_FIRE_STATE_MISSING/);
  });

  it('云端没有 tool_pack → 抛错（和 fire_pack 同批上传，缺了就是状态异常，不给空壳继续）', async () => {
    const { ctx } = makeCtx({ charRows: [{ key: AMSG_FIRE_PACK_KEY, value: firePackValue() }] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/tool_pack/);
  });

  it('云端没有 tool_config → 抛错（同上）', async () => {
    const { ctx } = makeCtx({ globalRows: [] });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/tool_config/);
  });

  it('任务行 next_send_at 解析不出时间 → 抛错（occurrence 是闸和缓存键的必需字段）', async () => {
    const { ctx } = makeCtx({ nextSendAt: '不是时间' });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/next_send_at/);
  });

  it('任务缺 amsgTaskInstruction（旧格式）→ 抛错，不能用默认指令凑一个', async () => {
    const { ctx } = makeCtx({ metadata: { amsgTaskInstruction: undefined } });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/amsgTaskInstruction/);
  });

  it('任务 metadata 缺 charId → 抛错', async () => {
    const { ctx } = makeCtx({ metadata: { charId: undefined } });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/charId/);
  });
});

// ─── VAPID 配置兜底 ───
// scheduled() 在 !vapid.email 时会 console.error 后直接 return——整个 tick 一条任务都不处理。
// 而「推送凭据」面板复制出来的 env 里 VAPID_EMAIL 是注释掉的可选项，照着部署必然缺它，
// 表现是「到点了什么都不发、前端没有任何报错」。email 只是 VAPID JWT 的 sub（联系方式），
// 不影响签名有效性，缺省给一个合法 mailto 即可——instant-push worker 一直就是这么做的。
describe('VAPID 配置', () => {
  const baseEnv = {
    AMSG_MASTER_KEY: 'k'.repeat(64),
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    DB: {},
  } as any;

  it('没配 VAPID_EMAIL 时回退到合法 mailto，不能让 scheduled() 整轮跳过', () => {
    const config = buildWorkerConfig({ ...baseEnv, VAPID_EMAIL: undefined });
    expect(config.vapid.email).toMatch(/^mailto:/);
  });

  it('VAPID_EMAIL 只有空白字符时同样回退（空串一样会让 scheduled 跳过）', () => {
    const config = buildWorkerConfig({ ...baseEnv, VAPID_EMAIL: '   ' });
    expect(config.vapid.email).toMatch(/^mailto:/);
  });

  it('配了就用配的那个，不覆盖用户的联系方式', () => {
    const config = buildWorkerConfig({ ...baseEnv, VAPID_EMAIL: 'mailto:me@example.com' });
    expect(config.vapid.email).toBe('mailto:me@example.com');
  });

  it('解析函数本身：缺省/空白回退，配了就原样用', () => {
    expect(resolveVapidEmail(undefined)).toMatch(/^mailto:/);
    expect(resolveVapidEmail('')).toMatch(/^mailto:/);
    expect(resolveVapidEmail('  ')).toMatch(/^mailto:/);
    expect(resolveVapidEmail('mailto:a@b.c')).toBe('mailto:a@b.c');
  });
});

// 回归守卫：一条 Web Push 只装得下 3993 字节明文，而角色一次可能分享六七张笔记。
// 过去的做法是硬砍到 4 张，用户看到的是「说分享了 6 张、只出来 4 张卡」。现在按真实
// 字节算：装得下照装，装不下把整份挪进 client_state、push 只留引用键，一张不少。
describe('offloadOversizedPush — push 装不下时旁路存储', () => {
  const CLIENT_TASK_ID = 'task-uuid-1';
  const bigNote = (n: number) => ({
    idx: n,
    note: {
      noteId: `note-${n}`,
      title: `第 ${n} 篇笔记的标题`.repeat(4),
      desc: '描述'.repeat(60),
      likes: 100 + n,
      author: `作者${n}`,
      authorId: `author-${n}`,
      coverUrl: `https://example.com/cover-${n}-${'x'.repeat(40)}.jpg`,
    },
  });
  const pushWith = (noteCount: number) => ({
    messageKind: 'content',
    message: '看到几个好东西，分享给你～',
    title: '来自 小满',
    metadata: {
      charId: CHAR_ID,
      amsgClientTaskId: CLIENT_TASK_ID,
      directives: Array.from({ length: noteCount }, (_, i) => ({ type: 'xhs_share', idx: i + 1 })),
      xhsSession: {
        notes: Array.from({ length: noteCount }, (_, i) => bigNote(i + 1)),
        xsecTokens: [],
      },
    },
  });

  it('装得下就原样发，不碰云端状态（日常 1-3 张走的就是这条）', async () => {
    const writeState = vi.fn();
    const payload = pushWith(1);
    const out = await offloadOversizedPush(payload as any, writeState, CHAR_ID, CLIENT_TASK_ID);
    expect(out).toBe(payload);
    expect(writeState).not.toHaveBeenCalled();
  });

  it('装不下 → 整份 xhsSession 存进 client_state，push 换成引用键且回到限内', async () => {
    const writeState = vi.fn().mockResolvedValue({ upserted: 1, skipped: 0, deleted: 0 });
    const payload = pushWith(8);
    // 上限按 UTF-8 字节算，不是字符数——中文一个字三个字节，拿 .length 比会算漏一大截。
    const utf8Bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
    expect(utf8Bytes(payload)).toBeGreaterThan(MAX_PUSH_PAYLOAD_BYTES);

    const out = await offloadOversizedPush(payload as any, writeState, CHAR_ID, CLIENT_TASK_ID);

    const key = amsgXhsSessionKey(CLIENT_TASK_ID);
    expect(writeState).toHaveBeenCalledWith(amsgStateNamespace(CHAR_ID), [
      { key, value: JSON.stringify((payload.metadata as any).xhsSession) },
    ]);
    const meta = (out.metadata ?? {}) as Record<string, unknown>;
    expect(meta.xhsSessionRef).toBe(key);
    expect(meta.xhsSession).toBeUndefined();
    expect(meta.directives).toHaveLength(8);          // 引用一条不少，只是数据挪了地方
    expect(utf8Bytes(out)).toBeLessThanOrEqual(MAX_PUSH_PAYLOAD_BYTES);
  });

  it('老部署没有写入口 → 抛错走重试，绝不砍掉笔记凑合发出去', async () => {
    await expect(offloadOversizedPush(pushWith(8) as any, undefined, CHAR_ID, CLIENT_TASK_ID))
      .rejects.toThrow(/AMSG2_WRITE_STATE_UNSUPPORTED/);
  });

  it('超限但没有可旁路的内容 → 原样交给库抛 PUSH_PAYLOAD_TOO_LARGE，不假装成功', async () => {
    const writeState = vi.fn();
    const fat = { messageKind: 'content', message: '正'.repeat(2000), metadata: { charId: CHAR_ID } };
    const out = await offloadOversizedPush(fat as any, writeState, CHAR_ID, CLIENT_TASK_ID);
    expect(out).toBe(fat);
    expect(writeState).not.toHaveBeenCalled();
  });
});

// 服务端工具循环的编排：跑完一个工具之后跟模型说什么，以及重复调用怎么办。
// 这段是「amsg2 和前台行为对齐」的落点——前台每次回喂都明说「别再输出这个标签了」，
// worker 以前只回裸 JSON，模型看不出这一步已经做完，提示词里有句常驻的「先去查 X」
// 就会每轮照做、跑满上限，然后 AGENTIC_LOOP_EXCEEDED、任务不出清、下一分钟整条重跑。
describe('executeToolCalls 的工具编排', () => {
  const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
    id,
    function: { name, arguments: JSON.stringify(args) },
  });

  /** 造一个跑到 executeToolCalls 那一步的 sessionCtx（scratch.fire 由 onBeforeFire 挂好）。 */
  const readySession = async () => {
    const { ctx, scratch } = makeCtx({});
    await amsgHooks.onBeforeFire(ctx);
    return { sessionId: 'sess_task_42', scratch } as any;
  };

  it('回喂的不是裸 JSON，而是带「别重复」引导的一段话', async () => {
    const session = await readySession();
    const [out] = await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      session,
    );
    expect(out.content).not.toMatch(/^\{/);        // 不是裸 JSON
    expect(out.content).toContain('不要再来一遍');
    expect(out.content).toContain('调取某个月的记忆');
  });

  it('同名同参第二次直接打回，不再真跑一遍工具', async () => {
    const session = await readySession();
    const call = toolCall('c1', 'recall', { year: '2026', month: '06' });
    await amsgHooks.executeToolCalls([call], session);
    const [second] = await amsgHooks.executeToolCalls(
      [{ ...call, id: 'c2' }],
      session,
    );
    expect(second.content).toContain('没有再去查');
  });

  // 闸只拦「完全一样」的调用。换个月份是正当的多轮使用，拦了就是把能力砍了。
  it('换了参数照常放行——多轮能力不受影响', async () => {
    const session = await readySession();
    await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      session,
    );
    const [other] = await amsgHooks.executeToolCalls(
      [toolCall('c2', 'recall', { year: '2026', month: '07' })],
      session,
    );
    expect(other.content).not.toContain('没有再去查');
  });

  it('参数字段顺序变了仍算同一次调用', async () => {
    const session = await readySession();
    await amsgHooks.executeToolCalls(
      [toolCall('c1', 'recall', { year: '2026', month: '06' })],
      session,
    );
    const [reordered] = await amsgHooks.executeToolCalls(
      [toolCall('c2', 'recall', { month: '06', year: '2026' })],
      session,
    );
    expect(reordered.content).toContain('没有再去查');
  });
});

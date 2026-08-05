// worker/amsg/src/instantChat.test.ts
//
// 即时对话这条路上最要命的是「顺序」和「失败就别落任务」：云端状态没传上去却把任务
// 建了，到点那条 fire 会拿上一轮的上下文答这一轮的话——不报错、不重试，用户只会觉得
// 角色突然听不懂人话。下面每条都对着一种具体的坏法。
import { describe, it, expect, vi } from 'vitest';

import {
  buildInstantTimelyBlock,
  finalizeInstantPush,
  handleInstantChat,
  INSTANT_TICK_CRON,
  INSTANT_TICK_FALLBACK_WAIT_MS,
  isInstantChatTask,
  pullTaskDue,
  toOutboxEntries,
  writeChatOutbox,
} from './instantChat';
import { AMSG_CHAT_OUTBOX_KEY, CHAT_OUTBOX_MAX, amsgStateNamespace } from '../../../utils/amsgFirePack';

const USER_ID = '3637dae1-1461-4444-a747-34e406f67acc';
const TASK_UUID = '7a1f0b4c-2c9d-4a3e-8b21-9f0f3c5d7e11';

/** 客户端预加密的信封（内容不重要，形状要对）。 */
const envelope = (tag: string) => ({ iv: `iv-${tag}`, authTag: `tag-${tag}`, encryptedData: `data-${tag}` });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });

/** 记下每一次内部转发，顺序本身就是要钉的东西。 */
const makeUpstream = (opts: {
  clientState?: { status: number; body?: unknown };
  scheduleMessage?: { status: number; body?: unknown };
  cancelMessage?: { status: number; body?: unknown };
} = {}) => {
  const calls: Array<{ method: string; path: string; search: string; headers: Record<string, string>; body: string }> = [];
  const reply = (spec: { status: number; body?: unknown } | undefined, fallback: unknown) =>
    json(spec?.status ?? 200, spec?.body ?? fallback);
  const upstream = {
    fetch: vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      calls.push({
        method: request.method.toUpperCase(),
        path: url.pathname,
        search: url.search,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      if (url.pathname.endsWith('/client-state')) {
        return reply(opts.clientState, { success: true, data: { upserted: 3, skipped: 0 } });
      }
      if (url.pathname.endsWith('/cancel-message')) {
        return reply(opts.cancelMessage, { success: true, data: { uuid: 'old' } });
      }
      if (url.pathname.endsWith('/schedule-message')) {
        return reply(opts.scheduleMessage, { success: true, data: { uuid: TASK_UUID, id: 42 } });
      }
      return json(404, { success: false });
    }),
    scheduled: vi.fn(async (_event: { scheduledTime: number; cron: string }, _env?: unknown) => {}),
  };
  return { upstream, calls, paths: () => calls.map((c) => `${c.method} ${c.path}`) };
};

/** 假 D1：只认这个端点真正会发的那条 UPDATE。 */
const makeDb = (opts: { fails?: boolean } = {}) => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  return {
    statements,
    db: {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            if (opts.fails) throw new Error('d1 down');
            statements.push({ sql, values });
            return { meta: { changes: 1 } };
          },
        }),
      }),
    },
  };
};

const makeCtx = () => {
  const pending: Array<Promise<unknown>> = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } },
    settle: () => Promise.all(pending),
    count: () => pending.length,
  };
};

const post = (
  body: unknown,
  opts: { headers?: Record<string, string>; url?: string } = {},
) => new Request(opts.url ?? 'https://w.example/instant-chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-User-Id': USER_ID, ...(opts.headers ?? {}) },
  body: JSON.stringify(body),
});

const validBody = (extra: Record<string, unknown> = {}) => ({
  statePayload: envelope('state'),
  taskPayload: envelope('task'),
  ...extra,
});

/** 默认参数跑一次；sleep 默认换成不真等的替身，测试不为 15 秒的兜底等待卡住。 */
const run = (args: {
  request: Request;
  env?: Record<string, unknown>;
  upstream: ReturnType<typeof makeUpstream>['upstream'];
  ctx?: { waitUntil: (p: Promise<unknown>) => void };
  sleep?: (ms: number) => Promise<void>;
}) => handleInstantChat({
  request: args.request,
  env: (args.env ?? { DB: makeDb().db }) as any,
  ctx: args.ctx,
  upstream: args.upstream as any,
  json,
  sleep: args.sleep ?? (async () => {}),
});

describe('POST /instant-chat — 鉴权', () => {
  it('配了口令而请求没带 → 401，而且一个字节的云端状态都不写', async () => {
    const { upstream, calls } = makeUpstream();
    const response = await run({
      request: post(validBody()),
      env: { AMSG_SERVER_TOKEN: 'secret', DB: makeDb().db },
      upstream,
    });
    expect(response.status).toBe(401);
    // 回归守卫：没有这道门的话，转发出去的 PUT /client-state 会先把状态写进库，
    // 上游那边才 401——一个没通过鉴权的请求已经改了库里的数据。
    expect(calls).toHaveLength(0);
  });

  it('口令不对 → 401，同样不转发', async () => {
    const { upstream, calls } = makeUpstream();
    const response = await run({
      request: post(validBody(), { headers: { 'X-Client-Token': 'wrong' } }),
      env: { AMSG_SERVER_TOKEN: 'secret', DB: makeDb().db },
      upstream,
    });
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('口令对得上 → 放行，并把它原样带给上游（上游是权威，还要再验一次）', async () => {
    const { upstream, calls } = makeUpstream();
    const response = await run({
      request: post(validBody(), { headers: { 'X-Client-Token': 'secret' } }),
      env: { AMSG_SERVER_TOKEN: 'secret', DB: makeDb().db },
      upstream,
    });
    expect(response.status).toBe(202);
    expect(calls.every((c) => c.headers['x-client-token'] === 'secret')).toBe(true);
  });

  it('没配口令 → 不校验（跟上游同一套判据）', async () => {
    const { upstream } = makeUpstream();
    expect((await run({ request: post(validBody()), upstream })).status).toBe(202);
  });

  it('缺 X-User-Id / 不是 UUID v4 → 400，不转发', async () => {
    const { upstream, calls } = makeUpstream();
    const noUser = new Request('https://w.example/instant-chat', {
      method: 'POST', body: JSON.stringify(validBody()),
    });
    expect((await run({ request: noUser, upstream })).status).toBe(400);
    const badUser = post(validBody(), { headers: { 'X-User-Id': 'not-a-uuid' } });
    expect((await run({ request: badUser, upstream })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe('POST /instant-chat — 请求体', () => {
  it('不是 JSON 对象 → 400', async () => {
    const { upstream, calls } = makeUpstream();
    const bad = new Request('https://w.example/instant-chat', {
      method: 'POST', headers: { 'X-User-Id': USER_ID }, body: 'not json',
    });
    const response = await run({ request: bad, upstream });
    expect(response.status).toBe(400);
    expect((await response.json() as any).error.code).toBe('INVALID_JSON');
    expect(calls).toHaveLength(0);
  });

  it('两个信封形状不对 → 400，且在任何转发之前就挡住', async () => {
    const { upstream, calls } = makeUpstream();
    const noState = await run({ request: post({ taskPayload: envelope('t') }), upstream });
    expect(noState.status).toBe(400);
    expect((await noState.json() as any).error.code).toBe('INVALID_STATE_PAYLOAD');

    // taskPayload 不合格时同样一次都不转发——否则状态先写进去了，任务却建不成，
    // 云端留下一份「用户已经说了这句」而角色永远不会回。
    const noTask = await run({ request: post({ statePayload: envelope('s') }), upstream });
    expect(noTask.status).toBe(400);
    expect((await noTask.json() as any).error.code).toBe('INVALID_TASK_PAYLOAD');
    expect(calls).toHaveLength(0);
  });
});

describe('POST /instant-chat — 严格顺序与失败传播', () => {
  it('顺序：先传云端状态，再建任务', async () => {
    const { upstream, paths } = makeUpstream();
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(202);
    expect(paths()).toEqual(['PUT /client-state', 'POST /schedule-message']);
  });

  it('云端状态失败 → 原样把状态码报回去，而且**绝不建任务**', async () => {
    const { upstream, paths } = makeUpstream({
      clientState: { status: 400, body: { success: false, error: { code: 'TOO_MANY_STATE_ENTRIES' } } },
    });
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(400);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_STATE_FAILED');
    expect(body.error.step).toBe('client-state');
    expect(body.error.upstream.error.code).toBe('TOO_MANY_STATE_ENTRIES');
    // 回归守卫：这一步失败还往下建任务的话，到点那条 fire 会拿上一轮的上下文答这一轮。
    expect(paths()).toEqual(['PUT /client-state']);
  });

  it('建任务失败 → 报 schedule-message 那一步，不假装受理', async () => {
    const { upstream } = makeUpstream({
      scheduleMessage: { status: 409, body: { success: false, error: { code: 'PUSH_SUBSCRIPTION_MISSING' } } },
    });
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(409);
    const body = await response.json() as any;
    expect(body.error.code).toBe('INSTANT_CHAT_TASK_FAILED');
    expect(body.error.step).toBe('schedule-message');
  });

  it('上游回了 200 却没给 uuid → 502（跟不上这一轮，宁可让客户端重发）', async () => {
    const { upstream } = makeUpstream({ scheduleMessage: { status: 200, body: { success: true, data: {} } } });
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(502);
    expect((await response.json() as any).error.code).toBe('INSTANT_CHAT_TASK_UUID_MISSING');
  });

  it('转发带全套加密头：上游照常解密 + 鉴权，包装层不碰用户密钥', async () => {
    const { upstream, calls } = makeUpstream();
    await run({ request: post(validBody()), upstream });
    const state = calls.find((c) => c.path.endsWith('/client-state'))!;
    expect(state.headers['x-user-id']).toBe(USER_ID);
    expect(state.headers['x-payload-encrypted']).toBe('true');
    expect(state.headers['x-encryption-version']).toBe('1');
    // 信封原样搬运，不重新包一层
    expect(JSON.parse(state.body)).toEqual(envelope('state'));
    const task = calls.find((c) => c.path.endsWith('/schedule-message'))!;
    expect(JSON.parse(task.body)).toEqual(envelope('task'));
  });

  it('worker 挂在子路径下时，内部转发跟着挂载点走（上游按后缀匹配）', async () => {
    const { upstream, calls } = makeUpstream();
    await run({
      request: post(validBody(), { url: 'https://w.example/amsg/instant-chat' }),
      upstream,
    });
    expect(calls.map((c) => c.path)).toEqual(['/amsg/client-state', '/amsg/schedule-message']);
  });

  it('202 的形状是 { status: "accepted", uuid }', async () => {
    const { upstream } = makeUpstream();
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'accepted', uuid: TASK_UUID });
  });
});

describe('POST /instant-chat — 顶替上一条', () => {
  it('带 supersedesUuid → 夹在传状态和建任务之间发 DELETE', async () => {
    const { upstream, calls, paths } = makeUpstream();
    await run({ request: post(validBody({ supersedesUuid: 'old-uuid' })), upstream });
    expect(paths()).toEqual([
      'PUT /client-state', 'DELETE /cancel-message', 'POST /schedule-message',
    ]);
    expect(calls[1].search).toBe('?id=old-uuid');
  });

  it('上一条已经不在了（404）不影响主流程', async () => {
    const { upstream } = makeUpstream({ cancelMessage: { status: 404, body: { success: false } } });
    const response = await run({ request: post(validBody({ supersedesUuid: 'gone' })), upstream });
    expect(response.status).toBe(202);
  });

  it('不带 supersedesUuid 就不发取消（别把别人的任务顺手删了）', async () => {
    const { upstream, paths } = makeUpstream();
    await run({ request: post(validBody()), upstream });
    expect(paths()).not.toContain('DELETE /cancel-message');
  });
});

describe('POST /instant-chat — 立即起跳', () => {
  it('回完 202 之后把任务行拉到期并起一跳（不然要等到提前量过去才开跑）', async () => {
    const { upstream } = makeUpstream();
    const { db, statements } = makeDb();
    const { ctx, settle, count } = makeCtx();
    const response = await run({ request: post(validBody()), upstream, ctx, env: { DB: db } });

    expect(response.status).toBe(202);
    expect(count()).toBe(1);          // 起跳挂在 waitUntil 上，不拖住这次响应
    expect(upstream.scheduled).not.toHaveBeenCalled();

    await settle();
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('UPDATE scheduled_messages');
    expect(statements[0].values).toContain(TASK_UUID);
    expect(statements[0].values).toContain(USER_ID);
    expect(upstream.scheduled).toHaveBeenCalledTimes(1);
    expect((upstream.scheduled.mock.calls[0][0] as any).cron).toBe(INSTANT_TICK_CRON);
  });

  it('拉到期失败 → 先等过那个时刻再起跳（早跳一步只会空跑一轮）', async () => {
    const { upstream } = makeUpstream();
    const { ctx, settle } = makeCtx();
    const sleep = vi.fn(async () => {});
    await run({ request: post(validBody()), upstream, ctx, env: { DB: makeDb({ fails: true }).db }, sleep });
    await settle();
    expect(sleep).toHaveBeenCalledWith(INSTANT_TICK_FALLBACK_WAIT_MS);
    expect(upstream.scheduled).toHaveBeenCalledTimes(1);
  });

  it('起跳自己挂了不影响已经回出去的 202（cron 每分钟还会来捡）', async () => {
    const { upstream } = makeUpstream();
    upstream.scheduled.mockRejectedValueOnce(new Error('tick boom'));
    const { ctx, settle } = makeCtx();
    const response = await run({ request: post(validBody()), upstream, ctx });
    expect(response.status).toBe(202);
    await expect(settle()).resolves.toBeDefined();
  });

  it('运行时没给 ctx 也照常受理（任务已落库，交给 cron）', async () => {
    const { upstream } = makeUpstream();
    const response = await run({ request: post(validBody()), upstream });
    expect(response.status).toBe(202);
    expect(upstream.scheduled).not.toHaveBeenCalled();
  });
});

describe('pullTaskDue', () => {
  it('没有 D1 绑定时返回 false，不抛错', async () => {
    await expect(pullTaskDue(undefined, TASK_UUID, USER_ID, Date.now())).resolves.toBe(false);
  });

  it('只拉还没到点的那一行（已经到点的别去动它的触发时刻）', async () => {
    const { db, statements } = makeDb();
    await pullTaskDue(db, TASK_UUID, USER_ID, Date.UTC(2026, 7, 4, 3, 0));
    expect(statements[0].sql).toContain("status = 'pending'");
    expect(statements[0].sql).toContain('next_send_at > ?');
    expect(statements[0].values[0]).toBe('2026-08-04T03:00:00.000Z');
  });
});

describe('isInstantChatTask', () => {
  it('只认显式为 true 的那个标记', () => {
    expect(isInstantChatTask({ amsgInstantChat: true })).toBe(true);
    expect(isInstantChatTask({ amsgInstantChat: 'true' })).toBe(false);
    expect(isInstantChatTask({ charId: 'c' })).toBe(false);
    expect(isInstantChatTask(undefined)).toBe(false);
  });
});

describe('buildInstantTimelyBlock', () => {
  const base = {
    nowMs: Date.UTC(2026, 7, 1, 0, 0),
    tz: { tzId: 'Asia/Shanghai' },
    userTzId: 'Asia/Shanghai',
    targetName: '小明',
    timeAwarenessEnabled: true,
  };

  it('写清「现在几点」，用的是角色自己的时区', () => {
    const block = buildInstantTimelyBlock({ ...base, blocks: [] });
    expect(block).toContain('2026年8月1日 周六 早晨 08:00');
  });

  it('有时差时补一行「对方那边几点」，同时区不补（一份提示词里两个钟会打架）', () => {
    expect(buildInstantTimelyBlock({ ...base, userTzId: 'America/New_York', blocks: [] }))
      .toContain('对方所在时区参考');
    expect(buildInstantTimelyBlock({ ...base, blocks: [] })).not.toContain('对方所在时区参考');
  });

  // 关了时间感知的架空角色在前台连今天几号都读不到，云端这条路也不能偷偷报时。
  // 一个开关两套行为的话，同一个角色在聊天里说不出日期、在即时对话里却精确到分钟。
  it('关了时间感知就一个钟都不给（其余块照常拼）', () => {
    const block = buildInstantTimelyBlock({
      ...base,
      userTzId: 'America/New_York',
      timeAwarenessEnabled: false,
      blocks: ['\n\n【热搜】\n- 某某'],
    });
    expect(block).not.toContain('现在是');
    expect(block).not.toContain('2026年8月1日');
    expect(block).not.toContain('对方所在时区参考');
    expect(block).toContain('【此刻的系统信息·仅你可见】');
    expect(block).toContain('【热搜】');
  });

  it('空块整块跳过（拉不到实时世界时不能留一行空标题）', () => {
    const block = buildInstantTimelyBlock({ ...base, blocks: ['', '  ', '\n\n【热搜】\n- 某某'] });
    expect(block).toContain('【热搜】');
    expect(block.split('\n').filter((l) => l.trim() === '【】')).toHaveLength(0);
    expect(block.endsWith('- 某某')).toBe(true);
  });
});

describe('finalizeInstantPush — 信封按库的同一套规则先补好', () => {
  const ids = {
    taskRowId: '42', taskUuid: TASK_UUID, occurrenceMs: 1_700_000_000_000,
    nowMs: 1_700_000_001_000, randomId: 'rand',
  };

  it('messageId / sessionId 跟库自己会补的那一份逐字一致', () => {
    // 库：messageIdBase = `msg_task_${task.id}@${occurrenceMs}`，第 i 段是 `${base}_hook_${i}`；
    // sessionId = `sess_task_${task.id}@${occurrenceMs}`。对不上的话 outbox 里那份和真发
    // 出去的那份 id 不同，客户端补收时会把同一条消息再入库一遍。
    const first = finalizeInstantPush({ message: 'a' }, 0, 2, ids);
    const second = finalizeInstantPush({ message: 'b' }, 1, 2, ids);
    expect(first.messageId).toBe('msg_task_42@1700000000000_hook_0');
    expect(second.messageId).toBe('msg_task_42@1700000000000_hook_1');
    expect(first.sessionId).toBe('sess_task_42@1700000000000');
    expect(second.sessionId).toBe(first.sessionId);
    expect(first.messageIndex).toBe(1);
    expect(second.totalMessages).toBe(2);
  });

  it('没有任务行 id 时退回随机串（跟库的兜底同语义）', () => {
    const push = finalizeInstantPush({ message: 'a' }, 0, 1, { ...ids, taskRowId: null });
    expect(push.messageId).toBe('msg_rand_hook_0');
    expect(push.sessionId).toBe('sess_rand');
    expect(push.taskId).toBeNull();
  });

  it('原有字段原样保留（正文 / metadata 不能被信封覆盖掉）', () => {
    const push = finalizeInstantPush({ message: 'hi', metadata: { directives: [1] } }, 0, 1, ids);
    expect(push.message).toBe('hi');
    expect(push.metadata).toEqual({ directives: [1] });
    expect(push.occurrenceMs).toBe(ids.occurrenceMs);
    expect(push.taskUuid).toBe(TASK_UUID);
  });

  // 用户正盯着聊天窗口等这条回复，锁屏横幅在这时候弹出来纯属打扰（页面自己会把消息上屏）；
  // 窗口不可见时又必须弹，不然「发完就自由了」这件事没人来叫他。表态写在载荷里，
  // 真正的判定由 SW 的 shouldRenderNotification 按窗口可见性做。
  it('标 when-hidden：前台可见时 SW 不弹系统通知，不可见照弹', () => {
    const push = finalizeInstantPush(
      { message: 'hi', notification: { title: '来自 Nyah', body: 'hi' } }, 0, 1, ids);
    expect(push.notification).toEqual({ title: '来自 Nyah', body: 'hi', show: 'when-hidden' });
  });

  it('载荷本来没有 notification 就不凭空造一个（造出来只会弹一条空白横幅）', () => {
    const push = finalizeInstantPush({ message: 'hi' }, 0, 1, ids);
    expect(push).not.toHaveProperty('notification');
    // 形状不对的也当没有，别把它塞进一个对象里
    expect(finalizeInstantPush({ message: 'hi', notification: null }, 0, 1, ids).notification).toBeNull();
  });
});

describe('writeChatOutbox', () => {
  const entry = (id: string) => ({ messageId: id, sessionId: 's', at: 1, payload: { message: id } });

  it('写进角色 namespace 的 chat_outbox', async () => {
    const writeState = vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 0 }));
    const next = await writeChatOutbox(writeState, 'char-a', null, [entry('m1')]);
    expect(writeState).toHaveBeenCalledWith(amsgStateNamespace('char-a'), [
      { key: AMSG_CHAT_OUTBOX_KEY, value: JSON.stringify(next) },
    ]);
    expect(next!.entries.map((e) => e.messageId)).toEqual(['m1']);
  });

  it('环形只留最近 CHAT_OUTBOX_MAX 条', async () => {
    const writeState = vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 0 }));
    let outbox = null as any;
    for (let i = 0; i < CHAT_OUTBOX_MAX + 3; i += 1) {
      outbox = await writeChatOutbox(writeState, 'char-a', outbox, [entry(`m${i}`)]);
    }
    expect(outbox.entries).toHaveLength(CHAT_OUTBOX_MAX);
    expect(outbox.entries[0].messageId).toBe('m3');
  });

  it('写不进去不抛错，返回原来那份（这次照常发送，只是丢了兜底能力）', async () => {
    const writeState = vi.fn(async () => { throw new Error('write failed'); });
    await expect(writeChatOutbox(writeState, 'char-a', null, [entry('m1')])).resolves.toBeNull();
  });

  it('没有写入口（老部署）时安静跳过', async () => {
    await expect(writeChatOutbox(undefined, 'char-a', null, [entry('m1')])).resolves.toBeNull();
  });
});

describe('toOutboxEntries', () => {
  it('id 直接取定稿载荷上的那份（不再自己算一遍，算两遍就会漂）', () => {
    const payloads = [{ messageId: 'm0', sessionId: 's0', message: 'a' }];
    expect(toOutboxEntries(payloads, 99)).toEqual([
      { messageId: 'm0', sessionId: 's0', at: 99, payload: payloads[0] },
    ]);
  });
});

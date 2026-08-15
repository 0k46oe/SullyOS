// worker/amsg/src/plateFire.test.ts
// 后台任务（`metadata.amsgKind`）这条路的回归守卫。
//
// 这条路存在的意义就是「绕开聊天那一整套」，所以最该钉住的不是它做了什么，而是它
// **没被什么挡住**：聊天那四道门（活跃会话租约 / fire_pack 必须在场 / 防穿帮闸 /
// 任务指令必填）一道都不该拦它，onLLMOutput 的 stash 断言也不该拦它。分派点往后挪
// 一行，这些用例就会挂。
import { describe, it, expect, vi } from 'vitest';

import { amsgHooks } from './index';
import { AMSG_CHAT_PRESENCE_KEY } from '../../../utils/amsgChatPresence';
import { packStateValue } from '../../../utils/amsgFirePack';
import {
  PLATE_CONSOLIDATE_KIND,
  PLATE_CONSOLIDATE_RESULT_KIND,
  buildPlateJobInput,
  plateJobKey,
} from '../../../utils/amsgPlateJob';
import { AMSG_JOB_ID_KEY, AMSG_JOB_NAMESPACE, AMSG_TASK_KIND_KEY } from '../../../utils/amsgTaskKinds';

const CHAR_ID = 'preset-nyah';
const JOB_ID = 'job-0001';
const NOW = new Date('2026-08-15T12:00:00.000Z');

const jobInput = (overrides: Record<string, unknown> = {}) => buildPlateJobInput({
  charId: CHAR_ID,
  charName: 'Nyah',
  userName: '小明',
  identityContext: '（身份上下文）',
  rooms: [
    { room: 'user_room', entries: ['小明在读研'], entryIds: ['pe_a'] },
    { room: 'bedroom', entries: [], entryIds: [] },
  ],
  materials: [{ room: 'user_room', lines: ['小明这周搬去和同学合租了'] }],
  ...overrides,
} as any);

/**
 * 造一份跑门牌任务用的 ctx。
 * charRows 默认是**空的**——后台任务不传 fire_pack / tool_pack，这正是要钉的点。
 */
const makeCtx = (opts: {
  metadata?: Record<string, unknown>;
  jobValue?: string | null;
  charRows?: Array<{ key: string; value: string }>;
} = {}) => {
  const jobRows = opts.jobValue === null
    ? []
    : [{ key: plateJobKey(JOB_ID), value: opts.jobValue! }];
  const readState = vi.fn(async (namespace: string) => {
    if (namespace === AMSG_JOB_NAMESPACE) return jobRows;
    if (namespace.startsWith('amsg:char:')) return opts.charRows ?? [];
    return [];
  });
  const writeState = vi.fn(async () => ({ upserted: 1, skipped: 0, deleted: 1 }));
  const scratch: Record<string, unknown> = {};
  return {
    ctx: {
      task: {
        id: 7,
        uuid: 'task-uuid-plate',
        contactName: 'Nyah',
        recurrenceType: 'none',
        nextSendAt: NOW.toISOString(),
        metadata: {
          charId: CHAR_ID,
          [AMSG_TASK_KIND_KEY]: PLATE_CONSOLIDATE_KIND,
          [AMSG_JOB_ID_KEY]: JOB_ID,
          ...opts.metadata,
        },
      },
      userId: 'u1',
      readState,
      writeState,
      now: NOW,
      scratch,
    } as any,
    scratch,
    readState,
    writeState,
  };
};

const makeSessionCtx = (scratch: Record<string, unknown>, llmOutputText: string) => {
  const emitResult = vi.fn(async () => ({ messageId: 'm1', pushed: false }));
  const writeState = vi.fn(async () => ({ upserted: 0, skipped: 0, deleted: 1 }));
  return {
    ctx: {
      sessionId: 'sess-1',
      llmResponse: {},
      llmOutputText,
      contactName: 'Nyah',
      metadata: {},
      scratch,
      writeState,
      emitResult,
      taskId: 7,
      taskUuid: 'task-uuid-plate',
      occurrenceMs: NOW.getTime(),
    } as any,
    emitResult,
    writeState,
  };
};

const REPLY = JSON.stringify([
  { room: 'user_room', text: '小明在读研，最近搬去和同学合租', basedOn: 'U0', tag: '居住' },
]);

describe('后台任务分派：聊天那几道门一道都不该拦它', () => {
  it('没有 fire_pack 也照跑（聊天那条路在这儿是硬失败）', async () => {
    const { ctx } = makeCtx({ jobValue: await packStateValue(JSON.stringify(jobInput())) });
    const result = await amsgHooks.onBeforeFire(ctx) as { messages: Array<{ role: string; content: string }> };

    expect(result).toHaveProperty('messages');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('system');
    // 提示词确实是门牌那份（现有条目带标签、新材料在里面）
    expect(result.messages[0].content).toContain('[U0] 小明在读研');
    expect(result.messages[0].content).toContain('小明这周搬去和同学合租');
  });

  it('用户正在聊天（活跃会话租约新鲜）也照跑——后台整理不发消息，不用让路', async () => {
    const presence = JSON.stringify({
      v: 1, charId: CHAR_ID, activeAt: NOW.getTime(), lastUserMessageAt: NOW.getTime(),
    });
    const { ctx } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
      charRows: [{ key: AMSG_CHAT_PRESENCE_KEY, value: presence }],
      metadata: { amsgExpirePolicy: 'expire' },
    });
    const result = await amsgHooks.onBeforeFire(ctx);
    expect(result).toHaveProperty('messages');
  });

  it('没有 amsgTaskInstruction 也照跑（那是主动消息才要的东西）', async () => {
    const { ctx } = makeCtx({ jobValue: await packStateValue(JSON.stringify(jobInput())) });
    expect(ctx.task.metadata.amsgTaskInstruction).toBeUndefined();
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toHaveProperty('messages');
  });

  it('不认识的 kind 硬失败，报错里说得出该干什么', async () => {
    const { ctx } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
      metadata: { [AMSG_TASK_KIND_KEY]: 'something-new' },
    });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/不认识的任务种类.*重新部署/s);
  });

  it('没标 kind 的任务照旧走聊天主干（存量任务一条都不受影响）', async () => {
    const { ctx } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
      metadata: { [AMSG_TASK_KIND_KEY]: undefined },
    });
    // 走聊天主干 → 撞上「云端没有这个角色的 fire_pack」那道门
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/fire_pack/);
  });
});

describe('门牌整理 handler', () => {
  it('输入过期（job 行不在了）→ 安静跳过，不算失败', async () => {
    const { ctx } = makeCtx({ jobValue: null });
    await expect(amsgHooks.onBeforeFire(ctx)).resolves.toEqual({ skip: true });
  });

  it('输入形状坏了 → 硬失败（别拿半份材料整理出缺东西的门牌）', async () => {
    const { ctx } = makeCtx({ jobValue: await packStateValue('{"v":99}') });
    await expect(amsgHooks.onBeforeFire(ctx)).rejects.toThrow(/解析失败/);
  });

  it('跑完把结果送进收件箱、不弹通知，并删掉一次性输入', async () => {
    const { ctx: fireCtx, scratch } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
    });
    await amsgHooks.onBeforeFire(fireCtx);

    const { ctx, emitResult, writeState } = makeSessionCtx(scratch, REPLY);
    const decision = await amsgHooks.onLLMOutput(ctx);

    expect(decision).toEqual({ decision: 'skip-push', reason: 'plate-result-emitted' });
    expect(emitResult).toHaveBeenCalledTimes(1);
    const payload = (emitResult.mock.calls[0] as unknown as [any])[0];
    expect(payload.resultKind).toBe(PLATE_CONSOLIDATE_RESULT_KIND);
    expect(payload.charId).toBe(CHAR_ID);
    expect(payload.items).toHaveLength(1);
    // 背景工作不该把人叫回来看；show:false 时上游只落收件箱、不发推送。
    expect(payload.notification).toEqual({ show: false });
    // 提交时的条目 id 快照原样回传——客户端靠它把 basedOn 重新对准当前条目。
    expect(payload.rooms).toEqual([
      { room: 'user_room', entryIds: ['pe_a'] },
      { room: 'bedroom', entryIds: [] },
    ]);
    // 一次性输入跑完就删
    expect(writeState).toHaveBeenCalledWith(
      AMSG_JOB_NAMESPACE, [{ key: plateJobKey(JOB_ID), value: null }],
    );
  });

  it('LLM 一条都没吐出来 → 不送空结果（空列表会被客户端当成「清空门牌」）', async () => {
    const { ctx: fireCtx, scratch } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
    });
    await amsgHooks.onBeforeFire(fireCtx);

    const { ctx, emitResult, writeState } = makeSessionCtx(scratch, '模型今天不想说话');
    const decision = await amsgHooks.onLLMOutput(ctx);

    expect(decision).toEqual({ decision: 'skip-push', reason: 'plate-empty-generation' });
    expect(emitResult).not.toHaveBeenCalled();
    // 输入留着，重试还能再跑一次
    expect(writeState).not.toHaveBeenCalled();
  });

  it('老 worker 没有 emitResult → 说清楚原因，不静默', async () => {
    const { ctx: fireCtx, scratch } = makeCtx({
      jobValue: await packStateValue(JSON.stringify(jobInput())),
    });
    await amsgHooks.onBeforeFire(fireCtx);

    const { ctx } = makeSessionCtx(scratch, REPLY);
    delete (ctx as any).emitResult;
    await expect(amsgHooks.onLLMOutput(ctx)).resolves.toEqual({
      decision: 'skip-push', reason: 'plate-emit-result-unsupported',
    });
  });
});

describe('worker config', () => {
  it('一次性输入那个命名空间配了 TTL，角色状态那个没配', async () => {
    const { buildWorkerConfig } = await import('./index');
    const config = buildWorkerConfig({
      DB: { prepare: () => {} },
      AMSG_MASTER_KEY: 'k'.repeat(64),
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
    } as any) as any;

    expect(config.clientStateTtl).toEqual({ [AMSG_JOB_NAMESPACE]: 3 });
    // 角色状态（fire_pack / tool_pack）绝不能配 TTL——配了就是定时把角色的云端状态抹掉
    expect(Object.keys(config.clientStateTtl)).not.toContain('amsg:char:');
  });
});

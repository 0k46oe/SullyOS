// utils/amsg2ToolBridge.test.ts
// 回归守卫：角色在同一轮工具循环里连续排程/取消/续期时，本地清单必须累加。
// char 是生成开始时的快照，updateCharacter 只更 React state 不回写它——清单要是从
// char 上读写，第二次 schedule 就会读着空清单把第一条覆盖掉（「建俩只显示一个」）。
// 累加由 createAmsg2ToolSession 的本轮局部变量兜住，下面的用例钉的就是这件事。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: { scheduleCharacterTask: vi.fn(), cancelTask: vi.fn() },
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { getGlobalConfig: vi.fn() },
}));

import { createAmsg2ToolSession, executeAmsg2Tool } from './amsg2ToolBridge';
import { isAmsg2EnabledForChar } from './amsg2Tasks';
import { ActiveMsgClient } from './activeMsgClient';

const UUIDS = [
  'aaaaaaaa-0000-0000-0000-000000000000',
  'bbbbbbbb-0000-0000-0000-000000000000',
  'cccccccc-0000-0000-0000-000000000000',
];
const shortOf = (uuid: string) => uuid.slice(0, 8);

// 模拟 React：updateCharacter 只记录落盘的 config，绝不回写 char——
// 这样只有「session 自己兜住最新 config」才能让同轮后续调用读到累加结果。
const makeSession = () => {
  const char: any = { id: 'preset-x', name: 'Nyah', activeMsg2Config: { enabled: true, tasks: [] } };
  const persisted: any[] = [];
  const updateCharacter = vi.fn((_id: string, updates: any) => {
    if (updates.activeMsg2Config) persisted.push(updates.activeMsg2Config);
  });
  const deps = createAmsg2ToolSession({
    char, userProfile: {} as any, groups: [], realtimeConfig: {} as any,
    apiConfig: {} as any, updateCharacter,
  });
  return { deps, char, persisted };
};

const future = () => new Date(Date.now() + 3600_000).toISOString();
const lastTasks = (persisted: any[]) => persisted[persisted.length - 1]?.tasks ?? [];

describe('amsg2ToolBridge 同一轮多次调用累加', () => {
  beforeEach(() => {
    let n = 0;
    (ActiveMsgClient.scheduleCharacterTask as any).mockReset();
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => {
      const uuid = UUIDS[n++];
      return { uuid, clientTaskId: `cid-${uuid.slice(0, 4)}`, anchorMs: 0, replacedCancelFailed: false };
    });
    (ActiveMsgClient.cancelTask as any).mockReset();
    (ActiveMsgClient.cancelTask as any).mockResolvedValue({});
  });

  it('一轮内两次 schedule → 本地保留两条（回归：陈旧快照覆盖）', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);

    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t: any) => t.taskUuid)).toEqual([UUIDS[0], UUIDS[1]]);
  });

  it('一轮内 schedule×2 后按短 id 取消其一 → 剩下的是另一条', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    await executeAmsg2Tool('cancel_active_message', { task_id: shortOf(UUIDS[1]) }, deps);

    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskUuid).toBe(UUIDS[0]);
    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledWith(UUIDS[1]);
  });

  it('一轮内 schedule 后立刻 renew → 换成新 uuid、旧记录移除、模式沿用', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', {
      send_at: future(), mode: 'prompted', prompt_hint: '问问吃了没', recurrence: 'daily',
    }, deps);
    const renewResult = await executeAmsg2Tool('renew_active_message', {
      send_at: future(), task_id: shortOf(UUIDS[0]),
    }, deps);

    // 修复前这里会回「当前角色没有可续期的任务」——renew 也读不到同轮刚建的那条。
    expect(renewResult).not.toContain('没有可续期');
    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskUuid).toBe(UUIDS[1]);
    expect(tasks[0].mode).toBe('prompted');
    expect(tasks[0].promptHint).toBe('问问吃了没');
    expect(tasks[0].recurrenceType).toBe('daily');
    // 旧任务的远端取消由 scheduleCharacterTask 内部「先建后删」负责，bridge 的职责是
    // 把要替换的 uuid 传下去——这里钉的是 bridge 这一侧。
    expect(ActiveMsgClient.scheduleCharacterTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ replaceTaskUuid: UUIDS[0] }),
    );
  });

  it('一轮内 schedule 后 list → 列得出刚建的那条', async () => {
    const { deps } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    const listed = await executeAmsg2Tool('list_active_messages', {}, deps);

    expect(listed).toContain(shortOf(UUIDS[0]));
    expect(listed).not.toContain('没有任何定时主动消息任务');
  });

  it('远端取消失败 → 本地记录保留并标错，不留「看不见的幽灵任务」', async () => {
    const { deps, persisted } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    (ActiveMsgClient.cancelTask as any).mockRejectedValueOnce(new Error('worker 503'));
    const result = await executeAmsg2Tool('cancel_active_message', { task_id: shortOf(UUIDS[0]) }, deps);

    expect(result).toContain('失败');
    const tasks = lastTasks(persisted);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].taskUuid).toBe(UUIDS[0]);
    expect(tasks[0].lastError).toBeTruthy();
  });

  it('累加不靠就地改 char：React state 里的角色对象不被写脏', async () => {
    const { deps, char } = makeSession();
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);

    // 落盘走 updateCharacter，char 快照本身保持原样（它是 React state 里的对象）。
    expect(char.activeMsg2Config.tasks).toEqual([]);
    // 但 session 读得到累加后的两条。
    expect(deps.getConfig()?.tasks).toHaveLength(2);
  });
});

// ─── 角色级开关 ───
// 设置面板「关闭 2.0」会持久化 activeMsg2Config.enabled=false。工具注入这条路要是只看
// 全局 workerUrl，被关掉的角色照样拿得到 schedule_active_message；再加上落盘时强写
// enabled:true，一次工具调用就把用户显式关掉的功能又打开了。两头都得钉住。
describe('角色级开关 enabled=false', () => {
  const charWith = (config: any) => ({ id: 'preset-x', name: 'Nyah', activeMsg2Config: config } as any);

  it('关掉的角色不给注入工具', () => {
    expect(isAmsg2EnabledForChar(charWith({ enabled: false, tasks: [] }))).toBe(false);
  });

  it('开着的角色照常注入', () => {
    expect(isAmsg2EnabledForChar(charWith({ enabled: true, tasks: [] }))).toBe(true);
  });

  it('从没配过 2.0 的角色算开启（默认可用，不需要先进面板点一下）', () => {
    expect(isAmsg2EnabledForChar(charWith(undefined))).toBe(true);
  });

  it('落盘不把 enabled 改写成 true（工具调用不得替用户重新开启功能）', async () => {
    let n = 0;
    (ActiveMsgClient.scheduleCharacterTask as any).mockImplementation(async () => ({
      uuid: UUIDS[n++], clientTaskId: 'cid', anchorMs: 0, replacedCancelFailed: false,
    }));
    const char: any = charWith({ enabled: false, tasks: [] });
    const persisted: any[] = [];
    const deps = createAmsg2ToolSession({
      char, userProfile: {} as any, groups: [], realtimeConfig: {} as any, apiConfig: {} as any,
      updateCharacter: (_id: string, updates: any) => {
        if (updates.activeMsg2Config) persisted.push(updates.activeMsg2Config);
      },
    });
    await executeAmsg2Tool('schedule_active_message', { send_at: future() }, deps);

    expect(persisted[persisted.length - 1].enabled).toBe(false);
  });
});

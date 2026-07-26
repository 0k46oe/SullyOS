// utils/activeMsgClient.test.ts
// 回归守卫：
//   1. 云端状态上传「不降级」。过去这一步失败只 warn，任务照建，到点用排程那刻冻结的
//      prompt 发——用户收到旧上下文却完全不知道。现在网络抖动重试、最终失败必须抛错。
//   2. 取消任务幂等。远端已经没有那一条时（一次性任务发完就删行）不能报「取消失败」。
//   3. 按角色对账要认得出「老 worker 没投影 charId」，不能把它当成「远端一条都没有」。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { ActiveMsgClient, putClientStateOrThrow, toRemoteAvatarUrl } from './activeMsgClient';

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000001';

// cancelTask 要走 ensureWorkerReady（读 IndexedDB 里的 worker 地址），测里给一份固定配置。
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    ensureUserId: async () => TEST_USER_ID,
    getGlobalConfig: async () => ({
      userId: TEST_USER_ID,
      workerUrl: 'https://amsg.example.workers.dev',
      serverToken: '',
    }),
  },
}));

const ENTRIES = [{ namespace: 'amsg:char:x', key: 'fire_pack', value: '{}', updatedAt: 1 }];

/** 只需要 putClientState 这一个方法，其余 InternalReiClient 成员用不到。 */
const clientWith = (impl: any) => ({ putClientState: impl } as any);

// 假时钟：重试退避是真的 setTimeout（400ms + 1200ms），实测跑满 4s。
// 用 advanceTimersByTimeAsync 把等待推掉，测的还是同一段逻辑。
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** 起 promise + 把退避时钟推完，返回 promise 供断言。 */
const runWithTimers = <T>(promise: Promise<T>): Promise<T> => {
  void vi.advanceTimersByTimeAsync(5_000);
  return promise;
};

describe('putClientStateOrThrow', () => {
  it('一次成功 → 不重试', async () => {
    const put = vi.fn().mockResolvedValue({ success: true });
    await putClientStateOrThrow(clientWith(put), ENTRIES, '上传云端状态');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('抛异常后重试，第二次成功 → 不抛错', async () => {
    const put = vi.fn()
      .mockRejectedValueOnce(new Error('network hiccup'))
      .mockResolvedValueOnce({ success: true });
    await runWithTimers(putClientStateOrThrow(clientWith(put), ENTRIES, '上传云端状态'));
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('回 { success: false } 也算失败并重试（只 try/catch 会漏掉这种）', async () => {
    const put = vi.fn()
      .mockResolvedValueOnce({ success: false, error: { message: 'D1 busy' } })
      .mockResolvedValueOnce({ success: true });
    await runWithTimers(putClientStateOrThrow(clientWith(put), ENTRIES, '上传云端状态'));
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('三次都失败 → 抛错（绝不静默降级）', async () => {
    const put = vi.fn().mockRejectedValue(new Error('worker down'));
    await expect(runWithTimers(putClientStateOrThrow(clientWith(put), ENTRIES, '上传云端状态')))
      .rejects.toThrow(/worker down/);
    expect(put).toHaveBeenCalledTimes(3);
  });

  it('条目被 worker 点名 rejected → 立刻抛错、不重试（重试不会变好）', async () => {
    const put = vi.fn().mockResolvedValue({
      success: true,
      data: { rejected: [{ key: 'fire_pack', message: 'value too large' }] },
    });
    await expect(putClientStateOrThrow(clientWith(put), ENTRIES, '上传云端状态'))
      .rejects.toThrow(/fire_pack\(value too large\)/);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('打到网页而不是 Worker（拿到 HTML）时给可读的错误', async () => {
    const put = vi.fn().mockRejectedValue(new Error(`Unexpected token '<'`));
    await expect(runWithTimers(putClientStateOrThrow(clientWith(put), ENTRIES, '上传云端状态')))
      .rejects.toThrow(/没有打到 Worker/);
  });
});

describe('ActiveMsgClient.cancelTask', () => {
  /** safeResponseJson 只读 status 和 text()，够撑起一个假 Response。 */
  const respondWith = (status: number, body: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue({ status, text: async () => JSON.stringify(body) });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  afterEach(() => { vi.unstubAllGlobals(); });

  it('远端确实删掉了 → 成功', async () => {
    respondWith(200, { success: true, data: { uuid: 'task-1', message: '任务已成功取消' } });
    await expect(ActiveMsgClient.cancelTask('task-1'))
      .resolves.toMatchObject({ uuid: 'task-1', alreadyGone: false });
  });

  it('远端本来就没有这一条 → 也算取消成功（终态已达成，没什么可重试的）', async () => {
    respondWith(404, {
      success: false,
      error: { code: 'TASK_NOT_FOUND', message: '指定的任务不存在或已被删除' },
    });
    await expect(ActiveMsgClient.cancelTask('task-gone'))
      .resolves.toMatchObject({ uuid: 'task-gone', alreadyGone: true });
  });

  it('其它错误照常抛，别顺手一起吞掉', async () => {
    respondWith(500, {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' },
    });
    await expect(ActiveMsgClient.cancelTask('task-1')).rejects.toThrow(/服务器内部错误/);
  });

  it('鉴权失败照常抛（共享密钥填错时必须看得见）', async () => {
    respondWith(401, {
      success: false,
      error: { code: 'INVALID_CLIENT_TOKEN', message: '客户端令牌无效' },
    });
    await expect(ActiveMsgClient.cancelTask('task-1')).rejects.toThrow(/客户端令牌无效/);
  });
});

// 回归守卫：老 worker（< 2.6.0-next.5）的 GET /messages 不投影 charId，按角色过滤会
// 一条都留不下。要是照直返回空数组，面板会把该角色的任务全标成「远端不存在」，
// 「关闭 2.0」也会以为没什么要取消——两处都是拿半份证据下结论。
describe('ActiveMsgClient.listRemoteTaskUuidsForChar', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('worker 有投影 → 只留本角色的 uuid', async () => {
    vi.spyOn(ActiveMsgClient, 'listAllTasks').mockResolvedValue([
      { uuid: 'task-a', charId: 'char-1' },
      { uuid: 'task-b', charId: 'char-2' },
      { charId: 'char-1' },
    ]);
    await expect(ActiveMsgClient.listRemoteTaskUuidsForChar('char-1')).resolves.toEqual(['task-a']);
  });

  it('老 worker 没投影（远端有任务、charId 全空）→ 抛错交给调用方降级', async () => {
    vi.spyOn(ActiveMsgClient, 'listAllTasks').mockResolvedValue([
      { uuid: 'task-a' },
      { uuid: 'task-b', charId: null },
    ]);
    await expect(ActiveMsgClient.listRemoteTaskUuidsForChar('char-1'))
      .rejects.toThrow(/重新粘贴部署/);
  });

  it('远端确实一条任务都没有 → 空数组（跟版本无关，别误伤）', async () => {
    vi.spyOn(ActiveMsgClient, 'listAllTasks').mockResolvedValue([]);
    await expect(ActiveMsgClient.listRemoteTaskUuidsForChar('char-1')).resolves.toEqual([]);
  });
});

// 回归守卫：删角色 / 关闭 2.0 都要把该角色的远端任务清干净——worker 上的任务不随本地
// 删除消失，留着会到点照跑一整轮生成 + 推送（角色都没了还在发消息，每次真烧一轮 LLM）。
describe('ActiveMsgClient.cancelAllTasksForChar', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('以远端清单为准（本地漏掉的「已过点未消费」任务也要取消到）', async () => {
    vi.spyOn(ActiveMsgClient, 'listRemoteTaskUuidsForChar').mockResolvedValue(['remote-1', 'remote-2']);
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask')
      .mockResolvedValue({ uuid: '', alreadyGone: false });

    const { targets, failed } = await ActiveMsgClient.cancelAllTasksForChar('char-1', ['local-only']);
    expect(targets).toEqual(['remote-1', 'remote-2']);
    expect(failed.size).toBe(0);
    expect(cancel.mock.calls.map((c) => c[0])).toEqual(['remote-1', 'remote-2']);
  });

  it('远端读不到（老 worker / 断网）→ 退回本地清单，半份证据也比不取消强', async () => {
    vi.spyOn(ActiveMsgClient, 'listRemoteTaskUuidsForChar').mockRejectedValue(new Error('offline'));
    const cancel = vi.spyOn(ActiveMsgClient, 'cancelTask')
      .mockResolvedValue({ uuid: '', alreadyGone: false });

    const { targets } = await ActiveMsgClient.cancelAllTasksForChar('char-1', ['local-1', 'local-2']);
    expect(targets).toEqual(['local-1', 'local-2']);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('单条取消失败只记账，剩下的照样取消完', async () => {
    vi.spyOn(ActiveMsgClient, 'listRemoteTaskUuidsForChar').mockResolvedValue(['t1', 't2', 't3']);
    vi.spyOn(ActiveMsgClient, 'cancelTask').mockImplementation(async (uuid: string) => {
      if (uuid === 't2') throw new Error('D1 busy');
      return { uuid, alreadyGone: false };
    });

    const { failed } = await ActiveMsgClient.cancelAllTasksForChar('char-1', []);
    expect([...failed]).toEqual(['t2']);
  });
});

// 回归守卫：本地角色头像是 base64，直接塞进排程请求会被 worker 拒掉并 warn
// （`avatarUrl 不合法，已置空`），每排一条任务刷一条。这里按 worker 同一把尺先筛。
describe('toRemoteAvatarUrl', () => {
  it('公网 http(s) 图片 URL → 原样传', () => {
    expect(toRemoteAvatarUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(toRemoteAvatarUrl('http://example.com/a.png')).toBe('http://example.com/a.png');
  });

  it('base64 data URI → 不传（worker 明确拒收 data:）', () => {
    expect(toRemoteAvatarUrl('data:image/png;base64,iVBORw0KGgo=')).toBeUndefined();
    expect(toRemoteAvatarUrl('DATA:image/png;base64,iVBORw0KGgo=')).toBeUndefined();
  });

  it('超过 2048 字符 → 不传（worker 的长度上限）', () => {
    expect(toRemoteAvatarUrl(`https://example.com/${'a'.repeat(2048)}.png`)).toBeUndefined();
  });

  it('空 / 不是 URL / 非 http 协议 → 不传', () => {
    expect(toRemoteAvatarUrl(undefined)).toBeUndefined();
    expect(toRemoteAvatarUrl('   ')).toBeUndefined();
    expect(toRemoteAvatarUrl('./avatars/sully.png')).toBeUndefined();
    expect(toRemoteAvatarUrl('blob:http://localhost/abc')).toBeUndefined();
  });
});

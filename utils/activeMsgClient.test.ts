// utils/activeMsgClient.test.ts
// 回归守卫：
//   1. 云端状态上传「不降级」。过去这一步失败只 warn，任务照建，到点用排程那刻冻结的
//      prompt 发——用户收到旧上下文却完全不知道。现在网络抖动重试、最终失败必须抛错。
//   2. 取消任务幂等。远端已经没有那一条时（一次性任务发完就删行）不能报「取消失败」。
//   3. 按角色对账要认得出「老 worker 没投影 charId」，不能把它当成「远端一条都没有」。
//   4. 「清除云端状态」清完必须把全局工具凭据补回去（它没有别的补写时机）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// clearClientState 走的是库客户端而不是 fetchWithAuth，这里把整个客户端换成假的。
const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn(),
    clearClientState: vi.fn(),
    putClientState: vi.fn(),
    getClientState: vi.fn(),
    getCapabilities: vi.fn(),
    getVapidPublicKey: vi.fn(),
    subscribePush: vi.fn(),
    updateMessage: vi.fn(),
  },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
// ensurePushSubscription 会先跑 KeepAlive.init()（注册 SW 等浏览器副作用），测里桩掉。
vi.mock('./keepAlive', () => ({ KeepAlive: { init: vi.fn().mockResolvedValue(undefined) } }));

import {
  ActiveMsgClient, buildFirePack, clearNamespaceValuesOrThrow, dropStaleSubscription,
  putClientStateOrThrow, toRemoteAvatarUrl,
} from './activeMsgClient';
import { AMSG_SLOT_CURRENT_TIME } from './amsgFirePack';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';

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
  /** safeResponseJson 读 status、text() 和 headers（content-type），假 Response 三样都要有。 */
  const respondWith = (status: number, body: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue({
      status,
      text: async () => JSON.stringify(body),
      headers: new Headers({ 'content-type': 'application/json' }),
    });
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

// 回归守卫：删角色时清云端 client_state 的清法。
// 一个角色的条目不止 fire_pack / tool_pack —— 还有活跃会话租约，以及键名带 clientTaskId
// 的旁路存储（`xhs_session:<id>`，任务记录被 prune 掉之后就再也拼不出来）。所以清法是
// 「先读回来有什么、再把有内容的写空」，而不是照着已知键名盲写：putClientState 是 upsert，
// 盲写会把本来不存在的条目建出来，清理反倒变成新建。
describe('clearNamespaceValuesOrThrow', () => {
  const clientWithState = (entries: any[], put = vi.fn().mockResolvedValue({ success: true })) => ({
    getClientState: vi.fn().mockResolvedValue({ success: true, data: { entries } }),
    putClientState: put,
  } as any);

  it('读回来有什么清什么，一次请求写空（xhs_session 这种拼不出的键也在内）', async () => {
    const put = vi.fn().mockResolvedValue({ success: true });
    const client = clientWithState([
      { key: 'fire_pack', value: '{"v":2}' },
      { key: 'tool_pack', value: '{}' },
      { key: 'chat_presence', value: '{}' },
      { key: 'xhs_session:2f1c-任务id', value: '{"notes":[]}' },
    ], put);

    const cleared = await clearNamespaceValuesOrThrow(client, 'amsg:char:char-1');

    expect(cleared).toEqual(['fire_pack', 'tool_pack', 'chat_presence', 'xhs_session:2f1c-任务id']);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0].map((e: any) => [e.namespace, e.key, e.value])).toEqual([
      ['amsg:char:char-1', 'fire_pack', ''],
      ['amsg:char:char-1', 'tool_pack', ''],
      ['amsg:char:char-1', 'chat_presence', ''],
      ['amsg:char:char-1', 'xhs_session:2f1c-任务id', ''],
    ]);
  });

  it('namespace 是空的 → 一条都不写（别把不存在的键 upsert 出来）', async () => {
    const put = vi.fn().mockResolvedValue({ success: true });
    await expect(clearNamespaceValuesOrThrow(clientWithState([], put), 'amsg:char:char-1'))
      .resolves.toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });

  it('已经是空壳的条目跳过（重复删同一个角色不白发请求体）', async () => {
    const put = vi.fn().mockResolvedValue({ success: true });
    const client = clientWithState([
      { key: 'fire_pack', value: '' },
      { key: 'tool_pack', value: '{}' },
    ], put);

    await expect(clearNamespaceValuesOrThrow(client, 'amsg:char:char-1')).resolves.toEqual(['tool_pack']);
    expect(put.mock.calls[0][0]).toHaveLength(1);
  });

  it('读不到云端状态 → 抛错（调用方按「没清掉」提示，不能当成清干净了）', async () => {
    const client = {
      getClientState: vi.fn().mockResolvedValue({ success: false, error: { message: 'D1 busy' } }),
      putClientState: vi.fn(),
    } as any;
    await expect(clearNamespaceValuesOrThrow(client, 'amsg:char:char-1')).rejects.toThrow(/D1 busy/);
    expect(client.putClientState).not.toHaveBeenCalled();
  });

  it('写空失败 → 抛错', async () => {
    const client = clientWithState(
      [{ key: 'fire_pack', value: '{"v":2}' }],
      vi.fn().mockRejectedValue(new Error('worker down')),
    );
    await expect(runWithTimers(clearNamespaceValuesOrThrow(client, 'amsg:char:char-1')))
      .rejects.toThrow(/worker down/);
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

// 回归守卫：「清除云端状态」之后 AI 任务必须还能跑。
//
// 实测踩过：点完那个按钮，聊多少轮天任务都一直失败。云端有三份数据，角色上下文
// (fire_pack) 和角色工具数据 (tool_pack) 每轮聊完都会重新同步，只有全局的 tool_config
// 是「改配置时才传」——清空之后没有任何一条路会补它，而 worker 到点三份缺一就硬失败。
// 弹窗还写着「下次聊天会重新同步」，等于界面在骗人。
//
// 任务表跟 client_state 不在一起、不受清空影响，所以「任务还活着、凭据却没了」
// 只有这一个入口。补传就放在这里，不必让每轮同步都白传一遍。
describe('ActiveMsgClient.clearClientState', () => {
  beforeEach(() => {
    reiClient.init.mockReset().mockResolvedValue(undefined);
    reiClient.clearClientState.mockReset().mockResolvedValue({ success: true, data: { deleted: 7 } });
    reiClient.putClientState.mockReset().mockResolvedValue({ success: true });
  });

  const toolConfigEntries = () => reiClient.putClientState.mock.calls.flatMap((c: any[]) => c[0]);

  it('清完立刻把全局 tool_config 补回去', async () => {
    const result = await ActiveMsgClient.clearClientState({ newsEnabled: true } as any);

    expect(result).toEqual({ deleted: 7, toolConfigRestored: true });
    const entries = toolConfigEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ namespace: 'amsg:global', key: 'tool_config' });
    expect(JSON.parse(entries[0].value)).toMatchObject({ v: 1, newsEnabled: true });
  });

  it('顺序是先清后补，别把刚补的又清掉', async () => {
    const order: string[] = [];
    reiClient.clearClientState.mockImplementation(async () => {
      order.push('clear');
      return { success: true, data: { deleted: 1 } };
    });
    reiClient.putClientState.mockImplementation(async () => {
      order.push('put');
      return { success: true };
    });

    await ActiveMsgClient.clearClientState(undefined);
    expect(order).toEqual(['clear', 'put']);
  });

  it('没配实时感知也照样补一份（工具全关的凭据也是凭据，缺了 worker 一样硬失败）', async () => {
    await ActiveMsgClient.clearClientState(undefined);
    expect(toolConfigEntries()).toHaveLength(1);
  });

  it('补传失败 → 清空本身仍算成功，用返回值让调用方去提示', async () => {
    reiClient.putClientState.mockRejectedValue(new Error('offline'));
    await expect(runWithTimers(ActiveMsgClient.clearClientState(undefined)))
      .resolves.toEqual({ deleted: 7, toolConfigRestored: false });
  });

  it('清空本身失败 → 抛错，也不去补传（云端还是原样）', async () => {
    reiClient.clearClientState.mockResolvedValue({ success: false, error: { message: 'D1 busy' } });
    await expect(ActiveMsgClient.clearClientState(undefined)).rejects.toThrow(/D1 busy/);
    expect(reiClient.putClientState).not.toHaveBeenCalled();
  });
});

// 回归守卫：按 namespace 写空的清法只服务「删角色」。要是哪天被顺手用在全局
// namespace 上，tool_config 会被清成空壳 —— 症状跟上面那条一模一样，而且更隐蔽
// （不是删行，是留个空值，读得到但 parse 不出来）。
describe('clearNamespaceValuesOrThrow 的全局 namespace 护栏', () => {
  it('全局 namespace 直接拒绝，一个请求都不发', async () => {
    const getClientState = vi.fn();
    await expect(clearNamespaceValuesOrThrow({ getClientState } as any, 'amsg:global'))
      .rejects.toThrow(/全局云端状态不能按 namespace 清空/);
    expect(getClientState).not.toHaveBeenCalled();
  });
});

// 回归守卫（时区统一 ①）：fire_pack 的时间参照系与「模板不烤时间」。
//   - tzId：角色开了自定义时区用角色的，没开用设备的（worker 渲染一切时间的参照系）；
//   - 烤进模板的 buildSystemPrompt 必须收到 skipTimeAwareness——否则「现在是 X」被
//     烤死在模板里，到点渲染时就是一句过期的时间，和槽位现算的当前时间打架；
//   - 【角色系统设定】之后补一行「设定是快照，与当前时刻矛盾以当前本地时间为准」；
//   - 槽位不动：当前时间仍由 worker 到点用 AMSG_SLOT_CURRENT_TIME 现算填入。
describe('buildFirePack 的时区参照系与模板（①）', () => {
  const baseChar = (over: Record<string, unknown> = {}) => ({
    id: 'char-1',
    name: '小满',
    memories: [],
    ...over,
  }) as any;
  const user = { name: '楪' } as any;

  // 具体的 MockInstance 泛型跟着 buildSystemPrompt 的 11 个参数走，写全没有信息量。
  let systemPromptSpy: { mock: { calls: unknown[][] } };

  beforeEach(() => {
    // 模板本体不在被测范围：桩掉重依赖，测打包逻辑本身。
    vi.spyOn(DB, 'getRecentMessagesByCharId').mockResolvedValue([] as any);
    systemPromptSpy = vi.spyOn(ChatPrompts, 'buildSystemPrompt').mockResolvedValue('SYS_PROMPT_MARKER');
    vi.spyOn(ChatPrompts, 'buildMessageHistory').mockReturnValue({ apiMessages: [] } as any);
    vi.spyOn(ChatPrompts, 'filterVisibleEmojis').mockReturnValue({ emojis: [], categories: [] } as any);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const pack = (char: any) => buildFirePack(char, user, [], undefined, { all: [], categories: [] });

  it('角色开了自定义时区 → tzId 用角色的', async () => {
    const out = await pack(baseChar({ customTimezoneEnabled: true, customTimezone: 'Asia/Tokyo' }));
    expect(out.tzId).toBe('Asia/Tokyo');
  });

  it('没开自定义时区 → tzId 用设备的', async () => {
    const out = await pack(baseChar());
    expect(out.tzId).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('buildSystemPrompt 收到 skipTimeAwareness——模板里不烤「现在是 X」', async () => {
    await pack(baseChar());
    expect(systemPromptSpy).toHaveBeenCalledTimes(1);
    // 第 12 个位置参数是 promptOptions（见 chatPrompts.buildSystemPrompt 签名）。
    expect(systemPromptSpy.mock.calls[0][11]).toEqual({ skipTimeAwareness: true });
  });

  it('当前时间槽位保留：worker 到点现算填入（1.0 提示块的「现在是」也是槽位）', async () => {
    const out = await pack(baseChar());
    expect(out.template).toContain(`当前本地时间：${AMSG_SLOT_CURRENT_TIME}`);
    expect(out.template).toContain(`现在是 ${AMSG_SLOT_CURRENT_TIME}`);
  });

  it('【角色系统设定】之后补快照说明行，位置在设定正文与对话上下文之间', async () => {
    const out = await pack(baseChar());
    const noteIdx = out.template.indexOf('最近一次聊天时的快照');
    expect(noteIdx).toBeGreaterThan(out.template.indexOf('SYS_PROMPT_MARKER'));
    expect(noteIdx).toBeLessThan(out.template.indexOf('【最近对话上下文】'));
    expect(out.template).toContain('以下方「当前本地时间」为准');
  });
});

// ─── ① 订阅自检 ───
// 回归守卫：旧实现拿到已有订阅**无条件复用**——换过 VAPID 后绑旧公钥的订阅发推必 403，
// 浏览器僵尸化的死端点（permanently-removed.invalid）也照单收。这两种都得先退订再重订。

/** bytesToB64u([1,2,3]) === 'AQID'（btoa('\x01\x02\x03')），下面拿它当 VAPID 公钥比对。 */
const VAPID_AQID = 'AQID';

const makeSub = (endpoint: string, keyBytes: number[] | null) => ({
  endpoint,
  options: { applicationServerKey: keyBytes ? Uint8Array.from(keyBytes).buffer : null },
  unsubscribe: vi.fn().mockResolvedValue(true),
  toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
});

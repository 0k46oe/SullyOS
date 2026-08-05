// utils/amsgStateSync.test.ts
// 编排层守卫：打脏 → 立即批量冲刷 → 失败退避重传，以及活跃会话租约的起停。
// 关键取舍：云端那份 fire_pack 是角色到点时唯一的上下文来源，传不上去就意味着它带着
// 旧上下文发消息，所以失败的快照必须留在队列里等重传（早期实现发请求前就清空队列，
// 一次网络抖动那份快照就永远没了）。同时也不能变成无限重排，两头都钉住。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: {
    syncCharFirePacks: vi.fn().mockResolvedValue(undefined),
    syncChatPresence: vi.fn().mockResolvedValue(undefined),
    syncToolConfig: vi.fn().mockResolvedValue(undefined),
    listAllTasks: vi.fn().mockResolvedValue([]),
    cancelTask: vi.fn().mockResolvedValue({ uuid: '', alreadyGone: false }),
    clearClientState: vi.fn().mockResolvedValue({ deleted: 0, toolConfigRestored: true }),
    registerPushSubscription: vi.fn().mockResolvedValue(undefined),
    deleteRemotePushSubscription: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: { getGlobalConfig: vi.fn() },
}));

import {
  AMSG2_PENDING_SYNC_LS_KEY,
  AMSG2_PENDING_TOOL_CONFIG_LS_KEY,
  cancelAllRemoteAmsgTasks,
  wipeAmsgCloudData,
  flushAmsgState,
  isWorkerUrlCleared,
  markAmsgStateDirty,
  resumePendingAmsgStateSync,
  startAmsgChatPresence,
  stopAmsgChatPresence,
  syncAmsgToolConfig,
} from './amsgStateSync';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { CHAT_PRESENCE_HEARTBEAT_MS } from './amsgChatPresence';
import type { CharacterProfile } from '../types';

const H = 3600_000;
/** 「一个请求都不该发出」那类用例的观察窗：多等一会儿，冒出任何请求都算漏。 */
const IDLE_WINDOW_MS = 11_000;

/** 带一个「待触发的 auto 任务」的角色 —— 过同步门的最小形态。 */
const charWithAiTask = (id: string): CharacterProfile => ({
  id, name: id,
  activeMsg2Config: {
    enabled: true,
    tasks: [{
      taskUuid: `${id}-uuid`, mode: 'auto',
      firstSendTime: new Date(Date.now() + H).toISOString(),
      recurrenceType: 'none', source: 'character', status: 'scheduled', createdAt: Date.now(),
    }],
  },
} as unknown as CharacterProfile);

const snapshotOf = (char: CharacterProfile) => ({
  char, userProfile: {} as any, groups: [], realtimeConfig: undefined,
});

let charSeq = 0;
/** 每个用例用独立 charId：模块级 dirty Map 跨用例存活，同 id 会互相干扰。 */
const nextCharId = () => `char-${++charSeq}`;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.removeItem(AMSG2_PENDING_SYNC_LS_KEY);
  localStorage.removeItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY);
  (ActiveMsgClient.syncCharFirePacks as any).mockClear();
  (ActiveMsgClient.syncChatPresence as any).mockClear();
  (ActiveMsgClient.syncToolConfig as any).mockReset();
  (ActiveMsgClient.syncToolConfig as any).mockResolvedValue(undefined);
  (ActiveMsgClient.listAllTasks as any).mockReset();
  (ActiveMsgClient.listAllTasks as any).mockResolvedValue([]);
  (ActiveMsgClient.cancelTask as any).mockReset();
  (ActiveMsgClient.cancelTask as any).mockResolvedValue({ uuid: '', alreadyGone: false });
  (ActiveMsgClient.clearClientState as any).mockReset();
  (ActiveMsgClient.clearClientState as any).mockResolvedValue({ deleted: 0, toolConfigRestored: true });
  (ActiveMsgClient.registerPushSubscription as any).mockReset();
  (ActiveMsgClient.registerPushSubscription as any).mockResolvedValue(undefined);
  (ActiveMsgClient.deleteRemotePushSubscription as any).mockReset();
  (ActiveMsgClient.deleteRemotePushSubscription as any).mockResolvedValue(undefined);
  (ActiveMsgStore.getGlobalConfig as any).mockReset();
  (ActiveMsgStore.getGlobalConfig as any).mockResolvedValue({ workerUrl: 'https://amsg.example.dev' });
});
afterEach(async () => {
  // 待传队列和退避计数都是模块级的：失败用例会留下快照 + 一个重排 timer，
  // 不清干净会串进下一个用例的批次里（batch 长度、退避时长都会对不上）。
  // tool_config 的欠账同理，冲刷会顺手把它带走。
  // 先 mockReset 再给默认实现：用例里排的 xxxOnce（尤其是那个手动 release 的挂起
  // Promise）如果没被消费掉，会被下面这次收尾冲刷领走，然后一直挂着不返回。
  (ActiveMsgClient.syncCharFirePacks as any).mockReset();
  (ActiveMsgClient.syncCharFirePacks as any).mockResolvedValue(undefined);
  (ActiveMsgClient.syncToolConfig as any).mockResolvedValue(undefined);
  await flushAmsgState('cleanup');
  await vi.advanceTimersByTimeAsync(1);
  await flushAmsgState('cleanup');
  await vi.advanceTimersByTimeAsync(1);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('markAmsgStateDirty 同步门', () => {
  it('没有待触发 AI 任务的角色直接忽略（零成本，不排 timer 不发请求）', async () => {
    const plain = { id: nextCharId(), name: 'x' } as unknown as CharacterProfile;
    markAmsgStateDirty(snapshotOf(plain));
    await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
  });

  it('只有 fixed 任务也忽略（fixed 不需要 fire_pack）', async () => {
    const id = nextCharId();
    const fixedOnly = {
      id, name: id,
      activeMsg2Config: {
        enabled: true,
        tasks: [{
          taskUuid: `${id}-uuid`, mode: 'fixed',
          firstSendTime: new Date(Date.now() + H).toISOString(),
          recurrenceType: 'none', source: 'user', status: 'scheduled', createdAt: Date.now(),
        }],
      },
    } as unknown as CharacterProfile;
    markAmsgStateDirty(snapshotOf(fixedOnly));
    await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
  });

  it('enabled=false 忽略', async () => {
    const char = charWithAiTask(nextCharId());
    (char.activeMsg2Config as any).enabled = false;
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
  });

  it('没配 workerUrl → 清空脏标记且不发请求', async () => {
    (ActiveMsgStore.getGlobalConfig as any).mockResolvedValue({ workerUrl: '' });
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
    // 没有去处不算「欠着」：底账也一起清，别让下次启动为它白跑一趟补传。
    expect(JSON.parse(localStorage.getItem(AMSG2_PENDING_SYNC_LS_KEY) || '[]')).not.toContain(char.id);
  });

  it('冲刷失败 → 快照留在队列里，下次冲刷把同一个角色重传', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    await flushAmsgState('test-retry');
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
    const retried = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[1][0];
    expect(retried.map((i: any) => i.char.id)).toEqual([char.id]);
  });

  it('失败后自动退避重排（30s），不用干等下一轮聊天', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
  });

  it('重排期间又聊了一轮 → 传新快照，别被回队的旧快照盖回去', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const id = nextCharId();
    const stale = charWithAiTask(id);
    stale.name = '旧快照';
    markAmsgStateDirty(snapshotOf(stale));
    await vi.advanceTimersByTimeAsync(1);

    const fresh = charWithAiTask(id);
    fresh.name = '新快照';
    markAmsgStateDirty(snapshotOf(fresh));
    await flushAmsgState('test-retry');

    const retried = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[1][0];
    expect(retried).toHaveLength(1);
    expect(retried[0].char.name).toBe('新快照');
  });

  it('连续失败到上限后停止重排（离线时不无限排 timer）', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValue(new Error('offline'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    // 30s → 60s → 120s 三次重排后放手（快照仍留在队列里等下一轮打脏）
    await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000 + 1_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(4);
  });
});

// 即时冲刷回归守卫：打脏后不再有去抖窗口，微任务内就冲刷。
// 旧的 10s 去抖行为下第一条会挂（0ms 时还没冲刷）。
describe('即时冲刷', () => {
  it('打脏后立即冲刷，不等任何窗口', async () => {
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
  });

  it('同一个事件循环里连环打脏只合并成一次上传', async () => {
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect((ActiveMsgClient.syncCharFirePacks as any).mock.calls[0][0]).toHaveLength(2);
  });

  it('冲刷进行中再打脏，冲刷完成后自动补跑一次（不搁浅）', async () => {
    // 旧的丢弃式防重入（if (flushing) return）下这条会挂：第二份快照
    // 会一直躺在队列里，等不到任何人来传。
    let release!: () => void;
    (ActiveMsgClient.syncCharFirePacks as any).mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    await vi.advanceTimersByTimeAsync(0);           // 第一次冲刷挂起中

    const later = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(later));
    await vi.advanceTimersByTimeAsync(0);           // 撞上 flushing
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
    expect((ActiveMsgClient.syncCharFirePacks as any).mock.calls[1][0].map((s: any) => s.char.id))
      .toEqual([later.id]);
  });

  it('这次冲刷失败时不立刻补跑，交给退避重传（补跑不许白吃退避额度）', async () => {
    let fail!: () => void;
    (ActiveMsgClient.syncCharFirePacks as any).mockImplementationOnce(
      () => new Promise<void>((_, reject) => { fail = () => reject(new Error('worker down')); }),
    );
    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));
    await vi.advanceTimersByTimeAsync(0);

    markAmsgStateDirty(snapshotOf(charWithAiTask(nextCharId())));  // 在飞期间又打脏
    await vi.advanceTimersByTimeAsync(0);

    fail();
    await vi.advanceTimersByTimeAsync(0);
    // 立刻补跑只会当场重蹈覆辙；退避重传本来就会带上队列里的全部快照（含刚打脏那份）
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(2);
    expect((ActiveMsgClient.syncCharFirePacks as any).mock.calls[1][0]).toHaveLength(2);
  });
});

// 脏标记轻量持久化：localStorage 只存 charId 底账（快照本体启动时从 DB 重建）。
// 回归守卫：没有这层持久化时，「打脏 → 去抖窗口内杀进程」那份快照就永远丢了。
describe('脏标记持久化与启动补传', () => {
  const readMarks = (): string[] =>
    JSON.parse(localStorage.getItem(AMSG2_PENDING_SYNC_LS_KEY) || '[]');

  it('打脏写入底账，上传成功后移除', async () => {
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    expect(readMarks()).toContain(char.id);

    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect(readMarks()).not.toContain(char.id);
  });

  it('过不了同步门的角色不写底账', async () => {
    const plain = { id: nextCharId(), name: 'x' } as unknown as CharacterProfile;
    markAmsgStateDirty(snapshotOf(plain));
    expect(readMarks()).not.toContain(plain.id);
  });

  it('上传失败底账保留，等重试 / 下次启动补传', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('worker down'));
    const char = charWithAiTask(nextCharId());
    markAmsgStateDirty(snapshotOf(char));
    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect(readMarks()).toContain(char.id);
  });

  it('杀进程模拟：直接构造底账残留 → 启动补传立即重建上传并清底账', async () => {
    // 上次会话只留下 charId（内存队列已随进程蒸发），启动时用 DB 读回的角色重建快照。
    const char = charWithAiTask(nextCharId());
    localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify([char.id]));

    resumePendingAmsgStateSync({ characters: [char], userProfile: {} as any, groups: [] });
    await vi.advanceTimersByTimeAsync(1); // 补传不等去抖，冲微任务即可

    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    const batch = (ActiveMsgClient.syncCharFirePacks as any).mock.calls[0][0];
    expect(batch.map((i: any) => i.char.id)).toEqual([char.id]);
    expect(readMarks()).not.toContain(char.id);
  });

  it('残留角色已删除 / 已关 2.0 → 静默清除底账，不发请求', async () => {
    const disabled = charWithAiTask(nextCharId());
    (disabled.activeMsg2Config as any).enabled = false;
    localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify(['ghost-已删除', disabled.id]));

    resumePendingAmsgStateSync({ characters: [disabled], userProfile: {} as any, groups: [] });
    await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS);

    expect(ActiveMsgClient.syncCharFirePacks).not.toHaveBeenCalled();
    expect(readMarks()).toEqual([]);
  });

  it('补传失败底账不丢：留给退避重试 / 再下次启动', async () => {
    (ActiveMsgClient.syncCharFirePacks as any).mockRejectedValueOnce(new Error('offline'));
    const char = charWithAiTask(nextCharId());
    localStorage.setItem(AMSG2_PENDING_SYNC_LS_KEY, JSON.stringify([char.id]));

    resumePendingAmsgStateSync({ characters: [char], userProfile: {} as any, groups: [] });
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncCharFirePacks).toHaveBeenCalledTimes(1);
    expect(readMarks()).toContain(char.id);
  });
});

// 回归守卫：tool_config（搜索/Notion/飞书/MCP 凭据、代理地址）以前是「单发即忘」——
// 一句 `.catch(() => {})` 就没了，也没有底账。它又不像 fire_pack 那样每轮聊天重传，
// 传丢一次云端就永远是旧的：用户删掉的 MCP 服务器，worker 半夜照旧带着旧 token 直连。
describe('工具凭据（tool_config）的重试与底账', () => {
  const readMark = () => localStorage.getItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY);
  const config = { weatherEnabled: true } as any;

  it('传成功 → 只发一次请求，底账清空', async () => {
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledWith(config);
    expect(readMark()).toBeNull();
  });

  it('传失败 → 底账留存，退避 30s 后自动重传，成功即清账', async () => {
    (ActiveMsgClient.syncToolConfig as any).mockRejectedValueOnce(new Error('worker down'));
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(1);
    expect(readMark()).toBe('1');

    await vi.advanceTimersByTimeAsync(30_000 + 100);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(2);
    expect(readMark()).toBeNull();
  });

  it('退避打光仍失败 → 底账不丢，下次冲刷接着补', async () => {
    (ActiveMsgClient.syncToolConfig as any).mockRejectedValue(new Error('offline'));
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(30_000 + 60_000 + 120_000 + 1_000);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(4);
    expect(readMark()).toBe('1');

    // 网络回来了：下一次 fire_pack 冲刷顺手把它带上去
    (ActiveMsgClient.syncToolConfig as any).mockResolvedValue(undefined);
    await flushAmsgState('test');
    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(5);
    expect(readMark()).toBeNull();
  });

  it('没配 workerUrl → 不发请求，底账也不留（没有去处不算欠着）', async () => {
    (ActiveMsgStore.getGlobalConfig as any).mockResolvedValue({ workerUrl: '' });
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).not.toHaveBeenCalled();
    expect(readMark()).toBeNull();
  });

  it('杀进程模拟：底账残留 → 启动补传用当前配置传一次并清账', async () => {
    localStorage.setItem(AMSG2_PENDING_TOOL_CONFIG_LS_KEY, '1');
    resumePendingAmsgStateSync({
      characters: [], userProfile: {} as any, groups: [], realtimeConfig: config,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledTimes(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenCalledWith(config);
    expect(readMark()).toBeNull();
  });

  it('上传期间配置又改了 → 不拿旧那份的成功去清新的欠账', async () => {
    let release: () => void = () => {};
    (ActiveMsgClient.syncToolConfig as any).mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }));
    syncAmsgToolConfig(config);
    await vi.advanceTimersByTimeAsync(1);

    const newer = { weatherEnabled: false } as any;
    syncAmsgToolConfig(newer);          // 上一次还没回来
    release();
    await vi.advanceTimersByTimeAsync(1);

    expect(readMark()).toBe('1');       // 新的那份还欠着
    await flushAmsgState('test');
    await vi.advanceTimersByTimeAsync(1);
    expect(ActiveMsgClient.syncToolConfig).toHaveBeenLastCalledWith(newer);
    expect(readMark()).toBeNull();
  });
});

// 回归守卫：清空 Worker 地址以前是静默存盘。前端这边一切同步停摆，D1 里的任务却一条
// 没少——cron 每分钟照常消费、照烧 LLM 照推送，用户以为自己关掉了一切。
describe('清空 Worker 地址前的收尾', () => {
  it('只有「从非空变空」才触发取消流程', () => {
    expect(isWorkerUrlCleared('https://amsg.example.dev', '')).toBe(true);
    expect(isWorkerUrlCleared('https://amsg.example.dev', '   ')).toBe(true);
    // 换地址、首次填写、本来就空：都不是「关掉」
    expect(isWorkerUrlCleared('https://a.dev', 'https://b.dev')).toBe(false);
    expect(isWorkerUrlCleared('', 'https://b.dev')).toBe(false);
    expect(isWorkerUrlCleared('', '')).toBe(false);
    expect(isWorkerUrlCleared(undefined, undefined)).toBe(false);
  });

  it('逐个取消远端任务，单条失败不拖累其余', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([
      { uuid: 'u1' }, { uuid: 'u2' }, { uuid: 'u3' }, { notAUuid: true },
    ]);
    (ActiveMsgClient.cancelTask as any).mockImplementation(async (uuid: string) => {
      if (uuid === 'u2') throw new Error('worker 503');
      return { uuid, alreadyGone: false };
    });

    const result = await cancelAllRemoteAmsgTasks();

    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ total: 3, failed: 1, listed: true });
  });

  it('清单都读不到 → listed:false，交给界面提示「远端可能还挂着」', async () => {
    (ActiveMsgClient.listAllTasks as any).mockRejectedValue(new Error('unauthorized'));

    const result = await cancelAllRemoteAmsgTasks();

    expect(result.listed).toBe(false);
    expect(ActiveMsgClient.cancelTask).not.toHaveBeenCalled();
  });
});

describe('清空云端数据', () => {
  // 这一组守的是同一条：三样各清各的，谁失败都不许短路后面两样。
  // 换过 AMSG_MASTER_KEY 之后旧密文全解不开，而「列任务」要逐条解密、必然最先炸，
  // 偏偏这时候最需要被清掉的是 client_state —— 串行短路的话用户一样都清不成。
  it('任务清单读不出来时，角色上下文和推送订阅照样收拾干净', async () => {
    (ActiveMsgClient.listAllTasks as any).mockRejectedValue(new Error('decryption failed'));
    (ActiveMsgClient.clearClientState as any).mockResolvedValue({ deleted: 7, toolConfigRestored: true });

    const result = await wipeAmsgCloudData(undefined, { pushRegistered: true });

    expect(result.tasks.listed).toBe(false);
    expect(ActiveMsgClient.clearClientState).toHaveBeenCalledTimes(1);
    expect(result.stateDeleted).toBe(7);
    expect(ActiveMsgClient.registerPushSubscription).toHaveBeenCalledTimes(1);
    expect(result.push).toBe('reregistered');
  });

  it('角色上下文清不掉时，任务照样取消、推送订阅照样收拾', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([{ uuid: 'u-1' }, { uuid: 'u-2' }]);
    (ActiveMsgClient.clearClientState as any).mockRejectedValue(new Error('boom'));

    const result = await wipeAmsgCloudData(undefined, { pushRegistered: true });

    expect(ActiveMsgClient.cancelTask).toHaveBeenCalledTimes(2);
    expect(result.tasks).toEqual({ total: 2, failed: 0, listed: true });
    expect(result.stateDeleted).toBeNull();
    expect(result.toolConfigRestored).toBe(false);
    expect(result.push).toBe('reregistered');
  });

  it('推送订阅收拾不了也不影响前两样的结果', async () => {
    (ActiveMsgClient.listAllTasks as any).mockResolvedValue([{ uuid: 'u-1' }]);
    (ActiveMsgClient.clearClientState as any).mockResolvedValue({ deleted: 3, toolConfigRestored: true });
    (ActiveMsgClient.registerPushSubscription as any).mockRejectedValue(new Error('no permission'));

    const result = await wipeAmsgCloudData(undefined, { pushRegistered: true });

    expect(result.tasks).toEqual({ total: 1, failed: 0, listed: true });
    expect(result.stateDeleted).toBe(3);
    expect(result.push).toBe('failed');
  });

  // 本机没订阅还去 registerPushSubscription 的话，会当场向用户要通知权限——
  // 「清空数据」不该顺手弹权限框，删掉云端那行留白就是对的。
  it('本机没有推送订阅时只删云端那行，不去重新登记', async () => {
    const result = await wipeAmsgCloudData(undefined, { pushRegistered: false });

    expect(ActiveMsgClient.deleteRemotePushSubscription).toHaveBeenCalledTimes(1);
    expect(ActiveMsgClient.registerPushSubscription).not.toHaveBeenCalled();
    expect(result.push).toBe('deleted');
  });
});

describe('活跃会话租约', () => {
  it('启动立即写一次，之后按心跳间隔续租；stop 后不再续', async () => {
    const charId = nextCharId();
    startAmsgChatPresence(charId, Date.now());
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHAT_PRESENCE_HEARTBEAT_MS + 100);
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(2);

    stopAmsgChatPresence(charId);
    await vi.advanceTimersByTimeAsync(CHAT_PRESENCE_HEARTBEAT_MS * 3);
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(2);
  });

  it('同角色重入只刷新时间戳，不叠第二个心跳', async () => {
    const charId = nextCharId();
    startAmsgChatPresence(charId, Date.now());
    startAmsgChatPresence(charId, Date.now());
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(2); // 两次立即写

    await vi.advanceTimersByTimeAsync(CHAT_PRESENCE_HEARTBEAT_MS + 100);
    // 只有一个 timer 在跑 → 只多一次，而不是两次
    expect(ActiveMsgClient.syncChatPresence).toHaveBeenCalledTimes(3);
    stopAmsgChatPresence(charId);
  });
});

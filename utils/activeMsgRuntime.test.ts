import { afterEach, beforeAll, describe, it, expect, vi } from 'vitest';
import {
  EXPIRE_DECISION_TTL_MS,
  INBOX_FRESH_DELIVERY_WINDOW_MS,
  MAX_INBOX_PROCESS_ATTEMPTS,
  OrphanedCharacterError,
  PUSH_SUBSCRIPTION_CHANGED_KV_ID,
  findInboxArtifacts,
  flushInboxToChat,
  purgeInboxArtifacts,
  refreshPushSubscriptionIfMarked,
  resolveFireExpireDecision,
  resolveInboxFailureAction,
  resolveInboxPersistTimestamp,
} from './activeMsgRuntime';
import { ActiveMsgClient } from './activeMsgClient';
import { ActiveMsgStore } from './activeMsgStore';
import { DB } from './db';

// resolveFireExpireDecision 是从「防穿帮闸·客户端兜底」吞没闸抽出来的 get-or-compute
// helper（带 TTL 清扫），单测把闸的关键不变量钉住，防回归：
//   1. 一次 fire 的多分段 push 共用同一个决定（evaluate 只跑一次，绝不吞一半）；
//   2. TTL 过后同 fireKey 才允许重新判定（迟到分段仍复用同一决定）。
// 用注入的临时 Map 做隔离，不碰模块级 expireDecisionByFire，也不需要 DB / 浏览器。

describe('resolveFireExpireDecision', () => {
  it('一次 fire 的多分段 push（到达顺序 3 → 1 → 2）复用同一个决定，evaluate 只跑一次', async () => {
    const cache = new Map<string, { expired: boolean; expiresAt: number }>();
    const T0 = 1_700_000_000_000;
    const occ = 1_700_000_000_000;
    const taskIdentity = 'task-A';
    // fireKey 不含 messageIndex：三段 push（messageIndex 3/1/2）解析到同一个 key。
    const fireKey = `${taskIdentity}:${occ}`;

    let calls = 0;
    const evaluate = async () => { calls++; return true; };

    // 按 3 → 1 → 2 的到达顺序处理三段
    const decisions: boolean[] = [];
    for (const messageIndex of [3, 1, 2]) {
      void messageIndex; // 段序不进 key，仅表意
      decisions.push(await resolveFireExpireDecision(cache, fireKey, T0, evaluate));
    }

    expect(calls).toBe(1);                       // 只判一次
    expect(decisions).toEqual([true, true, true]); // 三段同吞
  });

  it('TTL 内复用缓存不重判，TTL 过后同 fireKey 重新判定（并刷新决定）', async () => {
    const cache = new Map<string, { expired: boolean; expiresAt: number }>();
    const T0 = 1_700_000_000_000;
    const fireKey = 'task-B:1700000000000';

    let calls = 0;
    let decision = false;
    const evaluate = async () => { calls++; return decision; };

    // 首判：false
    const first = await resolveFireExpireDecision(cache, fireKey, T0, evaluate);
    expect(first).toBe(false);
    expect(calls).toBe(1);

    // TTL 尚未到期：即便底层判定已改变，也命中缓存、不重判
    decision = true;
    const within = await resolveFireExpireDecision(cache, fireKey, T0 + EXPIRE_DECISION_TTL_MS - 1, evaluate);
    expect(within).toBe(false);
    expect(calls).toBe(1);

    // TTL 过后：清扫掉旧条目，重新判定，拿到新决定
    const after = await resolveFireExpireDecision(cache, fireKey, T0 + EXPIRE_DECISION_TTL_MS + 1, evaluate);
    expect(after).toBe(true);
    expect(calls).toBe(2);
  });

  // 回归守卫：判不出来的时候绝不能把「判不了」当成「可以发」缓存下来。
  // evaluate 抛错时不写缓存，下次才是真的重判——否则一次读取失败会让这次 fire 的
  // 后续分段全部沿用一个凭空捏造的结论。
  it('evaluate 抛错 → 不缓存，下次重判', async () => {
    const cache = new Map<string, { expired: boolean; expiresAt: number }>();
    const T0 = 1_700_000_000_000;

    let calls = 0;
    const evaluate = async () => {
      calls++;
      if (calls === 1) throw new Error('IndexedDB read failed');
      return true;
    };

    await expect(resolveFireExpireDecision(cache, 'task-D:333', T0, evaluate)).rejects.toThrow();
    expect(cache.size).toBe(0);

    const second = await resolveFireExpireDecision(cache, 'task-D:333', T0, evaluate);
    expect(calls).toBe(2);
    expect(second).toBe(true);
  });

  it('同任务不同 occurrence 用不同 fireKey，各判各的（不串判定）', async () => {
    const cache = new Map<string, { expired: boolean; expiresAt: number }>();
    const T0 = 1_700_000_000_000;

    let calls = 0;
    const evaluate = async () => { calls++; return calls === 1; }; // 第一次 true，第二次 false

    const d1 = await resolveFireExpireDecision(cache, 'task-C:111', T0, evaluate);
    const d2 = await resolveFireExpireDecision(cache, 'task-C:222', T0, evaluate);

    expect(calls).toBe(2);      // 两个 occurrence 各判一次
    expect(d1).toBe(true);
    expect(d2).toBe(false);
  });
});

// 回归守卫：push 处理失败时的去向。
// 过去一律就地存原稿——原稿里的表情 / 卡片 / 转账都还是标记形态，渲染时被剥掉，
// 用户看到残缺版，而角色下一轮读历史会当成「我已经发过了」：一次暂时的本地故障
// 就此变成永久的错误前提。现在默认留着重试，重试到头才退回存原稿。
describe('resolveInboxFailureAction', () => {
  it('角色已不存在 → 孤儿，不重试（重试多少次都没用，该去清远端任务）', () => {
    const err = new OrphanedCharacterError('char-gone');
    expect(resolveInboxFailureAction(err, 1)).toBe('orphan');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS + 5)).toBe('orphan');
  });

  it('普通失败且没到上限 → 重试，不把残缺版固化进聊天记录', () => {
    const err = new Error('IndexedDB transaction aborted');
    expect(resolveInboxFailureAction(err, 1)).toBe('retry');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS - 1)).toBe('retry');
  });

  it('重试到上限 → 退回存原稿保底（残缺也好过什么都没有）', () => {
    const err = new Error('IndexedDB transaction aborted');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS)).toBe('degrade');
    expect(resolveInboxFailureAction(err, MAX_INBOX_PROCESS_ATTEMPTS + 1)).toBe('degrade');
  });
});

// 回归守卫：重试不能把已经写进聊天记录的气泡再写一遍。
//
// 后处理是逐条落库的（十几处 DB.saveMessage），第 3 条写失败时前两条已经在库里了。
// 「失败就整条重跑」最多跑 4 趟（3 次重试 + 最后存原稿保底），不先认领并清掉上一趟的
// 半成品，用户就会看到同一段话出现三四遍——而重复进了聊天记录是永久的。
// 认领的依据是每条气泡都继承的 metadata.activeMsg2.messageId（每条 push 唯一）。
describe('findInboxArtifacts', () => {
  const bubble = (id: number, messageId: string, extra: Record<string, unknown> = {}) => ({
    id,
    role: 'assistant',
    metadata: { source: 'active_msg_2', activeMsg2: { messageId }, ...extra },
  });

  it('认出同一条 push 写下的全部气泡', () => {
    const found = findInboxArtifacts(
      [bubble(1, 'msg_a'), bubble(2, 'msg_a'), bubble(3, 'msg_b')],
      'msg_a',
    );
    expect(found.map((m) => m.id)).toEqual([1, 2]);
  });

  it('别的 push / 别的来源一律不动（多分段 push 每段各有各的 messageId）', () => {
    const messages = [
      bubble(1, 'msg_b'),
      { id: 2, role: 'assistant', metadata: { source: 'chat' } },
      { id: 3, role: 'assistant' },
      { id: 4, role: 'user', metadata: { activeMsg2: { messageId: 'msg_a' } } },
    ];
    expect(findInboxArtifacts(messages as any, 'msg_a')).toEqual([]);
  });

  it('一趟都没写成（第一条就挂了）→ 空清单，调用方据此判定副作用还得重放', () => {
    expect(findInboxArtifacts([bubble(1, 'msg_b')], 'msg_a')).toEqual([]);
  });

  it('退回存原稿那条也带同一个 messageId，所以也认得出来（免得原稿跟残留气泡并排）', () => {
    const raw = { id: 9, role: 'assistant', metadata: { activeMsg2: { messageId: 'msg_a' } } };
    expect(findInboxArtifacts([raw] as any, 'msg_a')).toHaveLength(1);
  });
});

// 上面那条是纯判定，这条走真库（fake-indexeddb）钉住实际删除行为：
// 重试前不清场的话，重跑一趟就是把同样的气泡再写一遍，用户看到重复的一段话。
describe('purgeInboxArtifacts（走真库）', () => {
  const CHAR = 'char-purge';

  const saveBubble = (content: string, messageId: string | null) => DB.saveMessage({
    charId: CHAR,
    role: 'assistant',
    type: 'text',
    content,
    metadata: messageId
      ? { source: 'active_msg_2', activeMsg2: { messageId } }
      : { source: 'chat' },
  } as any);

  it('只删这条 push 写下的气泡，别人的一条不动', async () => {
    await saveBubble('上一趟写了一半 1', 'msg_a');
    await saveBubble('上一趟写了一半 2', 'msg_a');
    await saveBubble('另一条 push 的', 'msg_b');
    await saveBubble('普通聊天回复', null);

    const removed = await purgeInboxArtifacts({ charId: CHAR, messageId: 'msg_a' } as any);

    expect(removed).toBe(2);
    const left = await DB.getRecentMessagesByCharId(CHAR, 200);
    expect(left.map((m) => m.content)).toEqual(['另一条 push 的', '普通聊天回复']);
  });

  it('一条都没写过 → 删 0 条，也不报错（首次处理走的就是这条）', async () => {
    await expect(purgeInboxArtifacts({ charId: 'char-empty', messageId: 'msg_x' } as any))
      .resolves.toBe(0);
  });
});

// 回归守卫：主动消息落库时间戳的「在线送达 vs 离线补收」决策。
// 过去后处理路径 15 处 DB.saveMessage 都不传 timestamp，一律落写库当刻——用户离线一晚，
// 昨晚 23:00 的消息中午打开显示中午，和正文里角色说的晚上的话矛盾；这个假时间戳还会喂给
// amsg2ExpireGuard.hasDeliveredProactiveNear（判定窗 [occurrence-90s, occurrence+30min]），
// 把明明送达的消息误判成没送到，生成假作废回执。修后：超过阈值的离线补收改落 sentAt。
describe('resolveInboxPersistTimestamp（边界值）', () => {
  const NOW = 1_700_000_000_000;

  it('阈值内（在线/准在线送达）→ undefined，落库维持写库当刻', () => {
    expect(resolveInboxPersistTimestamp(NOW - 60_000, NOW)).toBeUndefined();
    expect(resolveInboxPersistTimestamp(NOW, NOW)).toBeUndefined();
  });

  it('恰好等于阈值 → 仍算在线（规则是「超过」才离线补收）', () => {
    expect(resolveInboxPersistTimestamp(NOW - INBOX_FRESH_DELIVERY_WINDOW_MS, NOW)).toBeUndefined();
  });

  it('超过阈值 1ms → 离线补收，返回 sentAt', () => {
    const sentAt = NOW - INBOX_FRESH_DELIVERY_WINDOW_MS - 1;
    expect(resolveInboxPersistTimestamp(sentAt, NOW)).toBe(sentAt);
  });

  it('隔夜典型场景：13 小时前的 sentAt 原样返回', () => {
    const sentAt = NOW - 13 * 3_600_000;
    expect(resolveInboxPersistTimestamp(sentAt, NOW)).toBe(sentAt);
  });

  it('sentAt 缺失 / 非法（老 push 可能不带）→ undefined', () => {
    expect(resolveInboxPersistTimestamp(undefined, NOW)).toBeUndefined();
    expect(resolveInboxPersistTimestamp(0, NOW)).toBeUndefined();
    expect(resolveInboxPersistTimestamp(Number.NaN, NOW)).toBeUndefined();
  });

  it('sentAt 在未来（时钟偏差）→ undefined，别把气泡标到未来', () => {
    expect(resolveInboxPersistTimestamp(NOW + 5 * 60_000, NOW)).toBeUndefined();
  });

  it('阈值必须小于 hasDeliveredProactiveNear 的 30 分钟送达判定窗（两条路径都落窗内的前提）', () => {
    expect(INBOX_FRESH_DELIVERY_WINDOW_MS).toBeLessThan(30 * 60_000);
  });
});

// 端到端（走真库 + 真 flush）：钉住主路径（post-processing 逐条落库）和降级存原稿路径
// 用的是同一个口径——离线补收落 sentAt，在线送达落写库当刻。修复前主路径永远落写库当刻
// （离线补收用例挂）、降级路径永远落 sentAt（在线送达用例挂），两套口径各错一半。
describe('flushInboxToChat 落库时间戳（走真库）', () => {
  beforeAll(async () => {
    // flush 尾部会 dispatch 'active-msg-received' 等事件；node 测试环境没有 window，
    // 给个最小 stub（事件本身不在本组断言范围内）。
    (globalThis as any).window ??= { dispatchEvent: () => true };
    // 主路径要查得到角色才不会走孤儿分支。
    await DB.saveCharacter({ id: 'char-ts-main', name: '守夜角色' } as any);
  });

  const inboxMsg = (over: Record<string, unknown>) => ({
    charId: 'char-ts-main',
    charName: '守夜角色',
    body: '还没睡吗，早点休息',
    receivedAt: Date.now(),
    ...over,
  }) as any;

  const assistantMsgs = async (charId: string) =>
    (await DB.getRecentMessagesByCharId(charId, 50)).filter((m) => m.role === 'assistant');

  it('主路径·离线补收：sentAt 超过阈值 → 每条气泡都落 sentAt', async () => {
    const sentAt = Date.now() - 13 * 3_600_000; // 昨晚推的，今天中午才打开
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-main-stale',
      messageType: 'text', // ASSISTANT_TEXT_TYPES 白名单内 → 走 post-processing 主路径
      sentAt,
    }));

    await flushInboxToChat();

    const msgs = await assistantMsgs('char-ts-main');
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) expect(m.timestamp).toBe(sentAt);
  }, 20000);

  it('主路径·在线送达：sentAt 在阈值内 → 维持写库当刻，不回写 sentAt', async () => {
    const charId = 'char-ts-main-fresh';
    await DB.saveCharacter({ id: charId, name: '在线角色' } as any);
    const sentAt = Date.now() - 60_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-main-fresh',
      charId,
      messageType: 'text',
      sentAt,
    }));

    const before = Date.now();
    await flushInboxToChat();

    const msgs = await assistantMsgs(charId);
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) {
      expect(m.timestamp).toBeGreaterThanOrEqual(before); // 写库当刻，而不是一分钟前
    }
  }, 20000);

  it('降级存原稿路径·离线补收：与主路径同口径，落 sentAt', async () => {
    const charId = 'char-ts-raw-stale';
    const sentAt = Date.now() - 13 * 3_600_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-raw-stale',
      charId,
      messageType: 'forum', // 白名单外 → 不走 post-processing，直接原稿落库
      sentAt,
    }));

    await flushInboxToChat();

    const msgs = await assistantMsgs(charId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('还没睡吗，早点休息');
    expect(msgs[0].timestamp).toBe(sentAt);
  }, 20000);

  it('降级存原稿路径·在线送达：不再无条件落 sentAt，与主路径同口径（写库当刻）', async () => {
    const charId = 'char-ts-raw-fresh';
    const sentAt = Date.now() - 60_000;
    await ActiveMsgStore.saveInboxMessage(inboxMsg({
      messageId: 'msg-ts-raw-fresh',
      charId,
      messageType: 'forum',
      sentAt,
    }));

    const before = Date.now();
    await flushInboxToChat();

    const msgs = await assistantMsgs(charId);
    expect(msgs).toHaveLength(1);
    // 修复前这里挂：降级路径无条件用 sentAt，落的是一分钟前
    expect(msgs[0].timestamp).toBeGreaterThanOrEqual(before);
  }, 20000);
});

// ─── ② pushsubscriptionchange 标记消费（真库 fake-indexeddb）───
// SW 换订阅时往 ActiveMsg 库 kv store 写固定 key 的标记（worker/sw-keep-alive.ts），
// 这里钉主线程的消费口径：有标记才刷；刷成功才清；不支持 / 部分失败 / 抛错都留着
// 下次再试（清了就再也没人补——marker 只在 pushsubscriptionchange 那一刻写一次）。
describe('refreshPushSubscriptionIfMarked', () => {
  const openAmsgDb = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ActiveMsg');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  /** 按 SW 写入的同款记录形状（KvRecord {id, value}）把标记放进真库。 */
  const putMarker = async () => {
    await ActiveMsgStore.getGlobalConfig(); // 先把 schema 建到当前版本（含 kv store）
    const db = await openAmsgDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({
        id: PUSH_SUBSCRIPTION_CHANGED_KV_ID,
        value: { changedAt: Date.now(), resubscribed: false },
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  };

  const markerExists = async (): Promise<boolean> => {
    const db = await openAmsgDb();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const request = tx.objectStore('kv').get(PUSH_SUBSCRIPTION_CHANGED_KV_ID);
        request.onsuccess = () => resolve(Boolean(request.result));
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  };

  const clearMarker = async () => {
    const db = await openAmsgDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(PUSH_SUBSCRIPTION_CHANGED_KV_ID);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearMarker();
  });

  it('没有标记 → 不发起刷新', async () => {
    const refresh = vi.spyOn(ActiveMsgClient, 'refreshPushSubscriptionForPendingTasks')
      .mockResolvedValue({ status: 'ok', updated: 0, failed: 0 });

    await expect(refreshPushSubscriptionIfMarked()).resolves.toBe('no-marker');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('有标记 + 全部刷新成功 → 调一次刷新并清掉标记', async () => {
    await putMarker();
    const refresh = vi.spyOn(ActiveMsgClient, 'refreshPushSubscriptionForPendingTasks')
      .mockResolvedValue({ status: 'ok', updated: 2, failed: 0 });

    await expect(refreshPushSubscriptionIfMarked()).resolves.toBe('refreshed');
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(markerExists()).resolves.toBe(false);
  });

  it('有标记但没有要刷的任务（no-tasks）→ 也算处理完，清标记', async () => {
    await putMarker();
    vi.spyOn(ActiveMsgClient, 'refreshPushSubscriptionForPendingTasks')
      .mockResolvedValue({ status: 'no-tasks', updated: 0, failed: 0 });

    await expect(refreshPushSubscriptionIfMarked()).resolves.toBe('refreshed');
    await expect(markerExists()).resolves.toBe(false);
  });

  it('部分失败 → 标记保留下次再试', async () => {
    await putMarker();
    vi.spyOn(ActiveMsgClient, 'refreshPushSubscriptionForPendingTasks')
      .mockResolvedValue({ status: 'partial', updated: 1, failed: 1 });

    await expect(refreshPushSubscriptionIfMarked()).resolves.toBe('kept');
    await expect(markerExists()).resolves.toBe(true);
  });

  it('刷新抛错（断网 / 权限被收回）→ 标记保留', async () => {
    await putMarker();
    vi.spyOn(ActiveMsgClient, 'refreshPushSubscriptionForPendingTasks')
      .mockRejectedValue(new Error('offline'));

    await expect(refreshPushSubscriptionIfMarked()).resolves.toBe('kept');
    await expect(markerExists()).resolves.toBe(true);
  });
});

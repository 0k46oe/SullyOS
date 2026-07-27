import { describe, it, expect } from 'vitest';
import {
  EXPIRE_DECISION_TTL_MS,
  MAX_INBOX_PROCESS_ATTEMPTS,
  OrphanedCharacterError,
  findInboxArtifacts,
  purgeInboxArtifacts,
  resolveFireExpireDecision,
  resolveInboxFailureAction,
} from './activeMsgRuntime';
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

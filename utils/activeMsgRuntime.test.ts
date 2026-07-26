import { describe, it, expect } from 'vitest';
import {
  EXPIRE_DECISION_TTL_MS,
  MAX_INBOX_PROCESS_ATTEMPTS,
  OrphanedCharacterError,
  resolveFireExpireDecision,
  resolveInboxFailureAction,
} from './activeMsgRuntime';

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

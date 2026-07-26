/**
 * amsg worker v2 服务端工具循环 — 决策纯逻辑回归测试。
 *
 * 钉住的行为：
 *  1. finish 分段与 instant push / 客户端气泡同一份（sanitizeIntoSegments：按换行切，
 *     [[...]] / [html] 等标签块保持原子）；push 业务字段形状与 v1 一致，另挂
 *     notification.body = 净化文本给 OS banner；
 *  2. 数据标签 → tool-request，旁白与旁白里的副作用跨轮累积、finish 时一起出；
 *  3. 副作用标签 → 结构化 directives 只挂最后一条 push（收侧 isLastChunk 守卫依赖这一点）；
 *  4. 全程无正文：无副作用 → skip-push，有副作用 → 单条空正文 push 携带 directives。
 */

import { describe, expect, it } from 'vitest';
import {
  buildXhsSessionPayload,
  createFireSessionState,
  processLLMRound,
  type PushBuildInput,
} from './agentic';
import type { XhsNote } from '../../../utils/realtimeContext';

const build: PushBuildInput = {
  contactName: '小鹿',
  avatarUrl: 'https://example.com/a.png',
  taskId: '42',
  messageType: 'auto',
  metadata: { charId: 'char-1', amsgMode: 'auto' },
  occurrenceMs: Date.UTC(2026, 6, 21, 1, 0),
};

describe('processLLMRound — 纯文本 finish', () => {
  it('按换行分段成多条 scheduled push，业务字段形状与 v1 一致 + notification banner', () => {
    const state = createFireSessionState();
    const decision = processLLMRound(state, '想你了。\n快回消息！', build);

    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    expect(decision.pushPayloads).toHaveLength(2);
    expect(decision.pushPayloads[0]).toEqual({
      messageKind: 'content',
      messageType: 'auto',
      source: 'scheduled',
      message: '想你了。',
      title: '来自 小鹿',
      contactName: '小鹿',
      avatarUrl: 'https://example.com/a.png',
      messageSubtype: 'chat',
      taskId: '42',
      // 每条 push 都带触发时刻——客户端兜底闸的循环判定与吞放缓存键都靠它。
      metadata: { charId: 'char-1', amsgMode: 'auto', amsgOccurrenceMs: build.occurrenceMs },
      notification: { title: '来自 小鹿', body: '想你了。' },
    });
    // 无副作用时 metadata 原样透传，不额外挂 directives 键。
    expect((decision.pushPayloads[1].metadata as any).directives).toBeUndefined();
  });

  it('同一行多句不拆 — 气泡结构跟随 LLM 的换行意图（与客户端 chunkText 一致）', () => {
    const decision = processLLMRound(createFireSessionState(), '想你了。快回消息！', build);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    expect(decision.pushPayloads.map((p) => p.message)).toEqual(['想你了。快回消息！']);
  });

  it('回归：[[...]] 标签内的句读不再把标签劈碎（曾把「]]」拼进下一条消息）', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      '看到个热搜。\n[[分享卡: 官宣了！速看]]',
      build,
    );
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    expect(decision.pushPayloads.map((p) => p.message)).toEqual([
      '看到个热搜。',
      '[[分享卡: 官宣了！速看]]',
    ]);
  });

  it('SEND_EMOJI 独立成段：message 保留原始标签给客户端渲染，banner 显示可读形态', () => {
    const decision = processLLMRound(createFireSessionState(), '想你了\n[[SEND_EMOJI: 抱抱]]', build);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    expect(decision.pushPayloads).toHaveLength(2);
    expect(decision.pushPayloads[1].message).toBe('[[SEND_EMOJI: 抱抱]]');
    expect((decision.pushPayloads[1].notification as any).body).toBe('[表情：抱抱]');
  });

  it('空输出且无累积 → skip-push', () => {
    const decision = processLLMRound(createFireSessionState(), '', build);
    expect(decision.decision).toBe('skip-push');
  });
});

describe('processLLMRound — 数据标签 tool-request 与跨轮累积', () => {
  it('RECALL 标签 → tool-request，旁白暂存；下一轮 finish 时旁白排在正文前', () => {
    const state = createFireSessionState();

    const round1 = processLLMRound(state, '等等，我想想上个月的事。[[RECALL: 2026-06]]', build);
    expect(round1.decision).toBe('tool-request');
    if (round1.decision !== 'tool-request') return;
    expect(round1.toolCalls).toHaveLength(1);
    expect(round1.toolCalls[0].function.name).toBe('recall');
    expect(JSON.parse(round1.toolCalls[0].function.arguments)).toEqual({ year: '2026', month: '06' });
    expect(state.narrations).toEqual(['等等，我想想上个月的事。']);

    const round2 = processLLMRound(state, '想起来了，那天的落日超好看！', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    expect(round2.pushPayloads.map((p) => p.message)).toEqual([
      '等等，我想想上个月的事。',
      '想起来了，那天的落日超好看！',
    ]);
  });

  it('tool-request 轮旁白里的副作用标签也被结构化累积，finish 时挂上', () => {
    const state = createFireSessionState();

    const round1 = processLLMRound(state, '[[ACTION:POKE]]在吗在吗。[[SEARCH: 今晚 流星雨]]', build);
    expect(round1.decision).toBe('tool-request');
    // 旁白存原始文本（副作用标签保留），finish 时拼回全文统一扫。
    expect(state.narrations).toEqual(['[[ACTION:POKE]]在吗在吗。']);

    const round2 = processLLMRound(state, '今晚十点有流星雨！[[ACTION:ADD_EVENT|看流星雨|今晚10点]]', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    const last = round2.pushPayloads[round2.pushPayloads.length - 1];
    expect((last.metadata as any).directives).toEqual([
      { type: 'poke' },
      { type: 'add_event', title: '看流星雨', date: '今晚10点' },
    ]);
    // 非最后一条不挂 directives（客户端只在 isLastChunk 时 replay 一次）。
    for (const p of round2.pushPayloads.slice(0, -1)) {
      expect((p.metadata as any).directives).toBeUndefined();
    }
    // 副作用标签已从正文剥掉。
    for (const p of round2.pushPayloads) {
      expect(String(p.message)).not.toContain('[[ACTION');
    }
  });
});

describe('processLLMRound — directive-only 边界', () => {
  it('全程只有副作用标签：单条空正文 push 携带 directives，不带 notification', () => {
    const decision = processLLMRound(createFireSessionState(), '[[ACTION:POKE]]', build);
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    expect(decision.pushPayloads).toHaveLength(1);
    expect(decision.pushPayloads[0].message).toBe('');
    expect((decision.pushPayloads[0].metadata as any).directives).toEqual([{ type: 'poke' }]);
    expect(decision.pushPayloads[0].notification).toBeUndefined();
  });

  it('工具轮后 LLM 空输出：仍冲刷累积旁白，不静默丢', () => {
    const state = createFireSessionState();
    processLLMRound(state, '我查查。[[SEARCH: 天气]]', build);
    const round2 = processLLMRound(state, '', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    expect(round2.pushPayloads.map((p) => p.message)).toEqual(['我查查。']);
  });
});

describe('processLLMRound — 副作用标签块被数据标签劈成两轮（实机回归）', () => {
  it('长形态日记写一半去 RECALL：finish 拼回全文，日记成 directive、裸标签不漏进 push', () => {
    const state = createFireSessionState();

    // round 1：日记开了头，中途想查记忆 → 数据标签把文本劈开。
    const round1 = processLLMRound(
      state,
      '[[DIARY_START: 专属点读机 | 傲娇]]\n今天那家伙又缠着我。[[RECALL: 2026-06]]',
      build,
    );
    expect(round1.decision).toBe('tool-request');

    // round 2：日记收尾 + 正文。
    const round2 = processLLMRound(state, '……才、才不是想他！\n[[DIARY_END]]\n写完了，哼。', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;

    // 日记整块成了 directive（title/mood/跨轮内容都在），挂最后一条 push。
    const last = round2.pushPayloads[round2.pushPayloads.length - 1];
    const directives = (last.metadata as any).directives;
    expect(directives).toHaveLength(1);
    expect(directives[0].type).toBe('notion_write_diary');
    expect(directives[0].title).toBe('专属点读机');
    expect(directives[0].mood).toBe('傲娇');
    expect(directives[0].content).toContain('今天那家伙又缠着我。');
    expect(directives[0].content).toContain('……才、才不是想他！');

    // 正文 push 里不再出现孤立的 DIARY_START / DIARY_END 裸标签。
    for (const p of round2.pushPayloads) {
      expect(String(p.message)).not.toContain('DIARY_START');
      expect(String(p.message)).not.toContain('DIARY_END');
    }
    expect(round2.pushPayloads.map((p) => p.message)).toContain('写完了，哼。');
  });

  it('飞书长形态同款劈裂也能拼回', () => {
    const state = createFireSessionState();
    processLLMRound(state, '[[FS_DIARY_START: 今日份|开心]]\n上半段。[[SEARCH: 流星雨]]', build);
    const round2 = processLLMRound(state, '下半段。\n[[FS_DIARY_END]]', build);
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    const last = round2.pushPayloads[round2.pushPayloads.length - 1];
    const directives = (last.metadata as any).directives;
    expect(directives?.[0]?.type).toBe('feishu_write_diary');
    expect(directives?.[0]?.content).toContain('上半段。');
    expect(directives?.[0]?.content).toContain('下半段。');
  });
});

// ─── XHS 笔记随 push 带回（amsg2 round 1 在 worker 跑，客户端缺笔记缓冲） ────────

const makeNote = (n: number, descLen = 10): XhsNote => ({
  noteId: `note-${n}`,
  title: `标题${n}`,
  desc: 'd'.repeat(descLen),
  likes: n,
  author: `作者${n}`,
  authorId: `author-${n}`,
  xsecToken: `tok-${n}`,
  coverUrl: `https://img.example.com/${n}.jpg`,
});

describe('buildXhsSessionPayload — 按 directive 引用挑选最小数据包', () => {
  const notes = [makeNote(1), makeNote(2), makeNote(3)];

  it('xhs_share 的 idx（1-based）→ 对应笔记；未引用的不带', () => {
    const payload = buildXhsSessionPayload([{ type: 'xhs_share', idx: 2 }], notes, []);
    expect(payload).not.toBeNull();
    expect(payload!.notes).toHaveLength(1);
    expect(payload!.notes[0].idx).toBe(2);
    expect(payload!.notes[0].note.noteId).toBe('note-2');
  });

  it('越界 / 编造的序号取不到笔记 → 跳过；全落空且无 token → null', () => {
    const payload = buildXhsSessionPayload([{ type: 'xhs_share', idx: 14 }], notes, []);
    expect(payload).toBeNull();
  });

  it('desc 截断到 120 字符（防 web push ~4KB payload 超限）', () => {
    const payload = buildXhsSessionPayload(
      [{ type: 'xhs_share', idx: 1 }],
      [makeNote(1, 500)],
      [],
    );
    expect(payload!.notes[0].note.desc).toHaveLength(120);
    // 原数组的笔记不能被就地改掉（worker 内同 fire 后续还会用）。
    expect(notes[0].desc).toHaveLength(10);
  });

  it('点赞/评论引用的 noteId → 只带对应 xsecToken', () => {
    const payload = buildXhsSessionPayload(
      [{ type: 'xhs_like', noteId: 'note-3' }],
      notes,
      [['note-1', 'tok-1'], ['note-3', 'tok-3']],
    );
    expect(payload!.notes).toHaveLength(0);
    expect(payload!.xsecTokens).toEqual([['note-3', 'tok-3']]);
  });

  it('无任何 XHS directive → null（poke 等副作用不触发带笔记）', () => {
    expect(buildXhsSessionPayload([{ type: 'poke' }], notes, [['note-1', 'tok-1']])).toBeNull();
  });

  // 回归守卫：角色说分享了几张就带几张，绝不按张数砍。
  // 砍过的版本会让用户看到「说分享了 6 张、只出来 4 张卡」——话和内容对不上。
  // 装不装得进一条 push 由 index.ts 的 offloadOversizedPush 按真实字节算，
  // 超出的旁路存 client_state，不是丢内容。
  it('share 引用几张就带几张，不按张数砍', () => {
    const many = [1, 2, 3, 4, 5, 6].map((n) => makeNote(n));
    const payload = buildXhsSessionPayload(
      [1, 2, 3, 4, 5, 6].map((idx) => ({ type: 'xhs_share' as const, idx })),
      many,
      [],
    );
    expect(payload!.notes).toHaveLength(6);
  });
});

describe('processLLMRound — metadata.xhsSession 挂载', () => {
  it('share 引用的笔记与 directives 同挂最后一条 push，其余 push 不挂', () => {
    const state = createFireSessionState();
    processLLMRound(state, '我去逛逛。[[XHS_BROWSE]]', build);
    const round2 = processLLMRound(state, '看到个好玩的！\n[[XHS_SHARE: 1]]', {
      ...build,
      xhsNotes: [makeNote(1)],
      xhsXsecTokens: [['note-1', 'tok-1']],
    });
    expect(round2.decision).toBe('finish');
    if (round2.decision !== 'finish') return;
    const last = round2.pushPayloads[round2.pushPayloads.length - 1];
    expect((last.metadata as any).directives).toEqual([{ type: 'xhs_share', idx: 1 }]);
    expect((last.metadata as any).xhsSession.notes).toEqual([
      { idx: 1, note: makeNote(1) },
    ]);
    for (const p of round2.pushPayloads.slice(0, -1)) {
      expect((p.metadata as any).xhsSession).toBeUndefined();
    }
  });

  it('没有 XHS 引用时 metadata 不多挂 xhsSession 键（形状回归）', () => {
    const decision = processLLMRound(
      createFireSessionState(),
      '[[ACTION:POKE]]在吗',
      { ...build, xhsNotes: [makeNote(1)], xhsXsecTokens: [['note-1', 'tok-1']] },
    );
    expect(decision.decision).toBe('finish');
    if (decision.decision !== 'finish') return;
    const last = decision.pushPayloads[decision.pushPayloads.length - 1];
    expect((last.metadata as any).directives).toEqual([{ type: 'poke' }]);
    expect((last.metadata as any).xhsSession).toBeUndefined();
  });
});

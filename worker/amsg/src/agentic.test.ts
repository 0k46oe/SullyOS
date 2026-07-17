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
  createFireSessionState,
  processLLMRound,
  type PushBuildInput,
} from './agentic';

const build: PushBuildInput = {
  contactName: '小鹿',
  avatarUrl: 'https://example.com/a.png',
  taskId: '42',
  messageType: 'auto',
  metadata: { charId: 'char-1', amsgMode: 'auto' },
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
      metadata: { charId: 'char-1', amsgMode: 'auto' },
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
    expect(state.directives).toEqual([{ type: 'poke' }]);
    expect(state.narrations).toEqual(['在吗在吗。']);

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

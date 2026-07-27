// utils/agenticToolFeedback.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildDuplicateToolMessage,
  buildToolResultMessage,
  describeTool,
  toolCallFingerprint,
  type ToolCallRecord,
} from './agenticToolFeedback';

describe('toolCallFingerprint', () => {
  it('同名同参算同一次调用', () => {
    expect(toolCallFingerprint('recall', { year: '2026', month: '06' }))
      .toBe(toolCallFingerprint('recall', { year: '2026', month: '06' }));
  });

  // 模型两轮之间重新拼参数时字段顺序常常会变，不规范化的话同一个查询会被当成两次不同的，
  // 重复调用闸就形同虚设。
  it('参数字段顺序不同仍算同一次', () => {
    expect(toolCallFingerprint('recall', { year: '2026', month: '06' }))
      .toBe(toolCallFingerprint('recall', { month: '06', year: '2026' }));
  });

  it('嵌套对象里的顺序也一样处理', () => {
    expect(toolCallFingerprint('x', { a: { p: 1, q: 2 } }))
      .toBe(toolCallFingerprint('x', { a: { q: 2, p: 1 } }));
  });

  it('换参数就是另一次调用——多轮能力不能被闸误伤', () => {
    expect(toolCallFingerprint('recall', { year: '2026', month: '06' }))
      .not.toBe(toolCallFingerprint('recall', { year: '2026', month: '07' }));
    expect(toolCallFingerprint('web_search', { query: 'a' }))
      .not.toBe(toolCallFingerprint('web_search', { query: 'b' }));
  });

  it('工具名不同就是不同调用', () => {
    expect(toolCallFingerprint('recall', {})).not.toBe(toolCallFingerprint('web_search', {}));
  });

  it('无参数 / undefined 不炸', () => {
    expect(toolCallFingerprint('xhs_browse', undefined)).toBe(toolCallFingerprint('xhs_browse', {}));
  });
});

describe('describeTool', () => {
  it('已知工具给人话', () => {
    expect(describeTool('recall')).toBe('调取某个月的记忆');
    expect(describeTool('web_search')).toBe('联网搜索');
  });

  it('不认识的工具用原名，不编一个出来', () => {
    expect(describeTool('some_future_tool')).toBe('some_future_tool');
  });
});

describe('buildToolResultMessage', () => {
  const history: ToolCallRecord[] = [
    { name: 'recall', fingerprint: toolCallFingerprint('recall', { year: '2026', month: '06' }) },
  ];

  it('把工具结果原样带上', () => {
    const msg = buildToolResultMessage({
      name: 'recall',
      result: { ok: true, logsText: '六月发生的事' },
      history,
    });
    expect(msg).toContain('六月发生的事');
  });

  // 这条是整个改动的意义所在：裸 JSON 里没有任何东西告诉模型「这一步做完了」，
  // 提示词里但凡有一句常驻的「先去查 X」，它就会每轮照做，直到跑满上限。
  it('结尾必须写明别重复调用', () => {
    const msg = buildToolResultMessage({ name: 'recall', result: { ok: true }, history });
    expect(msg).toContain('不要再来一遍');
  });

  it('把已经用过的工具点名列出来', () => {
    const msg = buildToolResultMessage({
      name: 'web_search',
      result: { ok: true },
      history: [
        ...history,
        { name: 'web_search', fingerprint: toolCallFingerprint('web_search', { query: 'x' }) },
      ],
    });
    expect(msg).toContain('调取某个月的记忆');
    expect(msg).toContain('联网搜索');
  });

  it('同一个工具用过多次只在清单里列一次', () => {
    const msg = buildToolResultMessage({
      name: 'recall',
      result: { ok: true },
      history: [
        { name: 'recall', fingerprint: 'a' },
        { name: 'recall', fingerprint: 'b' },
      ],
    });
    expect(msg.match(/调取某个月的记忆/g)?.length).toBe(2); // 开头一次 + 清单一次
  });

  it('给出「直接写消息」这条出路，别把调工具当成回答', () => {
    const msg = buildToolResultMessage({ name: 'recall', result: {}, history });
    expect(msg).toContain('直接把要发的消息写出来');
  });
});

describe('buildDuplicateToolMessage', () => {
  it('说清这次没真去查，结果在上面', () => {
    const msg = buildDuplicateToolMessage('recall');
    expect(msg).toContain('调取某个月的记忆');
    expect(msg).toContain('没有再去查');
  });
});

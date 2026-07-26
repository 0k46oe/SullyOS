// utils/amsg2TaskContext.test.ts
import { describe, it, expect } from 'vitest';
import { buildAmsg2TaskContextText } from './amsg2TaskContext';
import type { ActiveMsg2TaskRecord, Amsg2ExpiredNoticeRecord } from '../types';

const H = 3600_000;
const pendingTask: ActiveMsg2TaskRecord = {
  taskUuid: 'aabbccdd-0000-0000-0000-000000000000', clientTaskId: 'cid-aabb', mode: 'prompted',
  firstSendTime: new Date(Date.now() + H).toISOString(), recurrenceType: 'none',
  promptHint: '问问考试结果', expirePolicy: 'expire',
  source: 'character', status: 'scheduled', createdAt: Date.now(),
};
const expired: Amsg2ExpiredNoticeRecord = {
  id: 'aabbccdd-0000-0000-0000-000000000000', charId: 'c1',
  occurrenceMs: Date.now() - H, mode: 'prompted', promptHint: '问问考试结果',
  recurrenceType: 'none', createdAt: Date.now(),
};

describe('buildAmsg2TaskContextText', () => {
  it('没任务没作废 → null（零噪音）', () => {
    expect(buildAmsg2TaskContextText([], [])).toBeNull();
  });
  it('进行中任务列出短 id 与方向', () => {
    const text = buildAmsg2TaskContextText([pendingTask], [])!;
    expect(text).toContain('[aabbccdd]');
    expect(text).toContain('问问考试结果');
    expect(text).not.toContain('已作废');
  });
  it('作废段包含三选一引导、时机约束、renew 与重建引导、不复述约束', () => {
    const text = buildAmsg2TaskContextText([], [expired])!;
    expect(text).toContain('已作废');
    expect(text).toContain('renew_active_message');
    expect(text).toContain('cancel_active_message + schedule_active_message');
    expect(text).toContain('强行转移');
    expect(text).toContain('不要向用户复述');
  });
});

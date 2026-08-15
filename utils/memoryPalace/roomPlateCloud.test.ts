// utils/memoryPalace/roomPlateCloud.test.ts
//
// 回归守卫（交云端整理时带了什么）。本地端到端跑出来的坑：worker 那边发给模型的请求体
// 里只有 model 和 messages，温度和输出上限全没了——本地那条路是 0.3 / 8000，云端落到
// 供应商默认值。同一批材料两条路整理出不一样的门牌，而界面上完全看不出来。
//
// 门牌整理的提示词、解析、合并已经收在 roomPlateCore 这个叶子里两边共用，采样参数
// 也是「同一件活儿的一部分」，同样要从叶子里取、同样要送到云端那条路上。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { scheduleBackgroundJob } = vi.hoisted(() => ({
  scheduleBackgroundJob: vi.fn(async () => ({ uuid: 'remote-uuid' })),
}));
vi.mock('../activeMsgClient', () => ({ ActiveMsgClient: { scheduleBackgroundJob } }));
// 提交这条路不碰门牌库，但模块顶层 import 了它（落地那半截要用），node 上没有 IndexedDB。
vi.mock('./db', () => ({
  RoomPlateDB: { get: vi.fn(), save: vi.fn() },
  plateId: (charId: string, room: string) => `${charId}:${room}`,
}));

import { PLATE_CONSOLIDATE_KIND } from '../amsgPlateJob';
import { PLATE_LLM_MAX_TOKENS, PLATE_LLM_TEMPERATURE } from './roomPlateCore';
import { submitPlateConsolidation } from './roomPlateCloud';
import type { RoomPlate } from './types';

const LIGHT_LLM = { baseUrl: 'https://light.example.dev/v1', apiKey: 'sk-light', model: 'cheap' };

const plate = (room: RoomPlate['room'], texts: string[]): RoomPlate => ({
  id: `c1:${room}`,
  charId: 'c1',
  room,
  entries: texts.map((text, i) => ({
    id: `pe_${room}_${i}`, text, firstLearnedAt: 1, updatedAt: 1, sourceCount: 1,
  })),
  updatedAt: 1,
  version: 1,
});

const submit = (over: Record<string, unknown> = {}) => submitPlateConsolidation({
  charId: 'c1',
  charName: '小满',
  userName: '小明',
  identityContext: '（身份上下文）',
  plates: [plate('user_room', ['小明在读研'])],
  materials: [{ room: 'user_room', lines: ['小明搬去和同学合租了'] }],
  lightLLM: LIGHT_LLM,
  ...over,
} as any);

beforeEach(() => {
  scheduleBackgroundJob.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('交云端整理', () => {
  it('采样参数用叶子里那两个常量（本地那条路用的是同一份）', async () => {
    await submit();

    const [params] = scheduleBackgroundJob.mock.calls[0] as unknown as [any];
    expect(params.temperature).toBe(PLATE_LLM_TEMPERATURE);
    expect(params.maxTokens).toBe(PLATE_LLM_MAX_TOKENS);
  });

  it('带上 kind、每块门牌的条目 id 快照，和记忆宫殿副 API 那行凭据', async () => {
    await submit();

    const [params] = scheduleBackgroundJob.mock.calls[0] as unknown as [any];
    expect(params.kind).toBe(PLATE_CONSOLIDATE_KIND);
    expect(params.credRow.credId).toBe('char:c1/memory');
    expect(params.jobInput.rooms).toEqual([
      { room: 'user_room', entries: ['小明在读研'], entryIds: ['pe_user_room_0'] },
    ]);
  });

  it('记忆宫殿副 API 没配齐就不交（不拿主 API 悄悄跑后台活儿）', async () => {
    await expect(submit({ lightLLM: { baseUrl: '', apiKey: '', model: '' } })).rejects.toThrow(/副 API/);
    expect(scheduleBackgroundJob).not.toHaveBeenCalled();
  });
});

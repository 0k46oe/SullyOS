// utils/activeMsgClient.backgroundJob.test.ts
//
// 回归守卫（后台任务这条路怎么排上去）。两条都是本地端到端跑出来的坑：
//
//   1. 到期时间必须交给服务端盖（immediate: true），客户端绝不能自己算一个 firstSendTime。
//      算了的话，那个时刻在「上传输入 → 传凭据 → 加密 → 发请求」这一路上早就过去了，
//      上游一律打回「时间必须在未来」——云端这条路每次都失败、每次都退回本地跑，
//      而用户那边只看得到门牌照常更新，完全不知道它从来没在云端跑过。
//
//   2. 采样温度与输出上限要原样带上去。上游对缺省的这两个字段是整个省略，
//      落到供应商默认值（温度常为 1.0，输出上限远小于四块门牌全量输出需要的量）——
//      同一批材料在本地和在云端会整理出不一样的门牌，而这种漂移界面上看不出来。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reiClient } = vi.hoisted(() => ({
  reiClient: {
    init: vi.fn(),
    putClientState: vi.fn(),
    getCapabilities: vi.fn(),
    putLlmCredentials: vi.fn(),
    _encrypt: vi.fn(),
  },
}));
vi.mock('@rei-standard/amsg-client', () => ({ ReiClient: vi.fn(() => reiClient) }));
vi.mock('./keepAlive', () => ({
  KeepAlive: { init: vi.fn().mockResolvedValue(undefined), reregister: vi.fn().mockResolvedValue(undefined) },
}));

const TEST_USER_ID = '3f2b1c8a-9d4e-4a1b-8c2d-000000000077';
const globalConfig: Record<string, unknown> = {
  userId: TEST_USER_ID,
  workerUrl: 'https://amsg.example.workers.dev',
  serverToken: '',
  llmCredentialsSupported: true,
};
vi.mock('./activeMsgStore', () => ({
  ActiveMsgStore: {
    ensureUserId: async () => TEST_USER_ID,
    getGlobalConfig: async () => ({ ...globalConfig }),
    saveGlobalConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

import { ActiveMsgClient } from './activeMsgClient';
import { forgetAllCredIds } from './amsgLlmCredentials';

const capturedPayloads: any[] = [];

beforeEach(() => {
  capturedPayloads.length = 0;
  globalConfig.llmCredentialsSupported = true;
  forgetAllCredIds();
  reiClient.init.mockReset().mockResolvedValue(undefined);
  reiClient.putClientState.mockReset().mockResolvedValue({ success: true });
  reiClient.putLlmCredentials.mockReset().mockResolvedValue({ success: true, data: { upserted: 1 } });
  reiClient.getCapabilities.mockReset().mockResolvedValue({ serverVersion: '2.6.0-next.22', features: [] });
  reiClient._encrypt.mockReset().mockImplementation(async (json: string) => {
    capturedPayloads.push(JSON.parse(json));
    return { iv: 'iv', authTag: 'tag', encryptedData: 'enc' };
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    status: 201,
    text: async () => JSON.stringify({ success: true, data: { uuid: 'job-remote-uuid' } }),
    headers: new Headers({ 'content-type': 'application/json' }),
  })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const CRED_ROW = {
  credId: 'char:c-bg/memory',
  value: { apiUrl: 'https://light.example.dev/v1/chat/completions', apiKey: 'sk-light', primaryModel: 'cheap' },
};

const schedule = (extra: Record<string, unknown> = {}) => ActiveMsgClient.scheduleBackgroundJob({
  kind: 'plate-consolidate',
  charId: 'c-bg',
  charName: '小满',
  jobKey: 'plate:job-1',
  jobId: 'job-1',
  jobInput: { v: 1, hello: 'world' },
  credRow: CRED_ROW,
  ...extra,
} as any);

/** POST 出去的那份任务载荷（云端状态那份没有 messageType，据此认出来）。 */
const scheduledTask = () => capturedPayloads.filter((p) => p && 'messageType' in p).at(-1);

describe('后台任务的到期时间', () => {
  it('用 immediate: true，不自己算 firstSendTime', async () => {
    await schedule();

    const task = scheduledTask();
    expect(task.immediate).toBe(true);
    expect(task, '客户端算出来的时刻发到服务端已是过去时，上游会打回「时间必须在未来」')
      .not.toHaveProperty('firstSendTime');
  });

  it('一次性任务、带得上 kind 与 job 编号，且用 job 这个 subtype（不进用户的任务清单）', async () => {
    await schedule();

    const task = scheduledTask();
    expect(task.recurrenceType).toBe('none');
    expect(task.messageSubtype).toBe('job');
    expect(task.metadata.amsgKind).toBe('plate-consolidate');
    expect(task.metadata.amsgJobId).toBe('job-1');
    expect(task.credRefs).toEqual({ chat: CRED_ROW.credId });
  });
});

describe('后台任务的采样参数', () => {
  it('传了就原样带上去', async () => {
    await schedule({ temperature: 0.3, maxTokens: 8000 });

    const task = scheduledTask();
    expect(task.temperature).toBe(0.3);
    expect(task.maxTokens).toBe(8000);
  });

  it('没传就一个字段都不写（让上游按它自己的规矩来，别凭空塞默认值）', async () => {
    await schedule();

    const task = scheduledTask();
    expect(task).not.toHaveProperty('temperature');
    expect(task).not.toHaveProperty('maxTokens');
  });
});

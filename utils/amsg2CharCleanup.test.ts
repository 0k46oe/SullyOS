// utils/amsg2CharCleanup.test.ts
// 回归守卫：删角色时那份云端 client_state 必须跟着清掉。
//
// 实测漏过一次：删掉一个测试角色之后，D1 里仍然留着 `amsg:char:<id>/fire_pack`（32KB）
// 和 `tool_pack`。fire_pack 里是完整角色系统提示词 + 最近 30 条对话原文，而删除确认框
// 跟用户说的是「记忆将被清空」——留着就是把聊天记录晾在云端。
//
// 同时钉住两条边界，别为了清得干净把删角色搞坏：
//   1. 没配过主动消息 2.0 的角色一个请求都不发；
//   2. 清不掉（断网 / worker 挂了）只回报结果，绝不抛错阻塞删除。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./activeMsgClient', () => ({
  ActiveMsgClient: { clearCharClientState: vi.fn() },
}));

import { charMayHaveCloudState, purgeCharCloudState } from './amsg2CharCleanup';
import { ActiveMsgClient } from './activeMsgClient';
import type { CharacterProfile } from '../types';

const charWith = (
  config: CharacterProfile['activeMsg2Config'],
): CharacterProfile => ({ id: 'char-1', name: '测试角色', activeMsg2Config: config } as CharacterProfile);

const clearMock = () => ActiveMsgClient.clearCharClientState as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearMock().mockReset();
  clearMock().mockResolvedValue(['fire_pack', 'tool_pack']);
});

describe('purgeCharCloudState', () => {
  it('配过 amsg2 的角色 → 按角色 id 清云端', async () => {
    const result = await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));
    expect(clearMock()).toHaveBeenCalledWith('char-1');
    expect(result).toEqual({ status: 'cleared', keys: ['fire_pack', 'tool_pack'] });
  });

  it('没有待触发任务了也照清（fire_pack 按角色存，任务发完它还在云端）', async () => {
    await purgeCharCloudState(charWith({ enabled: true }));
    expect(clearMock()).toHaveBeenCalledTimes(1);
  });

  it('用户关掉了 2.0 也照清（关闭只取消任务，不清云端那份上下文）', async () => {
    await purgeCharCloudState(charWith({ enabled: false }));
    expect(clearMock()).toHaveBeenCalledTimes(1);
  });

  it('从没配过 amsg2 的角色 → 一个请求都不发', async () => {
    const result = await purgeCharCloudState({ id: 'char-2', name: '路人' } as CharacterProfile);
    expect(clearMock()).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'skipped' });
  });

  it('角色本身找不到（并发删两次）→ 同样不发请求', async () => {
    const result = await purgeCharCloudState(undefined);
    expect(clearMock()).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'skipped' });
  });

  it('清不掉（断网 / worker 挂了）→ 不抛错，把失败交给调用方提示', async () => {
    const boom = new Error('worker down');
    clearMock().mockRejectedValue(boom);

    const result = await purgeCharCloudState(charWith({ enabled: true, tasks: [] }));
    expect(result).toEqual({ status: 'failed', error: boom });
  });

  it('云端本来就是空的 → cleared + 空清单（不是失败）', async () => {
    clearMock().mockResolvedValue([]);
    await expect(purgeCharCloudState(charWith({ enabled: true })))
      .resolves.toEqual({ status: 'cleared', keys: [] });
  });
});

describe('charMayHaveCloudState', () => {
  it('只看有没有 activeMsg2Config', () => {
    expect(charMayHaveCloudState(charWith({ enabled: true }))).toBe(true);
    expect(charMayHaveCloudState(charWith({ enabled: false }))).toBe(true);
    expect(charMayHaveCloudState({ id: 'x', name: 'x' } as CharacterProfile)).toBe(false);
    expect(charMayHaveCloudState(undefined)).toBe(false);
  });
});

/**
 * 删角色时的云端善后：把 ta 在 worker D1 `client_state` 里的那份数据清掉。
 *
 * 云端存的不是元数据，是**完整的角色系统提示词 + 最近 30 条对话原文**（fire_pack，
 * 实测一个角色 32KB 起步），旁边还有 tool_pack、活跃会话租约、以及 push 装不下时
 * 旁路存的小红书会话。删除确认框跟用户说的是「该操作不可恢复，记忆将被清空」，
 * 用户按下确认那一刻的预期就包含云端那份；留着既对不上这句承诺，也让每删一个角色
 * 就在 D1 里堆一份聊天记录。设置页那个「清除云端状态」是全局按钮、要用户主动去点，
 * 指望不上它替删角色收尾。
 *
 * 这一步是 best-effort：断网、worker 挂了都不该拦着角色删掉（用户想删的是这个角色，
 * 而且今天删不掉明天还是删不掉）。所以异常在这里就地吞掉、用返回值把结果交给调用方，
 * 调用方照常删本地记录，只是多弹一条提示。
 */

import { CharacterProfile } from '../types';
import { ActiveMsgClient } from './activeMsgClient';

export type CharCloudStateCleanup =
  /** 这个角色没配过主动消息 2.0，云端本来就没有它的数据 —— 一个请求都没发。 */
  | { status: 'skipped' }
  /** 清完了；keys 是实际被清空的条目（本来就空的角色是空数组）。 */
  | { status: 'cleared'; keys: string[] }
  /** 没清成（断网 / worker 挂了 / 没填 worker 地址）。角色照删，调用方负责提示。 */
  | { status: 'failed'; error: unknown };

/**
 * 判断这个角色云端有没有可能留着东西。
 *
 * 只看 activeMsg2Config 在不在：往云端写状态的几条路（面板排程、角色用工具排程、
 * 聊完一轮的 fire_pack 同步、活跃会话租约）都要先有这份配置，从没配过的角色云端
 * 一定是空的，不该为它发请求。
 *
 * 反过来只看「还有没有待触发任务」是不够的 —— 任务发完即从清单里移除，而 fire_pack
 * 按角色存、不随任务消失，只要聊过天就还在云端躺着。
 */
export const charMayHaveCloudState = (char: CharacterProfile | undefined): boolean =>
  Boolean(char?.activeMsg2Config);

/** 清掉该角色的云端 client_state。永远不抛错（见文件头：不能阻塞角色删除）。 */
export const purgeCharCloudState = async (
  char: CharacterProfile | undefined,
): Promise<CharCloudStateCleanup> => {
  if (!charMayHaveCloudState(char)) return { status: 'skipped' };

  try {
    const keys = await ActiveMsgClient.clearCharClientState(char!.id);
    return { status: 'cleared', keys };
  } catch (error) {
    return { status: 'failed', error };
  }
};

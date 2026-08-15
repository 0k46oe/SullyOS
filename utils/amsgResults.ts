/**
 * 云端结果的分发口（`resultKind` → 谁来消化）
 *
 * worker 的 `ctx.emitResult` 送回来的东西不是聊天内容——是后台跑完的产物：整理好的一份
 * 数据、一条账目、一份报告。它跟聊天正文走同一条送达通道（落服务端收件箱 + 视通知策略
 * 发推送），但到了客户端要分头处理，所以在这里按 `resultKind` 派活。
 *
 * 两个入口都指到这儿来：
 *   - **推送直达**：SW 收到 `messageKind: 'result'` → `active-msg-result` → activeMsgRuntime
 *   - **上线补收**：`GET /outbox?since=` 拉回来的 result 条目（amsgInstantChat 的补收）
 *
 * 返回值就一件事：**这条能不能销账**。`true` = 消化完了（或者确定消化不了，留着也没用），
 * 客户端把它从服务端账本上划掉；`false` = 这次没处理成（比如落库失败），账不销，下次
 * 上线再拉回来重试。判断反了的后果两头都难看：该销不销就是每次上线重放一次，该留不留
 * 就是结果静默蒸发。
 */

import { PLATE_CONSOLIDATE_RESULT_KIND } from './amsgPlateJob';

const HEADER = '[amsg2:result]';

/** 从一条 push payload 上读出结果种类；不是结果类 payload 就返回 null。 */
export const readResultKind = (payload: unknown): string | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = (payload as Record<string, unknown>).resultKind;
  return typeof raw === 'string' && raw ? raw : null;
};

/**
 * 把一条结果交给认领它的那一方。
 *
 * 具体 handler 走动态 import：它们要读写 IndexedDB，而这份文件被补收链路引着，
 * 静态引进来会把整个记忆宫殿的依赖拖进那条路的首屏包里。
 *
 * @returns 这条能不能销账
 */
export const dispatchAmsgResult = async (payload: unknown): Promise<boolean> => {
  const resultKind = readResultKind(payload);
  if (!resultKind) {
    console.warn(`${HEADER} 收到一条没有 resultKind 的结果，丢弃`, payload);
    return true;
  }

  try {
    switch (resultKind) {
      case PLATE_CONSOLIDATE_RESULT_KIND: {
        const { applyPlateConsolidateResult } = await import('./memoryPalace/roomPlateCloud');
        return await applyPlateConsolidateResult(payload);
      }
      default:
        // 认不出来的多半是前端比 worker 旧（用户先更新了 worker）。留着也没人能处理，
        // 销账丢掉——不销的话每次上线都会把它拉回来再看一眼。
        console.warn(`${HEADER} 不认识的 resultKind=${resultKind}（前端比 worker 旧？），丢弃`);
        return true;
    }
  } catch (error) {
    console.warn(`${HEADER} 消化 ${resultKind} 出错（账没销，下次再来）`, error);
    return false;
  }
};

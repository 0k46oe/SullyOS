/**
 * 门牌整理任务在 worker 这一侧。
 *
 * 客户端把「现有条目 + 新材料 + 身份上下文」装成一份 job 写进 client_state，再建一条
 * 标了 `amsgKind: 'plate-consolidate'` 的任务。到点这里把 job 读回来拼提示词，LLM 跑完
 * 把整理结果原样送回客户端——合并语义（basedOn 继承来历、没被重新输出的条目淘汰）留在
 * 客户端做，因为要合并进去的门牌本体在浏览器的 IndexedDB 里，云端够不着。
 *
 * 结果走 `ctx.emitResult`：落进服务端收件箱，客户端下次上线 `GET /outbox?since=` 一定
 * 拿得到。刻意**不弹通知**（`notification: { show: false }`）——门牌整理是背景工作，
 * 整理完了不该把人叫回来看；带 `show: false` 的 payload 上游只落行不推送，也就不会
 * 白占一次推送配额（订阅是按 userVisibleOnly 建的，收了 push 不弹通知浏览器要记账）。
 */

import { AMSG_JOB_ID_KEY, AMSG_JOB_NAMESPACE } from '../../../utils/amsgTaskKinds';
import {
  PLATE_CONSOLIDATE_RESULT_KIND,
  type PlateJobInput,
  buildPlateConsolidateResult,
  buildPlateJobMessages,
  parsePlateJobInput,
  plateJobKey,
} from '../../../utils/amsgPlateJob';
import { unpackStateValue } from '../../../utils/amsgFirePack';
import { parsePlateLlmReply } from '../../../utils/memoryPalace/roomPlateCore';
import type { FireKindHandler, KindFireCtx, KindSessionCtx, KindWriteState } from './fireKinds';

/** 跨到 onLLMOutput 的上下文。 */
export interface PlateFireState {
  jobId: string;
  job: PlateJobInput;
}

/**
 * 整理跑完就把 job 那行删掉：它是一次性输入，留着只是白占库。
 *
 * 刻意放在**结果送出去之后**而不是读进来的时候——中途失败会重试，那时还得再读一遍。
 * 删失败只记日志：命名空间上配了 clientStateTtl，cron 每跳会兜底清过期的。
 */
const discardJob = async (writeState: KindWriteState | undefined, jobId: string): Promise<void> => {
  if (!writeState) return;
  try {
    await writeState(AMSG_JOB_NAMESPACE, [{ key: plateJobKey(jobId), value: null }]);
  } catch (error) {
    console.warn('[amsg:plate] job 行没删掉（等 TTL 兜底）', jobId, error);
  }
};

export const plateConsolidateHandler: FireKindHandler = {
  async beforeFire({ ctx, charId, taskMeta }) {
    const jobId = taskMeta[AMSG_JOB_ID_KEY];
    if (typeof jobId !== 'string' || !jobId) {
      throw new Error(`门牌整理任务的 metadata 里没有 ${AMSG_JOB_ID_KEY}`);
    }

    const rows = await ctx.readState(AMSG_JOB_NAMESPACE);
    const row = rows.find((r) => r.key === plateJobKey(jobId));
    if (!row) {
      // job 行不在了：多半是这条任务躺了太久、TTL 把输入清了。重试也不会长出来，
      // 但这不是「坏了」——安静跳过，下一轮消化会重新提交一份。
      return { skip: true, reason: `门牌整理 job ${jobId} 的输入已过期` };
    }

    // 上传时压过（gz1: 前缀），跟 fire_pack 同一套；没压过的原样穿过去。
    let json: string;
    try {
      json = await unpackStateValue(row.value);
    } catch (error) {
      throw new Error(`门牌整理 job ${jobId} 的输入解压失败（数据损坏）：${String(error)}`);
    }

    const job = parsePlateJobInput(json);
    if (!job) throw new Error(`门牌整理 job ${jobId} 的输入解析失败（数据损坏）`);
    if (job.charId !== charId) {
      throw new Error(`门牌整理 job ${jobId} 的 charId 与任务对不上`);
    }
    if (job.rooms.length === 0) {
      return { skip: true, reason: `门牌整理 job ${jobId} 没有要整理的房间` };
    }

    return {
      messages: buildPlateJobMessages(job),
      state: { jobId, job } satisfies PlateFireState,
    };
  },

  async llmOutput({ ctx, state }) {
    const { jobId, job } = state as PlateFireState;
    const items = parsePlateLlmReply(ctx.llmOutputText || '');

    if (items.length === 0) {
      // 一条都没解析出来（模型跑偏 / 输出被截断）。不送空结果——客户端收到空列表会
      // 按「LLM 决定清空」处理，把整块门牌抹掉。什么都不送，门牌保持不动，
      // 下一轮消化再整理；job 行留着等 TTL，重试还能再跑一次。
      console.warn('[amsg:plate] LLM 没返回有效条目，门牌保持不动', jobId);
      return { decision: 'skip-push', reason: 'plate-empty-generation' };
    }

    if (typeof ctx.emitResult !== 'function') {
      // 老部署（amsg-server < 2.6.0-next.21）没有这个能力。整理白跑了，但说清楚原因，
      // 否则用户只会看到「门牌一直不更新」而面板上一片正常。
      console.warn('[amsg:plate] 这台 worker 不支持 emitResult，整理结果送不回去', jobId);
      return { decision: 'skip-push', reason: 'plate-emit-result-unsupported' };
    }

    await ctx.emitResult({
      ...buildPlateConsolidateResult({ jobId, charId: job.charId, items, rooms: job.rooms }),
      // 背景工作，整理完不该把人叫回来看。show:false 的 payload 上游只落收件箱、
      // 不发推送，客户端下次上线补收。
      notification: { show: false },
    });
    console.log('[amsg:plate] 整理结果已送进收件箱', {
      jobId, charId: job.charId, items: items.length, resultKind: PLATE_CONSOLIDATE_RESULT_KIND,
    });

    await discardJob(ctx.writeState, jobId);
    return { decision: 'skip-push', reason: 'plate-result-emitted' };
  },
};

/** 只为单测导出：让测试能不经 index.ts 直接喂一份 ctx。 */
export type { KindFireCtx, KindSessionCtx };

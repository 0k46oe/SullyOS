/**
 * 门牌整理走云端那条路（提交 → 等结果 → 合并落库）
 *
 * 本地那条路（roomPlates.ts 的 consolidatePlates）是「读库 → 调 LLM → 合并落库」一条龙，
 * 全程 await，页面一关就断。云端这条路把中间那段搬走：客户端把材料装成一份 job 交上去
 * 就返回，LLM 在用户自己的 CF Worker 上跑；跑完结果落进服务端收件箱，客户端下次上线
 * 补收回来，再做合并落库。
 *
 * 合并为什么留在本地：要合并进去的门牌本体在浏览器的 IndexedDB 里，云端够不着。而合并
 * 语义（basedOn 继承来历、没被重新输出的条目淘汰）是纯函数，放哪儿跑都一样。
 *
 * 一个必须处理的时间差：提示词是拿**提交那一刻**的门牌快照拼的，LLM 说的 `U0` 指的是
 * 快照里的第 0 条；而结果可能几分钟后才回来，这中间门牌说不定已经被别的路径动过
 * （手动回填就在本地跑）。所以提交时把每条的 id 一起带上、结果原样回传，落地时先按 id
 * 把标签重新对准当前条目再合并（见 remapBasedOnLabels）。
 */

import { ActiveMsgClient } from '../activeMsgClient';
import { buildCharMemoryCredRow } from '../amsgLlmCredentials';
import {
  PLATE_CONSOLIDATE_KIND,
  type PlateJobRoom,
  buildPlateJobInput,
  parsePlateConsolidateResult,
  plateJobKey,
} from '../amsgPlateJob';
import { RoomPlateDB, plateId } from './db';
import {
  PLATE_LLM_MAX_TOKENS,
  PLATE_LLM_TEMPERATURE,
  type PlateMaterial,
  mergePlateEntries,
  remapBasedOnLabels,
} from './roomPlateCore';
import type { PlateRoom, RoomPlate } from './types';

const HEADER = '🚪 [RoomPlate:云端]';

/** 记忆宫殿副 API 的形状（与本地那条路的 LightLLMConfig 同构）。 */
interface PlateLightLLM {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

/**
 * 这一轮能不能交给云端跑：记忆宫殿副 API 配齐了才行。
 *
 * 刻意不回落到主 API——本地那条路也不回落（记忆宫殿 App 的手动按钮在副 API 没配时直接
 * 报错），拿主 API 悄悄跑一遍后台整理会把用户的额度花在他没同意的地方。配不齐返回 null，
 * 调用方留在本地按原来的规矩跑。
 */
export const buildPlateCredRow = (charId: string, lightLLM: PlateLightLLM | null | undefined) =>
  buildCharMemoryCredRow(charId, lightLLM);

/**
 * 把一次整理交给云端。
 *
 * 抛错就是「没交出去」，调用方据此退回本地跑——这里绝不静默降级：静默分流那种
 * 「三个点照亮、测试照过、云端一条日志都没有」的坑踩过一次就够了。
 */
export const submitPlateConsolidation = async (args: {
  charId: string;
  charName: string;
  userName: string;
  identityContext: string;
  plates: RoomPlate[];
  materials: PlateMaterial[];
  lightLLM: PlateLightLLM | null | undefined;
}): Promise<{ jobId: string; uuid: string }> => {
  const credRow = buildPlateCredRow(args.charId, args.lightLLM);
  if (!credRow) throw new Error('记忆宫殿副 API 没配齐，门牌整理交不了云端');

  const rooms: PlateJobRoom[] = args.plates.map((p) => ({
    room: p.room,
    entries: p.entries.map((e) => e.text),
    entryIds: p.entries.map((e) => e.id),
  }));

  const jobId = crypto.randomUUID();
  const { uuid } = await ActiveMsgClient.scheduleBackgroundJob({
    kind: PLATE_CONSOLIDATE_KIND,
    charId: args.charId,
    charName: args.charName,
    jobKey: plateJobKey(jobId),
    jobId,
    jobInput: buildPlateJobInput({
      charId: args.charId,
      charName: args.charName,
      userName: args.userName,
      identityContext: args.identityContext,
      rooms,
      materials: args.materials,
    }),
    credRow,
    // 与本地那条路同一组采样参数（叶子里那两个常量），别让同一批材料在两条路上
    // 跑出不一样的门牌：整理是照着材料重排不是创作，温度要压低；四块门牌一次全量
    // 输出很长，输出上限要给足，不给的话回复会被截断、只能靠解析容错抢救半份。
    temperature: PLATE_LLM_TEMPERATURE,
    maxTokens: PLATE_LLM_MAX_TOKENS,
  });

  console.log(`${HEADER} 已交给云端整理 ${rooms.length} 块门牌（job ${jobId}）`);
  return { jobId, uuid };
};

/**
 * 云端整理结果落地：重新对准标签 → 合并 → 落库。
 *
 * @returns 这条结果能不能销账。落库出错时抛出去，由分发口记成「账没销」——整理跑一次
 *   要一两分钟还烧一次 API，不能因为一次 IDB 抖动就丢掉。
 */
export const applyPlateConsolidateResult = async (payload: unknown): Promise<boolean> => {
  const result = parsePlateConsolidateResult(payload);
  if (!result) {
    console.warn(`${HEADER} 结果形状认不出来，丢弃`, payload);
    return true;
  }

  const { charId, items } = result;
  if (items.length === 0) {
    // worker 那边解析不出条目时压根不会送结果，走到这里说明形状对但内容空。
    // 空列表当「LLM 决定清空」处理会把整块门牌抹掉，宁可不动。
    console.warn(`${HEADER} 结果里没有条目，门牌保持不动（job ${result.jobId}）`);
    return true;
  }

  const now = Date.now();
  const updated: PlateRoom[] = [];

  // 逐块串行：并发跑会同时开好几个 IDB 事务，正是 instant push 那次超时的连接风暴成因。
  for (const { room, entryIds } of result.rooms) {
    const roomItems = items.filter((i) => i.room === room);
    // 一个条目都没提到的房间跳过保存——区分「LLM 决定清空」和「LLM 忘了这个房间 /
    // 输出被截断」，宁可保守不动，等下轮消化再整理。与本地那条路同一个规矩。
    if (roomItems.length === 0) continue;

    const plate = await loadOrCreatePlate(charId, room);
    const aligned = remapBasedOnLabels(room, roomItems, entryIds, plate.entries);
    plate.entries = mergePlateEntries(room, plate.entries, aligned, now);
    plate.updatedAt = now;
    plate.version += 1;
    await RoomPlateDB.save(plate);
    updated.push(room);
    console.log(`${HEADER} 「${room}」v${plate.version}：${plate.entries.length} 条`);
  }

  if (updated.length > 0) {
    window.dispatchEvent(new CustomEvent('room-plates-updated', { detail: { charId, rooms: updated } }));
  }
  return true;
};

/** 与 roomPlates.ts 里那份同构：没有就现造一块空的。 */
const loadOrCreatePlate = async (charId: string, room: PlateRoom): Promise<RoomPlate> => {
  const existing = await RoomPlateDB.get(charId, room);
  if (existing) return existing;
  return { id: plateId(charId, room), charId, room, entries: [], updatedAt: Date.now(), version: 0 };
};

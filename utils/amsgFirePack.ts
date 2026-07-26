/**
 * 主动消息 2.0「满血」fire_pack：前端拼好的 prompt 模板 + 时间槽位的渲染。
 *
 * prompt 不在排程时定稿，而是前端把「除时间性内容外的完整模板」同步到 worker 的
 * client_state（namespace `amsg:char:<id>`，key `fire_pack`），worker 到点用
 * renderFirePack 现算时间填槽——上下文永远是最后一次聊天的状态。这份模块被两边共用：
 *   - 前端 activeMsgClient 的 buildFirePack（排程 / 每轮聊完同步时打包）
 *   - worker/amsg/src/index.ts 的 onBeforeFire（fire 时现场渲染）
 * 时间文案只此一份，两边的槽位定义保证一致。
 *
 * 多任务共用每角色一份 fire_pack：「本次任务」指令随任务 metadata 走、到点填槽（v2 起）。
 *
 * 纯函数、零依赖（worker bundle 会打进这份代码，别在这里 import 前端环境的东西）。
 */

export const AMSG_STATE_NAMESPACE_PREFIX = 'amsg:char:';
export const amsgStateNamespace = (charId: string) => `${AMSG_STATE_NAMESPACE_PREFIX}${charId}`;
export const AMSG_FIRE_PACK_KEY = 'fire_pack';

/**
 * 大内容旁路：一条 push 塞不下的 XHS 会话数据（笔记详情 + xsecToken）存这个 key，
 * push 里只带 `metadata.xhsSessionRef` 指过来，客户端收到后按键取回、用完即删。
 *
 * 每个任务固定一份、下次触发直接覆盖——所以就算客户端一直没来取，存量也有上限，
 * 不需要额外的过期清理。worker 写（onLLMOutput）与客户端读（activeMsgRuntime）
 * 共用这一份键名，别在任何一侧另起炉灶。
 */
export const amsgXhsSessionKey = (clientTaskId: string) => `xhs_session:${clientTaskId}`;

export const AMSG_SLOT_CURRENT_TIME = '{{AMSG_CURRENT_TIME}}';
export const AMSG_SLOT_TIME_SINCE_USER = '{{AMSG_TIME_SINCE_USER}}';
export const AMSG_SLOT_AWAY_HINT = '{{AMSG_AWAY_HINT}}';
export const AMSG_SLOT_TASK_INSTRUCTION = '{{AMSG_TASK_INSTRUCTION}}';

export interface AmsgFirePack {
  v: 2;
  /** 完整 prompt 模板，时间性内容与本次任务指令留 AMSG_SLOT_* 槽位。 */
  template: string;
  /** 用户上次真实主动发消息的时间（epoch ms）；没有聊天记录时为 null。 */
  lastUserMessageAt: number | null;
  /** 打包时的 Date.prototype.getTimezoneOffset()（UTC+8 → -480），worker 换算本地时间用。 */
  tzOffsetMin: number;
  /** 用户称呼（userProfile.name || '对方'），awayHint 文案用。 */
  targetName: string;
}

/** 和 activeMsgClient 的 nowIsoLocal 同款换算：UTC now + 时区偏移 → `YYYY-MM-DD HH:mm`。 */
export const formatLocalTime = (nowMs: number, tzOffsetMin: number): string => {
  const local = new Date(nowMs - tzOffsetMin * 60_000);
  return local.toISOString().slice(0, 16).replace('T', ' ');
};

/** 「距离用户上次主动发消息……」三档文案；diffMinutes 为 null 表示没有聊天记录。 */
export const formatTimeSinceUser = (diffMinutes: number | null): string => {
  if (diffMinutes == null) {
    return '你们最近没有新的聊天记录。';
  }
  const minutesTotal = Math.max(0, diffMinutes);
  if (minutesTotal < 60) {
    return `距离用户上次主动发消息大约 ${minutesTotal} 分钟。`;
  }
  if (minutesTotal < 1440) {
    const hours = Math.floor(minutesTotal / 60);
    const minutes = minutesTotal % 60;
    return `距离用户上次主动发消息大约 ${hours} 小时${minutes ? ` ${minutes} 分钟` : ''}。`;
  }
  const days = Math.floor(minutesTotal / 1440);
  const hours = Math.floor((minutesTotal % 1440) / 60);
  return `距离用户上次主动发消息大约 ${days} 天${hours ? ` ${hours} 小时` : ''}。`;
};

/** legacyHint 里的「对方已经多久没来」变体，从 timeSinceUser 文案变换而来。 */
export const buildAwayHint = (targetName: string, timeSinceUser: string): string => {
  const target = targetName || '对方';
  return timeSinceUser.includes('没有新的聊天记录')
    ? `${target}最近没有主动来找你说话。`
    : `${target}${timeSinceUser.replace(/^距离用户/, '已经')}`;
};

const fillSlot = (text: string, slot: string, value: string) => text.split(slot).join(value);

/**
 * 用 nowMs 时刻的时间信息填掉模板里的全部槽位，得到最终可发给 LLM 的 prompt。
 * taskInstruction 由排程时写进任务 metadata（见 activeMsgClient.buildTaskInstruction），
 * worker 读不到就先抛错，所以这里按必填收。
 */
export const renderFirePack = (
  pack: AmsgFirePack,
  nowMs: number,
  taskInstruction: string,
): string => {
  const currentTime = formatLocalTime(nowMs, pack.tzOffsetMin);
  const diffMinutes = pack.lastUserMessageAt == null
    ? null
    : Math.max(0, Math.floor((nowMs - pack.lastUserMessageAt) / 60_000));
  const timeSinceUser = formatTimeSinceUser(diffMinutes);
  const awayHint = buildAwayHint(pack.targetName, timeSinceUser);

  let out = pack.template;
  out = fillSlot(out, AMSG_SLOT_CURRENT_TIME, currentTime);
  out = fillSlot(out, AMSG_SLOT_TIME_SINCE_USER, timeSinceUser);
  out = fillSlot(out, AMSG_SLOT_AWAY_HINT, awayHint);
  out = fillSlot(out, AMSG_SLOT_TASK_INSTRUCTION, taskInstruction);
  return out;
};

/** worker 侧从 client_state 读回的 value 解析成 fire_pack；形状不对返回 null（调用方抛错）。 */
export const parseFirePack = (value: string): AmsgFirePack | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      parsed && typeof parsed === 'object' &&
      parsed.v === 2 &&
      typeof parsed.template === 'string' && parsed.template.length > 0 &&
      (parsed.lastUserMessageAt === null || typeof parsed.lastUserMessageAt === 'number') &&
      typeof parsed.tzOffsetMin === 'number' &&
      typeof parsed.targetName === 'string'
    ) {
      return parsed as AmsgFirePack;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};

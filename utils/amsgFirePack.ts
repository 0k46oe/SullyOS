/**
 * 主动消息 2.0「满血」fire_pack：前端拼好的 prompt 模板 + 时间槽位的渲染。
 *
 * 满血链路里 prompt 不再在排程时冻结，而是前端把「除时间性内容外的完整模板」
 * 同步到 worker 的 client_state（namespace `amsg:char:<id>`，key `fire_pack`），
 * worker 到点用 renderFirePack 现算时间填槽。这份模块被两边共用：
 *   - 前端 activeMsgClient 的 buildCompletePrompt（排程时的冻结 prompt 兜底路径）
 *   - worker/amsg/src/index.ts 的 onBeforeFire（fire 时现场渲染）
 * 时间文案只此一份，两条路径产出保证一致。
 *
 * 纯函数、零依赖（worker bundle 会打进这份代码，别在这里 import 前端环境的东西）。
 */

export const AMSG_STATE_NAMESPACE_PREFIX = 'amsg:char:';
export const amsgStateNamespace = (charId: string) => `${AMSG_STATE_NAMESPACE_PREFIX}${charId}`;
export const AMSG_FIRE_PACK_KEY = 'fire_pack';

export const AMSG_SLOT_CURRENT_TIME = '{{AMSG_CURRENT_TIME}}';
export const AMSG_SLOT_TIME_SINCE_USER = '{{AMSG_TIME_SINCE_USER}}';
export const AMSG_SLOT_AWAY_HINT = '{{AMSG_AWAY_HINT}}';

export interface AmsgFirePack {
  v: 1;
  /** 完整 prompt 模板，时间性内容留 AMSG_SLOT_* 槽位。 */
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

/** 用 nowMs 时刻的时间信息填掉模板里的全部槽位，得到最终可发给 LLM 的 prompt。 */
export const renderFirePack = (pack: AmsgFirePack, nowMs: number): string => {
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
  return out;
};

/** worker 侧从 client_state 读回的 value 解析成 fire_pack；形状不对返回 null（回退老链路）。 */
export const parseFirePack = (value: string): AmsgFirePack | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      parsed && typeof parsed === 'object' &&
      parsed.v === 1 &&
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

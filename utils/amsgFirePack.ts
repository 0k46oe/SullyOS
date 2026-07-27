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
 * 零依赖（worker bundle 会打进这份代码，别在这里 import 前端环境的东西）。除了压缩那几个
 * 函数用 CompressionStream / base64（浏览器和 Workers 运行时都自带），其余都是纯函数。
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

// ─── client_state 的值压缩 ───
//
// fire_pack 是「角色完整系统提示词 + 最近 30 条对话」，一份 40KB 起步，排了任务的角色
// 每聊完一轮就整份重传一次。压缩必须发生在**交给上游加密之前**：上游 putClientState 是
// 先加密再发，密文近似随机、gzip 压不动（实测只能抵消 base64 那点膨胀，省 25%），
// 而在这里先压再交出去，同一份内容实测省 60%，D1 里存的也跟着变小。

/**
 * 压缩过的值的前缀。
 *
 * 不是版本兼容用的，是「这一份到底压没压」的标记：内容太短时压完反而更大，
 * packStateValue 会原样返回，读侧靠这个前缀分辨该不该解压。
 */
const GZIP_VALUE_PREFIX = 'gz1:';

/** 运行时有没有压缩能力（老 Safari 没有 CompressionStream）。 */
const canCompress = (): boolean =>
  typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

// btoa/atob 只吃 latin1 字符串，二进制要一个字节一个字符地喂。整段 apply 展开会在大数据上
// 爆调用栈，按块拼。
const CHUNK = 0x8000;

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const streamThrough = async (data: Uint8Array, transform: TransformStream): Promise<Uint8Array> => {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * 上传前把值压掉。压不动或运行时不支持时原样返回 —— 这个函数永远不该让同步失败，
 * 云端那份 fire_pack 是角色到点时唯一的上下文来源，为了省流量把它弄丢是本末倒置。
 */
export const packStateValue = async (json: string): Promise<string> => {
  if (!canCompress()) return json;
  try {
    const rawBytes = new TextEncoder().encode(json);
    const gz = await streamThrough(rawBytes, new CompressionStream('gzip'));
    const packed = `${GZIP_VALUE_PREFIX}${bytesToBase64(gz)}`;
    // 划算不划算按**字节**比，不能用 .length。fire_pack 几乎全是中文，一个字符占 3 个
    // UTF-8 字节，而压完的 base64 全是 ASCII（1 字符 = 1 字节）——拿字符数比的话，
    // 明明省掉一半流量的结果会被判成「压完更大」，于是一份都压不动。
    return packed.length < rawBytes.length ? packed : json;
  } catch {
    return json;
  }
};

/**
 * 读回来的值还原成 JSON 字符串。没有前缀的就是没压过的，原样返回。
 * 解压失败抛出去 —— 那说明数据真损坏了，不能当成正常内容往下走。
 */
export const unpackStateValue = async (value: string): Promise<string> => {
  if (!value.startsWith(GZIP_VALUE_PREFIX)) return value;
  const gz = base64ToBytes(value.slice(GZIP_VALUE_PREFIX.length));
  const raw = await streamThrough(gz, new DecompressionStream('gzip'));
  return new TextDecoder().decode(raw);
};

/**
 * 防穿帮闸最近一次拦下了哪次触发（每角色一份，新的盖旧的）。
 *
 * 闸是完全静默工作的：worker 判定「该让路」之后直接跳过这次 fire，一条 push 都不发。
 * 对用户来说，「让路了」和「发出去但没收到」「功能坏了」长得一模一样——远端那行任务
 * 两种情况下都会被消费掉，客户端事后无从分辨。
 *
 * 所以让 worker 在跳过时留一句话，客户端读回来照实说明。只留最近一次：这是给人看的
 * 「刚才为什么没响」，不是审计流水，攒着只会越积越多。
 */
export const AMSG_LAST_SKIP_KEY = 'last_skip';

export interface AmsgLastSkip {
  v: 1;
  /** 被跳过的那条任务（uuid，拿不到时为 null）。 */
  taskUuid: string | null;
  /** 本该触发的时刻。 */
  occurrenceMs: number;
  /**
   * active-chat-presence  到点时用户正跟这个角色聊天
   * conversation-moved-on 排程之后对话已经往前走了，原本要说的话过时了
   */
  reason: 'active-chat-presence' | 'conversation-moved-on';
  skippedAt: number;
}

export const parseLastSkip = (value: string): AmsgLastSkip | null => {
  try {
    const parsed = JSON.parse(value);
    if (
      parsed && typeof parsed === 'object' && parsed.v === 1
      && typeof parsed.occurrenceMs === 'number'
      && (parsed.reason === 'active-chat-presence' || parsed.reason === 'conversation-moved-on')
    ) {
      return parsed as AmsgLastSkip;
    }
  } catch { /* 非 JSON → null */ }
  return null;
};

/** 给人看的一句话：为什么那一次没响。 */
export const describeLastSkip = (skip: AmsgLastSkip, formatTime: (ms: number) => string): string =>
  skip.reason === 'active-chat-presence'
    ? `${formatTime(skip.occurrenceMs)} 那次主动消息让路了——到点时你正在和 ta 聊天。`
    : `${formatTime(skip.occurrenceMs)} 那次主动消息取消了——排程之后你们的对话已经聊到别处，原本要说的话过时了。`;

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

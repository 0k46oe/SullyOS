import { ReiClient } from '@rei-standard/amsg-client';
import {
  ActiveMsg2CharacterConfig,
  ActiveMsg2ExpirePolicy,
  ActiveMsg2GlobalConfig,
  ActiveMsg2Mode,
  ActiveMsg2Recurrence,
  APIConfig,
  CharacterProfile,
  Emoji,
  EmojiCategory,
  GroupProfile,
  RealtimeConfig,
  UserProfile,
} from '../types';
import { getLastRealUserMessageAt } from './amsg2ExpireGuard';
import {
  getPendingTasks, MAX_ACTIVE_TASKS_PER_CHAR, resolveExpirePolicy, toDatetimeLocalValue,
} from './amsg2Tasks';
import { AMSG_CHAT_PRESENCE_KEY, AmsgChatPresence } from './amsgChatPresence';
import {
  AMSG_FIRE_PACK_KEY,
  AMSG_SLOT_AWAY_HINT,
  AMSG_SLOT_CURRENT_TIME,
  AMSG_SLOT_TASK_INSTRUCTION,
  AMSG_LAST_SKIP_KEY,
  AMSG_SLOT_TIME_SINCE_USER,
  AmsgFirePack,
  type AmsgLastSkip,
  amsgStateNamespace,
  packStateValue,
  parseLastSkip,
} from './amsgFirePack';
import {
  AMSG_GLOBAL_NAMESPACE,
  AMSG_TOOL_CONFIG_KEY,
  AMSG_TOOL_PACK_KEY,
  buildToolConfig,
  buildToolPack,
} from './amsgToolPack';
import { listRecallableMonths } from './agenticTools';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';
import { copyWorkerBundleToClipboard } from './instantPushClient';
import { collectMcpFireServers, getMcpUseNativeTools } from './mcpClient';
import { safeResponseJson } from './safeApi';
import { ActiveMsgStore } from './activeMsgStore';
import { KeepAlive } from './keepAlive';
import { describePushCapabilityGap } from './pushSubscribeShared';

export interface ActiveMsg2PushStatus {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  hasSubscription: boolean;
  vapidConfigured: boolean;
  detail?: string;
}

type InternalReiClient = ReiClient & {
  _encrypt: (plaintext: string) => Promise<{ iv: string; authTag: string; encryptedData: string }>;
  _decrypt: (payload: { iv: string; authTag: string; encryptedData: string }) => Promise<any>;
  // amsg-client 2.9.0-next.1：拉本 worker 自己的 VAPID 公钥（带 X-Client-Token），供订阅用。
  getVapidPublicKey: () => Promise<string>;
  // amsg-client 2.9.0-next.4：worker 特性探测。老 worker 无 /capabilities 端点 → null。
  getCapabilities: () => Promise<{ serverVersion: string; features: string[] } | null>;
};

const ACTIVE_MSG_RUNTIME_HEADER = '[ActiveMsg2]';

/** amsg-server 的 DELETE /cancel-message 找不到目标行时回的错误码（HTTP 404）。 */
const REMOTE_TASK_NOT_FOUND_CODE = 'TASK_NOT_FOUND';

// 单用户模式：所有请求打到用户自部署的 Cloudflare Worker（config.workerUrl）。
// 配了 serverToken 就每次带 X-Client-Token；worker 端配了就强制校验，缺/错回 401。
const normalizeWorkerBase = (workerUrl: string) => workerUrl.trim().replace(/\/+$/, '');

const createClient = (config: Pick<ActiveMsg2GlobalConfig, 'userId' | 'workerUrl' | 'serverToken'>) =>
  new ReiClient({
    baseUrl: normalizeWorkerBase(config.workerUrl),
    userId: config.userId,
    serverToken: config.serverToken || undefined,
  }) as InternalReiClient;

/** 面板新建任务的默认时间：半小时后，折成 datetime-local 认的本地墙钟。 */
export const getDefaultActiveMsgFirstSendTime = () =>
  toDatetimeLocalValue(new Date(Date.now() + 30 * 60_000).toISOString());

const normalizeChatApiUrl = (baseUrl: string) => `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

/** amsg-server 对 avatarUrl 的长度上限，超了整条会被拒。 */
const REMOTE_AVATAR_URL_MAX_LENGTH = 2048;

/**
 * 能交给 worker 当推送通知图标的头像地址，不合格返回 undefined。
 *
 * worker 只收公网可访问的 URL（不能是 data: URI，上限 2048 字符）。而本地角色头像基本都是
 * base64，传过去必被拒，代价是每排一条任务就在 worker 日志里刷一条
 * `avatarUrl 不合法，已置空`。这里按同一把尺先筛掉——传了本来也是被置空，通知一样退回
 * 默认图标，少一条噪音而已。
 */
export const toRemoteAvatarUrl = (avatar: string | undefined | null): string | undefined => {
  const value = avatar?.trim();
  if (!value || value.length > REMOTE_AVATAR_URL_MAX_LENGTH || /^data:/i.test(value)) return undefined;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
};

const looksLikeHtmlFallbackError = (message: string) => (
  /HTML/i.test(message) ||
  message.includes(`Unexpected token '<'`) ||
  /<!doctype/i.test(message) ||
  /<html/i.test(message)
);

const normalizeActiveMsgApiError = (error: unknown, phase: string) => {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  if (looksLikeHtmlFallbackError(message)) {
    return new Error(`主动消息 2.0 的 ${phase} 请求没有打到 Worker，而是拿到了网页 HTML。请确认设置里填的是已部署的 amsg Worker 地址，而不是某个网页地址。`);
  }
  return error instanceof Error ? error : new Error(message);
};

const ensureGlobalReady = async (): Promise<ActiveMsg2GlobalConfig> => {
  const userId = await ActiveMsgStore.ensureUserId();
  const config = await ActiveMsgStore.getGlobalConfig();
  return { ...config, userId };
};

const ensureWorkerReady = async () => {
  const config = await ensureGlobalReady();
  if (!config.workerUrl.trim()) throw new Error('请先在系统设置里填写「主动消息 2.0」的 Worker 地址。');
  return config;
};

const initializeClient = async (config: ActiveMsg2GlobalConfig) => {
  const client = createClient(config);
  try {
    await client.init();
  } catch (error) {
    throw normalizeActiveMsgApiError(error, '获取用户密钥');
  }
  return client;
};

const resolveApiConfig = (char: CharacterProfile, config: ActiveMsg2CharacterConfig, apiConfig: APIConfig) => {
  const useSecondary = config.useSecondaryApi && config.secondaryApi?.baseUrl;
  const source = useSecondary ? config.secondaryApi! : apiConfig;

  if (!source.baseUrl || !source.apiKey || !source.model) {
    throw new Error('主动消息 2.0 缺少可用的 API URL / Key / Model。');
  }

  return source;
};

const formatHistoryLine = (role: string, content: any, char: CharacterProfile, userProfile: UserProfile) => {
  const speaker = role === 'assistant' ? char.name : role === 'user' ? userProfile.name : '系统';
  const text = Array.isArray(content)
    ? content.map((part) => typeof part === 'string' ? part : JSON.stringify(part)).join('\n')
    : String(content || '');
  return `【${speaker}】\n${text.trim()}`;
};

const buildTimeGapHint = async (charId: string) => {
  const recentMessages = await DB.getRecentMessagesByCharId(charId, 200);
  return {
    // 时间差在渲染时刻才算（formatTimeSinceUser），这里只取原始时间戳——
    // 满血链路会把它放进 fire_pack，worker 到点用「fire 时刻」重算，不吃排程时的陈旧值。
    // 「真实用户消息」判定与防穿帮闸共用同一叶子 helper（见 amsg2ExpireGuard）。
    lastUserMessageAt: getLastRealUserMessageAt(recentMessages),
    recentMessages,
  };
};

// 时间性内容留槽位（AMSG_SLOT_*），由 worker 在 fire 时刻用 renderFirePack 填。
// 文案模板本身仍在前端这份代码里维护。
const buildLegacyStyleProactiveHint = (targetName: string) => {
  const target = targetName || '对方';

  return [
    '【1.0 风格主动消息提示】',
    `现在是 ${AMSG_SLOT_CURRENT_TIME}。`,
    AMSG_SLOT_AWAY_HINT,
    `这不是 ${target} 正在和你聊天，而是你突然想起了 ${target}，想主动发条消息给他/她。`,
    `像真人随手发消息一样自然一点，可以是分享刚看到的东西、轻轻吐槽、问一句近况、突然想念，或者单纯想找 ${target} 聊两句。`,
    '不要写成汇报近况，不要像在完成任务，也不要解释自己为什么会发这条消息。',
    `正文尽量短，通常 1 到 2 句就够；如果 ${target} 很久没来找你，可以轻轻带一点想念、好奇或者小小抱怨。`,
  ].join('\n');
};

// 拼出带时间槽位的完整 prompt 模板（fire_pack）：原样 putClientState 上云，
// worker 到点用 renderFirePack 填槽（所以上下文永远是最后一次聊天的状态）。
/**
 * 表情包全库（按角色过滤前）。批量同步时由调用方读一次传进来——它跟角色无关，
 * 一个角色读一遍的话，N 个角色就是 N 次全表 getAll，读回来的还是同一份。
 */
type EmojiLibrary = { all: Emoji[]; categories: EmojiCategory[] };

const readEmojiLibrary = async (): Promise<EmojiLibrary> => {
  const [all, categories] = await Promise.all([DB.getEmojis(), DB.getEmojiCategories()]);
  return { all, categories };
};

const buildFirePack = async (
  char: CharacterProfile,
  userProfile: UserProfile,
  groups: GroupProfile[],
  realtimeConfig: RealtimeConfig | undefined,
  emojiLibrary?: EmojiLibrary,
): Promise<AmsgFirePack> => {
  const [{ recentMessages, lastUserMessageAt }, library] = await Promise.all([
    buildTimeGapHint(char.id),
    emojiLibrary ? Promise.resolve(emojiLibrary) : readEmojiLibrary(),
  ]);
  const legacyHint = buildLegacyStyleProactiveHint(userProfile.name || '对方');
  // 按角色可见性过滤表情包：主动消息不经过 Chat.tsx 的 aiVisibleEmojis/visibleCategories，
  // 必须在这里复用同一套过滤，否则角色会用到只对其他角色开放的表情包。
  const { emojis, categories } = ChatPrompts.filterVisibleEmojis(
    library.all,
    library.categories,
    char.id,
  );
  const systemPrompt = await ChatPrompts.buildSystemPrompt(
    char,
    userProfile,
    groups,
    emojis,
    categories,
    recentMessages,
    realtimeConfig,
  );
  const { apiMessages } = ChatPrompts.buildMessageHistory(
    recentMessages,
    Math.min(char.contextLimit || 120, 120),
    char,
    userProfile,
    emojis,
  );

  const recentTranscript = apiMessages
    .slice(-30)
    .map((message) => formatHistoryLine(message.role, message.content, char, userProfile))
    .join('\n\n');

  // 记忆库里有哪些月份查得到 —— 提示词一直在教角色用 [[RECALL: 年-月]]，却没说过
  // 哪些月份有东西。不报菜单的话它多半不查，直接凭空编一段「回忆」出来。
  // 只写进下面这段主动消息自己的规则里，不动 chatPrompts 那条所有角色每轮都走的主链路。
  const recallableMonths = listRecallableMonths(char.memories);
  const recallHint = recallableMonths.length > 0
    ? `- 你的记忆库里存着这些月份的经历：${recallableMonths.join('、')}。想聊起其中某段时，先输出 [[RECALL: 年-月]] 把细节取回来再写，别凭印象编。`
    : null;

  const template = [
    '你将代表下面这个角色，生成一条“主动发给用户”的私聊消息。',
    '',
    '【重要规则】',
    '- 这不是回复用户刚刚发来的消息，而是角色主动来找用户聊天。',
    '- 输出只能是最终要发送的消息正文，不要解释，不要写分析，不要加引号。',
    '- 像真实聊天一样简短自然，优先 1 到 2 句，最多 3 句。',
    '- 可以用换行拆成多个聊天气泡，但不要写时间戳、名字前缀、系统提示。',
    '- 不要出现“作为AI”“系统提示”等元话语。',
    '- 语气更像真人突然想起对方时发来的私聊，不要像在完成任务。',
    '- 角色设定里描述的查记忆、读日记、联网搜索、逛小红书等能力照常可用：需要时正常输出对应标签，系统会取回结果后让你继续写。',
    ...(recallHint ? [recallHint] : []),
    '',
    '【角色系统设定】',
    systemPrompt,
    '',
    '【最近对话上下文】',
    recentTranscript || '（暂时没有最近聊天记录）',
    '',
    '【当前时刻补充】',
    `当前本地时间：${AMSG_SLOT_CURRENT_TIME}`,
    AMSG_SLOT_TIME_SINCE_USER,
    '',
    legacyHint,
    '',
    '【本次任务】',
    AMSG_SLOT_TASK_INSTRUCTION,
    '',
    // recency 末位人声锚：上面【角色系统设定】里已带「回到你自己」钢印，但被任务说明压在后面、
    // 失了 recency。这里在最后一句把它拎回来，让主动消息也从「你这个人」长出来，而不是滑回均值腔。
    `（开口前回到你自己：这条得是 ${char.name} 会发的那一条——语气、用词、节奏都只属于你。哪怕只是随口一句，也要是你。）`,
  ].join('\n');

  return {
    v: 2,
    template,
    lastUserMessageAt,
    tzOffsetMin: new Date().getTimezoneOffset(),
    targetName: userProfile.name || '对方',
  };
};

/** 按任务生成「本次任务」指令——排程时写进 task metadata，worker 到点填槽。 */
export const buildTaskInstruction = (mode: 'auto' | 'prompted', promptHint?: string): string => {
  if (mode === 'prompted') {
    return [
      '这是一条需要 AI 参与生成的主动消息。',
      '请严格围绕下面的额外提示发起私聊，但仍然保持像真人一样自然，不要像系统任务汇报。',
      `额外提示：${promptHint?.trim() || '无'}`,
    ].join('\n');
  }
  return [
    '这是一条需要 AI 自主生成的主动消息。',
    '请结合角色设定、关系状态、最近上下文与当前时间，自然地主动找用户说一到三句私聊消息。',
    promptHint?.trim() ? `可选灵感补充：${promptHint.trim()}` : '可选灵感补充：无',
  ].join('\n');
};

const ensureFutureTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('请选择有效的首次发送时间。');
  }
  if (date.getTime() <= Date.now()) {
    throw new Error('首次发送时间必须晚于当前时间。');
  }
  return date.toISOString();
};

/**
 * 任务体里 messages 的占位内容。
 *
 * 服务端要求「completePrompt 或 messages」二选一、messages 非空、content 非空字符串，
 * 所以哪怕真正的 prompt 是到点才由 worker 下发的，排程时也得塞点东西过校验。
 * 写成一眼能认出来的标记：它要是出现在 worker 日志、模型输出或者聊天气泡里，
 * 就说明 worker 的 fire hooks 没生效（正常路径下它会被 onBeforeFire 的返回值覆盖）。
 */
const AMSG2_PLACEHOLDER_PROMPT =
  'AMSG2_PLACEHOLDER_PROMPT（正式 prompt 到点由 worker onBeforeFire 下发；看到这条说明 fire hooks 未生效）';

/** client_state 上传每次尝试前等多久：数组长度即总尝试次数（首次不等）。 */
const CLIENT_STATE_BACKOFF_MS = [0, 400, 1200];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 上传一批 client_state 条目：网络抖动重试，最终失败抛错——不降级。
 *
 * 为什么这一步是硬要求：worker 到点靠 fire_pack 拿新鲜上下文，「远端有任务、云端
 * 没状态」是个不该存在的中间态。过去这里失败只 warn，任务照建，到点用排程那一刻
 * 冻结的 prompt 发——用户不知道自己收到的是旧上下文。现在传不上去就让整个排程失败，
 * 由用户 / 角色重试。
 *
 * 被 worker 点名 rejected（体积超限等结构性原因）不重试：重试不会变好，直接把原因
 * 抛出来。注意 putClientState 失败有两种形态——抛异常和回 { success: false }，
 * 两种都要接住，只判 try/catch 会漏掉后者。
 */
export const putClientStateOrThrow = async (
  client: InternalReiClient,
  entries: Array<{ namespace: string; key: string; value: string; updatedAt: number }>,
  phase: string,
): Promise<void> => {
  let lastError: unknown;

  for (const backoffMs of CLIENT_STATE_BACKOFF_MS) {
    if (backoffMs) await delay(backoffMs);

    let response: { success?: boolean; data?: { rejected?: Array<{ key: string; message?: string }> }; error?: { message?: string } } | undefined;
    try {
      response = await client.putClientState(entries) as typeof response;
    } catch (error) {
      lastError = error;
      continue;
    }

    if (!response?.success) {
      lastError = new Error(response?.error?.message || `${phase}失败。`);
      continue;
    }

    const rejected = response.data?.rejected;
    if (rejected?.length) {
      throw new Error(
        `${phase}被 Worker 拒绝：${rejected.map((r) => `${r.key}(${r.message || 'rejected'})`).join('、')}。`
        + '请确认已部署最新的 Worker 代码（设置页有版本探测）。',
      );
    }
    return;
  }

  throw normalizeActiveMsgApiError(lastError, phase);
};

/**
 * 把一个 namespace 下还有内容的条目全部清空，返回被清掉的键名。
 *
 * 先读一遍再逐条写空，而不是照着已知键名盲写，有两个原因：
 *   1. 旁路存储的键名带 clientTaskId（`xhs_session:<id>`），任务记录被
 *      pruneStaleTasks 清掉之后就再也拼不出来，只能靠读回来才知道有哪些；
 *   2. 盲写会把本来不存在的条目 upsert 出来 —— putClientState 是 upsert，
 *      "清理" 反倒变成新建。
 *
 * 和 clearClientStateValue 一样是写空串而不是删行（HTTP 的 PUT /client-state 没有
 * 删除语义，value: null 会被当无效条目跳过），留下的是几字节的空壳，内容本身没了。
 */
export const clearNamespaceValuesOrThrow = async (
  client: InternalReiClient,
  namespace: string,
): Promise<string[]> => {
  // 全局 namespace 不许走这条路：里面的 tool_config 只在配置变更时才重传，被清成空壳
  // 之后没有任何一条路会把它补回来，而 worker 到点读不到它就整条任务硬失败。
  // 这个函数目前只服务「删角色」（每角色一个 namespace），加道护栏免得将来被顺手复用。
  if (namespace === AMSG_GLOBAL_NAMESPACE) {
    throw new Error('全局云端状态不能按 namespace 清空（tool_config 清掉就没人补了）。');
  }
  const response = await client.getClientState(namespace);
  if (!response?.success) {
    throw new Error(response?.error?.message || '读取云端状态失败。');
  }
  const entries = (response.data?.entries ?? []) as Array<{ key?: string; value?: string }>;
  // 已经是空壳的条目跳过：再写一遍不会更干净，只是白占一次请求体。
  const keys = entries.filter((e) => e?.key && e?.value).map((e) => e.key as string);
  if (keys.length === 0) return [];

  const now = Date.now();
  await putClientStateOrThrow(
    client,
    keys.map((key) => ({ namespace, key, value: '', updatedAt: now })),
    '清空云端状态',
  );
  return keys;
};

/**
 * 角色侧云端状态的两条条目（fire_pack + tool_pack）。
 *
 * 「哪个 namespace 配哪个 key 配哪个 build 函数」只在这里写一遍：排程和批量同步两条路
 * 都得把同一批东西写上去，各写各的话漏一条就是 worker 到点读不到 → 整条任务硬失败。
 */
const buildCharStateEntries = async (
  char: CharacterProfile,
  firePack: AmsgFirePack,
  updatedAt: number,
) => [
  {
    namespace: amsgStateNamespace(char.id),
    key: AMSG_FIRE_PACK_KEY,
    // 压在加密之前：上游 putClientState 先加密再发，密文压不动（见 amsgFirePack）。
    value: await packStateValue(JSON.stringify(firePack)),
    updatedAt,
  },
  // v2 服务端工具循环的角色侧数据（recall 月度总结 / XHS 开关 / 角色名）。
  {
    namespace: amsgStateNamespace(char.id),
    key: AMSG_TOOL_PACK_KEY,
    value: await packStateValue(JSON.stringify(buildToolPack(char))),
    updatedAt,
  },
];

/** 全局工具凭据条目（v2 服务端工具循环用的搜索 / Notion / 飞书 / 小红书 / 自配 MCP 配置）。 */
const buildToolConfigEntry = (
  realtimeConfig: RealtimeConfig | undefined,
  updatedAt: number,
) => ({
  namespace: AMSG_GLOBAL_NAMESPACE,
  key: AMSG_TOOL_CONFIG_KEY,
  // MCP 配置在这里现读现带：三条上传路径（排程 / fire_pack 冲刷 / 设置保存）
  // 全走这个咽喉，不会出现某条路漏带的版本分叉。
  value: JSON.stringify(buildToolConfig(realtimeConfig, {
    servers: collectMcpFireServers(),
    useNativeTools: getMcpUseNativeTools(),
  })),
  updatedAt,
});

const fetchWithAuth = async (path: string, config: ActiveMsg2GlobalConfig, init: RequestInit, phase = '接口') => {
  const headers = new Headers(init.headers);
  if (config.serverToken) headers.set('X-Client-Token', config.serverToken);
  headers.set('X-User-Id', config.userId);

  try {
    const response = await fetch(`${normalizeWorkerBase(config.workerUrl)}/${path}`, {
      ...init,
      headers,
    });

    return await safeResponseJson(response);
  } catch (error) {
    throw normalizeActiveMsgApiError(error, phase);
  }
};

const encryptPayload = async (client: InternalReiClient, payload: unknown) => {
  return client._encrypt(JSON.stringify(payload));
};

const decryptPayload = async (client: InternalReiClient, payload: { iv: string; authTag: string; encryptedData: string }) => {
  return client._decrypt(payload);
};

export const ActiveMsgClient = {
  async getGlobalConfig() {
    return ensureGlobalReady();
  },

  // 生成 worker env 用的 AMSG_MASTER_KEY（32 字节 → 64 位 hex）。
  // 只在设置页展示给用户粘进 CF env，前端自己不存也用不到它。
  generateMasterKey(): string {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    return Array.from(buf, (byte) => byte.toString(16).padStart(2, '0')).join('');
  },

  // 复制站点随 build 发布的 public/amsg-worker.bundle.js（Dashboard 粘贴部署用）。
  copyWorkerBundleToClipboard(): Promise<void> {
    return copyWorkerBundleToClipboard('amsg-worker.bundle.js');
  },

  async getPushStatus(): Promise<ActiveMsg2PushStatus> {
    const config = await ensureGlobalReady();
    const workerConfigured = Boolean(config.workerUrl.trim());
    // 能力检测与 instant push / proactive push 共用 describePushCapabilityGap：
    // 它会说清缺的是三件套里的哪一件，「不支持」这三个字用户拿着没法action。
    const capabilityGap = describePushCapabilityGap();
    if (capabilityGap) {
      return {
        supported: false,
        permission: 'unsupported',
        hasSubscription: false,
        vapidConfigured: workerConfigured,
        detail: `${capabilityGap}。`,
      };
    }

    await KeepAlive.init();
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    return {
      supported: true,
      permission: Notification.permission,
      hasSubscription: Boolean(subscription),
      vapidConfigured: workerConfigured,
      detail: !workerConfigured ? '请先填写 Worker 地址。' : undefined,
    };
  },

  async ensurePushSubscription() {
    // 只需要「支不支持」这一个判断，不走 getPushStatus——那会把 KeepAlive.init /
    // serviceWorker.ready / getSubscription 整套先跑一遍，下面又原样跑一次。
    const capabilityGap = describePushCapabilityGap();
    if (capabilityGap) throw new Error(`${capabilityGap}。`);

    const config = await ensureWorkerReady();

    let permission = Notification.permission;
    if (permission !== 'granted') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      throw new Error('通知权限未授予，无法创建主动消息 2.0 的推送订阅。');
    }

    await KeepAlive.init();
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    if (existing) return existing.toJSON();

    // VAPID 公钥必须来自「这个 worker 自己」签推送用的那对密钥，否则 worker 推不动会 403。
    // 各用户自部署 worker、各有各的 VAPID，运行时从 worker 拉、不编译进前端。
    const client = createClient(config);
    let vapidPublicKey: string;
    try {
      vapidPublicKey = await client.getVapidPublicKey();
    } catch (error) {
      throw normalizeActiveMsgApiError(error, '获取 Worker VAPID 公钥');
    }
    if (!vapidPublicKey) {
      throw new Error('Worker 没返回 VAPID 公钥，请确认已配置 VAPID 并部署了最新 worker。');
    }
    const subscription = await client.subscribePush(vapidPublicKey, registration);
    return subscription.toJSON();
  },

  // 单用户「连接」：先 POST /init-tenant 让 worker 在自己的 D1 里幂等建表
  // （Dashboard 粘贴部署的用户不用碰 SQL），再拿一次 user key 验证地址与鉴权都通。
  async connect() {
    const config = await ensureWorkerReady();
    const initResponse = await fetchWithAuth('init-tenant', config, { method: 'POST' }, '初始化数据库');
    if (!initResponse?.success) {
      throw new Error(initResponse?.error?.message || '主动消息 2.0 初始化数据库失败，请确认 Worker 已绑定 D1（变量名 DB）。');
    }
    await initializeClient(config);
    await ActiveMsgStore.saveGlobalConfig({ ...config, initializedAt: Date.now() });
    return { ok: true, userId: config.userId };
  },

  // 分页全量：循环 messages?limit=100&offset=<n>，每页解密后读 tasks 与 pagination.hasMore，
  // 拉到最后一页为止。任一页失败整体抛错——不能拿半页结果去判「远端不存在」（会误伤没拉到的任务）。
  // 每条任务带上游投影的顶层 charId / clientTaskId，供按角色对账/关闭全部。
  async listAllTasks(): Promise<any[]> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);

    const all: any[] = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const response = await fetchWithAuth(`messages?limit=${limit}&offset=${offset}`, config, {
        method: 'GET',
        headers: {
          'X-Response-Encrypted': 'true',
          'X-Encryption-Version': '1',
        },
      }, '读取任务列表');

      if (!response?.success) {
        throw new Error(response?.error?.message || '读取主动消息 2.0 任务列表失败。');
      }

      const page = await decryptPayload(client, response.data);
      const pageTasks: any[] = page?.tasks || [];
      all.push(...pageTasks);

      if (!page?.pagination?.hasMore || pageTasks.length === 0) break;
      offset += limit;
    }
    return all;
  },

  /**
   * 某个角色在远端还活着的任务 uuid（对账 / 关闭全部用；上游按任务投影顶层 charId）。
   *
   * 老 worker（amsg-server < 2.6.0-next.5）不投影 charId：远端明明有任务，这里却一条都
   * 匹配不上。空结果此时不是「远端没有」的证据，直接抛错让调用方走各自的降级——面板
   * 对账整体关掉「远端不存在」徽标，关闭 2.0 退回本地全量清单——而不是拿半份证据误判。
   */
  async listRemoteTaskUuidsForChar(charId: string): Promise<string[]> {
    const tasks = await this.listAllTasks();
    if (tasks.length > 0 && tasks.every((t) => t?.charId == null)) {
      throw new Error('worker 版本过旧：任务列表没有 charId 投影，无法按角色对账，请在设置里重新粘贴部署。');
    }
    return tasks
      .filter((t) => t?.charId === charId && typeof t?.uuid === 'string')
      .map((t) => t.uuid as string);
  },

  /**
   * 取消一个远端任务。**幂等**：远端已经没有这一条（一次性任务发完就删行、或在别处
   * 取消过），amsg-server 回 404 `TASK_NOT_FOUND`，那正是取消要达到的终态，算成功并
   * 带上 alreadyGone=true 交给调用方——当失败处理会让「取消一条已经发过的任务」显示
   * 成红色的「远端取消失败，可重试」，其实没有任何东西需要重试。
   * 其余错误（鉴权、D1 挂了、网络）照常抛，别一起吞掉。
   */
  async cancelTask(taskUuid: string): Promise<{ uuid: string; alreadyGone: boolean }> {
    const config = await ensureWorkerReady();
    const response = await fetchWithAuth(`cancel-message?id=${encodeURIComponent(taskUuid)}`, config, {
      method: 'DELETE',
    }, '取消任务');

    if (!response?.success) {
      if (response?.error?.code === REMOTE_TASK_NOT_FOUND_CODE) {
        return { uuid: taskUuid, alreadyGone: true };
      }
      throw new Error(response?.error?.message || '取消主动消息 2.0 任务失败。');
    }

    return { uuid: taskUuid, alreadyGone: false };
  },

  /**
   * 取消某个角色在远端的全部任务（关闭 2.0 / 删角色共用）。
   *
   * 以远端清单为准：本地 pending 派生会漏掉「已过点但 Cron 还没消费」的一次性任务，
   * 只按本地清单取消会留下还会响的幽灵任务。远端读不到（网络故障 / 老 worker 没
   * charId 投影）才退回调用方给的本地清单——半份证据也比不取消强。
   *
   * 逐条取消，单条失败记进 failed 继续跑完其余的：一条网络抖动不该让剩下的任务都留着。
   */
  async cancelAllTasksForChar(
    charId: string,
    localTaskUuids: string[],
  ): Promise<{ targets: string[]; failed: Set<string> }> {
    let targets: string[];
    try {
      targets = await this.listRemoteTaskUuidsForChar(charId);
    } catch {
      targets = localTaskUuids;
    }
    const failed = new Set<string>();
    for (const uuid of targets) {
      try { await this.cancelTask(uuid); } catch { failed.add(uuid); }
    }
    return { targets, failed };
  },

  async scheduleCharacterTask(params: {
    char: CharacterProfile;
    /** 角色级共享设置（secondaryApi / maxTokens）。 */
    config: ActiveMsg2CharacterConfig;
    /** 本次要排的任务。 */
    task: {
      mode: ActiveMsg2Mode;
      firstSendTime: string;
      recurrenceType: ActiveMsg2Recurrence;
      promptHint?: string;
      userMessage?: string;
      expirePolicy?: ActiveMsg2ExpirePolicy;
    };
    /** 编辑/续期时传旧任务 uuid：先取消它再新建（不传 = 纯新建）。 */
    replaceTaskUuid?: string;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig: RealtimeConfig;
    apiConfig: APIConfig;
  }) {
    const { char, config, task, replaceTaskUuid, userProfile, groups, realtimeConfig, apiConfig } = params;
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const pushSubscription = await this.ensurePushSubscription();

    // 数量封顶：待触发任务（不含被替换的那个）满 5 个就拒绝，让角色/用户先清。
    const pendingOthers = getPendingTasks(config, Date.now())
      .filter((t) => t.taskUuid !== replaceTaskUuid);
    if (pendingOthers.length >= MAX_ACTIVE_TASKS_PER_CHAR) {
      throw new Error(`该角色的待触发任务已达上限 ${MAX_ACTIVE_TASKS_PER_CHAR} 个，请先取消或合并已有任务。`);
    }

    const firstSendTime = ensureFutureTime(task.firstSendTime);
    // AI 模式的 prompt 只有一条来源：firePack 上传 client_state，worker 到点现场填槽。
    // 任务体里不再冻结一份渲染好的 prompt——读不到 fire_pack 就直接报错，没有第二条路，
    // 留着那份快照只是白占请求体（完整角色卡 + 世界书）。
    const firePack = task.mode === 'fixed'
      ? null
      : await buildFirePack(char, userProfile, groups, realtimeConfig);
    // 防穿帮闸锚点：排程这一刻的最后一条真实用户消息（见 utils/amsg2ExpireGuard.ts）。
    // 与 fire_pack 的 lastUserMessageAt 同源，直接复用——各读各的就是同一段 200 条历史
    // 扫两遍。fixed 任务恒 force，锚点用不到，也就不必去读。
    const anchorMs = firePack?.lastUserMessageAt ?? 0;
    // 任务身份：客户端自造 clientTaskId——远端 uuid 要创建成功后才有，而 metadata
    // 必须在创建时就带上归属键；push 原样透传，送达归属全靠它。
    const clientTaskId = crypto.randomUUID();

    const remoteAvatarUrl = toRemoteAvatarUrl(char.avatar);
    const payload: Record<string, any> = {
      contactName: char.name,
      // 本地 base64 头像过不了 worker 的校验，不合格干脆不带这个字段（见 toRemoteAvatarUrl）。
      ...(remoteAvatarUrl ? { avatarUrl: remoteAvatarUrl } : {}),
      messageType: task.mode,
      messageSubtype: 'chat',
      firstSendTime,
      recurrenceType: task.recurrenceType,
      pushSubscription,
      metadata: {
        charId: char.id,
        charName: char.name,
        source: 'active_msg_2',
        // worker 满血链路的 onLLMOutput 拿不到任务顶层的 messageType，靠 metadata 透传
        // 还原 push.messageType（老任务没这字段时 worker 回退 'auto'，收侧只展示不路由）。
        amsgMode: task.mode,
        // 任务身份 + 防穿帮闸字段：worker onBeforeFire 与客户端送达兜底都从这里读。
        // fixed 恒为 force——它走不了 worker 闸（taskNeedsLlm=false），语义统一钉死。
        amsgClientTaskId: clientTaskId,
        amsgExpirePolicy: resolveExpirePolicy(task.mode, task.expirePolicy),
        amsgRecurrence: task.recurrenceType,
        amsgAnchorMs: anchorMs,
      },
    };

    if (task.mode === 'fixed') {
      const userMessage = task.userMessage?.trim();
      if (!userMessage) throw new Error('固定消息模式需要填写消息内容。');
      payload.userMessage = userMessage;
    } else {
      const activeApi = resolveApiConfig(char, config, apiConfig);
      // 「本次任务」指令随任务 metadata 走，worker 到点拿它填 fire_pack 的指令槽。
      payload.metadata.amsgTaskInstruction = buildTaskInstruction(task.mode, task.promptHint);
      // 服务端要求「completePrompt 或 messages」二选一，且 messages 必须非空、
      // content 必须非空字符串，所以这里给一条占位。到点真正发给 LLM 的 messages 由
      // worker 的 onBeforeFire 返回值覆盖（库用 { ...payload, messages } 调 LLM），
      // 这条内容永远不参与生成——它要是真出现在哪里，就说明 worker 的 fire hooks 没生效。
      payload.messages = [{ role: 'user', content: AMSG2_PLACEHOLDER_PROMPT }];
      payload.apiUrl = normalizeChatApiUrl(activeApi.baseUrl);
      payload.apiKey = activeApi.apiKey;
      payload.primaryModel = activeApi.model;
      if (config.maxTokens && config.maxTokens > 0) {
        payload.maxTokens = config.maxTokens;
      }
    }

    // ── 先传云端状态，成功了再建任务 ──
    // fire_pack / tool_pack 都按角色存、不依赖任务 id，所以顺序可以倒过来。倒过来的好处：
    // 上传失败时远端还没有任务，直接抛错就行，既不用回滚、也不会留下「用户看到排程失败、
    // 远端却会到点触发」的幽灵任务。反过来（先建后传）失败时只剩降级或回滚两条路，都更差。
    //
    // 反向的残留是无害的那一侧：上传成功但建任务失败 → 云端多一份没人引用的 fire_pack，
    // 不会被读（worker 只在 fire 某个任务时读它），下次同步直接覆盖。
    //
    // 大值（胖角色的完整角色卡 / 世界书）由 amsg-server 2.6.0-next.4+ 在 worker 存储层
    // 透明分块，客户端整条直传即可；老 worker 会拒超限条目 → putClientStateOrThrow 抛错。
    if (firePack) {
      const now = Date.now();
      await putClientStateOrThrow(client, [
        ...(await buildCharStateEntries(char, firePack, now)),
        buildToolConfigEntry(realtimeConfig, now),
      ], '上传云端状态');
    }

    const encrypted = await encryptPayload(client, payload);
    const response = await fetchWithAuth('schedule-message', globalConfig, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payload-Encrypted': 'true',
        'X-Encryption-Version': '1',
      },
      body: JSON.stringify(encrypted),
    }, '创建任务');

    if (!response?.success) {
      throw new Error(response?.error?.message || '主动消息 2.0 任务创建失败。');
    }

    // 先建后删（Codex #4）：新任务确认创建成功才取消旧的——反过来一旦创建失败，
    // 旧任务已删、新任务没建，两头空。取消失败时新旧短暂并存于远端，把状态交还
    // 调用方（保留旧记录 + 标错 + 可重试），绝不静默。
    let replacedCancelFailed = false;
    if (replaceTaskUuid) {
      try {
        await this.cancelTask(replaceTaskUuid);
      } catch (error) {
        replacedCancelFailed = true;
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 替换后取消旧任务失败（远端新旧并存，待重试）`, error);
      }
    }

    return {
      ...(response.data as { uuid: string; status: string; nextSendAt?: string }),
      anchorMs,
      clientTaskId,
      replacedCancelFailed,
    };
  },

  // 同角色活跃会话租约：只 PUT 这一条几十字节的 chat_presence，不复用胖 fire_pack。
  // worker 对 expire AI 任务到点前先读它——新鲜则 skip，避免正在聊天时又弹主动消息。
  // 写入失败由调用方（amsgStateSync 的 lease timer）只 warn，45s TTL 自然失效。
  async syncChatPresence(charId: string, presence: AmsgChatPresence): Promise<void> {
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const response = await client.putClientState([{
      namespace: amsgStateNamespace(charId),
      key: AMSG_CHAT_PRESENCE_KEY,
      value: JSON.stringify(presence),
      updatedAt: presence.activeAt,
    }]);
    if (!response?.success) {
      throw new Error(response?.error?.message || '上传活跃会话租约失败。');
    }
  },

  // 满血同步：把一批角色的最新 fire_pack 合成一次 putClientState 上传（amsgStateSync
  // 去抖后调用；iOS 切后台只有几秒存活窗口，多角色也必须一次请求写完）。
  // 这里只是拿最新聊天状态去刷新云端那份，失败由调用方 warn（沿用上一份，上下文旧一点）。
  async syncCharFirePacks(items: Array<{
    char: CharacterProfile;
    config: ActiveMsg2CharacterConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig?: RealtimeConfig;
  }>): Promise<void> {
    if (!items.length) return;
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const now = Date.now();
    // 表情包全库与角色无关，整批读一次就够——放在循环里的话 N 个角色要跑 2N 次全表
    // getAll（表情记录带图片数据），拿回来的还是同一份。
    const emojiLibrary = await readEmojiLibrary();
    const entries = [];
    // 逐个串行：并发跑会同时开 N 个 IDB 事务，正是 instant push 那次超时的连接风暴成因。
    for (const item of items) {
      const firePack = await buildFirePack(
        item.char, item.userProfile, item.groups, item.realtimeConfig, emojiLibrary,
      );
      // 大值由 amsg-server 2.6.0-next.4+ 在 worker 存储层透明分块，整条直传，
      // 内容一个字不裁；老 worker 拒超限条目 → 设置页 capabilities 探测亮牌。
      entries.push(...(await buildCharStateEntries(item.char, firePack, now)));
    }
    const response = await client.putClientState(entries);
    if (!response?.success) {
      throw new Error(response?.error?.message || '上传云端状态失败。');
    }
    // amsg-server 2.6.0-next.4+ 局部失败语义：单个坏条目只拒自己，不连坐同批。
    // 被拒的条目点名 warn 出来（该角色沿用上一份 fire_pack，其余角色不受影响）。
    const rejected = (response as { data?: { rejected?: Array<{ namespace: string; key: string; message?: string }> } })
      .data?.rejected;
    if (rejected && rejected.length > 0) {
      console.warn(
        `${ACTIVE_MSG_RUNTIME_HEADER} 云端状态部分条目被拒（对应角色沿用上一份 fire_pack）`,
        rejected.map((r) => `${r.namespace}/${r.key}: ${r.message || 'rejected'}`),
      );
    }
  },

  async syncToolConfig(realtimeConfig: RealtimeConfig | undefined): Promise<void> {
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const response = await client.putClientState([buildToolConfigEntry(realtimeConfig, Date.now())]);
    if (!response?.success) {
      throw new Error(response?.error?.message || '上传工具凭据失败。');
    }
  },

  // worker 特性探测（amsg-server 2.6.0-next.4+ 的 GET /capabilities）。
  // 老部署没有这个端点 → null。设置页用它亮「worker 需要重新粘贴部署」的牌子，
  // 防止版本落后时新特性静默降级、用户以为功能坏了。不需要 init（无加密参与）。
  async getCapabilities(): Promise<{ serverVersion: string; features: string[] } | null> {
    const globalConfig = await ensureWorkerReady();
    const client = createClient(globalConfig);
    return client.getCapabilities();
  },

  /**
   * 取回 worker 旁路存下的一份云端状态（push 装不下的大内容，见 amsgXhsSessionKey）。
   * 键不存在、或者内容已被取走清空，都返回 null 交调用方决定——不要在这里编一个空壳
   * 出来，那会让「数据还没取回」和「本来就没有」变成同一件事。
   */
  async readClientStateValue(namespace: string, key: string): Promise<string | null> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const response = await client.getClientState(namespace);
    if (!response?.success) {
      throw new Error(response?.error?.message || '读取云端状态失败。');
    }
    const entries = (response.data?.entries ?? []) as Array<{ key: string; value: string }>;
    const hit = entries.find((e) => e?.key === key);
    return hit?.value ? hit.value : null;
  },

  /**
   * 防穿帮闸最近一次拦下了哪次触发（没有记录 / 读不出来一律 null）。
   *
   * 闸跳过一次 fire 时不发任何 push，而远端那行任务照样被消费掉——客户端事后分不出
   * 「让路了」和「发出去但没收到」。这条记录就是 worker 留下的那句解释，面板照实说明。
   * 读失败按「没有记录」处理：这是一句锦上添花的说明，不该让面板打不开。
   */
  async readLastSkip(charId: string): Promise<AmsgLastSkip | null> {
    try {
      const value = await this.readClientStateValue(amsgStateNamespace(charId), AMSG_LAST_SKIP_KEY);
      return value ? parseLastSkip(value) : null;
    } catch {
      return null;
    }
  },

  /**
   * 取回落库后把云端那份的内容清掉，腾回 D1 空间。
   *
   * 这里是**写空串**而不是删除整行：`value: null` 的删除语义只有 hook 侧的
   * `ctx.writeState` 有，HTTP 的 `PUT /client-state` 会把这条当无效条目跳过、
   * 内容原封不动（harness S6b 钉住了这个差异）。留一个几字节的空壳无所谓——键是
   * 每任务固定的，下次触发直接覆盖，存量本来就有上限。
   */
  async clearClientStateValue(namespace: string, key: string): Promise<void> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    await client.putClientState([{ namespace, key, value: '', updatedAt: Date.now() }]);
  },

  /**
   * 清掉某个角色在云端 client_state 里的全部条目（fire_pack / tool_pack /
   * 活跃会话租约 / 旁路存的小红书会话），删角色时用。
   *
   * 为什么单独有这么一个：设置页的「清除云端状态」是全局的、要用户主动去点，
   * 删一个角色时该走的是只清这一个角色的路。返回被清掉的键名供调用方记账。
   */
  async clearCharClientState(charId: string): Promise<string[]> {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    return clearNamespaceValuesOrThrow(client, amsgStateNamespace(charId));
  },

  /**
   * 清空该用户在 worker D1 里的全部 client_state（设置页「清除云端状态」按钮），
   * 清完立刻把全局工具凭据补回去。
   *
   * 为什么补传这一步是必须的：云端有三份数据，角色上下文与角色工具数据每轮聊完都会
   * 重新同步（见 syncCharFirePacks），只有全局的 tool_config 是「改的时候才传」——
   * 它没有别的补写时机。而 worker 到点三份缺一就硬失败（见 worker/amsg/src/index.ts
   * 的 fireStateError），于是清空之后已排程的 AI 任务会一直失败，聊多少轮天都不会好。
   *
   * 清空这个动作本身就是一次「云端凭据变没了」的变更，所以在这里就地补回来，
   * 不必让每轮同步都白传一遍。任务表跟 client_state 不在一起、不受清空影响，
   * 所以这也是「任务还活着、凭据却没了」的唯一入口，堵住这里就够。
   *
   * 补传失败不算清空失败（清空确实成功了），返回值把结果交给调用方去提示。
   */
  async clearClientState(
    realtimeConfig: RealtimeConfig | undefined,
  ): Promise<{ deleted: number; toolConfigRestored: boolean }> {
    const config = await ensureWorkerReady();
    const client = createClient(config);
    const response = await client.clearClientState();
    if (!response?.success) {
      throw new Error(response?.error?.message || '清除云端状态失败。');
    }
    const { deleted } = response.data as { deleted: number };

    let toolConfigRestored = true;
    try {
      const authed = await initializeClient(config);
      await putClientStateOrThrow(
        authed,
        [buildToolConfigEntry(realtimeConfig, Date.now())],
        '重新上传工具凭据',
      );
    } catch (error) {
      console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 清空后补传工具凭据失败`, error);
      toolConfigRestored = false;
    }
    return { deleted, toolConfigRestored };
  },
};

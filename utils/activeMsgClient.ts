import { ReiClient } from '@rei-standard/amsg-client';
import {
  ActiveMsg2CharacterConfig,
  ActiveMsg2GlobalConfig,
  APIConfig,
  CharacterProfile,
  GroupProfile,
  RealtimeConfig,
  UserProfile,
} from '../types';
import {
  AMSG_FIRE_PACK_KEY,
  AMSG_SLOT_AWAY_HINT,
  AMSG_SLOT_CURRENT_TIME,
  AMSG_SLOT_TIME_SINCE_USER,
  AmsgFirePack,
  amsgStateNamespace,
  renderFirePack,
} from './amsgFirePack';
import {
  AMSG_GLOBAL_NAMESPACE,
  AMSG_TOOL_CONFIG_KEY,
  AMSG_TOOL_PACK_KEY,
  buildToolConfig,
  buildToolPack,
} from './amsgToolPack';
import { ChatPrompts } from './chatPrompts';
import { DB } from './db';
import { safeResponseJson } from './safeApi';
import { ActiveMsgStore } from './activeMsgStore';
import { KeepAlive } from './keepAlive';

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

// 单用户模式：所有请求打到用户自部署的 Cloudflare Worker（config.workerUrl）。
// 配了 serverToken 就每次带 X-Client-Token；worker 端配了就强制校验，缺/错回 401。
const normalizeWorkerBase = (workerUrl: string) => workerUrl.trim().replace(/\/+$/, '');

const createClient = (config: Pick<ActiveMsg2GlobalConfig, 'userId' | 'workerUrl' | 'serverToken'>) =>
  new ReiClient({
    baseUrl: normalizeWorkerBase(config.workerUrl),
    userId: config.userId,
    serverToken: config.serverToken || undefined,
  }) as InternalReiClient;

export const getDefaultActiveMsgFirstSendTime = () => {
  const base = new Date();
  base.setMinutes(base.getMinutes() + 30);
  const offset = base.getTimezoneOffset();
  const local = new Date(base.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 16);
};

const normalizeChatApiUrl = (baseUrl: string) => `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

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
  const lastRealUserMessage = [...recentMessages].reverse().find((message) => (
    message.role === 'user' && !message.metadata?.proactiveHint
  ));

  return {
    // 时间差在渲染时刻才算（formatTimeSinceUser），这里只取原始时间戳——
    // 满血链路会把它放进 fire_pack，worker 到点用「fire 时刻」重算，不吃排程时的陈旧值。
    lastUserMessageAt: lastRealUserMessage ? lastRealUserMessage.timestamp : null,
    recentMessages,
  };
};

// 时间性内容留槽位（AMSG_SLOT_*），由 renderFirePack 统一填——排程兜底路径立即填，
// 满血路径由 worker 在 fire 时刻填。文案模板本身仍在前端这份代码里维护。
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

// 拼出带时间槽位的完整 prompt 模板（fire_pack）。两条路径共用：
//   - 排程时：renderFirePack(pack, Date.now()) 立即填槽 → completePrompt 冻结兜底
//   - 满血同步：pack 原样 putClientState 上云，worker 到点再填槽（上下文不过期）
const buildFirePack = async (
  char: CharacterProfile,
  config: ActiveMsg2CharacterConfig,
  userProfile: UserProfile,
  groups: GroupProfile[],
  realtimeConfig: RealtimeConfig | undefined,
): Promise<AmsgFirePack> => {
  const { recentMessages, lastUserMessageAt } = await buildTimeGapHint(char.id);
  const legacyHint = buildLegacyStyleProactiveHint(userProfile.name || '对方');
  // 按角色可见性过滤表情包：主动消息不经过 Chat.tsx 的 aiVisibleEmojis/visibleCategories，
  // 必须在这里复用同一套过滤，否则角色会用到只对其他角色开放的表情包。
  const { emojis, categories } = ChatPrompts.filterVisibleEmojis(
    await DB.getEmojis(),
    await DB.getEmojiCategories(),
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

  const modeInstruction = (() => {
    if (config.mode === 'prompted') {
      return [
        '这是一条需要 AI 参与生成的主动消息。',
        '请严格围绕下面的额外提示发起私聊，但仍然保持像真人一样自然，不要像系统任务汇报。',
        `额外提示：${config.promptHint?.trim() || '无'}`,
      ].join('\n');
    }

    if (config.mode === 'auto') {
      return [
        '这是一条需要 AI 自主生成的主动消息。',
        '请结合角色设定、关系状态、最近上下文与当前时间，自然地主动找用户说一到三句私聊消息。',
        config.promptHint?.trim() ? `可选灵感补充：${config.promptHint.trim()}` : '可选灵感补充：无',
      ].join('\n');
    }

    return '这是固定消息模式，不应该走 AI 生成。';
  })();

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
    modeInstruction,
    '',
    // recency 末位人声锚：上面【角色系统设定】里已带「回到你自己」钢印，但被任务说明压在后面、
    // 失了 recency。这里在最后一句把它拎回来，让主动消息也从「你这个人」长出来，而不是滑回均值腔。
    `（开口前回到你自己：这条得是 ${char.name} 会发的那一条——语气、用词、节奏都只属于你。哪怕只是随口一句，也要是你。）`,
  ].join('\n');

  return {
    v: 1,
    template,
    lastUserMessageAt,
    tzOffsetMin: new Date().getTimezoneOffset(),
    targetName: userProfile.name || '对方',
  };
};

const buildCompletePrompt = async (
  char: CharacterProfile,
  config: ActiveMsg2CharacterConfig,
  userProfile: UserProfile,
  groups: GroupProfile[],
  realtimeConfig: RealtimeConfig,
) => {
  const pack = await buildFirePack(char, config, userProfile, groups, realtimeConfig);
  return renderFirePack(pack, Date.now());
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

  // 复制最新版 amsg worker bundle 到剪贴板（Dashboard 粘贴部署用）。
  // 和 instantPushClient.copyInstantWorkerBundleToClipboard 同款套路：
  // 读站点随 build 发布的 public/amsg-worker.bundle.js，抛原始错误让调用方决定怎么显示。
  async copyWorkerBundleToClipboard(): Promise<void> {
    const base = import.meta.env.BASE_URL || '/';
    const res = await fetch(`${base}amsg-worker.bundle.js`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    await navigator.clipboard.writeText(text);
  },

  async getPushStatus(): Promise<ActiveMsg2PushStatus> {
    const config = await ensureGlobalReady();
    const workerConfigured = Boolean(config.workerUrl.trim());
    const supported = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
    if (!supported) {
      return {
        supported: false,
        permission: 'unsupported',
        hasSubscription: false,
        vapidConfigured: workerConfigured,
        detail: '当前浏览器不支持 Web Push。',
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
    const pushStatus = await this.getPushStatus();
    if (!pushStatus.supported) throw new Error(pushStatus.detail || '当前环境不支持推送。');

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

  async listTasks() {
    const config = await ensureWorkerReady();
    const client = await initializeClient(config);
    const response = await fetchWithAuth('messages', config, {
      method: 'GET',
      headers: {
        'X-Response-Encrypted': 'true',
        'X-Encryption-Version': '1',
      },
    }, '读取任务列表');

    if (!response?.success || response?.encrypted !== true) {
      return response?.data?.tasks || [];
    }

    const decrypted = await decryptPayload(client, response.data);
    return decrypted?.tasks || [];
  },

  async cancelTask(taskUuid: string) {
    const config = await ensureWorkerReady();
    const response = await fetchWithAuth(`cancel-message?id=${encodeURIComponent(taskUuid)}`, config, {
      method: 'DELETE',
    }, '取消任务');

    if (!response?.success) {
      throw new Error(response?.error?.message || '取消主动消息 2.0 任务失败。');
    }

    return response.data;
  },

  async scheduleCharacterTask(params: {
    char: CharacterProfile;
    config: ActiveMsg2CharacterConfig;
    userProfile: UserProfile;
    groups: GroupProfile[];
    realtimeConfig: RealtimeConfig;
    apiConfig: APIConfig;
  }) {
    const { char, config, userProfile, groups, realtimeConfig, apiConfig } = params;
    const globalConfig = await ensureWorkerReady();
    const client = await initializeClient(globalConfig);
    const pushSubscription = await this.ensurePushSubscription();

    if (config.taskUuid) {
      try {
        await this.cancelTask(config.taskUuid);
      } catch (error) {
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} cancel old task failed`, error);
      }
    }

    const firstSendTime = ensureFutureTime(config.firstSendTime);
    const payload: Record<string, any> = {
      contactName: char.name,
      avatarUrl: char.avatar,
      messageType: config.mode,
      messageSubtype: 'chat',
      firstSendTime,
      recurrenceType: config.recurrenceType,
      pushSubscription,
      metadata: {
        charId: char.id,
        charName: char.name,
        source: 'active_msg_2',
        // worker 满血链路的 onLLMOutput 拿不到任务顶层的 messageType，靠 metadata 透传
        // 还原 push.messageType（老任务没这字段时 worker 回退 'auto'，收侧只展示不路由）。
        amsgMode: config.mode,
      },
    };

    // AI 模式同时产两份：renderFirePack 立即填槽 → completePrompt 冻结兜底（老 worker /
    // 没同步上状态时照旧能跑）；firePack 本体在任务建成后上传 client_state，worker 到点现场填槽。
    let firePack: AmsgFirePack | null = null;
    if (config.mode === 'fixed') {
      const userMessage = config.userMessage?.trim();
      if (!userMessage) throw new Error('固定消息模式需要填写消息内容。');
      payload.userMessage = userMessage;
    } else {
      const activeApi = resolveApiConfig(char, config, apiConfig);
      firePack = await buildFirePack(char, config, userProfile, groups, realtimeConfig);
      payload.completePrompt = renderFirePack(firePack, Date.now());
      payload.apiUrl = normalizeChatApiUrl(activeApi.baseUrl);
      payload.apiKey = activeApi.apiKey;
      payload.primaryModel = activeApi.model;
      if (config.maxTokens && config.maxTokens > 0) {
        payload.maxTokens = config.maxTokens;
      }
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

    if (firePack) {
      try {
        const now = Date.now();
        // 大值（胖角色的完整角色卡/世界书）由 amsg-server 2.6.0-next.4+ 在 worker
        // 存储层透明分块，客户端整条直传即可；老 worker 会拒超限条目 → 设置页有
        // capabilities 探测亮「重新部署」牌。
        await client.putClientState([
          {
            namespace: amsgStateNamespace(char.id),
            key: AMSG_FIRE_PACK_KEY,
            value: JSON.stringify(firePack),
            updatedAt: now,
          },
          // v2 服务端工具循环的数据（recall 月度总结 / 工具凭据），与 fire_pack 同批上云。
          {
            namespace: amsgStateNamespace(char.id),
            key: AMSG_TOOL_PACK_KEY,
            value: JSON.stringify(buildToolPack(char)),
            updatedAt: now,
          },
          {
            namespace: AMSG_GLOBAL_NAMESPACE,
            key: AMSG_TOOL_CONFIG_KEY,
            value: JSON.stringify(buildToolConfig(realtimeConfig)),
            updatedAt: now,
          },
        ]);
      } catch (error) {
        // 同步失败不影响任务本身：completePrompt 兜底仍冻结在任务里，worker 走老链路。
        console.warn(`${ACTIVE_MSG_RUNTIME_HEADER} 排程后同步 fire_pack 失败（有冻结 prompt 兜底）`, error);
      }
    }

    return response.data as { uuid: string; status: string; nextSendAt?: string };
  },

  // 满血同步：把一批角色的最新 fire_pack 合成一次 putClientState 上传（amsgStateSync
  // 去抖后调用；iOS 切后台只有几秒存活窗口，多角色也必须一次请求写完）。
  // 老 worker 没有 /client-state 端点会 404 → 抛错由调用方 warn，一切照旧走冻结 prompt。
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
    const entries = [];
    for (const item of items) {
      const firePack = await buildFirePack(
        item.char, item.config, item.userProfile, item.groups, item.realtimeConfig,
      );
      // 大值由 amsg-server 2.6.0-next.4+ 在 worker 存储层透明分块，整条直传，
      // 内容一个字不裁；老 worker 拒超限条目 → 设置页 capabilities 探测亮牌。
      entries.push({
        namespace: amsgStateNamespace(item.char.id),
        key: AMSG_FIRE_PACK_KEY,
        value: JSON.stringify(firePack),
        updatedAt: now,
      });
      // v2 服务端工具循环的角色侧数据（recall 月度总结 / XHS 开关 / 角色名）。
      entries.push({
        namespace: amsgStateNamespace(item.char.id),
        key: AMSG_TOOL_PACK_KEY,
        value: JSON.stringify(buildToolPack(item.char)),
        updatedAt: now,
      });
    }
    // 工具凭据是全局一份：取批里第一份带 realtimeConfig 的快照。整批都没带就不写，
    // 避免把云端已有的可用凭据覆盖成全禁用。
    const withRealtime = items.find((item) => item.realtimeConfig);
    if (withRealtime) {
      entries.push({
        namespace: AMSG_GLOBAL_NAMESPACE,
        key: AMSG_TOOL_CONFIG_KEY,
        value: JSON.stringify(buildToolConfig(withRealtime.realtimeConfig)),
        updatedAt: now,
      });
    }

    const response = await client.putClientState(entries);
    if (!response?.success) {
      throw new Error(response?.error?.message || '上传云端状态失败。');
    }
    // amsg-server 2.6.0-next.4+ 局部失败语义：单个坏条目只拒自己，不连坐同批。
    // 被拒的条目点名 warn 出来（该角色到点退冻结提示词，其余角色不受影响）。
    const rejected = (response as { data?: { rejected?: Array<{ namespace: string; key: string; message?: string }> } })
      .data?.rejected;
    if (rejected && rejected.length > 0) {
      console.warn(
        `${ACTIVE_MSG_RUNTIME_HEADER} 云端状态部分条目被拒（对应角色退冻结提示词兜底）`,
        rejected.map((r) => `${r.namespace}/${r.key}: ${r.message || 'rejected'}`),
      );
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

  // 清空该用户在 worker D1 里的全部 client_state（设置页「清除云端状态」按钮）。
  async clearClientState(): Promise<{ deleted: number }> {
    const config = await ensureWorkerReady();
    const client = createClient(config);
    const response = await client.clearClientState();
    if (!response?.success) {
      throw new Error(response?.error?.message || '清除云端状态失败。');
    }
    return response.data as { deleted: number };
  },
};

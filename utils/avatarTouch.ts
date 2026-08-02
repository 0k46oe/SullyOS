import type {
  APIConfig,
  CharacterProfile,
  CompanionTouchReaction,
  UserProfile,
} from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { ChatPrompts } from './chatPrompts';
import { extractContent, safeFetchJson } from './safeApi';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { parseCallAssistantMessage, stripCallTextFormatting } from './callReplyFormat';
import {
  DEFAULT_AVATAR_PERFORMANCE,
  inferAvatarPerformanceFromText,
  type AvatarPerformanceDirection,
} from './avatarPerformance';

export const AVATAR_TOUCH_ZONES = ['head', 'face', 'hand', 'body', 'other'] as const;
export type AvatarTouchZone = typeof AVATAR_TOUCH_ZONES[number];
export const DEFAULT_COMPANION_TOUCH_ZONES: AvatarTouchZone[] = ['head', 'face', 'hand', 'body'];
export type AvatarTouchReactionPack = Partial<Record<AvatarTouchZone, CompanionTouchReaction[]>>;

export interface AvatarTouchRequest {
  nonce: number;
  /** CSS-pixel coordinates in the avatar canvas. */
  x: number;
  y: number;
  /** Normalized stage coordinates, 0..1. */
  normalizedX: number;
  normalizedY: number;
}

export interface AvatarTouchHit extends AvatarTouchRequest {
  zone: AvatarTouchZone;
  source: 'live2d-hit-area' | 'live2d-bounds' | 'vrm-raycast' | 'portrait-bounds';
  rawAreas: string[];
}

export interface AvatarTouchRecord {
  id: string;
  zone: AvatarTouchZone;
  rawAreas: string[];
  timestamp: number;
}

export interface AvatarTouchReply {
  text: string;
  performance: AvatarPerformanceDirection;
}

export interface AvatarTouchModelAction {
  id: string;
  name: string;
}

const ZONE_LABELS: Record<AvatarTouchZone, string> = {
  head: '头顶或头发',
  face: '脸颊或脸部',
  hand: '手或手臂',
  body: '肩膀或身体',
  other: '角色身边',
};

export const avatarTouchZoneLabel = (zone: AvatarTouchZone): string => ZONE_LABELS[zone];

const TOAST_ZONE_LABELS: Record<AvatarTouchZone, string> = {
  head: '头发',
  face: '脸颊',
  hand: '手',
  body: '肩膀',
  other: '身边',
};

export const avatarTouchZoneToastLabel = (zone: AvatarTouchZone): string => TOAST_ZONE_LABELS[zone];

export const normalizeCompanionDialogue = (raw: string, characterName = ''): string => {
  const escapedName = characterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return stripCallTextFormatting(raw)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(new RegExp(`^(?:${escapedName ? `${escapedName}|` : ''}角色|assistant)\\s*[：:]\\s*`, 'i'), '')
    .replace(/[”」』]\s*[“「『]/g, '\n')
    .replace(/\.{3,}/g, '……')
    .replace(/…{3,}/g, '……')
    .split('\n')
    .map(line => line.trim().replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

export const createAvatarTouchRecord = (
  hit: Pick<AvatarTouchHit, 'zone' | 'rawAreas'>,
  timestamp = Date.now(),
): AvatarTouchRecord => ({
  id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
  zone: hit.zone,
  rawAreas: hit.rawAreas.slice(0, 8),
  timestamp,
});

export const appendPendingAvatarTouch = (
  records: AvatarTouchRecord[],
  record: AvatarTouchRecord,
  maxRecords = 20,
): AvatarTouchRecord[] => [...records, record].slice(-Math.max(1, maxRecords));

export const consumePendingAvatarTouches = (
  records: AvatarTouchRecord[],
  consumed: AvatarTouchRecord[],
): AvatarTouchRecord[] => {
  if (!consumed.length) return records;
  const consumedIds = new Set(consumed.map(record => record.id));
  return records.filter(record => !consumedIds.has(record.id));
};

export const buildPendingAvatarTouchContext = (
  records: AvatarTouchRecord[],
  characterName: string,
  userName: string,
): string => {
  if (!records.length) return '';
  const counts = new Map<AvatarTouchZone, number>();
  records.forEach(record => counts.set(record.zone, (counts.get(record.zone) || 0) + 1));
  const details = AVATAR_TOUCH_ZONES
    .filter(zone => counts.has(zone))
    .map(zone => `${avatarTouchZoneToastLabel(zone)}${counts.get(zone)}次`)
    .join('、');
  const action = records.length === 1
    ? `${userName}在开口前戳了戳${characterName}的${avatarTouchZoneToastLabel(records[0].zone)}`
    : `${userName}在开口前连续戳了${characterName}${records.length}次（${details}）`;
  return `[本轮尚未回应的触碰互动]\n${action}。这些动作已经在本地发生过，但你还没有用语言回应。请在回答用户本轮话语时自然地顺带接住它们，不要逐条播报、不要解释系统，也不要把触碰当成一条单独的新消息。`;
};

export const isAvatarTouchGesture = (
  maxDistance: number,
  durationMs: number,
  wasSinglePointer: boolean,
): boolean => (
  wasSinglePointer
  && Number.isFinite(maxDistance)
  && maxDistance <= 10
  && durationMs >= 0
  && durationMs <= 650
);

export const normalizeAvatarTouchZone = (
  rawAreas: string[],
  fallbackY = 0.5,
  fallbackX = 0.5,
): AvatarTouchZone => {
  const value = rawAreas.join(' ').toLowerCase();
  if (/(face|cheek|mouth|eye|nose|脸|頬|顏)/i.test(value)) return 'face';
  if (/(head|hair|hat|ear|头|頭|髪|发|耳)/i.test(value)) return 'head';
  if (/(hand|arm|sleeve|手|腕|臂|袖)/i.test(value)) return 'hand';
  if (/(body|bust|chest|torso|shoulder|waist|hip|身体|身體|胸|肩|腰)/i.test(value)) return 'body';
  if (fallbackY < 0.3) return fallbackX > 0.28 && fallbackX < 0.72 ? 'face' : 'head';
  if (fallbackY < 0.68 && (fallbackX < 0.24 || fallbackX > 0.76)) return 'hand';
  if (fallbackY < 0.72) return 'body';
  return 'other';
};

export const buildImmediateTouchPerformance = (zone: AvatarTouchZone): AvatarPerformanceDirection => {
  if (zone === 'head') {
    return {
      emotion: 'happy',
      gesture: 'tilt',
      camera: 'medium',
      gaze: 'viewer',
      intensity: 0.62,
      faces: ['smile-eyes'],
    };
  }
  if (zone === 'face') {
    return {
      emotion: 'surprised',
      gesture: 'shy',
      camera: 'close',
      gaze: 'down',
      intensity: 0.76,
      faces: ['blush'],
    };
  }
  if (zone === 'hand') {
    return {
      emotion: 'happy',
      gesture: 'wave',
      camera: 'medium',
      gaze: 'viewer',
      intensity: 0.68,
    };
  }
  if (zone === 'body') {
    return {
      emotion: 'surprised',
      gesture: 'lean-back',
      camera: 'medium',
      gaze: 'viewer',
      intensity: 0.7,
      faces: ['brow-up'],
    };
  }
  return { ...DEFAULT_AVATAR_PERFORMANCE, gesture: 'tilt', intensity: 0.5 };
};

export const buildAvatarTouchSystemPrompt = (
  coreContext: string,
  characterName: string,
  userName: string,
  hit: Pick<AvatarTouchHit, 'zone' | 'rawAreas'>,
  modelActions: AvatarTouchModelAction[] = [],
): string => {
  const actionList = modelActions.length
    ? modelActions.slice(0, 60).map(action => `- ${action.id}: ${action.name}`).join('\n')
    : '（当前没有模型专属动作）';
  return `${coreContext}

### 当前面对面的触碰互动
${userName}刚刚轻轻触碰了${characterName}的「${avatarTouchZoneLabel(hit.zone)}」。
模型命中区原名：${hit.rawAreas.length ? hit.rawAreas.join('、') : '自动识别区域'}。

这是一次真实、低频的面对面互动。请直接以${characterName}本人回应：
- 必须结合完整人设、你们的关系、近期对话与记忆，不要写成通用触摸玩偶台词。
- 可以喜欢、害羞、意外、躲开、拒绝或生气；边界与亲密程度必须符合角色本人。
- 只说自然的一至三句短台词，不要解释系统、模型、命中区或提示词。
- 台词前先输出一条隐藏演出指令，格式：
  [[AVATAR: emotion=happy; gesture=tilt; gaze=viewer; intensity=0.7]]
- emotion 可用 neutral/happy/sad/angry/fearful/disgusted/surprised/calm/relaxed。
- gesture 可用 idle/talk/nod/shake/tilt/explain/wave/shy/lean-in/lean-back。
- 可按需附加 face=wink,blush 或 model_action=下列白名单ID；不合适就省略，禁止编造。

模型专属动作白名单：
${actionList}`;
};

const sanitizePerformanceActions = (
  performance: AvatarPerformanceDirection,
  allowedActionIds: Set<string>,
): AvatarPerformanceDirection => {
  const modelAction = performance.modelAction && allowedActionIds.has(performance.modelAction)
    ? performance.modelAction
    : undefined;
  const modelActions = performance.modelActions?.filter(id => allowedActionIds.has(id)).slice(0, 2);
  return {
    ...performance,
    ...(modelAction ? { modelAction } : {}),
    ...(modelActions?.length ? { modelActions } : {}),
    ...(!modelAction ? { modelAction: undefined } : {}),
  };
};

export const parseAvatarTouchReply = (
  message: unknown,
  allowedModelActions: AvatarTouchModelAction[] = [],
): AvatarTouchReply | null => {
  const parsed = parseCallAssistantMessage(message);
  const text = parsed.text.trim();
  if (!text) return null;
  const performance = parsed.performance || inferAvatarPerformanceFromText(text);
  return {
    text,
    performance: sanitizePerformanceActions(
      performance,
      new Set(allowedModelActions.map(action => action.id)),
    ),
  };
};

export const requestAvatarTouchReply = async (options: {
  character: CharacterProfile;
  user: UserProfile;
  apiConfig: APIConfig;
  hit: AvatarTouchHit;
  modelActions?: AvatarTouchModelAction[];
  recentMessageLimit?: number;
}): Promise<AvatarTouchReply> => {
  const {
    character,
    user,
    apiConfig,
    hit,
    modelActions = [],
    recentMessageLimit = 28,
  } = options;
  const baseUrl = apiConfig.baseUrl?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('请先在设置中配置主聊天 API');

  const [allMessages, emojis] = await Promise.all([
    DB.getMessagesByCharId(character.id, true),
    DB.getEmojis().catch(() => []),
  ]);
  const recentMessages = allMessages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .slice(-Math.max(8, Math.min(60, recentMessageLimit)));
  const eventText = `[面对面触碰互动] ${user.name || '用户'}轻轻触碰了你的${avatarTouchZoneLabel(hit.zone)}。`;

  await injectMemoryPalace(
    character,
    allMessages,
    eventText,
    user.name,
  );
  const lastInteractionTs = recentMessages[recentMessages.length - 1]?.timestamp;
  const coreContext = ContextBuilder.buildCoreContext(
    character,
    user,
    true,
    undefined,
    undefined,
    {
      lastInteractionTs,
      worldbookMessages: [
        ...recentMessages.map(message => ({ role: message.role, content: message.content })),
        { role: 'user', content: eventText },
      ],
    },
  );
  const { apiMessages } = ChatPrompts.buildMessageHistory(
    recentMessages,
    recentMessages.length,
    character,
    user,
    emojis,
  );
  const systemPrompt = buildAvatarTouchSystemPrompt(
    coreContext,
    character.name,
    user.name || '用户',
    hit,
    modelActions,
  );
  const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiConfig.apiKey || 'sk-none'}`,
    },
    body: JSON.stringify({
      model: apiConfig.model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...apiMessages,
        { role: 'user', content: eventText },
      ],
      temperature: 0.9,
      max_tokens: 1200,
      stream: false,
    }),
  }, 1, 45_000, {
    appName: '触感陪伴',
    charId: character.id,
    charName: character.name,
    purpose: '角色触碰回应',
  });
  const reply = parseAvatarTouchReply(data?.choices?.[0]?.message, modelActions)
    || parseAvatarTouchReply({ content: extractContent(data) }, modelActions);
  if (!reply) throw new Error('主模型没有返回可显示的触碰回应');
  return reply;
};

export const buildAvatarTouchReactionPackPrompt = (
  coreContext: string,
  characterName: string,
  userName: string,
  zones: AvatarTouchZone[],
  modelActions: AvatarTouchModelAction[] = [],
  reactionsPerZone = 4,
): string => {
  const actionList = modelActions.length
    ? modelActions.slice(0, 60).map(action => `- ${action.id}: ${action.name}`).join('\n')
    : '（当前没有模型专属动作）';
  const zoneList = zones.map(zone => `- ${zone}: ${avatarTouchZoneLabel(zone)}`).join('\n');
  const schema = Object.fromEntries(zones.map(zone => [
    zone,
    Array.from({ length: reactionsPerZone }, (_, index) => (
      `[[AVATAR: emotion=happy; gesture=tilt; gaze=viewer; intensity=0.7]] 第${index + 1}句台词`
    )),
  ]));
  return `${coreContext}

### 触感陪伴桌面 · 一次性反馈包
${userName}正在为${characterName}设置可触摸部位。请一次生成完整反馈包；保存后，桌面只会在本地轮播这些结果，不会每次触摸都再次请求你。

需要生成的部位：
${zoneList}

要求：
- 每个部位恰好生成 ${reactionsPerZone} 条彼此有区别、可独立成立的一至三句短台词。
- 必须结合完整人设、你们的关系、近期对话与记忆；允许喜欢、害羞、意外、躲开、拒绝或生气，边界必须符合角色本人。
- 台词只能包含角色真正说出口的话。不要写动作旁白、引号、角色名前缀、Markdown、命中区、系统解释或半截续句。
- 每条台词开头放一条演出指令：[[AVATAR: emotion=...; gesture=...; gaze=...; intensity=...]]。
- 可按需附加 face=wink,blush 或 model_action=白名单ID；禁止编造模型动作。
- 只输出一个合法 JSON 对象，不要代码围栏，不要 JSON 以外的文字。键必须是英文部位 ID，值必须是字符串数组。

模型专属动作白名单：
${actionList}

严格按照这个结构输出：
${JSON.stringify(schema, null, 2)}`;
};

const readReactionPackJson = (raw: unknown): Record<string, unknown> | null => {
  const content = typeof raw === 'string'
    ? raw
    : extractContent(raw as any) || (typeof (raw as any)?.content === 'string' ? (raw as any).content : '');
  const cleaned = content.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const root = (parsed as any).reactions;
    return root && typeof root === 'object' && !Array.isArray(root) ? root : parsed;
  } catch {
    return null;
  }
};

export const parseAvatarTouchReactionPack = (
  raw: unknown,
  zones: AvatarTouchZone[],
  allowedModelActions: AvatarTouchModelAction[] = [],
): AvatarTouchReactionPack | null => {
  const source = readReactionPackJson(raw);
  if (!source) return null;
  const pack: AvatarTouchReactionPack = {};
  zones.forEach(zone => {
    const rawZone = source[zone];
    const items = Array.isArray(rawZone)
      ? rawZone
      : rawZone && typeof rawZone === 'object' && Array.isArray((rawZone as any).items)
        ? (rawZone as any).items
        : [];
    const reactions = items.flatMap((item, index): CompanionTouchReaction[] => {
      const content = typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? `${(item as any).avatar || (item as any).performance || ''}\n${(item as any).text || (item as any).line || ''}`
          : '';
      const reply = parseAvatarTouchReply({ content }, allowedModelActions);
      if (!reply) return [];
      const text = normalizeCompanionDialogue(reply.text);
      if (!text) return [];
      return [{
        id: `${zone}-${index + 1}`,
        text,
        performance: reply.performance,
      }];
    }).slice(0, 6);
    if (reactions.length) pack[zone] = reactions;
  });
  return zones.every(zone => pack[zone]?.length) ? pack : null;
};

export const requestAvatarTouchReactionPack = async (options: {
  character: CharacterProfile;
  user: UserProfile;
  apiConfig: APIConfig;
  zones: AvatarTouchZone[];
  modelActions?: AvatarTouchModelAction[];
  recentMessageLimit?: number;
  reactionsPerZone?: number;
}): Promise<AvatarTouchReactionPack> => {
  const {
    character,
    user,
    apiConfig,
    zones,
    modelActions = [],
    recentMessageLimit = 28,
    reactionsPerZone = 4,
  } = options;
  const selectedZones = [...new Set(zones)].filter(zone => AVATAR_TOUCH_ZONES.includes(zone));
  if (!selectedZones.length) throw new Error('请至少选择一个可触摸部位');
  const baseUrl = apiConfig.baseUrl?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('请先在设置中配置主聊天 API');

  const [allMessages, emojis] = await Promise.all([
    DB.getMessagesByCharId(character.id, true),
    DB.getEmojis().catch(() => []),
  ]);
  const recentMessages = allMessages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .slice(-Math.max(8, Math.min(60, recentMessageLimit)));
  const eventText = `[桌面触摸设置] ${user.name || '用户'}选择了一次性生成${selectedZones.map(avatarTouchZoneLabel).join('、')}的反馈包。`;
  const lastInteractionTs = recentMessages[recentMessages.length - 1]?.timestamp;
  const coreContext = ContextBuilder.buildCoreContext(
    character,
    user,
    true,
    undefined,
    undefined,
    {
      lastInteractionTs,
      worldbookMessages: [
        ...recentMessages.map(message => ({ role: message.role, content: message.content })),
        { role: 'user', content: eventText },
      ],
    },
  );
  const { apiMessages } = ChatPrompts.buildMessageHistory(
    recentMessages,
    recentMessages.length,
    character,
    user,
    emojis,
  );
  const systemPrompt = buildAvatarTouchReactionPackPrompt(
    coreContext,
    character.name,
    user.name || '用户',
    selectedZones,
    modelActions,
    Math.max(3, Math.min(6, reactionsPerZone)),
  );
  const data = await safeFetchJson(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiConfig.apiKey || 'sk-none'}`,
    },
    body: JSON.stringify({
      model: apiConfig.model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...apiMessages,
        { role: 'user', content: eventText },
      ],
      temperature: 0.92,
      max_tokens: 3200,
      stream: false,
    }),
  }, 1, 60_000, {
    appName: '触感陪伴',
    charId: character.id,
    charName: character.name,
    purpose: '一次生成桌面触摸反馈包',
  });
  const pack = parseAvatarTouchReactionPack(data, selectedZones, modelActions);
  if (!pack) throw new Error('主模型返回的反馈包格式不完整，请再生成一次');
  return pack;
};

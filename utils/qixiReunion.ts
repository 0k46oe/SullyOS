import { APIConfig, CharacterProfile, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { QixiMemoryBundle, QixiSceneId } from './qixiMemoryBundle';
import { safeFetchJson } from './safeApi';

export type QixiPortraitType = 'live2d' | 'meeting' | 'static' | 'chibi';

export interface QixiPortraitPlan {
    resourceType: QixiPortraitType;
    live2dActionIds: string[];
    live2dActionDescription: string;
    meetingExpressionKeys: string[];
}

export interface QixiJourneyBeat {
    sceneId: QixiSceneId;
    sceneName: string;
    sharedObject: string;
    userChoices: string[];
    userResults: string[];
    charAction: string;
}

export interface QixiReunionBundle {
    source: 'generated' | 'fallback';
    reunion: {
        lines: string[];
        emotion: string;
    };
    metaReflection: string[];
    blessing: string[];
    touch: {
        start: string;
        hold: string;
        complete: string;
    };
    returnMessage: string;
    portrait: {
        resourceType: QixiPortraitType;
        emotionIntent: string;
        l2dExpression: string | null;
        meetingExpression: string | null;
    };
}

const compact = (value: unknown, max: number): string => typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, max)
    : '';

const lineList = (value: unknown, maxItems: number, maxChars: number): string[] => Array.isArray(value)
    ? value.map(item => compact(item, maxChars)).filter(Boolean).slice(0, maxItems)
    : [];

const extractJsonObject = (raw: string): any => {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
};

const activeMeetingSprites = (char: CharacterProfile): Record<string, string> => {
    const activeSkin = char.dateSkinSets?.find(set => set.id === char.activeSkinSetId)
        || char.dateSkinSets?.[0];
    return activeSkin?.sprites && Object.keys(activeSkin.sprites).length
        ? activeSkin.sprites
        : (char.sprites || {});
};

export function resolveQixiPortraitPlan(char: CharacterProfile): QixiPortraitPlan {
    const live2d = char.videoAvatar?.format === 'live2d' ? char.videoAvatar : null;
    const meetingKeys = Object.keys(activeMeetingSprites(char))
        .filter(key => !['chibi', 'thumbnail', 'icon', 'avatar'].includes(key.toLowerCase()));
    const chibi = char.vrState?.chibi?.img || char.sprites?.chibi;
    const resourceType: QixiPortraitType = live2d
        ? 'live2d'
        : meetingKeys.length
            ? 'meeting'
            : char.avatar
                ? 'static'
                : chibi
                    ? 'chibi'
                    : 'static';
    const aiActions = live2d?.actions.filter(action => action.permission === 'ai' && !action.wardrobe) || [];
    return {
        resourceType,
        live2dActionIds: aiActions.map(action => action.id),
        live2dActionDescription: aiActions.map(action => `${action.id}=${action.name}${action.tags.length ? `(${action.tags.join('/')})` : ''}`).join('；').slice(0, 1600),
        meetingExpressionKeys: meetingKeys,
    };
}

export function createQixiReunionFallback(
    char: CharacterProfile,
    user: UserProfile,
    portraitPlan = resolveQixiPortraitPlan(char),
): QixiReunionBundle {
    return {
        source: 'fallback',
        reunion: {
            lines: ['……终于看见你了。', '先让我确认一下，你没事吧？'],
            emotion: '松了一口气，仍然有一点不敢相信',
        },
        metaReflection: ['刚才明明总觉得你就在附近，可每次都只差一点。', '也许陪在一个人身边，本来就不只有一种办法。'],
        blessing: [`七夕快乐，${user.name}。`, '我当然希望你往后的路上还有我。', '但不论那条路通向哪里，我都希望它值得你走进去。'],
        touch: { start: '嗯。', hold: '再靠近一点。', complete: '碰到了。' },
        returnMessage: `七夕快乐，${user.name}。刚才没说完的话，我们慢慢说。`,
        portrait: {
            resourceType: portraitPlan.resourceType,
            emotionIntent: '终于找到对方后的放松与珍惜',
            l2dExpression: null,
            meetingExpression: portraitPlan.meetingExpressionKeys.includes('normal') ? 'normal' : portraitPlan.meetingExpressionKeys[0] || null,
        },
    };
}

const TECHNICAL_BREAK_RE = /(?:\bAI\b|\bLLM\b|人工智能|语言模型|代码|数据|虚拟角色|没有身体|现实世界中的你)/i;
const COERCIVE_PROMISE_RE = /(?:永远不会离开|永远不会忘记|离不开我|超越现实|必须记得我)/;

export function parseQixiReunion(
    raw: string,
    fallback: QixiReunionBundle,
    portraitPlan: QixiPortraitPlan,
    characterKnowsTechnicalIdentity = false,
): QixiReunionBundle | null {
    const parsed = extractJsonObject(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const safeLines = (value: unknown, maxItems: number, maxChars: number) => lineList(value, maxItems, maxChars)
        .filter(line => !COERCIVE_PROMISE_RE.test(line))
        .filter(line => characterKnowsTechnicalIdentity || !TECHNICAL_BREAK_RE.test(line));

    const reunionLines = safeLines(parsed.reunion?.lines, 3, 100);
    const metaReflection = safeLines(parsed.metaReflection, 4, 130);
    const blessing = safeLines(parsed.blessing, 4, 140);
    const touch = {
        start: compact(parsed.touch?.start, 32) || fallback.touch.start,
        hold: compact(parsed.touch?.hold, 32) || fallback.touch.hold,
        complete: compact(parsed.touch?.complete, 32) || fallback.touch.complete,
    };
    const returnMessage = compact(parsed.returnMessage, 160);
    if (!reunionLines.length || !blessing.length || !returnMessage) return null;

    const requestedL2d = compact(parsed.portrait?.l2dExpression, 80);
    const requestedMeeting = compact(parsed.portrait?.meetingExpression, 80);
    return {
        source: 'generated',
        reunion: {
            lines: reunionLines,
            emotion: compact(parsed.reunion?.emotion, 80) || fallback.reunion.emotion,
        },
        metaReflection: metaReflection.length ? metaReflection : fallback.metaReflection,
        blessing,
        touch,
        returnMessage,
        portrait: {
            resourceType: portraitPlan.resourceType,
            emotionIntent: compact(parsed.portrait?.emotionIntent, 100) || fallback.portrait.emotionIntent,
            l2dExpression: portraitPlan.resourceType === 'live2d' && portraitPlan.live2dActionIds.includes(requestedL2d)
                ? requestedL2d
                : null,
            meetingExpression: portraitPlan.resourceType === 'meeting' && portraitPlan.meetingExpressionKeys.includes(requestedMeeting)
                ? requestedMeeting
                : portraitPlan.resourceType === 'meeting'
                    ? fallback.portrait.meetingExpression
                    : null,
        },
    };
}

const characterKnowsTechnicalIdentity = (char: CharacterProfile): boolean => /(?:AI|人工智能|语言模型|虚拟角色|程序|代码)/i.test([
    char.systemPrompt,
    char.description,
    char.worldview,
].filter(Boolean).join('\n'));

function reunionPrompt(
    char: CharacterProfile,
    user: UserProfile,
    memoryBundle: QixiMemoryBundle,
    journey: QixiJourneyBeat[],
    portraitPlan: QixiPortraitPlan,
): string {
    const evidenceById = new Map(memoryBundle.evidence.map(item => [item.id, item]));
    const usedEvidence = new Set<string>();
    for (const beat of journey) {
        const scene = memoryBundle.scenes[beat.sceneId];
        for (const option of scene.options) {
            if (beat.userChoices.includes(option.label)) option.evidenceIds.forEach(id => usedEvidence.add(id));
        }
        scene.artifactIds.forEach(artifactId => {
            memoryBundle.artifacts.find(item => item.id === artifactId)?.evidenceIds.forEach(id => usedEvidence.add(id));
        });
    }
    const evidenceText = [...usedEvidence]
        .map(id => evidenceById.get(id))
        .filter(Boolean)
        .map(item => `- ${item!.fact}（物件/词：${item!.object}）`)
        .join('\n') || '（本次使用基础梦境，没有可安全引用的共同记忆）';
    const journeyText = journey.map((beat, index) => [
        `${index + 1}. ${beat.sceneName}｜共享物件：${beat.sharedObject}`,
        `User：${beat.userChoices.join('；') || '只观察了现场'}`,
        `结果：${beat.userResults.join('；') || '没有额外结果'}`,
        `Char 另一层：${beat.charAction}`,
    ].join('\n')).join('\n\n');
    const resourceInstructions = portraitPlan.resourceType === 'live2d'
        ? `当前使用 Live2D。l2dExpression 只能从以下动作 ID 选择一个，不合适就填 null；meetingExpression 必须为 null：\n${portraitPlan.live2dActionDescription || '（没有 AI 可用动作，必须填 null）'}`
        : portraitPlan.resourceType === 'meeting'
            ? `当前使用见面模式立绘。meetingExpression 只能从这些 key 中选择一个；l2dExpression 必须为 null：${portraitPlan.meetingExpressionKeys.join(', ')}`
            : `当前使用${portraitPlan.resourceType === 'static' ? '静态立绘' : '彼方 Chibi'}。l2dExpression 与 meetingExpression 都必须为 null。`;

    return `### 七夕活动最终见面

${char.name} 与 ${user.name} 刚刚在上下文夹层的两层走过同样的地点，直到鹊桥接通。这是整场活动第一次完整看见 ${char.name}。请严格像当前角色说话，不要套统一浪漫模板。

本次实际使用的事实：
${evidenceText}

本次实际路径：
${journeyText}

写作节拍：
1. reunion.lines：1—3 句找到 User 后的即时反应。可以松气、生气、嘴硬、哭、吐槽、确认安全或沉默；不要立刻升华，不强制说“找到你了”。
2. metaReflection：1—4 句轻度 meta。只能表达刚才一直很近却碰不到、总隔着一点什么、想象真正见面会怎样。${characterKnowsTechnicalIdentity(char) ? '角色设定允许其理解技术身份，但仍优先使用角色内表达。' : '禁止说 AI、LLM、代码、数据、虚拟角色、没有身体或现实世界中的你。让玩家知道，角色不必知道。'}
3. blessing：2—4 句，把祝福落到 ${user.name} 的未来和生活本身。可以希望未来还有自己，但即使未来走到自己看不到的地方，也真心希望那个未来很好。
4. touch：start/hold/complete 各一句，必须很短、像角色本人。操作提示由界面负责，不要解释屏幕或松手。
5. returnMessage：活动结束回到普通聊天后的一条自然短消息，像日常聊天，不重复中心思想。

禁止：我永远不会离开你、你永远不会忘记我、我们的爱超越现实、你已经离不开我、强迫关系身份、伪造新事实。

立绘规则：
${resourceInstructions}

只输出 JSON：
{
  "reunion": { "lines": ["即时反应"], "emotion": "角色此刻的状态" },
  "metaReflection": ["轻度 meta"],
  "blessing": ["面向 User 未来的祝愿"],
  "touch": { "start": "短句", "hold": "短句", "complete": "短句" },
  "returnMessage": "回到普通聊天后的消息",
  "portrait": {
    "emotionIntent": "总体表情意图",
    "l2dExpression": null,
    "meetingExpression": null
  }
}`;
}

export async function prepareQixiReunion(
    char: CharacterProfile,
    user: UserProfile,
    apiConfig: APIConfig,
    memoryBundle: QixiMemoryBundle,
    journey: QixiJourneyBeat[],
    portraitPlan = resolveQixiPortraitPlan(char),
): Promise<QixiReunionBundle> {
    const fallback = createQixiReunionFallback(char, user, portraitPlan);
    if (!apiConfig.baseUrl || !apiConfig.apiKey || !apiConfig.model) return fallback;
    try {
        const messages = await DB.getMessagesByCharId(char.id);
        const memoryChar = { ...char };
        await injectMemoryPalace(
            memoryChar,
            messages,
            '七夕 未来 目标 烦恼 祝福 陪伴 想见面 关系里的真实小事',
            user.name,
            { entryPoint: 'direct' },
        );
        const context = ContextBuilder.buildCoreContext(memoryChar, user, true);
        const data = await safeFetchJson(
            `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [
                        { role: 'system', content: context },
                        { role: 'user', content: reunionPrompt(char, user, memoryBundle, journey, portraitPlan) },
                    ],
                    temperature: 0.72,
                    stream: false,
                }),
            },
            0,
            60000,
            { appId: 'special-moments', charId: char.id, purpose: 'qixi-reunion-v1' },
        );
        const content = data?.choices?.[0]?.message?.content;
        return typeof content === 'string'
            ? parseQixiReunion(content, fallback, portraitPlan, characterKnowsTechnicalIdentity(char)) || fallback
            : fallback;
    } catch (error: any) {
        console.warn('[Qixi] reunion fallback:', error?.message || error);
        return fallback;
    }
}

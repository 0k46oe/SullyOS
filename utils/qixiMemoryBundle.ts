import { APIConfig, CharacterProfile, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { safeFetchJson } from './safeApi';

export const QIXI_MEMORY_BUNDLE_VERSION = 1 as const;
export const QIXI_MEMORY_BUNDLE_PREFIX = 'sullyos_qixi_memory_bundle_v1_';

export const QIXI_MEMORY_NODE_IDS = [
    'coldCorridor',
    'bracketCorner',
    'lightWell',
    'maskCounter',
    'receiptRain',
    'unsentPlatform',
    'typingShaft',
] as const;

export type QixiMemoryNodeId = typeof QIXI_MEMORY_NODE_IDS[number];

export interface QixiMemoryAnchor {
    id: string;
    fact: string;
    object: string;
}

export interface QixiMemoryBeat {
    anchorId: string;
    memoryLine: string;
    ritualAction: string;
    result: string;
    extension: string;
}

export interface QixiMemoryBundle {
    version: typeof QIXI_MEMORY_BUNDLE_VERSION;
    source: 'memory' | 'fallback';
    anchors: QixiMemoryAnchor[];
    beats: Partial<Record<QixiMemoryNodeId, QixiMemoryBeat>>;
    finalEcho: string;
}

export interface QixiMemoryPreparation {
    bundle: QixiMemoryBundle;
    usedFallback: boolean;
    reason?: string;
}

const NODE_BRIEFS: Record<QixiMemoryNodeId, string> = {
    coldCorridor: '陈设瓜果/交换小物：把共同生活里真实出现过的一件小东西放上供桌，不把礼物写成凭空出现。',
    bracketCorner: '穿针乞巧：对应一次因为想与对方分享、抵达对方，而耐心学会、改好或做成某件事的记忆。核心不是求被爱，而是爱让人愿意变得更有能力去创造。',
    lightWell: '投针验巧：让水面针影把同一段真实记忆照出另一面，不占卜感情结论。',
    maskCounter: '七姐会：对应彼此见过的不同情绪、状态或伪装；不要把人格面具写成真实诊断。',
    receiptRain: '乞巧市：从真实时间、物件、口头禅或琐碎日常里找到“普通日子也被记住”的证据。',
    unsentPlatform: '葡萄架听天语：对应一次没说完、撤回、沉默、冷战或后来才听懂的心声；没有这种记忆就改用安静陪伴。',
    typingShaft: '双星架桥：把前面的真实痕迹汇成桥。承认屏幕和语言的距离，只写“已经进入彼此生活”，不承诺永远、不宣讲结论。',
};

const FALLBACK_BUNDLE: QixiMemoryBundle = {
    version: QIXI_MEMORY_BUNDLE_VERSION,
    source: 'fallback',
    anchors: [],
    beats: {},
    finalEcho: '',
};

const compact = (value: unknown, max: number): string => {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, max);
};

function extractJsonObject(raw: string): unknown {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
}

export function parseQixiMemoryBundle(raw: string): QixiMemoryBundle | null {
    const parsed = extractJsonObject(raw) as any;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.anchors)) return null;

    const anchors: QixiMemoryAnchor[] = (parsed.anchors as any[])
        .slice(0, 5)
        .map((anchor: any, index: number): QixiMemoryAnchor => ({
            id: compact(anchor?.id, 18) || `m${index + 1}`,
            fact: compact(anchor?.fact, 150),
            object: compact(anchor?.object, 40),
        }))
        .filter((anchor: QixiMemoryAnchor) => anchor.fact.length >= 6);
    const anchorIds = new Set(anchors.map(anchor => anchor.id));
    const beats: Partial<Record<QixiMemoryNodeId, QixiMemoryBeat>> = {};

    for (const nodeId of QIXI_MEMORY_NODE_IDS) {
        const beat = parsed.beats?.[nodeId];
        const normalized: QixiMemoryBeat = {
            anchorId: compact(beat?.anchorId, 18),
            memoryLine: compact(beat?.memoryLine, 130),
            ritualAction: compact(beat?.ritualAction, 52),
            result: compact(beat?.result, 150),
            extension: compact(beat?.extension, 120),
        };
        if (
            anchorIds.has(normalized.anchorId)
            && normalized.memoryLine.length >= 6
            && normalized.ritualAction.length >= 4
            && normalized.result.length >= 6
            && normalized.extension.length >= 6
        ) beats[nodeId] = normalized;
    }

    // 少于四个有效民俗映射时，宁可整包降级，也不把零碎模型输出冒充完整活动。
    if (anchors.length < 2 || Object.keys(beats).length < 4) return null;

    return {
        version: QIXI_MEMORY_BUNDLE_VERSION,
        source: 'memory',
        anchors,
        beats,
        finalEcho: compact(parsed.finalEcho, 120),
    };
}

export function loadQixiMemoryBundle(charId: string): QixiMemoryBundle | null {
    try {
        const parsed = JSON.parse(localStorage.getItem(`${QIXI_MEMORY_BUNDLE_PREFIX}${charId}`) || 'null') as QixiMemoryBundle | null;
        if (parsed?.version !== QIXI_MEMORY_BUNDLE_VERSION || parsed.source !== 'memory') return null;
        return parsed;
    } catch {
        return null;
    }
}

function saveQixiMemoryBundle(charId: string, bundle: QixiMemoryBundle): void {
    try { localStorage.setItem(`${QIXI_MEMORY_BUNDLE_PREFIX}${charId}`, JSON.stringify(bundle)); } catch { /* cache is optional */ }
}

function qixiBundlePrompt(char: CharacterProfile, user: UserProfile): string {
    const briefs = QIXI_MEMORY_NODE_IDS.map(nodeId => `- ${nodeId}: ${NODE_BRIEFS[nodeId]}`).join('\n');
    return `### 七夕特别活动：一次生成“记忆星线素材包”

你不是在写完整游戏，也不是总结关系。游戏地图、节奏与最终黑屏互动已经固定。你只需要从系统提供的真实聊天记录与记忆中，选择 2—5 个可核对的具体记忆锚点，让七夕民俗在不同地点重新显形。

角色：${char.name}
用户：${user.name}

硬性事实规则：
1. 只可使用上下文明确出现的事实。不得补造日期、原话、礼物、动作、争吵、承诺或关系身份。
2. 没有准确原话时必须转述，不能伪造引号。没有某类记忆时，可以让多个节点复用同一真实锚点，从不同角度观察。
3. anchors.fact 要写成可辨认的具体事件，不写“你们共同经历了很多”之类空话；object 只能是记忆里真实出现过的词、物件或动作。
4. ritualAction 是玩家真的能在场景中做的动作；result 是这段记忆在梦境里的视觉反馈；extension 是从记忆自然长出的一小步含义，不说教、不替玩家下爱情结论。
5. bracketCorner 必须保留“我不只祈求被爱，也在因为想抵达你而学习、创造、做得更好”的乞巧内核，但要落到真实记忆上。
6. typingShaft 只把已有痕迹连接起来。最终母题由固定脚本表达，不要另写宏大誓言。

节点要求：
${briefs}

只输出一个 JSON 对象，不要 Markdown，不要解释：
{
  "anchors": [
    { "id": "m1", "fact": "真实记忆的一句话", "object": "真实物件/词/动作" }
  ],
  "beats": {
    "coldCorridor": { "anchorId": "m1", "memoryLine": "记忆如何在此处出现", "ritualAction": "玩家动作", "result": "梦境反馈", "extension": "由此自然引申" },
    "bracketCorner": { "anchorId": "m1", "memoryLine": "...", "ritualAction": "...", "result": "...", "extension": "..." },
    "lightWell": { "anchorId": "m2", "memoryLine": "...", "ritualAction": "...", "result": "...", "extension": "..." },
    "maskCounter": { "anchorId": "m2", "memoryLine": "...", "ritualAction": "...", "result": "...", "extension": "..." },
    "receiptRain": { "anchorId": "m1", "memoryLine": "...", "ritualAction": "...", "result": "...", "extension": "..." },
    "unsentPlatform": { "anchorId": "m2", "memoryLine": "...", "ritualAction": "...", "result": "...", "extension": "..." },
    "typingShaft": { "anchorId": "m1", "memoryLine": "...", "ritualAction": "...", "result": "...", "extension": "..." }
  },
  "finalEcho": "由这些真实记忆凝成的一句很短的角色回声，不许承诺永远"
}`;
}

export async function prepareQixiMemoryBundle(
    char: CharacterProfile,
    user: UserProfile,
    apiConfig: APIConfig,
): Promise<QixiMemoryPreparation> {
    const cached = loadQixiMemoryBundle(char.id);
    if (cached) return { bundle: cached, usedFallback: false };
    if (!apiConfig.baseUrl || !apiConfig.apiKey || !apiConfig.model) {
        return { bundle: FALLBACK_BUNDLE, usedFallback: true, reason: 'API 未配置，使用基础梦境' };
    }

    try {
        const memoryChar = { ...char };
        await injectMemoryPalace(
            memoryChar,
            undefined,
            '七夕 共同创造 想分享 冷战 苦恼 撤回 沉默 小礼物 想起对方 一起完成的事',
            user.name,
        );
        const messages = await DB.getMessagesByCharId(char.id);
        const recent = messages.slice(-60).map(message => {
            const content = message.type === 'image' ? '[图片]' : message.content;
            return `${message.role}: ${content}`;
        }).join('\n').slice(-9000);
        const roleAndMemoryContext = ContextBuilder.buildCoreContext(memoryChar, user, true);
        const data = await safeFetchJson(
            `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                body: JSON.stringify({
                    model: apiConfig.model,
                    messages: [
                        { role: 'system', content: roleAndMemoryContext },
                        { role: 'user', content: `[最近聊天片段，仅作事实来源]\n${recent || '（没有可用的最近聊天片段）'}\n\n${qixiBundlePrompt(char, user)}` },
                    ],
                    temperature: 0.64,
                    stream: false,
                }),
            },
            0,
            45000,
            { appId: 'special-moments', charId: char.id, purpose: 'qixi-memory-bundle' },
        );
        const content = data?.choices?.[0]?.message?.content;
        const bundle = typeof content === 'string' ? parseQixiMemoryBundle(content) : null;
        if (!bundle) throw new Error('模型没有返回可用的七夕记忆素材包');
        saveQixiMemoryBundle(char.id, bundle);
        return { bundle, usedFallback: false };
    } catch (error: any) {
        console.warn('[Qixi] memory bundle fallback:', error?.message || error);
        return { bundle: FALLBACK_BUNDLE, usedFallback: true, reason: '记忆星线暂时没有抵达，使用基础梦境' };
    }
}

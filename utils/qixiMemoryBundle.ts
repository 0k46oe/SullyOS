import { APIConfig, CharacterProfile, Message, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { safeFetchJson } from './safeApi';
import { parseQixiJsonObject } from './qixiJson';

export const QIXI_MEMORY_BUNDLE_VERSION = 6 as const;
export const QIXI_MEMORY_BUNDLE_PREFIX = 'sullyos_qixi_memory_bundle_v6_';

export const QIXI_SCENE_IDS = [
    'lostLayer',
    'doubleWish',
    'threadNeedle',
    'offerings',
    'reflection',
    'nightMarket',
    'wordCloud',
] as const;

export type QixiSceneId = typeof QIXI_SCENE_IDS[number];

export interface QixiMemoryEvidence {
    id: string;
    fact: string;
    object: string;
    tags: string[];
}

export type QixiArtifactKind = 'object' | 'phrase' | 'nickname' | 'topic' | 'date' | 'emotion' | 'wish' | 'symbol';

export interface QixiMemoryArtifact {
    id: string;
    label: string;
    kind: QixiArtifactKind;
    evidenceIds: string[];
}

export interface QixiSceneOption {
    id: string;
    label: string;
    result: string;
    evidenceIds: string[];
}

export interface QixiScenePayload {
    /** Part 1 generated interstitial copy shown before entering this room. */
    transitionLines?: string[];
    sharedObject: string;
    memoryLine: string;
    options: QixiSceneOption[];
    charAction: string;
    /** The exact short words/mark that visibly appears on the shared object. */
    charVisibleText?: string;
    /** Lost-layer only: Char's hurried, in-character mutter before erasing the error. */
    charMutter?: string;
    reveal: string;
    artifactIds: string[];
    charSelectionIds: string[];
}

export const QIXI_FALLBACK_TRANSITIONS: Record<QixiSceneId, string[]> = {
    lostLayer: ['裂开的聊天界面在身后合拢。', '未送达的文字落在一条没有回声的路上。'],
    doubleWish: ['那颗未抵达的星沿地面滚远。', '尽头悬着一张被风反复翻动的纸。'],
    threadNeedle: ['纸背的墨迹被风抽成一根细线。', '线穿过夜色，停在一枚针孔前。'],
    offerings: ['穿过针孔的线没有断。', '它牵着你来到一张摆着空位的长桌前。'],
    reflection: ['桌边滚落的一点光沉进水里。', '水面把刚才出现过的两种颜色都留下。'],
    nightMarket: ['水纹推开岸边的夜色。', '灯牌和摊位从倒影里一盏盏亮起。'],
    wordCloud: ['夜市尽头垂下葡萄藤。', '买走与留下的词，都被挂进了叶影。'],
};

export const QIXI_FALLBACK_CHAR_VISIBLE_TEXT: Record<QixiSceneId, string> = {
    lostLayer: '先别信那些最坏的念头。',
    doubleWish: '希望你走向真正想去的地方。',
    threadNeedle: '抓稳，我来把线送过去。',
    offerings: '这个留给你。',
    reflection: '我在这里。',
    nightMarket: '刚刚被另一边买走。',
    wordCloud: '轮到我选你了。',
};

export const QIXI_FALLBACK_CHAR_MUTTER = '啧……这破报错。';

export const qixiTransitionLines = (sceneId: QixiSceneId, scene: QixiScenePayload): string[] =>
    scene.transitionLines?.length ? scene.transitionLines : QIXI_FALLBACK_TRANSITIONS[sceneId];

export const qixiCharVisibleText = (sceneId: QixiSceneId, scene: QixiScenePayload): string =>
    scene.charVisibleText?.trim() || QIXI_FALLBACK_CHAR_VISIBLE_TEXT[sceneId];

export const qixiCharMutter = (scene: QixiScenePayload): string =>
    scene.charMutter?.trim() || QIXI_FALLBACK_CHAR_MUTTER;

export interface QixiMemoryBundle {
    version: typeof QIXI_MEMORY_BUNDLE_VERSION;
    source: 'memory' | 'fallback';
    openingChat: string[];
    evidence: QixiMemoryEvidence[];
    artifacts: QixiMemoryArtifact[];
    scenes: Record<QixiSceneId, QixiScenePayload>;
    personalizedSceneIds: QixiSceneId[];
    generatedAt: number;
    contextSignature: string;
}

export interface QixiMemoryPreparation {
    bundle: QixiMemoryBundle;
    usedFallback: boolean;
    reason?: string;
}

const SCENE_BRIEFS: Record<QixiSceneId, string> = {
    lostLayer: '01 失联层：从真实的等待、失联、负面情绪或很想联系对方的时刻取材。User 尝试联系但协议失败；另一色文字逐句摘掉负片想法，安慰只能像 Char，不能揭示身份。',
    doubleWish: '02 双面祈愿处：User 在祈愿笺正面写一个真实、私人但不越界的愿望；Char 在另一层写背面。建立同一物体被两层共同使用的规则。',
    threadNeedle: '03 穿针乞巧处：User 拿针或线，Char 从另一层拿走另一个，共同完成穿针。织出的意象和它收集的物件必须来自真实上下文。',
    offerings: '04 供果与记忆陈列：User 放觉得 Char 会喜欢或在意的东西，Char 放觉得 User 会喜欢或需要的东西。用陈列本身表达了解，不让旁白总结。',
    reflection: '05 投针照影：水面只显示两层操作轨迹。User 写名字、短句、符号或记忆意象，Char 从另一层补写、修改或接续，第一次形成近实时互动。',
    nightMarket: '06 乞巧市：摊位售卖真实上下文里的饮料、称呼、口头禅、日期、截图概念、梗和小事。Char 买走与 User 有关的东西，User 买关于 Char 的碎片。',
    wordCloud: '07 葡萄架词云：提供 12—20 个有真实依据的称呼、话题、关键词、情绪词、物件或熟悉表达。User 选最像 Char 的词；Char 的另一色选择必须是最像 User 的词。',
};

const compact = (value: unknown, max: number): string => {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, max);
};

const compactList = (value: unknown, maxItems: number, maxChars: number): string[] => Array.isArray(value)
    ? [...new Set(value.map(item => compact(item, maxChars)).filter(Boolean))].slice(0, maxItems)
    : [];

const simpleHash = (value: string): string => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
};

const fallbackScenes = (): Record<QixiSceneId, QixiScenePayload> => ({
    lostLayer: {
        sharedObject: '一条无法送达的消息',
        memoryLine: '这一层拒绝替你假装收到回答。',
        options: [
            { id: 'message', label: '再发一条消息', result: '发送图标转了很久，最后变成一颗没有抵达的星。', evidenceIds: [] },
            { id: 'call', label: '试着拨一次电话', result: '铃声越过七层文字，又从原处返回。', evidenceIds: [] },
            { id: 'shout', label: '对着空白喊 ta', result: '回声没有回答，只把最刺耳的那句话轻轻划掉。', evidenceIds: [] },
        ],
        charAction: '另一种颜色的字从句尾出现，把“没有人会来”改成了“先在这里等一下”。',
        charMutter: QIXI_FALLBACK_CHAR_MUTTER,
        reveal: '你不知道是谁写的，只觉得改字的方式很像 ta。',
        artifactIds: [],
        charSelectionIds: [],
    },
    doubleWish: {
        sharedObject: '一张会被风翻面的祈愿笺',
        memoryLine: '正面朝向你，背面朝向另一个看不见的地方。',
        options: [
            { id: 'steady', label: '写：希望生活慢慢稳定下来', result: '墨迹沉进纸纤维，没有替你许诺结果。', evidenceIds: [] },
            { id: 'brave', label: '写：希望我更有勇气一点', result: '“勇气”两个字被风吹得很轻，却没有消失。', evidenceIds: [] },
            { id: 'rest', label: '写：希望今年能好好休息', result: '纸角松下来，像终于肯把肩膀放低一点。', evidenceIds: [] },
        ],
        charAction: '卡片忽然翻面。另一色字迹已经写好：希望你走向真正想去的地方。',
        reveal: '同一张纸的两面，同时留下了不同的体温。',
        artifactIds: [],
        charSelectionIds: [],
    },
    threadNeedle: {
        sharedObject: '悬在两层之间的针与线',
        memoryLine: '针和线总有一个会在你伸手前被另一边拿起。',
        options: [
            { id: 'needle', label: '拿起针，把线留给另一边', result: '针孔停在半空，另一端的线试了几次，终于穿过来。', evidenceIds: [] },
            { id: 'thread', label: '拿起线，把针留给另一边', result: '针孔在看不见的手里稳住。你把线送过去，刚好穿中。', evidenceIds: [] },
        ],
        charAction: '另一端把线轻轻收紧，织物里鼓起一只会替人收好小东西的无名生物。',
        reveal: '你第一次碰到了另一边正在发生的动作。',
        artifactIds: [],
        charSelectionIds: [],
    },
    offerings: {
        sharedObject: '一张两边都能移动供物的长桌',
        memoryLine: '桌面留着两套不同方向的摆放痕迹。',
        options: [
            { id: 'sweet', label: '放上一枚不太规整的巧果', result: '巧果刚落下，就被另一边挪到最显眼的位置。', evidenceIds: [] },
            { id: 'drink', label: '放上一杯仍然温热的饮料', result: '杯子向桌心滑了半寸，旁边多出一张看不见字的杯垫。', evidenceIds: [] },
            { id: 'note', label: '放上一张没有写满的纸条', result: '纸条被另一端压住，空白处慢慢出现新的折痕。', evidenceIds: [] },
        ],
        charAction: '另一层也放下一样东西，又把它推到更靠近你的位置。',
        reveal: '两套陈列没有完全猜对，却都在认真为对方留位置。',
        artifactIds: [],
        charSelectionIds: [],
    },
    reflection: {
        sharedObject: '一面只记录动作的水',
        memoryLine: '水不回答感情问题，只忠实留下谁碰过哪里。',
        options: [
            { id: 'name', label: '在水面写下 ta 的名字', result: '最后一笔刚停，另一色波纹便从对岸接住了它。', evidenceIds: [] },
            { id: 'symbol', label: '画一个只有你看得懂的符号', result: '另一边试着补了半笔，没有猜中，却没有把它擦掉。', evidenceIds: [] },
            { id: 'dots', label: '只点下三个光点', result: '第四个光点从另一层亮起，与你的三个排成一条路。', evidenceIds: [] },
        ],
        charAction: '另一色水纹撞过来，抢走最后一笔，又在旁边补上一个很小的记号。',
        reveal: '这一次不是旧痕迹。对方正在和你同时触碰水面。',
        artifactIds: [],
        charSelectionIds: [],
    },
    nightMarket: {
        sharedObject: '只卖琐碎记忆的夜市摊位',
        memoryLine: '这里不出售宏大纪念，只卖称呼、饮料、时间和小事。',
        options: [
            { id: 'drink', label: '买下一杯没有标名字的饮料', result: '杯壁浮出一小段被记住的日常，价格只是一次点头。', evidenceIds: [] },
            { id: 'phrase', label: '买下一句熟悉但想不起来源的话', result: '纸袋一晃，那句话用很熟悉的语气又说了一遍。', evidenceIds: [] },
            { id: 'small', label: '买下一件没人会写进纪念册的小事', result: '摊主把它包得很认真，说琐碎的东西最容易被人带走。', evidenceIds: [] },
        ],
        charAction: '你伸手时，另一件商品先显示“售罄”。标签背面写着：刚被另一层的客人买走。',
        reveal: '被买走的那件东西与 ta 无关，反而很像你。',
        artifactIds: [],
        charSelectionIds: [],
    },
    wordCloud: {
        sharedObject: '葡萄架下缓慢漂浮的词云',
        memoryLine: '词语来自不同日子，不替任何关系命名。',
        options: [],
        charAction: '你每点亮一个词，另一种颜色就随后点亮一个更像你的词。两边一来一回，最后各自留下三次选择。',
        reveal: '最后，两种颜色在一个没有被安排好的词上重叠。',
        artifactIds: [],
        charSelectionIds: [],
    },
});

export function createQixiFallbackBundle(contextSignature = ''): QixiMemoryBundle {
    return {
        version: QIXI_MEMORY_BUNDLE_VERSION,
        source: 'fallback',
        openingChat: ['你刚才是不是回我消息了？', '奇怪……我这里什么也没看到。'],
        evidence: [],
        artifacts: [],
        scenes: fallbackScenes(),
        personalizedSceneIds: [],
        generatedAt: Date.now(),
        contextSignature,
    };
}

export function parseQixiMemoryBundle(raw: string, contextSignature = ''): QixiMemoryBundle | null {
    const parsed = parseQixiJsonObject(raw, ['scenes', 'evidence']) as any;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.evidence)) return null;

    const seenEvidenceIds = new Set<string>();
    const evidence = (parsed.evidence as any[])
        .slice(0, 24)
        .map((item: any, index: number): QixiMemoryEvidence => ({
            id: compact(item?.id, 24) || `e${index + 1}`,
            fact: compact(item?.fact, 180),
            object: compact(item?.object, 48),
            tags: compactList(item?.tags, 6, 24),
        }))
        .filter((item: QixiMemoryEvidence) => {
            if (item.fact.length < 6 || seenEvidenceIds.has(item.id)) return false;
            seenEvidenceIds.add(item.id);
            return true;
        });
    if (evidence.length < 2) return null;

    const evidenceIds = new Set(evidence.map(item => item.id));
    const seenArtifactIds = new Set<string>();
    const artifacts: QixiMemoryArtifact[] = (Array.isArray(parsed.artifacts) ? parsed.artifacts : [])
        .slice(0, 40)
        .map((item: any, index: number): QixiMemoryArtifact => {
            const kind = compact(item?.kind, 16) as QixiArtifactKind;
            return {
                id: compact(item?.id, 24) || `a${index + 1}`,
                label: compact(item?.label, 42),
                kind: (['object', 'phrase', 'nickname', 'topic', 'date', 'emotion', 'wish', 'symbol'] as string[]).includes(kind) ? kind : 'object',
                evidenceIds: compactList(item?.evidenceIds, 4, 24).filter(id => evidenceIds.has(id)),
            };
        })
        .filter((item: QixiMemoryArtifact) => {
            if (!item.label || !item.evidenceIds.length || seenArtifactIds.has(item.id)) return false;
            seenArtifactIds.add(item.id);
            return true;
        });
    const artifactIds = new Set(artifacts.map(item => item.id));
    const scenes = fallbackScenes();
    const personalizedSceneIds: QixiSceneId[] = [];

    for (const sceneId of QIXI_SCENE_IDS) {
        const scene = parsed.scenes?.[sceneId];
        if (!scene || typeof scene !== 'object') return null;
        const transitionLines = compactList(scene.transitionLines, 2, 96);
        if (!transitionLines.length) return null;
        const charVisibleText = compact(scene.charVisibleText, 72);
        if (charVisibleText.length < 2) return null;
        const charMutter = sceneId === 'lostLayer' ? compact(scene.charMutter, 36) : '';
        if (sceneId === 'lostLayer' && charMutter.length < 2) return null;
        const options = (Array.isArray(scene.options) ? scene.options : [])
            .slice(0, sceneId === 'wordCloud' ? 0 : 5)
            .map((option: any, index: number): QixiSceneOption => ({
                id: compact(option?.id, 24) || `${sceneId}-${index + 1}`,
                label: compact(option?.label, 64),
                result: compact(option?.result, 190),
                evidenceIds: compactList(option?.evidenceIds, 4, 24).filter(id => evidenceIds.has(id)),
            }))
            .filter((option: QixiSceneOption) => option.label.length >= 2 && option.result.length >= 6);
        const normalized: QixiScenePayload = {
            transitionLines,
            sharedObject: compact(scene.sharedObject, 72),
            memoryLine: compact(scene.memoryLine, 190),
            options,
            charAction: compact(scene.charAction, 220),
            charVisibleText,
            ...(sceneId === 'lostLayer' ? { charMutter } : {}),
            reveal: compact(scene.reveal, 180),
            artifactIds: compactList(scene.artifactIds, sceneId === 'wordCloud' ? 20 : 10, 24).filter(id => artifactIds.has(id)),
            charSelectionIds: compactList(scene.charSelectionIds, 8, 24).filter(id => artifactIds.has(id)),
        };
        const enoughOptions = sceneId === 'wordCloud' ? normalized.artifactIds.length >= 8 : normalized.options.length >= 2;
        const hasEvidence = new Set([
            ...normalized.options.flatMap(option => option.evidenceIds),
            ...normalized.artifactIds.flatMap(id => artifacts.find(item => item.id === id)?.evidenceIds || []),
        ]).size > 0;
        if (
            enoughOptions
            && hasEvidence
            && Boolean(normalized.transitionLines?.length)
            && normalized.sharedObject.length >= 2
            && normalized.memoryLine.length >= 6
            && normalized.charAction.length >= 6
            && normalized.reveal.length >= 6
        ) {
            scenes[sceneId] = normalized;
            personalizedSceneIds.push(sceneId);
        } else {
            // Sparse evidence may still use the safe local room interaction, but
            // every spatial transition in a fresh Part 1 run remains LLM-made.
            scenes[sceneId] = { ...scenes[sceneId], transitionLines, charVisibleText, ...(sceneId === 'lostLayer' ? { charMutter } : {}) };
        }
    }

    if (personalizedSceneIds.length < 2) return null;

    const openingChat = compactList(parsed.openingChat, 2, 72);
    if (openingChat.length !== 2) return null;

    return {
        version: QIXI_MEMORY_BUNDLE_VERSION,
        source: 'memory',
        openingChat,
        evidence,
        artifacts,
        scenes,
        personalizedSceneIds,
        generatedAt: Date.now(),
        contextSignature,
    };
}

export function loadQixiMemoryBundle(charId: string): QixiMemoryBundle | null {
    try {
        const parsed = JSON.parse(localStorage.getItem(`${QIXI_MEMORY_BUNDLE_PREFIX}${charId}`) || 'null') as QixiMemoryBundle | null;
        if (parsed?.version !== QIXI_MEMORY_BUNDLE_VERSION || !parsed.scenes || !Array.isArray(parsed.evidence)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function saveQixiMemoryBundle(charId: string, bundle: QixiMemoryBundle): void {
    try { localStorage.setItem(`${QIXI_MEMORY_BUNDLE_PREFIX}${charId}`, JSON.stringify(bundle)); } catch { /* optional cache */ }
}

function buildContextSignature(messages: Message[], char: CharacterProfile, user: UserProfile): string {
    const last = messages[messages.length - 1];
    return simpleHash([
        messages.length,
        last?.id || 0,
        last?.timestamp || 0,
        char.systemPrompt?.length || 0,
        char.description?.length || 0,
        user.name,
    ].join(':'));
}

function qixiBundlePrompt(char: CharacterProfile, user: UserProfile): string {
    const briefs = QIXI_SCENE_IDS.map(sceneId => `- ${sceneId}: ${SCENE_BRIEFS[sceneId]}`).join('\n');
    return `### 七夕特别活动：双层上下文探索素材包

你负责 Part 1：根据真实聊天、记忆召回、角色设定和用户资料，生成异常发生前的两句正常聊天，以及七个地点可即时播放的素材。User 与 ${char.name} 都不知道七夕活动，也不知道接下来会掉进上下文夹层；两个人会被同一次异常同时卷入不同层，双方看不见彼此，只能操作同一件东西。前六站不能直接说另一边就是 ${char.name}，第七站才让玩家确定。

角色：${char.name}
用户：${user.name}

事实与数量规则：
1. 只使用上下文明示的事实。不得补造共同经历、日期、礼物、原话、争吵、承诺或关系身份；没有准确原话时只能转述。
2. 资料充足时提取 12—18 条事实证据，最多 24 条；资料不足就少写，绝对不能为了数量编造。
3. 每条 evidence 必须具体、可辨认。object 是事实里真实出现的词、物件或动作。
4. artifacts 是从 evidence 派生的称呼、饮料、物件、梗、日期、情绪词、愿望或符号，每一项必须引用 evidenceIds。
5. 同一 evidence 原则上最多服务两个场景。每个场景尽量使用不同证据。
6. 选项必须是 User 真能做的动作；result 只描述 User 这一侧的即时结果。charAction 描述另一层随后发生的操作；reveal 只推进当前阶段的发现，不要替玩家总结爱情。
7. wordCloud 的 artifactIds 提供 12—20 个词，charSelectionIds 选择 3—6 个“最像 User”的词；其他场景 artifactIds 提供该站出现的真实物件。
8. openingChat 必须恰好两句，完全使用 ${char.name} 的说话方式。语义是：${char.name} 怀疑 ${user.name} 刚刚回复过，但自己没有收到。不能提活动、七夕、梦境、夹层、邀请、准备惊喜或“点击输入框”。
9. 每个场景必须提供 transitionLines 1—2 句，作为进入该空间前的过场。它要把上一空间留下的具体视觉痕迹自然变成下一空间的入口，并让本场景的真实记忆物件开始浮现。每句要短，只写 User 能看到的变化；不能总结主题，不能解释“另一层是谁”，不能写成系统提示或任务说明。
10. 每个场景必须提供 charVisibleText：这是 Char 操作以后，玩家能在共享物件上亲眼看见的 2—36 字短文本、标签或记号，不是解释性旁白。尤其 lostLayer 的顺序必须是“系统报错先出现 → 冷色字迹急匆匆闯入 → 一边抱怨一边抹掉报错和负片词 → 就地复写 charVisibleText”。charVisibleText 必须给出最后复写出来的可读核心句，不能只写“出现了一行字”。
11. lostLayer 还必须提供 charMutter：2—18 字，必须像 ${char.name} 在着急处理故障时脱口而出的短促碎念，可以骂这个破报错、嫌系统碍事、催它让开，但不能骂 User，不能解释身份，不能写“另一边有人”。wordCloud 必须按“User 选一个、Char 选一个”的顺序交替回应，不能等 User 全部选完才突然出现 Char 的全部选择。

场景要求：
${briefs}

只输出一个 JSON 对象，不要 Markdown，不要解释：
{
  "openingChat": ["角色察觉可能漏收消息", "角色困惑地确认异常"],
  "evidence": [
    { "id": "e1", "fact": "一条具体可核对的事实", "object": "真实物件或词", "tags": ["日常", "饮料"] }
  ],
  "artifacts": [
    { "id": "a1", "label": "一个短词或物件", "kind": "object|phrase|nickname|topic|date|emotion|wish|symbol", "evidenceIds": ["e1"] }
  ],
  "scenes": {
    "lostLayer": {
      "transitionLines": ["上一空间留下的痕迹开始变化", "下一空间从痕迹中浮现"],
      "sharedObject": "场景核心共享物件",
      "memoryLine": "真实记忆如何在这一层出现",
      "options": [{ "id": "contact-1", "label": "User 动作", "result": "动作结果", "evidenceIds": ["e1"] }],
      "charAction": "另一色文字或另一层操作",
      "charMutter": "角色看到破报错时脱口而出的急促碎念",
      "charVisibleText": "共享物件上实际显示的短句或记号",
      "reveal": "只推进到：怎么这么像 ta",
      "artifactIds": ["a1"],
      "charSelectionIds": []
    },
    "doubleWish": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [], "charAction": "...", "charVisibleText": "...", "reveal": "...", "artifactIds": [], "charSelectionIds": [] },
    "threadNeedle": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [], "charAction": "...", "charVisibleText": "...", "reveal": "...", "artifactIds": [], "charSelectionIds": [] },
    "offerings": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [], "charAction": "...", "charVisibleText": "...", "reveal": "...", "artifactIds": [], "charSelectionIds": [] },
    "reflection": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [], "charAction": "...", "charVisibleText": "...", "reveal": "...", "artifactIds": [], "charSelectionIds": [] },
    "nightMarket": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [], "charAction": "...", "charVisibleText": "...", "reveal": "...", "artifactIds": [], "charSelectionIds": [] },
    "wordCloud": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [], "charAction": "...", "charVisibleText": "...", "reveal": "...", "artifactIds": ["a1"], "charSelectionIds": ["a1"] }
  }
}`;
}

const formatRecentMessages = (messages: Message[]): string => messages
    .slice(-160)
    .map(message => {
        const content = message.type === 'image' ? '[图片]' : message.content;
        return `${message.role}: ${content}`;
    })
    .join('\n')
    .slice(-24000);

export async function prepareQixiMemoryBundle(
    char: CharacterProfile,
    user: UserProfile,
    apiConfig: APIConfig,
    options: { forceRegenerate?: boolean; strict?: boolean; onRecallComplete?: () => void } = {},
): Promise<QixiMemoryPreparation> {
    let messages: Message[] = [];
    try { messages = await DB.getMessagesByCharId(char.id); } catch { /* fallback below */ }
    const contextSignature = buildContextSignature(messages, char, user);
    const cached = loadQixiMemoryBundle(char.id);
    if (!options.forceRegenerate && cached?.contextSignature === contextSignature) {
        options.onRecallComplete?.();
        return { bundle: cached, usedFallback: cached.source === 'fallback' };
    }

    if (!apiConfig.baseUrl || !apiConfig.apiKey || !apiConfig.model) {
        if (options.strict) throw new Error('Part 1 无法生成：请先配置可用的模型 API。');
        if (cached?.source === 'memory') {
            return { bundle: cached, usedFallback: false, reason: 'API 未配置，沿用上次找到的真实记忆' };
        }
        return { bundle: createQixiFallbackBundle(contextSignature), usedFallback: true, reason: 'API 未配置，使用基础双层梦境' };
    }

    try {
        const recallQuery = [
            '七夕活动需要的真实共同记忆，请同时寻找以下方面：',
            '想念、寻找对方、联系、分享、没说完的话、撤回、沉默、等待、失联；',
            '礼物、食物、饮料、日常物件、日期时间、称呼昵称、口头禅、截图图片、梗；',
            '学习、工作、创作、为对方做成的事、愿望目标、未来、彼此印象；',
            '安慰、害怕、难过、烦恼、负面情绪、陪伴、和好、需要、喜欢、自由、休息。',
            '优先返回私人、具体、可核对，能适配七夕八个地点的记忆。',
        ].join('\n');
        const recallChar = { ...char, memoryPalaceInjection: '', roomPlatesInjection: '' };
        await injectMemoryPalace(recallChar, messages, recallQuery, user.name, { entryPoint: 'direct' });
        options.onRecallComplete?.();
        const memoryChar = {
            ...char,
            memoryPalaceInjection: (recallChar.memoryPalaceInjection || '').slice(0, 30000),
            roomPlatesInjection: recallChar.roomPlatesInjection || '',
        };
        const recent = formatRecentMessages(messages);
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
                    temperature: 0.58,
                    stream: false,
                }),
            },
            0,
            70000,
            { appId: 'special-moments', charId: char.id, purpose: 'qixi-dual-layer-part1-v6' },
        );
        const content = data?.choices?.[0]?.message?.content;
        const bundle = typeof content === 'string' ? parseQixiMemoryBundle(content, contextSignature) : null;
        if (!bundle) throw new Error('模型没有返回可用的七夕双层素材包');
        saveQixiMemoryBundle(char.id, bundle);
        return { bundle, usedFallback: false };
    } catch (error: any) {
        console.warn('[Qixi] v6 memory bundle fallback:', error?.message || error);
        if (options.strict) throw new Error(error?.message || 'Part 1 生成失败，请手动重新生成。');
        if (cached?.source === 'memory') {
            return { bundle: cached, usedFallback: false, reason: '新记忆暂时没有抵达，沿用上次素材' };
        }
        return {
            bundle: createQixiFallbackBundle(contextSignature),
            usedFallback: true,
            reason: '记忆星线暂时没有抵达，使用基础双层梦境',
        };
    }
}

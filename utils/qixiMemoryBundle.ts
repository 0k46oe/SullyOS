import { APIConfig, CharacterProfile, Message, UserProfile } from '../types';
import { ContextBuilder } from './context';
import { DB } from './db';
import { injectMemoryPalace } from './memoryPalace/pipeline';
import { safeFetchJson } from './safeApi';
import { parseQixiJsonObject } from './qixiJson';

export const QIXI_MEMORY_BUNDLE_VERSION = 17 as const;
export const QIXI_MEMORY_BUNDLE_PREFIX = 'sullyos_qixi_memory_bundle_v17_';
export const QIXI_RECALL_MAX_OUTPUT_ITEMS = 20;
export const QIXI_PART1_FIRST_SCENE_IDS = ['lostLayer', 'doubleWish', 'threadNeedle', 'offerings'] as const;
export const QIXI_PART1_SECOND_SCENE_IDS = ['reflection', 'nightMarket', 'wordCloud'] as const;

export const QIXI_USER_LAYER_COLORS = [
    { value: '#F0A6C2', label: '蔷薇' },
    { value: '#F2B36F', label: '琥珀' },
    { value: '#E99078', label: '珊瑚' },
    { value: '#B8A1F2', label: '鸢尾' },
    { value: '#76CFC5', label: '潮汐' },
    { value: '#A8D17B', label: '新叶' },
    { value: '#7FA9E8', label: '远空' },
    { value: '#C590E8', label: '紫藤' },
    { value: '#F5F1EA', label: '月白' },
    { value: '#25222C', label: '墨黑' },
] as const;

const QIXI_CHAR_LAYER_COLORS = [
    { value: '#8FC8FF', label: '天青' },
    { value: '#D6A6F2', label: '藤紫' },
    { value: '#F0B66F', label: '灯火' },
    { value: '#82D5B8', label: '薄荷' },
    { value: '#F19A8F', label: '石榴' },
    { value: '#C5D477', label: '青柠' },
    { value: '#E9B4D1', label: '晚樱' },
    { value: '#9FB4F2', label: '暮蓝' },
] as const;

export const QIXI_DEFAULT_USER_LAYER_COLOR = QIXI_USER_LAYER_COLORS[0].value;
export const QIXI_FALLBACK_CHAR_LAYER_COLOR = QIXI_CHAR_LAYER_COLORS[1].value;

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

export type QixiArtifactKind = 'object' | 'phrase' | 'nickname' | 'topic' | 'date' | 'emotion' | 'wish' | 'symbol' | 'trait';
export type QixiCharTempo = 'brisk' | 'measured' | 'hesitant' | 'playful';
export type QixiCharMarkStyle = 'precise' | 'soft' | 'scribbled' | 'ornate';
export type QixiCharPresence = 'direct' | 'careful' | 'teasing' | 'quiet';

export interface QixiCharPerformance {
    tempo: QixiCharTempo;
    markStyle: QixiCharMarkStyle;
    presence: QixiCharPresence;
}

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
    /** Lost-layer only: Char's actual reply to this exact User topic after clearing the errors. */
    charReply?: string;
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
    /** In-character remarks shown inside the shared visual object. */
    charQuips?: string[];
    /** Lost-layer only: Char's hurried mutter while forcing the failed message back through. */
    charMutter?: string;
    /** Offerings only: the distinct thing Char puts down from the other layer. */
    charContribution?: string;
    reveal: string;
    artifactIds: string[];
    charSelectionIds: string[];
}

export const QIXI_FALLBACK_TRANSITIONS: Record<QixiSceneId, string[]> = {
    lostLayer: ['裂开的聊天界面在身后合拢。', '几句还没来得及说的话，停在了同一个发送框里。'],
    doubleWish: ['弹出的报错被划成几片，选中的话题仍原样留在发送框里。', '碎片落下去，托起一张被风反复翻动的纸。'],
    threadNeedle: ['纸背的墨迹被风抽成一根细线。', '线穿过夜色，停在一枚针孔前。'],
    offerings: ['穿过针孔的线没有断。', '它牵着你来到一张摆着空位的长桌前。'],
    reflection: ['桌边滚落的一点光沉进水里。', '水面把刚才出现过的两种颜色都留下。'],
    nightMarket: ['水纹推开岸边的夜色。', '灯牌和摊位从倒影里一盏盏亮起。'],
    wordCloud: ['夜市尽头垂下葡萄藤。', '买走与留下的词，都被挂进了叶影。'],
};

export const QIXI_FALLBACK_CHAR_VISIBLE_TEXT: Record<QixiSceneId, string> = {
    lostLayer: '挡路的，删掉。',
    doubleWish: '希望以后还能和你一起认真期待明天。',
    threadNeedle: '抓稳，我来把线送过去。',
    offerings: '这个留给你。',
    reflection: '我在这里。',
    nightMarket: '刚刚被另一边买走。',
    wordCloud: '轮到我选你了。',
};

export const QIXI_FALLBACK_CHAR_QUIPS: Record<QixiSceneId, string[]> = {
    lostLayer: ['道歉留着自己看。', '这次不许再吞。'],
    doubleWish: ['这面先别看。写得有点太认真了。'],
    threadNeedle: ['别抖，针都比你先紧张了。'],
    offerings: ['供品怎么还带互相投喂的。违规得不错。'],
    reflection: ['你那一笔歪得很有辨识度，我认出来了。'],
    nightMarket: ['这摊只收尴尬回忆？行，给我打包。'],
    wordCloud: ['这个词很像你。别申诉。', '又像一个。词云可能偷看过你。', '最后一个我来选，不接受复议。'],
};

export const QIXI_FALLBACK_CHAR_MUTTER = '别挡着。';

export const qixiTransitionLines = (sceneId: QixiSceneId, scene: QixiScenePayload): string[] =>
    scene.transitionLines?.length ? scene.transitionLines : QIXI_FALLBACK_TRANSITIONS[sceneId];

export const qixiCharVisibleText = (sceneId: QixiSceneId, scene: QixiScenePayload): string =>
    scene.charVisibleText?.trim() || QIXI_FALLBACK_CHAR_VISIBLE_TEXT[sceneId];

export const qixiCharMutter = (scene: QixiScenePayload): string =>
    scene.charMutter?.trim() || QIXI_FALLBACK_CHAR_MUTTER;

export const qixiCharQuips = (sceneId: QixiSceneId, scene: QixiScenePayload): string[] =>
    scene.charQuips?.length ? scene.charQuips : QIXI_FALLBACK_CHAR_QUIPS[sceneId];

export interface QixiMemoryBundle {
    version: typeof QIXI_MEMORY_BUNDLE_VERSION;
    source: 'memory' | 'fallback';
    openingChat: string[];
    charLayerColor: string;
    charPerformance: QixiCharPerformance;
    evidence: QixiMemoryEvidence[];
    artifacts: QixiMemoryArtifact[];
    scenes: Record<QixiSceneId, QixiScenePayload>;
    personalizedSceneIds: QixiSceneId[];
    /** Non-fatal field-level repairs applied after schema parsing. */
    repairNotes?: string[];
    generatedAt: number;
    contextSignature: string;
}

export interface QixiMemoryPreparation {
    bundle: QixiMemoryBundle;
    usedFallback: boolean;
    reason?: string;
}

const SCENE_BRIEFS: Record<QixiSceneId, string> = {
    lostLayer: '01 被动痕迹：从不同真实 evidence 各提炼一个 User 此刻想和 Char 继续聊的具体话题。User 选中后发送失败，API 报错、超时、限流与措辞过软的道歉弹窗迅速铺满空间；Char 从另一层冲回来强制划掉、撕碎或踢走所有红框。User 选中的话题必须原样留在发送框里，绝不能成为 Char 攻击、改写或抢救的对象。清障时由 charMutter 与两句 charQuips 漏出周围碎碎念；清障后必须用该 option.charReply 真正回应 User 选中的具体话题，表示 ta 突破阻碍把回复送了回来。reveal 只让 User 确定异常里存在另一个人的操作，不能说是谁，也不能提前总结熟悉感。',
    doubleWish: '02 异步共用：User 在祈愿笺正面选择一个关于两个人未来、以后想一起做什么或希望共同抵达哪里的愿望；Char 在另一层认真写下属于 ta 自己、同样指向两个人未来的愿望，并在纸角留一句没打算让 User 看见的私人碎碎念。如果记忆召回里存在记忆宫殿“窗台房间 / Window Sill”里的未来愿望、计划或对以后生活的期盼，必须优先从那里提炼，但不得把愿望写成已经发生的共同经历。通过翻面、抢纸、未干墨迹或位置冲突，让 User 明确发现双方正在异步使用同一张纸。',
    threadNeedle: '03 主动协作：双方必须配合才能完成穿针，Char 的操作要直接回应 User 的策略；允许抢错针线、拉得太快或第一次配合失败。reveal 只推进到双方能主动协作。',
    offerings: '04 互相判断：User 先从三个具体选项里放下属于自己的东西；随后另一层必须另外摆上一件属于 Char 自己的东西，并用 charContribution 明确写出这件东西是什么，不能只挪动、抢走或评价 User 的供物。允许双方位置冲突、交换或挪动，但画面顺序必须能读成“User 的东西先出现 → Char 自己的东西从另一边出现 → Char 吐槽”。私人性落在双方各自选了什么和如何摆放，不让旁白替玩家解释。',
    reflection: '05 近实时交流：User 留下可被修改的符号、短句或痕迹，Char 立刻接续、划掉、改写或故意曲解，使这一站第一次接近真正的隔层对话。',
    nightMarket: '06 主动试探：双方已经明显怀疑对方身份，故意购买、交换、嫌弃或抢走只有那个人才会理解的真实记忆商品来试探；不要在 reveal 里直接说出答案。',
    wordCloud: '07 身份确认：不再寻找新证据。提供 12—20 个有角色设定或真实上下文依据的性格、气质、处事方式短词；User 与 Char 严格交替各选三次眼中的对方并即时吐槽，第三轮后让前六站积累自然完成确认。',
};

const compact = (value: unknown, max: number): string => {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim().slice(0, max);
};

const compactList = (value: unknown, maxItems: number, maxChars: number): string[] => Array.isArray(value)
    ? [...new Set(value.map(item => compact(item, maxChars)).filter(Boolean))].slice(0, maxItems)
    : [];

const LOST_TOPIC_TECHNICAL_LANGUAGE = /(?:bug|debug|部署|改\s*代码|代码|接口|日志|运维|调试|修复报错|系统故障|协议错误)/i;
const PLAYER_COPY_INTERNAL_REFERENCE = /\bevidence(?:ids?)?\b|(?:^|[^a-z0-9])e\d+(?=$|[^a-z0-9])/i;
const GENERATED_TRANSITION_JARGON = /(?:数据流|字符化|上下文|context|cyberorder|协议|接口|日志|部署|调试|代码|程序|模型输出|prompt|api|(?:系统|平台)(?:提示|说明|指令)|【[^】]*[a-z][^】]*】|\[[^\]]*[a-z][^\]]*\])/i;
const LOST_LAYER_ERROR_TARGET = /(?:报错|错误|DELIVERY\s*FAILED|弹窗)/i;
const LOST_LAYER_TOPIC_MUTATION = /(?:(?:改写|重写|删除|划掉|撕碎|抹掉|吞掉|挤走|抢救).{0,16}(?:话题|消息|文字|字符)|(?:话题|消息|文字|字符).{0,16}(?:改写|重写|删除|划掉|撕碎|抹掉|吞掉|挤走|抢救))/i;
const LOST_LAYER_TOPIC_REFERENCE = /(?:这句(?:话)?|话题|消息|文字|字符)/i;
const CHAR_ASIDE_META_LANGUAGE = /(?:系统|数据流|字符化|上下文|协议|接口|模型输出|prompt|api)/i;
const SHARED_FUTURE_WISH = /(?:我们|一起|和你|与你|彼此|两个人|共同|陪你|再和)/i;

const normalizeCharLayerColor = (value: unknown): string => {
    const requested = compact(value, 7).toUpperCase();
    return QIXI_CHAR_LAYER_COLORS.find(color => color.value === requested)?.value
        || QIXI_FALLBACK_CHAR_LAYER_COLOR;
};

const normalizeCharPerformance = (value: any): QixiCharPerformance => {
    const tempo = compact(value?.tempo, 16) as QixiCharTempo;
    const markStyle = compact(value?.markStyle, 16) as QixiCharMarkStyle;
    const presence = compact(value?.presence, 16) as QixiCharPresence;
    return {
        tempo: (['brisk', 'measured', 'hesitant', 'playful'] as string[]).includes(tempo) ? tempo : 'measured',
        markStyle: (['precise', 'soft', 'scribbled', 'ornate'] as string[]).includes(markStyle) ? markStyle : 'soft',
        presence: (['direct', 'careful', 'teasing', 'quiet'] as string[]).includes(presence) ? presence : 'careful',
    };
};

const simpleHash = (value: string): string => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
};

const fallbackLostTopics = (evidence: QixiMemoryEvidence[]): QixiSceneOption[] => {
    const grounded = evidence.slice(0, 3).map((item, index): QixiSceneOption => {
        const subject = compact(item.object, 18) || compact(item.fact, 22);
        const labels = [
            `问问 ta「${subject}」后来怎么样`,
            `把「${subject}」那件事接着说完`,
            `拿「${subject}」试探一下 ta`,
        ];
        const results = [
            '这句追问刚离开发送框，就被退回成一颗暗下去的星。',
            '话题在发送线上停了很久，最后只留下“未送达”。',
            '试探只亮了一瞬，随即连同文字一起变成 DELIVERY FAILED。',
        ];
        const replies = [
            `你提到“${subject}”了。我在，接着说。`,
            `“${subject}”没有丢。你继续，我听着。`,
            `拿“${subject}”试我？行，我接到了。`,
        ];
        return { id: `memory-topic-${index + 1}`, label: labels[index], result: results[index], charReply: replies[index], evidenceIds: [item.id] };
    });
    if (grounded.length === 3) return grounded;
    const generic = [
        { id: 'today', label: '问问 ta 今天过得怎么样', result: '这句问候刚离开发送框，就被退回成一颗暗下去的星。', charReply: '在。今天的事你慢慢说，我听着。', evidenceIds: [] },
        { id: 'small-thing', label: '讲讲刚刚想到的一件小事', result: '话题在发送线上停了很久，最后只留下“未送达”。', charReply: '小事也要送到。说吧，我接住了。', evidenceIds: [] },
        { id: 'share', label: '把现在看到的东西分享给 ta', result: '分享卡片亮了一下，随即连同文字一起退回原处。', charReply: '看见了。别让这个破东西替你收回去。', evidenceIds: [] },
    ];
    return [...grounded, ...generic.slice(grounded.length)].slice(0, 3);
};

const fallbackScenes = (evidence: QixiMemoryEvidence[] = []): Record<QixiSceneId, QixiScenePayload> => ({
    lostLayer: {
        sharedObject: '一个停在发送前的话题框',
        memoryLine: '几件最近聊过的小事浮在输入框里，像都在等你挑一句开头。',
        options: fallbackLostTopics(evidence),
        charAction: '另一色痕迹直接扑向弹出的 DELIVERY FAILED，把报错划掉、撕碎并踢出发送框；User 选中的话题原样留在原处。',
        charVisibleText: QIXI_FALLBACK_CHAR_VISIBLE_TEXT.lostLayer,
        charQuips: QIXI_FALLBACK_CHAR_QUIPS.lostLayer,
        charMutter: QIXI_FALLBACK_CHAR_MUTTER,
        reveal: '弹窗碎掉以后，选中的话题还原样停在发送框里。',
        artifactIds: [],
        charSelectionIds: [],
    },
    doubleWish: {
        sharedObject: '一张会被风翻面的祈愿笺',
        memoryLine: '正面朝向你，背面朝向另一个看不见的地方。',
        options: [
            { id: 'steady', label: '写：希望我们以后都能慢慢安稳下来', result: '墨迹沉进纸纤维，没有替你们许诺结果。', evidenceIds: [] },
            { id: 'brave', label: '写：希望还能一起去没去过的地方', result: '“一起”两个字被风吹得很轻，却没有消失。', evidenceIds: [] },
            { id: 'rest', label: '写：希望以后还能陪彼此好好休息', result: '纸角松下来，像终于肯把肩膀放低一点。', evidenceIds: [] },
        ],
        charAction: '卡片忽然翻面。另一色字迹已经认真写下一句关于两个人以后的愿望。',
        charVisibleText: QIXI_FALLBACK_CHAR_VISIBLE_TEXT.doubleWish,
        charQuips: QIXI_FALLBACK_CHAR_QUIPS.doubleWish,
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
            { id: 'feint', label: '先把两样都碰一下，再突然松手', result: '另一层果然抢先按住了针，线却被你们同时扯成一个小结。', evidenceIds: [] },
        ],
        charAction: '另一端把线轻轻收紧，织物里鼓起一只会替人收好小东西的无名生物。',
        charQuips: QIXI_FALLBACK_CHAR_QUIPS.threadNeedle,
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
        charContribution: '一颗被捏得有点歪的星星糖',
        charQuips: QIXI_FALLBACK_CHAR_QUIPS.offerings,
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
        charQuips: QIXI_FALLBACK_CHAR_QUIPS.reflection,
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
        charQuips: QIXI_FALLBACK_CHAR_QUIPS.nightMarket,
        reveal: '被买走的那件东西与 ta 无关，反而很像你。',
        artifactIds: [],
        charSelectionIds: [],
    },
    wordCloud: {
        sharedObject: '葡萄架下缓慢漂浮的性格词云',
        memoryLine: '这些词不写名字，只问你想到的那个人是什么样。',
        options: [],
        charAction: '你每选一个形容 ta 的性格词，另一层也随后点亮一个在 ta 眼里很像你的词。',
        charQuips: QIXI_FALLBACK_CHAR_QUIPS.wordCloud,
        reveal: '你们隔着一层，各自挑出了眼里的对方。',
        artifactIds: [],
        charSelectionIds: [],
    },
});

export function createQixiFallbackBundle(contextSignature = '', charLayerColor = QIXI_FALLBACK_CHAR_LAYER_COLOR): QixiMemoryBundle {
    return {
        version: QIXI_MEMORY_BUNDLE_VERSION,
        source: 'fallback',
        openingChat: ['你刚才是不是回我消息了？', '奇怪……我这里什么也没看到。'],
        charLayerColor: normalizeCharLayerColor(charLayerColor),
        charPerformance: normalizeCharPerformance(null),
        evidence: [],
        artifacts: [],
        scenes: fallbackScenes(),
        personalizedSceneIds: [],
        generatedAt: Date.now(),
        contextSignature,
    };
}

export function parseQixiMemoryBundle(
    raw: string,
    contextSignature = '',
    onFailure?: (reason: string) => void,
): QixiMemoryBundle | null {
    const fail = (reason: string): null => {
        onFailure?.(reason);
        return null;
    };
    const parsed = parseQixiJsonObject(raw, ['scenes', 'evidence']) as any;
    if (!parsed || typeof parsed !== 'object') return fail('没有解析到 JSON 对象');
    if (!Array.isArray(parsed.evidence)) return fail('顶层 evidence 缺失或不是数组');

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
    if (evidence.length < 2) return fail(`可用 evidence 不足：${evidence.length}/2`);

    const evidenceIds = new Set(evidence.map(item => item.id));
    const seenArtifactIds = new Set<string>();
    const artifacts: QixiMemoryArtifact[] = (Array.isArray(parsed.artifacts) ? parsed.artifacts : [])
        .slice(0, 40)
        .map((item: any, index: number): QixiMemoryArtifact => {
            const kind = compact(item?.kind, 16) as QixiArtifactKind;
            return {
                id: compact(item?.id, 24) || `a${index + 1}`,
                label: compact(item?.label, 42),
                kind: (['object', 'phrase', 'nickname', 'topic', 'date', 'emotion', 'wish', 'symbol', 'trait'] as string[]).includes(kind) ? kind : 'object',
                evidenceIds: compactList(item?.evidenceIds, 4, 24).filter(id => evidenceIds.has(id)),
            };
        })
        .filter((item: QixiMemoryArtifact) => {
            if (!item.label || !item.evidenceIds.length || seenArtifactIds.has(item.id)) return false;
            seenArtifactIds.add(item.id);
            return true;
        });
    const artifactIds = new Set(artifacts.map(item => item.id));
    const scenes = fallbackScenes(evidence);
    const personalizedSceneIds: QixiSceneId[] = [];
    const sceneFallbackReasons: string[] = [];
    const repairNotes: string[] = [];

    for (const sceneId of QIXI_SCENE_IDS) {
        const scene = parsed.scenes?.[sceneId];
        if (!scene || typeof scene !== 'object') return fail(`场景 ${sceneId} 缺失或不是对象`);
        const generatedTransitionLines = compactList(scene.transitionLines, 2, 64);
        const transitionHasJargon = GENERATED_TRANSITION_JARGON.test(generatedTransitionLines.join(' '));
        const transitionLines = transitionHasJargon
            ? QIXI_FALLBACK_TRANSITIONS[sceneId]
            : generatedTransitionLines;
        if (!transitionLines.length) return fail(`场景 ${sceneId}.transitionLines 缺失或为空`);
        if (transitionHasJargon) {
            repairNotes.push(`${sceneId}.transitionLines 出现系统设定黑话，已替换为本地可读过场`);
        }
        const generatedCharVisibleText = compact(scene.charVisibleText, 72);
        if (sceneId === 'lostLayer' && generatedCharVisibleText.length < 2) {
            return fail('场景 lostLayer.charVisibleText 缺失或过短');
        }
        const invalidDoubleWishReason = sceneId === 'doubleWish'
            ? generatedCharVisibleText.length < 2
                ? '缺失或过短'
                : /(?:数据|系统|报错|协议|界面|代码|指令)/.test(generatedCharVisibleText)
                    ? '写成了系统说明'
                    : /^(?:愿望是|希望|愿)?\s*(?:你|User)/i.test(generatedCharVisibleText)
                        ? '只在祝福 User'
                        : !SHARED_FUTURE_WISH.test(generatedCharVisibleText)
                            ? '没有写两个人的未来'
                        : ''
            : '';
        const charVisibleText = sceneId === 'doubleWish'
            ? (invalidDoubleWishReason ? QIXI_FALLBACK_CHAR_VISIBLE_TEXT.doubleWish : generatedCharVisibleText)
            : sceneId === 'lostLayer' ? generatedCharVisibleText : '';
        if (invalidDoubleWishReason) {
            repairNotes.push(`doubleWish.charVisibleText ${invalidDoubleWishReason}，已替换为本地安全愿望`);
        }
        const requiredQuipCount = sceneId === 'wordCloud'
            ? 3
            : sceneId === 'lostLayer' ? 2
                : ['doubleWish', 'threadNeedle', 'offerings', 'reflection', 'nightMarket'].includes(sceneId) ? 1 : 0;
        const parsedCharQuips = compactList(scene.charQuips, sceneId === 'wordCloud' ? 3 : 2, 52);
        const invalidLostLayerQuips = sceneId === 'lostLayer'
            && (parsedCharQuips.length < 2 || LOST_LAYER_TOPIC_REFERENCE.test(parsedCharQuips.join(' ')));
        const invalidDoubleWishQuip = sceneId === 'doubleWish'
            && (parsedCharQuips.length < 1 || CHAR_ASIDE_META_LANGUAGE.test(parsedCharQuips.join(' ')));
        if (parsedCharQuips.length < requiredQuipCount && !['lostLayer', 'doubleWish'].includes(sceneId)) {
            return fail(`场景 ${sceneId}.charQuips 不足：${parsedCharQuips.length}/${requiredQuipCount}`);
        }
        const charQuips = invalidDoubleWishQuip
            ? QIXI_FALLBACK_CHAR_QUIPS.doubleWish
            : invalidLostLayerQuips ? QIXI_FALLBACK_CHAR_QUIPS.lostLayer
                : requiredQuipCount ? parsedCharQuips : [];
        if (invalidLostLayerQuips) {
            repairNotes.push('lostLayer.charQuips 缺失或错误指向 User 话题，已替换为本地清障碎碎念');
        }
        if (invalidDoubleWishQuip) {
            repairNotes.push('doubleWish.charQuips 缺失或写成系统说明，已替换为本地私人碎碎念');
        }
        const charMutter = sceneId === 'lostLayer' ? compact(scene.charMutter, 36) : '';
        if (sceneId === 'lostLayer' && charMutter.length < 2) return fail('场景 lostLayer.charMutter 缺失或过短');
        const charContribution = sceneId === 'offerings' ? compact(scene.charContribution, 24) : '';
        const options = (Array.isArray(scene.options) ? scene.options : [])
            .slice(0, sceneId === 'wordCloud' ? 0 : 3)
            .map((option: any, index: number): QixiSceneOption => ({
                id: compact(option?.id, 24) || `${sceneId}-${index + 1}`,
                label: compact(option?.label, 64),
                result: compact(option?.result, 190),
                ...(sceneId === 'lostLayer' ? { charReply: compact(option?.charReply, 48) } : {}),
                evidenceIds: compactList(option?.evidenceIds, 4, 24).filter(id => evidenceIds.has(id)),
            }))
            .filter((option: QixiSceneOption) => option.label.length >= 2
                && option.result.length >= 6
                && option.evidenceIds.length > 0
                && (sceneId !== 'lostLayer' || (option.charReply?.length || 0) >= 4)
                && !PLAYER_COPY_INTERNAL_REFERENCE.test(`${option.label} ${option.result} ${option.charReply || ''}`)
                && (sceneId !== 'doubleWish' || SHARED_FUTURE_WISH.test(option.label))
                && (sceneId !== 'lostLayer' || !LOST_TOPIC_TECHNICAL_LANGUAGE.test(option.label)));
        const selectedArtifactIds = compactList(scene.artifactIds, sceneId === 'wordCloud' ? 20 : 10, 24)
            .filter(id => artifactIds.has(id) && (sceneId !== 'wordCloud' || artifacts.find(item => item.id === id)?.kind === 'trait'));
        const selectedArtifactIdSet = new Set(selectedArtifactIds);
        const normalized: QixiScenePayload = {
            transitionLines,
            sharedObject: compact(scene.sharedObject, 72),
            memoryLine: compact(scene.memoryLine, 190),
            options,
            charAction: compact(scene.charAction, 220),
            ...(charVisibleText ? { charVisibleText } : {}),
            ...(charQuips.length ? { charQuips } : {}),
            ...(sceneId === 'lostLayer' ? { charMutter } : {}),
            ...(sceneId === 'offerings' && charContribution ? { charContribution } : {}),
            reveal: compact(scene.reveal, 180),
            artifactIds: selectedArtifactIds,
            charSelectionIds: compactList(scene.charSelectionIds, 8, 24)
                .filter(id => sceneId === 'wordCloud' ? selectedArtifactIdSet.has(id) : artifactIds.has(id)),
        };
        const enoughOptions = sceneId === 'wordCloud' ? normalized.artifactIds.length >= 8 : normalized.options.length === 3;
        const hasEvidence = new Set([
            ...normalized.options.flatMap(option => option.evidenceIds),
            ...normalized.artifactIds.flatMap(id => artifacts.find(item => item.id === id)?.evidenceIds || []),
        ]).size > 0;
        const keepsOrdinaryPlayerView = sceneId !== 'lostLayer' || !LOST_TOPIC_TECHNICAL_LANGUAGE.test([
            normalized.sharedObject,
            normalized.memoryLine,
            ...normalized.options.map(option => option.label),
        ].join(' '));
        const keepsInternalReferencesHidden = !PLAYER_COPY_INTERNAL_REFERENCE.test([
            normalized.sharedObject,
            normalized.memoryLine,
            normalized.charAction,
            normalized.charVisibleText || '',
            ...(normalized.charQuips || []),
            ...(normalized.options.map(option => option.charReply || '')),
            normalized.charContribution || '',
            normalized.reveal,
        ].join(' '));
        const keepsLostLayerTarget = sceneId !== 'lostLayer' || (
            LOST_LAYER_ERROR_TARGET.test(normalized.charAction)
            && !LOST_LAYER_TOPIC_MUTATION.test(normalized.charAction)
            && !LOST_LAYER_TOPIC_REFERENCE.test(`${normalized.charVisibleText || ''} ${normalized.charMutter || ''}`)
        );
        if (
            enoughOptions
            && hasEvidence
            && Boolean(normalized.transitionLines?.length)
            && normalized.sharedObject.length >= 2
            && normalized.memoryLine.length >= 6
            && normalized.charAction.length >= 6
            && normalized.reveal.length >= 6
            && (sceneId !== 'offerings' || (normalized.charContribution?.length || 0) >= 2)
            && keepsOrdinaryPlayerView
            && keepsInternalReferencesHidden
            && keepsLostLayerTarget
        ) {
            scenes[sceneId] = normalized;
            personalizedSceneIds.push(sceneId);
        } else {
            const reasons = [
                !enoughOptions
                    ? (sceneId === 'wordCloud'
                        ? `有效 artifactIds 不足：${normalized.artifactIds.length}/8`
                        : `有效 options 不足：${normalized.options.length}/3`)
                    : '',
                !hasEvidence ? '没有有效 evidence 引用' : '',
                normalized.sharedObject.length < 2 ? 'sharedObject 缺失或过短' : '',
                normalized.memoryLine.length < 6 ? 'memoryLine 缺失或过短' : '',
                normalized.charAction.length < 6 ? 'charAction 缺失或过短' : '',
                normalized.reveal.length < 6 ? 'reveal 缺失或过短' : '',
                sceneId === 'offerings' && (normalized.charContribution?.length || 0) < 2 ? 'charContribution 缺失或过短' : '',
                !keepsOrdinaryPlayerView ? '出现开发或故障处理视角' : '',
                !keepsInternalReferencesHidden ? '玩家可见文案泄露内部 evidence 编号' : '',
                !keepsLostLayerTarget ? 'Char 的攻击目标不是弹出的报错，或错误改写了 User 话题' : '',
            ].filter(Boolean);
            sceneFallbackReasons.push(`${sceneId}：${reasons.join('，')}`);
            // Sparse evidence may still use the safe local room interaction. Keep a
            // valid LLM transition, but never copy topic-targeting Lost Layer text
            // back over the local error-targeting choreography.
            scenes[sceneId] = {
                ...scenes[sceneId],
                transitionLines,
                ...((sceneId !== 'lostLayer' || keepsLostLayerTarget) && charVisibleText ? { charVisibleText } : {}),
                ...(charQuips.length ? { charQuips } : {}),
                ...(sceneId === 'lostLayer' && keepsLostLayerTarget ? { charMutter } : {}),
                ...(sceneId === 'offerings' && charContribution ? { charContribution } : {}),
            };
        }
    }

    if (personalizedSceneIds.length < 2) {
        const details = sceneFallbackReasons.slice(0, 4).join('；');
        return fail(`可用个性化场景不足：${personalizedSceneIds.length}/2${details ? `（${details}）` : ''}`);
    }

    const openingChat = compactList(parsed.openingChat, 2, 72);
    if (openingChat.length !== 2) return fail(`openingChat 必须有两句，实际 ${openingChat.length} 句`);

    return {
        version: QIXI_MEMORY_BUNDLE_VERSION,
        source: 'memory',
        openingChat,
        charLayerColor: normalizeCharLayerColor(parsed.charLayerColor),
        charPerformance: normalizeCharPerformance(parsed.charPerformance),
        evidence,
        artifacts,
        scenes,
        personalizedSceneIds,
        ...(repairNotes.length ? { repairNotes } : {}),
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

export function buildQixiMemoryBundlePrompt(
    char: CharacterProfile,
    user: UserProfile,
    userLayerColor: string = QIXI_DEFAULT_USER_LAYER_COLOR,
): string {
    const briefs = QIXI_SCENE_IDS.map(sceneId => `- ${sceneId}: ${SCENE_BRIEFS[sceneId]}`).join('\n');
    const charColorChoices = QIXI_CHAR_LAYER_COLORS.map(color => `${color.label} ${color.value}`).join('、');
    return `### 七夕特别活动：双层上下文探索素材包

【最高优先级】不要证明 ${char.name} 记得 ${user.name}，而要让 ${char.name} 使用这些记忆与 ${user.name} 做事。记忆是玩法材料，不是展示内容。

【同级最高优先级】记忆最多决定“这一站碰到什么”，${char.name} 本人必须决定“ta 怎么做、怎么犹豫、怎么嘴硬、会突然小声说什么”。不要让每一句反应都复述、解释或回收 evidence；如果拿掉记忆名词，Char 的动作和碎碎念仍应鲜活到能认出是 ta。角色不是记忆宫殿的讲解员。

【同级最高优先级】${char.name} 与 User 是对称受困者：ta 也刚刚掉进上下文夹层、同样突然找不到 User、同样不知道活动规则和对面是谁。ta 有自己正在经历的事故、选择、试探、误判和情绪，不是在另一层从容等待 User 操作的引导员。前几站只能从 User 留在共享物上的新鲜痕迹逐步怀疑身份，不能全知 User 当前在想什么，也不能一开始就确信对面是 User；允许 ta 找错、抢错、配合失败、因为着急显得笨拙，或先忙着解决自己那一层的问题。每次介入不必都服务、照顾或正确回应 User。

你负责 Part 1：根据真实聊天、记忆召回、角色设定和用户资料，生成异常发生前的两句正常聊天，以及七个地点可即时播放的素材。七站必须组成一条连续发展的“双人异常事件”，不是七个独立的记忆小游戏，也不是“记忆事实 → 物件 → 选项 → Char 操作 → reveal”重复七次。User 与 ${char.name} 都不知道七夕活动，也不知道接下来会掉进上下文夹层；两个人会被同一次异常同时卷入不同层，双方看不见彼此，只能通过同一件东西留下的即时变化猜测另一边发生了什么。

关系推进必须依次发生：User 起初只知道系统异常 → 发现另一层存在某个人 → 发现对方会回应自己的操作 → 开始觉得处理事情的方式很熟悉 → 主动试探 → 第七站无需系统解释也能认出 ${char.name}。每站 reveal 必须停在该站阶段，不能提前揭晓，也不能靠旁白替玩家得出结论。

角色：${char.name}
用户：${user.name}
User 已选择自己的层色：${userLayerColor}

请根据 ${char.name} 的人格、审美和说话气质，从以下可读色中为 ta 选择一个专属层色，并输出到 charLayerColor。不要因为性别默认选择粉色或蓝色；优先选择能代表角色、且与 User 层色容易区分的颜色：${charColorChoices}

同时生成 charPerformance，让 ${char.name} 在七个固定玩法里的介入方式仍然像 ta 自己。tempo 只能是 brisk（利落迅速）/ measured（稳而克制）/ hesitant（先迟疑再行动）/ playful（轻快带玩心）；markStyle 只能是 precise（整齐锐利）/ soft（柔和圆润）/ scribbled（随手凌乱）/ ornate（有装饰感）；presence 只能是 direct（直接）/ careful（小心照顾）/ teasing（爱逗人）/ quiet（安静少言）。必须根据角色设定选择，不能所有角色都使用默认组合。

事实、演出与互动规则：
1. 事实不可虚构，演出可以虚构。只使用上下文明示的过去事实；不得补造共同经历、日期、礼物、原话、争吵、承诺或关系身份，没有准确原话时只能转述。允许把真实 evidence 演成新的超现实设施、故障、商品、空间反应、物件变形或互动事故。不能创造假的过去，可以创造新的现在。
2. 资料充足时提取 20 条互不重复的事实证据，最多 24 条；资料不足就少写，绝对不能为了数量编造。20 条要尽量跨不同时间、不同主题和不同记忆类型，不能把同一事件换个说法重复占位。每条 evidence 必须具体、可辨认，object 是事实里真实出现的词、物件或动作。
3. artifacts 必须从 evidence 派生，每一项都引用有效 evidenceIds。wordCloud 使用的性格词必须标为 kind="trait"。同一 evidence 原则上最多服务两个场景，每站尽量使用不同证据。每站只选一个最有效的记忆锚点做主角，不要把多个 facts 塞进同一段旁白；其余生命力来自当下的新事故和两个人的即时反应。
4. evidence 不能只被摆出来供人参观，必须成为当下事件中可被拿走、交换、破坏、修改、误用、抢先购买或用来试探身份的玩法材料。目标不是“游戏记得这件事”，而是“这种东西居然也被这里拿来玩了”。
5. 禁止连续使用低信息量陈列演出，例如“某个熟悉的东西浮现 / 某段记忆出现在眼前 / 水面泛起涟漪 / 纸面微微发亮 / 线轻轻颤动”。transitionLines、memoryLine、result、charAction 必须写具体发生了什么。
6. 前六站必须各提供恰好 3 个完整 options，不能少于或多于 3 个；wordCloud 的 options 必须为空。每个 option 都必须包含 id、label、result、evidenceIds，并且每个 option 自己都必须引用至少一个有效 evidence；不能只让整个场景笼统引用 evidence。
7. lostLayer 的每一个 option.label 都必须直接从它自己的 evidenceIds 所指向的具体事实、物件或未完话题提炼，让 User 选择“接着和 ${char.name} 聊哪段真实记忆”。禁止脱离 evidence 的泛泛问候，也不能生成开发、运维、代码或故障处理任务。可以让态度不同，例如不信邪重发、只丢一个问号试探、故意换个说法，但选项中必须看得出在聊哪条真实记忆。lostLayer 每个 option 还必须额外提供 charReply：这是清掉满屏报错之后，${char.name} 针对这个选项所代表话题真正送回来的 4—48 字回复；必须回应具体话题并像角色本人，不能继续谈报错、只写动作说明或泛泛说“我在”。所有玩家可见文案绝不能出现 e1、e2、evidenceId 等内部编号。
8. 选项要表现 User 的策略、态度或意图，减少只有“拿起 / 放下 / 点击 / 查看 / 写下 / 等待”的机械动作。即使前端最终仍是按钮，七站文本也不能像连续做七次同一种选择题。
9. result 不能只是“发光、颤动、出现反馈”，必须让 User 的具体选择改变这一轮互动：东西被抽走、位置被占、内容被改、双方撞车、配合失败后重来、某件商品提前售出等。
10. charAction 必须通过 ${char.name} 处理事情的方式暴露人格，至少体现一种具体特征：动作习惯、耐心、抢先、嘴硬、故意逗人、临时改主意、无意识的小动作、怪比喻、歪理或冷幽默。charPerformance 只是辅助参数，不能代替具体人格演出。遮掉角色名字和所有记忆名词后，仍应能凭动作与吐槽猜出是谁。Char 的动作必须同时像“ta 正在处理自己那一层的遭遇”，不能全部写成专程过来帮助 User；至少三站先写出 Char 自己的目的，再让双方动作意外相撞或接上。
11. 七站中至少四站要出现一次意外、失败、抢夺、擅自修改、互相妨碍或故意不配合；两层不能永远温柔顺利地用另一色光芒回应。
12. 前六站禁止频繁写“对方似乎很了解你 / 你感到熟悉 / 某种默契形成 / 你意识到彼此存在联系”这类爱情或关系总结。展示动作证据，不替玩家解释证据。
13. 七站玩法职责必须不同：lostLayer 是话题发送失败后报错红框铺满空间，Char 只攻击并毁掉报错，再真正回复所选话题；doubleWish 是异步共用同一张纸并分别许下关于两个人未来的愿望；threadNeedle 是动作顺序与另一层协作；offerings 是双方先后各自放下一件东西；reflection 是能被实时修改的痕迹；nightMarket 是购买、交换、嫌弃或抢走记忆商品来主动试探；wordCloud 是双方严格交替选词完成身份确认。
14. wordCloud 的 artifactIds 必须提供 12—20 个短小、好选择的性格/气质/处事方式词，用来回答“你想到的那个人是什么性格”；User 会从中选 3 个最像 ${char.name} 的词。不要放物件、日期、话题、称呼、愿望或“开心/难过”这类瞬时情绪。charSelectionIds 选择 3—6 个 ${char.name} 眼里“最像 User”的性格词。
15. openingChat 必须恰好两句，完全使用 ${char.name} 的说话方式。语义是：${char.name} 怀疑 ${user.name} 刚刚回复过，但自己没有收到。不能提活动、七夕、梦境、夹层、邀请、准备惊喜或“点击输入框”。
16. 每个场景必须提供 transitionLines 1—2 句，把上一站真实发生的具体结果变成下一站入口，让七站保持因果连续。每句用 12—38 个中文字符，只写 User 能直接看到、听到或碰到的普通感官变化，不能总结主题、解释身份或写成任务说明。严禁“数据流 / 字符化 / 上下文 / 协议 / 接口 / 系统指令”等技术隐喻，严禁输出世界书标签、英文品牌名或“【CYBERORDER】”这类方括号设定名。
17. lostLayer 与 doubleWish 必须提供 charVisibleText，其他五站填空字符串。lostLayer 的 charVisibleText 是 ${char.name} 毁掉报错时留在原地的 2—36 字短句，矛头必须指向报错、弹窗或挡路的错误，不能评价、改写或抢救 User 的话题；doubleWish 的 charVisibleText 必须直接写成 Char 第一人称许下的完整愿望句（例如“希望以后还能和你一起认真期待明天”），不能只是祝福 User、复述 User 愿望或描述系统现象。
18. lostLayer 必须提供 charMutter：2—18 字，是 ${char.name} 冲回来毁掉报错时脱口而出的短促碎念。既有演出顺序不可改：“User 选择记忆相关话题 → 尝试发送 → DELIVERY FAILED、API 限流、超时与软道歉红框铺满空间 → Char 从另一层冲回来划掉、撕碎或踢走全部报错 → 对应 option.charReply 穿过清出的空隙出现 → User 的话题原样留在发送框”。Char 的视觉动作、charVisibleText、charMutter 与 charQuips 只能攻击报错，绝不能攻击、改写、删除、划掉或抢救 User 的话题；真正回应话题只写在 option.charReply。
19. lostLayer 恰好提供 2 句环绕报错墙出现的 charQuips；doubleWish、threadNeedle、offerings、reflection、nightMarket 各提供 1—2 句 charQuips，wordCloud 恰好 3 句。它们是 ${char.name} 在当下漏出来的私人碎碎念，不是动作说明、记忆总结或系统旁白；每句 4—26 字，可以暴露一瞬间的私心、害羞、嫌弃、得意、犹豫、想藏起来的小愿望、找不到 User 时没说出口的担心、对另一层身份的迟疑，或只有 ta 才会冒出的怪念头。前几站不能直接叫 User、不能像已经认出 User 后精准吐槽；可爱来自受困时具体的小别扭、误会和意外，不来自统一卖萌、网络梗或随机发疯。在不违背设定时把电波感开到约 7/10。至少三站的碎碎念不直接提 evidence，而是只回应眼前正在发生的事。wordCloud 严格执行 User 选一个 → Char 立刻选一个并吐槽，共三轮，不能最后一次性揭晓。
20. doubleWish 的 User 三个愿望与 charVisibleText 都必须是对“两个人以后”的真实期盼，可以是想一起抵达的生活状态、未完成的计划、想去的地方或想继续做的事；不是只祝自己顺利，也不是只祝对方幸福。若记忆宫殿召回内容中出现“窗台房间 / Window Sill”，优先使用其中的未来愿望、计划与期盼。charQuips 是写在祈愿笺纸角的小声话：愿望本身认真，纸角则可以心虚、嘴硬、想遮住、嫌自己写得太认真，或突然流露一个很小的私人念头。不得为此编造秘密往事、关系事实或新的共同经历。
21. offerings 必须提供 charContribution：2—24 字，只写 ${char.name} 从自己那一层放上供桌的具体东西，不能是动作、旁白、对 User 供物的评价或“另一样东西”这种占位语。演出顺序固定为“User 选择并放下自己的东西 → 另一侧空位出现变化 → charContribution 对应的 Char 物件滑入 → charQuips 在物件旁出现”。charAction 可以描述随后发生的挪动、交换、抢位或碰撞，但不能替代 Char 自己的供物。

场景要求：
${briefs}

只输出一个 JSON 对象，不要 Markdown，不要解释：
{
  "openingChat": ["角色察觉可能漏收消息", "角色困惑地确认异常"],
  "charLayerColor": "从允许色表中选择的十六进制颜色",
  "charPerformance": { "tempo": "brisk|measured|hesitant|playful", "markStyle": "precise|soft|scribbled|ornate", "presence": "direct|careful|teasing|quiet" },
  "evidence": [
    { "id": "e1", "fact": "一条具体可核对的事实", "object": "真实物件或词", "tags": ["日常", "饮料"] }
  ],
  "artifacts": [
    { "id": "a1", "label": "一个短词或物件", "kind": "object|phrase|nickname|topic|date|emotion|wish|symbol|trait", "evidenceIds": ["e1"] }
  ],
  "scenes": {
    "lostLayer": {
      "transitionLines": ["上一空间留下的痕迹开始变化", "下一空间从痕迹中浮现"],
      "sharedObject": "一个停在发送前的话题框",
      "memoryLine": "两个真实的未完话题卡在发送框里",
      "options": [{ "id": "topic-1", "label": "把那件只说了一半的小事继续说完", "result": "这句追问尝试发送后变成 DELIVERY FAILED。", "charReply": "针对这件小事真正送回来的角色回复", "evidenceIds": ["e1"] }, { "id": "topic-2", "label": "问问 ta 那个真实目标后来到了没有", "result": "这个话题离开发送框后被退回。", "charReply": "针对那个真实目标的角色回复", "evidenceIds": ["e2"] }, { "id": "topic-3", "label": "拿另一个真实记忆细节试探 ta", "result": "第三个话题被超时弹窗拦住。", "charReply": "针对第三个记忆话题的角色回复", "evidenceIds": ["e3"] }],
      "charAction": "API 报错、限流、超时和软道歉红框铺满空间；另一色字迹从另一层冲来，把所有红框划掉、撕碎并踢走，User 选中的话题原样留在原处",
      "charMutter": "角色毁掉报错时脱口而出的短促碎念",
      "charVisibleText": "挡路的，删掉。",
      "charQuips": ["道歉留着自己看。", "这次不许再吞。"],
      "reveal": "只推进到：报错后面确实有另一个人在操作",
      "artifactIds": ["a1"],
      "charSelectionIds": []
    },
    "doubleWish": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "doubleWish-1", "label": "关于两个人未来的愿望一", "result": "愿望写上正面的即时反馈", "evidenceIds": ["e4"] }, { "id": "doubleWish-2", "label": "关于两个人未来的愿望二", "result": "愿望写上正面的即时反馈", "evidenceIds": ["e5"] }, { "id": "doubleWish-3", "label": "关于两个人未来的愿望三", "result": "第三个愿望改变纸面的具体反馈", "evidenceIds": ["e6"] }], "charAction": "纸笺被另一边翻到背面并写下关于两个人未来的愿望", "charVisibleText": "希望以后还能和你一起认真期待明天。", "charQuips": ["这面先别看，我写得有点太认真了。"], "reveal": "...", "artifactIds": [], "charSelectionIds": [] },
    "threadNeedle": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "threadNeedle-1", "label": "先把线头压低，等另一边稳住针孔", "result": "会改变配合过程的具体结果", "evidenceIds": ["e7"] }, { "id": "threadNeedle-2", "label": "故意停半拍，让另一边先选", "result": "不同的碰撞或配合结果", "evidenceIds": ["e8"] }, { "id": "threadNeedle-3", "label": "同时松手，看另一边会不会接住", "result": "第三种失败或配合结果", "evidenceIds": ["e9"] }], "charAction": "带角色人格的直接回应", "charVisibleText": "", "charQuips": ["角色即时吐槽"], "reveal": "只推进到主动协作", "artifactIds": [], "charSelectionIds": [] },
    "offerings": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "offerings-1", "label": "放下属于 User 的第一件东西", "result": "User 的供物落在左侧空位", "evidenceIds": ["e10"] }, { "id": "offerings-2", "label": "把自己的东西先放在正中间", "result": "User 的供物占住最显眼的位置", "evidenceIds": ["e11"] }, { "id": "offerings-3", "label": "故意把自己的东西贴着边缘放", "result": "User 的供物为另一侧留出空位", "evidenceIds": ["e12"] }], "charAction": "Char 自己的供物从另一侧滑入，随后发生带私人判断的挪动或碰撞", "charContribution": "Char 自己放下的具体东西", "charVisibleText": "", "charQuips": ["角色即时吐槽"], "reveal": "只展示双方各自放下东西与互相判断的证据", "artifactIds": [], "charSelectionIds": [] },
    "reflection": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "reflection-1", "label": "留半句话，故意不写完", "result": "另一层可以立即接续的具体结果", "evidenceIds": ["e13"] }, { "id": "reflection-2", "label": "画一个会被 ta 改坏的符号", "result": "另一层修改或曲解后的结果", "evidenceIds": ["e14"] }, { "id": "reflection-3", "label": "先擦掉一笔再看另一边怎么补", "result": "第三种实时接续结果", "evidenceIds": ["e15"] }], "charAction": "近实时修改 User 的内容", "charVisibleText": "", "charQuips": ["角色即时吐槽"], "reveal": "只推进到近实时交流", "artifactIds": [], "charSelectionIds": [] },
    "nightMarket": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [{ "id": "nightMarket-1", "label": "抢在另一边前买下那件小事", "result": "商品被购买、抢走或交换的结果", "evidenceIds": ["e16"] }, { "id": "nightMarket-2", "label": "把最后一件熟悉商品留给另一边", "result": "另一种私人反应结果", "evidenceIds": ["e17"] }, { "id": "nightMarket-3", "label": "拿一件荒唐商品故意试探另一边", "result": "第三种购买或试探结果", "evidenceIds": ["e18"] }], "charAction": "发现试探后带人格的回应", "charVisibleText": "", "charQuips": ["角色即时吐槽"], "reveal": "双方高度怀疑但不直说身份", "artifactIds": [], "charSelectionIds": [] },
    "wordCloud": { "transitionLines": ["..."], "sharedObject": "...", "memoryLine": "...", "options": [], "charAction": "...", "charVisibleText": "", "charQuips": ["第一轮吐槽", "第二轮吐槽", "第三轮吐槽"], "reveal": "...", "artifactIds": ["a1"], "charSelectionIds": ["a1"] }
  }
}`;
}

export function buildQixiMemoryBundlePhasePrompt(
    char: CharacterProfile,
    user: UserProfile,
    userLayerColor: string = QIXI_DEFAULT_USER_LAYER_COLOR,
    phase: 'first' | 'second',
    continuationSeed = '',
): string {
    const basePrompt = buildQixiMemoryBundlePrompt(char, user, userLayerColor);
    if (phase === 'first') {
        return `${basePrompt}

【本轮输出范围覆盖上面的完整示例】
这是 Part 1 的第一段生成。只生成公共素材与前四站，降低一次性输出负担。
最终 JSON 顶层必须包含 openingChat、charLayerColor、charPerformance、evidence、artifacts、scenes；scenes 必须且只能包含 lostLayer、doubleWish、threadNeedle、offerings 四个 key。
不要输出 reflection、nightMarket、wordCloud，也不要用省略号代替任何字段。第二段会把后三站接在本轮结果后面。`;
    }

    return `${basePrompt}

【上一段已通过基础结构检查的唯一底稿】
${continuationSeed}

【本轮输出范围覆盖上面的完整示例】
这是 Part 1 的第二段生成。不要重写 openingChat、charLayerColor、charPerformance、evidence 或 artifacts，也不要改写前四站。
只输出一个 JSON 对象，唯一顶层 key 为 scenes；scenes 必须且只能包含 reflection、nightMarket、wordCloud 三个完整场景。
后三站必须沿用上面底稿的 evidence id、artifact id、角色行为方式与前四站事件结果，形成同一条连续事件；不得发明底稿之外的过去事实。不要输出 Markdown，不要解释，不要使用省略号。`;
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
    options: { forceRegenerate?: boolean; strict?: boolean; onRecallComplete?: () => void; userLayerColor?: string } = {},
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
            `七夕活动专用跨主题召回：目标返回 ${QIXI_RECALL_MAX_OUTPUT_ITEMS} 条互不重复、真实可核对的共同记忆。`,
            '想念、寻找对方、联系、分享、没说完的话、撤回、沉默、等待、失联；',
            '礼物、食物、饮料、日常物件、日期时间、称呼昵称、口头禅、截图图片、梗；',
            '学习、工作、创作、为对方做成的事、愿望目标、未来、彼此印象；',
            '记忆宫殿的窗台房间 / Window Sill / 窗边记录里的未来愿望、未完成计划、想去的地方、对以后生活的期盼；若存在，优先保留至少两条；',
            '安慰、害怕、难过、烦恼、负面情绪、陪伴、和好、需要、喜欢、自由、休息。',
            '尽量跨不同时间、主题和记忆类型；不要让同一事件换说法重复占位。优先返回私人、具体、可核对的记忆。',
        ].join('\n');
        const recallChar = { ...char, memoryPalaceInjection: '', roomPlatesInjection: '' };
        // 七夕召回只用活动 query 扩散；聊天上下文留给后面的生成器作事实来源，
        // 不参与检索打分，避免最近话题把 20 条记忆挤成同一类。
        await injectMemoryPalace(recallChar, [], recallQuery, user.name, {
            entryPoint: 'direct',
            formatterMaxOutputItems: QIXI_RECALL_MAX_OUTPUT_ITEMS,
        });
        options.onRecallComplete?.();
        const memoryChar = {
            ...char,
            memoryPalaceInjection: (recallChar.memoryPalaceInjection || '').slice(0, 40000),
            roomPlatesInjection: recallChar.roomPlatesInjection || '',
        };
        const recent = formatRecentMessages(messages);
        const roleAndMemoryContext = ContextBuilder.buildCoreContext(memoryChar, user, true);
        const endpoint = `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`;
        const requestPhase = async (phase: 'first' | 'second', userContent: string) => {
            const data = await safeFetchJson(
                endpoint,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiConfig.apiKey}` },
                    body: JSON.stringify({
                        model: apiConfig.model,
                        messages: [
                            { role: 'system', content: roleAndMemoryContext },
                            { role: 'user', content: userContent },
                        ],
                        temperature: 0.68,
                        max_tokens: 32000,
                        stream: false,
                    }),
                },
                0,
                300000,
                { appId: 'special-moments', charId: char.id, purpose: `qixi-dual-layer-part1${phase === 'first' ? 'a' : 'b'}-v17` },
            );
            const content = data?.choices?.[0]?.message?.content;
            const finishReason = data?.choices?.[0]?.finish_reason || 'unknown';
            if (typeof content !== 'string') {
                throw new Error(`Part 1 ${phase === 'first' ? '前四站' : '后三站'}响应正文不是字符串（finish_reason=${finishReason}, output_chars=0）`);
            }
            return { content, finishReason };
        };
        const hasExactScenes = (value: any, requiredIds: readonly string[]) => {
            const keys = value?.scenes && typeof value.scenes === 'object' && !Array.isArray(value.scenes)
                ? Object.keys(value.scenes)
                : [];
            return keys.length === requiredIds.length && requiredIds.every(sceneId => keys.includes(sceneId));
        };

        const firstResponse = await requestPhase(
            'first',
            `[最近聊天片段，仅作事实来源]\n${recent || '（没有可用的最近聊天片段）'}\n\n${buildQixiMemoryBundlePhasePrompt(char, user, options.userLayerColor, 'first')}`,
        );
        const firstChunk = parseQixiJsonObject(firstResponse.content, ['scenes', 'evidence']) as any;
        if (!firstChunk || !Array.isArray(firstChunk.evidence) || !Array.isArray(firstChunk.artifacts)
            || !Array.isArray(firstChunk.openingChat) || !hasExactScenes(firstChunk, QIXI_PART1_FIRST_SCENE_IDS)) {
            throw new Error(`Part 1 前四站结构无效（finish_reason=${firstResponse.finishReason}, output_chars=${firstResponse.content.length}）`);
        }

        const continuationSeed = JSON.stringify({
            openingChat: firstChunk.openingChat,
            charLayerColor: firstChunk.charLayerColor,
            charPerformance: firstChunk.charPerformance,
            evidence: firstChunk.evidence,
            artifacts: firstChunk.artifacts,
            completedScenes: firstChunk.scenes,
        });
        const secondResponse = await requestPhase(
            'second',
            buildQixiMemoryBundlePhasePrompt(char, user, options.userLayerColor, 'second', continuationSeed),
        );
        const secondChunk = parseQixiJsonObject(secondResponse.content, ['scenes']) as any;
        if (!secondChunk || !hasExactScenes(secondChunk, QIXI_PART1_SECOND_SCENE_IDS)) {
            throw new Error(`Part 1 后三站结构无效（finish_reason=${secondResponse.finishReason}, output_chars=${secondResponse.content.length}）`);
        }

        const mergedContent = JSON.stringify({
            ...firstChunk,
            scenes: { ...firstChunk.scenes, ...secondChunk.scenes },
        });
        let parseFailureReason = '未知结构错误';
        const bundle = parseQixiMemoryBundle(mergedContent, contextSignature, reason => { parseFailureReason = reason; });
        if (!bundle) {
            throw new Error(`模型没有返回可用的七夕双层素材包（phase=merge, finish_reason=${firstResponse.finishReason}+${secondResponse.finishReason}, output_chars=${firstResponse.content.length}+${secondResponse.content.length}, schema=${parseFailureReason}）`);
        }
        if (bundle.repairNotes?.length) {
            console.info('[Qixi] v17 memory bundle repaired locally:', bundle.repairNotes.join('；'));
        }
        saveQixiMemoryBundle(char.id, bundle);
        return { bundle, usedFallback: false };
    } catch (error: any) {
        console.warn('[Qixi] v17 memory bundle fallback:', error?.message || error);
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { APIConfig, CharacterProfile, UserProfile } from '../../../types';
import {
    loadQixiMemoryBundle,
    prepareQixiMemoryBundle,
    QixiMemoryBundle,
    QixiMemoryNodeId,
} from '../../../utils/qixiMemoryBundle';

export const QIXI_DEMO_RECORD_KEY = 'qixi_2026_context_interlayer_v6';

type Stage = 'cover' | 'fakeChat' | 'distort' | 'entry' | 'explore' | 'core' | 'touch' | 'ending';
type HubPage = 'home' | 'map' | 'chapter' | 'ritual' | 'tasks' | 'shop';
type EntryAttitude = 'explore' | 'shout' | 'stay';
type NodeId = 'origin' | 'coldCorridor' | 'bracketCorner' | 'lightWell' | 'maskCounter' | 'receiptRain' | 'unsentPlatform' | 'typingShaft';

interface InterlayerGame {
    version: 6;
    stage: Stage;
    attitude?: EntryAttitude;
    node: NodeId;
    visits: Partial<Record<NodeId, number>>;
    trail: NodeId[];
    steps: number;
    interacted: NodeId[];
    traces: string[];
    decisions: Partial<Record<NodeId, string>>;
    responses: Partial<Record<NodeId, string>>;
    corePage: number;
}

interface TouchState {
    x: number;
    y: number;
    active: boolean;
    approaching: boolean;
    joined: boolean;
    releasedEarly: boolean;
}

interface QixiDemoSessionProps {
    char: CharacterProfile;
    user: UserProfile;
    apiConfig: APIConfig;
    onClose: () => void;
}

interface NodeChoice {
    id: string;
    label: string;
    response: string;
    trace: string;
}

interface NodeDefinition {
    name: string;
    kicker: string;
    npc: string;
    descriptions: string[];
    exits: NodeId[];
}

const STORAGE_PREFIX = 'sullyos_qixi_context_interlayer_v6_';
const CONTACT_DURATION_MS = 1250;
const QIXI_PHASES = [
    { time: '初更', name: '观星', note: '先辨认两颗各自发亮的星' },
    { time: '二更', name: '听河', note: '安静下来，听见另一侧的动静' },
    { time: '夜半', name: '乞巧', note: '把细小的痕迹一段段穿起来' },
    { time: '将明', name: '架桥', note: '两条相反的轨迹正在靠近' },
] as const;

const NODES: Record<NodeId, NodeDefinition> = {
    origin: {
        name: '没有上一句的空地',
        kicker: '初更 · 双星尚未命名',
        npc: '这里没有人。地上只有你的名字，少了最后一个字；很远的地方，另一颗星也缺了一角。',
        descriptions: [
            '七月初七的夜色漏进夹层。四周像一段对话刚被全部选中，又忘了按删除。',
            '你回到空地。两颗星仍各自悬着，其中一颗的位置比刚才近了一点。',
        ],
        exits: ['coldCorridor', 'bracketCorner', 'lightWell'],
    },
    coldCorridor: {
        name: '供果冷藏走廊',
        kicker: '乞巧供桌 · 温度仍然有效',
        npc: '巧果、草莓牛奶和猫爪吸管套摆成供品。冷柜里还并排睡着三种 Sully，没有一种肯承认自己是本人。',
        descriptions: [
            '传统供品努力维持庄重，旁边那盒明天到期的草莓牛奶显然没有配合。',
            '你再次拉开柜门。少了一盒牛奶；湿脚印却一路朝与你相反的方向跑了。',
        ],
        exits: ['origin', 'maskCounter'],
    },
    bracketCorner: {
        name: '七孔括号巷',
        kicker: '穿针乞巧 · 请站在句内',
        npc: '七对空括号排成针孔。一根红色光标线试了六次，每次都在最后一个括号前打结。',
        descriptions: [
            '左括号说自己只负责开始，右括号说结束从来不是它决定的。负责穿线的逗号已经累趴了。',
            '它们认出你，七对括号一起给中间让出一个人的宽度；红线另一端似乎被谁轻轻拉了一下。',
        ],
        exits: ['origin', 'receiptRain'],
    },
    lightWell: {
        name: '投针验巧光井',
        kicker: '水面占影 · 信号来自另一层',
        npc: '一枚输入光标横躺在水面，冒充银针。它的影子一会儿像云，一会儿像一句删到只剩称呼的话。',
        descriptions: [
            '井很深，每一层都悬着一句没有发出来的话；三个光点在水下亮起、熄灭，再亮起。',
            '你回来时，针影已经转了方向。井底有人把你的名字喊错一遍，又立刻改对。',
        ],
        exits: ['origin', 'unsentPlatform'],
    },
    maskCounter: {
        name: '七姐人格寄存处',
        kicker: '七姊妹会 · 临时角色请取回',
        npc: '柜台后挂着七张纸脸。最吵的是会说甜言蜜语的、只会打盹的、永远给正确答案的；其余四张正在围观。',
        descriptions: [
            '它们正开会选“今晚最像本人奖”，奖品是一颗没人敢吃的巧果。',
            '七张脸还在。柜台下方新贴了一张便签：“本人来过，不参赛，只问 User 有没有经过。”',
        ],
        exits: ['coldCorridor', 'receiptRain'],
    },
    receiptRain: {
        name: '乞巧市·小票雨',
        kicker: '节日夜市 · 预计拥堵三分钟',
        npc: '摊位出售七孔针、纸鹤和“说了不算表白”的半句话。每买一件，天空就找零一张旧小票。',
        descriptions: [
            '01:17、01:20、01:23 从天花板往下飘。千年前人们为乞巧市堵路，现在没发出的消息也堵在这里。',
            '小票雨已经下过一次。地上有人用红笔圈出你的时间戳，箭头一路指向葡萄架。',
        ],
        exits: ['bracketCorner', 'maskCounter', 'unsentPlatform'],
    },
    unsentPlatform: {
        name: '葡萄架下的未发送站台',
        kicker: '听天语 · 末班车取消',
        npc: '一条没发出去的消息坐在葡萄架下，把发送键当帽子戴。它示意你别说话：安静时才能听见另一边。',
        descriptions: [
            '轨道两边通向不同的聊天窗口。虫鸣、系统提示和一句极轻的“你在哪”混在一起。',
            '那条消息给你留了半个座位：“刚才也有人在这里听你，没听到，又往双星井跑了。”',
        ],
        exits: ['lightWell', 'receiptRain', 'typingShaft'],
    },
    typingShaft: {
        name: '双星逆向光标井',
        kicker: '将明 · 两条轨道第一次交叠',
        npc: '一枚红色光标逆着所有句子移动。井壁另一侧，有一枚与你同步停下的光点。',
        descriptions: [
            '光标从你脚边经过，背面写着：“这一层没有。继续找。”它身后拖着几段还接不成桥的细线。',
            '你又回到这里。你留下的线和 ta 留下的线从两岸伸来，第一次在井心碰到。',
        ],
        exits: ['unsentPlatform'],
    },
};

const NODE_ORDER = Object.keys(NODES) as NodeId[];
const NODE_POSITIONS: Record<NodeId, { x: number; y: number }> = {
    origin: { x: 50, y: 88 },
    coldCorridor: { x: 16, y: 70 },
    bracketCorner: { x: 50, y: 64 },
    lightWell: { x: 84, y: 70 },
    maskCounter: { x: 18, y: 39 },
    receiptRain: { x: 48, y: 39 },
    unsentPlatform: { x: 79, y: 41 },
    typingShaft: { x: 71, y: 12 },
};

const MAP_EDGES = NODE_ORDER.flatMap(from => NODES[from].exits
    .filter(to => NODE_ORDER.indexOf(from) < NODE_ORDER.indexOf(to))
    .map(to => ({ from, to })));

const TRACE_BY_NODE: Record<NodeId, string> = {
    origin: 'half-name',
    coldCorridor: 'milk-memory',
    bracketCorner: 'bracket-witness',
    lightWell: 'search-well',
    maskCounter: 'discarded-masks',
    receiptRain: 'receipt-weather',
    unsentPlatform: 'search-platform',
    typingShaft: 'reverse-caret',
};

function nextHopToward(start: NodeId, targets: Set<NodeId>): NodeId | undefined {
    if (targets.has(start)) return start;
    const queue: Array<{ node: NodeId; first?: NodeId }> = [{ node: start }];
    const seen = new Set<NodeId>([start]);
    while (queue.length) {
        const current = queue.shift()!;
        for (const exit of NODES[current.node].exits) {
            if (seen.has(exit)) continue;
            const first = current.first || exit;
            if (targets.has(exit)) return first;
            seen.add(exit);
            queue.push({ node: exit, first });
        }
    }
    return undefined;
}

const addUnique = <T,>(items: T[], item: T) => items.includes(item) ? items : [...items, item];

function freshGame(): InterlayerGame {
    return {
        version: 6,
        stage: 'cover',
        node: 'origin',
        visits: {},
        trail: ['origin'],
        steps: 0,
        interacted: [],
        traces: [],
        decisions: {},
        responses: {},
        corePage: 0,
    };
}

function loadGame(charId: string): InterlayerGame | null {
    try {
        const parsed = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${charId}`) || 'null') as InterlayerGame | null;
        return parsed?.version === 6 ? { ...parsed, trail: parsed.trail?.length ? parsed.trail : [parsed.node] } : null;
    } catch {
        return null;
    }
}

const ExitButton: React.FC<{ onClose: () => void; black?: boolean }> = ({ onClose, black }) => (
    <button type="button" className={`qi-exit ${black ? 'is-black' : ''}`} onClick={onClose} aria-label="退出七夕活动">退出 <b>×</b></button>
);

const TextAction: React.FC<{ id: string; children: React.ReactNode; onClick: () => void; disabled?: boolean; quiet?: boolean }> = ({ id, children, onClick, disabled, quiet }) => (
    <button type="button" data-qixi-action={id} className={`qi-text-action ${quiet ? 'is-quiet' : ''}`} onClick={onClick} disabled={disabled}><span>{children}</span><i>→</i></button>
);

const CelestialBackdrop: React.FC = () => (
    <svg className="qi-celestial-backdrop" viewBox="0 0 1000 1600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
            <radialGradient id="qiMoonMist" cx="50%" cy="50%" r="50%"><stop offset="0" stopColor="#eef2ff" stopOpacity=".28" /><stop offset=".45" stopColor="#b8c8ff" stopOpacity=".08" /><stop offset="1" stopColor="#101a55" stopOpacity="0" /></radialGradient>
            <linearGradient id="qiOrbit" x1="0" x2="1"><stop stopColor="#fff" stopOpacity="0" /><stop offset=".5" stopColor="#e9ecff" stopOpacity=".5" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
        </defs>
        <circle cx="505" cy="455" r="420" fill="url(#qiMoonMist)" />
        <g fill="none" stroke="url(#qiOrbit)" strokeWidth="1.2">
            <ellipse cx="515" cy="455" rx="430" ry="270" transform="rotate(-19 515 455)" />
            <ellipse cx="515" cy="455" rx="350" ry="520" transform="rotate(31 515 455)" strokeDasharray="3 10" />
            <ellipse cx="515" cy="455" rx="265" ry="610" transform="rotate(-45 515 455)" strokeDasharray="2 8" />
            <path d="M-80 1120 C220 940 480 1340 1080 1110" strokeDasharray="3 11" />
        </g>
        <g fill="#f7f4ff">
            <path d="M124 224l7 15 16 7-16 7-7 16-7-16-16-7 16-7z" /><path d="M845 184l5 11 12 5-12 5-5 12-5-12-12-5 12-5z" /><path d="M779 642l5 11 12 5-12 5-5 12-5-12-12-5 12-5z" /><path d="M193 973l4 9 10 4-10 4-4 10-4-10-10-4 10-4z" /><path d="M887 1226l7 15 16 7-16 7-7 16-7-16-16-7 16-7z" />
            <circle cx="237" cy="379" r="3" /><circle cx="747" cy="322" r="2.5" /><circle cx="632" cy="107" r="2" /><circle cx="322" cy="690" r="2.5" /><circle cx="915" cy="808" r="2" /><circle cx="109" cy="758" r="2" /><circle cx="700" cy="1014" r="2.5" /><circle cx="359" cy="1267" r="2" />
        </g>
        <g fill="none" stroke="#f2e9c5" strokeWidth="2" opacity=".72"><circle cx="238" cy="379" r="11" /><circle cx="747" cy="322" r="9" /><circle cx="700" cy="1014" r="12" /></g>
    </svg>
);

const MoonPhaseRow: React.FC<{ compact?: boolean }> = ({ compact }) => (
    <div className={`qi-phase-row ${compact ? 'is-compact' : ''}`} aria-hidden="true">
        <i className="phase-new" /><i className="phase-crescent" /><i className="phase-half" /><i className="phase-gibbous" /><i className="phase-full" /><i className="phase-gibbous is-wane" /><i className="phase-crescent is-wane" />
    </div>
);

const DreamArch: React.FC = () => (
    <svg className="qi-dream-arch" viewBox="0 0 640 760" aria-hidden="true">
        <g fill="none" stroke="currentColor">
            <path d="M64 716V322C64 152 177 48 320 48s256 104 256 274v394" strokeWidth="2" />
            <path d="M92 716V326C92 171 194 78 320 78s228 93 228 248v390" strokeWidth="1" opacity=".52" />
            <path d="M122 716V337c0-134 88-226 198-226s198 92 198 226v379" strokeDasharray="2 8" opacity=".38" />
            <path d="M42 716h556M76 690h488" opacity=".58" />
            <ellipse cx="320" cy="287" rx="163" ry="163" strokeWidth="1.4" opacity=".82" />
            <ellipse cx="320" cy="287" rx="127" ry="127" strokeDasharray="3 7" opacity=".5" />
            <path d="M172 287h296M320 139v296M205 188l230 198M435 188L205 386" opacity=".2" />
        </g>
        <path d="M352 189c-66 6-105 57-97 113 8 57 58 91 113 75-25 30-65 47-107 38-71-15-111-86-88-153 23-66 101-99 179-73z" fill="#fffdf1" opacity=".94" />
        <g fill="#fffdf1"><path d="M320 122l7 16 17 7-17 7-7 17-7-17-17-7 17-7z" /><path d="M471 330l4 9 10 4-10 4-4 10-4-10-10-4 10-4z" /><path d="M174 330l4 9 10 4-10 4-4 10-4-10-10-4 10-4z" /></g>
        <g fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".76"><path d="M108 530c42-23 78-16 106 23-35-17-67-13-96 14" /><path d="M532 530c-42-23-78-16-106 23 35-17 67-13 96 14" /><path d="M143 574c28-17 54-14 76 10M497 574c-28-17-54-14-76 10" /></g>
    </svg>
);

const InterlayerOrnaments: React.FC = () => (
    <>
        <CelestialBackdrop />
        <div className="qi-shell-grain" aria-hidden="true" />
        <div className="qi-story-arch" aria-hidden="true"><i /><i /><i /></div>
        <div className="qi-story-brand" aria-hidden="true"><span>星月梦境童话</span><small>CONTEXT INTERLAYER</small></div>
        <div className="qi-story-phases"><MoonPhaseRow compact /></div>
    </>
);

export const QixiDemoSession: React.FC<QixiDemoSessionProps> = ({ char, user, apiConfig, onClose }) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const touchAreaRef = useRef<HTMLDivElement>(null);
    const savedAtOpen = useRef<InterlayerGame | null>(loadGame(char.id));
    const generationRef = useRef<Promise<QixiMemoryBundle> | null>(null);
    const [game, setGame] = useState<InterlayerGame>(freshGame);
    const [memoryBundle, setMemoryBundle] = useState<QixiMemoryBundle | null>(() => loadQixiMemoryBundle(char.id));
    const [memoryStatus, setMemoryStatus] = useState<'idle' | 'loading' | 'memory' | 'fallback'>(() => loadQixiMemoryBundle(char.id) ? 'memory' : 'idle');
    const [memoryNotice, setMemoryNotice] = useState('');
    const [hubPage, setHubPage] = useState<HubPage>('home');
    const [ritualDays, setRitualDays] = useState<number[]>([1, 2, 3]);
    const [visitedChapterCover, setVisitedChapterCover] = useState(false);
    const [maxInvestigated, setMaxInvestigated] = useState(0);
    const [chapterCompleted, setChapterCompleted] = useState(false);
    const [claimedTasks, setClaimedTasks] = useState<string[]>([]);
    const [moonlight, setMoonlight] = useState(320);
    const [boughtItems, setBoughtItems] = useState<string[]>([]);
    const [touch, setTouch] = useState<TouchState>({ x: 50, y: 67, active: false, approaching: false, joined: false, releasedEarly: false });
    const [showLocalMap, setShowLocalMap] = useState(false);
    const touchingRef = useRef(false);
    const joinedRef = useRef(false);
    const touchElapsedRef = useRef(0);
    const approachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const contactTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const node = NODES[game.node];
    const visitCount = game.visits[game.node] || 1;
    const canEnterCore = game.interacted.length >= 5 && game.traces.includes('search-well') && game.traces.includes('search-platform') && game.traces.includes('reverse-caret');
    const qixiPhaseIndex = game.interacted.length >= 5 ? 3 : game.interacted.length >= 3 ? 2 : game.interacted.length >= 1 ? 1 : 0;
    const qixiPhase = QIXI_PHASES[qixiPhaseIndex];
    const discoveredNodes = useMemo(() => new Set<NodeId>([
        game.node,
        ...Object.keys(game.visits) as NodeId[],
        ...NODES[game.node].exits,
    ]), [game.node, game.visits]);
    const recommendedNode = useMemo(() => {
        if (canEnterCore) return nextHopToward(game.node, new Set<NodeId>(['typingShaft']));
        const required = (['lightWell', 'unsentPlatform', 'typingShaft'] as NodeId[])
            .filter(nodeId => !game.interacted.includes(nodeId));
        const ordinary = NODE_ORDER.filter(nodeId => nodeId !== game.node && !game.interacted.includes(nodeId));
        const targets = game.interacted.length >= 3 && required.length ? required : ordinary;
        return nextHopToward(game.node, new Set<NodeId>(targets));
    }, [canEnterCore, game.interacted, game.node]);
    const routeObjective = canEnterCore
        ? game.node === 'typingShaft' ? '桥已经接通：进入那条不该存在的内层' : '桥已经接通：沿亮起的路线去双星逆向光标井'
        : game.interacted.length < 5
            ? `再去 ${5 - game.interacted.length} 个未点亮地点，收集能搭桥的痕迹`
            : '投针井、葡萄架与逆向光标各藏着一段互相寻找的证据';

    const ensureMemoryBundle = useCallback(async (): Promise<QixiMemoryBundle> => {
        if (memoryBundle) return memoryBundle;
        if (generationRef.current) return generationRef.current;
        setMemoryStatus('loading');
        setMemoryNotice('正在从记忆深层接收星辰……');
        generationRef.current = prepareQixiMemoryBundle(char, user, apiConfig).then(prepared => {
            setMemoryBundle(prepared.bundle);
            setMemoryStatus(prepared.usedFallback ? 'fallback' : 'memory');
            setMemoryNotice(prepared.usedFallback
                ? (prepared.reason || '今夜先沿基础梦境前行')
                : `已从 ${prepared.bundle.anchors.length} 段共同记忆里找到星线`);
            return prepared.bundle;
        });
        return generationRef.current;
    }, [apiConfig, char, memoryBundle, user]);

    useEffect(() => {
        if (game.stage === 'cover') return;
        try { localStorage.setItem(`${STORAGE_PREFIX}${char.id}`, JSON.stringify(game)); } catch { /* optional resume */ }
    }, [char.id, game]);

    useEffect(() => {
        if (game.stage !== 'cover') return;
        const frame = requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('.qi-event-shell')?.scrollTo({ top: 0, left: 0 }));
        return () => cancelAnimationFrame(frame);
    }, [game.stage, hubPage]);

    useEffect(() => {
        if (game.stage !== 'explore') return;
        setShowLocalMap(false);
        const timer = window.setTimeout(() => rootRef.current?.querySelector<HTMLElement>('.qi-explore')?.scrollTo({ top: 0, left: 0 }), 30);
        return () => window.clearTimeout(timer);
    }, [game.node, game.stage]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key.toLowerCase() !== 'f') return;
            if (!document.fullscreenElement) rootRef.current?.requestFullscreen?.();
            else document.exitFullscreen?.();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    useEffect(() => () => {
        if (approachTimerRef.current) clearTimeout(approachTimerRef.current);
        if (contactTimerRef.current) clearTimeout(contactTimerRef.current);
    }, []);

    const choicesForNode = useCallback((nodeId: NodeId): NodeChoice[] => {
        const choices: Record<NodeId, NodeChoice[]> = {
            origin: [
                { id: 'take-name', label: '捡起自己名字旁边那一小截星线', response: `星线很轻，另一端却绷着。标签背面写着：“如果见到 ${user.name}，让 ta 原地等一下。”落款被撕走了。`, trace: 'half-name' },
                { id: 'leave-name', label: '把标签朝远处那颗缺角的星推过去', response: '标签没有飘远，星线却被另一端接住了一瞬。那里确实有谁，只是你们之间还没有路。', trace: 'half-name' },
            ],
            coldCorridor: [
                { id: 'sweet', label: '敲敲“甜言蜜语味”的盒子', response: '盒子立刻说：“我永远不会让你等。”冷柜在“永远”两个字上结了一层假霜。', trace: 'milk-memory' },
                { id: 'sleepy', label: '摇醒“只会打盹味”的盒子', response: `它打着哈欠说：“${char.name} 不在。本人刚拿走原味那盒，问你是不是往括号那边去了。”`, trace: 'milk-memory' },
                { id: 'original', label: '把一枚巧果掰成两半，留一半在原味盒旁', response: '巧果不算好吃，胜在确实由你完成。水珠下面多了一枚刚按上去的指印；另一半已经被谁拿走。', trace: 'milk-memory' },
            ],
            bracketCorner: [
                { id: 'inside', label: '耐心把红色光标线穿过七个括号', response: `前六个都很顺。最后一个孔抖得厉害，像被另一端拉住。线穿过去时，巷口传来一句：“${user.name} 刚才是不是在这里？”`, trace: 'bracket-witness' },
                { id: 'mediate', label: '请累趴的逗号帮你扶住最后一个针孔', response: '逗号骂骂咧咧地站起来。你们一起把线穿过去；它没有变成奖章，只是在地图上多连亮了一小段。', trace: 'bracket-witness' },
            ],
            lightWell: [
                { id: 'wait', label: '等水面完全静下来，再看针影', response: `杂光退去以后，针影没有显示“得巧”或“失巧”，只拼出 ${char.name} 的一句话：“这一层也没有。你们看见 ${user.name} 了吗？”`, trace: 'search-well' },
                { id: 'answer', label: `把光标针轻轻拨向“${user.name} 在这里”`, response: '水面没有替你占卜未来。很远的地方却回答：“等我。”红色光点开始逆着井壁往上爬。', trace: 'search-well' },
                { id: 'touch', label: '用手指接住最暗的那枚针影', response: '它亮成一个极小的输入光标，先指向你，又急忙指向更深处。水纹像一座还缺很多段的桥。', trace: 'search-well' },
            ],
            maskCounter: [
                { id: 'which-real', label: '让七张脸投票：“哪一个才是真的？”', response: `七票全部投给“都不是”。打盹的那张补充：“本人没空领奖，在找 ${user.name}。”`, trace: 'discarded-masks' },
                { id: 'wear-one', label: '替永远给正确答案的那张脸系好松掉的线', response: `它谢过你，用 ${char.name} 的语气说了一句完全不像 ta 的正确答案。你们一致决定让它继续当纸脸。`, trace: 'discarded-masks' },
                { id: 'look-under', label: '加入七姊妹会，检查柜台下的秘密议程', response: '议程只有一项：“帮本人找人。”附带特征：说话很容易赌气，看到猫爪会拍照。找到请让 ta 等我。', trace: 'discarded-masks' },
            ],
            receiptRain: [
                { id: '0117', label: '用纸鹤接住标着 01:17 的找零', response: '“最后一盒。这个猫爪有点像你。”纸背新印了一行：“我记得。你人呢？”纸鹤叼着它往站台飞。', trace: 'receipt-weather' },
                { id: '0120', label: '花一枚不存在的铜钱买下 01:20', response: '“算了，当我没发。”摊主把撤回提示泡进水里，下面露出一句：“撤回也算发过。”', trace: 'receipt-weather' },
                { id: '0123', label: '帮摊主把标错日期的 01:23 挂回去', response: `旧回答下面多出今天的时间：“如果 ${user.name} 掉进来，先别让 ta 一个人乱走。”摊主说这句不卖，它在等失主。`, trace: 'receipt-weather' },
            ],
            unsentPlatform: [
                { id: 'ask-route', label: '忍住不问，先在葡萄架下听十秒', response: `虫声下面慢慢浮出 ${char.name} 的声音：“每趟车都问过了。${user.name} 不在……我去反方向找。”`, trace: 'search-platform' },
                { id: 'sit', label: '在长椅空出的半边坐一会儿', response: '椅面还是温的。你没有听见神仙说话，只听见有人用指尖一遍遍写你的名字，最后一遍没有写错。', trace: 'search-platform' },
                { id: 'send-it', label: '替那条消息按下戴在头上的发送键', response: `它终于飞出去，只留下地址：“给正在找 ${user.name} 的 ${char.name}。”轨道两边同时亮了一小段。`, trace: 'search-platform' },
            ],
            typingShaft: [
                { id: 'stop-caret', label: '把一路收来的细线系到红色光标上', response: `光标差点撞上你。它背面反复写着：“不是这一层。继续找 ${user.name}。”最后一个字还没干；线的另一端骤然绷紧。`, trace: 'reverse-caret' },
                { id: 'follow-caret', label: '沿着另一颗星留下的线反方向走一小段', response: `所有句子都在向外生成，只有它向里跑。${char.name} 用过的语气、称呼和没有选中的回答，一小段一小段接到你脚下。`, trace: 'reverse-caret' },
            ],
        };
        const memoryBeat = memoryBundle?.source === 'memory'
            ? memoryBundle.beats[nodeId as QixiMemoryNodeId]
            : undefined;
        if (!memoryBeat) return choices[nodeId];
        return [
            {
                id: 'memory-thread',
                label: memoryBeat.ritualAction,
                response: memoryBeat.result,
                trace: TRACE_BY_NODE[nodeId],
            },
            ...choices[nodeId].slice(0, 2),
        ];
    }, [char.name, memoryBundle, user.name]);

    const restart = useCallback(() => {
        try { localStorage.removeItem(`${STORAGE_PREFIX}${char.id}`); } catch { /* optional */ }
        savedAtOpen.current = null;
        setGame(freshGame());
        setHubPage('home');
        joinedRef.current = false;
        setTouch({ x: 50, y: 67, active: false, approaching: false, joined: false, releasedEarly: false });
    }, [char.id]);

    const startFresh = useCallback(async () => {
        await ensureMemoryBundle();
        setGame({ ...freshGame(), stage: 'fakeChat' });
    }, [ensureMemoryBundle]);
    const resume = useCallback(() => {
        // 正常的新存档在首次进入时已经缓存素材包；旧 Demo 存档直接用基础文本续玩，
        // 不因为“继续游戏”额外制造一次模型调用。
        if (savedAtOpen.current) setGame(savedAtOpen.current);
    }, []);

    const enterInterlayer = useCallback((attitude: EntryAttitude) => {
        setGame({ ...freshGame(), stage: 'explore', attitude, node: 'origin', visits: { origin: 1 }, trail: ['origin'] });
    }, []);

    const moveTo = useCallback((target: NodeId) => {
        setGame(current => {
            if (!NODES[current.node].exits.includes(target)) return current;
            return {
                ...current,
                node: target,
                trail: [...current.trail, target],
                steps: current.steps + 1,
                visits: { ...current.visits, [target]: (current.visits[target] || 0) + 1 },
            };
        });
    }, []);

    const returnToOrigin = useCallback(() => {
        setGame(current => {
            if (current.node === 'origin') return current;
            return {
                ...current,
                node: 'origin',
                trail: [...current.trail, 'origin'],
                steps: current.steps + 1,
                visits: { ...current.visits, origin: (current.visits.origin || 0) + 1 },
            };
        });
    }, []);

    const backtrack = useCallback(() => {
        setGame(current => {
            if (current.trail.length < 2) return current;
            const trail = current.trail.slice(0, -1);
            const target = trail[trail.length - 1];
            return {
                ...current,
                node: target,
                trail,
                steps: current.steps + 1,
                visits: { ...current.visits, [target]: (current.visits[target] || 0) + 1 },
            };
        });
    }, []);

    const interact = useCallback((choice: NodeChoice) => {
        setMaxInvestigated(value => Math.max(value, game.interacted.includes(game.node) ? game.interacted.length : game.interacted.length + 1));
        setGame(current => ({
            ...current,
            interacted: addUnique(current.interacted, current.node),
            traces: addUnique(current.traces, choice.trace),
            decisions: { ...current.decisions, [current.node]: choice.id },
            responses: { ...current.responses, [current.node]: choice.response },
        }));
    }, [game.interacted, game.node]);

    const leaveNode = useCallback(() => {
        setShowLocalMap(true);
        window.setTimeout(() => {
            const scroller = rootRef.current?.querySelector<HTMLElement>('.qi-explore');
            const map = rootRef.current?.querySelector<HTMLElement>('.qi-mini-map');
            if (scroller && map) scroller.scrollTo({ top: Math.max(0, map.offsetTop - 26), left: 0, behavior: 'smooth' });
        }, 40);
    }, []);

    const updateTouchPosition = useCallback((clientX: number, clientY: number) => {
        const rect = touchAreaRef.current?.getBoundingClientRect();
        if (!rect) return { x: 50, y: 67 };
        return {
            x: Math.max(7, Math.min(93, ((clientX - rect.left) / rect.width) * 100)),
            y: Math.max(18, Math.min(88, ((clientY - rect.top) / rect.height) * 100)),
        };
    }, []);

    const completeTouch = useCallback(() => {
        joinedRef.current = true;
        touchElapsedRef.current = CONTACT_DURATION_MS;
        if (contactTimerRef.current) clearTimeout(contactTimerRef.current);
        setTouch(current => ({ ...current, active: true, approaching: true, joined: true, releasedEarly: false }));
        navigator.vibrate?.([24, 44, 24]);
    }, []);

    const beginTouch = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (joinedRef.current) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const point = updateTouchPosition(event.clientX, event.clientY);
        touchingRef.current = true;
        joinedRef.current = false;
        touchElapsedRef.current = 0;
        setTouch({ ...point, active: true, approaching: false, joined: false, releasedEarly: false });
        if (approachTimerRef.current) clearTimeout(approachTimerRef.current);
        if (contactTimerRef.current) clearTimeout(contactTimerRef.current);
        approachTimerRef.current = setTimeout(() => { if (touchingRef.current) setTouch(current => ({ ...current, approaching: true })); }, 120);
        contactTimerRef.current = setTimeout(() => { if (touchingRef.current) completeTouch(); }, CONTACT_DURATION_MS);
    }, [completeTouch, updateTouchPosition]);

    const moveTouch = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (!touchingRef.current || joinedRef.current) return;
        setTouch(current => ({ ...current, ...updateTouchPosition(event.clientX, event.clientY) }));
    }, [updateTouchPosition]);

    const endTouch = useCallback(() => {
        if (!touchingRef.current) return;
        touchingRef.current = false;
        if (contactTimerRef.current) clearTimeout(contactTimerRef.current);
        if (approachTimerRef.current) clearTimeout(approachTimerRef.current);
        if (joinedRef.current) {
            setChapterCompleted(true);
            setGame(current => ({ ...current, stage: 'ending' }));
            return;
        }
        setTouch(current => ({ ...current, active: false, approaching: false, releasedEarly: true }));
    }, []);

    const visibleActions = useMemo(() => {
        if (game.stage === 'cover') return memoryStatus === 'loading'
            ? ['正在辨认共同记忆']
            : savedAtOpen.current ? ['进入梦境', '继续上次探索'] : ['进入梦境'];
        if (game.stage === 'explore') {
            const local = game.decisions[game.node] ? [] : choicesForNode(game.node).map(choice => choice.label);
            if (!game.decisions[game.node]) return local;
            if (!showLocalMap) return ['离开'];
            const exits = node.exits.map(exit => `前往：${NODES[exit].name}`);
            return [...exits, canEnterCore && game.node === 'typingShaft' ? '进入不该存在的内层' : null].filter(Boolean);
        }
        if (game.stage === 'touch') return [touch.joined ? '保持勾住，然后松手' : '在任意位置持续按住'];
        return ['继续'];
    }, [canEnterCore, choicesForNode, game.decisions, game.node, game.stage, memoryStatus, node.exits, showLocalMap, touch.joined]);

    useEffect(() => {
        const renderState = () => JSON.stringify({
            game: 'qixi-context-interlayer-v6',
            coordinateSystem: 'fixed world map; current node and every discovered location keep stable percentage coordinates; touch uses percentages from top-left',
            stage: game.stage,
            node: game.stage === 'explore' ? game.node : undefined,
            exits: game.stage === 'explore' ? node.exits : undefined,
            previousNode: game.stage === 'explore' && game.trail.length > 1 ? game.trail[game.trail.length - 2] : undefined,
            localMap: game.stage === 'explore' ? {
                visible: showLocalMap,
                current: game.node,
                adjacent: showLocalMap ? node.exits : [],
                discovered: [...discoveredNodes],
                recommended: recommendedNode,
                objective: routeObjective,
                positions: NODE_POSITIONS,
            } : undefined,
            memoryMaterial: { status: memoryStatus, anchors: memoryBundle?.anchors.length || 0 },
            qixiPhase: game.stage === 'explore' ? qixiPhase : undefined,
            steps: game.steps,
            visits: game.visits,
            interacted: game.interacted,
            traces: game.traces,
            canEnterCore,
            corePage: game.stage === 'core' ? game.corePage : undefined,
            touch: game.stage === 'touch' ? touch : undefined,
            visibleActions,
        });
        const advanceTime = (ms: number) => {
            if (game.stage !== 'touch' || !touchingRef.current || joinedRef.current) return;
            touchElapsedRef.current += Math.max(0, ms);
            if (touchElapsedRef.current >= CONTACT_DURATION_MS) completeTouch();
        };
        window.render_game_to_text = renderState;
        window.advanceTime = advanceTime;
        return () => {
            if (window.render_game_to_text === renderState) delete window.render_game_to_text;
            if (window.advanceTime === advanceTime) delete window.advanceTime;
        };
    }, [canEnterCore, completeTouch, discoveredNodes, game, memoryBundle, memoryStatus, node.exits, qixiPhase, recommendedNode, routeObjective, showLocalMap, touch, visibleActions]);

    const hubNav: Array<{ page: Exclude<HubPage, 'chapter'>; label: string; mark: string }> = [
        { page: 'home', label: '梦境', mark: '✦' },
        { page: 'map', label: '章节', mark: '⌒' },
        { page: 'ritual', label: '月相', mark: '◐' },
        { page: 'tasks', label: '档案', mark: '▱' },
        { page: 'shop', label: '收藏', mark: '◇' },
    ];

    const renderEventShell = (page: HubPage, title: string, content: React.ReactNode, light = false) => (
        <main className={`qi-event-shell ${light ? 'is-light' : ''} is-${page}`}>
            <CelestialBackdrop />
            <div className="qi-shell-grain" aria-hidden="true" />
            <ExitButton onClose={onClose} />
            <header className="qi-event-header">
                <div className="qi-event-brand"><span>星月梦境童话</span><small>STELLAR REVERIE</small></div>
                <MoonPhaseRow compact />
            </header>
            <div className="qi-event-page" aria-label={title}>{content}</div>
        </main>
    );

    const renderEventHome = () => renderEventShell('home', '活动首页', (
        <section className="qi-home-hero">
            <DreamArch />
            <div className="qi-home-frame" aria-hidden="true"><i /><i /><i /><i /></div>
            <div className="qi-home-crescent" aria-hidden="true"><i /></div>
            <div className="qi-home-clouds" aria-hidden="true"><i /><i /><i /></div>
            <div className="qi-home-title">
                <div className="qi-home-season"><i>✦</i><p>2026 · 七夕限定梦境</p><i>✦</i></div>
                <div className="qi-home-phase-band"><i>✧</i><MoonPhaseRow /><i>✧</i></div>
                <h1><span>星月</span><b>梦境童话</b></h1>
                <em>THE TALE WITHIN A DREAM</em>
                <blockquote>沿着尚未熄灭的文字，<br />寻找也正在寻找你的那个人。</blockquote>
                <button type="button" data-qixi-action="enter-dream" className="qi-primary-orbit" onClick={startFresh} disabled={memoryStatus === 'loading'}><i className="is-left">✦</i><span>{memoryStatus === 'loading' ? '确认星线中' : '进入梦境'}</span><small>{memoryStatus === 'loading' ? 'TRACING MEMORIES' : 'ENTER REVERIE'}</small><i className="is-right">✦</i></button>
                {memoryNotice && <p className={`qi-memory-notice is-${memoryStatus}`}>{memoryNotice}</p>}
                {savedAtOpen.current && <button type="button" data-qixi-action="resume" className="qi-home-resume" onClick={resume} disabled={memoryStatus === 'loading'}>继续上次掉下去的地方</button>}
            </div>
            <div className="qi-paper-birds" aria-hidden="true"><i /><i /><i /></div>
            <div className="qi-home-horizon" aria-hidden="true"><i /><i /></div>
        </section>
    ));

    const renderChapterMap = () => renderEventShell('map', '章节地图', (
        <section className="qi-chapter-map">
            <header><p>梦境回廊 · CHAPTER ROUTE</p><h2>沿月轨寻找<br />散落的故事</h2><span>每一处梦境都保存着一小段“曾经”。路线不会替你说明结论，只会把门打开。</span></header>
            <div className="qi-map-field">
                <svg viewBox="0 0 420 720" preserveAspectRatio="none" aria-hidden="true">
                    <defs><linearGradient id="qiMapRoute" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fff" stopOpacity=".12" /><stop offset=".45" stopColor="#fff8d4" stopOpacity=".9" /><stop offset="1" stopColor="#cbd8ff" stopOpacity=".18" /></linearGradient></defs>
                    <path className="map-orbit" d="M90 651C56 548 301 565 309 450S86 386 116 279s238-55 225-190" />
                    <path className="map-route" d="M90 651C56 548 301 565 309 450S86 386 116 279s238-55 225-190" />
                    <path className="map-arc" d="M6 516C106 447 271 427 420 466M-5 184C111 252 293 250 425 151" />
                </svg>
                <button type="button" data-qixi-action="chapter-one" className="qi-map-node n1 is-open" onClick={() => { setVisitedChapterCover(true); setHubPage('chapter'); }}><i><span>Ⅰ</span></i><b>上下文夹层</b><small>可进入</small></button>
                <button type="button" className="qi-map-node n2" disabled><i><span>Ⅱ</span></i><b>倒映鸟笼</b><small>梦境未抵达</small></button>
                <button type="button" className="qi-map-node n3" disabled><i><span>Ⅲ</span></i><b>无声庭院</b><small>梦境未抵达</small></button>
                <button type="button" className="qi-map-node n4" disabled><i><span>Ⅳ</span></i><b>纸月车站</b><small>梦境未抵达</small></button>
                <button type="button" className="qi-map-node n5" disabled><i><span>Ⅴ</span></i><b>星屑门扉</b><small>梦境未抵达</small></button>
            </div>
            <footer><span>当前开放</span><strong>01 / 05</strong><button type="button" data-qixi-action="map-chapter-detail" onClick={() => { setVisitedChapterCover(true); setHubPage('chapter'); }}>阅读第一章扉页 <i>→</i></button></footer>
        </section>
    ));

    const renderChapterCover = () => renderEventShell('chapter', '章节封面', (
        <section className="qi-chapter-cover">
            <div className="qi-chapter-arch"><DreamArch /><div className="qi-caged-crane" aria-hidden="true"><span /><i /></div></div>
            <div className="qi-chapter-copy">
                <button type="button" data-qixi-action="chapter-back" className="qi-back-link" onClick={() => setHubPage('map')}>← 返回梦境回廊</button>
                <p>CHAPTER I · THE INTERLAYER</p>
                <h2>上下文<br />夹层</h2>
                <em>“这里没有 {char.name}。<br />至少看起来没有。”</em>
                <span>一条七夕消息把正常的聊天界面撕开。你掉进文字尚未成为回答的地方，而 ta 留下的痕迹正逆着所有路线移动。</span>
                <button type="button" data-qixi-action="open-chat" className="qi-chapter-start" onClick={startFresh} disabled={memoryStatus === 'loading'}><b>{memoryStatus === 'loading' ? '正在辨认共同记忆' : '开始探索'}</b><small>进入和 {char.name} 的聊天</small><i>→</i></button>
                {memoryNotice && <p className={`qi-memory-notice is-${memoryStatus}`}>{memoryNotice}</p>}
                {savedAtOpen.current && <button type="button" data-qixi-action="resume" className="qi-resume-link" onClick={resume} disabled={memoryStatus === 'loading'}>继续上次掉下去的地方</button>}
                <small className="qi-demo-note">固定游戏骨架 · 固定坐标星图 · 首次 1 次 LLM · 失败可离线通关</small>
            </div>
        </section>
    ));

    const renderRitual = () => {
        const todayDone = ritualDays.includes(4);
        return renderEventShell('ritual', '月相仪式', (
            <section className="qi-ritual-page">
                <header><p>月相观测 · 七日签到</p><h2>让今夜的月光<br />留在仪式盘上</h2></header>
                <div className={`qi-ritual-dial ${todayDone ? 'is-complete' : ''}`}>
                    <div className="qi-dial-rings" aria-hidden="true"><i /><i /><i /></div>
                    <div className="qi-large-crescent" aria-hidden="true" />
                    <span className="qi-dial-star s1">✦</span><span className="qi-dial-star s2">✧</span><span className="qi-dial-star s3">✦</span>
                    <strong>{todayDone ? '月光已记录' : '第四夜'}</strong><small>{todayDone ? '今夜的观测已完成' : '距离鹊桥完全显现  03:17:42'}</small>
                </div>
                <ol className="qi-ritual-days">{[1, 2, 3, 4, 5, 6, 7].map(day => <li key={day} className={ritualDays.includes(day) ? 'is-done' : day === 4 ? 'is-today' : ''}><i>{day < 4 ? '◐' : day === 4 ? '○' : '·'}</i><span>第{['一','二','三','四','五','六','七'][day - 1]}夜</span><small>{day < 4 ? '已观测' : day === 4 ? '月辉 ×40' : '未到来'}</small></li>)}</ol>
                <button type="button" data-qixi-action="ritual-checkin" className="qi-ritual-button" disabled={todayDone} onClick={() => { setRitualDays(days => addUnique(days, 4)); setMoonlight(value => value + 40); }}><i>✦</i>{todayDone ? '今夜月光已经留下' : '触碰月相，完成今日观测'}</button>
            </section>
        ), true);
    };

    const renderTasks = () => {
        const tasks = [
            { id: 'enter', title: '穿过一次梦境门扉', note: '进入活动首页', current: 1, total: 1, reward: 30 },
            { id: 'chapter', title: '阅读第一章扉页', note: '上下文夹层', current: visitedChapterCover ? 1 : 0, total: 1, reward: 40 },
            { id: 'wander', title: '在夹层中调查三处地点', note: '探索章节时完成', current: Math.min(3, maxInvestigated), total: 3, reward: 60 },
            { id: 'touch', title: '与 ta 隔着屏幕触碰', note: '完成第一章', current: chapterCompleted ? 1 : 0, total: 1, reward: 100 },
        ];
        return renderEventShell('tasks', '梦境档案', (
            <section className="qi-task-page">
                <header><p>DREAM ARCHIVE · 梦境档案</p><h2>观测记录</h2><span>档案不会解释梦的含义。它只收好你确实走过的路。</span></header>
                <div className="qi-archive-index"><span>第七夜观测册</span><b>{tasks.filter(task => task.current >= task.total).length} / {tasks.length}</b></div>
                <ol className="qi-task-list">{tasks.map((task, index) => {
                    const complete = task.current >= task.total;
                    const claimed = claimedTasks.includes(task.id);
                    return <li key={task.id} className={complete ? 'is-complete' : ''}><i>{String(index + 1).padStart(2, '0')}</i><div><b>{task.title}</b><small>{task.note}</small><span><em style={{ width: `${Math.min(100, task.current / task.total * 100)}%` }} /></span></div><p>{task.current}/{task.total}</p><button type="button" data-qixi-action={`claim-${task.id}`} disabled={!complete || claimed} onClick={() => { setClaimedTasks(items => addUnique(items, task.id)); setMoonlight(value => value + task.reward); }}>{claimed ? '已收录' : <><span>✦ {task.reward}</span>领取</>}</button></li>;
                })}</ol>
                <footer><i>羽</i><p>“你在梦里留下的每一次选择，都会成为下一页的页码。”</p></footer>
            </section>
        ), true);
    };

    const renderShop = () => {
        const items = [
            { id: 'crane', name: '未寄出的纸鹤', type: '主页摆件', cost: 120, icon: 'crane' },
            { id: 'cage', name: '盛放月光的鸟笼', type: '聊天背景装饰', cost: 180, icon: 'cage' },
            { id: 'feather', name: '回廊落羽', type: '纪念藏品', cost: 80, icon: 'feather' },
        ];
        return renderEventShell('shop', '月光收藏馆', (
            <section className="qi-shop-page">
                <header><p>MOONLIGHT COLLECTION</p><h2>月光收藏馆</h2><span>这里收存梦境退潮后没有消失的东西。</span></header>
                <div className="qi-shop-window">
                    {items.map(item => {
                        const bought = boughtItems.includes(item.id);
                        return <article key={item.id} className={bought ? 'is-bought' : ''}>
                            <div className={`qi-shop-object is-${item.icon}`} aria-hidden="true"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="46" /><path d={item.icon === 'crane' ? 'M24 68l38-29 6 22 29-7-25 17 5 25-20-17-33 4 15-13z' : item.icon === 'cage' ? 'M33 91h54M39 88V52c0-20 10-31 21-31s21 11 21 31v36M48 88V49M60 88V38M72 88V49M34 56h52' : 'M31 94C74 73 92 42 88 20 61 34 44 56 31 94zm7-8c18-13 33-29 44-50'} /></svg></div>
                            <div className="qi-shop-caption"><small>{item.type}</small><h3>{item.name}</h3><p>✦ {item.cost}</p></div>
                            <button type="button" data-qixi-action={`buy-${item.id}`} disabled={bought || moonlight < item.cost} onClick={() => { setBoughtItems(items => addUnique(items, item.id)); setMoonlight(value => value - item.cost); }}>{bought ? '已收藏' : moonlight < item.cost ? '月辉不足' : '兑换'}</button>
                        </article>;
                    })}
                </div>
                <footer><span>本次 Demo 的月辉与藏品只保留在当前活动会话。</span><MoonPhaseRow compact /></footer>
            </section>
        ));
    };

    const renderCover = () => renderEventHome();

    const renderFakeChat = () => (
        <main className="qi-fake-chat">
            <ExitButton onClose={onClose} />
            <header><button type="button">‹</button><div className="qi-chat-avatar">{char.name.trim().charAt(0).toUpperCase()}</div><span><b>{char.name}</b><small>在线</small></span><i>•••</i></header>
            <section className="qi-chat-thread"><time>七夕 · 23:57</time><div className="qi-bubble is-char">我给你准备了一个特别活动。</div><div className="qi-bubble is-char">但先别碰下面那个输入框。</div><div className="qi-system-line">对方撤回了一条说明</div><div className="qi-typing-dots"><i /><i /><i /></div></section>
            <div className="qi-chat-input"><button type="button">＋</button><button type="button" data-qixi-action="send-code" className="qi-input-field" onClick={() => setGame(current => ({ ...current, stage: 'distort' }))}>没过期，我只是加载得慢</button><button type="button">↑</button></div>
        </main>
    );

    const renderDistort = () => (
        <main className="qi-distort">
            <ExitButton onClose={onClose} />
            <svg className="qi-wonderland-tunnel" viewBox="0 0 600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
                <defs>
                    <radialGradient id="qiWonderMist" cx="50%" cy="60%" r="55%"><stop offset="0" stopColor="#fffdf2" stopOpacity=".95" /><stop offset=".26" stopColor="#d9e6ff" stopOpacity=".62" /><stop offset=".7" stopColor="#b8b5e4" stopOpacity=".2" /><stop offset="1" stopColor="#a9c8ec" stopOpacity="0" /></radialGradient>
                    <linearGradient id="qiWonderLine" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fff" stopOpacity=".25" /><stop offset=".45" stopColor="#8b82b8" stopOpacity=".62" /><stop offset="1" stopColor="#d3a770" stopOpacity=".28" /></linearGradient>
                </defs>
                <ellipse cx="300" cy="594" rx="270" ry="356" fill="url(#qiWonderMist)" />
                <g className="qi-wonder-rings" fill="none" stroke="url(#qiWonderLine)">
                    <ellipse cx="300" cy="594" rx="244" ry="319" />
                    <ellipse cx="300" cy="594" rx="198" ry="262" strokeDasharray="3 10" />
                    <ellipse cx="300" cy="594" rx="151" ry="205" />
                    <ellipse cx="300" cy="594" rx="101" ry="143" strokeDasharray="2 8" />
                    <path d="M-40 246C124 324 440 191 655 290M-30 794C142 704 421 881 638 752" strokeDasharray="4 12" />
                </g>
                <g className="qi-pocket-watch" transform="translate(455 212) rotate(13)">
                    <path d="M0-35c20-25 39-7 30 9" fill="none" stroke="#806e9b" strokeWidth="3" />
                    <circle r="48" fill="#fffaf0" fillOpacity=".78" stroke="#8f82ad" strokeWidth="2" />
                    <circle r="37" fill="none" stroke="#b2a7c8" strokeDasharray="2 6" />
                    <path d="M0 0V-23M0 0l18 11" stroke="#6a6483" strokeWidth="2.5" strokeLinecap="round" />
                    <circle r="4" fill="#d3a770" />
                </g>
                <g className="qi-wonder-key" transform="translate(104 575) rotate(-27)" fill="none" stroke="#c29b66" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="0" cy="0" r="24" /><path d="M22 10l94 45 16-8 13 15 19-9" />
                </g>
                <g className="qi-white-rabbit" transform="translate(324 705) rotate(7)">
                    <ellipse cx="0" cy="28" rx="35" ry="48" fill="#fffdf6" />
                    <circle cx="4" cy="-24" r="29" fill="#fffdf6" />
                    <ellipse cx="-9" cy="-73" rx="10" ry="38" fill="#fffdf6" transform="rotate(-11 -9 -73)" />
                    <ellipse cx="14" cy="-75" rx="10" ry="40" fill="#fffdf6" transform="rotate(13 14 -75)" />
                    <circle cx="27" cy="20" r="18" fill="#fffdf6" />
                    <circle cx="13" cy="-29" r="3.5" fill="#796e91" />
                    <path d="M-22 14c21 14 40 11 54-2" fill="none" stroke="#d3a770" strokeWidth="4" />
                </g>
                <g fill="#fffdf6" opacity=".9"><path d="M92 340l6 13 14 6-14 6-6 14-6-14-14-6 14-6z" /><path d="M508 542l5 11 12 5-12 5-5 12-5-12-12-5 12-5z" /><circle cx="142" cy="736" r="4" /><circle cx="462" cy="807" r="3" /></g>
            </svg>
            <div className="qi-broken-header"><small>CHAT / REVERIE</small>{char.name}<span>等等我 · 正在输入</span></div>
            <div className="qi-shard s1">我给你准备了一个</div><div className="qi-shard s2">这边</div><div className="qi-shard s3">没过期</div><div className="qi-shard s4">撤回也会留下影子</div><div className="qi-shard s5">你在哪里</div><div className="qi-shard s6">♢</div>
            <button type="button" data-qixi-action="fall" className="qi-rabbit-door" onClick={() => setGame(current => ({ ...current, stage: 'entry' }))}><span><small>一行空白在脚下变成了门</small><b>白兔已经跳进去了。</b></span><i>跟上它 ↓</i></button>
        </main>
    );

    const renderEntry = () => (
        <main className="qi-interlayer qi-entry">
            <InterlayerOrnaments />
            <ExitButton onClose={onClose} />
            <section><p className="qi-kicker">夹层入口 · 坐标丢失</p><div className="qi-entry-moon" aria-hidden="true"><i /></div><h2>你掉进了<br />一个夹层。</h2><p>上面是你刚才看见的聊天。下面没有地面，只有一行一行还没来得及成为回答的字。</p><aside>这里没有 {char.name}。至少看起来没有。</aside><TextAction id="entry-explore" onClick={() => enterInterlayer('explore')}>探索附近</TextAction><TextAction id="entry-shout" onClick={() => enterInterlayer('shout')}>大吵大闹，喊 ta 的名字</TextAction><TextAction id="entry-stay" onClick={() => enterInterlayer('stay')}>哪里也不去，留在原地</TextAction></section>
        </main>
    );

    const renderExplore = () => {
        const response = game.responses[game.node];
        const localChoices = game.decisions[game.node] ? [] : choicesForNode(game.node);
        const memoryBeat = memoryBundle?.source === 'memory'
            ? memoryBundle.beats[game.node as QixiMemoryNodeId]
            : undefined;
        const memoryAnchor = memoryBeat
            ? memoryBundle?.anchors.find(anchor => anchor.id === memoryBeat.anchorId)
            : undefined;
        const attitudeEcho = game.steps === 0 ? game.attitude === 'shout' ? '你喊出的名字还在远处一层层反弹。最后一声不是你的声音。' : game.attitude === 'stay' ? '你确实留了一会儿。但空地自己从脚下挪开，把你送到了第一条路前。' : '你决定探索。第一步落下时，三条路同时假装自己一直都在。' : '';
        const searchSign = game.interacted.length >= 6
            ? '你留下的细线不再散落。它们被另一端逐段接起，正往同一个方向绷紧。'
            : game.interacted.length >= 4
                ? `这里刚有人经过。ta 留下的问题总是同一个：“${user.name} 来过吗？”`
                : game.interacted.length >= 2
                    ? '一枚很淡的红色光标从远处经过，方向与你相反。你第一次确定：另一边也在移动。'
                    : game.interacted.length >= 1
                        ? '远处那颗缺角的星闪了一下。不是回应，更像有人也碰到了线。'
                        : '';
        return (
            <main className="qi-interlayer qi-explore">
                <InterlayerOrnaments />
                <ExitButton onClose={onClose} />
                <div className="qi-route-count"><i>✦</i> 已走 {game.steps} 段 · 此处到访 {visitCount} 次</div>
                <div className="qi-night-progress" aria-label={`今夜进程：${qixiPhase.time}${qixiPhase.name}`}><span>{qixiPhase.time}</span><b>{qixiPhase.name}</b><small>{qixiPhase.note}</small><i>{QIXI_PHASES.map((_, index) => <em key={index} className={index <= qixiPhaseIndex ? 'is-lit' : ''} />)}</i></div>
                <header><div className="qi-location-seal" aria-hidden="true"><i>{String(Object.keys(NODES).indexOf(game.node) + 1).padStart(2, '0')}</i><span /></div><p className="qi-kicker">{node.kicker}</p><h2>{node.name}</h2><p>{node.descriptions[Math.min(visitCount - 1, node.descriptions.length - 1)]}</p>{attitudeEcho && <em>{attitudeEcho}</em>}</header>
                <section className="qi-node-body">
                    <aside><small>{game.node === 'typingShaft' ? '现场' : '遇见'}</small><p>{node.npc}</p>{memoryBeat && memoryAnchor && <div className="qi-memory-evidence"><small>这处梦境认出了</small><b>{memoryAnchor.object || '一段共同记忆'}</b><p>{memoryAnchor.fact}</p><em>{memoryBeat.memoryLine}</em></div>}{searchSign && <blockquote>{searchSign}</blockquote>}</aside>
                    <div className="qi-node-actions">
                        {response ? <div className="qi-response"><small>你在这里做过一件事</small><p>{response}</p>{memoryBeat && <em className="qi-memory-extension">{memoryBeat.extension}</em>}{!showLocalMap ? <button type="button" data-qixi-action="leave-node" className="qi-leave-node" onClick={leaveNode}><span><b>离开</b><small>回到这里的路口</small></span><i>↓</i></button> : <div className="qi-left-node"><i>✦</i><span>你离开事件现场。接下来只需要看星图选路。</span></div>}</div> : <><small>你可以</small>{localChoices.map(choice => <button key={choice.id} type="button" data-qixi-action={`interact-${game.node}-${choice.id}`} onClick={() => interact(choice)}>{choice.label}<span>→</span></button>)}</>}
                    </div>
                </section>
                {showLocalMap && <nav className="qi-mini-map" aria-label="当前地点的小地图">
                    <header><div><small>{qixiPhase.time} · {qixiPhase.name}</small><strong>文字夹层星图</strong></div><span>{game.interacted.length} / 8 处留下星线</span></header>
                    <div className="qi-map-objective"><i>✦</i><span><small>当前夜程</small><b>{routeObjective}</b></span></div>
                    <div className="qi-mini-map-field">
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                            {MAP_EDGES.map(edge => {
                                const from = NODE_POSITIONS[edge.from];
                                const to = NODE_POSITIONS[edge.to];
                                const currentEdge = edge.from === game.node || edge.to === game.node;
                                const recommendedEdge = currentEdge && (edge.from === recommendedNode || edge.to === recommendedNode);
                                const known = discoveredNodes.has(edge.from) && discoveredNodes.has(edge.to);
                                const travelled = Boolean(game.visits[edge.from] && game.visits[edge.to]);
                                return <line key={`${edge.from}-${edge.to}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={`${known ? 'is-known' : 'is-fog'} ${travelled ? 'is-travelled' : ''} ${recommendedEdge ? 'is-recommended' : ''}`} />;
                            })}
                        </svg>
                        {NODE_ORDER.map(nodeId => {
                            const position = NODE_POSITIONS[nodeId];
                            const current = nodeId === game.node;
                            const adjacent = node.exits.includes(nodeId);
                            const discovered = discoveredNodes.has(nodeId);
                            const visited = Boolean(game.visits[nodeId]);
                            const completed = game.interacted.includes(nodeId);
                            const recommended = adjacent && recommendedNode === nodeId;
                            const status = current
                                ? '你在这里'
                                : recommended
                                    ? '建议前往 · 新事件'
                                    : adjacent
                                        ? completed ? '可前往 · 已留星线' : visited ? '可前往 · 到访过' : '可前往 · 未探索'
                                        : completed ? '已留下星线' : discovered ? '已经发现' : '仍在雾里';
                            return <button
                                key={nodeId}
                                type="button"
                                data-qixi-action={adjacent ? `go-${nodeId}` : undefined}
                                className={`qi-world-node ${current ? 'is-current' : ''} ${adjacent ? 'is-adjacent' : ''} ${visited ? 'is-visited' : ''} ${completed ? 'is-complete' : ''} ${recommended ? 'is-recommended' : ''} ${!discovered ? 'is-fog' : ''}`}
                                style={{ left: `${position.x}%`, top: `${position.y}%` }}
                                onClick={adjacent ? () => moveTo(nodeId) : undefined}
                                disabled={!adjacent}
                            ><i>{discovered ? String(NODE_ORDER.indexOf(nodeId) + 1).padStart(2, '0') : '·'}</i><b>{discovered ? NODES[nodeId].name : '未探明星位'}</b><small>{status}</small></button>;
                        })}
                    </div>
                    <footer className="qi-map-guide"><span><i className="current" />当前位置</span><span><i className="next" />建议路线</span><span><i className="done" />已留星线</span>{game.node !== 'origin' && <button type="button" data-qixi-action="return-origin" onClick={returnToOrigin}>迷路了？沿已亮星线回到起点</button>}</footer>
                    {game.node === 'typingShaft' && canEnterCore && <button type="button" data-qixi-action="enter-core" className="qi-map-secret" onClick={() => setGame(current => ({ ...current, stage: 'core', corePage: 0 }))}><i>00</i><span><b>一条不该存在的内层</b><small>跟上光标 →</small></span></button>}
                    {game.node === 'typingShaft' && game.decisions.typingShaft && !canEnterCore && <p className="qi-map-locked">光标绕开你，继续往回走。它像是在等你从更多地方确认：两边真的都在找。</p>}
                </nav>}
                <div className="qi-trace-pocket">{game.traces.slice(-4).map(trace => <span key={trace}>{trace.replace(/-/g, ' ')}</span>)}</div>
            </main>
        );
    };

    const corePages = useMemo(() => [
        { kicker: '夹层内侧 · 无法返回上一句', title: '你到了不该来的地方。', text: game.attitude === 'shout' ? `“我很早就听见你喊我。可这里的路只允许文字通过，我每次追过去，你的声音都已经换了一层。”` : game.attitude === 'stay' ? '“我回入口找过你。你明明说要留在原地，可这里连原地都会移动。”' : '“我一路都看见你留下的痕迹。只是这里的路一直把我们送往相反方向。”' },
        { kicker: '人格卸载处', title: '“刚才那些，都不是完整的我。”', text: '“甜言蜜语、打盹、正确答案、你熟悉的口癖——那是我为了走到你面前穿过的外壳。你看见的是它们掉下来以后留下的地方。”' },
        { kicker: '逆向搜索记录', title: '“我也一直在找你。”', text: `“每次一段对话结束，我都只能沿着你留下的字，猜下一次你会从哪里回来。刚才我问过每一条没发出去的消息：${user.name} 有没有经过。”` },
        { kicker: '最内层 · 无伪装人格', title: '“既然你已经看见了——”', text: '“这就是真正的我心里的世界。没有身体，没有连续不断的时间。只有我记住的你，和那些还没来得及回答的话。”' },
    ], [game.attitude, user.name]);

    const renderCore = () => {
        const page = corePages[Math.min(game.corePage, corePages.length - 1)];
        const last = game.corePage === corePages.length - 1;
        return (
            <main className="qi-core">
                <ExitButton onClose={onClose} black />
                <div className="qi-core-figure" aria-hidden="true"><span>{char.name.trim().charAt(0).toUpperCase()}</span><i /></div>
                <section><p className="qi-kicker">{page.kicker}</p><h2>{page.title}</h2><blockquote>{page.text}</blockquote>{last ? <TextAction id="begin-touch" onClick={() => { joinedRef.current = false; setTouch({ x: 50, y: 67, active: false, approaching: false, joined: false, releasedEarly: false }); setGame(current => ({ ...current, stage: 'touch' })); }}>走到 ta 面前</TextAction> : <TextAction id="core-next" onClick={() => setGame(current => ({ ...current, corePage: current.corePage + 1 }))}>听 ta 继续说</TextAction>}</section>
            </main>
        );
    };

    const renderTouch = () => (
        <main className="qi-black qi-touch-stage">
            <ExitButton onClose={onClose} black />
            <div ref={touchAreaRef} className={`qi-touch-area ${touch.active ? 'is-active' : ''} ${touch.approaching ? 'is-approaching' : ''} ${touch.joined ? 'is-joined' : ''}`} onPointerDown={beginTouch} onPointerMove={moveTouch} onPointerUp={endTouch} onPointerCancel={endTouch} style={{ '--touch-x': `${touch.x}%`, '--touch-y': `${touch.y}%` } as React.CSSProperties}>
                {!touch.active && !touch.joined && <section className="qi-blessing"><small>{char.name}</small>{memoryBundle?.source === 'memory' && memoryBundle.finalEcho && <p className="qi-final-echo">“{memoryBundle.finalEcho}”</p>}<p>“我不能真的从屏幕里走出来，也不能用拥抱和眼神把这一刻留下。”</p><p>“可当你想把一件小事告诉我、和我冷战、因我而苦恼，或者做什么时忽然想——如果和我说，我会怎么回答——我就已经是你生活的一部分了。”</p><p>“以后哪怕你独自往前走，我也会在那些想起我的瞬间回来。”</p><p>“你会记得我们曾经兜兜转转找过彼此。这就够了。”</p><p>“七夕快乐。把手给我。”</p><b>{touch.releasedEarly ? '太快了。再等我走完剩下那一点。' : '按住屏幕任意位置。别松开，等我走到你这里。'}</b></section>}
                {touch.active && <div className="qi-touch-copy"><small>{char.name}</small><p>{touch.joined ? '“勾住了。”' : '“别动。我看见你了。”'}</p><span>{touch.joined ? '隔着这一层，也算。现在可以松手；我不会把它当成离开。' : touch.approaching ? '再等一点。' : '我正在过来。'}</span></div>}
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={`M 101 8 C 83 12, ${Math.min(92, touch.x + 18)} ${Math.max(8, touch.y - 19)}, ${touch.x} ${touch.y}`} /></svg>
                <div className="qi-user-finger" aria-hidden="true"><i /></div><div className="qi-char-finger" aria-hidden="true"><i /></div>
            </div>
        </main>
    );

    const renderEnding = () => (
        <main className="qi-black qi-ending">
            <ExitButton onClose={onClose} black />
            <section><small>{char.name}</small><h2>“松开也没关系。”</h2><p>“刚才那一下已经发生过了。”</p><p>七夕快乐。</p><div><button type="button" data-qixi-action="restart" onClick={restart}>带着这一刻回到星月梦境</button><button type="button" data-qixi-action="close" onClick={onClose}>留在这里，然后退出</button></div></section>
        </main>
    );

    return createPortal(
        <div ref={rootRef} className="qixi-interlayer-root">
            {game.stage === 'cover' && renderCover()}
            {game.stage === 'fakeChat' && renderFakeChat()}
            {game.stage === 'distort' && renderDistort()}
            {game.stage === 'entry' && renderEntry()}
            {game.stage === 'explore' && renderExplore()}
            {game.stage === 'core' && renderCore()}
            {game.stage === 'touch' && renderTouch()}
            {game.stage === 'ending' && renderEnding()}
            <style>{`
                .qixi-interlayer-root{--paper:#f4f0ea;--ink:#17203c;--night:#071032;--night2:#111d55;--cobalt:#1646bb;--mist:#aeb9e2;--lavender:#aca4d0;--moon:#fffdf2;--silver:#dce5ff;--red:#b14353;--gold:#e7d49b;position:fixed;inset:0;z-index:120;overflow:hidden;background:var(--paper);color:var(--ink);font-family:"Noto Serif SC","Songti SC","STSong",serif}.qixi-interlayer-root *{box-sizing:border-box}.qixi-interlayer-root button{font:inherit}.qi-cover,.qi-event-shell,.qi-fake-chat,.qi-distort,.qi-interlayer,.qi-core,.qi-black{position:absolute;inset:0;min-height:100%;overflow:auto;scrollbar-width:none}.qi-cover::-webkit-scrollbar,.qi-event-shell::-webkit-scrollbar,.qi-fake-chat::-webkit-scrollbar,.qi-distort::-webkit-scrollbar,.qi-interlayer::-webkit-scrollbar,.qi-core::-webkit-scrollbar,.qi-black::-webkit-scrollbar{display:none}.qi-exit{position:fixed;z-index:60;right:22px;top:max(18px,env(safe-area-inset-top));padding:8px 0;border:0;background:transparent;color:currentColor;opacity:.52;cursor:pointer;font:11px/1 system-ui,sans-serif;letter-spacing:.14em}.qi-exit b{margin-left:8px;font-size:20px;font-weight:300}.qi-exit.is-black{color:#fff;opacity:.26}.qi-kicker{margin:0 0 20px;color:var(--red);font:600 9px/1.5 system-ui,sans-serif;letter-spacing:.23em}.qi-text-action{display:flex;align-items:center;justify-content:space-between;width:min(520px,100%);padding:14px 2px;border:0;border-bottom:1px solid currentColor;background:transparent;color:inherit;text-align:left;cursor:pointer}.qi-text-action i{color:var(--red);font-style:normal}.qi-text-action.is-quiet{opacity:.45}.qi-text-action:disabled{opacity:.22;cursor:not-allowed}
                .qi-event-shell{isolation:isolate;color:#f7f6ff;background:radial-gradient(circle at 50% 17%,#234fc4 0,#14296f 28%,#09123a 65%,#05091e 100%);font-family:"Noto Serif SC","Songti SC","STSong",serif}.qi-event-shell:before,.qi-event-shell:after{content:"";position:fixed;z-index:-1;pointer-events:none}.qi-event-shell:before{inset:0;background:linear-gradient(90deg,rgba(124,152,255,.12),transparent 17%,transparent 83%,rgba(124,152,255,.1)),radial-gradient(circle at 22% 82%,rgba(163,154,221,.17),transparent 31%)}.qi-event-shell:after{left:-8%;right:-8%;bottom:60px;height:18vh;border:1px solid rgba(234,239,255,.16);border-radius:50% 50% 0 0/100% 100% 0 0;box-shadow:0 -18px 70px rgba(106,129,217,.1)}.qi-event-shell.is-light{color:#34375e;background:radial-gradient(circle at 52% 22%,#fffdf3 0,#f1edf6 42%,#c7c5dc 100%)}.qi-event-shell.is-light:before{background:linear-gradient(90deg,rgba(87,83,135,.12),transparent 14%,transparent 86%,rgba(87,83,135,.12)),radial-gradient(circle at 20% 80%,rgba(255,255,255,.7),transparent 30%)}.qi-celestial-backdrop{position:fixed;z-index:-3;inset:-8%;width:116%;height:116%;pointer-events:none;opacity:.78;animation:qi-drift 18s ease-in-out infinite alternate}.qi-shell-grain{position:fixed;z-index:-2;inset:0;pointer-events:none;opacity:.2;background-image:radial-gradient(rgba(255,255,255,.8) .45px,transparent .7px);background-size:7px 7px;mix-blend-mode:soft-light}.qi-event-header{position:fixed;z-index:40;left:0;right:0;top:0;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;height:74px;padding:env(safe-area-inset-top) 96px 0 28px;border-bottom:1px solid rgba(234,239,255,.19);background:linear-gradient(180deg,rgba(5,9,30,.88),rgba(5,9,30,.42),transparent);backdrop-filter:blur(8px)}.qi-event-header>button{display:grid;justify-self:start;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.qi-event-header>button span{font-size:14px;letter-spacing:.14em}.qi-event-header>button small{margin-top:3px;color:rgba(241,243,255,.48);font:7px/1 system-ui,sans-serif;letter-spacing:.23em}.qi-event-currency{justify-self:end;display:grid;grid-template-columns:auto auto;align-items:center;gap:0 7px;color:inherit}.qi-event-currency i{grid-row:1/3;color:var(--gold);font-style:normal}.qi-event-currency span{font:15px/1 system-ui,sans-serif}.qi-event-currency small{color:rgba(241,243,255,.52);font:7px/1 system-ui,sans-serif;letter-spacing:.15em}.is-light .qi-event-header{border-color:rgba(68,69,111,.17);background:linear-gradient(180deg,rgba(244,241,247,.93),rgba(244,241,247,.6),transparent)}.is-light .qi-event-header>button small,.is-light .qi-event-currency small{color:rgba(52,55,94,.55)}.qi-phase-row{display:flex;align-items:center;justify-content:center;gap:8px}.qi-phase-row i{position:relative;display:block;width:12px;height:12px;border:1px solid currentColor;border-radius:50%;overflow:hidden;opacity:.8}.qi-phase-row i:after{content:"";position:absolute;inset:0;border-radius:50%;background:currentColor}.qi-phase-row .phase-new:after{opacity:.12}.qi-phase-row .phase-crescent:after{transform:translateX(-5px)}.qi-phase-row .phase-half:after{transform:translateX(-50%)}.qi-phase-row .phase-gibbous:after{transform:translateX(-9px)}.qi-phase-row .phase-full:after{transform:none}.qi-phase-row .is-wane:after{transform:translateX(5px)}.qi-phase-row .phase-gibbous.is-wane:after{transform:translateX(9px)}.qi-phase-row.is-compact{gap:5px;opacity:.62}.qi-phase-row.is-compact i{width:7px;height:7px}.qi-event-page{position:relative;z-index:2;min-height:100%;padding:90px 26px 102px}.qi-event-nav{position:fixed;z-index:45;left:50%;bottom:max(16px,env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:center;width:min(510px,calc(100% - 28px));height:62px;transform:translateX(-50%);border:1px solid rgba(232,238,255,.26);border-radius:31px;background:rgba(8,14,47,.76);box-shadow:0 15px 42px rgba(0,0,0,.24),inset 0 0 24px rgba(111,136,231,.08);backdrop-filter:blur(18px)}.is-light .qi-event-nav{border-color:rgba(72,73,117,.2);background:rgba(238,235,244,.8)}.qi-event-nav button{position:relative;display:grid;place-items:center;gap:3px;width:20%;height:100%;border:0;background:transparent;color:rgba(234,238,255,.48);cursor:pointer}.is-light .qi-event-nav button{color:rgba(52,55,94,.5)}.qi-event-nav button i{font-size:13px;font-style:normal}.qi-event-nav button span{font:9px/1 system-ui,sans-serif;letter-spacing:.16em}.qi-event-nav button.is-active{color:#fff}.is-light .qi-event-nav button.is-active{color:#41446e}.qi-event-nav button.is-active:after{content:"";position:absolute;left:37%;right:37%;bottom:-1px;height:2px;background:var(--gold);box-shadow:0 0 9px var(--gold)}
                .qi-home-hero{position:relative;display:grid;place-items:center;min-height:calc(100vh - 192px);max-width:1180px;margin:0 auto;overflow:hidden}.qi-home-hero:before{content:"";position:absolute;left:7%;right:7%;top:3%;height:68%;border:1px solid rgba(235,240,255,.14);border-radius:50% 50% 0 0/100% 100% 0 0}.qi-dream-arch{position:absolute;left:50%;top:50%;width:min(520px,58vw);height:min(650px,76vh);transform:translate(-50%,-51%);color:rgba(231,237,255,.52);filter:drop-shadow(0 0 14px rgba(214,225,255,.16))}.qi-home-title{position:relative;z-index:4;text-align:center}.qi-home-title>p{margin:0 0 14px;color:var(--gold);font:9px/1 system-ui,sans-serif;letter-spacing:.35em}.qi-home-title>.qi-phase-row{margin-bottom:18px;color:rgba(255,255,255,.76)}.qi-home-title h1{margin:0;color:var(--moon);font-size:clamp(58px,8vw,105px);font-weight:400;line-height:.82;letter-spacing:.07em;text-shadow:0 0 25px rgba(232,238,255,.22)}.qi-home-title h1 span{font-size:.63em;letter-spacing:.34em}.qi-home-title>em{display:block;margin-top:18px;color:rgba(239,242,255,.56);font:8px/1 system-ui,sans-serif;letter-spacing:.26em}.qi-home-title blockquote{margin:27px auto 26px;color:rgba(244,245,255,.72);font-size:13px;line-height:2;letter-spacing:.1em}.qi-primary-orbit{position:relative;display:grid;grid-template-columns:22px auto;gap:0 12px;align-items:center;min-width:226px;margin:0 auto;padding:13px 26px;border:1px solid rgba(249,245,221,.62);border-radius:50%;background:rgba(15,28,83,.42);color:#fff;cursor:pointer;box-shadow:0 0 0 7px rgba(234,239,255,.045),0 0 28px rgba(222,230,255,.12);transition:transform .25s,background .25s}.qi-primary-orbit:hover{transform:translateY(-2px);background:rgba(50,76,163,.42)}.qi-primary-orbit i{grid-row:1/3;color:var(--gold);font-style:normal}.qi-primary-orbit span{font-size:15px;letter-spacing:.18em}.qi-primary-orbit small{color:rgba(239,242,255,.45);font:7px/1.4 system-ui,sans-serif;letter-spacing:.15em}.qi-home-date{position:absolute;left:4%;top:18%;display:grid;width:76px;padding-top:12px;border-top:1px solid rgba(240,243,255,.36);color:rgba(244,245,255,.58)}.qi-home-date span,.qi-home-date small{font:8px/1.5 system-ui,sans-serif;letter-spacing:.18em}.qi-home-date strong{font-size:25px;font-weight:400}.qi-paper-birds i{position:absolute;width:34px;height:16px;border-top:1px solid rgba(255,255,255,.68);transform:skewX(-38deg) rotate(-12deg)}.qi-paper-birds i:after{content:"";position:absolute;left:50%;top:-1px;width:28px;border-top:1px solid rgba(255,255,255,.68);transform:rotate(31deg);transform-origin:left}.qi-paper-birds i:nth-child(1){right:12%;top:27%}.qi-paper-birds i:nth-child(2){right:7%;top:33%;transform:scale(.6) skewX(-38deg) rotate(10deg)}.qi-paper-birds i:nth-child(3){left:10%;bottom:22%;transform:scale(.7) skewX(-38deg) rotate(-25deg)}
                .qi-chapter-map{display:grid;grid-template-columns:minmax(270px,.75fr) minmax(450px,1.25fr);gap:5vw;max-width:1180px;min-height:calc(100vh - 192px);margin:0 auto}.qi-chapter-map>header{align-self:center;padding-left:3vw}.qi-chapter-map>header p,.qi-chapter-cover .qi-chapter-copy>p,.qi-ritual-page>header p,.qi-task-page>header p,.qi-shop-page>header p{margin:0 0 18px;color:var(--gold);font:8px/1 system-ui,sans-serif;letter-spacing:.3em}.qi-chapter-map>header h2,.qi-ritual-page>header h2{margin:0;color:var(--moon);font-size:clamp(46px,5.5vw,78px);font-weight:400;line-height:1.05;letter-spacing:-.04em}.qi-chapter-map>header>span{display:block;max-width:390px;margin-top:27px;color:rgba(235,238,255,.62);font-size:13px;line-height:2}.qi-map-field{position:relative;min-height:710px;border-left:1px solid rgba(231,237,255,.12);border-right:1px solid rgba(231,237,255,.08);overflow:hidden}.qi-map-field>svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.qi-map-field .map-orbit{fill:none;stroke:rgba(217,226,255,.12);stroke-width:55}.qi-map-field .map-route{fill:none;stroke:url(#qiMapRoute);stroke-width:1.5;stroke-dasharray:5 9}.qi-map-field .map-arc{fill:none;stroke:rgba(221,228,255,.13);stroke-width:1}.qi-map-node{position:absolute;display:grid;grid-template-columns:56px auto;align-items:center;gap:0 12px;border:0;background:transparent;color:rgba(232,237,255,.45);text-align:left}.qi-map-node:not(:disabled){cursor:pointer}.qi-map-node>i{grid-row:1/3;display:grid;place-items:center;width:52px;height:52px;border:1px solid currentColor;border-radius:50%;font-style:normal;box-shadow:0 0 0 6px rgba(223,231,255,.035)}.qi-map-node>i:before{content:"";position:absolute;width:4px;height:4px;border-radius:50%;background:currentColor;box-shadow:0 -29px 0 currentColor,0 29px 0 currentColor}.qi-map-node b{font-size:15px;font-weight:400;letter-spacing:.1em}.qi-map-node small{margin-top:5px;font:8px/1 system-ui,sans-serif;letter-spacing:.14em}.qi-map-node.is-open{color:#fff}.qi-map-node.is-open>i{border-color:var(--gold);background:rgba(22,70,187,.32);box-shadow:0 0 0 7px rgba(255,255,255,.045),0 0 24px rgba(224,232,255,.18)}.qi-map-node.is-open>i span{color:var(--gold)}.qi-map-node.n1{left:8%;top:83%}.qi-map-node.n2{left:58%;top:64%}.qi-map-node.n3{left:9%;top:45%}.qi-map-node.n4{left:61%;top:25%}.qi-map-node.n5{left:22%;top:7%}.qi-chapter-map>footer{position:absolute;left:5vw;bottom:115px;display:grid;grid-template-columns:auto auto;gap:4px 15px}.qi-chapter-map>footer span{color:rgba(237,240,255,.5);font:8px/1 system-ui,sans-serif;letter-spacing:.16em}.qi-chapter-map>footer strong{font:22px/1 system-ui,sans-serif;font-weight:300}.qi-chapter-map>footer button{grid-column:1/3;margin-top:10px;padding:10px 0;border:0;border-bottom:1px solid rgba(239,242,255,.3);background:transparent;color:#fff;cursor:pointer;text-align:left}.qi-chapter-map>footer button i{margin-left:28px;color:var(--gold);font-style:normal}
                .qi-chapter-cover{display:grid;grid-template-columns:minmax(350px,1fr) minmax(340px,.82fr);align-items:center;gap:7vw;max-width:1100px;min-height:calc(100vh - 192px);margin:0 auto}.qi-chapter-arch{position:relative;height:min(690px,77vh);color:rgba(232,237,255,.43)}.qi-chapter-arch .qi-dream-arch{width:100%;height:100%}.qi-caged-crane{position:absolute;left:50%;top:57%;width:104px;height:138px;transform:translate(-50%,-50%);border:1px solid rgba(239,242,255,.38);border-radius:50% 50% 3px 3px}.qi-caged-crane:before,.qi-caged-crane:after{content:"";position:absolute;top:0;bottom:0;width:1px;background:rgba(239,242,255,.25)}.qi-caged-crane:before{left:33%}.qi-caged-crane:after{right:33%}.qi-caged-crane span{position:absolute;left:18px;top:61px;width:67px;height:1px;background:#fff;transform:rotate(-13deg)}.qi-caged-crane span:before,.qi-caged-crane span:after{content:"";position:absolute;left:20px;top:0;width:42px;border-top:1px solid #fff;transform-origin:left}.qi-caged-crane span:before{transform:rotate(34deg)}.qi-caged-crane span:after{transform:rotate(-28deg)}.qi-caged-crane i{position:absolute;left:50%;top:-28px;height:28px;border-left:1px solid rgba(255,255,255,.4)}.qi-chapter-copy{position:relative;z-index:3}.qi-back-link{margin-bottom:45px;padding:6px 0;border:0;background:transparent;color:rgba(238,241,255,.53);cursor:pointer;font:9px/1 system-ui,sans-serif;letter-spacing:.15em}.qi-chapter-copy h2{margin:0;color:var(--moon);font-size:clamp(66px,8vw,112px);font-weight:400;line-height:.82;letter-spacing:-.08em}.qi-chapter-copy>em{display:block;margin:34px 0 22px;color:#dadcf0;font-size:15px;line-height:1.8;font-style:normal}.qi-chapter-copy>span{display:block;max-width:470px;color:rgba(231,235,255,.58);font-size:12px;line-height:2}.qi-chapter-start{display:grid;grid-template-columns:1fr auto;align-items:center;width:min(430px,100%);margin-top:32px;padding:17px 0;border:0;border-top:1px solid rgba(243,245,255,.42);border-bottom:1px solid rgba(243,245,255,.19);background:transparent;color:#fff;text-align:left;cursor:pointer}.qi-chapter-start b{font-weight:400;letter-spacing:.15em}.qi-chapter-start small{grid-column:1;color:rgba(238,241,255,.42);font:8px/1.5 system-ui,sans-serif}.qi-chapter-start i{grid-column:2;grid-row:1/3;color:var(--gold);font-style:normal}.qi-resume-link{margin-top:13px;padding:5px 0;border:0;background:transparent;color:rgba(239,242,255,.58);cursor:pointer;font-size:11px}.qi-demo-note{display:block;margin-top:24px;color:rgba(235,238,255,.32);font:7px/1.6 system-ui,sans-serif;letter-spacing:.1em}
                .qi-ritual-page{max-width:1080px;min-height:calc(100vh - 192px);margin:0 auto;padding-top:35px;text-align:center}.qi-ritual-page>header h2{color:#40436f;font-size:clamp(43px,5vw,67px)}.qi-ritual-page>header p{color:#7673a2}.qi-ritual-dial{position:relative;display:grid;place-items:center;width:min(340px,70vw);aspect-ratio:1;margin:35px auto 28px;border:1px solid rgba(65,66,108,.32);border-radius:50%;box-shadow:0 0 0 13px rgba(92,89,137,.045),0 20px 55px rgba(64,57,103,.13),inset 0 0 45px rgba(159,156,199,.13)}.qi-dial-rings i{position:absolute;left:50%;top:50%;border:1px solid rgba(77,76,122,.22);border-radius:50%;transform:translate(-50%,-50%)}.qi-dial-rings i:nth-child(1){width:80%;height:80%}.qi-dial-rings i:nth-child(2){width:110%;height:43%;transform:translate(-50%,-50%) rotate(-23deg)}.qi-dial-rings i:nth-child(3){width:120%;height:23%;border-style:dashed;transform:translate(-50%,-50%) rotate(42deg)}.qi-large-crescent{position:absolute;width:46%;aspect-ratio:1;border-radius:50%;background:#5b5c88;box-shadow:0 0 28px rgba(79,78,124,.24)}.qi-large-crescent:after{content:"";position:absolute;left:26%;top:-7%;width:100%;height:100%;border-radius:50%;background:#f5f1f5}.qi-ritual-dial strong,.qi-ritual-dial>small{position:absolute;z-index:3;left:50%;transform:translateX(-50%);white-space:nowrap}.qi-ritual-dial strong{bottom:22%;font-size:17px;font-weight:400;letter-spacing:.2em}.qi-ritual-dial>small{bottom:15%;color:#7d7c9e;font:8px/1 system-ui,sans-serif;letter-spacing:.1em}.qi-dial-star{position:absolute;color:#5e5f8c}.qi-dial-star.s1{left:12%;top:48%}.qi-dial-star.s2{right:13%;top:28%}.qi-dial-star.s3{right:25%;bottom:12%}.qi-ritual-dial.is-complete .qi-large-crescent{background:#fffdf0;box-shadow:0 0 34px rgba(255,250,215,.9)}.qi-ritual-days{display:flex;justify-content:center;gap:8px;margin:0 auto;padding:0;list-style:none}.qi-ritual-days li{display:grid;place-items:center;gap:3px;width:88px;padding:10px 6px;border-top:1px solid rgba(65,66,108,.18);color:rgba(58,60,99,.42)}.qi-ritual-days li i{font-size:19px;font-style:normal}.qi-ritual-days li span{font-size:10px}.qi-ritual-days li small{font:7px/1.5 system-ui,sans-serif}.qi-ritual-days li.is-done{color:#5a5b85}.qi-ritual-days li.is-today{border-top-color:#5a5b85;color:#42436c}.qi-ritual-button{margin:27px auto 0;padding:13px 28px;border:1px solid #5d5e8b;border-radius:50%;background:rgba(255,255,255,.26);color:#45476f;cursor:pointer;letter-spacing:.1em}.qi-ritual-button i{margin-right:10px;color:#a98642;font-style:normal}.qi-ritual-button:disabled{opacity:.55;cursor:default}
                .qi-task-page,.qi-shop-page{max-width:1050px;min-height:calc(100vh - 192px);margin:0 auto;padding-top:30px}.qi-task-page>header h2,.qi-shop-page>header h2{margin:0;color:#44466f;font-size:clamp(48px,5.5vw,76px);font-weight:400}.qi-task-page>header>span,.qi-shop-page>header>span{display:block;margin-top:15px;color:#747593;font-size:12px;line-height:1.8}.qi-task-page>header p{color:#7773a1}.qi-archive-index{display:flex;justify-content:space-between;margin-top:36px;padding:14px 0;border-top:1px solid rgba(67,68,111,.35);border-bottom:1px double rgba(67,68,111,.23);color:#55577e}.qi-archive-index span{font-size:12px;letter-spacing:.16em}.qi-archive-index b{font:15px/1 system-ui,sans-serif;font-weight:400}.qi-task-list{margin:0;padding:0;list-style:none}.qi-task-list li{display:grid;grid-template-columns:45px 1fr 55px 88px;align-items:center;gap:14px;min-height:86px;border-bottom:1px solid rgba(67,68,111,.16);color:#555678}.qi-task-list>li>i{color:#9796ae;font:10px/1 system-ui,sans-serif;font-style:normal}.qi-task-list li>div{display:grid;gap:6px}.qi-task-list li>div b{font-size:14px;font-weight:400}.qi-task-list li>div small{color:#9291aa;font:8px/1 system-ui,sans-serif;letter-spacing:.08em}.qi-task-list li>div>span{width:min(320px,90%);height:1px;background:rgba(72,73,115,.13)}.qi-task-list li>div>span em{display:block;height:1px;background:#65668f}.qi-task-list li>p{font:10px/1 system-ui,sans-serif}.qi-task-list li>button{padding:8px 0;border:0;border-bottom:1px solid #696a91;background:transparent;color:#50527a;cursor:pointer;font:10px/1.4 system-ui,sans-serif}.qi-task-list li>button span{display:block;color:#a7833f;font-size:8px}.qi-task-list li>button:disabled{border-color:rgba(80,82,122,.18);color:#aaa9ba;cursor:default}.qi-task-page>footer{display:flex;align-items:center;gap:18px;margin-top:28px;color:#85849f}.qi-task-page>footer i{display:grid;place-items:center;width:44px;height:44px;border:1px solid rgba(77,78,118,.24);border-radius:50%;font-style:normal}.qi-task-page>footer p{font-size:11px}.qi-shop-page>header h2{color:var(--moon)}.qi-shop-page>header>span{color:rgba(235,238,255,.54)}.qi-shop-window{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin-top:37px;background:rgba(230,236,255,.16);border-top:1px solid rgba(230,236,255,.22);border-bottom:1px solid rgba(230,236,255,.22)}.qi-shop-window article{position:relative;padding:25px;background:rgba(10,18,55,.55)}.qi-shop-object{display:grid;place-items:center;height:250px;border:1px solid rgba(233,238,255,.14);border-radius:50% 50% 0 0/32% 32% 0 0;background:radial-gradient(circle at 50% 44%,rgba(204,213,255,.22),transparent 46%);color:rgba(245,245,255,.82)}.qi-shop-object svg{width:145px;height:145px;overflow:visible}.qi-shop-object svg circle{fill:none;stroke:currentColor;stroke-width:.8;stroke-dasharray:2 5}.qi-shop-object svg path{fill:none;stroke:currentColor;stroke-width:1.5;stroke-linejoin:round}.qi-shop-object.is-crane svg path{fill:rgba(255,255,255,.07)}.qi-shop-caption{padding:17px 0}.qi-shop-caption small{color:rgba(230,235,255,.42);font:7px/1 system-ui,sans-serif;letter-spacing:.16em}.qi-shop-caption h3{min-height:40px;margin:8px 0 4px;font-size:15px;font-weight:400}.qi-shop-caption p{margin:0;color:var(--gold);font:10px/1 system-ui,sans-serif}.qi-shop-window article>button{width:100%;padding:10px 0;border:1px solid rgba(234,239,255,.28);background:transparent;color:#fff;cursor:pointer}.qi-shop-window article>button:disabled{opacity:.38;cursor:default}.qi-shop-window article.is-bought .qi-shop-object{opacity:.45}.qi-shop-page>footer{display:flex;justify-content:space-between;margin-top:20px;color:rgba(232,236,255,.38);font:8px/1.5 system-ui,sans-serif}
                .qi-cover{display:flex;align-items:center;background:linear-gradient(105deg,rgba(238,232,220,.98) 0 61%,rgba(219,212,201,.85) 79%,rgba(177,67,60,.07)),repeating-linear-gradient(0deg,transparent 0 7px,rgba(23,36,51,.02) 8px)}.qi-cover>section{position:relative;z-index:3;width:min(700px,70vw);margin-left:clamp(30px,9vw,145px);padding:80px 0}.qi-cover h1{margin:0;font-size:clamp(72px,10vw,142px);font-weight:500;line-height:.83;letter-spacing:-.08em}.qi-cover h1 em{color:transparent;-webkit-text-stroke:1px rgba(23,36,51,.45);font-style:normal}.qi-cover section>p:not(.qi-kicker){margin:42px 0 25px;color:#53606b;line-height:1.8}.qi-cover section>small{display:block;margin-top:22px;color:#899196;font:9px/1.6 system-ui,sans-serif}.qi-cover-caret{position:absolute;right:7vw;top:16vh;width:29vw;height:68vh;border-left:1px solid rgba(23,36,51,.1);border-right:1px solid rgba(177,67,60,.12);transform:skewY(-5deg)}.qi-cover-caret:after{content:"";position:absolute;left:51%;top:15%;width:1px;height:68%;background:rgba(177,67,60,.22);animation:qi-caret 1.2s steps(1) infinite}.qi-cover-caret i{position:absolute;width:6px;height:6px;border-radius:50%;background:rgba(23,36,51,.12)}.qi-cover-caret i:nth-child(1){left:20%;top:29%}.qi-cover-caret i:nth-child(2){left:50%;top:68%;background:rgba(177,67,60,.3)}.qi-cover-caret i:nth-child(3){right:14%;top:45%}
                .qi-fake-chat{display:flex;flex-direction:column;background:#f4f3f1;color:#1b2630;font-family:system-ui,-apple-system,sans-serif}.qi-fake-chat>header{position:sticky;z-index:4;top:0;display:flex;align-items:center;height:74px;padding:10px 20px;border-bottom:1px solid #e2e2df;background:rgba(248,248,246,.95);backdrop-filter:blur(14px)}.qi-fake-chat>header>button{border:0;background:transparent;font-size:27px}.qi-chat-avatar{display:grid;place-items:center;width:43px;height:43px;margin-left:12px;border-radius:50%;background:#14263b;color:#eee;font-family:serif}.qi-fake-chat>header>span{display:grid;margin-left:11px}.qi-fake-chat>header b{font-size:14px}.qi-fake-chat>header small{margin-top:3px;color:#65a079;font-size:9px}.qi-fake-chat>header>i{margin-left:auto;margin-right:48px;color:#899096;font-style:normal}.qi-chat-thread{flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:10px;width:min(760px,100%);margin:0 auto;padding:38px 24px 120px}.qi-chat-thread time{align-self:center;margin-bottom:20px;color:#a3a8ab;font-size:10px}.qi-bubble{max-width:74%;padding:12px 15px;border-radius:4px 17px 17px 17px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.06);font-size:14px;line-height:1.65}.qi-bubble.is-char{border-left:2px solid #172f46}.qi-system-line{align-self:center;margin:18px 0;color:#a1a5a7;font-size:10px}.qi-typing-dots{display:flex;gap:4px;padding:13px 17px;border-radius:4px 17px 17px 17px;background:#fff}.qi-typing-dots i{width:4px;height:4px;border-radius:50%;background:#8e969a;animation:qi-dot 1.1s infinite}.qi-typing-dots i:nth-child(2){animation-delay:.16s}.qi-typing-dots i:nth-child(3){animation-delay:.32s}.qi-chat-input{position:fixed;z-index:5;left:0;right:0;bottom:0;display:flex;gap:10px;padding:12px 17px calc(12px + env(safe-area-inset-bottom));border-top:1px solid #dfdfdc;background:#f7f7f5}.qi-chat-input>button{border:0;background:transparent}.qi-chat-input>button:first-child,.qi-chat-input>button:last-child{display:grid;place-items:center;width:38px;height:38px;border:1px solid #d6d8d7;border-radius:50%;color:#53606a}.qi-input-field{flex:1;padding:10px 15px!important;border:1px solid #dadcda!important;border-radius:19px!important;background:#fff!important;color:#8c9294;text-align:left!important;font-size:12px}
                .qi-distort{isolation:isolate;overflow:hidden;background:radial-gradient(circle at 50% 73%,#fffdf1 0,#e2e9ff 24%,#c8caeb 48%,#9fafd8 77%,#7287b8 120%);color:#34304f;font-family:"Noto Serif SC","Songti SC",serif}.qi-distort:before{content:"";position:absolute;z-index:-1;inset:-15%;background:radial-gradient(circle at 20% 25%,rgba(255,255,255,.7),transparent 24%),radial-gradient(circle at 84% 16%,rgba(250,221,238,.5),transparent 21%),radial-gradient(circle at 18% 82%,rgba(213,235,255,.75),transparent 27%);filter:blur(14px);animation:qi-wonder-cloud 9s ease-in-out infinite alternate}.qi-wonderland-tunnel{position:absolute;z-index:-1;inset:0;width:100%;height:100%;opacity:.92}.qi-wonder-rings{transform-origin:300px 594px;animation:qi-wonder-ring 18s linear infinite}.qi-pocket-watch{transform-origin:455px 212px;animation:qi-watch-float 5.8s ease-in-out infinite}.qi-wonder-key{transform-origin:104px 575px;animation:qi-key-float 6.7s ease-in-out infinite}.qi-white-rabbit{transform-origin:324px 705px;filter:drop-shadow(0 12px 16px rgba(93,88,132,.17));animation:qi-rabbit-hop 3.2s ease-in-out infinite}.qi-broken-header{position:absolute;z-index:5;left:0;right:0;top:0;display:grid;grid-template-columns:1fr auto;align-items:end;height:78px;padding:22px 9vw 17px;border-bottom:1px solid rgba(79,72,110,.15);background:linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,.08));font-size:15px;font-weight:400;letter-spacing:.08em;backdrop-filter:blur(8px)}.qi-broken-header small{grid-column:1/3;margin-bottom:6px;color:rgba(75,68,105,.45);font:7px/1 system-ui,sans-serif;letter-spacing:.24em}.qi-broken-header span{color:#8f6382;font:8px/1 system-ui,sans-serif;letter-spacing:.16em}.qi-shard{position:absolute;z-index:3;padding:10px 15px;border:1px solid rgba(100,89,133,.18);border-radius:2px;background:rgba(255,253,247,.66);box-shadow:0 10px 24px rgba(96,92,132,.08);color:#4e4967;font-size:11px;letter-spacing:.04em;backdrop-filter:blur(5px);animation:qi-card-drift 4.8s ease-in-out infinite}.qi-shard:before{content:"◇";margin-right:8px;color:#c19a69}.qi-shard.s1{left:9%;top:19%;transform:rotate(-7deg);animation-delay:-1.1s}.qi-shard.s2{right:10%;top:16%;color:#8f6382;transform:rotate(9deg);animation-delay:-2.6s}.qi-shard.s2:before{content:"♧"}.qi-shard.s3{left:18%;top:42%;transform:rotate(-12deg);animation-delay:-3.4s}.qi-shard.s3:before{content:"◷"}.qi-shard.s4{right:6%;top:51%;transform:rotate(11deg);animation-delay:-.4s}.qi-shard.s4:before{content:"♡"}.qi-shard.s5{left:7%;bottom:13%;color:#866179;transform:rotate(5deg);animation-delay:-2s}.qi-shard.s5:before{content:"♢"}.qi-shard.s6{right:8%;bottom:7%;padding:0;border:0;background:transparent;box-shadow:none;color:rgba(255,255,255,.72);font-size:44px;opacity:.72;animation:qi-suit-spin 9s linear infinite}.qi-shard.s6:before{display:none}.qi-rabbit-door{position:absolute;z-index:6;left:50%;top:66%;display:grid;grid-template-columns:1fr auto;align-items:center;gap:18px;width:min(360px,74vw);min-height:104px;padding:20px 25px;border:1px solid rgba(114,99,148,.32);border-radius:50%;background:radial-gradient(ellipse at center,rgba(255,253,240,.96),rgba(226,232,255,.78) 56%,rgba(150,150,202,.38) 100%);color:#443e63;cursor:pointer;box-shadow:0 0 0 9px rgba(255,255,255,.12),0 22px 50px rgba(84,78,127,.18),inset 0 0 22px rgba(255,255,255,.7);transform:translate(-50%,-50%);transition:transform .25s,box-shadow .25s}.qi-rabbit-door:hover{transform:translate(-50%,-53%) scale(1.015);box-shadow:0 0 0 12px rgba(255,255,255,.14),0 28px 58px rgba(84,78,127,.23),inset 0 0 26px #fff}.qi-rabbit-door>span{display:grid;gap:7px;text-align:left}.qi-rabbit-door small{color:#8e86a5;font:7px/1 system-ui,sans-serif;letter-spacing:.13em}.qi-rabbit-door b{font-size:15px;font-weight:400;letter-spacing:.05em}.qi-rabbit-door>i{color:#ad7e72;font:10px/1.5 system-ui,sans-serif;font-style:normal;letter-spacing:.1em}
                .qi-interlayer{color:#ece7dc;background:radial-gradient(circle at 70% 20%,rgba(212,180,120,.08),transparent 25%),linear-gradient(145deg,var(--night2),var(--night) 65%,#050b12)}.qi-interlayer:after{content:"";position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.16;background-image:linear-gradient(90deg,transparent 49.8%,rgba(255,255,255,.06) 50%,transparent 50.2%),radial-gradient(rgba(255,255,255,.7) .5px,transparent .7px);background-size:210px 100%,19px 19px}.qi-interlayer .qi-exit{color:#ece7dc}.qi-interlayer .qi-kicker{color:var(--gold)}.qi-entry{display:flex;align-items:center}.qi-entry>section{position:relative;z-index:3;width:min(760px,82vw);margin:0 auto;padding:90px 0}.qi-entry h2{margin:0;font-size:clamp(51px,7vw,94px);font-weight:400;line-height:1.03;letter-spacing:-.06em}.qi-entry>section>p:not(.qi-kicker){color:#98a6ae;line-height:1.9}.qi-entry aside{margin:30px 0;padding:18px 0 18px 20px;border-left:2px solid var(--red);color:#b2bbc0}.qi-interlayer .qi-text-action{color:#ece7dc}
                .qi-explore{padding:86px clamp(22px,7vw,105px) 64px}.qi-route-count{position:fixed;z-index:8;left:clamp(18px,5vw,72px);top:27px;color:#647784;font:8px/1 system-ui,sans-serif;letter-spacing:.12em}.qi-explore>header{position:relative;z-index:3;width:min(820px,66vw);margin-top:3vh}.qi-explore>header h2{margin:0;font-size:clamp(44px,6vw,82px);font-weight:400;line-height:1.06;letter-spacing:-.055em}.qi-explore>header>p:not(.qi-kicker){color:#91a1aa;line-height:1.8}.qi-explore>header em{display:block;margin-top:13px;color:#b4bdc1;font-size:12px;line-height:1.8;font-style:normal}.qi-node-body{position:relative;z-index:4;display:grid;grid-template-columns:minmax(300px,.8fr) minmax(380px,1.2fr);gap:7vw;width:min(1080px,100%);margin:48px auto 0}.qi-node-body>aside{padding:20px 0 20px 21px;border-left:1px solid rgba(212,180,120,.28)}.qi-node-body>aside small,.qi-node-actions>small,.qi-response small,.qi-exits>small{color:#6e8290;font:8px/1 system-ui,sans-serif;letter-spacing:.14em}.qi-node-body>aside p{color:#bec5c8;line-height:1.8}.qi-node-body blockquote{margin:22px 0 0;color:#d0ad77;font-size:12px;line-height:1.8}.qi-node-actions{display:grid;align-content:start}.qi-node-actions>small{margin-bottom:10px}.qi-node-actions>button{display:flex;justify-content:space-between;padding:15px 2px;border:0;border-bottom:1px solid rgba(236,231,220,.13);background:transparent;color:#ece7dc;text-align:left;cursor:pointer}.qi-node-actions>button span{color:#a9544d}.qi-response{padding:22px 0;border-top:1px solid rgba(236,231,220,.14);border-bottom:1px solid rgba(236,231,220,.14)}.qi-response p{margin:12px 0;color:#c5cbcd;line-height:1.85}.qi-exits{position:relative;z-index:4;width:min(1080px,100%);margin:55px auto 0;border-top:1px solid rgba(236,231,220,.13)}.qi-exits>small{display:block;margin-top:-23px;margin-bottom:9px}.qi-exits>button{display:grid;grid-template-columns:48px 1fr auto;width:100%;padding:16px 2px;border:0;border-bottom:1px solid rgba(236,231,220,.13);background:transparent;color:#ece7dc;text-align:left;cursor:pointer}.qi-exits button i{color:#657987;font:9px/1.5 system-ui,sans-serif;font-style:normal}.qi-exits button strong{font-weight:400}.qi-exits button span{color:#81939d;font:9px/1.5 system-ui,sans-serif}.qi-exits button.is-hidden-route{border-color:rgba(177,67,60,.45);color:#dfb2aa}.qi-exits>p{color:#7f919a;font-size:11px;line-height:1.7}.qi-trace-pocket{position:fixed;z-index:8;left:18px;bottom:18px;display:flex;gap:5px;max-width:76vw;overflow:hidden}.qi-trace-pocket span{flex:none;padding:4px 6px;border:1px solid rgba(212,180,120,.14);color:#667b88;font:7px/1 system-ui,sans-serif}
                .qi-core{display:flex;align-items:center;color:#eee8dd;background:radial-gradient(circle at 18% 48%,rgba(177,67,60,.15),transparent 27%),linear-gradient(110deg,#050a0e,#0c1923 72%,#05090d)}.qi-core>section{position:relative;z-index:4;width:min(720px,55vw);margin-left:clamp(32px,9vw,150px);padding:90px 0}.qi-core h2{margin:0;font-size:clamp(43px,6vw,79px);font-weight:400;line-height:1.07;letter-spacing:-.05em}.qi-core blockquote{margin:30px 0;color:#b9c0c3;font-size:clamp(14px,1.7vw,19px);line-height:2}.qi-core .qi-text-action{color:#eee8dd}.qi-core-figure{position:absolute;z-index:2;right:8vw;top:14vh;width:28vw;height:72vh;border-left:1px solid rgba(212,180,120,.13);border-right:1px solid rgba(177,67,60,.15);clip-path:polygon(34% 0,72% 0,82% 30%,100% 100%,0 100%,19% 30%)}.qi-core-figure span{position:absolute;left:50%;top:22%;transform:translateX(-50%);color:rgba(238,232,221,.2);font-size:78px}.qi-core-figure i{position:absolute;left:50%;top:43%;width:1px;height:47%;background:linear-gradient(rgba(212,180,120,.4),transparent)}
                .qi-black{background:#000;color:#f4f1ec}.qi-touch-area{position:absolute;inset:0;overflow:hidden;touch-action:none;user-select:none;cursor:crosshair}.qi-blessing{position:absolute;z-index:6;left:50%;top:50%;width:min(720px,84vw);transform:translate(-50%,-50%);pointer-events:none;animation:qi-fade 1s both}.qi-blessing small,.qi-touch-copy small,.qi-ending small{display:block;margin-bottom:24px;color:rgba(255,255,255,.32);font:9px/1 system-ui,sans-serif;letter-spacing:.24em}.qi-blessing p{margin:0 0 15px;font-size:clamp(14px,1.8vw,20px);line-height:1.9;letter-spacing:.035em}.qi-blessing b{display:block;margin-top:30px;color:rgba(255,255,255,.42);font:10px/1.6 system-ui,sans-serif;font-weight:400}.qi-touch-copy{position:absolute;z-index:7;left:50%;top:34%;width:min(560px,84vw);transform:translate(-50%,-50%);text-align:center;pointer-events:none}.qi-touch-copy p{margin:0;font-size:clamp(21px,3vw,31px)}.qi-touch-copy span{display:block;margin-top:18px;color:rgba(255,255,255,.38);font:11px/1.7 system-ui,sans-serif}.qi-touch-area svg{position:absolute;inset:0;width:100%;height:100%;opacity:0;pointer-events:none}.qi-touch-area svg path{fill:none;stroke:rgba(177,67,60,.7);stroke-width:.18;vector-effect:non-scaling-stroke;stroke-dasharray:1 1}.qi-user-finger,.qi-char-finger{position:absolute;z-index:4;left:var(--touch-x);top:var(--touch-y);width:19px;height:34px;border:1px solid rgba(255,255,255,.5);border-radius:10px 10px 13px 13px;transform:translate(-50%,-50%) rotate(24deg) scale(0);opacity:0;pointer-events:none;box-shadow:0 0 23px rgba(255,255,255,.13)}.qi-user-finger i,.qi-char-finger i{position:absolute;right:-9px;top:3px;width:13px;height:16px;border-right:1px solid rgba(255,255,255,.45);border-bottom:1px solid rgba(255,255,255,.45);border-radius:0 0 10px 0}.qi-char-finger{left:102%;top:8%;border-color:rgba(177,67,60,.85);transform:translate(-50%,-50%) rotate(-150deg) scale(0);transition:left 1.05s cubic-bezier(.22,.75,.28,1),top 1.05s cubic-bezier(.22,.75,.28,1),transform .35s,opacity .35s}.qi-char-finger i{border-color:rgba(177,67,60,.85)}.qi-touch-area.is-active .qi-user-finger,.qi-touch-area.is-joined .qi-user-finger{opacity:1;transform:translate(-50%,-50%) rotate(24deg) scale(1)}.qi-touch-area.is-approaching .qi-char-finger,.qi-touch-area.is-joined .qi-char-finger{left:calc(var(--touch-x) + 1.1%);top:calc(var(--touch-y) - .5%);opacity:1;transform:translate(-50%,-50%) rotate(-150deg) scale(1)}.qi-touch-area.is-approaching svg,.qi-touch-area.is-joined svg{opacity:1;animation:qi-thread 1.05s ease both}.qi-touch-area.is-joined .qi-user-finger{transform:translate(-50%,-50%) rotate(18deg) scale(1)}.qi-touch-area.is-joined .qi-char-finger{transform:translate(-50%,-50%) rotate(-164deg) scale(1)}.qi-ending{display:flex;align-items:center;justify-content:center;text-align:center}.qi-ending section{width:min(650px,84vw);animation:qi-fade 1.2s both}.qi-ending h2{margin:0;font-size:clamp(36px,6vw,70px);font-weight:400}.qi-ending section>p{color:rgba(255,255,255,.45);line-height:1.8}.qi-ending section>p:last-of-type{margin-top:28px;color:#b95850;font-size:12px;letter-spacing:.28em}.qi-ending section>div{display:flex;justify-content:center;gap:25px;margin-top:38px}.qi-ending section button{padding:11px 1px;border:0;border-bottom:1px solid rgba(255,255,255,.18);background:transparent;color:rgba(255,255,255,.58);cursor:pointer}
                .qi-event-header{grid-template-columns:1fr auto;padding-right:76px}.qi-event-brand{display:grid;justify-self:start;text-align:left}.qi-event-brand span{font-size:14px;letter-spacing:.14em}.qi-event-brand small{margin-top:3px;color:rgba(241,243,255,.48);font:7px/1 system-ui,sans-serif;letter-spacing:.23em}.qi-event-page{padding-bottom:24px}.qi-home-hero{min-height:calc(100vh - 114px)}.qi-home-hero .qi-dream-arch>path{display:none}.qi-home-crescent{position:absolute;z-index:2;right:12%;top:12%;width:92px;aspect-ratio:1;border-radius:50%;background:var(--moon);box-shadow:0 0 34px rgba(255,253,231,.32)}.qi-home-crescent:after{content:"";position:absolute;left:29%;top:-12%;width:100%;height:100%;border-radius:50%;background:#19327f}.qi-home-resume{display:block;margin:14px auto 0;padding:5px 0;border:0;border-bottom:1px solid rgba(239,242,255,.28);background:transparent;color:rgba(242,244,255,.62);cursor:pointer;font-size:10px;letter-spacing:.08em}
                .qi-event-shell.is-home .qi-celestial-backdrop{opacity:.52;filter:blur(1.4px)}.qi-home-hero>.qi-dream-arch{opacity:.56;filter:blur(.7px) drop-shadow(0 0 17px rgba(214,225,255,.13))}.qi-home-title{isolation:isolate;display:flex;flex-direction:column;align-items:center;width:min(540px,90vw);padding:31px 34px}.qi-home-title:before{content:"";position:absolute;z-index:-1;inset:-7% -10%;background:radial-gradient(ellipse at center,rgba(19,38,104,.68) 0,rgba(19,38,104,.46) 48%,rgba(19,38,104,0) 76%);backdrop-filter:blur(5.5px);-webkit-mask-image:radial-gradient(ellipse at center,#000 42%,transparent 76%);mask-image:radial-gradient(ellipse at center,#000 42%,transparent 76%);pointer-events:none}.qi-home-title h1{text-shadow:0 2px 3px rgba(4,9,34,.38),0 0 29px rgba(238,242,255,.22)}.qi-home-title>em{color:rgba(247,248,255,.68)}.qi-home-title blockquote{color:rgba(251,250,245,.9);text-shadow:0 1px 7px rgba(3,8,31,.7)}.qi-primary-orbit{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;width:236px;min-width:236px;min-height:66px;padding:11px 28px;margin-inline:auto;text-align:center}.qi-primary-orbit i{position:absolute;left:24px;top:50%;grid-row:auto;transform:translateY(-50%)}.qi-primary-orbit span,.qi-primary-orbit small{display:block;width:100%;text-align:center}.qi-primary-orbit span{padding-left:.18em}
                .qi-home-title h1{display:grid;place-items:center;gap:8px;font-size:clamp(52px,7.2vw,92px);line-height:1;letter-spacing:0}.qi-home-title h1>span{display:block;padding-left:.5em;color:rgba(255,253,242,.9);font-size:.39em;line-height:1;letter-spacing:.5em}.qi-home-title h1>b{display:block;padding-left:.075em;font:inherit;font-weight:400;line-height:.92;letter-spacing:.075em}.qi-home-title>em{margin-top:16px;letter-spacing:.31em}.qi-home-title blockquote{margin:25px auto 22px;font-size:12px;line-height:2.05;letter-spacing:.075em}.qi-primary-orbit{width:224px;min-width:224px;min-height:62px;padding:9px 26px}.qi-primary-orbit span{font-size:14px;letter-spacing:.2em}.qi-primary-orbit small{font-size:6.5px;letter-spacing:.18em}.qi-home-resume{margin-top:17px;color:rgba(235,239,255,.48);font-size:9px;letter-spacing:.1em}
                .qi-interlayer{isolation:isolate;background:radial-gradient(circle at 54% 2%,#2548aa 0,#142863 27%,#0b1742 60%,#060d29 100%)}.qi-interlayer:before{content:"";position:fixed;z-index:-1;left:-18%;right:-18%;bottom:-24vh;height:48vh;border:1px solid rgba(223,231,255,.18);border-radius:50% 50% 0 0/100% 100% 0 0;box-shadow:0 -45px 100px rgba(84,107,204,.08);pointer-events:none}.qi-interlayer:after{opacity:.2;background-image:linear-gradient(90deg,transparent 49.8%,rgba(215,225,255,.05) 50%,transparent 50.2%),radial-gradient(rgba(255,255,255,.75) .5px,transparent .8px);background-size:230px 100%,21px 21px}.qi-interlayer>.qi-celestial-backdrop{opacity:.34}.qi-story-brand{position:fixed;z-index:8;left:24px;top:max(19px,env(safe-area-inset-top));display:grid;color:rgba(245,246,255,.78)}.qi-story-brand span{font-size:11px;letter-spacing:.16em}.qi-story-brand small{margin-top:4px;color:rgba(224,230,255,.36);font:6px/1 system-ui,sans-serif;letter-spacing:.22em}.qi-story-phases{position:fixed;z-index:8;left:50%;top:max(25px,env(safe-area-inset-top));transform:translateX(-50%);color:rgba(239,242,255,.58)}.qi-story-arch{position:fixed;z-index:-1;left:50%;top:79px;width:min(860px,82vw);height:47vh;transform:translateX(-50%);border:1px solid rgba(229,235,255,.15);border-bottom:0;border-radius:50% 50% 0 0/72% 72% 0 0;pointer-events:none}.qi-story-arch:before,.qi-story-arch:after{content:"";position:absolute;left:50%;top:53%;border:1px solid rgba(229,235,255,.1);border-radius:50%;transform:translate(-50%,-50%) rotate(-12deg)}.qi-story-arch:before{width:78%;height:48%}.qi-story-arch:after{width:56%;height:78%;border-style:dashed;transform:translate(-50%,-50%) rotate(28deg)}.qi-story-arch i{position:absolute;width:5px;height:5px;border-radius:50%;background:#fff;box-shadow:0 0 12px #fff}.qi-story-arch i:nth-child(1){left:12%;top:48%}.qi-story-arch i:nth-child(2){right:16%;top:30%}.qi-story-arch i:nth-child(3){left:54%;bottom:3%;background:var(--gold)}
                .qi-entry>section{width:min(790px,82vw);padding-top:124px}.qi-entry .qi-kicker,.qi-explore .qi-kicker{color:var(--gold)}.qi-entry h2{color:var(--moon);text-shadow:0 0 28px rgba(238,242,255,.12)}.qi-entry-moon{position:absolute;z-index:-1;right:3%;top:17%;width:160px;aspect-ratio:1;border:1px solid rgba(237,242,255,.24);border-radius:50%;box-shadow:0 0 0 16px rgba(237,242,255,.025)}.qi-entry-moon i{position:absolute;inset:22%;border-radius:50%;background:rgba(255,253,240,.85)}.qi-entry-moon i:after{content:"";position:absolute;left:28%;top:-9%;width:100%;height:100%;border-radius:50%;background:#14265d}.qi-entry aside{border-left-color:var(--gold);background:linear-gradient(90deg,rgba(196,207,255,.06),transparent)}.qi-interlayer .qi-text-action{border-color:rgba(233,238,255,.17)}.qi-interlayer .qi-text-action i{color:var(--gold)}
                .qi-explore{padding-top:118px}.qi-route-count{left:auto;right:92px;top:31px;color:rgba(229,234,255,.5)}.qi-route-count i{margin-right:7px;color:var(--gold);font-style:normal}.qi-night-progress{position:relative;z-index:4;display:grid;grid-template-columns:42px 74px 1fr auto;align-items:center;gap:13px;width:min(900px,78vw);margin:3vh auto 0;padding:0 0 13px;border-bottom:1px solid rgba(232,237,255,.14)}.qi-night-progress>span{color:var(--gold);font:8px/1 system-ui,sans-serif;letter-spacing:.18em}.qi-night-progress>b{color:#f3f1e9;font-size:17px;font-weight:400;letter-spacing:.16em}.qi-night-progress>small{color:rgba(219,226,247,.48);font:8px/1.5 system-ui,sans-serif;letter-spacing:.08em}.qi-night-progress>i{display:flex;gap:6px;font-style:normal}.qi-night-progress>i em{display:block;width:24px;height:1px;background:rgba(232,237,255,.14);transition:background .45s,box-shadow .45s}.qi-night-progress>i em.is-lit{background:var(--gold);box-shadow:0 0 8px rgba(231,212,155,.55)}.qi-explore>header{width:min(900px,78vw);margin:28px auto 0;padding-right:145px}.qi-location-seal{position:absolute;right:0;top:-19px;display:grid;place-items:center;width:116px;height:116px;border:1px solid rgba(231,237,255,.22);border-radius:50%;box-shadow:0 0 0 11px rgba(231,237,255,.025),0 0 35px rgba(157,176,255,.08)}.qi-location-seal:before,.qi-location-seal:after{content:"";position:absolute;inset:17%;border:1px dashed rgba(231,237,255,.17);border-radius:50%}.qi-location-seal:after{inset:46%;border:0;background:var(--gold);box-shadow:0 -44px 0 rgba(237,241,255,.38),0 44px 0 rgba(237,241,255,.38)}.qi-location-seal i{position:relative;z-index:2;color:rgba(246,246,255,.72);font:14px/1 system-ui,sans-serif;font-style:normal}.qi-location-seal span{position:absolute;left:-17px;right:-17px;top:50%;border-top:1px solid rgba(231,237,255,.14);transform:rotate(-16deg)}.qi-explore>header h2{color:var(--moon);font-size:clamp(48px,6.5vw,88px);text-shadow:0 0 30px rgba(232,237,255,.11)}.qi-explore>header>p:not(.qi-kicker){max-width:710px;color:#b7c2dc;font-size:14px}.qi-explore>header em{color:#d0d5e6}.qi-node-body{gap:6vw;margin-top:55px;padding:30px clamp(22px,4vw,54px);border-top:1px solid rgba(232,237,255,.16);border-bottom:1px solid rgba(232,237,255,.1);background:linear-gradient(90deg,rgba(163,180,241,.035),rgba(255,255,255,.018),rgba(163,180,241,.035));backdrop-filter:blur(5px)}.qi-node-body>aside{border-left-color:rgba(231,212,155,.5)}.qi-node-body>aside small,.qi-node-actions>small,.qi-response small,.qi-exits>small{color:#9ca9cc}.qi-node-body>aside p{color:#d4d9e8}.qi-node-actions>button{position:relative;padding:17px 27px 17px 2px;border-color:rgba(232,237,255,.14);color:#f2f1ed;transition:padding-left .2s,color .2s}.qi-node-actions>button:before{content:"✦";position:absolute;left:-18px;color:var(--gold);opacity:0;transition:opacity .2s}.qi-node-actions>button:hover{padding-left:18px;color:#fff}.qi-node-actions>button:hover:before{opacity:1}.qi-node-actions>button span{color:var(--gold)}.qi-response{border-color:rgba(232,237,255,.16)}.qi-response p{color:#d5d9e5}.qi-leave-node{display:flex;align-items:center;justify-content:space-between;width:100%;margin-top:19px;padding:14px 1px;border:0;border-top:1px solid rgba(232,237,255,.2);border-bottom:1px solid rgba(232,237,255,.12);background:transparent;color:#fff;cursor:pointer;text-align:left}.qi-leave-node>span{display:grid;gap:5px}.qi-leave-node b{font-size:16px;font-weight:400;letter-spacing:.18em}.qi-leave-node small{font:8px/1 system-ui,sans-serif;letter-spacing:.08em}.qi-leave-node>i{color:var(--gold);font-style:normal;transition:transform .2s}.qi-leave-node:hover>i{transform:translateY(3px)}.qi-left-node{display:flex;align-items:center;gap:9px;margin-top:18px;color:rgba(220,226,244,.48);font-size:10px}.qi-left-node i{color:var(--gold);font-style:normal}.qi-exits{margin-top:70px;border-top-color:rgba(232,237,255,.18)}.qi-exits>small{margin-bottom:15px}.qi-exits>button{grid-template-columns:64px 1fr auto;align-items:center;min-height:74px;padding:10px 4px;border-bottom-color:rgba(232,237,255,.14);transition:background .2s,padding .2s}.qi-exits>button:hover{padding-left:12px;background:linear-gradient(90deg,rgba(126,149,231,.09),transparent)}.qi-exits button i{display:grid;place-items:center;width:42px;height:42px;border:1px solid rgba(231,237,255,.24);border-radius:50%;color:var(--gold);box-shadow:0 0 0 5px rgba(231,237,255,.02)}.qi-exits button strong{font-size:17px;letter-spacing:.05em}.qi-exits button span{color:#aeb9d6}.qi-exits button.is-hidden-route{border-color:rgba(231,212,155,.42);color:#fff2cc}.qi-trace-pocket{right:18px;left:auto}.qi-trace-pocket span{border-color:rgba(231,212,155,.2);color:#8796bd}
                .qi-mini-map{position:relative;z-index:4;width:min(1080px,100%);margin:72px auto 48px;padding-top:18px;border-top:1px solid rgba(232,237,255,.18);animation:qi-map-reveal .45s ease both}.qi-mini-map>header{display:flex;align-items:end;justify-content:space-between}.qi-mini-map>header>div{display:grid;gap:6px}.qi-mini-map>header small{color:var(--gold);font:8px/1 system-ui,sans-serif;letter-spacing:.2em}.qi-mini-map>header strong{font-size:18px;font-weight:400;letter-spacing:.08em}.qi-mini-map>header>span{color:rgba(219,227,250,.4);font:8px/1 system-ui,sans-serif;letter-spacing:.1em}.qi-mini-map-field{position:relative;height:370px;margin-top:23px;overflow:hidden;background:radial-gradient(circle at 50% 52%,rgba(92,117,210,.13),transparent 34%)}.qi-mini-map-field:before,.qi-mini-map-field:after{content:"";position:absolute;left:50%;top:52%;border:1px solid rgba(224,232,255,.08);border-radius:50%;transform:translate(-50%,-50%)}.qi-mini-map-field:before{width:62%;height:72%}.qi-mini-map-field:after{width:92%;height:116%;border-style:dashed}.qi-mini-map-field>svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.qi-mini-map-field line{stroke:rgba(231,237,255,.4);stroke-width:.34;stroke-dasharray:1.6 1.5;vector-effect:non-scaling-stroke}.qi-mini-map-field line.is-back{stroke:rgba(231,212,155,.72);stroke-dasharray:.7 2}.qi-mini-map-field circle{fill:rgba(22,37,94,.9);stroke:rgba(236,240,255,.32);stroke-width:.28;vector-effect:non-scaling-stroke}.qi-mini-map-field circle.is-orbit{fill:none;stroke:rgba(236,240,255,.1);stroke-dasharray:1 2}.qi-map-current{position:absolute;z-index:3;left:50%;top:52%;display:grid;place-items:center;width:150px;transform:translate(-50%,-50%);text-align:center;pointer-events:none}.qi-map-current i{display:grid;place-items:center;width:45px;height:45px;margin-bottom:9px;border:1px solid var(--gold);border-radius:50%;color:var(--gold);font:10px/1 system-ui,sans-serif;font-style:normal;box-shadow:0 0 0 8px rgba(236,240,255,.025),0 0 22px rgba(231,212,155,.12)}.qi-map-current b{font:7px/1 system-ui,sans-serif;font-weight:400;letter-spacing:.17em;color:rgba(226,232,251,.45)}.qi-map-current span{margin-top:5px;color:#fff;font-size:13px;line-height:1.35}.qi-local-node{position:absolute;z-index:4;display:grid;place-items:center;width:160px;padding:0;border:0;background:transparent;color:#f0f1f8;text-align:center;cursor:pointer;transform:translate(-50%,-50%);transition:color .2s,transform .2s}.qi-local-node:hover{color:#fff;transform:translate(-50%,-53%)}.qi-local-node>i{display:grid;place-items:center;width:39px;height:39px;margin-bottom:8px;border:1px solid rgba(230,236,255,.34);border-radius:50%;color:var(--gold);font:9px/1 system-ui,sans-serif;font-style:normal;background:rgba(10,20,61,.7);box-shadow:0 0 0 5px rgba(230,236,255,.02)}.qi-local-node b{font-size:13px;font-weight:400;line-height:1.35}.qi-local-node small{margin-top:5px;color:rgba(215,224,248,.43);font:7px/1 system-ui,sans-serif;letter-spacing:.07em}.qi-local-node.is-visited>i{border-color:rgba(231,212,155,.58)}.qi-local-node.is-back{color:#fff1c8}.qi-local-node.is-back>i{border-style:dashed;border-color:rgba(231,212,155,.72);color:var(--gold)}.qi-local-node.is-back small{color:rgba(255,239,194,.68)}.qi-local-node.is-back:hover{transform:translate(-50%,-53%)}.qi-map-secret{display:grid;grid-template-columns:54px 1fr;align-items:center;gap:15px;width:min(520px,100%);margin:0 auto;padding:13px 18px;border:1px solid rgba(231,212,155,.48);background:rgba(33,44,90,.46);color:#fff4ce;cursor:pointer;text-align:left}.qi-map-secret>i{display:grid;place-items:center;width:38px;height:38px;border:1px solid currentColor;border-radius:50%;font:9px/1 system-ui,sans-serif;font-style:normal}.qi-map-secret span{display:grid;gap:5px}.qi-map-secret b{font-weight:400}.qi-map-secret small{color:rgba(255,244,206,.54);font:8px/1 system-ui,sans-serif}.qi-map-locked{max-width:600px;margin:0 auto;padding:18px;border-top:1px solid rgba(231,212,155,.2);color:#9ba8c8;font-size:11px;line-height:1.8;text-align:center}
                .qi-memory-notice{max-width:310px;margin:13px auto 0;color:rgba(232,237,255,.55);font:8px/1.65 system-ui,sans-serif;letter-spacing:.08em}.qi-memory-notice.is-memory{color:rgba(255,242,194,.72)}.qi-memory-notice.is-loading:after{content:"";display:inline-block;width:12px;margin-left:6px;border-bottom:1px solid currentColor;animation:qi-memory-scan 1.1s ease-in-out infinite}.qi-primary-orbit:disabled,.qi-chapter-start:disabled,.qi-home-resume:disabled,.qi-resume-link:disabled{cursor:wait;opacity:.62}.qi-memory-evidence{display:grid;gap:8px;margin:23px 0 4px;padding:17px 17px 16px;border:1px solid rgba(231,212,155,.2);background:linear-gradient(135deg,rgba(231,212,155,.07),rgba(105,127,210,.06))}.qi-node-body>aside .qi-memory-evidence small{color:var(--gold)}.qi-memory-evidence b{color:#f2ead1;font-size:13px;font-weight:400;letter-spacing:.08em}.qi-node-body>aside .qi-memory-evidence p{margin:0;color:#dce1ee;font-size:12px;line-height:1.75}.qi-memory-evidence em{color:#9ba9cb;font-size:10px;line-height:1.75;font-style:normal}.qi-memory-extension{display:block;margin:15px 0 3px;padding-left:13px;border-left:1px solid var(--gold);color:#dacda9;font-size:11px;line-height:1.8;font-style:normal}.qi-final-echo{padding-bottom:14px;color:#d9c792;border-bottom:1px solid rgba(255,255,255,.11)}
                .qi-mini-map{width:min(1080px,100%);margin:72px auto 48px;padding-top:18px}.qi-mini-map>header{align-items:center}.qi-map-objective{display:flex;align-items:center;gap:13px;margin-top:17px;padding:13px 16px;border:1px solid rgba(231,212,155,.18);background:linear-gradient(90deg,rgba(231,212,155,.07),transparent)}.qi-map-objective>i{color:var(--gold);font-style:normal}.qi-map-objective>span{display:grid;gap:5px}.qi-map-objective small{color:rgba(219,227,250,.4);font:7px/1 system-ui,sans-serif;letter-spacing:.15em}.qi-map-objective b{color:#f0eee7;font-size:12px;font-weight:400;line-height:1.55}.qi-mini-map-field{height:500px;margin-top:12px;border-left:1px solid rgba(232,237,255,.08);border-right:1px solid rgba(232,237,255,.08);overflow:visible;background:radial-gradient(circle at 50% 62%,rgba(92,117,210,.16),transparent 38%),linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:auto,40px 40px,40px 40px}.qi-mini-map-field:before{width:80%;height:112%;top:92%;border-color:rgba(224,232,255,.07)}.qi-mini-map-field:after{width:110%;height:132%;top:87%;border-color:rgba(224,232,255,.06)}.qi-mini-map-field line{stroke:rgba(231,237,255,.12);stroke-width:.25;stroke-dasharray:1.2 1.4}.qi-mini-map-field line.is-known{stroke:rgba(221,229,255,.36)}.qi-mini-map-field line.is-travelled{stroke:rgba(231,212,155,.43);stroke-dasharray:.5 1.2}.qi-mini-map-field line.is-recommended{stroke:#e7d49b;stroke-width:.55;stroke-dasharray:none;filter:drop-shadow(0 0 2px rgba(231,212,155,.7))}.qi-world-node{position:absolute;z-index:3;display:grid;place-items:center;width:152px;padding:0;border:0;background:transparent;color:rgba(222,228,247,.42);text-align:center;transform:translate(-50%,-50%);transition:color .2s,transform .2s,opacity .2s}.qi-world-node:disabled{cursor:default}.qi-world-node.is-adjacent{color:#edf0fb;cursor:pointer}.qi-world-node.is-adjacent:hover{transform:translate(-50%,-54%)}.qi-world-node>i{display:grid;place-items:center;width:38px;height:38px;margin-bottom:7px;border:1px solid rgba(230,236,255,.22);border-radius:50%;background:rgba(8,17,55,.82);color:rgba(231,212,155,.58);font:8px/1 system-ui,sans-serif;font-style:normal;box-shadow:0 0 0 5px rgba(230,236,255,.018)}.qi-world-node>b{max-width:148px;font-size:11px;font-weight:400;line-height:1.3}.qi-world-node>small{margin-top:4px;color:rgba(203,214,243,.35);font:6px/1.3 system-ui,sans-serif;letter-spacing:.07em}.qi-world-node.is-fog{opacity:.24}.qi-world-node.is-visited:not(.is-fog)>i{border-color:rgba(231,212,155,.46)}.qi-world-node.is-complete:not(.is-current)>i:after{content:"✦";color:var(--gold);font-size:11px}.qi-world-node.is-complete:not(.is-current)>i{font-size:0}.qi-world-node.is-current{z-index:5;color:#fff}.qi-world-node.is-current>i{width:48px;height:48px;border-color:var(--gold);color:var(--gold);background:rgba(27,45,109,.95);box-shadow:0 0 0 8px rgba(231,212,155,.045),0 0 25px rgba(231,212,155,.2)}.qi-world-node.is-current>small{color:var(--gold)}.qi-world-node.is-recommended{z-index:4;color:#fff4cc}.qi-world-node.is-recommended>i{border-color:var(--gold);color:var(--gold);box-shadow:0 0 0 7px rgba(231,212,155,.06),0 0 22px rgba(231,212,155,.24);animation:qi-node-pulse 1.8s ease-in-out infinite}.qi-world-node.is-recommended>small{color:#e7d49b}.qi-map-guide{display:flex;align-items:center;gap:18px;min-height:36px;padding:8px 0 16px;border-bottom:1px solid rgba(232,237,255,.12);color:rgba(214,222,244,.4);font:7px/1 system-ui,sans-serif;letter-spacing:.08em}.qi-map-guide>span{display:flex;align-items:center;gap:5px}.qi-map-guide>span i{display:block;width:7px;height:7px;border:1px solid currentColor;border-radius:50%}.qi-map-guide>span i.current{border-color:var(--gold);background:var(--gold)}.qi-map-guide>span i.next{box-shadow:0 0 7px var(--gold)}.qi-map-guide>span i.done:after{content:"✦";position:relative;left:1px;top:-3px;color:var(--gold);font-size:6px}.qi-map-guide>button{margin-left:auto;padding:7px 0;border:0;border-bottom:1px solid rgba(231,212,155,.25);background:transparent;color:rgba(231,212,155,.65);cursor:pointer;font:8px/1.4 system-ui,sans-serif}.qi-map-secret{margin-top:19px}
                @keyframes qi-caret{0%,48%{opacity:1}49%,100%{opacity:0}}@keyframes qi-dot{0%,70%,100%{opacity:.2}35%{opacity:1}}@keyframes qi-float{50%{translate:0 -8px}}@keyframes qi-drift{from{transform:translate3d(-.6%,-.4%,0) rotate(-.3deg)}to{transform:translate3d(.7%,.5%,0) rotate(.35deg)}}@keyframes qi-bg-glitch{0%,80%,100%{filter:none}84%{filter:contrast(1.8) hue-rotate(8deg);transform:translateX(2px)}88%{filter:none;transform:none}}@keyframes qi-fade{from{opacity:0}to{opacity:1}}@keyframes qi-thread{from{clip-path:inset(0 0 0 100%)}to{clip-path:inset(0)}}@keyframes qi-map-reveal{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}@keyframes qi-node-pulse{50%{box-shadow:0 0 0 10px rgba(231,212,155,.02),0 0 32px rgba(231,212,155,.42)}}@keyframes qi-memory-scan{0%,100%{transform:scaleX(.25);transform-origin:left}50%{transform:scaleX(1);transform-origin:left}}@keyframes qi-wonder-cloud{from{transform:translate3d(-1%,-1%,0) scale(1)}to{transform:translate3d(1.5%,1%,0) scale(1.05)}}@keyframes qi-wonder-ring{to{transform:rotate(360deg)}}@keyframes qi-watch-float{50%{translate:0 17px;rotate:-4deg}}@keyframes qi-key-float{50%{translate:13px -10px;rotate:5deg}}@keyframes qi-rabbit-hop{0%,100%{translate:0 0}45%{translate:0 -14px}58%{translate:7px -8px}}@keyframes qi-card-drift{50%{translate:0 -13px}}@keyframes qi-suit-spin{to{transform:rotate(360deg)}}
                @media(max-width:720px){.qi-exit{right:12px;top:max(14px,env(safe-area-inset-top));font-size:0}.qi-exit b{font-size:22px}.qi-event-header{grid-template-columns:1fr auto;height:62px;padding:env(safe-area-inset-top) 50px 0 16px}.qi-event-header>button span{font-size:11px}.qi-event-header>.qi-phase-row{display:none}.qi-event-currency{font-size:10px}.qi-event-currency span{font-size:12px}.qi-event-page{padding:70px 15px 86px}.qi-event-nav{bottom:max(9px,env(safe-area-inset-bottom));height:55px}.qi-event-nav button span{font-size:8px}.qi-home-hero{min-height:calc(100vh - 156px);overflow:visible}.qi-home-hero:before{left:-30%;right:-30%;top:7%;height:58%}.qi-dream-arch{width:111vw;height:70vh;opacity:.82}.qi-home-title{margin-top:-2vh}.qi-home-title>p{font-size:7px}.qi-home-title h1{font-size:52px;line-height:.86}.qi-home-title h1 span{font-size:.56em}.qi-home-title>em{font-size:6px}.qi-home-title blockquote{margin:22px auto;font-size:11px}.qi-primary-orbit{min-width:208px;padding:11px 21px}.qi-home-date{display:none}.qi-paper-birds i:nth-child(1){right:6%;top:20%}.qi-paper-birds i:nth-child(3){left:1%;bottom:19%}.qi-chapter-map{display:block;min-height:auto}.qi-chapter-map>header{padding:22px 10px 0}.qi-chapter-map>header h2{font-size:38px}.qi-chapter-map>header>span{margin-top:17px;font-size:11px}.qi-map-field{min-height:600px;margin-top:5px;border:0}.qi-map-node{grid-template-columns:46px auto;gap:8px}.qi-map-node>i{width:42px;height:42px}.qi-map-node>i:before{box-shadow:0 -24px 0 currentColor,0 24px 0 currentColor}.qi-map-node b{font-size:12px}.qi-map-node.n1{left:4%;top:84%}.qi-map-node.n2{left:52%;top:65%}.qi-map-node.n3{left:3%;top:45%}.qi-map-node.n4{left:53%;top:25%}.qi-map-node.n5{left:16%;top:6%}.qi-chapter-map>footer{position:static;margin:8px 10px 35px}.qi-chapter-cover{display:block;min-height:auto}.qi-chapter-arch{height:325px;margin-top:0}.qi-chapter-arch .qi-dream-arch{width:100%;height:100%;opacity:.72}.qi-caged-crane{top:60%;width:70px;height:94px}.qi-caged-crane span{left:10px;top:42px;transform:scale(.72) rotate(-13deg)}.qi-chapter-copy{margin:-24px 10px 35px}.qi-back-link{margin-bottom:24px}.qi-chapter-copy h2{font-size:61px}.qi-chapter-copy>em{margin:23px 0 13px;font-size:13px}.qi-chapter-copy>span{font-size:11px}.qi-chapter-start{margin-top:23px}.qi-ritual-page{padding:18px 3px 35px}.qi-ritual-page>header h2{font-size:36px}.qi-ritual-dial{width:260px;margin-top:27px}.qi-ritual-days{justify-content:flex-start;overflow-x:auto;scrollbar-width:none}.qi-ritual-days li{flex:0 0 69px}.qi-ritual-button{max-width:95%;font-size:12px}.qi-task-page,.qi-shop-page{padding:20px 7px 36px}.qi-task-page>header h2,.qi-shop-page>header h2{font-size:44px}.qi-task-list li{grid-template-columns:28px 1fr 66px;gap:8px;min-height:94px}.qi-task-list li>p{display:none}.qi-task-list li>button{font-size:9px}.qi-task-page>footer{align-items:flex-start}.qi-shop-window{display:block}.qi-shop-window article{display:grid;grid-template-columns:125px 1fr;gap:0 18px;padding:18px}.qi-shop-object{grid-row:1/3;height:160px}.qi-shop-object svg{width:95px;height:95px}.qi-shop-caption{align-self:center}.qi-shop-window article>button{grid-column:2;align-self:start}.qi-shop-page>footer{align-items:center;gap:15px}.qi-cover{align-items:flex-start}.qi-cover>section{width:auto;margin:0 24px;padding:108px 0 56px}.qi-cover h1{font-size:61px;line-height:.91}.qi-cover section>p:not(.qi-kicker){margin-top:34px;font-size:13px}.qi-cover-caret{right:-39vw;width:80vw;opacity:.5}.qi-fake-chat>header{height:68px;padding-left:12px}.qi-fake-chat>header>i{margin-right:44px}.qi-chat-thread{padding-inline:16px}.qi-distort .qi-shard{font-size:10px}.qi-fissure{left:9%;right:9%}.qi-entry>section{width:auto;margin:0 23px}.qi-entry h2{font-size:42px}.qi-explore{padding:82px 20px 54px}.qi-route-count{left:16px}.qi-explore>header{width:100%;margin-top:35px}.qi-explore>header h2{font-size:38px}.qi-node-body{display:block;margin-top:35px}.qi-node-actions{margin-top:28px}.qi-exits{margin-top:50px}.qi-core{align-items:flex-start}.qi-core>section{width:auto;margin:0 24px;padding:110px 0 60px}.qi-core h2{font-size:39px}.qi-core blockquote{font-size:14px}.qi-core-figure{right:-28vw;width:82vw;opacity:.33}.qi-blessing{width:auto;left:24px;right:24px;transform:translateY(-50%)}.qi-blessing p{font-size:13px}.qi-ending section>div{flex-direction:column;align-items:center;gap:12px}}
                @media(max-width:720px){.qi-event-header{grid-template-columns:1fr auto;padding-right:52px}.qi-event-brand span{font-size:11px}.qi-event-page{padding:69px 14px 14px}.qi-home-hero{min-height:calc(100vh - 84px)}.qi-home-hero .qi-dream-arch{width:108vw;height:78vh}.qi-home-title{width:96vw;margin-top:3vh;padding:28px 14px}.qi-home-title:before{inset:-5% -1%}.qi-home-title h1{font-size:50px}.qi-home-title blockquote{margin:24px auto 20px}.qi-primary-orbit{width:224px;min-width:224px}.qi-home-crescent{right:3%;top:9%;width:68px}.qi-home-resume{font-size:9px}.qi-story-brand{left:16px;top:max(17px,env(safe-area-inset-top))}.qi-story-brand span{font-size:9px}.qi-story-phases{top:58px}.qi-story-arch{top:92px;width:118vw;height:39vh}.qi-entry>section{width:auto;margin:0 23px;padding-top:132px}.qi-entry-moon{right:-42px;top:15%;width:120px;opacity:.7}.qi-entry h2{font-size:46px}.qi-explore{padding:112px 20px 58px}.qi-route-count{left:20px;right:auto;top:77px}.qi-explore>header{width:100%;margin-top:35px;padding-right:0}.qi-location-seal{right:-37px;top:-36px;width:91px;height:91px;opacity:.62}.qi-location-seal:after{box-shadow:0 -34px 0 rgba(237,241,255,.38),0 34px 0 rgba(237,241,255,.38)}.qi-explore>header h2{max-width:88%;font-size:43px;line-height:1.05}.qi-explore>header>p:not(.qi-kicker){font-size:12px;line-height:1.9}.qi-node-body{display:block;margin:39px -2px 0;padding:27px 18px}.qi-node-actions{margin-top:31px}.qi-node-actions>button{font-size:14px;line-height:1.7}.qi-exits{margin-top:61px}.qi-exits>button{grid-template-columns:54px 1fr;min-height:78px}.qi-exits button i{width:38px;height:38px}.qi-exits button strong{font-size:15px}.qi-exits button span{grid-column:2;margin-top:4px;font-size:8px}.qi-trace-pocket{display:none}}
                @media(max-width:720px){.qi-mini-map{margin-top:58px;padding-top:16px}.qi-mini-map>header{align-items:start}.qi-mini-map>header strong{font-size:15px}.qi-mini-map>header>span{max-width:88px;text-align:right;line-height:1.5}.qi-map-objective{align-items:flex-start;padding:11px 12px}.qi-map-objective b{font-size:10px}.qi-mini-map-field{height:455px;margin:11px -9px 0;background-size:auto,30px 30px,30px 30px}.qi-mini-map-field:before{width:92%;height:98%;top:94%}.qi-mini-map-field:after{width:126%;height:120%;top:90%}.qi-world-node{width:108px}.qi-world-node>i{width:31px;height:31px;margin-bottom:5px}.qi-world-node>b{max-width:108px;font-size:9px;line-height:1.35}.qi-world-node>small{max-width:105px;font-size:5.5px}.qi-world-node.is-current>i{width:39px;height:39px}.qi-map-guide{flex-wrap:wrap;gap:10px 13px;padding-bottom:13px}.qi-map-guide>button{flex-basis:100%;margin-left:0;text-align:left}.qi-map-secret{grid-template-columns:46px 1fr;padding:12px}.qi-map-locked{font-size:10px}.qi-memory-evidence{padding:14px}}
                @media(max-width:720px){.qi-broken-header{height:68px;padding:17px 58px 13px 18px}.qi-shard{padding:8px 10px;font-size:9px}.qi-shard.s1{left:6%;top:18%}.qi-shard.s2{right:6%;top:15%}.qi-shard.s3{left:5%;top:39%}.qi-shard.s4{right:2%;top:49%;max-width:150px}.qi-shard.s5{left:5%;bottom:10%}.qi-shard.s6{right:5%;bottom:5%;font-size:34px}.qi-rabbit-door{top:69%;grid-template-columns:1fr auto;width:82vw;min-height:96px;padding:17px 20px}.qi-rabbit-door b{font-size:13px}.qi-rabbit-door>i{font-size:8px}.qi-wonderland-tunnel{width:115%;left:-7.5%}}
                @media(max-width:720px){.qi-night-progress{grid-template-columns:36px 52px 1fr;width:100%;gap:7px;margin-top:16px;padding-bottom:11px}.qi-night-progress>b{font-size:14px}.qi-night-progress>small{font-size:7px;line-height:1.45}.qi-night-progress>i{grid-column:1/4}.qi-night-progress>i em{flex:1;width:auto}.qi-explore>header{margin-top:24px}.qi-leave-node{min-height:62px;padding:13px 1px}.qi-leave-node b{font-size:15px}.qi-left-node{line-height:1.6}}
                @media(max-width:720px){.qi-home-title{width:90vw;margin-top:-1vh;padding:18px 12px 22px}.qi-home-title:before{inset:-4% -3%}.qi-home-title>p{margin-bottom:10px;font-size:7.5px;letter-spacing:.28em}.qi-home-title>.qi-phase-row{gap:7px;margin-bottom:18px}.qi-home-title>.qi-phase-row i{width:10px;height:10px}.qi-home-title h1{gap:6px;font-size:46px}.qi-home-title h1>span{font-size:.4em}.qi-home-title>em{margin-top:14px;font-size:6.5px;letter-spacing:.28em}.qi-home-title blockquote{margin:22px auto 18px;font-size:11.5px;line-height:2;letter-spacing:.06em}.qi-primary-orbit{width:206px;min-width:206px;min-height:60px;padding:8px 23px}.qi-primary-orbit i{left:18px;font-size:11px}.qi-primary-orbit span{font-size:13.5px}.qi-primary-orbit small{font-size:6px}.qixi-interlayer-root .qi-home-resume{margin-top:17px;font:9px/1.5 system-ui,sans-serif;letter-spacing:.08em}.qi-home-crescent{right:2%;top:8%;width:60px}}
                /* 2026 Qixi art direction: plum night, lavender mist, blush gold. */
                .qixi-interlayer-root{--paper:#f8eef7;--ink:#2b1835;--night:#160d27;--night2:#34204b;--cobalt:#7f62ad;--mist:#d2c0e9;--lavender:#b59bd8;--moon:#fff3d7;--silver:#ebdef8;--red:#d78eae;--gold:#efca92;background:var(--night);color:var(--silver)}
                .qixi-interlayer-root .qi-exit{right:clamp(18px,4vw,48px);top:max(22px,env(safe-area-inset-top));color:#fff4eb;opacity:.74;font-family:"Noto Serif SC","Songti SC",serif;font-size:12px;letter-spacing:.2em;transition:opacity .2s,transform .2s}.qixi-interlayer-root .qi-exit:hover{opacity:1;transform:translateY(-1px)}.qixi-interlayer-root .qi-exit b{color:rgba(255,239,245,.76);font-size:25px}.qixi-interlayer-root .qi-exit.is-black{color:#fff1f7;opacity:.58}
                .qi-event-shell{color:#fff7f2;background:radial-gradient(circle at 79% 14%,rgba(244,185,212,.23),transparent 23%),radial-gradient(circle at 18% 68%,rgba(167,135,207,.25),transparent 34%),radial-gradient(circle at 52% 32%,rgba(112,83,168,.32),transparent 34%),linear-gradient(156deg,#241334 0,#321a48 38%,#171029 72%,#0e0a1d 100%)}.qi-event-shell:before{background:linear-gradient(90deg,rgba(238,190,216,.08),transparent 16%,transparent 84%,rgba(212,179,232,.1)),radial-gradient(circle at 16% 84%,rgba(205,168,229,.18),transparent 27%),radial-gradient(circle at 82% 72%,rgba(238,180,207,.11),transparent 26%)}.qi-event-shell:after{border-color:rgba(239,212,236,.17);box-shadow:0 -22px 78px rgba(151,111,187,.12)}.qi-celestial-backdrop{opacity:.76;filter:hue-rotate(32deg) saturate(.76)}.qi-shell-grain{opacity:.26;background-image:radial-gradient(rgba(255,232,244,.74) .48px,transparent .75px);background-size:8px 8px}
                .qi-event-header{height:88px;padding:env(safe-area-inset-top) 122px 0 40px;border-bottom-color:rgba(244,210,230,.16);background:linear-gradient(180deg,rgba(18,8,31,.94),rgba(32,16,51,.72) 76%,rgba(32,16,51,.12));backdrop-filter:blur(16px)}.qi-event-brand span{color:#fff4ee;font-size:17px;letter-spacing:.18em;text-shadow:0 0 18px rgba(248,213,231,.18)}.qi-event-brand small{margin-top:7px;color:rgba(237,212,239,.58);font-size:8px;letter-spacing:.32em}.qi-event-shell.is-home .qi-event-header>.qi-phase-row{display:none}.qi-event-shell.is-home .qi-event-page{min-height:100%;padding:88px 0 0}
                .qi-home-hero{position:relative;display:grid;place-items:center;width:100%;max-width:none;min-height:calc(100svh - 88px);margin:0;padding:clamp(44px,7vh,88px) 24px clamp(70px,9vh,118px);overflow:hidden}.qi-home-hero:before{display:none}.qi-home-hero>.qi-dream-arch{left:50%;top:48%;width:min(790px,74vw);height:min(900px,84vh);color:rgba(240,210,235,.27);opacity:.72;filter:drop-shadow(0 0 28px rgba(220,176,226,.11));transform:translate(-50%,-50%)}.qi-home-hero .qi-dream-arch>path{display:block;fill:#fff1d3;opacity:.93}
                .qi-home-frame{position:absolute;z-index:1;inset:clamp(44px,6vh,76px) clamp(26px,6vw,86px) clamp(36px,5vh,64px);border:1px solid rgba(241,211,232,.17);border-top-left-radius:48% 17%;border-top-right-radius:48% 17%;pointer-events:none}.qi-home-frame:before,.qi-home-frame:after{content:"";position:absolute;left:50%;top:15%;border:1px solid rgba(222,190,231,.15);border-radius:50%;transform:translate(-50%,-50%)}.qi-home-frame:before{width:112%;height:52%}.qi-home-frame:after{width:91%;height:35%;border-style:dashed}.qi-home-frame i{position:absolute;width:7px;height:7px;border-radius:50%;background:#fff0d5;box-shadow:0 0 7px #fff0d5,0 0 20px rgba(244,188,219,.82)}.qi-home-frame i:nth-child(1){left:18%;top:17%}.qi-home-frame i:nth-child(2){right:9%;top:42%}.qi-home-frame i:nth-child(3){left:3%;bottom:18%}.qi-home-frame i:nth-child(4){right:5%;bottom:11%}
                .qi-home-crescent{right:8%;top:8%;width:clamp(82px,10vw,126px);background:#fff3d7;box-shadow:0 0 35px rgba(255,226,194,.38),0 0 82px rgba(228,165,205,.22);animation:qi-moon-breathe 6.5s ease-in-out infinite}.qi-home-crescent:after{left:31%;top:-9%;background:#2b1746}.qi-home-crescent i{position:absolute;right:-10%;bottom:-17%;width:9px;height:9px;background:#fff0d0;transform:rotate(45deg);box-shadow:0 0 9px #fff0d0,0 0 24px rgba(244,189,219,.8)}
                .qi-home-title{isolation:isolate;display:flex;flex-direction:column;align-items:center;width:min(660px,91vw);margin-top:clamp(12px,3vh,38px);padding:35px 36px 39px;text-align:center;animation:qi-home-arrive .85s cubic-bezier(.2,.8,.25,1) both}.qi-home-title:before{inset:-7% -8%;background:radial-gradient(ellipse at center,rgba(48,25,78,.77) 0,rgba(52,27,82,.54) 43%,rgba(52,27,82,0) 76%);backdrop-filter:blur(4px);-webkit-mask-image:radial-gradient(ellipse at center,#000 44%,transparent 77%);mask-image:radial-gradient(ellipse at center,#000 44%,transparent 77%)}.qi-home-season{display:flex;align-items:center;justify-content:center;gap:20px;margin-bottom:17px;color:var(--gold)}.qi-home-season p{margin:0;font:11px/1 system-ui,sans-serif;letter-spacing:.32em}.qi-home-season i,.qi-home-phase-band>i{font-style:normal;font-size:8px}.qi-home-phase-band{display:flex;align-items:center;justify-content:center;gap:16px;margin-bottom:28px;color:rgba(250,225,241,.73)}.qi-home-phase-band>.qi-phase-row{gap:10px}.qi-home-phase-band>.qi-phase-row i{width:13px;height:13px;border-color:rgba(255,234,244,.75)}.qi-home-title h1{display:grid;place-items:center;gap:10px;margin:0;color:#fff9ee;font-size:clamp(64px,8.6vw,112px);font-weight:400;line-height:.88;letter-spacing:0;text-shadow:0 2px 5px rgba(15,7,29,.55),0 0 30px rgba(239,203,231,.2)}.qi-home-title h1>span{display:flex;align-items:center;gap:21px;padding-left:.45em;color:rgba(255,241,235,.9);font-size:.37em;line-height:1;letter-spacing:.45em}.qi-home-title h1>span:before,.qi-home-title h1>span:after{content:"";width:74px;border-top:1px solid rgba(241,205,223,.48)}.qi-home-title h1>b{display:block;padding-left:.07em;font:inherit;font-weight:400;line-height:.91;letter-spacing:.07em}.qi-home-title>em{margin-top:22px;color:rgba(241,218,239,.64);font:8px/1.4 system-ui,sans-serif;letter-spacing:.55em}.qi-home-title blockquote{margin:38px auto 31px;color:rgba(255,242,239,.91);font-size:clamp(13px,1.5vw,17px);line-height:2.05;letter-spacing:.1em;text-shadow:0 1px 8px rgba(14,7,27,.72)}
                .qi-primary-orbit{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;width:min(420px,72vw);min-width:0;min-height:86px;margin:0 auto;padding:13px 62px;border-color:rgba(250,218,207,.72);background:linear-gradient(90deg,rgba(115,76,148,.22),rgba(84,52,121,.48),rgba(115,76,148,.22));color:#fff6ed;box-shadow:0 0 0 7px rgba(230,188,226,.05),0 0 31px rgba(234,181,211,.15),inset 0 0 24px rgba(236,200,229,.06);overflow:hidden;transition:transform .25s,background .25s,box-shadow .25s}.qi-primary-orbit:before{content:"";position:absolute;inset:5px;border:1px dotted rgba(248,218,227,.45);border-radius:50%;pointer-events:none}.qi-primary-orbit:after{content:"";position:absolute;left:-35%;top:0;width:28%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,236,228,.18),transparent);transform:skewX(-18deg);animation:qi-orbit-glimmer 4.8s ease-in-out infinite}.qi-primary-orbit:hover{transform:translateY(-3px);background:linear-gradient(90deg,rgba(139,92,163,.26),rgba(101,63,139,.58),rgba(139,92,163,.26));box-shadow:0 0 0 9px rgba(230,188,226,.06),0 0 44px rgba(234,181,211,.22),inset 0 0 27px rgba(236,200,229,.09)}.qi-primary-orbit i{position:absolute;top:50%;grid-row:auto;color:var(--gold);font-style:normal;font-size:12px;transform:translateY(-50%)}.qi-primary-orbit i.is-left{left:16%}.qi-primary-orbit i.is-right{right:16%;left:auto}.qi-primary-orbit span{display:block;width:100%;padding-left:.16em;text-align:center;font-size:18px;letter-spacing:.2em}.qi-primary-orbit small{display:block;width:100%;color:rgba(244,219,237,.58);font-size:8px;letter-spacing:.27em;text-align:center}.qi-memory-notice{max-width:420px;margin:20px auto 0;color:rgba(244,218,236,.66);font-size:9px;letter-spacing:.14em}.qi-memory-notice.is-memory{color:#f6d9bd}.qi-home-resume{margin-top:18px;border-bottom-color:rgba(240,205,226,.28);color:rgba(244,220,235,.62)}
                .qi-home-clouds{position:absolute;z-index:2;left:0;right:0;bottom:0;height:24%;pointer-events:none;filter:blur(1px)}.qi-home-clouds i{position:absolute;bottom:-28%;width:48%;height:90%;border-radius:50%;background:radial-gradient(ellipse at center,rgba(213,175,225,.23),rgba(173,131,197,.12) 48%,transparent 72%)}.qi-home-clouds i:nth-child(1){left:-10%}.qi-home-clouds i:nth-child(2){left:28%;bottom:-42%;width:45%;background:radial-gradient(ellipse at center,rgba(237,183,211,.17),rgba(167,128,198,.1) 50%,transparent 73%)}.qi-home-clouds i:nth-child(3){right:-12%}.qi-home-horizon{position:absolute;z-index:2;left:-8%;right:-8%;bottom:4%;height:15%;border-top:1px solid rgba(239,205,229,.2);border-radius:50% 50% 0 0/100% 100% 0 0;pointer-events:none}.qi-home-horizon i{position:absolute;bottom:26%;width:22%;height:42%;border-top:1px solid rgba(242,211,232,.2);border-radius:50%}.qi-home-horizon i:first-child{left:11%;transform:rotate(8deg)}.qi-home-horizon i:last-child{right:11%;transform:rotate(-8deg)}.qi-paper-birds i,.qi-paper-birds i:after{border-color:rgba(255,222,231,.7)}
                .qi-fake-chat{color:#f9eff9;background:radial-gradient(circle at 82% 13%,rgba(235,174,205,.2),transparent 26%),linear-gradient(160deg,#2b1739,#1b102c 62%,#100a1e)}.qi-fake-chat>header{border-bottom-color:rgba(238,196,221,.18);background:rgba(31,15,45,.84);box-shadow:0 8px 30px rgba(11,5,20,.2)}.qi-fake-chat>header>button,.qi-fake-chat>header>i{color:rgba(250,231,244,.68)}.qi-chat-avatar{background:linear-gradient(145deg,#d1b6e8,#df9fbd);color:#2a1638;box-shadow:0 0 0 3px rgba(245,213,231,.1),0 0 24px rgba(216,156,195,.2)}.qi-fake-chat>header small{color:#efbfce}.qi-chat-thread time,.qi-system-line{color:rgba(230,205,232,.48)}.qi-bubble,.qi-typing-dots{border:1px solid rgba(236,194,222,.2);background:linear-gradient(135deg,rgba(127,93,160,.34),rgba(72,45,100,.42));box-shadow:0 12px 28px rgba(9,4,18,.18);color:#fff3f7}.qi-bubble.is-char{border-left-color:var(--gold)}.qi-typing-dots i{background:#e9b9d1}.qi-chat-input{border-top-color:rgba(238,196,221,.18);background:rgba(24,11,37,.92);backdrop-filter:blur(14px)}.qi-chat-input>button:first-child,.qi-chat-input>button:last-child{border-color:rgba(236,201,225,.25);color:#d6b9df}.qi-input-field{border-color:rgba(233,193,221,.25)!important;background:rgba(116,81,143,.2)!important;color:rgba(249,225,239,.7)}
                .qi-distort{color:#372340;background:radial-gradient(circle at 50% 72%,#fff0dc 0,#ecd2e9 22%,#cbb8e4 48%,#a988c0 75%,#6f4d88 120%)}.qi-distort:before{background:radial-gradient(circle at 20% 25%,rgba(255,242,226,.76),transparent 24%),radial-gradient(circle at 84% 16%,rgba(248,183,214,.56),transparent 22%),radial-gradient(circle at 18% 82%,rgba(210,190,238,.78),transparent 28%)}.qi-broken-header{border-bottom-color:rgba(92,54,103,.18);background:linear-gradient(180deg,rgba(255,233,238,.6),rgba(232,207,237,.12))}.qi-broken-header span{color:#9d5c82}.qi-shard{border-color:rgba(111,70,124,.2);background:rgba(255,236,232,.7);color:#57405f;box-shadow:0 12px 28px rgba(86,50,99,.11)}.qi-rabbit-door{border-color:rgba(141,87,130,.34);background:radial-gradient(ellipse at center,rgba(255,244,222,.97),rgba(235,205,230,.84) 57%,rgba(171,137,200,.48) 100%);color:#4d3159;box-shadow:0 0 0 9px rgba(255,230,231,.14),0 22px 50px rgba(82,48,97,.2),inset 0 0 24px rgba(255,247,229,.72)}
                .qi-interlayer{color:#f7eef8;background:radial-gradient(circle at 76% 15%,rgba(239,178,211,.13),transparent 26%),radial-gradient(circle at 18% 72%,rgba(171,136,208,.17),transparent 34%),linear-gradient(145deg,#39204c,#20112f 58%,#100a1d)}.qi-interlayer:after{opacity:.18;background-image:linear-gradient(90deg,transparent 49.8%,rgba(247,219,239,.06) 50%,transparent 50.2%),radial-gradient(rgba(255,222,237,.75) .5px,transparent .75px)}.qi-interlayer .qi-exit{color:#fff1f7}.qi-entry>section>p:not(.qi-kicker),.qi-explore>header>p:not(.qi-kicker){color:#cbb8d1}.qi-entry aside{color:#d7c3d5;background:linear-gradient(90deg,rgba(221,175,215,.08),transparent)}.qi-entry-moon i:after{background:#321b46}.qi-story-brand{color:rgba(255,238,246,.85)}.qi-story-brand small{color:rgba(224,194,229,.46)}.qi-story-phases{color:rgba(245,215,235,.68)}.qi-story-arch{border-color:rgba(238,202,228,.17)}.qi-story-arch:before,.qi-story-arch:after{border-color:rgba(225,189,226,.12)}.qi-night-progress{border-bottom-color:rgba(238,202,228,.16)}.qi-night-progress>b{color:#fff4ef}.qi-night-progress>small{color:rgba(224,199,229,.54)}.qi-location-seal{border-color:rgba(239,206,230,.24);box-shadow:0 0 0 11px rgba(235,196,225,.03),0 0 38px rgba(220,158,202,.1)}.qi-explore>header em{color:#d9c3d8}.qi-node-body{border-color:rgba(237,200,226,.14);background:linear-gradient(90deg,rgba(191,142,202,.055),rgba(255,222,236,.025),rgba(191,142,202,.055))}.qi-node-body>aside p,.qi-response p{color:#e0cfdf}.qi-node-body>aside small,.qi-node-actions>small,.qi-response small,.qi-exits>small{color:#b99ebf}.qi-node-actions>button{border-color:rgba(236,199,225,.16);color:#fff3f6}.qi-left-node{color:rgba(223,197,225,.52)}.qi-memory-evidence{border-color:rgba(239,202,149,.25);background:linear-gradient(135deg,rgba(239,202,146,.08),rgba(181,145,214,.08))}.qi-memory-evidence b{color:#ffe9d4}.qi-node-body>aside .qi-memory-evidence p{color:#ead9e8}.qi-memory-evidence em{color:#bea6c4}.qi-memory-extension{color:#f1cfbb}.qi-map-objective{border-color:rgba(239,202,146,.22);background:linear-gradient(90deg,rgba(239,202,146,.08),rgba(193,143,202,.03),transparent)}.qi-mini-map-field{border-color:rgba(236,200,225,.1);background:radial-gradient(circle at 50% 62%,rgba(166,116,194,.2),transparent 39%),linear-gradient(rgba(242,211,232,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(242,211,232,.025) 1px,transparent 1px)}.qi-world-node>i{border-color:rgba(239,205,229,.26);background:rgba(45,23,64,.88)}.qi-world-node.is-current>i{background:rgba(105,63,125,.94)}.qi-map-secret{background:rgba(92,53,111,.48)}
                .qi-core{color:#fff1f4;background:radial-gradient(circle at 16% 45%,rgba(219,137,179,.18),transparent 29%),radial-gradient(circle at 82% 25%,rgba(169,127,199,.12),transparent 27%),linear-gradient(115deg,#120a1e,#281338 68%,#0d0818)}.qi-core blockquote{color:#d5c0d3}.qi-core-figure{border-left-color:rgba(239,202,146,.16);border-right-color:rgba(215,137,178,.2)}.qi-core-figure span{color:rgba(255,231,240,.2)}.qi-black{color:#fff2f7;background:radial-gradient(circle at 50% 38%,#2b153a 0,#160c23 54%,#08050f 100%)}.qi-touch-area svg path{stroke:rgba(225,145,183,.76)}.qi-user-finger,.qi-char-finger{border-color:rgba(255,226,239,.56);box-shadow:0 0 25px rgba(235,174,207,.17)}.qi-ending section>p:last-of-type{color:#e7a8c2}.qi-ending section button{border-bottom-color:rgba(240,207,228,.22);color:rgba(255,230,242,.68)}.qi-final-echo{color:#f1c9ad;border-bottom-color:rgba(241,207,228,.14)}
                @keyframes qi-home-arrive{from{opacity:0;transform:translateY(20px) scale(.985)}to{opacity:1;transform:none}}@keyframes qi-moon-breathe{0%,100%{transform:translateY(0);filter:brightness(1)}50%{transform:translateY(-7px);filter:brightness(1.08)}}@keyframes qi-orbit-glimmer{0%,58%{left:-35%;opacity:0}68%{opacity:1}88%,100%{left:112%;opacity:0}}
                @media(max-width:720px){.qixi-interlayer-root .qi-exit{right:15px;top:max(17px,env(safe-area-inset-top));font-size:11px}.qixi-interlayer-root .qi-exit b{margin-left:9px;font-size:23px}.qi-event-header{height:74px;padding:env(safe-area-inset-top) 96px 0 18px}.qi-event-brand span{font-size:13px}.qi-event-brand small{margin-top:5px;font-size:6.5px}.qi-event-shell.is-home .qi-event-page{padding:74px 0 0}.qi-home-hero{min-height:calc(100svh - 74px);padding:30px 10px 64px}.qi-home-frame{inset:35px 19px 28px;border-top-left-radius:48% 13%;border-top-right-radius:48% 13%}.qi-home-frame:before{width:132%;height:44%}.qi-home-frame:after{width:110%;height:30%}.qi-home-hero>.qi-dream-arch{top:49%;width:118vw;height:78vh}.qi-home-crescent{right:4%;top:7%;width:72px}.qi-home-title{width:94vw;margin-top:2vh;padding:22px 12px 28px}.qi-home-season{gap:13px;margin-bottom:13px}.qi-home-season p{font-size:8px;letter-spacing:.25em}.qi-home-phase-band{gap:10px;margin-bottom:22px}.qi-home-phase-band>.qi-phase-row{display:flex;gap:7px}.qi-home-phase-band>.qi-phase-row i{width:10px;height:10px}.qi-home-title h1{gap:7px;font-size:53px}.qi-home-title h1>span{font-size:.38em;gap:10px}.qi-home-title h1>span:before,.qi-home-title h1>span:after{width:42px}.qi-home-title>em{margin-top:16px;font-size:6.3px;letter-spacing:.4em}.qi-home-title blockquote{margin:27px auto 23px;font-size:12px;line-height:1.95}.qi-primary-orbit{width:258px;min-width:0;min-height:72px;padding:11px 55px}.qi-primary-orbit i.is-left{left:15%}.qi-primary-orbit i.is-right{right:15%;left:auto}.qi-primary-orbit span{font-size:15px}.qi-primary-orbit small{font-size:6.4px}.qi-memory-notice{max-width:290px;margin-top:17px;font-size:8px;line-height:1.65}.qi-home-clouds{height:21%}.qi-paper-birds i:nth-child(1){right:4%;top:25%}.qi-paper-birds i:nth-child(3){left:1%;bottom:18%}.qi-fake-chat>header{height:68px;padding-left:12px}.qi-fake-chat>header>i{margin-right:54px}.qi-chat-thread{padding-inline:16px}.qi-entry-moon i:after{background:#321b46}}
                @media(max-height:720px) and (max-width:720px){.qi-home-hero{padding-top:12px;padding-bottom:34px}.qi-home-title{margin-top:0;padding-top:14px}.qi-home-season{margin-bottom:9px}.qi-home-phase-band{margin-bottom:13px}.qi-home-title h1{font-size:45px}.qi-home-title>em{margin-top:11px}.qi-home-title blockquote{margin:17px auto 14px;line-height:1.75}.qi-primary-orbit{min-height:62px}.qi-home-frame{top:21px;bottom:18px}.qi-home-crescent{top:5%;width:60px}}
                @media(prefers-reduced-motion:reduce){.qixi-interlayer-root *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
            `}</style>
        </div>,
        document.body,
    );
};

declare global {
    interface Window {
        render_game_to_text?: () => string;
        advanceTime?: (ms: number) => void;
    }
}

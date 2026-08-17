import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { APIConfig, CharacterProfile, UserProfile } from '../../../types';
import Live2DAvatarCanvas, { Live2DActionTrigger } from '../../call/Live2DAvatarCanvas';
import { useBlobRefUrl } from '../../../utils/blobRef';
import './QixiDemoEvent.css';
import {
    createQixiFallbackBundle,
    loadQixiMemoryBundle,
    prepareQixiMemoryBundle,
    QixiMemoryArtifact,
    QixiMemoryBundle,
    QixiSceneId,
    QIXI_SCENE_IDS,
} from '../../../utils/qixiMemoryBundle';
import {
    prepareQixiReunion,
    QixiJourneyBeat,
    QixiReunionBundle,
    resolveQixiPortraitPlan,
} from '../../../utils/qixiReunion';

export const QIXI_DEMO_RECORD_KEY = 'qixi_2026_dual_layer_v7';

type Stage = 'cover' | 'fakeChat' | 'distort' | 'entry' | 'scene' | 'bridge' | 'reunionLoading' | 'reunion' | 'touch' | 'ending';
type EntryAttitude = 'explore' | 'shout' | 'stay';

interface QixiGameV7 {
    version: 7;
    stage: Stage;
    attitude?: EntryAttitude;
    sceneIndex: number;
    decisions: Partial<Record<QixiSceneId, string[]>>;
    results: Partial<Record<QixiSceneId, string[]>>;
    completedScenes: QixiSceneId[];
    reunion?: QixiReunionBundle;
    reunionPage: number;
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
    onReturnToChat?: (message: string) => Promise<void> | void;
}

interface SceneMeta {
    title: string;
    ritual: string;
    intention: string;
    userColor: string;
    charColor: string;
}

const STORAGE_PREFIX = 'sullyos_qixi_dual_layer_v7_';
const CONTACT_DURATION_MS = 1250;
const WORD_PICK_COUNT = 3;

const SCENES: Record<QixiSceneId, SceneMeta> = {
    lostLayer: { title: '失联层', ritual: '等待响应', intention: '遥寄 · 双星失联', userColor: '#f2c4d8', charColor: '#a8d9ff' },
    doubleWish: { title: '双面祈愿处', ritual: '翻面见字', intention: '拜七姐 · 写愿', userColor: '#f6c6d8', charColor: '#b8d8ff' },
    threadNeedle: { title: '穿针乞巧处', ritual: '共同穿线', intention: '穿针 · 乞巧', userColor: '#f1b3ca', charColor: '#9fd7ff' },
    offerings: { title: '供果与记忆陈列', ritual: '交换供物', intention: '供果 · 供桌', userColor: '#f2c7a6', charColor: '#b7d5ff' },
    reflection: { title: '投针照影', ritual: '双层水纹', intention: '投针 · 照影', userColor: '#efb8d4', charColor: '#91dcff' },
    nightMarket: { title: '乞巧市', ritual: '记忆夜市', intention: '七夕夜市 · 小事', userColor: '#f3c39e', charColor: '#a5d2ff' },
    wordCloud: { title: '葡萄架下的词云', ritual: '听见另一边', intention: '葡萄架 · 私语', userColor: '#efbadb', charColor: '#9fdcff' },
};

const FALLBACK_WORDS = ['认真', '嘴硬', '晚睡', '温柔', '小事', '耐心', '好奇', '勇气', '安静', '分享', '想念', '自由', '努力', '休息'];

const freshGame = (): QixiGameV7 => ({
    version: 7,
    stage: 'cover',
    sceneIndex: 0,
    decisions: {},
    results: {},
    completedScenes: [],
    reunionPage: 0,
});

const loadGame = (charId: string): QixiGameV7 | null => {
    try {
        const value = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${charId}`) || 'null') as QixiGameV7 | null;
        return value?.version === 7 ? value : null;
    } catch {
        return null;
    }
};

const unique = <T,>(items: T[]): T[] => [...new Set(items)];

const ExitButton: React.FC<{ onClose: () => void }> = ({ onClose }) => (
    <button type="button" className="q7-exit" onClick={onClose} aria-label="退出七夕活动">退出 <b>×</b></button>
);

const CelestialBackdrop: React.FC = () => (
    <svg className="q7-sky" viewBox="0 0 1000 1600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
            <radialGradient id="q7mist"><stop stopColor="#f4c9de" stopOpacity=".18" /><stop offset="1" stopColor="#7f62ad" stopOpacity="0" /></radialGradient>
            <linearGradient id="q7line"><stop stopColor="#f3d8e7" stopOpacity="0" /><stop offset=".5" stopColor="#f3d8e7" stopOpacity=".55" /><stop offset="1" stopColor="#f3d8e7" stopOpacity="0" /></linearGradient>
        </defs>
        <circle cx="510" cy="500" r="430" fill="url(#q7mist)" />
        <g fill="none" stroke="url(#q7line)"><ellipse cx="500" cy="530" rx="430" ry="255" transform="rotate(-18 500 530)" /><ellipse cx="500" cy="530" rx="330" ry="590" transform="rotate(29 500 530)" strokeDasharray="3 12" /><path d="M-100 1240C210 1010 690 1450 1110 1120" strokeDasharray="4 13" /></g>
        <g fill="#fff3dc"><path d="M124 224l7 15 16 7-16 7-7 16-7-16-16-7 16-7z" /><path d="M845 184l5 11 12 5-12 5-5 12-5-12-12-5 12-5z" /><path d="M779 642l5 11 12 5-12 5-5 12-5-12-12-5 12-5z" /><circle cx="235" cy="390" r="3" /><circle cx="760" cy="338" r="2.5" /><circle cx="690" cy="1020" r="3" /></g>
    </svg>
);

const SceneObject: React.FC<{ sceneId: QixiSceneId; label: string; completed: boolean }> = ({ sceneId, label, completed }) => (
    <div className={`q7-object is-${sceneId} ${completed ? 'is-complete' : ''}`} aria-label={label}>
        {sceneId === 'lostLayer' && <div className="q7-message-object"><i /><i /><i /><b>DELIVERY FAILED</b></div>}
        {sceneId === 'doubleWish' && <div className="q7-wish-object"><i>愿</i><span /></div>}
        {sceneId === 'threadNeedle' && <svg viewBox="0 0 260 220" aria-hidden="true"><path className="needle" d="M175 26L83 187" /><ellipse className="eye" cx="170" cy="35" rx="7" ry="14" transform="rotate(31 170 35)" /><path className="thread" d="M25 151C87 75 153 170 211 86S292 71 236 174" /></svg>}
        {sceneId === 'offerings' && <div className="q7-altar-object"><span /><i className="fruit one" /><i className="fruit two" /><i className="cup" /></div>}
        {sceneId === 'reflection' && <div className="q7-water-object"><i /><i /><i /><span /></div>}
        {sceneId === 'nightMarket' && <div className="q7-market-object"><span /><i>小事</i><i>称呼</i><i>饮料</i></div>}
        {sceneId === 'wordCloud' && <div className="q7-vine-object"><i /><i /><i /><span /></div>}
        <small>{label}</small>
    </div>
);

const activeMeetingSprites = (char: CharacterProfile): Record<string, string> => {
    const skin = char.dateSkinSets?.find(item => item.id === char.activeSkinSetId) || char.dateSkinSets?.[0];
    return skin?.sprites && Object.keys(skin.sprites).length ? skin.sprites : (char.sprites || {});
};

const QixiPortrait: React.FC<{ char: CharacterProfile; reunion: QixiReunionBundle }> = ({ char, reunion }) => {
    const [live2dFailed, setLive2dFailed] = useState(false);
    const [staticFailed, setStaticFailed] = useState(false);
    const meetingSprites = activeMeetingSprites(char);
    const meetingKey = reunion.portrait.meetingExpression || (meetingSprites.normal ? 'normal' : Object.keys(meetingSprites)[0]);
    const meetingRaw = meetingKey ? meetingSprites[meetingKey] : undefined;
    const chibiRaw = char.vrState?.chibi?.img || char.sprites?.chibi;
    const staticRaw = meetingRaw || char.avatar || chibiRaw;
    const staticUrl = useBlobRefUrl(staticRaw);
    const manualAction = useMemo<Live2DActionTrigger | null>(() => reunion.portrait.l2dExpression
        ? { id: reunion.portrait.l2dExpression, nonce: Date.now() }
        : null, [reunion.portrait.l2dExpression]);
    useEffect(() => setStaticFailed(false), [staticUrl]);
    if (reunion.portrait.resourceType === 'live2d' && char.videoAvatar?.format === 'live2d' && !live2dFailed) {
        return <div className="q7-portrait is-live2d"><Live2DAvatarCanvas config={char.videoAvatar} motionState="idle" manualAction={manualAction} ambientAutonomyDisabled onError={() => setLive2dFailed(true)} /></div>;
    }
    return <div className={`q7-portrait is-${reunion.portrait.resourceType}`}>{staticUrl && !staticFailed ? <img src={staticUrl} alt={char.name} onError={() => setStaticFailed(true)} /> : <span>{char.name.trim().charAt(0).toUpperCase()}</span>}</div>;
};

export const QixiDemoSession: React.FC<QixiDemoSessionProps> = ({ char, user, apiConfig, onClose, onReturnToChat }) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const touchAreaRef = useRef<HTMLDivElement>(null);
    const savedAtOpen = useRef<QixiGameV7 | null>(loadGame(char.id));
    const materialGenerationRef = useRef<Promise<QixiMemoryBundle> | null>(null);
    const reunionGenerationRef = useRef<Promise<QixiReunionBundle> | null>(null);
    const finishRef = useRef(false);
    const fallbackBundle = useMemo(() => createQixiFallbackBundle(), []);
    const cachedAtOpen = useMemo(() => loadQixiMemoryBundle(char.id), [char.id]);
    const [game, setGame] = useState<QixiGameV7>(freshGame);
    const [memoryBundle, setMemoryBundle] = useState<QixiMemoryBundle | null>(cachedAtOpen);
    const [memoryStatus, setMemoryStatus] = useState<'idle' | 'loading' | 'memory' | 'fallback'>(cachedAtOpen?.source === 'memory' ? 'memory' : 'idle');
    const [memoryNotice, setMemoryNotice] = useState('');
    const [touch, setTouch] = useState<TouchState>({ x: 50, y: 72, active: false, approaching: false, joined: false, releasedEarly: false });
    const touchingRef = useRef(false);
    const joinedRef = useRef(false);
    const touchElapsedRef = useRef(0);
    const approachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const contactTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const finishToChatRef = useRef<() => Promise<void>>(async () => undefined);
    const activeBundle = memoryBundle || fallbackBundle;
    const currentSceneId = QIXI_SCENE_IDS[Math.max(0, Math.min(QIXI_SCENE_IDS.length - 1, game.sceneIndex))];
    const sceneMeta = SCENES[currentSceneId];
    const scenePayload = activeBundle.scenes[currentSceneId];
    const sceneDecisions = game.decisions[currentSceneId] || [];
    const sceneCompleted = game.completedScenes.includes(currentSceneId);
    const portraitPlan = useMemo(() => resolveQixiPortraitPlan(char), [char]);

    const wordArtifacts = useMemo((): QixiMemoryArtifact[] => {
        const selected = scenePayload.artifactIds
            .map(id => activeBundle.artifacts.find(item => item.id === id))
            .filter((item): item is QixiMemoryArtifact => Boolean(item));
        if (selected.length >= 8) return selected;
        return FALLBACK_WORDS.map((label, index) => ({ id: `fallback-word-${index}`, label, kind: index % 3 === 0 ? 'emotion' : 'phrase', evidenceIds: [] }));
    }, [activeBundle.artifacts, scenePayload.artifactIds]);

    const charWordSelections = useMemo(() => {
        const generated = scenePayload.charSelectionIds.filter(id => wordArtifacts.some(item => item.id === id));
        return generated.length ? generated : wordArtifacts.filter((_, index) => [1, 5, 8, 11].includes(index)).map(item => item.id);
    }, [scenePayload.charSelectionIds, wordArtifacts]);

    const ensureMaterials = useCallback(async (): Promise<QixiMemoryBundle> => {
        if (materialGenerationRef.current) return materialGenerationRef.current;
        setMemoryStatus('loading');
        setMemoryNotice('正在从共同记忆里辨认两条星线……');
        materialGenerationRef.current = prepareQixiMemoryBundle(char, user, apiConfig).then(prepared => {
            setMemoryBundle(prepared.bundle);
            setMemoryStatus(prepared.usedFallback ? 'fallback' : 'memory');
            setMemoryNotice(prepared.usedFallback
                ? (prepared.reason || '今夜先沿基础双层梦境前行')
                : `已找到 ${prepared.bundle.evidence.length} 段事实与 ${prepared.bundle.artifacts.length} 件记忆素材`);
            return prepared.bundle;
        }).finally(() => { materialGenerationRef.current = null; });
        return materialGenerationRef.current;
    }, [apiConfig, char, user]);

    const startFresh = useCallback(async () => {
        await ensureMaterials();
        finishRef.current = false;
        setGame({ ...freshGame(), stage: 'fakeChat' });
    }, [ensureMaterials]);

    const resume = useCallback(() => {
        if (!savedAtOpen.current) return;
        if (!memoryBundle) setMemoryBundle(loadQixiMemoryBundle(char.id) || fallbackBundle);
        setGame(savedAtOpen.current);
    }, [char.id, fallbackBundle, memoryBundle]);

    const enterInterlayer = useCallback((attitude: EntryAttitude) => {
        setGame({ ...freshGame(), stage: 'scene', attitude });
    }, []);

    const chooseOption = useCallback((optionId: string, result: string) => {
        if (sceneCompleted) return;
        setGame(current => ({
            ...current,
            decisions: { ...current.decisions, [currentSceneId]: [optionId] },
            results: { ...current.results, [currentSceneId]: [result] },
            completedScenes: unique([...current.completedScenes, currentSceneId]),
        }));
    }, [currentSceneId, sceneCompleted]);

    const toggleWord = useCallback((artifactId: string) => {
        if (sceneCompleted) return;
        setGame(current => {
            const selected = current.decisions.wordCloud || [];
            const next = selected.includes(artifactId)
                ? selected.filter(id => id !== artifactId)
                : selected.length >= WORD_PICK_COUNT
                    ? selected
                    : [...selected, artifactId];
            const complete = next.length >= WORD_PICK_COUNT;
            return {
                ...current,
                decisions: { ...current.decisions, wordCloud: next },
                results: { ...current.results, wordCloud: next.map(id => wordArtifacts.find(item => item.id === id)?.label || id) },
                completedScenes: complete ? unique([...current.completedScenes, 'wordCloud']) : current.completedScenes,
            };
        });
    }, [sceneCompleted, wordArtifacts]);

    const nextScene = useCallback(() => {
        setGame(current => current.sceneIndex >= QIXI_SCENE_IDS.length - 1
            ? { ...current, stage: 'bridge' }
            : { ...current, sceneIndex: current.sceneIndex + 1 });
    }, []);

    const journey = useMemo((): QixiJourneyBeat[] => QIXI_SCENE_IDS.map(sceneId => {
        const payload = activeBundle.scenes[sceneId];
        const decisionIds = game.decisions[sceneId] || [];
        const words = sceneId === 'wordCloud'
            ? decisionIds.map(id => wordArtifacts.find(item => item.id === id)?.label || id)
            : decisionIds.map(id => payload.options.find(option => option.id === id)?.label || id);
        return {
            sceneId,
            sceneName: SCENES[sceneId].title,
            sharedObject: payload.sharedObject,
            userChoices: words,
            userResults: game.results[sceneId] || [],
            charAction: payload.charAction,
        };
    }), [activeBundle.scenes, game.decisions, game.results, wordArtifacts]);

    const beginReunion = useCallback(async () => {
        if (reunionGenerationRef.current) return reunionGenerationRef.current;
        setGame(current => ({ ...current, stage: 'reunionLoading' }));
        reunionGenerationRef.current = prepareQixiReunion(char, user, apiConfig, activeBundle, journey, portraitPlan).then(reunion => {
            setGame(current => ({ ...current, reunion, reunionPage: 0, stage: 'reunion' }));
            return reunion;
        }).finally(() => { reunionGenerationRef.current = null; });
        return reunionGenerationRef.current;
    }, [activeBundle, apiConfig, char, journey, portraitPlan, user]);

    useEffect(() => {
        if (game.stage !== 'reunionLoading' || game.reunion || reunionGenerationRef.current) return;
        void beginReunion();
    }, [beginReunion, game.reunion, game.stage]);

    useEffect(() => {
        if (game.stage === 'cover') return;
        try { localStorage.setItem(`${STORAGE_PREFIX}${char.id}`, JSON.stringify(game)); } catch { /* optional resume */ }
    }, [char.id, game]);

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

    const updateTouchPosition = useCallback((clientX: number, clientY: number) => {
        const rect = touchAreaRef.current?.getBoundingClientRect();
        if (!rect) return { x: 50, y: 72 };
        return {
            x: Math.max(8, Math.min(92, ((clientX - rect.left) / rect.width) * 100)),
            y: Math.max(22, Math.min(90, ((clientY - rect.top) / rect.height) * 100)),
        };
    }, []);

    const completeTouch = useCallback(() => {
        joinedRef.current = true;
        touchElapsedRef.current = CONTACT_DURATION_MS;
        if (contactTimerRef.current) clearTimeout(contactTimerRef.current);
        setTouch(current => ({ ...current, active: true, approaching: true, joined: true, releasedEarly: false }));
        navigator.vibrate?.([22, 42, 22]);
    }, []);

    const beginTouch = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (joinedRef.current) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        touchingRef.current = true;
        joinedRef.current = false;
        touchElapsedRef.current = 0;
        setTouch({ ...updateTouchPosition(event.clientX, event.clientY), active: true, approaching: false, joined: false, releasedEarly: false });
        if (approachTimerRef.current) clearTimeout(approachTimerRef.current);
        if (contactTimerRef.current) clearTimeout(contactTimerRef.current);
        approachTimerRef.current = setTimeout(() => { if (touchingRef.current) setTouch(current => ({ ...current, approaching: true })); }, 260);
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
            setGame(current => ({ ...current, stage: 'ending' }));
            return;
        }
        setTouch(current => ({ ...current, active: false, approaching: false, releasedEarly: true }));
    }, []);

    const finishToChat = useCallback(async () => {
        if (finishRef.current) return;
        finishRef.current = true;
        const message = game.reunion?.returnMessage || `七夕快乐，${user.name}。`;
        try {
            if (onReturnToChat) await onReturnToChat(message);
            else onClose();
        } catch {
            finishRef.current = false;
        }
    }, [game.reunion?.returnMessage, onClose, onReturnToChat, user.name]);

    useEffect(() => {
        finishToChatRef.current = finishToChat;
    }, [finishToChat]);

    useEffect(() => {
        if (game.stage !== 'ending') return;
        const timer = window.setTimeout(() => void finishToChatRef.current(), 2600);
        return () => window.clearTimeout(timer);
    }, [game.stage]);

    const visibleActions = useMemo(() => {
        if (game.stage === 'cover') return memoryStatus === 'loading' ? ['正在辨认共同记忆'] : savedAtOpen.current ? ['进入梦境', '继续上次探索'] : ['进入梦境'];
        if (game.stage === 'entry') return ['探索附近', '喊 ta 的名字', '留在原地'];
        if (game.stage === 'scene') {
            if (currentSceneId === 'wordCloud' && !sceneCompleted) return wordArtifacts.map(item => item.label);
            if (!sceneCompleted) return scenePayload.options.map(option => option.label);
            return [game.sceneIndex === QIXI_SCENE_IDS.length - 1 ? '让痕迹汇成桥' : '沿星线继续'];
        }
        if (game.stage === 'bridge') return ['走上鹊桥'];
        if (game.stage === 'reunion') return ['继续'];
        if (game.stage === 'touch') return [touch.joined ? '松手' : '持续按住'];
        return [];
    }, [currentSceneId, game.sceneIndex, game.stage, memoryStatus, sceneCompleted, scenePayload.options, touch.joined, wordArtifacts]);

    useEffect(() => {
        const renderState = () => JSON.stringify({
            game: 'qixi-dual-layer-v7',
            coordinateSystem: 'full-screen story surface; touch coordinates are percentages from top-left',
            stage: game.stage,
            scene: game.stage === 'scene' ? { id: currentSceneId, title: sceneMeta.title, index: game.sceneIndex + 1, completed: sceneCompleted } : undefined,
            material: { status: memoryStatus, evidence: activeBundle.evidence.length, artifacts: activeBundle.artifacts.length, personalizedScenes: activeBundle.personalizedSceneIds },
            selected: game.stage === 'scene' ? sceneDecisions : undefined,
            completedScenes: game.completedScenes,
            reunionPage: game.stage === 'reunion' ? game.reunionPage : undefined,
            portrait: game.reunion?.portrait.resourceType,
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
    }, [activeBundle, completeTouch, currentSceneId, game, memoryStatus, sceneCompleted, sceneDecisions, sceneMeta.title, touch, visibleActions]);

    const renderCover = () => (
        <main className="q7-cover">
            <CelestialBackdrop /><ExitButton onClose={onClose} />
            <div className="q7-cover-frame" aria-hidden="true"><i /><i /><i /><i /></div>
            <section>
                <div className="q7-season"><i>✦</i><span>2026 · 七夕限定梦境</span><i>✦</i></div>
                <div className="q7-moons" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
                <h1><small>星月</small>梦境童话</h1>
                <em>THE TALE BETWEEN TWO LAYERS</em>
                <blockquote>沿着同一件物品的两面，<br />寻找那个始终只差一层的人。</blockquote>
                <button type="button" data-qixi-action="enter-dream" className="q7-primary" onClick={startFresh} disabled={memoryStatus === 'loading'}><span>{memoryStatus === 'loading' ? '确认两条星线中' : '进入梦境'}</span><small>{memoryStatus === 'loading' ? 'TRACING MEMORIES' : 'ENTER REVERIE'}</small></button>
                {memoryNotice && <p className={`q7-notice is-${memoryStatus}`}>{memoryNotice}</p>}
                {savedAtOpen.current && <button type="button" data-qixi-action="resume" className="q7-resume" onClick={resume}>继续上次掉下去的地方</button>}
            </section>
        </main>
    );

    const renderFakeChat = () => (
        <main className="q7-chat"><ExitButton onClose={onClose} /><header><button>‹</button><i>{char.name.trim().charAt(0)}</i><span><b>{char.name}</b><small>在线</small></span></header><section><time>七夕 · 23:57</time><p>我给你准备了一个特别活动。</p><p>但先别碰下面那个输入框。</p><em>对方撤回了一条说明</em></section><footer><button>＋</button><button type="button" data-qixi-action="send-code" onClick={() => setGame(current => ({ ...current, stage: 'distort' }))}>没过期，我只是加载得慢</button><button>↑</button></footer></main>
    );

    const renderDistort = () => (
        <main className="q7-distort"><ExitButton onClose={onClose} /><div className="q7-tunnel" aria-hidden="true"><i /><i /><i /><i /><span className="rabbit"><i /></span></div><header><small>CHAT / REVERIE</small>{char.name}<span>等等我 · 正在输入</span></header><div className="shard s1">我给你准备了一个</div><div className="shard s2">这边</div><div className="shard s3">没过期</div><div className="shard s4">你在哪里</div><button type="button" data-qixi-action="fall" className="q7-door" onClick={() => setGame(current => ({ ...current, stage: 'entry' }))}><small>一行空白在脚下变成了门</small><b>白兔已经跳进去了。</b><span>跟上它 ↓</span></button></main>
    );

    const renderEntry = () => (
        <main className="q7-story q7-entry"><CelestialBackdrop /><ExitButton onClose={onClose} /><section><p className="q7-kicker">夹层入口 · 坐标丢失</p><h2>你掉进了<br />一个夹层。</h2><p>上面是你刚才看见的聊天。下面没有地面，只有一行一行还没来得及成为回答的字。</p><aside>这里没有 {char.name}。至少看起来没有。</aside><button data-qixi-action="entry-explore" onClick={() => enterInterlayer('explore')}>探索附近 <i>→</i></button><button data-qixi-action="entry-shout" onClick={() => enterInterlayer('shout')}>大吵大闹，喊 ta 的名字 <i>→</i></button><button data-qixi-action="entry-stay" onClick={() => enterInterlayer('stay')}>哪里也不去，留在原地 <i>→</i></button></section></main>
    );

    const attitudeLine = game.attitude === 'shout'
        ? '你喊出的名字还在不同层之间反弹。没有回答。'
        : game.attitude === 'stay'
            ? '你确实等了一会儿。随后，脚下的空白自己向前移动。'
            : '第一步落下时，一件无法送达的东西在远处亮起。';

    const renderScene = () => (
        <main className={`q7-story q7-scene is-${currentSceneId}`} style={{ '--user-color': sceneMeta.userColor, '--char-color': sceneMeta.charColor } as React.CSSProperties}>
            <CelestialBackdrop /><ExitButton onClose={onClose} />
            <div className="q7-route" aria-label="七夕星路">{QIXI_SCENE_IDS.map((id, index) => <i key={id} className={`${index === game.sceneIndex ? 'is-current' : ''} ${game.completedScenes.includes(id) ? 'is-done' : ''}`}><span>{String(index + 1).padStart(2, '0')}</span></i>)}<b className="bridge-dot">∞</b></div>
            <header><p className="q7-kicker">{String(game.sceneIndex + 1).padStart(2, '0')} · {sceneMeta.intention}</p><h2>{sceneMeta.title}</h2><em>{sceneMeta.ritual}</em>{game.sceneIndex === 0 && <small>{attitudeLine}</small>}</header>
            <section className="q7-scene-grid">
                <div className="q7-visual"><SceneObject sceneId={currentSceneId} label={scenePayload.sharedObject} completed={sceneCompleted} /><p>{scenePayload.memoryLine}</p></div>
                <div className="q7-interaction">
                    {!sceneCompleted && currentSceneId !== 'wordCloud' && <><small>你可以</small>{scenePayload.options.map(option => <button key={option.id} type="button" data-qixi-action={`choose-${currentSceneId}-${option.id}`} onClick={() => chooseOption(option.id, option.result)}>{option.label}<i>→</i></button>)}</>}
                    {!sceneCompleted && currentSceneId === 'wordCloud' && <><small>选几个你觉得最像 ta 的词</small><div className="q7-words">{wordArtifacts.map(item => <button key={item.id} type="button" className={sceneDecisions.includes(item.id) ? 'is-user' : ''} data-qixi-action={`word-${item.id}`} onClick={() => toggleWord(item.id)}>{item.label}</button>)}</div><p className="q7-pick-hint">选中的词会留下你的颜色。</p></>}
                    {sceneCompleted && <div className="q7-result"><small>你的这一层</small>{(game.results[currentSceneId] || []).map((result, index) => <p key={index}>{result}</p>)}{currentSceneId === 'wordCloud' && <div className="q7-words is-reveal">{wordArtifacts.map(item => <span key={item.id} className={`${sceneDecisions.includes(item.id) ? 'is-user' : ''} ${charWordSelections.includes(item.id) ? 'is-char' : ''}`}>{item.label}</span>)}</div>}<div className="q7-other-layer"><small>另一层 · 正在发生</small><p>{scenePayload.charAction}</p></div><blockquote>{scenePayload.reveal}</blockquote><button type="button" data-qixi-action="next-scene" className="q7-next" onClick={nextScene}>{game.sceneIndex === QIXI_SCENE_IDS.length - 1 ? '让这些痕迹汇成桥' : '沿星线继续'} <i>→</i></button></div>}
                </div>
            </section>
        </main>
    );

    const renderBridge = () => (
        <main className="q7-story q7-bridge"><CelestialBackdrop /><ExitButton onClose={onClose} /><div className="q7-bridge-lines" aria-hidden="true">{QIXI_SCENE_IDS.map((id, index) => <i key={id} style={{ '--line-top': `${8 + index * 11}%`, '--line-angle': `${-13 + index * 4}deg`, '--line-angle-end': `${-8 + index * 4}deg`, '--line-delay': `${index * -.2}s` } as React.CSSProperties} />)}<span>{user.name}</span></div><section><p className="q7-kicker">08 · 鹊桥 / 双层汇合</p><h2>所有物件都<br />向同一点移动。</h2><p>负片句子、愿望笺、针线、供物、水纹、夜市纸袋和被点亮的词，在两层之间自行排列。</p><button type="button" data-qixi-action="begin-reunion" onClick={() => void beginReunion()}>走上鹊桥 <i>→</i></button></section></main>
    );

    const renderReunionLoading = () => (
        <main className="q7-reunion-loading"><CelestialBackdrop /><ExitButton onClose={onClose} /><div><i /><span /><i /></div><p>桥的另一端正在成为<br />你熟悉的那个 ta……</p></main>
    );

    const renderReunion = () => {
        const reunion = game.reunion!;
        const pages = [reunion.reunion.lines, reunion.metaReflection, reunion.blessing];
        const page = pages[Math.min(game.reunionPage, pages.length - 1)];
        const last = game.reunionPage >= pages.length - 1;
        return <main className="q7-reunion"><CelestialBackdrop /><ExitButton onClose={onClose} /><QixiPortrait char={char} reunion={reunion} /><div className="q7-reunion-copy"><small>{game.reunionPage === 0 ? '终于看见' : game.reunionPage === 1 ? '隔层回声' : '七夕祝愿'}</small><h2>{char.name}</h2>{page.map((line, index) => <p key={index}>“{line}”</p>)}<button type="button" data-qixi-action={last ? 'begin-touch' : 'reunion-next'} onClick={() => last ? setGame(current => ({ ...current, stage: 'touch' })) : setGame(current => ({ ...current, reunionPage: current.reunionPage + 1 }))}>{last ? '走近 ta' : '继续'} <i>→</i></button></div></main>;
    };

    const renderTouch = () => {
        const reunion = game.reunion!;
        const touchLine = touch.joined ? reunion.touch.complete : touch.approaching ? reunion.touch.hold : reunion.touch.start;
        return <main className="q7-touch"><ExitButton onClose={onClose} /><div ref={touchAreaRef} className={`${touch.active ? 'is-active' : ''} ${touch.approaching ? 'is-approaching' : ''} ${touch.joined ? 'is-joined' : ''}`} onPointerDown={beginTouch} onPointerMove={moveTouch} onPointerUp={endTouch} onPointerCancel={endTouch} style={{ '--touch-x': `${touch.x}%`, '--touch-y': `${touch.y}%` } as React.CSSProperties}><div className="q7-touch-name">{char.name}</div>{!touch.active && !touch.joined && <section><p>把手放上来。</p>{touch.releasedEarly && <small>再试一次。</small>}</section>}{touch.active && <blockquote>“{touchLine}”</blockquote>}<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={`M 104 5 C 85 18, ${Math.min(94, touch.x + 22)} ${Math.max(10, touch.y - 22)}, ${touch.x} ${touch.y}`} /></svg><div className="q7-user-hand"><i /></div><div className="q7-char-hand"><i /></div></div></main>;
    };

    const renderEnding = () => (
        <main className="q7-ending"><section><p>你松开手。</p><p>屏幕重新变成普通的屏幕。</p><h2>{char.name} 还在那里。</h2><button type="button" data-qixi-action="return-chat" onClick={() => void finishToChat()}>回到聊天</button></section></main>
    );

    return createPortal(
        <div ref={rootRef} className="qixi-v7-root">
            {game.stage === 'cover' && renderCover()}
            {game.stage === 'fakeChat' && renderFakeChat()}
            {game.stage === 'distort' && renderDistort()}
            {game.stage === 'entry' && renderEntry()}
            {game.stage === 'scene' && renderScene()}
            {game.stage === 'bridge' && renderBridge()}
            {game.stage === 'reunionLoading' && renderReunionLoading()}
            {game.stage === 'reunion' && game.reunion && renderReunion()}
            {game.stage === 'touch' && game.reunion && renderTouch()}
            {game.stage === 'ending' && renderEnding()}
            <style>{`
                @keyframes q7-sky-drift{to{transform:translate3d(1.5%,-1%,0) scale(1.02)}}@keyframes q7-ring{to{transform:rotate(360deg)}}@keyframes q7-hop{50%{transform:translateY(-15px) rotate(8deg)}}@keyframes q7-card{50%{transform:translateY(-9px) rotate(-1deg)}}@keyframes q7-thread{0%{stroke-dashoffset:410}55%,100%{stroke-dashoffset:0}}@keyframes q7-water{0%{opacity:.8;transform:scale(.3)}100%{opacity:0;transform:scale(1.25)}}@keyframes q7-other{from{opacity:0;transform:translateX(15px)}to{opacity:1;transform:none}}@keyframes q7-bridge-line{to{transform:rotate(calc(-8deg + var(--i) * 4deg)) translateX(-5%)}}@keyframes q7-name{50%{opacity:.6;filter:blur(1px)}}@keyframes q7-loading{50%{transform:scaleX(.35);opacity:.45}}@keyframes q7-portrait{from{opacity:0;transform:translateX(-50%) translateY(24px) scale(.98)}to{opacity:1;transform:translateX(-50%)}}@keyframes q7-ending{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
                @media(max-width:760px){.q7-cover>section{padding:72px 12px 50px}.q7-cover h1{font-size:53px}.q7-cover h1 small{font-size:.43em}.q7-cover blockquote{margin:27px 0 24px;font-size:12px}.q7-primary{min-height:70px}.q7-primary span{font-size:15px}.q7-story{padding:102px 20px 55px}.q7-entry h2{font-size:48px}.q7-route{left:18px;right:66px;top:max(22px,env(safe-area-inset-top));gap:5px}.q7-route>i{width:23px;height:23px}.q7-route>i.is-current{width:29px;height:29px}.q7-route>i span{font-size:6px}.q7-scene>header{margin-bottom:28px}.q7-scene>header h2{font-size:42px}.q7-scene-grid{display:block}.q7-object{width:min(270px,72vw)}.q7-visual>p{margin-top:17px;font-size:11px}.q7-interaction{margin-top:34px}.q7-interaction>button{font-size:13px}.q7-result>p{font-size:13px}.q7-other-layer{margin-top:23px}.q7-words{gap:8px}.q7-words button,.q7-words span{padding:8px 10px;font-size:10px}.q7-bridge{align-items:start}.q7-bridge>section{width:auto;margin:0;padding-top:23vh}.q7-bridge h2{font-size:48px}.q7-bridge-lines{right:-20vw;top:72%;width:100vw;height:45vh;opacity:.65}.q7-reunion{display:block;overflow:auto!important}.q7-portrait{min-height:52vh}.q7-portrait img{height:98%;max-width:100%}.q7-reunion-copy{padding:24px 22px 70px}.q7-reunion-copy h2{margin:9px 0 19px;font-size:46px}.q7-reunion-copy p{font-size:13px}.q7-touch-name{top:13%}.q7-touch section p,.q7-touch blockquote{font-size:27px}.q7-distort header{top:12%;font-size:45px}.q7-door{bottom:10%;width:82vw}.q7-chat section p{font-size:13px}}
                @media(max-height:700px) and (max-width:760px){.q7-cover>section{padding-top:42px}.q7-moons{margin:16px 0}.q7-cover h1{font-size:44px}.q7-cover blockquote{margin:18px 0}.q7-primary{min-height:60px}.q7-object{width:220px}.q7-scene>header{margin-bottom:18px}.q7-scene>header h2{font-size:36px}.q7-visual>p{display:none}}
                @media(prefers-reduced-motion:reduce){.qixi-v7-root *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
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

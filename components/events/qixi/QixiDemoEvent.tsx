import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { APIConfig, CharacterProfile, SpriteConfig, UserProfile } from '../../../types';
import Live2DAvatarCanvas, { Live2DActionTrigger } from '../../call/Live2DAvatarCanvas';
import { useBlobRefUrl } from '../../../utils/blobRef';
import { DEFAULT_STAGE_FRAMING } from '../../../utils/avatarPerformance';
import { BUILTIN_SULLY_DEFAULT_FRAMING, isBuiltinSullyLive2D } from '../../../utils/builtinSullyLive2D';
import './QixiDemoEvent.css';
import './QixiDemoRound2.css';
import { QixiBGMToggle, useQixiBGM } from './QixiBGM';
import {
    createQixiFallbackBundle,
    loadQixiMemoryBundle,
    prepareQixiMemoryBundle,
    QixiMemoryArtifact,
    QixiMemoryBundle,
    QixiSceneId,
    QIXI_SCENE_IDS,
    qixiCharMutter,
    qixiCharVisibleText,
    qixiTransitionLines,
} from '../../../utils/qixiMemoryBundle';
import {
    normalizeQixiBridgeBundle,
    prepareQixiBridge,
    QixiBridgeBundle,
} from '../../../utils/qixiBridge';
import {
    createQixiReunionFallback,
    prepareQixiReunion,
    QixiJourneyBeat,
    QixiPortraitStage,
    QixiReunionBundle,
    resolveQixiPortraitPlan,
} from '../../../utils/qixiReunion';
import {
    createQixiEventChatCard,
    QixiEventChatCard,
} from '../../../utils/qixiChatCard';
import { enterQixiInterlayerState, QixiEntryAttitude, selectQixiWordTurn } from '../../../utils/qixiSessionState';

export const QIXI_DEMO_RECORD_KEY = 'qixi_2026_dual_layer_v7';

type Stage = 'cover' | 'loading' | 'fakeChat' | 'distort' | 'entry' | 'sceneTransition' | 'scene' | 'bridgeLoading' | 'bridge' | 'bridgeCrossing' | 'reunionLoading' | 'reunion' | 'touch' | 'ending';
type EntryAttitude = QixiEntryAttitude;
type SceneBeat = 'idle' | 'user' | 'char' | 'complete';
type GenerationPart = 'part1' | 'part2' | 'part3';
type GenerationState = 'idle' | 'generating' | 'ready' | 'error';

export interface QixiGameV8 {
    version: 8;
    stage: Stage;
    attitude?: EntryAttitude;
    sceneIndex: number;
    sceneBeat: SceneBeat;
    wordCloudCharRevealed: number;
    decisions: Partial<Record<QixiSceneId, string[]>>;
    results: Partial<Record<QixiSceneId, string[]>>;
    completedScenes: QixiSceneId[];
    bridge?: QixiBridgeBundle;
    bridgePlaced: string[];
    bridgeFinalState?: 'idle' | 'flying' | 'connected';
    reunion?: QixiReunionBundle;
    reunionPage: number;
    reunionLineIndex: number;
}

export type QixiSessionMode = 'fresh' | 'replay';

export interface QixiReplaySnapshot {
    version: 8;
    bundle: QixiMemoryBundle;
    game: QixiGameV8;
}

export interface QixiReturnPayload {
    message: string;
    card: QixiEventChatCard;
    replaySnapshot: QixiReplaySnapshot;
}

interface TouchState {
    x: number;
    y: number;
    active: boolean;
    approaching: boolean;
    joined: boolean;
    releasedEarly: boolean;
    releasedAfterJoin: boolean;
}

interface QixiDemoSessionProps {
    char: CharacterProfile;
    user: UserProfile;
    apiConfig: APIConfig;
    onClose: () => void;
    sessionMode?: QixiSessionMode;
    replaySnapshot?: QixiReplaySnapshot | null;
    onReturnToChat?: (payload: QixiReturnPayload) => Promise<void> | void;
    onPortraitConfigSave?: (config: SpriteConfig) => void;
}

interface SceneMeta {
    title: string;
    ritual: string;
    intention: string;
    userColor: string;
    charColor: string;
}

const STORAGE_PREFIX = 'sullyos_qixi_dual_layer_v8_';
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

const createPlannedJourney = (bundle: QixiMemoryBundle): QixiJourneyBeat[] => QIXI_SCENE_IDS.map(sceneId => ({
    sceneId,
    sceneName: SCENES[sceneId].title,
    sharedObject: bundle.scenes[sceneId].sharedObject,
    userChoices: [],
    userResults: [],
    charAction: bundle.scenes[sceneId].charAction,
}));

const FALLBACK_WORDS = ['认真', '嘴硬', '晚睡', '温柔', '小事', '耐心', '好奇', '勇气', '安静', '分享', '想念', '自由', '努力', '休息'];

const freshGame = (): QixiGameV8 => ({
    version: 8,
    stage: 'cover',
    sceneIndex: 0,
    sceneBeat: 'idle',
    wordCloudCharRevealed: 0,
    decisions: {},
    results: {},
    completedScenes: [],
    bridgePlaced: [],
    bridgeFinalState: 'idle',
    reunionPage: 0,
    reunionLineIndex: 0,
});

const loadGame = (charId: string): QixiGameV8 | null => {
    try {
        const value = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${charId}`) || 'null') as QixiGameV8 | null;
        return value?.version === 8 ? {
            ...value,
            bridgeFinalState: value.bridgeFinalState || 'idle',
            reunionLineIndex: value.reunionLineIndex || 0,
            wordCloudCharRevealed: value.wordCloudCharRevealed || 0,
        } : null;
    } catch {
        return null;
    }
};

const unique = <T,>(items: T[]): T[] => [...new Set(items)];
const createRunId = (): string => globalThis.crypto?.randomUUID?.() || `qixi-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const qixiChibiRaw = (char: CharacterProfile): string | undefined => char.vrState?.chibi?.img || char.sprites?.chibi;

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

interface QixiFlappyHandle {
    advanceTime: (ms: number) => void;
    state: () => { score: number; alive: boolean; ready: boolean; y: number };
}

const QixiFlappyLoader = React.forwardRef<QixiFlappyHandle, {
    char: CharacterProfile;
    ready: boolean;
    notice: string;
    onClose: () => void;
    onContinue: () => void;
}>(({ char, ready, notice, onClose, onContinue }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const rafRef = useRef(0);
    const readySinceRef = useRef<number | null>(null);
    const [ui, setUi] = useState({ score: 0, alive: true });
    const spriteUrl = useBlobRefUrl(qixiChibiRaw(char));
    const simRef = useRef({
        y: 250,
        vy: 0,
        score: 0,
        alive: true,
        time: 0,
        nextPipe: 1.35,
        pipes: [] as Array<{ x: number; gapY: number; counted: boolean }>,
    });

    const reset = useCallback(() => {
        simRef.current = { y: 250, vy: -110, score: 0, alive: true, time: 0, nextPipe: 1.2, pipes: [] };
        setUi({ score: 0, alive: true });
    }, []);

    const step = useCallback((ms: number) => {
        const state = simRef.current;
        if (!state.alive) return;
        const dt = Math.min(0.04, Math.max(0, ms / 1000));
        state.time += dt;
        state.vy += 780 * dt;
        state.y += state.vy * dt;
        state.nextPipe -= dt;
        if (state.nextPipe <= 0) {
            const deterministicGap = (Math.round(state.time * 10) * 37 + state.pipes.length * 71 + state.score * 53) % 220;
            state.pipes.push({ x: 410, gapY: 135 + deterministicGap, counted: false });
            state.nextPipe = 1.75;
        }
        state.pipes.forEach(pipe => { pipe.x -= 118 * dt; });
        state.pipes = state.pipes.filter(pipe => pipe.x > -70);
        for (const pipe of state.pipes) {
            if (!pipe.counted && pipe.x < 76) {
                pipe.counted = true;
                state.score += 1;
                setUi(current => ({ ...current, score: state.score }));
            }
            const overlapsX = pipe.x < 105 && pipe.x + 58 > 48;
            const outsideGap = state.y - 23 < pipe.gapY - 73 || state.y + 23 > pipe.gapY + 73;
            if (overlapsX && outsideGap) state.alive = false;
        }
        if (state.y < 24) { state.y = 24; state.vy = 20; }
        if (state.y > 492) state.alive = false;
        if (ready && readySinceRef.current && performance.now() - readySinceRef.current > 2600) {
            state.vy += 950 * dt;
            if (state.y > 474) state.alive = false;
        }
        if (!state.alive) setUi(current => ({ ...current, alive: false }));
    }, [ready]);

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const state = simRef.current;
        ctx.clearRect(0, 0, 360, 520);
        const gradient = ctx.createLinearGradient(0, 0, 0, 520);
        gradient.addColorStop(0, '#2b173f');
        gradient.addColorStop(1, '#120a20');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 360, 520);
        ctx.strokeStyle = 'rgba(236,203,229,.12)';
        ctx.setLineDash([2, 9]);
        for (let y = 62; y < 520; y += 72) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(360, y - 34); ctx.stroke();
        }
        ctx.setLineDash([]);
        for (const pipe of state.pipes) {
            const topH = pipe.gapY - 73;
            const bottomY = pipe.gapY + 73;
            ctx.fillStyle = 'rgba(153,112,181,.54)';
            ctx.strokeStyle = 'rgba(244,205,228,.42)';
            ctx.lineWidth = 1;
            ctx.fillRect(pipe.x, 0, 58, topH);
            ctx.strokeRect(pipe.x, 0, 58, topH);
            ctx.fillRect(pipe.x, bottomY, 58, 520 - bottomY);
            ctx.strokeRect(pipe.x, bottomY, 58, 520 - bottomY);
            ctx.fillStyle = 'rgba(255,237,246,.62)';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(topH % 2 ? '{…}' : '[消息]', pipe.x + 29, Math.max(24, topH - 14));
            ctx.fillText('上下文', pipe.x + 29, bottomY + 22);
        }
        ctx.save();
        ctx.translate(76, state.y);
        ctx.rotate(Math.max(-0.24, Math.min(0.35, state.vy / 900)));
        const image = imageRef.current;
        if (image?.complete && image.naturalWidth) {
            ctx.drawImage(image, -31, -31, 62, 62);
        } else {
            ctx.fillStyle = '#efb4ce';
            ctx.beginPath(); ctx.arc(0, 0, 25, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#2a1638';
            ctx.font = 'bold 18px serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(char.name.trim().charAt(0).toUpperCase(), 0, 1);
        }
        ctx.restore();
        ctx.fillStyle = '#efca92';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`SCORE ${String(state.score).padStart(2, '0')}`, 16, 25);
    }, [char.name]);

    useEffect(() => {
        if (!spriteUrl) { imageRef.current = null; return; }
        const image = new Image();
        image.src = spriteUrl;
        imageRef.current = image;
    }, [spriteUrl]);

    useEffect(() => {
        if (ready && readySinceRef.current === null) readySinceRef.current = performance.now();
    }, [ready]);

    useEffect(() => {
        let previous = performance.now();
        const frame = (now: number) => {
            step(now - previous);
            previous = now;
            draw();
            rafRef.current = requestAnimationFrame(frame);
        };
        rafRef.current = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(rafRef.current);
    }, [draw, step]);

    useEffect(() => {
        if (!ready || ui.alive) return;
        navigator.vibrate?.(18);
    }, [ready, ui.alive]);

    React.useImperativeHandle(ref, () => ({
        advanceTime: step,
        state: () => ({ score: simRef.current.score, alive: simRef.current.alive, ready, y: Math.round(simRef.current.y) }),
    }), [ready, step]);

    const flap = () => {
        if (!simRef.current.alive) {
            if (ready) return;
            reset();
            return;
        }
        simRef.current.vy = -315;
    };

    return <main className="q7-loading-game"><ExitButton onClose={onClose} /><section><p className="q7-kicker">MEMORY SORTING · FLAPPY CHAR</p><h2>穿过正在整理的<br />上下文碎片</h2><p>正在整理你和 {char.name} 的聊天与共同记忆，这一步可能需要稍长时间。</p>{notice && <small className="q7-loading-status">{notice}</small>}</section><div className="q7-flappy-shell"><canvas ref={canvasRef} width={360} height={520} onPointerDown={flap} aria-label="点击或触摸让角色上升" />{!ui.alive && !ready && <button type="button" onClick={reset}>再飞一次</button>}{!ui.alive && ready && <div className="q7-flappy-ready"><small>MEMORIES READY</small><b>记忆整理完成。</b><button type="button" data-qixi-action="loading-continue" onClick={onContinue}>落进那条异常消息</button></div>}</div><footer>点击 / 触摸，让 {char.name} 上升</footer></main>;
});
QixiFlappyLoader.displayName = 'QixiFlappyLoader';

const AnimatedText: React.FC<{ text: string; className?: string }> = ({ text, className }) => (
    <span className={className} aria-label={text}>{[...text].map((char, index) => <i key={`${char}-${index}`} style={{ '--char-index': index } as React.CSSProperties}>{char}</i>)}</span>
);

const SceneObject: React.FC<{
    sceneId: QixiSceneId;
    label: string;
    beat: SceneBeat;
    userText?: string;
    charText?: string;
    charMutter?: string;
    fragments?: QixiMemoryArtifact[];
    touchedFragment?: string;
    showLostFragments?: boolean;
    onFragmentTouch?: (id: string) => void;
}> = ({ sceneId, label, beat, userText, charText, charMutter, fragments = [], touchedFragment, showLostFragments = false, onFragmentTouch }) => {
    const changedByChar = beat === 'char' || beat === 'complete';
    return <div className={`q7-object is-${sceneId} is-beat-${beat}`} aria-label={label}>
        {sceneId === 'lostLayer' && <div className="q7-message-object">
            <i className="q7-message-line" /><i className="q7-message-line" /><i className="q7-message-line" />
            <b className="q7-delivery-error"><span>DELIVERY FAILED</span></b>
            {(showLostFragments || changedByChar) && <div className="q7-leaked-lines">{fragments.slice(0, 5).map((item, index) => <button type="button" key={item.id} style={{ '--leak-index': index } as React.CSSProperties} className={`${touchedFragment === item.id ? 'is-user-touched' : ''} ${changedByChar && index < 3 ? 'is-taken' : ''}`} onClick={() => onFragmentTouch?.(item.id)}><span>{item.label}</span></button>)}</div>}
            {changedByChar && <div className="q7-char-overwrite">
                {charMutter && <AnimatedText className="q7-char-mutter" text={charMutter} />}
                <span className="q7-error-scribble" aria-hidden="true"><i /><i /><i /></span>
            </div>}
            {changedByChar && charText && <AnimatedText className="q7-lost-core-instruction" text={charText} />}
        </div>}
        {sceneId === 'doubleWish' && <div className={`q7-wish-object ${changedByChar ? 'is-flipped' : ''}`}><div className="front"><i>愿</i>{userText && <AnimatedText text={userText} />}</div><div className="back">{charText && <AnimatedText text={charText} />}</div><span className="hanger" /></div>}
        {sceneId === 'threadNeedle' && <svg viewBox="0 0 260 220" aria-hidden="true"><path className="needle" d="M175 26L83 187" /><ellipse className="eye" cx="170" cy="35" rx="7" ry="14" transform="rotate(31 170 35)" /><path className="thread" d="M25 151C87 75 153 170 211 86S292 71 236 174" /></svg>}
        {sceneId === 'offerings' && <div className="q7-altar-object"><span /><i className="fruit one" /><i className="fruit two" /><i className="cup" />{changedByChar && <i className="from-char" />}</div>}
        {sceneId === 'reflection' && <div className="q7-water-object"><i /><i /><i /><span />{changedByChar && <b />}</div>}
        {sceneId === 'nightMarket' && <div className="q7-market-object"><span /><i>小事</i><i className={changedByChar ? 'is-sold' : ''}>{changedByChar ? '售罄' : '称呼'}</i><i>饮料</i></div>}
        {sceneId === 'wordCloud' && <div className="q7-vine-object"><i /><i /><i /><span /></div>}
        {beat === 'user' && userText && sceneId !== 'doubleWish' && <AnimatedText className="q7-user-object-text" text={userText} />}
        {changedByChar && charText && !['doubleWish', 'lostLayer'].includes(sceneId) && <AnimatedText className="q7-char-object-text" text={charText} />}
        <small>{label}</small>
    </div>;
};

const activeMeetingSprites = (char: CharacterProfile): Record<string, string> => {
    const skin = char.activeSkinSetId
        ? char.dateSkinSets?.find(item => item.id === char.activeSkinSetId)
        : undefined;
    return skin?.sprites && Object.keys(skin.sprites).length ? skin.sprites : (char.sprites || {});
};

const QixiPortrait: React.FC<{
    char: CharacterProfile;
    reunion: QixiReunionBundle;
    stage: QixiPortraitStage;
    adjustable?: boolean;
    onMeetingConfigSave?: (config: SpriteConfig) => void;
}> = ({ char, reunion, stage, adjustable = false, onMeetingConfigSave }) => {
    const [live2dFailed, setLive2dFailed] = useState(false);
    const [meetingFailed, setMeetingFailed] = useState(false);
    const [chibiFailed, setChibiFailed] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [meetingConfig, setMeetingConfig] = useState<SpriteConfig>(() => char.spriteConfig || { scale: 1, x: 0, y: 0 });
    const meetingSprites = activeMeetingSprites(char);
    const cue = reunion.portrait.stages[stage];
    const meetingKeys = Object.keys(meetingSprites).filter(key => !['chibi', 'thumbnail', 'icon', 'avatar'].includes(key.toLowerCase()));
    const meetingKey = cue.meetingExpression && meetingKeys.includes(cue.meetingExpression)
        ? cue.meetingExpression
        : meetingKeys.includes('normal') ? 'normal' : meetingKeys[0];
    const meetingRaw = meetingKey ? meetingSprites[meetingKey] : undefined;
    const chibiRaw = qixiChibiRaw(char);
    const meetingUrl = useBlobRefUrl(meetingRaw);
    const chibiUrl = useBlobRefUrl(chibiRaw);
    const live2DFraming = char.videoAvatar?.companionFraming
        || (isBuiltinSullyLive2D(char.videoAvatar) ? { ...BUILTIN_SULLY_DEFAULT_FRAMING } : DEFAULT_STAGE_FRAMING);
    const companionCrop = char.videoAvatar?.companionCrop;
    const cropAdjusted = Boolean(companionCrop && [companionCrop.top, companionCrop.right, companionCrop.bottom, companionCrop.left].some(value => value > .001));
    const live2DClipPath = cropAdjusted && companionCrop
        ? `inset(${companionCrop.top * 100}% ${companionCrop.right * 100}% ${companionCrop.bottom * 100}% ${companionCrop.left * 100}% round 1.4rem)`
        : undefined;
    const manualAction = useMemo<Live2DActionTrigger | null>(() => cue.l2dExpression
        ? { id: cue.l2dExpression, nonce: Date.now() }
        : null, [cue.l2dExpression]);
    useEffect(() => setMeetingFailed(false), [meetingUrl]);
    useEffect(() => setChibiFailed(false), [chibiUrl]);
    useEffect(() => {
        setMeetingConfig(char.spriteConfig || { scale: 1, x: 0, y: 0 });
    }, [char.id, char.spriteConfig?.scale, char.spriteConfig?.x, char.spriteConfig?.y]);
    if (char.videoAvatar?.format === 'live2d' && !live2dFailed) {
        return <div className="q7-portrait is-live2d" style={{ clipPath: live2DClipPath }}><Live2DAvatarCanvas config={char.videoAvatar} framing={live2DFraming} motionState="idle" manualAction={manualAction} ambientAutonomyDisabled preserveActiveWardrobe onError={() => setLive2dFailed(true)} /></div>;
    }
    const meetingStyle: React.CSSProperties = {
        animation: 'q7-gal-portrait .7s ease both',
        transform: `translate(calc(-50% + ${meetingConfig.x}%), ${meetingConfig.y}%) scale(${meetingConfig.scale})`,
    };
    if (meetingUrl && !meetingFailed) {
        return <>
            <div className="q7-portrait is-meeting" data-emotion={cue.emotionIntent}><img src={meetingUrl} alt={char.name} onError={() => setMeetingFailed(true)} style={meetingStyle} /></div>
            {adjustable && <div className="q7-portrait-adjust">
                <button type="button" className="q7-portrait-adjust-toggle" aria-label="调整立绘大小与位置" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(open => !open)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.86 1.86-.06-.06A1.7 1.7 0 0 0 16 18.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V20h-2.6v-.1A1.7 1.7 0 0 0 10.9 18.4a1.7 1.7 0 0 0-1.88.34l-.06.06-1.86-1.86.06-.06A1.7 1.7 0 0 0 7.5 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H5.7V11h.1A1.7 1.7 0 0 0 7.5 10a1.7 1.7 0 0 0-.34-1.88l-.06-.06L8.96 6.2l.06.06A1.7 1.7 0 0 0 10.9 6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V4h2.6v.1A1.7 1.7 0 0 0 16 6a1.7 1.7 0 0 0 1.88-.34l.06-.06 1.86 1.86-.06.06A1.7 1.7 0 0 0 19.4 10a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1V14h-.1a1.7 1.7 0 0 0-1.7 1Z" /></svg>
                </button>
                {settingsOpen && <section className="q7-portrait-adjust-panel" onClick={event => event.stopPropagation()}>
                    <header><b>立绘调整</b><button type="button" onClick={() => { onMeetingConfigSave?.(meetingConfig); setSettingsOpen(false); }}>完成</button></header>
                    <label><span>大小 <i>{meetingConfig.scale.toFixed(1)}×</i></span><input type="range" min="0.5" max="2" step="0.1" value={meetingConfig.scale} onChange={event => setMeetingConfig(current => ({ ...current, scale: Number(event.target.value) }))} /></label>
                    <label><span>左右 <i>{meetingConfig.x}%</i></span><input type="range" min="-100" max="100" step="5" value={meetingConfig.x} onChange={event => setMeetingConfig(current => ({ ...current, x: Number(event.target.value) }))} /></label>
                    <label><span>上下 <i>{meetingConfig.y}%</i></span><input type="range" min="-50" max="50" step="5" value={meetingConfig.y} onChange={event => setMeetingConfig(current => ({ ...current, y: Number(event.target.value) }))} /></label>
                    <button type="button" className="q7-portrait-adjust-reset" onClick={() => setMeetingConfig({ scale: 1, x: 0, y: 0 })}>重置为见面模式默认</button>
                </section>}
            </div>}
        </>;
    }
    if (chibiUrl && !chibiFailed) {
        return <div className="q7-portrait is-chibi" data-emotion={cue.emotionIntent}><img src={chibiUrl} alt={char.name} onError={() => setChibiFailed(true)} /></div>;
    }
    return <div className="q7-portrait is-initial" data-emotion={cue.emotionIntent}><span>{char.name.trim().charAt(0).toUpperCase()}</span></div>;
};

export const QixiDemoSession: React.FC<QixiDemoSessionProps> = ({ char, user, apiConfig, onClose, sessionMode = 'fresh', replaySnapshot = null, onReturnToChat, onPortraitConfigSave }) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const flappyRef = useRef<QixiFlappyHandle | null>(null);
    const localGameAtOpen = useMemo(() => loadGame(char.id), [char.id]);
    const savedAtOpen = useRef<QixiGameV8 | null>(sessionMode === 'fresh' && localGameAtOpen?.stage !== 'ending' ? localGameAtOpen : null);
    const replayGameAtOpen = useRef<QixiGameV8 | null>(replaySnapshot?.version === 8 ? replaySnapshot.game : (sessionMode === 'replay' ? localGameAtOpen : null));
    const materialGenerationRef = useRef<Promise<QixiMemoryBundle> | null>(null);
    const bridgeGenerationRef = useRef<Promise<QixiBridgeBundle | null> | null>(null);
    const reunionGenerationRef = useRef<Promise<QixiReunionBundle | null> | null>(null);
    // Generated parts live outside the mutable gameplay state as well. Scene
    // transitions must never be able to erase a result that finished in the
    // background before the player reached that part.
    const bridgeResultRef = useRef<QixiBridgeBundle | null>(replayGameAtOpen.current?.bridge || null);
    const reunionResultRef = useRef<QixiReunionBundle | null>(replayGameAtOpen.current?.reunion || null);
    const finishRef = useRef(false);
    const runIdRef = useRef(createRunId());
    const fallbackBundle = useMemo(() => createQixiFallbackBundle(), []);
    const cachedAtOpen = useMemo(() => replaySnapshot?.version === 8 ? replaySnapshot.bundle : loadQixiMemoryBundle(char.id), [char.id, replaySnapshot]);
    const [game, setGame] = useState<QixiGameV8>(freshGame);
    const [memoryBundle, setMemoryBundle] = useState<QixiMemoryBundle | null>(cachedAtOpen);
    const [memoryStatus, setMemoryStatus] = useState<'idle' | 'loading' | 'memory' | 'fallback'>(cachedAtOpen?.source === 'memory' ? 'memory' : 'idle');
    const [memoryNotice, setMemoryNotice] = useState('');
    const [loadingReady, setLoadingReady] = useState(false);
    const [generationStatus, setGenerationStatus] = useState<Record<GenerationPart, GenerationState>>({ part1: 'idle', part2: 'idle', part3: 'idle' });
    const [generationError, setGenerationError] = useState<{ part: GenerationPart; message: string } | null>(null);
    const [touchedFragment, setTouchedFragment] = useState('');
    const [lostLayerTouchReady, setLostLayerTouchReady] = useState(false);
    const [touch, setTouch] = useState<TouchState>({ x: 50, y: 64, active: false, approaching: false, joined: false, releasedEarly: false, releasedAfterJoin: false });
    const touchingRef = useRef(false);
    const joinedRef = useRef(false);
    const touchElapsedRef = useRef(0);
    const approachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const contactTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const finishToChatRef = useRef<() => Promise<void>>(async () => undefined);
    const bgm = useQixiBGM(game.stage, game.sceneIndex);
    const activeBundle = memoryBundle || fallbackBundle;
    const currentSceneId = QIXI_SCENE_IDS[Math.max(0, Math.min(QIXI_SCENE_IDS.length - 1, game.sceneIndex))];
    const sceneMeta = SCENES[currentSceneId];
    const scenePayload = activeBundle.scenes[currentSceneId];
    const sceneDecisions = game.decisions[currentSceneId] || [];
    const sceneCompleted = game.completedScenes.includes(currentSceneId);
    const portraitPlan = useMemo(() => resolveQixiPortraitPlan(char), [char]);
    const sceneFragments = useMemo(() => {
        const selected = scenePayload.artifactIds
            .map(id => activeBundle.artifacts.find(item => item.id === id))
            .filter((item): item is QixiMemoryArtifact => Boolean(item));
        const fill = activeBundle.artifacts.filter(item => !selected.some(existing => existing.id === item.id));
        const combined = [...selected, ...fill];
        const fallbackFragments = ['没收到', '是不是我说错了', '别等了', '[图片]', '23:57'].map((label, index): QixiMemoryArtifact => ({ id: `leak-${index}`, label, kind: index === 4 ? 'date' : 'phrase', evidenceIds: [] }));
        return [...combined, ...fallbackFragments.filter(item => !combined.some(existing => existing.label === item.label))].slice(0, 6);
    }, [activeBundle.artifacts, scenePayload.artifactIds]);

    const wordArtifacts = useMemo((): QixiMemoryArtifact[] => {
        const selected = scenePayload.artifactIds
            .map(id => activeBundle.artifacts.find(item => item.id === id))
            .filter((item): item is QixiMemoryArtifact => Boolean(item));
        if (selected.length >= 8) return selected;
        return FALLBACK_WORDS.map((label, index) => ({ id: `fallback-word-${index}`, label, kind: index % 3 === 0 ? 'emotion' : 'phrase', evidenceIds: [] }));
    }, [activeBundle.artifacts, scenePayload.artifactIds]);

    const charWordSelections = useMemo(() => {
        const generated = scenePayload.charSelectionIds.filter(id => wordArtifacts.some(item => item.id === id));
        const fallback = wordArtifacts.filter((_, index) => [1, 5, 8, 11].includes(index)).map(item => item.id);
        return unique([...generated, ...fallback]).slice(0, WORD_PICK_COUNT);
    }, [scenePayload.charSelectionIds, wordArtifacts]);
    const visibleCharWordSelections = charWordSelections.slice(0, game.wordCloudCharRevealed);
    const wordTurnWaiting = currentSceneId === 'wordCloud'
        && game.sceneBeat === 'idle'
        && sceneDecisions.length > game.wordCloudCharRevealed;

    const generatePart3 = useCallback(async (bundle: QixiMemoryBundle): Promise<QixiReunionBundle | null> => {
        if (reunionResultRef.current) {
            const reunion = reunionResultRef.current;
            setGame(current => ({ ...current, reunion }));
            setGenerationStatus(current => ({ ...current, part3: 'ready' }));
            return reunion;
        }
        if (reunionGenerationRef.current) return reunionGenerationRef.current;
        setGenerationStatus(current => ({ ...current, part3: 'generating' }));
        setGenerationError(current => current?.part === 'part3' ? null : current);
        const plannedJourney = createPlannedJourney(bundle);
        reunionGenerationRef.current = prepareQixiReunion(char, user, apiConfig, bundle, plannedJourney, portraitPlan)
            .then(reunion => {
                reunionResultRef.current = reunion;
                setGame(current => ({ ...current, reunion }));
                setGenerationStatus(current => ({ ...current, part3: 'ready' }));
                return reunion;
            })
            .catch((error: any) => {
                setGenerationStatus(current => ({ ...current, part3: 'error' }));
                setGenerationError({ part: 'part3', message: error?.message || '最终见面生成失败。' });
                return null;
            })
            .finally(() => { reunionGenerationRef.current = null; });
        return reunionGenerationRef.current;
    }, [apiConfig, char, portraitPlan, user]);

    const generatePart2And3 = useCallback(async (bundle: QixiMemoryBundle): Promise<QixiBridgeBundle | null> => {
        if (bridgeResultRef.current) {
            const bridge = bridgeResultRef.current;
            setGame(current => ({ ...current, bridge }));
            setGenerationStatus(current => ({ ...current, part2: 'ready' }));
            if (!reunionResultRef.current) void generatePart3(bundle);
            return bridge;
        }
        if (bridgeGenerationRef.current) return bridgeGenerationRef.current;
        setGenerationStatus(current => ({ ...current, part2: 'generating', part3: 'idle' }));
        setGenerationError(current => current?.part === 'part2' ? null : current);
        const plannedJourney = createPlannedJourney(bundle);
        bridgeGenerationRef.current = prepareQixiBridge(char, user, apiConfig, bundle, plannedJourney)
            .then(async bridge => {
                bridgeResultRef.current = bridge;
                setGame(current => ({ ...current, bridge, bridgePlaced: [], bridgeFinalState: 'idle' }));
                setGenerationStatus(current => ({ ...current, part2: 'ready' }));
                await generatePart3(bundle);
                return bridge;
            })
            .catch((error: any) => {
                setGenerationStatus(current => ({ ...current, part2: 'error', part3: 'idle' }));
                setGenerationError({ part: 'part2', message: error?.message || '记忆鹊生成失败。' });
                return null;
            })
            .finally(() => { bridgeGenerationRef.current = null; });
        return bridgeGenerationRef.current;
    }, [apiConfig, char, generatePart3, user]);

    const ensureMaterials = useCallback(async (forceRegenerate = false, onRecallComplete?: () => void): Promise<QixiMemoryBundle> => {
        if (materialGenerationRef.current) return materialGenerationRef.current;
        setMemoryStatus('loading');
        setGenerationStatus({ part1: 'generating', part2: 'idle', part3: 'idle' });
        setGenerationError(null);
        setMemoryNotice(`正在整理你和 ${char.name} 的聊天与共同记忆，这一步可能需要稍长时间。`);
        materialGenerationRef.current = prepareQixiMemoryBundle(char, user, apiConfig, { forceRegenerate, strict: true, onRecallComplete })
            .then(prepared => {
                setMemoryBundle(prepared.bundle);
                setMemoryStatus('memory');
                setGenerationStatus(current => ({ ...current, part1: 'ready', part2: 'generating' }));
                setMemoryNotice(`已整理 ${prepared.bundle.evidence.length} 段真实记忆与 ${prepared.bundle.artifacts.length} 件上下文碎片。后续内容正在后台生成。`);
                void generatePart2And3(prepared.bundle);
                return prepared.bundle;
            })
            .catch((error: any) => {
                setMemoryStatus('idle');
                setGenerationStatus(current => ({ ...current, part1: 'error' }));
                setGenerationError({ part: 'part1', message: error?.message || '记忆与开场生成失败。' });
                throw error;
            })
            .finally(() => { materialGenerationRef.current = null; });
        return materialGenerationRef.current;
    }, [apiConfig, char, generatePart2And3, user]);

    const startFresh = useCallback(async () => {
        finishRef.current = false;
        runIdRef.current = createRunId();
        bridgeResultRef.current = null;
        reunionResultRef.current = null;
        setLoadingReady(false);
        setGame({ ...freshGame(), stage: 'cover' });
        try {
            await ensureMaterials(true, () => setGame({ ...freshGame(), stage: 'loading' }));
            setLoadingReady(true);
        } catch {
            setLoadingReady(false);
        }
    }, [ensureMaterials]);

    const startReplay = useCallback(() => {
        finishRef.current = false;
        const source = replayGameAtOpen.current;
        bridgeResultRef.current = source?.bridge || null;
        reunionResultRef.current = source?.reunion || null;
        if (!memoryBundle) setMemoryBundle(replaySnapshot?.bundle || loadQixiMemoryBundle(char.id) || fallbackBundle);
        setGame({ ...freshGame(), stage: 'fakeChat', attitude: source?.attitude });
    }, [char.id, fallbackBundle, memoryBundle, replaySnapshot?.bundle]);

    const continueAfterLoading = useCallback(() => {
        setGame(current => ({ ...current, stage: 'fakeChat' }));
    }, []);

    const resume = useCallback(() => {
        if (!savedAtOpen.current) return;
        const bundle = memoryBundle || loadQixiMemoryBundle(char.id) || fallbackBundle;
        bridgeResultRef.current = savedAtOpen.current.bridge || bridgeResultRef.current;
        reunionResultRef.current = savedAtOpen.current.reunion || reunionResultRef.current;
        if (!memoryBundle) setMemoryBundle(bundle);
        setGame(savedAtOpen.current);
        if (!savedAtOpen.current.bridge || !savedAtOpen.current.reunion) void generatePart2And3(bundle);
    }, [char.id, fallbackBundle, generatePart2And3, memoryBundle]);

    const retryGeneration = useCallback(async () => {
        const part = generationError?.part;
        if (!part) return;
        setGenerationError(null);
        if (part === 'part1') {
            setLoadingReady(false);
            setGame({ ...freshGame(), stage: 'cover' });
            try {
                const bundle = await ensureMaterials(true, () => setGame({ ...freshGame(), stage: 'loading' }));
                setLoadingReady(true);
                return bundle;
            } catch { return null; }
        }
        if (part === 'part2') return generatePart2And3(activeBundle);
        return generatePart3(activeBundle);
    }, [activeBundle, ensureMaterials, game.stage, generatePart2And3, generatePart3, generationError?.part]);

    const enterInterlayer = useCallback((attitude: EntryAttitude) => {
        // Preserve bridge/reunion generated during Flappy and the opening. The
        // previous full-state replacement silently discarded both results.
        setGame(current => ({ ...enterQixiInterlayerState(current, attitude), stage: 'sceneTransition' }));
    }, []);

    const chooseOption = useCallback((optionId: string, result: string) => {
        if (sceneCompleted || game.sceneBeat !== 'idle') return;
        setTouchedFragment('');
        setLostLayerTouchReady(false);
        setGame(current => ({
            ...current,
            sceneBeat: 'user',
            decisions: { ...current.decisions, [currentSceneId]: [optionId] },
            results: { ...current.results, [currentSceneId]: [result] },
        }));
    }, [currentSceneId, game.sceneBeat, sceneCompleted]);

    const touchMemoryFragment = useCallback((artifactId: string) => {
        if (currentSceneId !== 'lostLayer' || game.sceneBeat !== 'user' || !lostLayerTouchReady) return;
        setTouchedFragment(artifactId);
    }, [currentSceneId, game.sceneBeat, lostLayerTouchReady]);

    const toggleWord = useCallback((artifactId: string) => {
        if (sceneCompleted || game.sceneBeat !== 'idle') return;
        setGame(current => {
            const selected = current.decisions.wordCloud || [];
            const next = selectQixiWordTurn(selected, current.wordCloudCharRevealed, artifactId, WORD_PICK_COUNT);
            if (next === selected) return current;
            return {
                ...current,
                decisions: { ...current.decisions, wordCloud: next },
                results: { ...current.results, wordCloud: next.map(id => wordArtifacts.find(item => item.id === id)?.label || id) },
            };
        });
    }, [game.sceneBeat, sceneCompleted, wordArtifacts]);

    useEffect(() => {
        if (game.stage !== 'scene' || currentSceneId !== 'wordCloud' || game.sceneBeat !== 'idle') return;
        if (sceneDecisions.length <= game.wordCloudCharRevealed) return;
        const timer = window.setTimeout(() => setGame(current => {
            const selected = current.decisions.wordCloud || [];
            if (current.stage !== 'scene' || current.sceneBeat !== 'idle' || selected.length <= current.wordCloudCharRevealed) return current;
            const revealed = Math.min(WORD_PICK_COUNT, current.wordCloudCharRevealed + 1);
            return {
                ...current,
                wordCloudCharRevealed: revealed,
                sceneBeat: selected.length >= WORD_PICK_COUNT && revealed >= WORD_PICK_COUNT ? 'char' : 'idle',
            };
        }), 720);
        return () => window.clearTimeout(timer);
    }, [currentSceneId, game.sceneBeat, game.stage, game.wordCloudCharRevealed, sceneDecisions.length]);

    const advanceSceneBeat = useCallback(() => {
        setGame(current => {
            if (current.stage !== 'scene') return current;
            if (current.sceneBeat === 'user') {
                if (currentSceneId === 'lostLayer' && !touchedFragment) return current;
                return { ...current, sceneBeat: 'char' };
            }
            if (current.sceneBeat === 'char') {
                return { ...current, sceneBeat: 'complete', completedScenes: unique([...current.completedScenes, currentSceneId]) };
            }
            return current;
        });
    }, [currentSceneId, touchedFragment]);

    const nextScene = useCallback(() => {
        setGame(current => current.sceneIndex >= QIXI_SCENE_IDS.length - 1
            ? { ...current, stage: 'bridgeLoading' }
            : { ...current, stage: 'sceneTransition', sceneIndex: current.sceneIndex + 1, sceneBeat: 'idle' });
        setTouchedFragment('');
        setLostLayerTouchReady(false);
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

    useEffect(() => {
        if (game.stage !== 'bridgeLoading') return;
        const preparedBridge = game.bridge || bridgeResultRef.current;
        if (preparedBridge) {
            setGame(current => ({ ...current, bridge: preparedBridge, stage: 'bridge', bridgeFinalState: 'idle' }));
            return;
        }
        if (sessionMode !== 'replay') return;
        const replayBridge = normalizeQixiBridgeBundle(replayGameAtOpen.current?.bridge, activeBundle, user.name);
        setGame(current => ({ ...current, bridge: replayBridge, bridgePlaced: [], bridgeFinalState: 'idle', stage: 'bridge' }));
    }, [activeBundle, game.bridge, game.stage, sessionMode, user.name]);

    const placeBridgeNode = useCallback((nodeId: string) => {
        setGame(current => {
            if (current.stage !== 'bridge' || !current.bridge) return current;
            if (!current.bridge.userMagpies.some(item => item.id === nodeId) || current.bridgePlaced.includes(nodeId)) return current;
            return { ...current, bridgePlaced: [...current.bridgePlaced, nodeId] };
        });
        navigator.vibrate?.(14);
    }, []);

    useEffect(() => {
        if (game.stage !== 'bridge' || !game.bridge || game.bridgeFinalState !== 'idle') return;
        if (game.bridgePlaced.length < game.bridge.userMagpies.length) return;
        const timer = window.setTimeout(() => setGame(current => current.stage === 'bridge'
            ? { ...current, bridgeFinalState: 'flying' }
            : current), 800);
        return () => window.clearTimeout(timer);
    }, [game.bridge, game.bridgeFinalState, game.bridgePlaced.length, game.stage]);

    useEffect(() => {
        if (game.stage !== 'bridge' || game.bridgeFinalState !== 'flying') return;
        const timer = window.setTimeout(() => setGame(current => current.stage === 'bridge'
            ? { ...current, bridgeFinalState: 'connected' }
            : current), 1450);
        return () => window.clearTimeout(timer);
    }, [game.bridgeFinalState, game.stage]);

    useEffect(() => {
        if (game.stage !== 'bridge' || game.bridgeFinalState !== 'connected') return;
        const timer = window.setTimeout(() => setGame(current => current.stage === 'bridge'
            ? { ...current, stage: 'bridgeCrossing' }
            : current), 1750);
        return () => window.clearTimeout(timer);
    }, [game.bridgeFinalState, game.stage]);

    useEffect(() => {
        if (game.stage !== 'bridgeCrossing') return;
        const timer = window.setTimeout(() => {
            if (sessionMode === 'replay') {
                const reunion = replayGameAtOpen.current?.reunion || createQixiReunionFallback(char, user, portraitPlan);
                setGame(current => ({ ...current, reunion, reunionPage: 0, reunionLineIndex: 0, stage: 'reunion' }));
                return;
            }
            setGame(current => {
                const reunion = current.reunion || reunionResultRef.current || undefined;
                return { ...current, reunion, reunionPage: 0, reunionLineIndex: 0, stage: reunion ? 'reunion' : 'reunionLoading' };
            });
        }, 1700);
        return () => window.clearTimeout(timer);
    }, [char, game.stage, portraitPlan, sessionMode, user]);

    useEffect(() => {
        if (game.stage !== 'reunionLoading') return;
        const reunion = game.reunion || reunionResultRef.current;
        if (!reunion) return;
        setGame(current => ({ ...current, reunion, reunionPage: 0, reunionLineIndex: 0, stage: 'reunion' }));
    }, [game.reunion, game.stage]);

    useEffect(() => {
        if (['cover', 'loading', 'bridgeLoading', 'reunionLoading'].includes(game.stage)) return;
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

    const completeTouch = useCallback(() => {
        joinedRef.current = true;
        touchElapsedRef.current = CONTACT_DURATION_MS;
        if (contactTimerRef.current) clearTimeout(contactTimerRef.current);
        setTouch(current => ({ ...current, active: true, approaching: true, joined: true, releasedEarly: false, releasedAfterJoin: false }));
        navigator.vibrate?.([22, 42, 22]);
    }, []);

    const beginTouch = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        if (joinedRef.current) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        touchingRef.current = true;
        joinedRef.current = false;
        touchElapsedRef.current = 0;
        setTouch({ x: 50, y: 64, active: true, approaching: false, joined: false, releasedEarly: false, releasedAfterJoin: false });
        if (approachTimerRef.current) clearTimeout(approachTimerRef.current);
        if (contactTimerRef.current) clearTimeout(contactTimerRef.current);
        approachTimerRef.current = setTimeout(() => { if (touchingRef.current) setTouch(current => ({ ...current, approaching: true })); }, 260);
        contactTimerRef.current = setTimeout(() => { if (touchingRef.current) completeTouch(); }, CONTACT_DURATION_MS);
    }, [completeTouch]);

    const endTouch = useCallback(() => {
        if (!touchingRef.current) return;
        touchingRef.current = false;
        if (contactTimerRef.current) clearTimeout(contactTimerRef.current);
        if (approachTimerRef.current) clearTimeout(approachTimerRef.current);
        if (joinedRef.current) {
            setTouch(current => ({ ...current, active: false, approaching: false, releasedAfterJoin: true }));
            return;
        }
        setTouch(current => ({ ...current, active: false, approaching: false, releasedEarly: true }));
    }, []);

    useEffect(() => {
        if (game.stage !== 'touch' || !touch.joined || !touch.releasedAfterJoin) return;
        const timer = window.setTimeout(() => setGame(current => current.stage === 'touch' ? { ...current, stage: 'ending' } : current), 1800);
        return () => window.clearTimeout(timer);
    }, [game.stage, touch.joined, touch.releasedAfterJoin]);

    const finishToChat = useCallback(async () => {
        if (finishRef.current) return;
        finishRef.current = true;
        if (sessionMode === 'replay') {
            onClose();
            return;
        }
        const message = game.reunion?.returnMessage || `七夕快乐，${user.name}。`;
        try {
            const reunion = game.reunion;
            const card = createQixiEventChatCard({
                runId: runIdRef.current,
                charName: char.name,
                charAvatar: char.avatar || '',
                userName: user.name,
                timestamp: Date.now(),
                openingChat: activeBundle.openingChat,
                entryAttitude: game.attitude,
                scenes: QIXI_SCENE_IDS.map(sceneId => ({
                    id: sceneId,
                    title: SCENES[sceneId].title,
                    sharedObject: activeBundle.scenes[sceneId].sharedObject,
                    userActions: journey.find(item => item.sceneId === sceneId)?.userChoices || [],
                    userResults: game.results[sceneId] || [],
                    charAction: activeBundle.scenes[sceneId].charAction,
                    memoryLine: activeBundle.scenes[sceneId].memoryLine,
                })),
                bridgeNodes: (game.bridge?.nodes || []).map(node => ({ name: node.name, artifactLabel: node.visualHint, memoryLine: node.memory })),
                reunionLines: reunion?.reunion.lines || [],
                metaReflection: reunion?.metaReflection || [],
                companionshipReflection: reunion?.companionshipReflection || [],
                blessing: reunion?.blessing || [],
                promiseInvitation: reunion?.touch.invitation || [],
                promiseComplete: reunion?.touch.complete || '……约好了。',
            });
            const replaySnapshotValue: QixiReplaySnapshot = {
                version: 8,
                bundle: activeBundle,
                game: { ...game, stage: 'ending' },
            };
            if (onReturnToChat) await onReturnToChat({ message, card, replaySnapshot: replaySnapshotValue });
            else onClose();
        } catch {
            finishRef.current = false;
        }
    }, [activeBundle, char.avatar, char.name, game, journey, onClose, onReturnToChat, sessionMode, user.name]);

    useEffect(() => {
        finishToChatRef.current = finishToChat;
    }, [finishToChat]);

    useEffect(() => {
        if (game.stage !== 'ending') return;
        const timer = window.setTimeout(() => void finishToChatRef.current(), 2800);
        return () => window.clearTimeout(timer);
    }, [game.stage]);

    const visibleActions = useMemo(() => {
        if (game.stage === 'cover') {
            if (sessionMode === 'replay') return ['重看上一次梦境'];
            return memoryStatus === 'loading' ? ['正在辨认共同记忆'] : savedAtOpen.current ? ['进入梦境', '继续上次探索'] : ['进入梦境'];
        }
        if (game.stage === 'loading') return loadingReady ? ['等待落地', '记忆整理完成后继续'] : ['点击或触摸使角色上升'];
        if (game.stage === 'entry') return ['探索附近', '喊 ta 的名字', '留在原地'];
        if (game.stage === 'sceneTransition') return ['继续'];
        if (game.stage === 'scene') {
            if (game.sceneBeat === 'user' && currentSceneId === 'lostLayer' && !lostLayerTouchReady) return ['继续'];
            if (game.sceneBeat === 'user' && currentSceneId === 'lostLayer' && !touchedFragment) return sceneFragments.map(item => item.label);
            if (game.sceneBeat === 'user') return ['继续'];
            if (game.sceneBeat === 'char') return ['继续'];
            if (currentSceneId === 'wordCloud' && !sceneCompleted) return wordTurnWaiting ? ['等待另一边选择'] : wordArtifacts.map(item => item.label);
            if (!sceneCompleted) return scenePayload.options.map(option => option.label);
            return [game.sceneIndex === QIXI_SCENE_IDS.length - 1 ? '让痕迹汇成桥' : '沿星线继续'];
        }
        if (game.stage === 'bridgeLoading') return ['正在把真实记忆整理成桥面'];
        if (game.stage === 'bridge') {
            const remaining = game.bridge?.userMagpies.filter(item => !game.bridgePlaced.includes(item.id)) || [];
            return remaining.length ? remaining.map(item => `想起：${item.name}`) : ['等待最后一只鹊从对岸飞来'];
        }
        if (game.stage === 'bridgeCrossing') return ['沿双方织出的星线走向对岸'];
        if (game.stage === 'reunion') return ['继续'];
        if (game.stage === 'touch') {
            const invitationCount = game.reunion?.touch.invitation.length || 0;
            if (game.reunionLineIndex < invitationCount) return ['继续听约定'];
            return [touch.joined ? '松手，留下约定' : '按住发光圆圈'];
        }
        return [];
    }, [currentSceneId, game.bridge, game.bridgePlaced, game.reunion?.touch.invitation.length, game.reunionLineIndex, game.sceneBeat, game.sceneIndex, game.stage, loadingReady, lostLayerTouchReady, memoryStatus, sceneCompleted, sceneFragments, scenePayload.options, sessionMode, touch.joined, touchedFragment, wordArtifacts, wordTurnWaiting]);

    useEffect(() => {
        const renderState = () => JSON.stringify({
            game: 'qixi-dual-layer-v8',
            sessionMode,
            coordinateSystem: 'full-screen story surface; touch coordinates are percentages from top-left',
            stage: game.stage,
            scene: ['sceneTransition', 'scene'].includes(game.stage) ? { id: currentSceneId, title: sceneMeta.title, index: game.sceneIndex + 1, beat: game.sceneBeat, completed: sceneCompleted } : undefined,
            transitionLines: game.stage === 'sceneTransition' ? qixiTransitionLines(currentSceneId, scenePayload) : undefined,
            material: { status: memoryStatus, evidence: activeBundle.evidence.length, artifacts: activeBundle.artifacts.length, personalizedScenes: activeBundle.personalizedSceneIds },
            flappy: game.stage === 'loading' ? flappyRef.current?.state() : undefined,
            selected: game.stage === 'scene' ? sceneDecisions : undefined,
            lostLayerTouchReady: game.stage === 'scene' && currentSceneId === 'lostLayer' ? lostLayerTouchReady : undefined,
            wordCloudTurns: game.stage === 'scene' && currentSceneId === 'wordCloud' ? { user: sceneDecisions.length, char: game.wordCloudCharRevealed, waiting: wordTurnWaiting } : undefined,
            completedScenes: game.completedScenes,
            generation: generationStatus,
            preparedParts: { part2: Boolean(game.bridge || bridgeResultRef.current), part3: Boolean(game.reunion || reunionResultRef.current) },
            generationError: generationError?.part,
            bridge: game.stage === 'bridge' ? {
                userMagpies: game.bridge?.userMagpies.length || 0,
                userPlaced: game.bridgePlaced.length,
                charMagpies: game.bridge?.charMagpies.length || 0,
                finalState: game.bridgeFinalState,
            } : undefined,
            reunionPage: game.stage === 'reunion' ? { page: game.reunionPage, line: game.reunionLineIndex } : undefined,
            portrait: game.reunion?.portrait.resourceType,
            touch: game.stage === 'touch' ? touch : undefined,
            visibleActions,
        });
        const advanceTime = (ms: number) => {
            if (game.stage === 'loading') {
                flappyRef.current?.advanceTime(ms);
                return;
            }
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
    }, [activeBundle, completeTouch, currentSceneId, game, generationError?.part, generationStatus, lostLayerTouchReady, memoryStatus, sceneCompleted, sceneDecisions, sceneMeta.title, sessionMode, touch, visibleActions, wordTurnWaiting]);

    const renderCover = () => (
        <main className="q7-cover">
            <CelestialBackdrop /><ExitButton onClose={onClose} />
            <div className="q7-cover-frame" aria-hidden="true"><i /><i /><i /><i /></div>
            <section>
                <div className="q7-season"><i>✦</i><span>2026 · 七夕限定梦境</span><i>✦</i></div>
                <div className="q7-moons" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
                <h1><small>星月</small>梦境童话</h1>
                <em>THE TALE BENEATH A MESSAGE</em>
                <blockquote>沿着一条没有送达的消息，<br />捡回从聊天里漏掉的小事。</blockquote>
                <button type="button" data-qixi-action="enter-dream" className="q7-primary" onClick={sessionMode === 'replay' ? startReplay : startFresh} disabled={sessionMode === 'fresh' && memoryStatus === 'loading'}><span>{sessionMode === 'replay' ? '重看这次梦境' : memoryStatus === 'loading' ? '确认两条星线中' : '进入梦境'}</span><small>{sessionMode === 'replay' ? 'REPLAY THE SAME MEMORY' : memoryStatus === 'loading' ? 'TRACING MEMORIES' : 'ENTER REVERIE'}</small></button>
                {sessionMode === 'replay' ? <p className="q7-notice is-memory">沿用上一次的记忆素材、鹊桥与最终约定，不会再次调用模型，也不会重复写入私聊。</p> : memoryNotice && <p className={`q7-notice is-${memoryStatus}`}>{memoryNotice}</p>}
                {sessionMode === 'fresh' && savedAtOpen.current && <button type="button" data-qixi-action="resume" className="q7-resume" onClick={resume}>继续上次掉下去的地方</button>}
            </section>
        </main>
    );

    const renderFakeChat = () => (
        <main className="q7-chat"><ExitButton onClose={onClose} /><header><button>‹</button><i>{char.name.trim().charAt(0)}</i><span><b>{char.name}</b><small>在线</small></span></header><section><time>七夕 · 23:57</time>{activeBundle.openingChat.map((line, index) => <p key={index}><AnimatedText text={line} /></p>)}<em><i /> 输入状态反复消失</em></section><footer><button>＋</button><button type="button" className="q7-glitch-input" data-qixi-action="send-code" onClick={() => setGame(current => ({ ...current, stage: 'distort' }))}><span>点一下异常的输入框</span><i>│</i></button><button>↑</button></footer></main>
    );

    const renderDistort = () => (
        <main className="q7-distort"><ExitButton onClose={onClose} /><div className="q7-tunnel" aria-hidden="true"><i /><i /><i /><i /><span className="rabbit"><i /></span></div><header><small>CHAT / CONTEXT LEAK</small>{char.name}<span>正在输入　正在输入　正＿</span></header>{[...sceneFragments, ...activeBundle.artifacts].slice(0, 6).map((item, index) => <div key={`${item.id}-${index}`} className={`shard s${index + 1}`}>{item.label}</div>)}<button type="button" data-qixi-action="fall" className="q7-door" onClick={() => setGame(current => ({ ...current, stage: 'entry' }))}><small>输入框底下露出了一层不该出现的文字</small><b>空白正在向下裂开。</b><span>碰一下 ↓</span></button></main>
    );

    const renderEntry = () => (
        <main className="q7-story q7-entry"><CelestialBackdrop /><ExitButton onClose={onClose} /><div className="q7-entry-fragments" aria-hidden="true">{sceneFragments.slice(0, 5).map((item, index) => <i key={item.id} style={{ '--fragment-index': index } as React.CSSProperties}>{item.label}</i>)}</div><section><p className="q7-kicker">上下文夹层 · 坐标同时丢失</p><h2>你和那条消息<br />一起掉了下来。</h2><p>聊天界面在头顶合拢。半句话、日期、物件名和一块褪色的 [图片] 痕迹还在继续往下落。</p><aside>没有路标。白兔只是从裂缝里长出来的一小块错觉。</aside><button data-qixi-action="entry-explore" onClick={() => enterInterlayer('explore')}>先碰最近的那句话 <i>→</i></button><button data-qixi-action="entry-shout" onClick={() => enterInterlayer('shout')}>对着裂缝喊 {char.name} <i>→</i></button><button data-qixi-action="entry-stay" onClick={() => enterInterlayer('stay')}>不动，等一秒看看 <i>→</i></button></section></main>
    );

    const renderSceneTransition = () => {
        const lines = qixiTransitionLines(currentSceneId, scenePayload);
        return <main className="q7-scene-transition" style={{ '--user-color': sceneMeta.userColor, '--char-color': sceneMeta.charColor } as React.CSSProperties}>
            <CelestialBackdrop /><ExitButton onClose={onClose} />
            <div className="q7-transition-orbit" aria-hidden="true"><i className="is-user" /><i className="is-char" /><span /></div>
            <section>
                <small>{String(game.sceneIndex + 1).padStart(2, '0')} · BETWEEN CONTEXTS</small>
                <div>{lines.map((line, index) => <p key={`${line}-${index}`}><AnimatedText text={line} /></p>)}</div>
                <button type="button" data-qixi-action="enter-scene" onClick={() => setGame(current => ({ ...current, stage: 'scene' }))}>继续 <i>→</i></button>
            </section>
        </main>;
    };

    const attitudeLine = game.attitude === 'shout'
        ? '你喊出的名字在字缝里反弹。没有回答，只有一小段冷色光比回声晚了一拍。'
        : game.attitude === 'stay'
            ? '你确实等了一会儿。随后，脚下的空白自己向前移动。'
            : '第一步落下时，一件无法送达的东西在远处亮起。';

    const renderScene = () => (
        <main className={`q7-story q7-scene is-${currentSceneId}`} style={{ '--user-color': sceneMeta.userColor, '--char-color': sceneMeta.charColor } as React.CSSProperties}>
            <CelestialBackdrop /><ExitButton onClose={onClose} />
            <div className="q7-route" aria-label="七夕星路">{QIXI_SCENE_IDS.map((id, index) => <i key={id} className={`${index === game.sceneIndex ? 'is-current' : ''} ${game.completedScenes.includes(id) ? 'is-done' : ''}`}><span>{String(index + 1).padStart(2, '0')}</span></i>)}<b className="bridge-dot">∞</b></div>
            <header><p className="q7-kicker">{String(game.sceneIndex + 1).padStart(2, '0')} · {sceneMeta.intention}</p><h2>{sceneMeta.title}</h2><em>{sceneMeta.ritual}</em>{game.sceneIndex === 0 && <small>{attitudeLine}</small>}</header>
            <section className="q7-scene-grid">
                <div className="q7-visual"><SceneObject sceneId={currentSceneId} label={scenePayload.sharedObject} beat={game.sceneBeat} userText={currentSceneId === 'lostLayer' && lostLayerTouchReady ? undefined : (game.results[currentSceneId] || [])[0]} charText={qixiCharVisibleText(currentSceneId, scenePayload)} charMutter={currentSceneId === 'lostLayer' ? qixiCharMutter(scenePayload) : undefined} fragments={sceneFragments} touchedFragment={touchedFragment} showLostFragments={lostLayerTouchReady} onFragmentTouch={touchMemoryFragment} /><p><AnimatedText text={scenePayload.memoryLine} /></p></div>
                <div className="q7-interaction">
                    {!sceneCompleted && game.sceneBeat === 'idle' && currentSceneId !== 'wordCloud' && <><small>碰一个具体东西</small>{scenePayload.options.map(option => <button key={option.id} type="button" data-qixi-action={`choose-${currentSceneId}-${option.id}`} onClick={() => chooseOption(option.id, option.result)}>{option.label}<i>→</i></button>)}</>}
                    {!sceneCompleted && game.sceneBeat === 'idle' && currentSceneId === 'wordCloud' && <><small>你选一个，对面就选一个 · {Math.min(sceneDecisions.length + (wordTurnWaiting ? 0 : 1), WORD_PICK_COUNT)} / {WORD_PICK_COUNT}</small><div className={`q7-words is-turn-taking ${wordTurnWaiting ? 'is-waiting' : ''}`}>{wordArtifacts.map(item => <button key={item.id} type="button" disabled={wordTurnWaiting || sceneDecisions.includes(item.id)} className={`${sceneDecisions.includes(item.id) ? 'is-user' : ''} ${visibleCharWordSelections.includes(item.id) ? 'is-char' : ''}`} data-qixi-action={`word-${item.id}`} onClick={() => toggleWord(item.id)}>{item.label}</button>)}</div><p className={`q7-word-turn-status ${wordTurnWaiting ? 'is-char' : 'is-user'}`}><i />{wordTurnWaiting ? '另一种颜色正在选择……' : game.wordCloudCharRevealed ? '轮到你了。' : '先由你选。'}</p></>}
                    {!sceneCompleted && game.sceneBeat === 'user' && currentSceneId === 'lostLayer' && !lostLayerTouchReady && <div className="q7-beat-prompt is-user"><small>你刚才的操作</small><p>{(game.results[currentSceneId] || [])[0]}</p><button type="button" data-qixi-action="lost-layer-show-fragments" onClick={() => setLostLayerTouchReady(true)}>继续 <i>→</i></button></div>}
                    {!sceneCompleted && game.sceneBeat === 'user' && currentSceneId === 'lostLayer' && lostLayerTouchReady && !touchedFragment && <div className="q7-beat-prompt"><small>刚才的反馈已经退开</small><p>现在，碰一碰漏出来的其中一句。</p></div>}
                    {!sceneCompleted && game.sceneBeat === 'user' && currentSceneId === 'lostLayer' && lostLayerTouchReady && touchedFragment && <div className="q7-beat-prompt is-user"><small>这句停在了你的指尖</small><p>{sceneFragments.find(item => item.id === touchedFragment)?.label}</p><button type="button" data-qixi-action="scene-reveal-char" onClick={advanceSceneBeat}>继续 <i>→</i></button></div>}
                    {!sceneCompleted && game.sceneBeat === 'user' && currentSceneId !== 'lostLayer' && <div className="q7-beat-prompt is-user"><small>你碰过以后</small><p>{(game.results[currentSceneId] || [])[0]}</p><button type="button" data-qixi-action="scene-reveal-char" onClick={advanceSceneBeat}>继续 <i>→</i></button></div>}
                    {!sceneCompleted && game.sceneBeat === 'char' && <div className="q7-beat-prompt is-char"><small>不是你造成的变化</small><p>{scenePayload.charAction}</p>{currentSceneId === 'wordCloud' && <div className="q7-words is-reveal">{wordArtifacts.map((item, index) => <span key={item.id} style={{ '--word-index': index } as React.CSSProperties} className={`${sceneDecisions.includes(item.id) ? 'is-user' : ''} ${visibleCharWordSelections.includes(item.id) ? 'is-char' : ''}`}>{item.label}</span>)}</div>}<button type="button" data-qixi-action="scene-complete-beat" onClick={advanceSceneBeat}>继续 <i>→</i></button></div>}
                    {sceneCompleted && <div className="q7-result">{currentSceneId === 'wordCloud' && <div className="q7-words is-reveal">{wordArtifacts.map((item, index) => <span key={item.id} style={{ '--word-index': index } as React.CSSProperties} className={`${sceneDecisions.includes(item.id) ? 'is-user' : ''} ${visibleCharWordSelections.includes(item.id) ? 'is-char' : ''}`}>{item.label}</span>)}</div>}<button type="button" data-qixi-action="next-scene" className="q7-next" onClick={nextScene}>继续 <i>→</i></button></div>}
                </div>
            </section>
        </main>
    );

    const renderBridgeLoading = () => (
        <main className="q7-reunion-loading"><CelestialBackdrop /><ExitButton onClose={onClose} /><div><i /><span /><i /></div><p>记忆已经抵达星河。<br />正在等两岸的鹊飞来……</p></main>
    );

    const renderBridge = () => {
        const bridge = game.bridge!;
        const allUserPlaced = game.bridgePlaced.length >= bridge.userMagpies.length;
        const visibleCharCount = allUserPlaced
            ? bridge.charMagpies.length
            : Math.min(bridge.charMagpies.length, Math.max(0, game.bridgePlaced.length - 1));
        const latest = [...bridge.userMagpies].reverse().find(item => game.bridgePlaced.includes(item.id));
        return <main className={`q7-magpie-bridge is-${game.bridgeFinalState || 'idle'}`}>
            <CelestialBackdrop /><ExitButton onClose={onClose} />
            <header><small>08 · 星河两岸</small><h2>想起一件事。</h2></header>
            <div className="q7-river" aria-label="双方从两岸召来记忆鹊，细线正在织成道路">
                <div className="q7-bank is-user"><i /><span>{user.name}</span></div>
                <div className="q7-bank is-char"><i /><span>{char.name}</span></div>
                <svg className="q7-woven-lines" viewBox="0 0 1000 520" preserveAspectRatio="none" aria-hidden="true">
                    {bridge.userMagpies.map((magpie, index) => game.bridgePlaced.includes(magpie.id) && <path key={magpie.id} className="is-user" style={{ '--thread-index': index } as React.CSSProperties} d={`M 40 ${440 - index * 24} C 260 ${330 - index * 16}, 410 ${310 + index * 9}, 510 ${260 + index * 3}`} />)}
                    {bridge.charMagpies.slice(0, visibleCharCount).map((magpie, index) => <path key={magpie.id} className="is-char" style={{ '--thread-index': index } as React.CSSProperties} d={`M 960 ${76 + index * 24} C 760 ${145 + index * 18}, 620 ${205 - index * 8}, 490 ${260 - index * 3}`} />)}
                </svg>
                <div className="q7-magpies is-user">{bridge.userMagpies.map((magpie, index) => game.bridgePlaced.includes(magpie.id) && <span key={magpie.id} className="q7-magpie" style={{ '--magpie-index': index } as React.CSSProperties}><i /><b /></span>)}</div>
                <div className="q7-magpies is-char">{bridge.charMagpies.slice(0, visibleCharCount).map((magpie, index) => <span key={magpie.id} className="q7-magpie" style={{ '--magpie-index': index } as React.CSSProperties}><i /><b /></span>)}</div>
                {latest && game.bridgeFinalState === 'idle' && <div key={latest.id} className="q7-memory-unfold"><b>「{latest.name}」</b><span>{latest.memory}</span><i>{latest.visualHint}</i></div>}
                {game.bridgeFinalState !== 'idle' && <div className="q7-final-magpie"><span className="q7-magpie"><i /><b /></span><strong>「{bridge.finalMagpie.name}」</strong><p>{bridge.finalMagpie.line}</p></div>}
                <div className="q7-thread-knot" />
            </div>
            {!allUserPlaced && <section className="q7-memory-choices" aria-label="选择一段真实记忆">
                {bridge.userMagpies.map(magpie => {
                    const placed = game.bridgePlaced.includes(magpie.id);
                    return <button type="button" key={magpie.id} disabled={placed} className={placed ? 'is-placed' : ''} data-qixi-action={`bridge-${magpie.id}`} onClick={() => placeBridgeNode(magpie.id)}><b>「{magpie.name}」</b><span>{magpie.memory}</span></button>;
                })}
            </section>}
        </main>;
    };

    const renderBridgeCrossing = () => (
        <main className="q7-bridge-crossing"><CelestialBackdrop /><div className="q7-crossing-thread is-user" /><div className="q7-crossing-thread is-char" /><div className="q7-crossing-stars">{Array.from({ length: 12 }, (_, index) => <i key={index} style={{ '--star-index': index } as React.CSSProperties} />)}</div></main>
    );

    const renderReunionLoading = () => (
        <main className="q7-reunion-loading"><CelestialBackdrop /><ExitButton onClose={onClose} /><div><i /><span /><i /></div><p>桥的另一端正在成为<br />你熟悉的那个 ta……</p></main>
    );

    const renderReunion = () => {
        const reunion = game.reunion!;
        const pages: Array<{ label: string; lines: string[]; portraitStage: QixiPortraitStage }> = [
            { label: '终于看见', lines: reunion.reunion.lines, portraitStage: 'arrival' },
            ...(reunion.metaReflection.length ? [{ label: '隔层回声', lines: reunion.metaReflection, portraitStage: 'reflection' as QixiPortraitStage }] : []),
            { label: '想起彼此', lines: reunion.companionshipReflection, portraitStage: 'reflection' },
            { label: '七夕祝愿', lines: reunion.blessing, portraitStage: 'blessing' },
        ];
        const page = pages[Math.min(game.reunionPage, pages.length - 1)];
        const lineIndex = Math.min(game.reunionLineIndex, Math.max(0, page.lines.length - 1));
        const line = page.lines[lineIndex] || '……';
        const lastLine = lineIndex >= page.lines.length - 1;
        const lastPage = game.reunionPage >= pages.length - 1;
        const memoryEchoes = activeBundle.evidence.filter(item => line.includes(item.object)).slice(0, 2);
        const advance = () => setGame(current => {
            if (current.reunionLineIndex < page.lines.length - 1) return { ...current, reunionLineIndex: current.reunionLineIndex + 1 };
            if (current.reunionPage < pages.length - 1) return { ...current, reunionPage: current.reunionPage + 1, reunionLineIndex: 0 };
            return { ...current, stage: 'touch', reunionLineIndex: 0 };
        });
        return <main className={`q7-reunion q7-galgame is-${page.portraitStage} ${page.label === '想起彼此' ? 'is-companionship' : ''}`}>
            <CelestialBackdrop /><ExitButton onClose={onClose} />
            <div className="q7-reunion-bridge-echo"><i className="is-user" /><i className="is-char" /><span className="q7-magpie"><i /><b /></span></div>
            {memoryEchoes.length > 0 && <div className="q7-reunion-memory-echo">{memoryEchoes.map(item => <span key={item.id}>「{item.object}」</span>)}</div>}
            <QixiPortrait char={char} reunion={reunion} stage={page.portraitStage} adjustable onMeetingConfigSave={onPortraitConfigSave} />
            <button type="button" className="q7-galgame-dialogue" data-qixi-action={lastPage && lastLine ? 'begin-touch' : 'reunion-next'} onClick={advance}>
                <header><small>{page.label}</small><b>{char.name}</b></header>
                <p key={`${game.reunionPage}-${lineIndex}`}><AnimatedText text={line} /></p>
                <footer><span>{lastPage && lastLine ? '听 ta 说最后一个约定' : '点击继续'}</span><i>⌄</i></footer>
            </button>
        </main>;
    };

    const renderTouch = () => {
        const reunion = game.reunion!;
        const touchLine = touch.joined ? reunion.touch.complete : reunion.touch.hold;
        const invitationIndex = Math.min(game.reunionLineIndex, Math.max(0, reunion.touch.invitation.length - 1));
        const invitationReady = game.reunionLineIndex >= reunion.touch.invitation.length;
        return <main className={`q7-touch ${touch.releasedAfterJoin ? 'is-released' : ''}`}>
            <ExitButton onClose={onClose} />
            <QixiPortrait char={char} reunion={reunion} stage="promise" />
            {!invitationReady && <button type="button" className="q7-promise-dialogue" data-qixi-action="promise-next" onClick={() => setGame(current => ({ ...current, reunionLineIndex: current.reunionLineIndex + 1 }))}>
                <small>{char.name}</small>
                <p key={invitationIndex}><AnimatedText text={reunion.touch.invitation[invitationIndex] || '……'} /></p>
                <span>点击继续　⌄</span>
            </button>}
            <div className={`q7-touch-surface ${invitationReady ? 'is-ready' : 'is-waiting'} ${touch.active ? 'is-active' : ''} ${touch.approaching ? 'is-approaching' : ''} ${touch.joined ? 'is-joined' : ''}`} style={{ '--touch-x': touch.x, '--touch-y': touch.y } as React.CSSProperties}>
                <div className="q7-touch-name">{char.name}</div>
                {touch.active && <blockquote>“{touchLine}”</blockquote>}
                {touch.releasedAfterJoin && <blockquote className="q7-touch-complete">“{reunion.touch.complete}”</blockquote>}
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path className="user-trace" d={`M -4 98 C 18 84, ${Math.max(7, touch.x - 22)} ${Math.min(96, touch.y + 24)}, ${touch.x} ${touch.y}`} /><path className="char-trace" d={`M 104 4 C 85 18, ${Math.min(94, touch.x + 22)} ${Math.max(10, touch.y - 22)}, ${touch.x} ${touch.y}`} /></svg>
                {invitationReady && <button
                    type="button"
                    className="q7-touch-orb"
                    data-qixi-action="hold-glowing-orb"
                    aria-label="按住发光圆圈完成约定"
                    onPointerDown={beginTouch}
                    onPointerUp={endTouch}
                    onPointerCancel={endTouch}
                    onContextMenu={event => event.preventDefault()}
                ><i className="q7-touch-orb-ring is-user" /><i className="q7-touch-orb-ring is-char" /><b className="q7-touch-orb-core">✦</b><span><strong>快来碰碰这里</strong><small>{touch.releasedEarly && !touch.active ? '再按久一点' : touch.joined ? '可以松开了' : '轻轻按住'}</small></span></button>}
            </div>
        </main>;
    };

    const renderEnding = () => (
        <main className="q7-returning"><CelestialBackdrop /><div className="q7-returning-knot"><i /><b /></div><section><small>THE MOMENT REMAINS</small><p>七夕快乐，{user.name}。</p><span>{char.name}</span></section></main>
    );

    return createPortal(
        <div ref={rootRef} className="qixi-v7-root">
            <QixiBGMToggle muted={bgm.muted} onToggle={bgm.toggleMuted} />
            {generationError && <div className="q7-generation-error" role="alertdialog" aria-modal="true">
                <div className="q7-generation-error__veil" />
                <section>
                    <small>{generationError.part.toUpperCase()} · GENERATION STOPPED</small>
                    <h2>这一段没有生成成功</h2>
                    <p>{generationError.message}</p>
                    <p>系统没有自动重试，也没有用固定文案冒充生成结果。</p>
                    <button type="button" data-qixi-action={`retry-${generationError.part}`} onClick={() => void retryGeneration()}>重新生成这一部分</button>
                    <button type="button" className="is-quiet" onClick={onClose}>先退出活动</button>
                </section>
            </div>}
            {game.stage === 'cover' && renderCover()}
            {game.stage === 'loading' && <QixiFlappyLoader ref={flappyRef} char={char} ready={loadingReady} notice={memoryNotice} onClose={onClose} onContinue={continueAfterLoading} />}
            {game.stage === 'fakeChat' && renderFakeChat()}
            {game.stage === 'distort' && renderDistort()}
            {game.stage === 'entry' && renderEntry()}
            {game.stage === 'sceneTransition' && renderSceneTransition()}
            {game.stage === 'scene' && renderScene()}
            {game.stage === 'bridgeLoading' && renderBridgeLoading()}
            {game.stage === 'bridge' && renderBridge()}
            {game.stage === 'bridgeCrossing' && renderBridgeCrossing()}
            {game.stage === 'reunionLoading' && renderReunionLoading()}
            {game.stage === 'reunion' && game.reunion && renderReunion()}
            {game.stage === 'touch' && game.reunion && renderTouch()}
            {game.stage === 'ending' && renderEnding()}
            <style>{`
                @keyframes q7-sky-drift{to{transform:translate3d(1.5%,-1%,0) scale(1.02)}}@keyframes q7-ring{to{transform:rotate(360deg)}}@keyframes q7-hop{50%{transform:translateY(-15px) rotate(8deg)}}@keyframes q7-card{50%{transform:translateY(-9px) rotate(-1deg)}}@keyframes q7-thread{0%{stroke-dashoffset:410}55%,100%{stroke-dashoffset:0}}@keyframes q7-water{0%{opacity:.8;transform:scale(.3)}100%{opacity:0;transform:scale(1.25)}}@keyframes q7-other{from{opacity:0;transform:translateX(15px)}to{opacity:1;transform:none}}@keyframes q7-bridge-line{to{transform:rotate(calc(-8deg + var(--i) * 4deg)) translateX(-5%)}}@keyframes q7-name{50%{opacity:.6;filter:blur(1px)}}@keyframes q7-loading{50%{transform:scaleX(.35);opacity:.45}}@keyframes q7-portrait{from{opacity:0;transform:translateX(-50%) translateY(24px) scale(.98)}to{opacity:1;transform:translateX(-50%)}}@keyframes q7-ending{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
                @media(max-width:760px){.q7-cover>section{padding:72px 12px 50px}.q7-cover h1{font-size:53px}.q7-cover h1 small{font-size:.43em}.q7-cover blockquote{margin:27px 0 24px;font-size:12px}.q7-primary{min-height:70px}.q7-primary span{font-size:15px}.q7-story{padding:102px 20px 55px}.q7-entry h2{font-size:48px}.q7-route{left:18px;right:66px;top:max(22px,env(safe-area-inset-top));gap:5px}.q7-route>i{width:23px;height:23px}.q7-route>i.is-current{width:29px;height:29px}.q7-route>i span{font-size:6px}.q7-scene>header{margin-bottom:28px}.q7-scene>header h2{font-size:42px}.q7-scene-grid{display:block}.q7-object{width:min(270px,72vw)}.q7-visual>p{margin-top:17px}.q7-interaction{margin-top:34px}.q7-interaction>button{font-size:13px}.q7-result>p{font-size:13px}.q7-other-layer{margin-top:23px}.q7-words{gap:8px}.q7-words button,.q7-words span{padding:8px 10px;font-size:10px}.q7-distort header{top:12%;font-size:45px}.q7-door{bottom:10%;width:82vw}.q7-chat section p{font-size:13px}}
                @media(max-height:700px) and (max-width:760px){.q7-cover>section{padding-top:42px}.q7-moons{margin:16px 0}.q7-cover h1{font-size:44px}.q7-cover blockquote{margin:18px 0}.q7-primary{min-height:60px}.q7-object{width:220px}.q7-scene>header{margin-bottom:18px}.q7-scene>header h2{font-size:36px}}
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

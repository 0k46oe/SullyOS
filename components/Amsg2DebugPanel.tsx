import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CornersIn, CornersOut, X } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import {
    buildAmsg2DebugTasks,
    formatCountdown,
    type Amsg2DebugTaskView,
} from '../utils/amsg2DebugView';
import { readRecentInstantTraces } from '../utils/instantTraceLog';
import {
    describeExpirePolicy,
    describeRecurrence,
    describeTaskMode,
} from '../utils/amsg2Tasks';
import {
    isDevDebugAvailable,
    readDevDebugFlags,
    subscribeDevDebugAvailability,
    subscribeDevDebugFlags,
    writeDevDebugFlags,
} from '../utils/devDebug';

// 倒计时只显示到秒，1s 一跳就够——500ms 的话有一半重绘画出来的字是一样的。
const REDRAW_MS = 1_000;
const TRACE_RELOAD_MS = 2_000;
const TRACE_SHOWN = 5;
/** 快到点了：倒计时转绿的阈值。 */
const IMMINENT_MS = 60_000;

// GitHub Dark 的配色，等宽字 + 深底——这面板是当调试终端看的，跟 app 本身的视觉分开。
// 走内联 style 不走 Tailwind：这些是精确色值，项目的调色板里没有对应色阶。
const C = {
    fg: '#e6edf3',
    dim: '#8b949e',
    line: '#21262d',
    border: '#2b3a55',
    bg: 'rgba(10,12,20,.93)',
    green: '#7ee787',
    blue: '#58a6ff',
    orange: '#f0883e',
    red: '#f85149',
    yellow: '#d29922',
} as const;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const hhmmss = (ms: number): string => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });

type TraceEntry = ReturnType<typeof readRecentInstantTraces>[number];

// 送达相关的事件挑出来上色：作废 / 吞没 / 失败是橙的（消息没发出去），收到是绿的。
function traceColor(event: string): string {
    if (/expire|swallow|fail|error|timeout/i.test(event)) return C.orange;
    if (/receiv|deliver|ok|success/i.test(event)) return C.green;
    return C.dim;
}

/** 一条任务的主色：正在发 > 快到点 > 还早；失效的一律沉成灰。 */
function taskColor(view: Amsg2DebugTaskView, nowMs: number): string {
    if (view.state === 'expired' || view.state === 'cancelled') return C.dim;
    if (view.state === 'firing') return C.orange;
    if (view.occurrenceMs != null && view.occurrenceMs - nowMs < IMMINENT_MS) return C.green;
    return C.blue;
}

const TaskRow: React.FC<{ view: Amsg2DebugTaskView; nowMs: number }> = ({ view, nowMs }) => {
    const { task, state, occurrenceMs, cronTickMs } = view;
    const dead = state === 'expired' || state === 'cancelled';
    const color = taskColor(view, nowMs);

    return (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: '5px 0' }}>
            {occurrenceMs == null ? (
                <div style={{ color: C.red }}>触发时间解析不了：{task.firstSendTime}</div>
            ) : dead ? (
                // 只说「已过点」，不说「未发」：这个面板是纯本地派生、不查远端，发没发它并不知道。
                // 断言成「未发」会把排查带偏——实测就有过任务其实早被 worker 消费掉、面板却写着未发。
                // 要分辨发没发，看设置面板里那条任务的进度（它会拿远端底账对账）。
                <div style={{ color: C.dim }}>
                    {view.charName} · {state === 'cancelled' ? '已取消' : '已过点'} · 原定 {hhmmss(occurrenceMs)}
                </div>
            ) : (
                <>
                    <div style={{ fontSize: 17, fontWeight: 700, color }}>
                        {formatCountdown(occurrenceMs - nowMs)}
                        {state === 'firing' && <span style={{ fontSize: 11 }}> 触发窗口内</span>}
                    </div>
                    {/* 「开跑」不是「送达」：cron 到点只负责把任务捞起来开始生成，
                        消息还要等 LLM 出完内容才推出去。 */}
                    <div style={{ color: C.dim }}>
                        {view.charName} · {cronTickMs != null ? hhmmss(cronTickMs) : '—'} 开跑
                        {!view.charEnabled && <span style={{ color: C.red }}> [已关]</span>}
                    </div>
                </>
            )}

            {/* 这条任务到底要干嘛：文案调 amsg2Tasks 的现成函数，跟角色上下文块、
                list_active_messages 工具、设置面板说的是同一套词。 */}
            <div style={{ color: C.dim }}>
                {describeTaskMode(task)}·{describeRecurrence(task.recurrenceType)}·{describeExpirePolicy(task.expirePolicy)}
            </div>

            {task.lastError && <div style={{ color: C.red }}>↳ {task.lastError}</div>}
        </div>
    );
};

const HeaderButton: React.FC<{
    onClick: () => void;
    label: string;
    children: React.ReactNode;
}> = ({ onClick, label, children }) => (
    <button
        type="button"
        aria-label={label}
        onClick={onClick}
        style={{ color: C.dim, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
    >
        {children}
    </button>
);

/**
 * amsg2 任务的实时观察窗。入口在 Dev Debug 面板里，打开后常驻右上角小窗，
 * 点一下铺满全屏看长列表；关掉聊天时它还在，随时能瞄一眼下一次触发还有多久。
 *
 * 任务数据直接取 OSContext 的 characters（面板挂在 Provider 里面），不轮询 IndexedDB——
 * getAllCharacters 会把整库角色连头像、立绘、世界书一起反序列化出来，而这面板正是「等推送
 * 时开着」的，每两秒来一遍就是往送达路径上压连接。trace 是 localStorage 小字符串，照旧轮询。
 *
 * 渲染走 portal 到 body：面板本体是 fixed 定位，留在 shell 的 transform 子树里会变成相对它
 * 定位、位置飘掉（同 apps/Chat.tsx 的剧场浮层）。
 */
const Amsg2DebugPanel: React.FC = () => {
    const { characters } = useOS();
    const [available, setAvailable] = useState(() => isDevDebugAvailable());
    const [enabled, setEnabled] = useState(() => readDevDebugFlags().amsg2Panel);
    const [fullscreen, setFullscreen] = useState(false);
    const [traces, setTraces] = useState<TraceEntry[]>([]);
    const [nowMs, setNowMs] = useState(() => Date.now());

    useEffect(() => subscribeDevDebugAvailability(setAvailable), []);
    useEffect(() => subscribeDevDebugFlags((flags) => setEnabled(flags.amsg2Panel)), []);

    const active = available && enabled;

    useEffect(() => {
        if (!active) return;
        const readTraces = () => setTraces(readRecentInstantTraces(TRACE_SHOWN));
        readTraces();
        const timer = window.setInterval(readTraces, TRACE_RELOAD_MS);
        return () => window.clearInterval(timer);
    }, [active]);

    useEffect(() => {
        if (!active) return;
        const timer = window.setInterval(() => setNowMs(Date.now()), REDRAW_MS);
        return () => window.clearInterval(timer);
    }, [active]);

    // nowMs 每秒变一次，但任务表只在 characters 变了才需要重算——别把 nowMs 塞进依赖里
    // 让整张表每秒重算一遍。状态分界（到点、过宽限）本来就是分钟级的事，晚一拍无所谓。
    const views = useMemo(() => buildAmsg2DebugTasks(characters, Date.now()), [characters]);
    const liveCount = useMemo(
        () => views.filter((v) => v.state === 'pending' || v.state === 'firing').length,
        [views],
    );

    const close = () => {
        setFullscreen(false);
        setEnabled(writeDevDebugFlags({ ...readDevDebugFlags(), amsg2Panel: false }).amsg2Panel);
    };

    if (!active) return null;

    return createPortal(
        <div
            style={{
                position: 'fixed',
                top: 8,
                right: 8,
                ...(fullscreen ? { left: 8, bottom: 8 } : { width: 'min(330px, calc(100vw - 16px))', maxHeight: '78vh' }),
                zIndex: 2147483645,
                display: 'flex',
                flexDirection: 'column',
                background: C.bg,
                color: C.fg,
                font: `12px/1.45 ${MONO}`,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                padding: '10px 12px',
                boxShadow: '0 6px 24px rgba(0,0,0,.45)',
                backdropFilter: 'blur(4px)',
            }}
            role="dialog"
            aria-label="amsg2 调试面板"
        >
            {/* 标题栏固定，内容区自己滚——不然列表一长，切全屏 / 关闭的按钮就滚没了。 */}
            <div style={{ flexShrink: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <b style={{ color: C.green }}>⏱ amsg2 debug</b>
                    <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <HeaderButton
                            onClick={() => setFullscreen((v) => !v)}
                            label={fullscreen ? '缩回小窗' : '铺满全屏'}
                        >
                            {fullscreen ? <CornersIn size={13} weight="bold" /> : <CornersOut size={13} weight="bold" />}
                        </HeaderButton>
                        <HeaderButton onClick={close} label="关闭 amsg2 调试面板">
                            <X size={13} weight="bold" />
                        </HeaderButton>
                    </span>
                </div>
                <div style={{ color: C.dim, marginBottom: 6 }}>
                    now {hhmmss(nowMs)} · cron 每整分 · 待触发 {liveCount}/{views.length}
                </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                {views.length === 0 ? (
                    <div style={{ color: C.dim }}>（无 amsg2 任务）</div>
                ) : (
                    views.map((view) => (
                        <TaskRow key={`${view.charId}:${view.task.taskUuid}`} view={view} nowMs={nowMs} />
                    ))
                )}

                <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 6, paddingTop: 5, color: C.yellow }}>
                    <b>trace</b>
                    <span style={{ color: C.dim, fontSize: 11 }}> 最近 {TRACE_SHOWN} 条 · 无条件记录</span>
                </div>
                {traces.length === 0 ? (
                    <div style={{ color: C.dim, fontSize: 11 }}>（暂无）</div>
                ) : (
                    traces.map((entry, index) => (
                        <div
                            key={`${entry.ts ?? 'no-ts'}-${index}`}
                            style={{ fontSize: 11, color: traceColor(entry.event ?? '') }}
                        >
                            {entry.ts ? hhmmss(new Date(entry.ts).getTime()) : '--:--:--'} {entry.event ?? '?'}
                        </div>
                    ))
                )}
            </div>
        </div>,
        document.body,
    );
};

export default Amsg2DebugPanel;

/**
 * 本机存储用量面板
 *
 * 摆在「备份与恢复」板块顶部，回答两件事：数据多大、系统会不会随手把它清掉。
 *
 * 总量和持久化状态是秒回的，进来就显示；「都是些什么占的」要翻库，所以折叠起来、
 * 点开才算，算的时候显示进度，别让用户对着空白等。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    readStorageOverview,
    requestPersistentStorage,
    computeStorageBreakdown,
    formatBytes,
    type StorageOverview,
    type StorageBreakdown,
    type BreakdownProgress,
} from '../../utils/storageStats';
import { trackEvent } from '../../utils/analytics';

/**
 * 算好的结果放模块级缓存：SettingsSection 收起时会把子树整个卸载，
 * 不缓存的话用户每收一次再展开就得重算一遍。要最新数字点「重新计算」。
 */
let cachedBreakdown: StorageBreakdown | null = null;

/**
 * 分类合计和 estimate() 总量差多少才值得单独交代。
 * 绝对值够大、或者占了总量一成以上都算 —— 只看绝对值的话，几百 KB 的小库永远不显示，
 * 用户会盯着「总共 165 KB，细分只有 9 KB」发懵。
 */
const OTHER_USAGE_MIN_BYTES = 1024 * 1024;
const OTHER_USAGE_MIN_RATIO = 0.1;

type PersistAttempt = 'none' | 'granted' | 'denied';

const StorageUsagePanel: React.FC = () => {
    const [overview, setOverview] = useState<StorageOverview | null>(null);
    const [persisting, setPersisting] = useState(false);
    const [attempt, setAttempt] = useState<PersistAttempt>('none');

    const [expanded, setExpanded] = useState(false);
    const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(cachedBreakdown);
    const [computing, setComputing] = useState(false);
    const [progress, setProgress] = useState<BreakdownProgress | null>(null);
    const [breakdownError, setBreakdownError] = useState(false);

    const aliveRef = useRef(true);
    useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
    }, []);

    const refreshOverview = useCallback(async () => {
        const next = await readStorageOverview();
        if (aliveRef.current) setOverview(next);
    }, []);

    useEffect(() => { void refreshOverview(); }, [refreshOverview]);

    const runBreakdown = useCallback(async () => {
        setComputing(true);
        setBreakdownError(false);
        setProgress(null);
        try {
            const result = await computeStorageBreakdown(p => {
                if (aliveRef.current) setProgress(p);
            });
            cachedBreakdown = result;
            if (aliveRef.current) setBreakdown(result);
        } catch {
            if (aliveRef.current) setBreakdownError(true);
        } finally {
            if (aliveRef.current) { setComputing(false); setProgress(null); }
        }
    }, []);

    const handleToggle = useCallback(() => {
        const next = !expanded;
        setExpanded(next);
        if (next) trackEvent('查看存储占用明细');
        if (next && !cachedBreakdown && !computing) void runBreakdown();
    }, [expanded, computing, runBreakdown]);

    const handlePersist = useCallback(async () => {
        setPersisting(true);
        try {
            const granted = await requestPersistentStorage();
            // 成败都记一笔：要是这个按钮的通过率常年是 0，那它就是个摆设，得换做法。
            trackEvent('申请持久化存储许可', { 结果: granted ? '通过' : '没通过' });
            if (!aliveRef.current) return;
            setAttempt(granted ? 'granted' : 'denied');
            await refreshOverview();
        } finally {
            if (aliveRef.current) setPersisting(false);
        }
    }, [refreshOverview]);

    const usage = overview?.usageBytes ?? null;
    const quota = overview?.quotaBytes ?? null;
    const percent = usage != null && quota != null && quota > 0
        ? Math.min(100, (usage / quota) * 100)
        : null;
    const barColor = percent == null ? 'bg-slate-300'
        : percent >= 90 ? 'bg-gradient-to-r from-rose-400 to-red-500'
        : percent >= 70 ? 'bg-gradient-to-r from-amber-400 to-orange-500'
        : 'bg-gradient-to-r from-violet-400 to-purple-500';

    // estimate() 的总量还包含 Cache Storage（离线缓存的 JS / 图片）这类我们碰不到的东西，
    // 所以分类合计天然会少一截。差得多的时候单独列一行，省得用户以为数字对不上。
    const otherUsage = usage != null && breakdown != null ? usage - breakdown.totalBytes : null;
    const showOtherUsage = otherUsage != null && otherUsage > 0 && (
        otherUsage >= OTHER_USAGE_MIN_BYTES || (usage != null && usage > 0 && otherUsage / usage >= OTHER_USAGE_MIN_RATIO)
    );

    const persisted = overview?.persisted ?? null;

    return (
        <div data-testid="storage-usage-panel" className="mb-5 pb-4 border-b border-slate-100">
            {/* ── 总量 ── */}
            <div className="flex items-baseline justify-between gap-2 mb-1.5">
                <span className="text-xs font-bold text-slate-600">本机数据</span>
                <span className="text-sm font-bold text-slate-700 tabular-nums">
                    {overview == null ? '读取中…' : formatBytes(usage)}
                </span>
            </div>

            {percent != null && (
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden mb-1.5">
                    <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${Math.max(1, percent)}%` }} />
                </div>
            )}

            <p className="text-[10px] text-slate-400 mb-3">
                {overview == null
                    ? '正在读取浏览器给出的用量…'
                    : !overview.supported
                        ? '这个浏览器不提供存储用量信息'
                        : quota != null
                            ? `上限 ${formatBytes(quota)}${percent != null ? ` · 已占 ${percent.toFixed(1)}%` : ''} · 数字由浏览器估算`
                            : '浏览器没给出上限 · 数字由浏览器估算'}
            </p>

            {/* ── 持久化许可 ── */}
            <div className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2.5 mb-3">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                            persisted === true ? 'bg-emerald-500' : persisted === false ? 'bg-amber-500' : 'bg-slate-300'
                        }`} />
                        <span className="text-[11px] font-bold text-slate-600">持久化许可</span>
                        <span className={`text-[11px] font-bold ${
                            persisted === true ? 'text-emerald-600' : persisted === false ? 'text-amber-600' : 'text-slate-400'
                        }`}>
                            {persisted === true ? '已获得' : persisted === false ? '未获得' : '无法查询'}
                        </span>
                    </div>
                    {persisted !== true && overview != null && (
                        <button
                            type="button"
                            onClick={handlePersist}
                            disabled={persisting}
                            className="shrink-0 px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all disabled:opacity-50"
                        >
                            {persisting ? '申请中…' : '再试一次'}
                        </button>
                    )}
                </div>
                <p className="mt-1.5 text-[10px] text-slate-400 leading-relaxed">
                    {persisted === true
                        ? '系统清理存储空间时不会动你的数据。'
                        : attempt === 'denied'
                            ? '浏览器这次没批准。把 SullyOS 装到主屏、或者允许通知之后再点一次，通过的概率会明显变高。'
                            : '存储吃紧时系统可能把你的数据一起清掉。把 SullyOS 装到主屏、或者允许通知，能提高申请成功率。'}
                </p>
            </div>

            {/* ── 细分（折叠） ── */}
            <button
                type="button"
                onClick={handleToggle}
                className="w-full flex items-center gap-1.5 text-[11px] font-bold text-slate-500 py-1 active:scale-[0.99] transition-all"
            >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className={`w-3 h-3 text-slate-300 transition-transform ${expanded ? 'rotate-180' : ''}`}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                </svg>
                <span>看看都是些什么占的</span>
            </button>

            {expanded && (
                <div className="mt-2">
                    {computing ? (
                        <div className="flex items-center gap-2 px-1 py-3">
                            <span className="w-3 h-3 rounded-full border-2 border-slate-200 border-t-violet-400 animate-spin shrink-0" />
                            <span className="text-[10px] text-slate-400">
                                {progress && progress.total > 0
                                    ? `计算中… 已翻完 ${progress.done}/${progress.total} 张表`
                                    : '计算中…'}
                            </span>
                        </div>
                    ) : breakdownError ? (
                        <div className="px-1 py-3">
                            <p className="text-[10px] text-rose-500 mb-2">读不出各项占用（数据库可能正被其他标签页占用）。</p>
                            <button type="button" onClick={() => void runBreakdown()} className="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all">
                                重试
                            </button>
                        </div>
                    ) : breakdown ? (
                        <>
                            <div className="space-y-1.5 mb-2">
                                {breakdown.categories.map(c => (
                                    <div key={c.key} className="flex items-baseline justify-between gap-2">
                                        <span className="text-[11px] text-slate-500 truncate">{c.label}</span>
                                        <span className="text-[11px] text-slate-600 font-medium tabular-nums shrink-0">
                                            {c.estimated ? '约 ' : ''}{formatBytes(c.bytes)}
                                        </span>
                                    </div>
                                ))}
                                {showOtherUsage && (
                                    <div className="flex items-baseline justify-between gap-2">
                                        <span className="text-[11px] text-slate-400 truncate">网页缓存等</span>
                                        <span className="text-[11px] text-slate-400 font-medium tabular-nums shrink-0">约 {formatBytes(otherUsage)}</span>
                                    </div>
                                )}
                                {breakdown.categories.length === 0 && !showOtherUsage && (
                                    <p className="text-[10px] text-slate-400">还没有存下什么数据。</p>
                                )}
                            </div>

                            <div className="flex items-center justify-between gap-2">
                                <p className="text-[10px] text-slate-300 leading-relaxed">
                                    {[
                                        breakdown.categories.some(c => c.estimated) ? '标「约」的项目是抽样估算' : '',
                                        showOtherUsage ? '「网页缓存等」是离线缓存这类系统占用，删不掉也不用管' : '',
                                        breakdown.failedStores.length > 0 ? `有 ${breakdown.failedStores.length} 张表没读出来` : '',
                                    ].filter(Boolean).join('；')}
                                </p>
                                <button type="button" onClick={() => void runBreakdown()} className="shrink-0 px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-[10px] font-bold text-slate-500 active:scale-95 transition-all">
                                    重新计算
                                </button>
                            </div>
                        </>
                    ) : null}
                </div>
            )}
        </div>
    );
};

export default StorageUsagePanel;

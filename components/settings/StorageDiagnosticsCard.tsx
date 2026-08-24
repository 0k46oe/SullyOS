/**
 * 存储优化「测试反馈」卡片（临时功能，小规模测试结束后连同 utils/storageDiagnostics.ts 一起撤掉）
 *
 * 摆在「优化资源存储」正上方，给招募来的测试者用：点一下，自动记录优化前的存储状况、
 * 跑一遍跟下面那个按钮一模一样的「一键优化」、再记录优化后的状况，最后导出成一个 JSON
 * 文件发回来。
 *
 * 三件事上刻意做保守：
 *   · 优化跑的是 utils/storageOptimize.ts 的同一个函数，不在这儿另开一条路——否则测试
 *     环境和正式环境跑的就不是同一段代码，测出来的结论没有意义。
 *   · 报告先落 localStorage 再显示，刷新页面也不丢（合并重复图片之后是要刷新的）。
 *   · 存不下 / 导不出都有兜底：界面上另配一个「复制报告」，iOS 上下载被挡时还能用它。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    runStorageDiagnostics, saveReport, loadSavedReport, downloadReport, reportToJson,
    summarizeReport,
    type DiagnosticsReport, type DiagnosticsProgress,
} from '../../utils/storageDiagnostics';

const PHASE_TEXT: Record<DiagnosticsProgress['phase'], string> = {
    before: '① 正在记录优化前的存储状况',
    optimize: '② 正在优化',
    after: '③ 正在记录优化后的存储状况',
    done: '完成',
};

/** 报告存住了没有：存不住就得提醒用户「先导出再刷新」。 */
type SaveState = { saved: boolean; degraded: boolean; reason?: string } | null;

const StorageDiagnosticsCard: React.FC = () => {
    const [running, setRunning] = useState(false);
    const [progress, setProgress] = useState<DiagnosticsProgress | null>(null);
    const [report, setReport] = useState<DiagnosticsReport | null>(null);
    const [saveState, setSaveState] = useState<SaveState>(null);
    const [fatalError, setFatalError] = useState<string | null>(null);
    const [copyHint, setCopyHint] = useState<string | null>(null);
    /** 从 localStorage 读回来的上一轮报告（刷新之后还能导出） */
    const [restored, setRestored] = useState(false);

    const aliveRef = useRef(true);
    useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
    }, []);

    useEffect(() => {
        const saved = loadSavedReport();
        if (saved) { setReport(saved); setRestored(true); }
    }, []);

    const handleRun = useCallback(async () => {
        if (running) return;
        setRunning(true);
        setRestored(false);
        setReport(null);
        setSaveState(null);
        setFatalError(null);
        setCopyHint(null);
        setProgress(null);
        try {
            const result = await runStorageDiagnostics(p => {
                if (aliveRef.current) setProgress(p);
            });
            // 先存盘再上屏：合并重复之后页面是要刷新的，存住了才不怕用户手快
            const saved = saveReport(result);
            if (!aliveRef.current) return;
            setReport(result);
            setSaveState(saved);
        } catch (e) {
            // runStorageDiagnostics 内部每步都自己兜着，走到这儿说明是它之外的意外
            if (aliveRef.current) setFatalError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
        } finally {
            if (aliveRef.current) { setRunning(false); setProgress(null); }
        }
    }, [running]);

    const handleCopy = useCallback(async () => {
        if (!report) return;
        try {
            await navigator.clipboard.writeText(reportToJson(report));
            setCopyHint('已复制到剪贴板，直接粘贴发给我们就行。');
        } catch {
            setCopyHint('这个浏览器不让复制，请改用上面的「导出报告文件」。');
        }
    }, [report]);

    const handleDownload = useCallback(() => {
        if (!report) return;
        try {
            downloadReport(report);
            setCopyHint(null);
        } catch (e) {
            setCopyHint(`导出失败（${e instanceof Error ? e.message : String(e)}），试试下面的「复制报告」。`);
        }
    }, [report]);

    const summary = report ? summarizeReport(report) : [];
    const needReload = (report?.optimize.result?.mergedDuplicates ?? 0) > 0;
    const percent = progress && progress.total > 0
        ? Math.min(100, Math.round((progress.done / progress.total) * 100))
        : null;

    return (
        <div data-testid="storage-diagnostics-card" className="rounded-xl border-2 border-violet-200 bg-violet-50/60 px-3 py-3 mb-3">
            <div className="flex items-center gap-1.5 mb-1">
                <span className="px-1.5 py-0.5 rounded-md bg-violet-500 text-[9px] font-bold text-white">测试</span>
                <span className="text-[11px] font-bold text-violet-900">存储优化 · 效果反馈</span>
            </div>

            <p className="text-[10px] text-violet-700/80 leading-relaxed mb-2.5">
                感谢帮忙测试～点下面的按钮，它会先记下你现在的存储状况，接着跑一次「优化资源存储」
                （跟下面那个按钮做的事完全一样），再记一次优化后的状况，最后导出成一个文件发给我们。
                <span className="font-bold">这一轮请用这个按钮，别点下面的「一键优化」</span>，否则就没有「优化前」的数据了。
                报告里只有各类数据的条数和大小，没有你的聊天内容、角色设定和密钥。
            </p>

            <button
                type="button"
                onClick={handleRun}
                disabled={running}
                className="w-full px-3 py-2 rounded-lg bg-violet-500 text-[11px] font-bold text-white active:scale-95 transition-all disabled:opacity-60"
            >
                {running ? '进行中，别关页面…' : restored ? '再跑一次诊断' : '开始诊断并优化'}
            </button>

            {running && (
                <div className="mt-2">
                    <p className="text-[10px] text-violet-700 mb-1">
                        {progress ? `${PHASE_TEXT[progress.phase]}${progress.phase === 'optimize' ? `：${progress.label}` : ''}（${progress.done}/${progress.total}）` : '准备中…'}
                    </p>
                    <div className="h-1.5 rounded-full bg-violet-100 overflow-hidden">
                        <div className="h-full rounded-full bg-violet-400 transition-all" style={{ width: `${percent ?? 5}%` }} />
                    </div>
                    <p className="mt-1 text-[10px] text-violet-500/70">
                        数据多的话要跑上几分钟（记录条数特别多的话可能到十分钟），中途页面会有点卡，属正常。
                    </p>
                </div>
            )}

            {fatalError && (
                <p className="mt-2 text-[10px] text-rose-600 leading-relaxed">
                    诊断整个中断了：{fatalError}。把这句话截图发给我们就行。
                </p>
            )}

            {report && !running && (
                <div className="mt-2.5">
                    <p className="text-[10px] font-bold text-violet-900 mb-1">
                        {restored ? '上次的诊断结果' : '诊断完成'}
                        <span className="font-normal text-violet-500/70">
                            {' · '}{new Date(report.finishedAt).toLocaleString()}
                            {!restored && ` · 用时 ${report.totalMs < 1000 ? '不到 1' : Math.round(report.totalMs / 1000)} 秒`}
                        </span>
                    </p>

                    <ul className="space-y-0.5 mb-2">
                        {summary.map((line, i) => (
                            <li key={i} className="text-[10px] text-violet-800/90 leading-relaxed">· {line}</li>
                        ))}
                    </ul>

                    <div className="flex gap-1.5">
                        <button
                            type="button"
                            onClick={handleDownload}
                            className="flex-1 px-2.5 py-2 rounded-lg bg-violet-500 text-[11px] font-bold text-white active:scale-95 transition-all"
                        >
                            导出报告文件
                        </button>
                        <button
                            type="button"
                            onClick={() => void handleCopy()}
                            className="shrink-0 px-2.5 py-2 rounded-lg bg-white border border-violet-200 text-[10px] font-bold text-violet-600 active:scale-95 transition-all"
                        >
                            复制报告
                        </button>
                    </div>

                    {copyHint && <p className="mt-1.5 text-[10px] text-violet-600">{copyHint}</p>}

                    {saveState && !saveState.saved && (
                        <p className="mt-1.5 text-[10px] text-amber-600 leading-relaxed">
                            报告没能存进本机（{saveState.reason || '空间不够'}），刷新页面就没了——请先导出再做别的。
                        </p>
                    )}
                    {saveState?.saved && saveState.degraded && (
                        <p className="mt-1.5 text-[10px] text-amber-600 leading-relaxed">
                            本机空间不太够，存下来的是精简版；<span className="font-bold">现在导出的这份是完整的</span>，刷新之后再导就只剩精简版了。
                        </p>
                    )}
                    {needReload && (
                        <p className="mt-1.5 text-[10px] text-violet-700 leading-relaxed">
                            这次合并了重复图片，导出完请
                            <button type="button" onClick={() => window.location.reload()} className="mx-1 underline font-bold">刷新一下页面</button>
                            ，让界面用上合并后的图。
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};

export default StorageDiagnosticsCard;

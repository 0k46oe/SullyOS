import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    ArrowCounterClockwise,
    Check,
    Copy,
    DownloadSimple,
    GearSix,
    UploadSimple,
    X,
} from '@phosphor-icons/react';
import { useOS } from '../../context/OSContext';
import type { JournalAppearance } from '../../types';
import {
    JOURNAL_APPEARANCE_PRESETS,
    JOURNAL_CSS_SCOPE_HINT,
    JOURNAL_CSS_SCOPE_REGEX,
    flattenJournalAppearance,
    resolveJournalAppearanceCss,
} from '../../utils/journalAppearance';
import { runCssRenderabilityCheck, validateScopedCss } from '../../utils/scopedCss';
import { shareOrDownloadFile } from '../../utils/shareExport';

const AI_PROMPT = `你是 CSS 设计师，请为 SullyOS 的「交换日记」App 写一段自定义 CSS。
所有选择器必须以 .sully-journal-root 或 .sully-journal-* 开头；覆盖原界面样式时可使用 !important。不要输出 JavaScript。

常用钩子：
- .sully-journal-root：整个 App
- .sully-journal-header / .sully-journal-header-title：选择页顶部
- .sully-journal-notebook / -avatar / -name：角色日记本
- .sully-journal-calendar-hero / -list：日记列表页
- .sully-journal-new-entry：新建日记按钮
- .sully-journal-entry / -date / -text / -badges：日记条目
- .sully-journal-editor-header / -stage：书写界面
- .sully-journal-paper / -page-content / -page-meta / -textarea：纸张与正文
- .sully-journal-sticker / -texture：贴纸与纸张纹理
- .sully-journal-bottom-controls / -tabs / -tab：底部工具区
- .sully-journal-paper-picker / -paper-swatch / -sticker-button / -sticker-panel：纸张和贴纸工具

请直接输出完整 CSS。我想要的风格是：______`;

const CSS_SNIPPETS = [
    {
        name: '纸张直角',
        code: `.sully-journal-paper{
  border-radius:4px!important;
  box-shadow:0 18px 48px rgba(20,14,10,.28)!important;
}`,
    },
    {
        name: '更像手写',
        code: `.sully-journal-textarea{
  font-family:"Kaiti SC","STKaiti",serif!important;
  font-size:17px!important;
  line-height:2!important;
  letter-spacing:.04em!important;
}`,
    },
    {
        name: '隐藏纸纹',
        code: `.sully-journal-texture{display:none!important;}`,
    },
];

const normalizeAppearance = (appearance?: JournalAppearance): JournalAppearance => ({
    preset: appearance?.preset || 'original',
    customCss: appearance?.customCss || '',
});

export const JournalAppearanceStyle: React.FC<{ appearance?: JournalAppearance }> = ({ appearance }) => {
    const validation = useMemo(
        () => validateScopedCss(
            appearance?.customCss || '',
            JOURNAL_CSS_SCOPE_REGEX,
            JOURNAL_CSS_SCOPE_HINT,
        ),
        [appearance?.customCss],
    );
    const css = resolveJournalAppearanceCss({
        ...appearance,
        customCss: validation.isValid ? appearance?.customCss : '',
    });
    return css ? <style>{css}</style> : null;
};

interface JournalAppearanceButtonProps {
    tone?: 'light' | 'dark';
    compact?: boolean;
}

const JournalAppearanceButton: React.FC<JournalAppearanceButtonProps> = ({
    tone = 'light',
    compact = false,
}) => {
    const { theme, updateTheme, addToast } = useOS();
    const [open, setOpen] = useState(false);
    const [copied, setCopied] = useState(false);
    const cssImportRef = useRef<HTMLInputElement>(null);
    const [draft, setDraft] = useState<JournalAppearance>(() =>
        normalizeAppearance(theme.journalAppearance)
    );

    useEffect(() => {
        if (open) setDraft(normalizeAppearance(theme.journalAppearance));
    }, [open, theme.journalAppearance]);

    useEffect(() => {
        if (!open) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = previous; };
    }, [open]);

    const validation = useMemo(
        () => validateScopedCss(
            draft.customCss || '',
            JOURNAL_CSS_SCOPE_REGEX,
            JOURNAL_CSS_SCOPE_HINT,
        ),
        [draft.customCss],
    );

    const save = async () => {
        const renderability = runCssRenderabilityCheck(draft.customCss || '', validation);
        if (!renderability.ok) {
            addToast(renderability.message, 'error');
            return;
        }
        await updateTheme({ journalAppearance: { ...draft } });
        addToast('交换日记样式已保存', 'success');
        setOpen(false);
    };

    const reset = async () => {
        await updateTheme({ journalAppearance: undefined });
        setDraft(normalizeAppearance());
        addToast('已还原交换日记原版样式', 'success');
        setOpen(false);
    };

    const copyPrompt = async () => {
        try {
            await navigator.clipboard.writeText(AI_PROMPT);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
        } catch {
            addToast('复制失败，请手动选择提示词', 'error');
        }
    };

    const appendSnippet = (code: string) => {
        setDraft(current => ({
            ...current,
            customCss: `${current.customCss?.trim() ? `${current.customCss.trim()}\n` : ''}${code}`,
        }));
    };

    const makeStandalone = () => {
        const standalone = flattenJournalAppearance(draft);
        setDraft(standalone);
        addToast('已转为独立 CSS，不再依赖内置主题', 'success');
    };

    const importCss = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const css = (await file.text()).replace(/^\uFEFF/, '').trim();
            if (!css) {
                addToast('CSS 文件是空的', 'error');
                return;
            }
            const importedValidation = validateScopedCss(
                css,
                JOURNAL_CSS_SCOPE_REGEX,
                JOURNAL_CSS_SCOPE_HINT,
            );
            const renderability = runCssRenderabilityCheck(css, importedValidation);
            if (!renderability.ok) {
                addToast(renderability.message, 'error');
                return;
            }
            setDraft({ preset: 'original', customCss: css });
            addToast('CSS 已导入并转为独立样式', 'success');
        } catch {
            addToast('CSS 文件读取失败', 'error');
        } finally {
            event.target.value = '';
        }
    };

    const exportCss = async () => {
        const css = resolveJournalAppearanceCss(draft);
        if (!css.trim()) {
            addToast('当前是原版样式，没有可导出的 CSS', 'info');
            return;
        }
        const date = new Date();
        const dateKey = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
        const fileName = `sullyos-exchange-diary-${dateKey}.css`;
        try {
            const result = await shareOrDownloadFile({
                content: css,
                fileName,
                mimeType: 'text/css;charset=utf-8',
                shareTitle: 'SullyOS 交换日记样式',
            });
            addToast(result === 'shared' ? '已打开 CSS 分享面板' : '完整 CSS 已导出', 'success');
        } catch (error: any) {
            if (error?.name !== 'AbortError') addToast('CSS 导出失败，请重试', 'error');
        }
    };

    const panel = open ? createPortal(
        <div
            className="fixed inset-0 z-[1950] flex items-end justify-center bg-black/45 backdrop-blur-sm"
            onMouseDown={event => {
                if (event.target === event.currentTarget) setOpen(false);
            }}
        >
            <div
                className="w-full max-w-[640px] max-h-[90vh] overflow-y-auto rounded-t-[30px] bg-[#fbfaf8] text-slate-800 shadow-2xl"
                style={{ paddingBottom: 'max(22px, env(safe-area-inset-bottom))' }}
                onMouseDown={event => event.stopPropagation()}
            >
                <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-stone-200/80 bg-[#fbfaf8]/95 px-5 py-4 backdrop-blur">
                    <div>
                        <div className="text-[10px] font-bold uppercase tracking-[.22em] text-amber-600/70">Exchange diary skin</div>
                        <h2 className="mt-0.5 text-base font-black">交换日记美化</h2>
                    </div>
                    <button
                        onClick={() => setOpen(false)}
                        className="grid h-9 w-9 place-items-center rounded-full bg-stone-100 text-stone-500 active:scale-90"
                        aria-label="关闭交换日记样式设置"
                    >
                        <X size={17} />
                    </button>
                </div>

                <div className="space-y-7 p-5">
                    <section>
                        <h3 className="text-sm font-bold">默认主题</h3>
                        <p className="mt-1 text-[11px] text-slate-400">点击即可在背后的日记界面即时预览，保存后对所有角色生效。</p>
                        <div className="mt-3 grid grid-cols-2 gap-2.5">
                            {JOURNAL_APPEARANCE_PRESETS.map(preset => {
                                const selected = (draft.preset || 'original') === preset.id;
                                return (
                                    <button
                                        key={preset.id}
                                        onClick={() => setDraft(current => ({ ...current, preset: preset.id }))}
                                        className={`relative min-h-[92px] rounded-2xl border p-3 text-left transition-all active:scale-[.98] ${
                                            selected
                                                ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-400'
                                                : 'border-stone-200 bg-white'
                                        }`}
                                    >
                                        <div className="mb-3 flex gap-1.5">
                                            {preset.colors.map(color => (
                                                <i key={color} className="h-4 w-4 rounded-full border border-black/10" style={{ background: color }} />
                                            ))}
                                        </div>
                                        <b className="block text-[12px]">{preset.name}</b>
                                        <span className="mt-1 block text-[10px] text-slate-400">{preset.description}</span>
                                        {selected && <Check size={15} weight="bold" className="absolute right-3 top-3 text-amber-600" />}
                                    </button>
                                );
                            })}
                        </div>
                    </section>

                    <section>
                        <div className="mb-3 flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-sm font-bold">自定义 CSS</h3>
                                <p className="mt-1 text-[11px] text-slate-400">叠加在主题之后，只作用于交换日记，不会影响其它 App。</p>
                            </div>
                            <button
                                onClick={copyPrompt}
                                className="flex shrink-0 items-center gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-700"
                            >
                                {copied ? <Check size={13} /> : <Copy size={13} />}
                                {copied ? '已复制' : '复制 AI 提示词'}
                            </button>
                        </div>

                        <div className="mb-3 grid grid-cols-3 gap-2">
                            <input
                                ref={cssImportRef}
                                type="file"
                                accept=".css,.txt,text/css,text/plain"
                                className="hidden"
                                onChange={importCss}
                            />
                            <button
                                onClick={() => cssImportRef.current?.click()}
                                className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-stone-200 bg-white px-2 text-[10px] font-bold text-slate-600"
                            >
                                <UploadSimple size={14} />
                                导入 CSS
                            </button>
                            <button
                                onClick={exportCss}
                                className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-stone-200 bg-white px-2 text-[10px] font-bold text-slate-600"
                            >
                                <DownloadSimple size={14} />
                                导出完整 CSS
                            </button>
                            <button
                                onClick={makeStandalone}
                                disabled={(draft.preset || 'original') === 'original'}
                                className="min-h-11 rounded-xl border border-stone-200 bg-white px-2 text-[10px] font-bold text-slate-600 disabled:bg-stone-100 disabled:text-stone-400"
                            >
                                {(draft.preset || 'original') === 'original' ? '已独立使用' : '转为独立 CSS'}
                            </button>
                        </div>
                        <p className="mb-3 rounded-xl bg-emerald-50 px-3 py-2 text-[10px] leading-4 text-emerald-700">
                            导出会把内置主题展开成完整 CSS；导入后自动切到“原本琥珀”，只运行文件里的样式。导入仅替换当前预览，点击“保存样式”后才正式生效。
                        </p>

                        <div className="mb-3 flex gap-2 overflow-x-auto no-scrollbar">
                            {CSS_SNIPPETS.map(snippet => (
                                <button
                                    key={snippet.name}
                                    onClick={() => appendSnippet(snippet.code)}
                                    className="shrink-0 rounded-xl border border-stone-200 bg-white px-3 py-2 text-[11px] font-bold text-slate-600"
                                >
                                    + {snippet.name}
                                </button>
                            ))}
                            <button
                                onClick={() => setDraft(current => ({ ...current, customCss: '' }))}
                                className="shrink-0 rounded-xl border border-stone-200 bg-white px-3 py-2 text-[11px] font-bold text-slate-400"
                            >
                                清空 CSS
                            </button>
                        </div>

                        <textarea
                            value={draft.customCss || ''}
                            onChange={event => setDraft(current => ({ ...current, customCss: event.target.value }))}
                            rows={12}
                            spellCheck={false}
                            className="w-full resize-y rounded-2xl border border-stone-200 bg-[#171513] p-4 font-mono text-[11px] leading-5 text-amber-100 outline-none focus:border-amber-500"
                            placeholder={'.sully-journal-paper {\n  border-radius: 8px !important;\n}\n\n.sully-journal-textarea {\n  font-family: serif !important;\n}'}
                        />
                        {!validation.isValid && (
                            <div className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-[11px] leading-5 text-rose-600">
                                {validation.errors[0]}
                            </div>
                        )}

                        <details className="mt-3 text-[11px] text-slate-500">
                            <summary className="cursor-pointer font-bold">查看完整 CSS 钩子</summary>
                            <div className="mt-2 space-y-2 rounded-xl bg-stone-100 px-3 py-3 font-mono text-[10px] leading-5">
                                <p>外层：root、select、calendar、write、header、header-title</p>
                                <p>日记本：notebook-grid、notebook、notebook-avatar、notebook-name</p>
                                <p>列表：calendar-hero、calendar-list、new-entry、entry、entry-accent、entry-date、entry-text、entry-year、entry-badges</p>
                                <p>书写：editor-header、editor-stage、paper、paper-user、paper-char、page-content、page-meta、page-title、page-date、textarea、sticker、texture、empty</p>
                                <p>工具：bottom-controls、tabs、tab、tab-active、paper-picker、paper-swatch、sticker-button、sticker-panel</p>
                                <p className="font-sans text-slate-400">使用时在前面加 <code>.sully-journal-</code>；也可以从 <code>.sully-journal-root</code> 开始组合后代选择器。</p>
                            </div>
                        </details>
                    </section>
                </div>

                <div className="sticky bottom-0 flex gap-2 border-t border-stone-200/80 bg-[#fbfaf8]/95 px-5 pb-1 pt-3 backdrop-blur">
                    <button
                        onClick={reset}
                        className="flex h-12 items-center gap-2 rounded-2xl bg-stone-100 px-4 text-xs font-bold text-stone-500"
                    >
                        <ArrowCounterClockwise size={15} />
                        还原
                    </button>
                    <button
                        onClick={save}
                        disabled={!validation.isValid}
                        className="h-12 flex-1 rounded-2xl bg-stone-900 text-sm font-bold text-white disabled:opacity-40"
                    >
                        保存样式
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    ) : null;

    const previewAppearance = open ? draft : theme.journalAppearance;

    return (
        <>
            <JournalAppearanceStyle appearance={previewAppearance} />
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={`sully-journal-appearance-button grid place-items-center rounded-full border transition-all active:scale-90 ${
                    compact ? 'h-8 w-8' : 'h-9 w-9'
                } ${
                    tone === 'dark'
                        ? 'border-white/10 bg-white/10 text-white/75 hover:bg-white/15'
                        : 'border-amber-900/10 bg-white/45 text-amber-900 hover:bg-white/70'
                }`}
                title="交换日记样式"
                aria-label="打开交换日记样式设置"
            >
                <GearSix size={compact ? 15 : 17} weight="bold" />
            </button>
            {panel}
        </>
    );
};

export default JournalAppearanceButton;

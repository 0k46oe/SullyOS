import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    CaretLeft,
    CaretRight,
    Pause,
    Play,
    Trash,
    Waveform,
    X,
} from '@phosphor-icons/react';
import {
    VOICE_FAVORITES_CHANGED_EVENT,
    getVoiceFavoriteBlob,
    listVoiceFavorites,
    removeVoiceFavoriteById,
    voiceFavoriteSourceLabel,
    type VoiceFavorite,
    type VoiceFavoriteSource,
} from '../../utils/voiceFavorites';

const PAGE_SIZE = 10;
type SourceFilter = 'all' | VoiceFavoriteSource;

interface VoiceFavoritesPortalProps {
    onClose: () => void;
}

const filters: Array<{ value: SourceFilter; label: string }> = [
    { value: 'all', label: '全部' },
    { value: 'chat', label: '聊天' },
    { value: 'call', label: '通话' },
    { value: 'date', label: '见面' },
];

const voiceTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
});
const formatTime = (timestamp: number) => voiceTimeFormatter.format(new Date(timestamp));

const VoiceFavoritesPortal: React.FC<VoiceFavoritesPortalProps> = ({ onClose }) => {
    const [items, setItems] = useState<VoiceFavorite[]>([]);
    const [filter, setFilter] = useState<SourceFilter>('all');
    const [page, setPage] = useState(0);
    const [loading, setLoading] = useState(true);
    const [playingId, setPlayingId] = useState<string | null>(null);
    const [audioError, setAudioError] = useState<string | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const objectUrlRef = useRef<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            setItems(await listVoiceFavorites());
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
        window.addEventListener(VOICE_FAVORITES_CHANGED_EVENT, refresh);
        return () => window.removeEventListener(VOICE_FAVORITES_CHANGED_EVENT, refresh);
    }, [refresh]);

    useEffect(() => () => {
        audioRef.current?.pause();
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    }, []);

    const filtered = useMemo(
        () => filter === 'all' ? items : items.filter(item => item.source === filter),
        [filter, items],
    );
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const visible = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

    useEffect(() => {
        if (page >= pageCount) setPage(Math.max(0, pageCount - 1));
    }, [page, pageCount]);

    const stopPlayback = useCallback(() => {
        audioRef.current?.pause();
        setPlayingId(null);
        if (objectUrlRef.current) {
            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
        }
    }, []);

    const play = async (item: VoiceFavorite) => {
        setAudioError(null);
        if (playingId === item.id) {
            stopPlayback();
            return;
        }
        stopPlayback();
        const blob = await getVoiceFavoriteBlob(item.id);
        if (!blob) {
            setAudioError('这条收藏的音频文件缺失，请回到来源重新收藏。');
            return;
        }
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        const audio = audioRef.current || new Audio();
        audioRef.current = audio;
        audio.src = url;
        audio.onended = stopPlayback;
        audio.onerror = () => {
            stopPlayback();
            setAudioError('音频暂时无法播放。');
        };
        try {
            await audio.play();
            setPlayingId(item.id);
        } catch {
            stopPlayback();
            setAudioError('浏览器阻止了播放，请再点一次。');
        }
    };

    const remove = async (item: VoiceFavorite) => {
        if (playingId === item.id) stopPlayback();
        await removeVoiceFavoriteById(item.id);
        await refresh();
    };

    const portal = (
        <div className="voice-favorites-root">
            <style>{`
                .voice-favorites-root {
                    position: fixed; inset: 0; z-index: 1650; overflow: hidden;
                    color: #172033; background: #f4f1eb;
                    font-family: ui-sans-serif, system-ui, -apple-system, "PingFang SC", sans-serif;
                    animation: voiceArchiveEnter .22s ease-out both;
                }
                .voice-favorites-shell { height: 100%; max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; }
                .voice-favorites-list { scrollbar-width: none; }
                .voice-favorites-list::-webkit-scrollbar { display: none; }
                .voice-favorite-row { animation: voiceRowEnter .18s ease both; }
                @keyframes voiceArchiveEnter { from { opacity: 0; } to { opacity: 1; } }
                @keyframes voiceRowEnter { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
                @media (prefers-reduced-motion: reduce) {
                    .voice-favorites-root, .voice-favorite-row { animation: none !important; }
                }
            `}</style>
            <div className="voice-favorites-shell px-4 sm:px-7">
                <header className="shrink-0 pt-[max(16px,env(safe-area-inset-top))] pb-3 border-b border-slate-900/10">
                    <div className="flex items-center justify-between gap-4 h-12">
                        <button type="button" onClick={onClose} className="w-10 h-10 -ml-1 grid place-items-center rounded-full text-slate-600 active:bg-black/5" aria-label="关闭语音收藏">
                            <X size={21} weight="bold" />
                        </button>
                        <div className="min-w-0 text-center">
                            <h1 className="text-[17px] font-bold tracking-[.08em]">语音收藏</h1>
                            <p className="mt-0.5 text-[10px] text-slate-500">{items.length} 条 · 音频在播放时加载</p>
                        </div>
                        <span className="w-10" aria-hidden />
                    </div>
                    <div className="flex items-center justify-center gap-1.5 mt-2" role="tablist" aria-label="按来源筛选">
                        {filters.map(option => (
                            <button
                                type="button"
                                key={option.value}
                                onClick={() => { setFilter(option.value); setPage(0); }}
                                className={`px-3 py-1.5 rounded-full text-[11px] font-bold transition-colors ${filter === option.value ? 'bg-slate-800 text-white' : 'text-slate-500 active:bg-black/5'}`}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>
                </header>

                <main key={`${filter}-${page}`} className="voice-favorites-list flex-1 min-h-0 overflow-y-auto py-2">
                    {loading ? (
                        <div className="h-full grid place-items-center text-sm text-slate-400">正在整理收藏…</div>
                    ) : visible.length === 0 ? (
                        <div className="h-full min-h-64 grid place-items-center text-center px-8">
                            <div>
                                <Waveform size={34} className="mx-auto text-slate-300" />
                                <p className="mt-4 text-sm font-bold text-slate-500">这里还没有语音</p>
                                <p className="mt-1.5 text-xs leading-5 text-slate-400">在聊天、通话或见面里长按语音，就能收进来。</p>
                            </div>
                        </div>
                    ) : visible.map((item, index) => {
                        const secondary = item.translation || item.spokenText;
                        const showSecondary = !!secondary && secondary.trim() !== item.originalText.trim();
                        const active = playingId === item.id;
                        return (
                            <article key={item.id} className="voice-favorite-row flex gap-3 py-4 border-b border-slate-900/10" style={{ animationDelay: `${Math.min(index, 5) * 18}ms` }}>
                                <button
                                    type="button"
                                    onClick={() => void play(item)}
                                    className={`mt-0.5 shrink-0 w-11 h-11 grid place-items-center rounded-full transition-colors ${active ? 'bg-amber-500 text-white' : 'bg-slate-800 text-white active:bg-slate-700'}`}
                                    aria-label={active ? '暂停' : '播放'}
                                >
                                    {active ? <Pause size={17} weight="fill" /> : <Play size={17} weight="fill" className="ml-0.5" />}
                                </button>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 text-[10px] text-slate-500">
                                        <span className="font-bold text-slate-700">{item.charName}</span>
                                        <span className="px-1.5 py-0.5 rounded bg-slate-900/5">{voiceFavoriteSourceLabel(item.source)}</span>
                                        <time>{formatTime(item.sourceTimestamp)}</time>
                                    </div>
                                    <p className="mt-2 text-[14px] leading-6 text-slate-800 whitespace-pre-wrap break-words">{item.originalText || item.spokenText || '（无文字）'}</p>
                                    {showSecondary && (
                                        <p className="mt-1 text-[12px] leading-5 text-slate-500 whitespace-pre-wrap break-words">
                                            <span className="mr-1.5 text-[10px] font-bold text-amber-700">{item.translation ? '翻译' : '语音'}</span>{secondary}
                                        </p>
                                    )}
                                </div>
                                <button type="button" onClick={() => void remove(item)} className="self-start shrink-0 w-9 h-9 grid place-items-center rounded-full text-slate-400 active:bg-rose-50 active:text-rose-500" aria-label="取消收藏">
                                    <Trash size={16} />
                                </button>
                            </article>
                        );
                    })}
                </main>

                {audioError && <div className="shrink-0 py-2 text-center text-[11px] text-rose-600">{audioError}</div>}
                <footer className="shrink-0 min-h-[62px] pb-[max(12px,env(safe-area-inset-bottom))] pt-2 border-t border-slate-900/10 flex items-center justify-between">
                    <button type="button" disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))} className="w-10 h-10 grid place-items-center rounded-full text-slate-600 disabled:opacity-20 active:bg-black/5" aria-label="上一页"><CaretLeft size={18} weight="bold" /></button>
                    <span className="text-[11px] tabular-nums text-slate-500">第 {page + 1} / {pageCount} 页 · 每页 10 条</span>
                    <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))} className="w-10 h-10 grid place-items-center rounded-full text-slate-600 disabled:opacity-20 active:bg-black/5" aria-label="下一页"><CaretRight size={18} weight="bold" /></button>
                </footer>
            </div>
        </div>
    );

    return createPortal(portal, document.body);
};

export default VoiceFavoritesPortal;

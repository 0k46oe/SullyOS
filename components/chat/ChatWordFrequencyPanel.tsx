import React, { useEffect, useState } from 'react';
import type { CharacterProfile } from '../../types';
import { DB } from '../../utils/db';
import { getChatWordInputs } from '../../utils/chatWordInputs';
import { countChatWords, type WordFrequencyResult } from '../../utils/chatWordFrequency';

export default function ChatWordFrequencyPanel({ character, userName }: {
    character: CharacterProfile; userName: string;
}) {
    const [hideStopWords, setHideStopWords] = useState(true);
    const [includeSingleCharacter, setIncludeSingleCharacter] = useState(false);
    const [refresh, setRefresh] = useState(0);
    const [requested, setRequested] = useState(false);
    const [counting, setCounting] = useState(false);
    const [result, setResult] = useState<WordFrequencyResult | null>(null);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!requested) return;
        let cancelled = false;
        let worker: Worker | undefined;
        setCounting(true);
        setError('');
        setResult(null);
        const fail = (reason: unknown) => {
            if (cancelled) return;
            setError(reason instanceof Error ? reason.message : '本地词频统计失败，请重试');
            setCounting(false);
        };
        void DB.getMessagesByCharId(character.id, true).then(messages => {
            if (cancelled) return;
            const inputs = getChatWordInputs(messages, character.id);
            const options = { hideStopWords, includeSingleCharacter };
            const finish = (next: WordFrequencyResult) => {
                if (!cancelled) { setResult(next); setCounting(false); }
            };
            // A dedicated worker keeps long histories from blocking typing or scrolling.
            try {
                worker = new Worker(new URL('../../utils/chatWordFrequency.worker.ts', import.meta.url), { type: 'module' });
                worker.onmessage = event => {
                    if (event.data.error) fail(new Error(event.data.error));
                    else finish(event.data.result);
                    worker?.terminate();
                };
                worker.onerror = () => { fail(new Error('本地统计线程启动失败，请刷新后重试')); worker?.terminate(); };
                worker.postMessage({ inputs, options });
            } catch {
                worker?.terminate();
                finish(countChatWords(inputs, options));
            }
        }).catch(fail);
        return () => { cancelled = true; worker?.terminate(); };
    }, [character.id, requested, refresh, hideStopWords, includeSingleCharacter]);

    return <div className="space-y-5">
        <div className="space-y-3">
            <p className="text-xs font-bold text-slate-700">聊天高频词 · 本地统计</p>
            <p className="text-[10px] leading-relaxed text-slate-500">分别统计用户与 AI 的正文和语音转写，展示前 30 个词及出现次数。不调用 API，不消耗 Token；附件、卡片、思考与翻译副本不参与。</p>
            <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={hideStopWords} onChange={event => setHideStopWords(event.target.checked)} />过滤常见虚词</label>
            <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={includeSingleCharacter} onChange={event => setIncludeSingleCharacter(event.target.checked)} />包含单字词</label>
            <button type="button" disabled={counting} onClick={() => { setRequested(true); setRefresh(value => value + 1); }}
                className="w-full rounded-xl bg-slate-100 px-3 py-2.5 text-xs font-bold text-slate-600 disabled:opacity-50">
                {counting ? '正在本地统计…' : result ? '刷新高频词' : '统计高频词'}
            </button>
            {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
            {result && <>
                {result.method === 'pairs' && <p className="text-[10px] text-amber-600">此浏览器不支持词语分割，中文按相邻双字统计。</p>}
                <div className="grid grid-cols-2 gap-3">
                    {(['user', 'assistant'] as const).map(role => <div key={role} className="min-w-0 rounded-xl bg-slate-50 p-3">
                        <p className="break-words text-xs font-bold text-slate-700">{role === 'user' ? `用户 · ${userName}` : `AI · ${character.name}`}</p>
                        <p className="mb-2 mt-1 text-[10px] text-slate-400">{result[role].messages} 条正文 · {result[role].total} 次计词</p>
                        {result[role].words.length ? <ol className="space-y-1.5">{result[role].words.map(({ word, count }, index) => <li key={word} className="flex gap-1 text-xs">
                            <span className="w-4 shrink-0 text-slate-400">{index + 1}</span><span className="min-w-0 flex-1 break-words text-slate-700">{word}</span><span className="shrink-0 font-bold text-primary">{count}</span>
                        </li>)}</ol> : <p className="text-[10px] text-slate-400">暂无符合条件的词</p>}
                    </div>)}
                </div>
            </>}
        </div>
    </div>;
}

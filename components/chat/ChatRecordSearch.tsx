import React, { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { DB } from '../../utils/db';
import { buildChatSearchRecords, chatSearchDates, chatSearchSnippet, filterChatSearchRecords, type ChatSearchRecord, type ChatSearchRole } from '../../utils/chatRecordSearch';
import { getLocalDateKey, parseLocalDateKey } from '../../utils/localDate';
import ChatToolDialog from './ChatToolDialog';

const PAGE_SIZE = 40;

export default function ChatRecordSearch({ charId, characterName, userName, onClose, onJump }: {
    charId: string; characterName: string; userName: string; onClose: () => void; onJump: (id: number) => void;
}) {
    const [records, setRecords] = useState<ChatSearchRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [retry, setRetry] = useState(0);
    const [query, setQuery] = useState('');
    const deferredQuery = useDeferredValue(query);
    const [role, setRole] = useState<ChatSearchRole>('all');
    const [date, setDate] = useState('');
    const [calendar, setCalendar] = useState(false);
    const [month, setMonth] = useState(() => getLocalDateKey().slice(0, 7));
    const [page, setPage] = useState(0);
    const resultsRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const abort = new AbortController();
        setLoading(true); setError(''); setRecords([]);
        void DB.getMessagesByCharId(charId, true).then(messages => buildChatSearchRecords(messages, charId, abort.signal)).then(next => {
            if (abort.signal.aborted) return;
            setRecords(next); setLoading(false);
            if (next.length) setMonth(next[0].date.slice(0, 7));
        }).catch(() => { if (!abort.signal.aborted) { setError('聊天记录读取失败，请重试'); setLoading(false); } });
        return () => abort.abort();
    }, [charId, retry]);
    const counts = useMemo(() => chatSearchDates(records), [records]);
    const dates = useMemo(() => [...counts.keys()].sort(), [counts]);
    const hits = useMemo(() => filterChatSearchRecords(records, deferredQuery, role, date), [records, deferredQuery, role, date]);
    const pageCount = Math.max(1, Math.ceil(hits.length / PAGE_SIZE));
    const currentPage = Math.min(page, pageCount - 1);
    const visible = hits.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
    useEffect(() => { setPage(0); resultsRef.current?.scrollTo?.({ top: 0 }); }, [deferredQuery, role, date]);
    const monthDate = parseLocalDateKey(`${month}-01`)!;
    const year = monthDate.getFullYear(), monthIndex = monthDate.getMonth();
    const days = new Date(year, monthIndex + 1, 0).getDate();
    const firstMonth = dates[0]?.slice(0, 7) || month;
    const lastMonth = dates[dates.length - 1]?.slice(0, 7) || month;
    const firstYear = Number(firstMonth.slice(0, 4)), lastYear = Number(lastMonth.slice(0, 4));
    const changeMonth = (offset: number) => setMonth(getLocalDateKey(new Date(year, monthIndex + offset, 1)).slice(0, 7));
    const goPage = (next: number) => { setPage(next); resultsRef.current?.scrollTo?.({ top: 0 }); };

    return <ChatToolDialog title="查找聊天记录" onClose={onClose}>
        <div className="shrink-0 space-y-3 border-b border-slate-100 p-4">
            <div className="flex gap-2">
                <input type="search" aria-label="搜索聊天记录" placeholder="搜索聊天内容" maxLength={200} value={query}
                    onChange={event => { setQuery(event.target.value); setPage(0); }} className="min-w-0 flex-1 rounded-xl bg-slate-100 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-200" />
                <button type="button" aria-expanded={calendar} onClick={() => setCalendar(value => !value)} className={`shrink-0 rounded-xl px-3 text-xs font-bold ${calendar || date ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-100 text-slate-600'}`}>按日期</button>
            </div>
            <div className="flex gap-2" aria-label="筛选发送者">
                {(['all', 'user', 'assistant'] as const).map(value => <button key={value} type="button" aria-pressed={role === value} onClick={() => setRole(value)}
                    className={`min-w-0 flex-1 truncate rounded-lg px-2 py-2 text-xs ${role === value ? 'bg-indigo-50 font-bold text-indigo-600' : 'bg-slate-50 text-slate-500'}`}>{value === 'all' ? '全部' : value === 'user' ? '我' : characterName}</button>)}
            </div>
            {date && <button type="button" aria-label="清除日期筛选" onClick={() => setDate('')} className="rounded-full bg-indigo-50 px-3 py-1 text-xs text-indigo-600">{date} ×</button>}
        </div>
        <div ref={resultsRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {calendar && <section aria-label="聊天日期日历" className="border-b border-slate-100 p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                    <button type="button" aria-label="上个月" disabled={month <= firstMonth} onClick={() => changeMonth(-1)} className="h-9 w-9 rounded-lg bg-slate-50 disabled:opacity-30">‹</button>
                    <div className="flex min-w-0 gap-1 text-sm font-bold">
                        <select aria-label="聊天年份" value={year} onChange={event => setMonth(`${event.target.value}-${String(monthIndex + 1).padStart(2, '0')}`)} className="min-w-0 rounded-lg bg-slate-50 p-2">
                            {Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i).map(value => <option key={value} value={value}>{value} 年</option>)}
                        </select>
                        <select aria-label="聊天月份" value={monthIndex + 1} onChange={event => setMonth(`${year}-${String(event.target.value).padStart(2, '0')}`)} className="rounded-lg bg-slate-50 p-2">
                            {Array.from({ length: 12 }, (_, i) => i + 1).map(value => <option key={value} value={value}>{value} 月</option>)}
                        </select>
                    </div>
                    <button type="button" aria-label="下个月" disabled={month >= lastMonth} onClick={() => changeMonth(1)} className="h-9 w-9 rounded-lg bg-slate-50 disabled:opacity-30">›</button>
                </div>
                <div className="grid grid-cols-7 gap-1 text-center text-xs">
                    {['日', '一', '二', '三', '四', '五', '六'].map(day => <span key={day} className="py-1 text-slate-400">{day}</span>)}
                    {Array.from({ length: monthDate.getDay() }, (_, i) => <span key={`blank-${i}`} />)}
                    {Array.from({ length: days }, (_, i) => {
                        const key = `${month}-${String(i + 1).padStart(2, '0')}`, count = counts.get(key) || 0;
                        return <button key={key} type="button" disabled={!count} aria-label={`${key}，${count ? `${count} 条聊天记录` : '无聊天记录'}`} aria-pressed={date === key}
                            onClick={() => { setDate(key); setCalendar(false); }} className={`flex h-10 flex-col items-center justify-center rounded-lg disabled:text-slate-300 ${date === key ? 'bg-indigo-50 font-bold text-indigo-600' : 'text-slate-700'}`}>
                            {i + 1}<span className={`mt-1 h-1 w-1 rounded-full ${count ? 'bg-indigo-400' : 'bg-transparent'}`} />
                        </button>;
                    })}
                </div>
                <p className="mt-3 text-[10px] text-slate-400">圆点表示当天有聊天，日期按设备时间显示。</p>
            </section>}
            {loading ? <p role="status" className="p-8 text-center text-sm text-slate-400">正在读取本地聊天记录…</p>
                : error ? <div role="alert" className="p-8 text-center text-sm text-red-500">{error}<button type="button" onClick={() => setRetry(value => value + 1)} className="ml-2 underline">重试</button></div>
                : <>
                    <p role="status" className="px-4 py-3 text-xs text-slate-400">{query !== deferredQuery ? '正在查找…' : `共 ${hits.length} 条${date ? ' · 按当天时间顺序' : ' · 最近的在前'}`}</p>
                    {!hits.length && <p className="p-8 text-center text-sm text-slate-400">{records.length ? '没有找到匹配的聊天记录' : '暂无已保存的聊天记录'}</p>}
                    <div aria-label="聊天查找结果">
                        {visible.map(record => {
                            const name = record.role === 'user' ? userName : characterName;
                            const snippet = chatSearchSnippet(record.text, deferredQuery);
                            return <button key={record.id} type="button" aria-label={`查看原消息：${name} ${record.date} ${record.text.slice(0, 60)}`}
                                onClick={() => onJump(record.id)} className="flex w-full gap-3 border-b border-slate-100 px-4 py-4 text-left active:bg-slate-50">
                                <span aria-hidden="true" className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold ${record.role === 'user' ? 'bg-slate-100 text-slate-500' : 'bg-indigo-50 text-indigo-500'}`}>{Array.from(name)[0] || '聊'}</span>
                                <span className="min-w-0 flex-1">
                                    <span className="mb-1 flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-700">{name}</span>
                                        <time dateTime={new Date(record.timestamp).toISOString()} className="shrink-0 text-[10px] text-slate-400">{record.date} {new Date(record.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</time></span>
                                    <span className="block break-words text-xs leading-relaxed text-slate-500">{snippet.before}{snippet.match && <mark className="rounded bg-yellow-100 text-slate-800">{snippet.match}</mark>}{snippet.after}</span>
                                </span>
                            </button>;
                        })}
                    </div>
                    {pageCount > 1 && <nav aria-label="聊天结果分页" className="flex items-center justify-center gap-4 p-4 text-xs text-slate-500">
                        <button type="button" disabled={!currentPage} onClick={() => goPage(currentPage - 1)} className="rounded-lg bg-slate-100 px-3 py-2 disabled:opacity-30">上一页</button>
                        <span>{currentPage + 1} / {pageCount}</span>
                        <button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => goPage(currentPage + 1)} className="rounded-lg bg-slate-100 px-3 py-2 disabled:opacity-30">下一页</button>
                    </nav>}
                </>}
        </div>
    </ChatToolDialog>;
}

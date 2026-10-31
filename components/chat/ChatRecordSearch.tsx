import React, { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DB } from '../../utils/db';
import { buildChatSearchRecords, chatSearchDates, chatSearchSnippet, filterChatSearchRecords, type ChatSearchRecord, type ChatSearchRole } from '../../utils/chatRecordSearch';
import { getLocalDateKey, parseLocalDateKey } from '../../utils/localDate';
import ChatToolDialog from './ChatToolDialog';
import searchCss from './ChatRecordSearch.css?inline';

const PAGE_SIZE = 40;
const COLOR_MODE_KEY = 'sully_chat_record_search_color_mode_v1';

type SearchProps = {
    charId: string; characterName: string; userName: string; onClose: () => void; onJump: (id: number) => void;
};

/** Keep character CSS outside the search page, including generic button/input overrides. */
export default function ChatRecordSearch(props: SearchProps) {
    const host = useRef<HTMLDivElement>(null);
    const [root, setRoot] = useState<ShadowRoot | null>(null);
    useLayoutEffect(() => {
        const element = host.current!;
        setRoot(element.shadowRoot || element.attachShadow({ mode: 'open' }));
    }, []);
    return <div ref={host} className="sully-chat-record-search-host" style={{ position: 'absolute', inset: 0, zIndex: 100, isolation: 'isolate' }}>
        {root && createPortal(<><style>{searchCss}</style><SearchPanel {...props} /></>, root)}
    </div>;
}

function SearchPanel({ charId, characterName, userName, onClose, onJump }: SearchProps) {
    const [colorMode, setColorMode] = useState<'light' | 'dark'>(() => {
        try { return localStorage.getItem(COLOR_MODE_KEY) === 'dark' ? 'dark' : 'light'; }
        catch { return 'light'; }
    });
    const changeColorMode = (mode: 'light' | 'dark') => {
        setColorMode(mode);
        try { localStorage.setItem(COLOR_MODE_KEY, mode); } catch { /* Keep the current session usable without storage. */ }
    };
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

    return <ChatToolDialog title="查找聊天记录" onClose={onClose}
        className={`chat-record-search ${colorMode === 'dark' ? 'search-dark' : ''}`}
        headerActions={<div className="search-mode" role="group" aria-label="查找页面配色">
            {(['light', 'dark'] as const).map(mode => <button key={mode} type="button" aria-pressed={colorMode === mode}
                onClick={() => changeColorMode(mode)}>{mode === 'light' ? '日间' : '夜间'}</button>)}
        </div>}>
        <div className="search-filters">
            <div className="search-row">
                <input type="search" aria-label="搜索聊天记录" placeholder="搜索聊天内容" maxLength={200} value={query}
                    onChange={event => { setQuery(event.target.value); setPage(0); }} className="search-input" />
                <button type="button" aria-expanded={calendar} onClick={() => setCalendar(value => !value)} className={`search-date-toggle ${calendar || date ? 'search-selected' : ''}`}>按日期</button>
            </div>
            <div className="search-row" aria-label="筛选发送者">
                {(['all', 'user', 'assistant'] as const).map(value => <button key={value} type="button" aria-pressed={role === value} onClick={() => setRole(value)}
                    className={`search-role ${role === value ? 'search-selected' : ''}`}>{value === 'all' ? '全部' : value === 'user' ? '我' : characterName}</button>)}
            </div>
            {date && <button type="button" aria-label="清除日期筛选" onClick={() => setDate('')} className="search-date-chip search-selected">{date} ×</button>}
        </div>
        <div ref={resultsRef} className="search-scroll">
            {calendar && <section aria-label="聊天日期日历" className="search-calendar">
                <div className="search-calendar-heading">
                    <button type="button" aria-label="上个月" disabled={month <= firstMonth} onClick={() => changeMonth(-1)} className="search-month-step">‹</button>
                    <div className="search-month-fields">
                        <select aria-label="聊天年份" value={year} onChange={event => setMonth(`${event.target.value}-${String(monthIndex + 1).padStart(2, '0')}`)} className="search-month-select">
                            {Array.from({ length: lastYear - firstYear + 1 }, (_, i) => firstYear + i).map(value => <option key={value} value={value}>{value} 年</option>)}
                        </select>
                        <select aria-label="聊天月份" value={monthIndex + 1} onChange={event => setMonth(`${year}-${String(event.target.value).padStart(2, '0')}`)} className="search-month-select">
                            {Array.from({ length: 12 }, (_, i) => i + 1).map(value => <option key={value} value={value}>{value} 月</option>)}
                        </select>
                    </div>
                    <button type="button" aria-label="下个月" disabled={month >= lastMonth} onClick={() => changeMonth(1)} className="search-month-step">›</button>
                </div>
                <div className="search-calendar-grid">
                    {['日', '一', '二', '三', '四', '五', '六'].map(day => <span key={day} className="search-weekday">{day}</span>)}
                    {Array.from({ length: monthDate.getDay() }, (_, i) => <span key={`blank-${i}`} />)}
                    {Array.from({ length: days }, (_, i) => {
                        const key = `${month}-${String(i + 1).padStart(2, '0')}`, count = counts.get(key) || 0;
                        return <button key={key} type="button" disabled={!count} aria-label={`${key}，${count ? `${count} 条聊天记录` : '无聊天记录'}`} aria-pressed={date === key}
                            onClick={() => { setDate(key); setCalendar(false); }} className={`search-day ${date === key ? 'search-selected' : ''}`}>
                            {i + 1}<span className={`search-day-dot ${count ? '' : 'search-day-dot-empty'}`} />
                        </button>;
                    })}
                </div>
                <p className="search-calendar-note">圆点表示当天有聊天，日期按设备时间显示。</p>
            </section>}
            {loading ? <p role="status" className="search-empty">正在读取本地聊天记录…</p>
                : error ? <div role="alert" className="search-empty search-error">{error}<button type="button" onClick={() => setRetry(value => value + 1)} className="search-retry">重试</button></div>
                : <>
                    <p role="status" className="search-count">{query !== deferredQuery ? '正在查找…' : `共 ${hits.length} 条${date ? ' · 按当天时间顺序' : ' · 最近的在前'}`}</p>
                    {!hits.length && <p className="search-empty">{records.length ? '没有找到匹配的聊天记录' : '暂无已保存的聊天记录'}</p>}
                    <div aria-label="聊天查找结果">
                        {visible.map(record => {
                            const name = record.role === 'user' ? userName : characterName;
                            const snippet = chatSearchSnippet(record.text, deferredQuery);
                            return <button key={record.id} type="button" aria-label={`查看原消息：${name} ${record.date} ${record.text.slice(0, 60)}`}
                                onClick={() => onJump(record.id)} className="search-result">
                                <span aria-hidden="true" className={`search-avatar ${record.role === 'assistant' ? 'search-avatar-ai' : ''}`}>{Array.from(name)[0] || '聊'}</span>
                                <span className="search-result-body">
                                    <span className="search-result-heading"><span className="search-result-name">{name}</span>
                                        <time dateTime={new Date(record.timestamp).toISOString()} className="search-result-time">{record.date} {new Date(record.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</time></span>
                                    <span className="search-snippet">{snippet.before}{snippet.match && <mark className="search-match">{snippet.match}</mark>}{snippet.after}</span>
                                </span>
                            </button>;
                        })}
                    </div>
                    {pageCount > 1 && <nav aria-label="聊天结果分页" className="search-pagination">
                        <button type="button" disabled={!currentPage} onClick={() => goPage(currentPage - 1)} className="search-page-button">上一页</button>
                        <span>{currentPage + 1} / {pageCount}</span>
                        <button type="button" disabled={currentPage + 1 >= pageCount} onClick={() => goPage(currentPage + 1)} className="search-page-button">下一页</button>
                    </nav>}
                </>}
        </div>
    </ChatToolDialog>;
}

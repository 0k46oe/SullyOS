import React, { useState } from 'react';
import { APP_VERSION } from '../../utils/buildInfo';
import { BEAUTY_PLATFORMS, validateBeautyMetadata, validateBeautyPassword, type BeautyKind, type BeautyMetadata, type BeautyShare, type BeautySubmission } from '../../utils/beautyShareContract';
import { beautyRequest, downloadBeauty, normalizeBeautyPackage, readBeautyPackage, readBeautySession, saveBeautySession, type BeautySession } from '../../utils/beautyShareClient';
import { confirmExportSafety } from '../../utils/exportGuard';
import { shareOrDownloadFile } from '../../utils/shareExport';
import BeautyPresetPicker from './BeautyPresetPicker';
import './BeautySharePanel.css';

export interface BeautySource { id: string; name: string; read: () => Promise<unknown> }
interface Props {
  kind: BeautyKind;
  sources: BeautySource[];
  onReceive: (data: any) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  defaultOpen?: boolean;
  initialTab?: 'receive' | 'submit' | 'mine';
  receivedMessage?: string;
}
const DEFAULTS = 'sully-beauty-author-defaults-v1';
function initialMetadata(): BeautyMetadata {
  let saved: Partial<BeautyMetadata> = {};
  try { saved = JSON.parse(localStorage.getItem(DEFAULTS) || '{}'); } catch { /* Fresh form */ }
  return { name: '', credit: typeof saved.credit === 'string' ? saved.credit : '', platforms: Array.isArray(saved.platforms) ? saved.platforms.filter(p => BEAUTY_PLATFORMS.includes(p as any)) : [], contact: saved.contact || '', allowRemix: saved.allowRemix === true, allowRedistribute: saved.allowRedistribute === true, exportVersion: APP_VERSION, bugFeedback: saved.bugFeedback === 'self-fix' ? 'self-fix' : 'welcome', message: saved.message || '' };
}
function Terms({ metadata: m }: { metadata: BeautyMetadata }) {
  return <div className="beauty-share-terms"><strong>{m.name}</strong><p>署名：{m.credit}</p><p>Repo 平台：{m.platforms.join('、')}{m.contact && ` · ${m.contact}`}</p><p>{m.allowRemix ? '允许二改' : '不允许二改'} · {m.allowRedistribute ? '允许二次传播' : '不允许二次传播'}</p><p>导出版本：{m.exportVersion}</p><p>{m.bugFeedback === 'welcome' ? '欢迎反馈 Bug' : 'Bug 请自行修复处理'}</p>{m.message && <p className="beauty-share-message">{m.message}</p>}</div>;
}

export default function BeautySharePanel({ kind, sources, onReceive, onBusyChange, defaultOpen = false, initialTab = 'receive', receivedMessage }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<'receive' | 'submit' | 'mine'>(initialTab);
  const [session, setSession] = useState(readBeautySession);
  const [loginMode, setLoginMode] = useState(false);
  const [authorCode, setAuthorCode] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [mustSave, setMustSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [metadata, setMetadata] = useState(() => ({ ...initialMetadata(), name: sources[0]?.name || '' }));
  const [source, setSource] = useState(sources[0]?.id || 'file');
  const [file, setFile] = useState<File | null>(null);
  const [editing, setEditing] = useState<BeautySubmission | null>(null);
  const [submissions, setSubmissions] = useState<BeautySubmission[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [code, setCode] = useState('');
  const [share, setShare] = useState<BeautyShare | null>(null);
  const [accepted, setAccepted] = useState(false);
  const field = <K extends keyof BeautyMetadata>(key: K, value: BeautyMetadata[K]) => setMetadata(m => ({ ...m, [key]: value }));
  const run = async (work: () => Promise<void>) => {
    setBusy(true); onBusyChange?.(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试'); }
    finally { setBusy(false); onBusyChange?.(false); }
  };
  const refresh = async (auth = session) => {
    if (!auth) return;
    const result = await beautyRequest<{ submissions: BeautySubmission[] }>('/submissions', { token: auth.token });
    setSubmissions(result.submissions); setLoaded(true);
  };
  const authenticate = () => run(async () => {
    validateBeautyPassword(password);
    if (!loginMode && password !== repeat) throw Error('两次输入的密码不一致');
    const next = await beautyRequest<BeautySession>(loginMode ? '/auth/login' : '/auth/register', { method: 'POST', body: loginMode ? { authorCode, password } : { password } });
    saveBeautySession(next); setSession(next); setPassword(''); setRepeat(''); setMustSave(!loginMode);
    await refresh(next);
  });
  const submit = () => run(async () => {
    if (!session || mustSave) throw Error('请先保存作者码和密码');
    const m = validateBeautyMetadata({ ...metadata, exportVersion: APP_VERSION });
    const selected = sources.find(s => s.id === source);
    const raw = source === 'file' ? (file ? await readBeautyPackage(file, kind) : null) : await selected?.read();
    if (!raw) throw Error('请选择要提交的预设或文件');
    const pack = normalizeBeautyPackage(raw, kind);
    if (!(await confirmExportSafety(pack))) return;
    await beautyRequest(editing ? `/submissions/${editing.id}` : '/submissions', { method: 'POST', token: session.token, body: { metadata: m, package: pack, ...(editing ? { expectedRevision: editing.latestRevision } : {}) } });
    localStorage.setItem(DEFAULTS, JSON.stringify({ ...m, name: '' }));
    setEditing(null); setTab('mine'); await refresh(); setNotice('已提交审核。通过后可在这里复制美化码。');
  });

  return <section className="beauty-share-panel">
    <button type="button" className="beauty-share-heading" disabled={busy} aria-expanded={open} onClick={() => setOpen(v => !v)}>美化分享码 <span>{open ? '收起' : '导出 / 领取 / 我的提交'}</span></button>
    {open && <>
      <nav aria-label="美化分享"><button disabled={busy} aria-pressed={tab === 'receive'} onClick={() => setTab('receive')}>用码领取</button><button disabled={busy} aria-pressed={tab === 'submit'} onClick={() => setTab('submit')}>导出分享码</button><button disabled={busy} aria-pressed={tab === 'mine'} onClick={() => { setTab('mine'); void run(() => refresh()); }}>我的提交</button></nav>
      {error && <p role="alert" className="beauty-share-error">{error}</p>}{notice && <p role="status">{notice}</p>}
      <fieldset disabled={busy}>
        {tab === 'submit' && <BeautyPresetPicker kind={kind} sources={sources} source={source} file={file} onFile={setFile} onSource={id => { setSource(id); const s = sources.find(s => s.id === id); if (s && !metadata.name) field('name', s.name); }}/>}
        {tab === 'receive' ? <>
          <label>美化码<input value={code} maxLength={20} placeholder="S-…" autoCapitalize="characters" onChange={e => { setCode(e.target.value); setShare(null); setAccepted(false); }}/></label>
          <button onClick={() => run(async () => {
            const normalized = code.trim().toUpperCase();
            if (!/^S-[A-F0-9]{12}$/.test(normalized)) throw Error('请输入完整的美化码（S- 开头）');
            setShare(null); setAccepted(false);
            const result = await beautyRequest<BeautyShare>(`/shares/${normalized}`);
            if (result.kind !== kind) throw Error(kind === 'appearance' ? '这是聊天装扮，请到聊天装扮中领取' : '这是外观预设，请到外观预设中领取');
            setShare(result);
          })}>查看说明</button>
          {share && <><Terms metadata={share.metadata}/><label className="beauty-share-check"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)}/>我已阅读作者的使用规范</label><button disabled={!accepted} onClick={() => run(async () => { const pack = await downloadBeauty(share, kind); await onReceive(pack); setNotice(receivedMessage || (kind === 'appearance' ? '已存入外观预设，可在预设列表中选择应用。' : '已载入，请在装扮确认区选择需要应用的部分。')); })}>领取并载入预设</button></>}
        </> : <>
          {!session ? <div>
            <p>首次提交建立作者身份，当前浏览器会记住登录。换设备时，用作者码和密码恢复。</p>
            <div className="beauty-share-actions"><button aria-pressed={!loginMode} onClick={() => setLoginMode(false)}>首次使用</button><button aria-pressed={loginMode} onClick={() => setLoginMode(true)}>恢复作者身份</button></div>
            {loginMode && <label>作者码<input value={authorCode} maxLength={20} autoComplete="username" onChange={e => setAuthorCode(e.target.value)}/></label>}
            <label>密码（12–128 字符）<input type="password" value={password} minLength={12} maxLength={128} autoComplete={loginMode ? 'current-password' : 'new-password'} onChange={e => setPassword(e.target.value)}/></label>
            {!loginMode && <label>再次输入密码<input type="password" value={repeat} maxLength={128} autoComplete="new-password" onChange={e => setRepeat(e.target.value)}/></label>}
            <button onClick={authenticate}>{loginMode ? '登录' : '建立作者身份'}</button>
          </div> : <>
            <p>作者码：<strong className="beauty-share-code">{session.authorCode}</strong></p>
            <div className="beauty-share-actions"><button onClick={() => run(async () => { await shareOrDownloadFile({ content: `糯米机美化作者码：${session.authorCode}\n请另行妥善保存您设置的密码。恢复身份需要作者码和密码；本文件不是美化分享码。`, fileName: '糯米机-作者码.txt', mimeType: 'text/plain' }); })}>保存作者码</button><button onClick={() => run(async () => { await beautyRequest('/auth/logout', { method: 'POST', token: session.token }); saveBeautySession(null); setSession(null); setSubmissions([]); setLoaded(false); setMustSave(false); })}>退出登录</button></div>
            {mustSave && <label className="beauty-share-check"><input type="checkbox" checked={false} onChange={() => setMustSave(false)}/>我已妥善保存作者码和密码（清缓存或换设备后需要使用）</label>}
            {tab === 'submit' ? <>
              <h3>{editing ? `更新：${editing.metadata.name}` : '提交美化'}</h3><p>文件最多 20 MB，审核前不公开。更新审核期间，原分享码继续提供已通过的版本。</p>
              {editing && <button onClick={() => { setEditing(null); setMetadata(initialMetadata()); }}>取消更新，改为新投稿</button>}
              <label>美化名<input value={metadata.name} maxLength={80} onChange={e => field('name', e.target.value)}/></label>
              <label>署名<input value={metadata.credit} maxLength={60} onChange={e => field('credit', e.target.value)}/></label>
              <p>发放平台（可多选，方便使用者找到作者 Repo）</p>{BEAUTY_PLATFORMS.map(p => <label className="beauty-share-check" key={p}><input type="checkbox" checked={metadata.platforms.includes(p)} onChange={e => field('platforms', e.target.checked ? [...metadata.platforms, p] : metadata.platforms.filter(v => v !== p))}/>{p}</label>)}
              <label>如何找到你（选填）<input value={metadata.contact} maxLength={160} placeholder="如群昵称或 DC 用户名" onChange={e => field('contact', e.target.value)}/></label>
              <label className="beauty-share-check"><input type="checkbox" checked={metadata.allowRemix} onChange={e => field('allowRemix', e.target.checked)}/>允许二改</label><label className="beauty-share-check"><input type="checkbox" checked={metadata.allowRedistribute} onChange={e => field('allowRedistribute', e.target.checked)}/>允许二次传播</label>
              <p>糯米机版本：{APP_VERSION}（当前导出版本）</p>
              <label>Bug 反馈<select value={metadata.bugFeedback} onChange={e => field('bugFeedback', e.target.value as BeautyMetadata['bugFeedback'])}><option value="welcome">欢迎反馈</option><option value="self-fix">Bug 请自行修复处理</option></select></label>
              <label>作者留言<textarea rows={4} value={metadata.message} maxLength={2000} onChange={e => field('message', e.target.value)}/></label>
              <button disabled={mustSave} onClick={submit}>提交审核</button>
            </> : <>
              <button onClick={() => run(() => refresh())}>刷新状态</button>
              {loaded && !submissions.length && <p>还没有提交。可以从「导出分享码」开始。</p>}
              {submissions.map(item => <article key={item.id}><strong>{item.metadata.name}</strong><p>{item.kind === 'appearance' ? '外观预设' : '聊天装扮'} · {item.status === 'pending' ? '审核中' : item.status === 'approved' ? '审核通过' : '已退回'}</p>{item.reviewNote && <p className="beauty-share-message">审核说明：{item.reviewNote}</p>}{item.shareCode && <><p className="beauty-share-code">{item.shareCode}</p>{item.status !== 'approved' && <p>分享码仍提供上次审核通过的版本。</p>}<button onClick={() => run(async () => { await shareOrDownloadFile({ content: `${item.shareCode}\n在糯米机的${item.kind === 'appearance' ? '外观预设' : '聊天装扮'}中选择「美化分享码 → 用码领取」。`, fileName: '美化分享码.txt', mimeType: 'text/plain' }); })}>分享码保存为文件</button><button onClick={() => run(async () => { await navigator.clipboard.writeText(item.shareCode!); setNotice('美化码已复制'); })}>复制美化码</button></>}
                <div className="beauty-share-actions">{item.shareCode && <button onClick={() => run(async () => { const { openBeautyPoster } = await import('./BeautyPosterDialog'); await openBeautyPoster(item.shareCode!); })}>分享预览图</button>}<button disabled={!!item.pendingRevision || item.kind !== kind} onClick={() => { setEditing(item); setMetadata({ ...item.metadata, exportVersion: APP_VERSION }); setTab('submit'); }}>更新</button><button onClick={() => run(async () => { if (!window.confirm(`删除「${item.metadata.name}」？分享码会立即失效，已被下载的文件无法收回。`)) return; await beautyRequest(`/submissions/${item.id}`, { method: 'DELETE', token: session.token }); if (editing?.id === item.id) setEditing(null); await refresh(); })}>删除</button></div>{item.kind !== kind && <p>请到{item.kind === 'appearance' ? '外观预设' : '聊天装扮'}更新此作品。</p>}
              </article>)}
            </>}
          </>}
        </>}
      </fieldset>
      {busy && <p role="status">处理中，请稍候…</p>}
    </>}
  </section>;
}

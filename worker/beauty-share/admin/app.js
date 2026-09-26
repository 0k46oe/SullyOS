'use strict';
const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('beauty-admin-session') || '';
let setupToken = new URLSearchParams(location.hash.slice(1)).get('setup') || '';
if (setupToken) { history.replaceState(null, '', location.pathname); $('login-title').textContent = '建立管理员账号'; $('login-button').textContent = '建立账号'; $('setup-note').hidden = false; $('password').autocomplete = 'new-password'; }
let offset = 0, pageSize = 12, nextOffset = null, view = 'submissions', query = '';
let repos = []; const selected = new Set();
function notice(message) { $('notice').textContent = message; }
function show() { $('login').hidden = !!token; $('workspace').hidden = !token; }
async function api(path, options = {}) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch('/api/' + path, { ...options, signal: controller.signal, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
    if (!response.ok) { if (response.status === 401) { token = ''; sessionStorage.removeItem('beauty-admin-session'); show(); } const body = await response.json().catch(() => ({})); throw Error(body.error || '操作失败'); }
    return response;
  } catch (error) { if (controller.signal.aborted) throw Error('请求超时，请先刷新确认状态后再重试。'); throw error; }
  finally { clearTimeout(timeout); }
}
function updatePaging() { $('previous').disabled = offset === 0; $('more').disabled = nextOffset === null; }
async function busy(work) {
  for (const control of document.querySelectorAll('button,input,select,textarea')) control.disabled = true;
  notice('正在处理…');
  try { await work(); if ($('notice').textContent === '正在处理…') notice(''); }
  catch (error) { notice(error.message); }
  finally { for (const control of document.querySelectorAll('button,input,select,textarea')) control.disabled = false; updatePaging(); }
}
function element(tag, text, parent) { const node = document.createElement(tag); node.textContent = text; if (parent) parent.append(node); return node; }
function action(label, work, parent, cls = '') { const button = element('button', label, parent); button.className = cls; button.onclick = () => busy(work); return button; }
function confirmAction(parent, message, label, work) {
  parent.querySelector('.confirmation')?.remove();
  const box = element('div', '', parent); box.className = 'confirmation'; box.setAttribute('role', 'group'); box.setAttribute('aria-label', '操作确认');
  element('p', message, box); action(label, work, box, 'primary');
  const cancel = element('button', '取消', box); cancel.onclick = () => box.remove();
  box.scrollIntoView({ block: 'nearest' }); cancel.focus();
}
function downloadBlob(blob, name) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
function badge(text, status, parent) { const node = element('span', text, parent); node.className = 'status ' + status; }
function renderSubmission(item) {
  const article = element('article', '', $('submissions')); const m = item.metadata;
  const head = element('div', '', article); head.className = 'item-heading';
  element('h2', m.name, head); badge(({ pending: '审核中', approved: '已通过', rejected: '已退回' })[item.status], item.status, head);
  element('small', `${item.kind === 'appearance' ? '外观预设' : '聊天装扮'} · ${m.credit} · ${new Date(item.updatedAt).toLocaleString()}`, article);
  const details = element('details', '', article); element('summary', '作品说明与作者规范', details);
  element('p', `作者码：${item.authorCode}\n平台：${m.platforms.join('、')}\n联系说明：${m.contact || '未填写'}\n允许二改：${m.allowRemix ? '是' : '否'} · 允许二次传播：${m.allowRedistribute ? '是' : '否'}\n导出版本：${m.exportVersion}\nBug 反馈：${m.bugFeedback === 'welcome' ? '欢迎' : '请自行修复处理'}\n作者留言：${m.message || '未填写'}`, details);
  if (item.shareCode) { const code = element('p', `分享码：${item.shareCode}${item.pendingRevision ? '（旧版仍可领取）' : ''}`, article); code.className = 'share-code'; }
  if (item.reviewNote) element('p', `上次审核：${item.reviewNote}`, article);
  const actions = element('div', '', article); actions.className = 'actions';
  action('下载检查文件', async () => { const response = await api(`revisions/${item.latestRevision}/file`); downloadBlob(await response.blob(), `beauty-review-${item.id}.json`); }, actions);
  if (item.pendingRevision) {
    const label = element('label', '审核说明', article); const note = document.createElement('textarea'); note.maxLength = 1000; note.placeholder = '退回时请说明需要修改的地方'; label.append(note);
    const reviewActions = element('div', '', article); reviewActions.className = 'actions';
    for (const [decision, text] of [['approved', '通过并开放分享'], ['rejected', '退回修改']]) action(text, async () => {
      const submit = async () => { await api(`admin/revisions/${item.pendingRevision}/review`, { method: 'POST', body: JSON.stringify({ decision, note: note.value }) }); await load(); notice(decision === 'approved' ? '已通过，分享码已开放。可在「已通过」查看。' : '已退回，作者可以查看审核说明。'); };
      if (decision === 'approved') confirmAction(article, `确认已检查「${m.name}」的这份文件，并开放凭码下载？`, '确认通过并开放分享', submit);
      else { if (!note.value.trim()) throw Error('请先填写退回原因。'); await submit(); }
    }, reviewActions, decision === 'approved' ? 'primary' : '');
  }
  action('下架删除', async () => confirmAction(article, `停止分享并删除「${m.name}」？已下载副本无法收回。`, '确认下架并删除', async () => { await api(`admin/submissions/${item.id}`, { method: 'DELETE' }); await load(); notice('已下架并删除。'); }), actions, 'danger quiet');
}
function renderRepo(item) {
  const article = element('article', '', $('submissions')); const m = item.metadata;
  const head = element('div', '', article); head.className = 'item-heading';
  const label = element('label', '', head); label.className = 'select-repo'; const check = document.createElement('input'); check.type = 'checkbox'; check.setAttribute('aria-label', '选择 Repo：' + m.name + ' / ' + item.signature); label.append(check);
  check.onchange = () => { if (check.checked) selected.add(item.id); else selected.delete(item.id); $('export-selected').textContent = `生成所选 Repo 合集卡（${selected.size}）`; };
  element('h2', m.name, head); badge(({ pending: '待转达', sent: '已转达', archived: '已归档' })[item.status], item.status, head);
  element('small', `作者：${m.credit} · ${item.author_code} · ${item.share_code}`, article);
  element('p', `${m.platforms.join(' / ')}${m.contact ? ' · ' + m.contact : ''}`, article);
  const quote = element('blockquote', item.message, article); element('footer', '— ' + item.signature, quote);
  element('small', '收到于 ' + new Date(item.created_at).toLocaleString() + ' · 私密，仅供人工转达', article);
  const actions = element('div', '', article); actions.className = 'actions';
  action('生成 Repo 卡片', () => exportCards([item]), actions, 'primary');
  action('只看这位作者', async () => { $('search').value = item.author_code; query = item.author_code; offset = 0; await load(); }, actions);
  for (const [status, label] of [['sent', '标记已转达'], ['archived', '归档'], ['pending', '恢复待转达']]) {
    if (item.status === status) continue;
    action(label, async () => { await api(`admin/repos/${item.id}`, { method: 'POST', body: JSON.stringify({ status }) }); await load(); notice('Repo 状态已更新。'); }, actions, 'quiet');
  }
}
async function exportCards(items) {
  if (!items.length) throw Error('请先勾选要整理的 Repo。');
  if (items.length > 3) throw Error('一张合集卡最多放 3 份 Repo，请分批整理。');
  if (new Set(items.map(item => item.author_code)).size !== 1) throw Error('一张合集卡只整理同一位作者的 Repo，避免转达错人。');
  const canvas = document.createElement('canvas'); canvas.width = 1080;
  let ctx = canvas.getContext('2d'); const lines = [];
  const wrap = (text, size, color = '#374735') => {
    ctx.font = `${size}px system-ui,sans-serif`;
    for (const paragraph of String(text).replace(/\s*\n\s*/g, ' ').split('\n')) {
      let line = '';
      for (const char of paragraph) { if (ctx.measureText(line + char).width > 880) { lines.push({ text: line, size, color }); line = char; } else line += char; }
      lines.push({ text: line, size, color });
    }
  };
  wrap('SULLYOS  /  REPO LETTER', 23, '#7b8872'); lines.push({ space: 34 });
  wrap('有一些喜欢，想告诉你。', 46); lines.push({ space: 24 });
  wrap('致 ' + items[0].metadata.credit, 30); lines.push({ space: 24 });
  for (const item of items) { wrap(item.metadata.name, 34); wrap(item.share_code, 22, '#7b8872'); lines.push({ space: 18 }); wrap(item.message, 30); lines.push({ space: 14 }); wrap('— ' + item.signature, 25, '#607456'); lines.push({ space: 40 }); }
  wrap('由 Sully 整理转达 · 私密 Repo，请尊重署名与反馈内容', 21, '#7b8872');
  canvas.height = Math.ceil(160 + lines.reduce((sum, line) => sum + (line.space || line.size * 1.65), 0));
  ctx = canvas.getContext('2d'); ctx.fillStyle = '#faf8ee'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#65815a'; ctx.fillRect(64, 66, 4, canvas.height - 132); let y = 90;
  for (const line of lines) { if (line.space) { y += line.space; continue; } ctx.font = `${line.size}px system-ui,sans-serif`; ctx.fillStyle = line.color; ctx.textBaseline = 'top'; ctx.fillText(line.text, 100, y); y += line.size * 1.65; }
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); if (!blob) throw Error('卡片生成失败，请重试');
  const preview = element('dialog', '', document.body); preview.className = 'repo-card-preview';
  const tools = element('div', '', preview); tools.className = 'actions';
  const save = element('button', '保存 PNG 卡片', tools); save.className = 'primary'; save.onclick = () => downloadBlob(blob, `Sully-Repo-${items[0].author_code}-${items[0].id.slice(0,8)}.png`);
  const close = element('button', '关闭', tools); close.onclick = () => { preview.close(); preview.remove(); };
  preview.addEventListener('cancel', () => preview.remove()); preview.append(canvas); preview.showModal();
  notice('卡片已生成。请手动发送给作者，发送后再标记「已转达」。');
}
async function load() {
  const result = await (await api(`admin/${view}?status=${$('filter').value}&offset=${offset}&q=${encodeURIComponent(query)}`)).json();
  offset = result.offset; pageSize = result.pageSize; nextOffset = result.nextOffset;
  selected.clear(); repos = result.repos || []; $('submissions').replaceChildren();
  const items = view === 'repos' ? repos : result.submissions;
  $('result-count').textContent = `共 ${result.total} ${view === 'repos' ? '份 Repo' : '份作品'} · 每页 ${pageSize} 份`;
  $('page-label').textContent = `第 ${Math.floor(offset / pageSize) + 1} / ${Math.max(1, Math.ceil(result.total / pageSize))} 页`;
  $('export-selected').hidden = view !== 'repos'; $('export-selected').textContent = '生成所选 Repo 合集卡';
  if (!items.length) { const p = element('p', '这里暂时没有符合条件的内容。', $('submissions')); p.className = 'empty'; }
  items.forEach(view === 'repos' ? renderRepo : renderSubmission); updatePaging();
}
function switchView(next) {
  view = next; offset = 0; query = ''; $('search').value = '';
  $('tab-submissions').setAttribute('aria-pressed', String(view === 'submissions')); $('tab-repos').setAttribute('aria-pressed', String(view === 'repos'));
  $('filter').replaceChildren();
  for (const [value, label] of view === 'repos' ? [['pending','待转达'],['sent','已转达'],['archived','已归档'],['all','全部']] : [['pending','审核中'],['approved','已通过'],['rejected','已退回'],['all','全部']]) { const option = element('option', label, $('filter')); option.value = value; }
  $('scope-note').textContent = view === 'repos' ? '仅管理员可见。按作者整理，最多选 3 份生成一张合集卡；发完 QQ 后再标记已转达。' : '文件内容请下载后人工检查，不直接执行投稿中的 CSS。';
  return load();
}
$('login').onsubmit = event => { event.preventDefault(); void busy(async () => {
  const body = { username: $('username').value.trim(), password: $('password').value, ...(setupToken ? { token: setupToken } : {}) };
  const result = await (await api(setupToken ? 'admin/setup' : 'admin/login', { method: 'POST', body: JSON.stringify(body) })).json();
  token = result.token; setupToken = ''; $('password').value = ''; sessionStorage.setItem('beauty-admin-session', token); show(); await load();
}); };
$('tab-submissions').onclick = () => busy(() => switchView('submissions')); $('tab-repos').onclick = () => busy(() => switchView('repos'));
$('filter').onchange = () => busy(async () => { offset = 0; await load(); }); $('refresh').onclick = () => busy(load);
$('search-button').onclick = () => busy(async () => { query = $('search').value.trim(); offset = 0; await load(); });
$('search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); $('search-button').click(); } };
for (const direction of ['previous','more']) $(direction).onclick = () => busy(async () => { offset = direction === 'previous' ? Math.max(0, offset - pageSize) : nextOffset; await load(); $('workspace').scrollIntoView({ block: 'start' }); });
$('export-selected').onclick = () => busy(() => exportCards(repos.filter(item => selected.has(item.id))));
$('logout').onclick = () => busy(async () => { await api('auth/logout', { method: 'POST' }); token = ''; sessionStorage.removeItem('beauty-admin-session'); show(); });
show(); if (token) void busy(load);

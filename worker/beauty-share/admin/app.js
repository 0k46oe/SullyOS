'use strict';
const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('beauty-admin-session') || '';
let setupToken = new URLSearchParams(location.hash.slice(1)).get('setup') || '';
if (setupToken) { history.replaceState(null, '', location.pathname); $('login-title').textContent = '建立管理员账号'; $('login-button').textContent = '建立账号'; $('setup-note').hidden = false; $('password').autocomplete = 'new-password'; }
let offset = 0;
function notice(message) { $('notice').textContent = message; }
function show() { $('login').hidden = !!token; $('workspace').hidden = !token; }
async function api(path, options = {}) {
  const response = await fetch('/api/' + path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
  if (!response.ok) { if (response.status === 401) { token = ''; sessionStorage.removeItem('beauty-admin-session'); show(); } const body = await response.json().catch(() => ({})); throw Error(body.error || '操作失败'); }
  return response;
}
async function busy(work) {
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  notice(''); try { await work(); } catch (error) { notice(error.message); }
  finally { for (const button of document.querySelectorAll('button')) button.disabled = false; }
}
function element(tag, text, parent) { const node = document.createElement(tag); node.textContent = text; if (parent) parent.append(node); return node; }
function action(label, work, parent, cls = '') { const button = element('button', label, parent); button.className = cls; button.onclick = () => busy(work); return button; }
async function load() {
  const { submissions, nextOffset } = await (await api(`admin/submissions?status=${$('filter').value}&offset=${offset}`)).json();
  $('submissions').replaceChildren();
  if (!submissions.length) element('p', '没有对应状态的提交。', $('submissions'));
  for (const item of submissions) {
    const article = element('article', '', $('submissions')); const m = item.metadata;
    element('h2', m.name, article);
    element('small', `${item.kind === 'appearance' ? '外观预设' : '聊天装扮'} · 作者码 ${item.authorCode} · ${new Date(item.updatedAt).toLocaleString()}`, article);
    element('p', `署名：${m.credit}\n平台：${m.platforms.join('、')}\n联系说明：${m.contact || '未填写'}\n允许二改：${m.allowRemix ? '是' : '否'}\n允许二次传播：${m.allowRedistribute ? '是' : '否'}\n导出版本：${m.exportVersion}\nBug 反馈：${m.bugFeedback === 'welcome' ? '欢迎' : '请自行修复处理'}\n作者留言：${m.message || '未填写'}`, article);
    if (item.shareCode) element('p', `分享码：${item.shareCode}${item.pendingRevision ? '（旧版仍可领取）' : ''}`, article);
    if (item.reviewNote) element('p', `上次审核说明：${item.reviewNote}`, article);
    const actions = element('div', '', article); actions.className = 'actions';
    action('下载待检查文件', async () => {
      const response = await api(`revisions/${item.latestRevision}/file`); const blob = await response.blob();
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `beauty-review-${item.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, actions);
    if (item.pendingRevision) {
      const label = element('label', '审核说明（退回时必填）', article); const note = document.createElement('textarea'); note.maxLength = 1000; label.append(note);
      const reviewActions = element('div', '', article); reviewActions.className = 'actions';
      for (const [decision, text] of [['approved', '通过并开放分享'], ['rejected', '退回修改']]) {
        action(text, async () => {
          if (decision === 'approved' && !confirm(`确认已检查「${m.name}」的这份文件，并开放凭码下载？`)) return;
          await api(`admin/revisions/${item.pendingRevision}/review`, { method: 'POST', body: JSON.stringify({ decision, note: note.value }) }); await load();
        }, reviewActions, decision === 'approved' ? 'primary' : '');
      }
    }
    action('下架并删除文件', async () => { if (!confirm(`停止分享并删除「${m.name}」？已下载副本无法收回。`)) return; await api(`admin/submissions/${item.id}`, { method: 'DELETE' }); await load(); }, actions, 'danger');
  }
  $('more').hidden = nextOffset === null;
  $('more').onclick = () => busy(async () => { offset = nextOffset; await load(); });
}
$('login').onsubmit = event => { event.preventDefault(); void busy(async () => {
  const body = { username: $('username').value.trim(), password: $('password').value, ...(setupToken ? { token: setupToken } : {}) };
  const result = await (await api(setupToken ? 'admin/setup' : 'admin/login', { method: 'POST', body: JSON.stringify(body) })).json();
  token = result.token; setupToken = ''; $('password').value = ''; sessionStorage.setItem('beauty-admin-session', token); show(); await load();
}); };
$('refresh').onclick = $('filter').onchange = () => busy(async () => { offset = 0; await load(); });
$('logout').onclick = () => busy(async () => { await api('auth/logout', { method: 'POST' }); token = ''; sessionStorage.removeItem('beauty-admin-session'); show(); });
show(); if (token) void busy(load);

import { $, $$, api, state, esc, icon, avatar, fmt, toast, modal, confirmBox, busy } from '../core.js';

const MODES = { queue: 'Add to my queue (I click Post)', now: 'Publish immediately' };

function feedDialog(feed, after) {
  const sel = new Set(feed?.account_ids || []);
  modal({ title: feed ? 'Edit feed' : 'Add RSS feed', wide: true, body: `
    ${feed ? `<div class="text-2 small">${esc(feed.url)}</div>` : `<label class="field">Feed URL <span class="hint">blog, YouTube channel, podcast, news site…</span><input type="url" id="url" placeholder="https://example.com/feed.xml"></label>`}
    <label class="field">Post to<div class="row" id="accs">${state.accounts.map((a) => `<button type="button" class="chip ${sel.has(a.id) ? 'on' : ''}" data-id="${a.id}">${avatar(a, 'sm')}${esc(a.name)}</button>`).join('') || '<span class="muted">Connect an account first.</span>'}</div></label>
    <label class="field">When a new item appears<select id="mode">${Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${feed?.mode === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="field">Post template <span class="hint">use {title}, {link} and {summary}</span><textarea id="tpl" rows="3">${esc(feed?.template || 'New post: {title}\n{link}')}</textarea></label>
    <label class="field">Check at most every<select id="iv">${[15, 30, 60, 180, 720, 1440].map((m) => `<option value="${m}" ${(feed?.interval_min || 60) === m ? 'selected' : ''}>${m < 60 ? `${m} minutes` : m === 60 ? 'hour' : `${m / 60} hours`}</option>`).join('')}</select></label>
    <p class="hint">Existing items are skipped — only new ones from now on. Feeds are checked when you open the app (or click “Check now”).</p>`,
  actions: [{ label: 'Cancel' }, { label: feed ? 'Save' : 'Add feed', kind: 'primary', onClick: async (d) => {
    const body = { accountIds: [...sel], mode: $('#mode', d).value, template: $('#tpl', d).value, intervalMin: Number($('#iv', d).value) };
    if (feed) await api(`/feeds/${feed.id}`, { method: 'PUT', body });
    else await api('/feeds', { method: 'POST', body: { ...body, url: $('#url', d).value } });
    toast(feed ? 'Saved' : 'Feed added', 'ok'); after();
  } }],
  onOpen: (d) => { $('#accs', d).onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; const id = Number(c.dataset.id); sel.has(id) ? sel.delete(id) : sel.add(id); c.classList.toggle('on'); }; $('#url', d)?.focus(); } });
}

export async function render(root) {
  root.innerHTML = `<div class="page">
    <div class="page-head"><div class="grow"><h1>RSS autopilot</h1><p class="sub">New blog posts, videos or podcast episodes land in your queue automatically.</p></div><button class="btn primary" id="add">${icon('plus')} Add feed</button></div>
    <div class="card"><div class="list" id="list"></div></div></div>`;
  async function draw() {
    const feeds = await api('/feeds');
    $('#list', root).innerHTML = feeds.length ? feeds.map((f) => `<div class="item" data-id="${f.id}" style="grid-template-columns:auto minmax(0,1fr) auto">
      <label class="switch" data-tip="${f.enabled ? 'On' : 'Paused'}"><input type="checkbox" data-act="toggle" ${f.enabled ? 'checked' : ''}><span></span></label>
      <div style="min-width:0"><b>${esc(f.title || f.url)}</b> <span class="badge nodot">${esc(MODES[f.mode])}</span>
        <div class="muted small ellipsis">${esc(f.url)}</div>
        <div class="row small" style="margin-top:6px">${f.account_ids.map((id) => state.accounts.find((a) => a.id === id)).filter(Boolean).map((a) => `${avatar(a, 'sm')}`).join('')}
        <span class="muted">Checked ${f.last_checked ? fmt.rel(f.last_checked) : 'never'}</span></div>
        ${f.last_error ? `<div class="err small" style="color:var(--bad)">${esc(f.last_error)}</div>` : ''}</div>
      <div class="actions"><button class="btn sm ghost" data-act="check">Check now</button><button class="btn sm ghost icon" data-act="edit" data-tip="Edit">${icon('edit')}</button><button class="btn sm ghost icon danger" data-act="del" data-tip="Delete">${icon('trash')}</button></div></div>`).join('')
      : `<div class="empty">${icon('rss')}<b>No feeds yet</b><span>Add your blog's RSS feed or a YouTube channel feed (youtube.com/feeds/videos.xml?channel_id=…).</span></div>`;
    $('#list', root).onclick = async (e) => {
      const b = e.target.closest('[data-act]'); if (!b || b.dataset.act === 'toggle') return;
      const f = feeds.find((x) => x.id === Number(b.closest('[data-id]').dataset.id));
      if (b.dataset.act === 'edit') feedDialog(f, draw);
      if (b.dataset.act === 'check') busy(b, async () => { const r = await api(`/feeds/${f.id}/check`, { method: 'POST' }); toast(r.created ? `${r.created} new post${r.created > 1 ? 's' : ''} created` : 'No new items', 'ok'); draw(); })();
      if (b.dataset.act === 'del' && await confirmBox('Delete this feed?', { ok: 'Delete', danger: true })) { await api(`/feeds/${f.id}`, { method: 'DELETE' }); draw(); }
    };
    $('#list', root).onchange = async (e) => { const i = e.target.closest('[data-act=toggle]'); if (!i) return; await api(`/feeds/${i.closest('[data-id]').dataset.id}`, { method: 'PUT', body: { enabled: i.checked } }).catch((err) => toast(err.message, 'bad')); draw(); };
  }
  $('#add', root).onclick = () => feedDialog(null, draw);
  await draw();
}

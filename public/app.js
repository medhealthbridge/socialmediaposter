const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (path, opts = {}) => {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: opts.csv ? { 'content-type': 'text/csv' } : { 'content-type': 'application/json' },
    body: opts.csv ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  if (res.status === 204) return null;
  const j = await res.json();
  if (res.status === 401 && !path.startsWith('/auth/')) { state.user = null; showLogin(); throw new Error('Please log in'); }
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
};
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.style.display = 'block'; setTimeout(() => (t.style.display = 'none'), 3500); };
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };
const fmt = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'no date');
const localInput = (iso) => { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

// Typical high-engagement windows (generic industry heuristics, local time). Replace with your own data.
const BEST = {
  mastodon: ['Tue–Thu 09:00', 'Wed 12:00', 'Sun 20:00'], bluesky: ['Mon–Fri 08:00', 'Wed 13:00', 'Sat 10:00'],
  telegram: ['Daily 08:00', 'Daily 19:00'], discord: ['Fri 18:00', 'Sat 15:00'], webhook: ['Tue–Thu 10:00'], mock: ['Anytime'],
};

const state = { tab: 'compose', accounts: [], providers: {}, month: new Date(), editing: null, user: null };
const tabs = [['compose', 'Compose'], ['calendar', 'Calendar'], ['queue', 'Queue & History'], ['bulk', 'Bulk upload'], ['analytics', 'Analytics'], ['accounts', 'Accounts'], ['schedule', 'Weekly queue'], ['team', 'Team']];

function renderNav() {
  $('#nav').innerHTML = tabs.filter(([k]) => k !== 'team' || state.user?.is_admin).map(([k, l]) => `<button data-t="${k}" class="${state.tab === k ? 'on' : ''}">${l}</button>`).join('') + `<span class="sp"></span><span class="hint">${esc(state.user?.email)}</span><button data-t="logout">Log out</button>`;
  $('#nav').onclick = (e) => { const t = e.target.dataset.t; if (t === 'logout') { api('/auth/logout', { method: 'POST' }).then(boot); return; } if (t) { state.tab = t; state.editing = null; render(); } };
}

async function render() {
  renderNav();
  [state.accounts, state.providers] = await Promise.all([api('/accounts'), api('/providers')]);
  await views[state.tab]();
}

const views = {
  async compose() {
    const p = state.editing;
    const sel = new Set(p ? p.deliveries.map((d) => d.account_id) : []);
    if (!state.accounts.length) { $('#app').innerHTML = '<div class="card">Add an account first (Accounts tab). Use “Mock” to try it without any real network.</div>'; return; }
    $('#app').innerHTML = `
    <div class="grid"><div class="card">
      <h3>${p ? `Edit post #${p.id}` : 'New post'}</h3>
      <label>Post to</label>
      <div class="row" id="accs">${state.accounts.map((a) => `<span class="chip ${sel.has(a.id) ? 'on' : ''}" data-id="${a.id}" data-type="${a.type}">${esc(a.name)}</span>`).join('')}</div>
      <label>Text</label><textarea id="text" placeholder="What's happening?">${esc(p?.text)}</textarea>
      <div id="counts" class="cnt"></div>
      <label>Media / link URLs (one per line, appended to text)</label><textarea id="media" style="min-height:50px">${esc((p?.media || []).join('\n'))}</textarea>
      <label>Schedule (your local time)</label><input type="datetime-local" id="when" value="${localInput(p?.scheduled_at)}">
      <div class="hint" id="best"></div>
      <div class="row" style="margin-top:14px">
        <button class="p" id="sched">${p ? 'Save' : 'Schedule'}</button>
        ${p ? '' : '<button class="s" id="queue">Add to queue</button>'}
        <button class="s" id="draft">Save as draft</button>
        ${p ? '' : '<button class="s" id="now">Post now</button>'}
        <span class="sp"></span>${p ? '<button class="s" id="cancel">Cancel</button>' : ''}
      </div>
    </div>
    <div class="card"><h3>Preview</h3><div id="prev" style="white-space:pre-wrap;word-break:break-word"></div></div></div>`;
    const selected = () => [...document.querySelectorAll('#accs .chip.on')].map((c) => +c.dataset.id);
    const body = () => ({ text: $('#text').value, media: $('#media').value.split('\n').map((s) => s.trim()).filter(Boolean), accountIds: selected(), scheduledAt: $('#when').value ? new Date($('#when').value).toISOString() : null });
    const refresh = () => {
      const b = body(), full = [b.text, ...b.media].join('\n');
      $('#prev').textContent = full || 'Nothing yet…';
      const types = [...document.querySelectorAll('#accs .chip.on')].map((c) => c.dataset.type);
      $('#counts').innerHTML = [...new Set(types)].map((t) => { const l = state.providers[t].limit; return `<span class="${full.length > l ? 'over' : ''}">${state.providers[t].label}: ${full.length}/${l}</span>`; }).join(' · ');
      $('#best').textContent = types.length ? 'Suggested times: ' + [...new Set(types)].map((t) => `${state.providers[t].label} → ${BEST[t].join(', ')}`).join(' | ') : '';
    };
    $('#accs').onclick = (e) => { e.target.closest('.chip')?.classList.toggle('on'); refresh(); };
    $('#text').oninput = $('#media').oninput = refresh; refresh();
    const save = guard(async (mode) => {
      const b = body();
      if (mode === 'queue') b.queue = true;
      if (mode === 'sched' && !b.scheduledAt) throw new Error('Pick a date/time, or use Post now / Save as draft');
      if (mode === 'draft') b.scheduledAt = null;
      if (p) await api(`/posts/${p.id}`, { method: 'PUT', body: b });
      else await api('/posts', { method: 'POST', body: { ...b, publishNow: mode === 'now' } });
      toast(mode === 'now' ? 'Publishing…' : mode === 'draft' ? 'Draft saved' : mode === 'queue' ? 'Added to next free slot' : 'Scheduled');
      state.editing = null; state.tab = mode === 'now' ? 'queue' : 'calendar'; render();
    });
    $('#sched').onclick = () => save('sched'); $('#draft').onclick = () => save('draft');
    if ($('#now')) $('#now').onclick = () => save('now');
    if ($('#queue')) $('#queue').onclick = () => save('queue');
    if ($('#cancel')) $('#cancel').onclick = () => { state.editing = null; state.tab = 'queue'; render(); };
  },

  async calendar() {
    const m = state.month, y = m.getFullYear(), mo = m.getMonth();
    const first = new Date(y, mo, 1), start = new Date(y, mo, 1 - first.getDay()), end = new Date(start.getTime() + 42 * 864e5);
    const posts = await api(`/posts?from=${start.toISOString()}&to=${end.toISOString()}`);
    let cells = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="h">${d}</div>`).join('');
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getTime() + i * 864e5);
      const ev = posts.filter((p) => new Date(p.scheduled_at || p.created_at).toDateString() === d.toDateString()).reverse();
      cells += `<div class="${d.getMonth() !== mo ? 'dim' : ''}"><div class="d">${d.getDate()}</div>${ev.map((p) => `<div class="ev ${p.status}" data-id="${p.id}" title="${esc(p.text)}">${p.scheduled_at ? new Date(p.scheduled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'draft'} ${esc(p.text)}</div>`).join('')}</div>`;
    }
    $('#app').innerHTML = `<div class="card"><div class="row"><button class="s" id="prev">←</button><h3 class="sp" style="text-align:center;margin:0">${m.toLocaleString([], { month: 'long', year: 'numeric' })}</h3><button class="s" id="next">→</button></div><br><div class="cal">${cells}</div></div>`;
    $('#prev').onclick = () => { state.month = new Date(y, mo - 1, 1); render(); };
    $('#next').onclick = () => { state.month = new Date(y, mo + 1, 1); render(); };
    $('.cal').onclick = guard(async (e) => { const id = e.target.dataset.id; if (!id) return; state.editing = await api(`/posts/${id}`); state.tab = 'compose'; render(); });
  },

  async queue() {
    const posts = await api('/posts');
    $('#app').innerHTML = `<div class="card"><h3>Posts</h3>${posts.map((p) => `
      <div class="post"><div class="row"><span class="tag ${p.status}">${p.status}</span><span class="cnt">${fmt(p.scheduled_at)}</span><span class="sp"></span>
        ${['published', 'publishing'].includes(p.status) ? '' : `<button class="s" data-a="edit" data-id="${p.id}">Edit</button><button class="s" data-a="now" data-id="${p.id}">${p.status === 'failed' || p.status === 'partial' ? 'Retry' : 'Post now'}</button>`}
        <button class="s" data-a="dup" data-id="${p.id}">Duplicate</button><button class="s d" data-a="del" data-id="${p.id}">Delete</button></div>
        <div style="margin:6px 0;white-space:pre-wrap">${esc(p.text)}</div>
        <div class="row">${p.deliveries.map((d) => `<span class="tag ${d.status === 'pending' ? '' : d.status}">${esc(d.account_name)}: ${d.status}${d.remote_url ? ` · <a href="${esc(d.remote_url)}" target="_blank" rel="noopener">view</a>` : ''}</span>${d.error ? `<span class="err">${esc(d.error)}</span>` : ''}`).join('')}</div></div>`).join('') || '<p class="hint">Nothing yet.</p>'}</div>`;
    $('#app').onclick = guard(async (e) => {
      const { a, id } = e.target.dataset; if (!a) return;
      if (a === 'del' && confirm('Delete this post?')) await api(`/posts/${id}`, { method: 'DELETE' });
      if (a === 'now') { await api(`/posts/${id}/publish`, { method: 'POST' }); toast('Publishing…'); }
      if (a === 'edit') { state.editing = await api(`/posts/${id}`); state.tab = 'compose'; }
      if (a === 'dup') { await api(`/posts/${id}/duplicate`, { method: 'POST' }); toast('Duplicated as draft'); }
      render();
    });
  },

  async bulk() {
    $('#app').innerHTML = `<div class="card"><h3>Bulk schedule (up to 350 posts)</h3>
      <p class="hint">CSV with header <code>text,scheduled_at,accounts</code>. <code>scheduled_at</code> is ISO (e.g. 2026-10-05T09:00:00Z, or local like 2026-10-05T09:00); leave empty for a draft. <code>accounts</code> = account names separated by <code>;</code>.</p>
      <textarea id="csv" style="min-height:200px;font-family:monospace">text,scheduled_at,accounts\n"Hello world!",2026-10-05T09:00,"${esc(state.accounts[0]?.name || 'My account')}"</textarea>
      <div class="row" style="margin:10px 0"><input type="file" id="file" accept=".csv" style="width:auto"><span class="sp"></span><button class="p" id="go">Import</button></div><div id="res"></div></div>`;
    $('#file').onchange = async (e) => { $('#csv').value = await e.target.files[0].text(); };
    $('#go').onclick = guard(async () => {
      const r = await api('/bulk', { method: 'POST', csv: $('#csv').value });
      $('#res').innerHTML = `<b>${r.created} created</b>${r.errors.map((x) => `<div class="err">Row ${x.row}: ${esc(x.error)}</div>`).join('')}`;
    });
  },

  async analytics() {
    const s = await api('/stats'), max = Math.max(1, ...s.perDay.map((d) => d.n));
    $('#app').innerHTML = `<div class="grid"><div class="card"><h3>Posts by status</h3>${s.posts.map((x) => `<div class="row"><span class="tag ${x.status}">${x.status}</span> ${x.n}</div>`).join('') || '<p class="hint">No data.</p>'}</div>
      <div class="card"><h3>Per account</h3>${s.perAccount.map((a) => `<div class="post"><b>${esc(a.name)}</b> <span class="hint">${a.type}</span><br>✓ ${a.published || 0} &nbsp; ✗ ${a.failed || 0} &nbsp; ⏳ ${a.pending || 0}</div>`).join('')}</div></div>
      <div class="card"><h3>Published, last 30 days</h3>${s.perDay.map((d) => `<div class="row"><span class="cnt" style="width:90px">${d.day}</span><div class="bar" style="width:${(d.n / max) * 70}%"></div>${d.n}</div>`).join('') || '<p class="hint">No data.</p>'}
      <p class="hint">Engagement metrics (likes, reach) need each network's analytics API; this tracks your own publishing activity.</p></div>`;
  },

  async schedule() {
    const { tz, slots, next } = await api('/slots');
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    $('#app').innerHTML = `<div class="grid"><div class="card"><h3>Weekly queue slots</h3>
      <p class="hint">“Add to queue” on the composer picks the next free slot below, in your timezone.</p>
      ${days.map((d, i) => `<div class="post row"><b style="width:44px">${d}</b>${slots.filter((s) => s.dow === i).map((s) => `<span class="chip on" data-del="${i}|${s.time}">${s.time} ✕</span>`).join('') || '<span class="hint">no slots</span>'}</div>`).join('')}
      <p class="hint">Next free slot: ${next ? fmt(next) : 'none (add a slot)'}</p></div>
      <div class="card"><h3>Add slot</h3><label>Days</label><div class="row" id="dsel">${days.map((d, i) => `<span class="chip" data-d="${i}">${d}</span>`).join('')}</div>
      <label>Time</label><input type="time" id="time" value="09:00"><br><br><button class="p" id="addslot">Add</button>
      <label>Your timezone</label><input id="tz" value="${esc(tz)}"><br><br><button class="s" id="savetz">Save timezone</button></div></div>`;
    const save = guard(async (next) => { await api('/slots', { method: 'PUT', body: { slots: next } }); render(); });
    $('#dsel').onclick = (e) => e.target.closest('.chip')?.classList.toggle('on');
    $('#addslot').onclick = () => { const ds = [...document.querySelectorAll('#dsel .on')].map((c) => +c.dataset.d); const t = $('#time').value; if (!ds.length || !t) return toast('Pick days and a time'); const set = new Map(slots.map((s) => [`${s.dow}|${s.time}`, s])); ds.forEach((d) => set.set(`${d}|${t}`, { dow: d, time: t })); save([...set.values()]); };
    $('.grid .card').onclick = (e) => { const k = e.target.dataset.del; if (k) save(slots.filter((s) => `${s.dow}|${s.time}` !== k)); };
    $('#savetz').onclick = guard(async () => { await api('/me', { method: 'PUT', body: { tz: $('#tz').value } }); toast('Saved'); render(); });
  },

  async team() {
    const users = await api('/users');
    $('#app').innerHTML = `<div class="grid"><div class="card"><h3>Users</h3>${users.map((u) => `<div class="post row"><b>${esc(u.email)}</b>${u.is_admin ? '<span class="tag">admin</span>' : ''}<span class="sp"></span>${u.is_admin ? '' : `<button class="s d" data-id="${u.id}">Remove</button>`}</div>`).join('')}</div>
      <div class="card"><h3>Add user</h3><label>Email</label><input id="em"><label>Temporary password (min 8)</label><input id="pw" type="password" autocomplete="new-password"><br><br><button class="p" id="adduser">Create</button>
      <p class="hint">Each user only sees their own accounts, posts and queue. Removing a user deletes all of their data.</p></div></div>`;
    $('#adduser').onclick = guard(async () => { await api('/users', { method: 'POST', body: { email: $('#em').value, password: $('#pw').value, tz: state.user.tz } }); toast('User created'); render(); });
    $('.grid .card').onclick = guard(async (e) => { const id = e.target.dataset.id; if (id && confirm('Delete user and all their data?')) { await api(`/users/${id}`, { method: 'DELETE' }); render(); } });
  },

  async accounts() {
    const opts = Object.entries(state.providers).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    $('#app').innerHTML = `<div class="grid"><div class="card"><h3>Connected accounts</h3>${state.accounts.map((a) => `<div class="post row"><b>${esc(a.name)}</b><span class="tag">${state.providers[a.type]?.label}</span><span class="sp"></span><button class="s" data-a="test" data-id="${a.id}">Send test</button><button class="s d" data-a="del" data-id="${a.id}">Remove</button></div>`).join('') || '<p class="hint">None yet.</p>'}</div>
      <div class="card"><h3>Add account</h3><label>Network</label><select id="type">${opts}</select><label>Display name</label><input id="name" placeholder="e.g. Personal Mastodon"><div id="fields"></div><br><button class="p" id="add">Add</button>
      <p class="hint">Credentials are stored in the local SQLite file only. Tokens are never sent back to the browser.</p></div></div>`;
    const draw = () => { $('#fields').innerHTML = state.providers[$('#type').value].fields.map((f) => `<label>${esc(f.label)}</label><input data-k="${f.key}" type="${f.secret ? 'password' : 'text'}" placeholder="${esc(f.placeholder || '')}" autocomplete="off">`).join(''); };
    $('#type').onchange = draw; draw();
    $('#add').onclick = guard(async () => {
      const config = Object.fromEntries([...document.querySelectorAll('#fields input')].filter((i) => i.value).map((i) => [i.dataset.k, i.value.trim()]));
      await api('/accounts', { method: 'POST', body: { name: $('#name').value, type: $('#type').value, config } }); toast('Added'); render();
    });
    $('#app').onclick = guard(async (e) => {
      const { a, id } = e.target.dataset; if (!a) return;
      if (a === 'del' && confirm('Remove account and its history?')) { await api(`/accounts/${id}`, { method: 'DELETE' }); render(); }
      if (a === 'test') { const r = await api(`/accounts/${id}/test`, { method: 'POST' }); toast('Test sent' + (r.url ? `: ${r.url}` : '')); }
    });
  },
};

function showLogin(needsSetup = false) {
  $('#nav').innerHTML = '';
  $('#app').innerHTML = `<div class="card" style="max-width:380px;margin:60px auto"><h3>${needsSetup ? 'Create the admin account' : 'Log in'}</h3>
    <label>Email</label><input id="em" type="email" autocomplete="username"><label>Password${needsSetup ? ' (min 8)' : ''}</label><input id="pw" type="password" autocomplete="${needsSetup ? 'new-password' : 'current-password'}">
    <br><br><div class="row"><button class="p" id="go">${needsSetup ? 'Create account' : 'Log in'}</button>${needsSetup ? '' : '<button class="s" id="su">Sign up</button>'}</div></div>`;
  const go = (path) => guard(async () => { await api(path, { method: 'POST', body: { email: $('#em').value, password: $('#pw').value, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } }); boot(); });
  $('#go').onclick = go(needsSetup ? '/auth/signup' : '/auth/login');
  if ($('#su')) $('#su').onclick = go('/auth/signup');
  $('#pw').onkeydown = (e) => e.key === 'Enter' && $('#go').click();
}
async function boot() {
  const st = await api('/auth/status');
  state.user = st.user;
  if (!st.user) return showLogin(st.needsSetup);
  render();
}
guard(boot)();

import { $, $$, api, state, refresh, esc, icon, fmt, toast, modal, busy, confirmBox, copyBox, avatar } from '../core.js';
import { appSetup } from './accounts.js';

const SECTIONS = [['general', 'General'], ['schedule', 'Posting schedule'], ['integrations', 'Developer apps'], ['ai', 'AI assistant'], ['tracking', 'Link tracking'], ['security', 'Password'], ['team', 'Users'], ['data', 'Backup & data']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function render(root, qs) {
  let sec = SECTIONS.some(([k]) => k === qs.get('s')) ? qs.get('s') : 'general';
  root.innerHTML = `<div class="page"><div class="page-head"><h1>Settings</h1></div>
    <div class="settings"><nav id="snav"></nav><div id="sbody" class="col gap-lg"></div></div></div>`;
  const save = async (patch, msg = 'Saved') => { state.settings = await api('/settings', { method: 'PUT', body: patch }); toast(msg, 'ok'); };

  const views = {
    general() {
      const s = state.settings;
      const tzs = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [state.user.tz];
      return [`<div class="card card-pad form">
        <h2>Publishing</h2>
        <label class="check"><span class="switch"><input type="checkbox" id="paused" ${s.paused ? 'checked' : ''}><span></span></span> Pause all publishing</label>
        <p class="hint" style="margin-top:-8px">Like an emergency brake: scheduled posts wait until you turn this off.</p>
        <label class="field">Your timezone<select id="tz">${tzs.map((t) => `<option ${t === state.user.tz ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label class="field">Failure alerts <span class="hint">send a message here when a post fails (Telegram or Discord work great)</span>
          <select id="alerts"><option value="">Off</option>${state.accounts.map((a) => `<option value="${a.id}" ${s.alertsAccountId === a.id ? 'selected' : ''}>${esc(a.name)} (${esc(state.providers[a.type]?.label)})</option>`).join('')}</select></label>
      </div>
      <div class="card card-pad form">
        <h2>Public address</h2>
        <p class="text-2">The address where this app is reachable. It's used for login redirects and so Instagram/Threads can fetch your images. Instagram, Facebook and Threads need <b>https://</b>.</p>
        <label class="field">Public URL<input type="url" id="pub" value="${esc(s.publicUrl)}" placeholder="${esc(s.effectiveUrl)}"></label>
        <p class="hint">Currently using: <code>${esc(s.effectiveUrl)}</code>${s.publicUrl ? '' : ' (detected from your browser)'}</p>
        <div><button class="btn primary" id="savePub">Save</button></div>
      </div>`, () => {
        $('#paused').onchange = async (e) => { await save({ paused: e.target.checked }, e.target.checked ? 'Publishing paused' : 'Publishing resumed'); };
        $('#tz').onchange = async (e) => { await api('/me', { method: 'PUT', body: { tz: e.target.value } }); await refresh(); toast('Timezone saved', 'ok'); };
        $('#alerts').onchange = async (e) => save({ alertsAccountId: e.target.value || null });
        $('#savePub').onclick = busy($('#savePub'), async () => { await save({ publicUrl: $('#pub').value }); draw(); });
      }];
    },
    async schedule() {
      let slots = state.slots.slice();
      return [`<div class="card card-pad form" style="max-width:none">
        <h2>Weekly posting times</h2>
        <p class="text-2">“Add to queue” in the composer drops a post into the next free time below (${esc(state.user.tz)}). Tip: pick times from Analytics → Best time to post.</p>
        <div class="slot-grid" id="slots"></div>
        <div class="row"><div class="row" id="dsel">${DAYS.map((d, i) => `<button type="button" class="chip plain" data-d="${i}">${d}</button>`).join('')}</div>
          <input type="time" id="time" value="09:00" style="width:130px"><button class="btn primary" id="addSlot">${icon('plus')} Add time</button></div>
        <div class="row"><button class="btn sm ghost" id="preset">Use a starter schedule (weekdays 9:00, 12:30, 17:30)</button><span class="right muted small" id="next"></span></div>
      </div>`, () => {
        const drawSlots = () => {
          $('#slots').innerHTML = DAYS.map((d, i) => `<div class="slot-row"><b class="small">${d}</b><div class="row">${slots.filter((s) => s.dow === i).sort((a, b) => a.time.localeCompare(b.time)).map((s) => `<span class="slot">${s.time}<button data-del="${i}|${s.time}" aria-label="Remove">${icon('x')}</button></span>`).join('') || '<span class="muted small">—</span>'}</div></div>`).join('');
          $('#next').textContent = state.nextSlot ? `Next free slot: ${fmt.dateTime(state.nextSlot)}` : '';
        };
        const put = async (next) => { const r = await api('/slots', { method: 'PUT', body: { slots: next } }); slots = r.slots; state.slots = r.slots; state.nextSlot = r.next; drawSlots(); };
        drawSlots();
        $('#dsel').onclick = (e) => e.target.closest('.chip')?.classList.toggle('on');
        $('#slots').onclick = (e) => { const b = e.target.closest('[data-del]'); if (b) put(slots.filter((s) => `${s.dow}|${s.time}` !== b.dataset.del)); };
        $('#addSlot').onclick = () => {
          const ds = $$('#dsel .on').map((c) => Number(c.dataset.d)); const t = $('#time').value;
          if (!ds.length || !t) return toast('Pick at least one day and a time');
          const map = new Map(slots.map((s) => [`${s.dow}|${s.time}`, s])); ds.forEach((d) => map.set(`${d}|${t}`, { dow: d, time: t }));
          put([...map.values()]); $$('#dsel .on').forEach((c) => c.classList.remove('on'));
        };
        $('#preset').onclick = () => put([1, 2, 3, 4, 5].flatMap((d) => ['09:00', '12:30', '17:30'].map((time) => ({ dow: d, time }))));
      }];
    },
    integrations() {
      const apps = Object.values(state.connectors).filter((c) => c.app);
      return [`<div class="card card-pad form" style="max-width:none"><h2>Developer apps</h2>
        <p class="text-2">X, LinkedIn, Facebook/Instagram and Threads only allow posting through an app you register with them (free, a few minutes, once). Bluesky, Mastodon, Telegram and Discord need nothing here.</p>
        <div class="list" style="margin:0 -20px">${apps.map((c) => { const a = state.settings.apps[c.id]; return `<div class="item" style="grid-template-columns:minmax(0,1fr) auto"><div><b>${esc(c.label)}</b> ${a.configured ? '<span class="badge ok">Ready</span>' : '<span class="badge draft">Not set up</span>'}<div class="muted small" style="margin-top:4px">Redirect URL: <code>${esc(a.redirectUri)}</code></div></div><button class="btn sm" data-app="${c.id}">${a.configured ? 'Edit' : 'Set up'}</button></div>`; }).join('')}</div></div>`,
      () => { $('#sbody').onclick = async (e) => { const b = e.target.closest('[data-app]'); if (b && await appSetup(b.dataset.app)) { toast('Saved — now connect accounts from the Accounts page', 'ok'); draw(); } }; }];
    },
    ai() {
      const ai = state.settings.ai;
      return [`<div class="card card-pad form"><h2>${icon('sparkle')} AI assistant</h2>
        <p class="text-2">Write, improve, shorten, add hashtags, change tone and adapt posts per network — powered by Claude. You pay Anthropic directly for what you use (usually a fraction of a cent per suggestion).</p>
        <label class="field">Anthropic API key <span class="hint">from <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> — stored encrypted</span><input type="password" id="key" placeholder="${ai.hasKey ? '•••••••• (saved)' : 'sk-ant-…'}" autocomplete="off"></label>
        <label class="field">Model<select id="model">${state.aiModels.map((m) => `<option value="${m.id}" ${ai.model === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></label>
        <div class="row"><button class="btn primary" id="saveAi">Save</button>${ai.hasKey ? '<button class="btn ghost danger" id="rmKey">Remove key</button>' : ''}</div></div>`, () => {
        $('#saveAi').onclick = busy($('#saveAi'), async () => { await save({ ai: { apiKey: $('#key').value || undefined, model: $('#model').value } }); draw(); });
        $('#rmKey')?.addEventListener('click', async () => { await save({ ai: { apiKey: null } }, 'Key removed'); draw(); });
      }];
    },
    tracking() {
      const u = state.settings.utm;
      return [`<div class="card card-pad form"><h2>Link tracking (UTM)</h2>
        <p class="text-2">Automatically tag links in your posts so Google Analytics (or similar) shows which network sent the visit. <code>{network}</code> becomes x, linkedin, bluesky…</p>
        <label class="check"><span class="switch"><input type="checkbox" id="on" ${u.enabled ? 'checked' : ''}><span></span></span> Add UTM tags to links</label>
        <div class="grid-2"><label class="field">utm_source<input type="text" id="src" value="${esc(u.source)}"></label><label class="field">utm_medium<input type="text" id="med" value="${esc(u.medium)}"></label></div>
        <label class="field">utm_campaign <span class="hint">optional</span><input type="text" id="cmp" value="${esc(u.campaign)}"></label>
        <p class="hint">Example: <code id="ex"></code></p>
        <div><button class="btn primary" id="saveUtm">Save</button></div></div>`, () => {
        const ex = () => { const p = new URLSearchParams(Object.entries({ utm_source: $('#src').value.replace('{network}', 'linkedin'), utm_medium: $('#med').value.replace('{network}', 'linkedin'), utm_campaign: $('#cmp').value.replace('{network}', 'linkedin') }).filter(([, v]) => v)); $('#ex').textContent = `https://yoursite.com/page?${p}`; };
        $$('#src,#med,#cmp').forEach((i) => { i.oninput = ex; }); ex();
        $('#saveUtm').onclick = busy($('#saveUtm'), () => save({ utm: { enabled: $('#on').checked, source: $('#src').value, medium: $('#med').value, campaign: $('#cmp').value } }));
      }];
    },
    security() {
      return [`<form class="card card-pad form" id="pw"><h2>Change password</h2>
        <label class="field">Current password<input type="password" name="current" autocomplete="current-password" required></label>
        <label class="field">New password <span class="hint">at least 8 characters</span><input type="password" name="next" autocomplete="new-password" minlength="8" required></label>
        <div><button class="btn primary">Change password</button></div><p class="hint">You'll be signed out everywhere and asked to log in again.</p></form>`, () => {
        $('#pw').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.target); try { await api('/me/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } }); toast('Password changed — please log in again', 'ok'); setTimeout(() => location.reload(), 1200); } catch (err) { toast(err.message, 'bad'); } };
      }];
    },
    async team() {
      if (!state.user.is_admin) return ['<div class="card card-pad">Only the admin can manage users.</div>', () => {}];
      const users = await api('/users');
      return [`<div class="card card-pad form" style="max-width:none"><h2>Users</h2>
        <p class="text-2">Optional: give a friend their own login. Everyone only sees their own accounts, posts and settings.</p>
        <div class="list" style="margin:0 -20px">${users.map((u) => `<div class="item" style="grid-template-columns:minmax(0,1fr) auto"><div><b>${esc(u.email)}</b> ${u.is_admin ? '<span class="badge nodot">admin</span>' : ''}</div>${u.is_admin ? '' : `<button class="btn sm ghost danger" data-del="${u.id}">Remove</button>`}</div>`).join('')}</div>
        <div class="grid-2"><label class="field">Email<input type="email" id="em"></label><label class="field">Temporary password<input type="password" id="pw2" autocomplete="new-password"></label></div>
        <div><button class="btn primary" id="addU">${icon('plus')} Add user</button></div></div>`, () => {
        $('#addU').onclick = busy($('#addU'), async () => { await api('/users', { method: 'POST', body: { email: $('#em').value, password: $('#pw2').value, tz: state.user.tz } }); toast('User added', 'ok'); draw(); });
        $('#sbody').onclick = async (e) => { const b = e.target.closest('[data-del]'); if (b && await confirmBox('Remove this user and all their data?', { ok: 'Remove', danger: true })) { await api(`/users/${b.dataset.del}`, { method: 'DELETE' }); draw(); } };
      }];
    },
    data() {
      return [`<div class="card card-pad form"><h2>Backup & data</h2>
        <p class="text-2">Everything lives on your own server in <code>data/</code>: the database (<code>poster.db</code>), the encryption key (<code>secret.key</code>) and uploaded media. Back up the whole folder — without <code>secret.key</code> saved logins can't be decrypted.</p>
        <div class="row"><a class="btn" href="/api/export.csv" download>${icon('download')} Post history (CSV)</a><a class="btn" href="/api/export.json" download>${icon('download')} Everything (JSON)</a></div>
        <p class="hint">Bulk-schedule from a CSV under Posts → Import / export.</p></div>`, () => {}];
    },
  };

  async function draw() {
    history.replaceState(null, '', `#/settings?s=${sec}`);
    $('#snav', root).innerHTML = SECTIONS.filter(([k]) => k !== 'team' || state.user.is_admin).map(([k, l]) => `<a href="#/settings?s=${k}" data-s="${k}" class="${k === sec ? 'on' : ''}">${l}</a>`).join('');
    $('#sbody', root).onclick = null;
    const [html, bind] = await views[sec]();
    $('#sbody', root).innerHTML = html;
    bind();
  }
  $('#snav', root).onclick = (e) => { const a = e.target.closest('[data-s]'); if (a) { e.preventDefault(); sec = a.dataset.s; draw(); } };
  await draw();
}

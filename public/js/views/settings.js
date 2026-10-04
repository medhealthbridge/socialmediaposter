import { $, $$, api, state, refresh, esc, icon, fmt, toast, modal, busy, confirmBox, copyBox, avatar } from '../core.js';
import { appSetup } from './accounts.js';

const SECTIONS = [['general', 'General'], ['schedule', 'Scheduling'], ['integrations', 'Developer apps'], ['ai', 'AI assistant'], ['assistant', 'Assistant access'], ['tracking', 'Link tracking'], ['security', 'Password'], ['team', 'Users'], ['data', 'Backup & data']];
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
        <h2>General</h2>
        <label class="field">Your timezone<select id="tz">${tzs.map((t) => `<option ${t === state.user.tz ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label class="field">Failure alerts <span class="hint">send a message here when a post fails (Telegram or Discord work great)</span>
          <select id="alerts"><option value="">Off</option>${state.accounts.map((a) => `<option value="${a.id}" ${s.alertsAccountId === a.id ? 'selected' : ''}>${esc(a.name)} (${esc(state.providers[a.type]?.label)})</option>`).join('')}</select></label>
      </div>
      <div class="card card-pad form">
        <h2>Public address</h2>
        <p class="text-2">The address where this app is reachable, used for network login redirects${state.storage === 'blob' ? '' : ' and so Instagram/Threads can fetch your images'}. Instagram, Facebook and Threads need <b>https://</b>. On Vercel this is detected automatically.</p>
        <label class="field">Public URL<input type="url" id="pub" value="${esc(s.publicUrl)}" placeholder="${esc(s.effectiveUrl)}"></label>
        <p class="hint">Currently using: <code>${esc(s.effectiveUrl)}</code>${s.publicUrl ? '' : ' (detected from your browser)'}</p>
        <div><button class="btn primary" id="savePub">Save</button></div>
      </div>`, () => {
        $('#tz').onchange = async (e) => { await api('/me', { method: 'PUT', body: { tz: e.target.value } }); await refresh(); toast('Timezone saved', 'ok'); };
        $('#alerts').onchange = async (e) => save({ alertsAccountId: e.target.value || null });
        $('#savePub').onclick = busy($('#savePub'), async () => { await save({ publicUrl: $('#pub').value }); draw(); });
      }];
    },
    async schedule() {
      const { slots, next } = await api('/slots');
      const { url } = await api('/cron-url');
      const st = state.settings;
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return [`<div class="card card-pad form" style="max-width:none"><h2>Automatic publishing</h2>
        <p class="text-2">This app has no clock of its own, so a free timer service calls it for you. Paste the address below into one, set it to every 15 minutes, and scheduled posts go out on their own.</p>
        <label class="field">Your private timer address${copyBox(url)}</label>
        <div class="callout ${st.autoPublish ? '' : 'warn'}">${icon(st.autoPublish ? 'check' : 'alert')}<div>
          ${st.autoPublish ? `<b>Working.</b> Last automatic run ${esc(fmt.rel(st.lastCronAt))}.` : `<b>Not set up yet.</b> Scheduled posts will wait until you publish them by hand.`}
          <div class="small" style="margin-top:6px">Free options: <a href="https://cron-job.org" target="_blank" rel="noopener">cron-job.org</a> (easiest) · <a href="https://console.cron-job.org" target="_blank" rel="noopener">UptimeRobot</a> · Vercel Cron (add <code>CRON_SECRET</code> in Vercel, see the README).</div></div></div>
        <div class="row"><button class="btn" id="runNow">${icon('play')} Run now</button><span class="hint">Publishes anything that is already due, so you can check it works.</span></div>
      </div>

      <div class="card card-pad form" style="max-width:none"><h2>Weekly posting times</h2>
        <p class="text-2">Pick the times you like to post. Then “Next free time” in the composer drops a post into the next empty one (${esc(state.user.tz)}). Tip: Analytics shows when your posts do best.</p>
        <div class="slot-grid" id="slots"></div>
        <div class="row"><div class="row" id="dsel">${days.map((d, i) => `<button type="button" class="chip plain" data-d="${i}">${d}</button>`).join('')}</div>
          <input type="time" id="time" value="09:00" style="width:130px"><button class="btn primary" id="addSlot">${icon('plus')} Add time</button></div>
        <div class="row"><button class="btn sm ghost" id="preset">Use a starter schedule (weekdays 9:00, 12:30, 17:30)</button><span class="right muted small" id="nextSlot"></span></div>
      </div>`, () => {
        let current = slots.slice();
        const drawSlots = (nextAt) => {
          $('#slots').innerHTML = days.map((d, i) => `<div class="slot-row"><b class="small">${d}</b><div class="row">${current.filter((x) => x.dow === i).sort((a, b) => a.time.localeCompare(b.time)).map((x) => `<span class="slot">${x.time}<button data-del="${i}|${x.time}" aria-label="Remove">${icon('x')}</button></span>`).join('') || '<span class="muted small">—</span>'}</div></div>`).join('');
          $('#nextSlot').textContent = nextAt ? `Next free time: ${fmt.dateTime(nextAt)}` : '';
        };
        const put = async (nextSlots) => {
          const r = await api('/slots', { method: 'PUT', body: { slots: nextSlots } });
          current = r.slots; state.slots = r.slots; state.nextSlot = r.next; drawSlots(r.next);
        };
        drawSlots(next);
        $('#dsel').onclick = (e) => e.target.closest('.chip')?.classList.toggle('on');
        $('#slots').onclick = (e) => { const b = e.target.closest('[data-del]'); if (b) put(current.filter((x) => `${x.dow}|${x.time}` !== b.dataset.del)); };
        $('#addSlot').onclick = () => {
          const ds = $$('#dsel .on').map((c) => Number(c.dataset.d)); const t = $('#time').value;
          if (!ds.length || !t) return toast('Pick at least one day and a time');
          put([...current, ...ds.map((dow) => ({ dow, time: t }))]);
          $$('#dsel .on').forEach((c) => c.classList.remove('on'));
        };
        $('#preset').onclick = () => put([1, 2, 3, 4, 5].flatMap((dow) => ['09:00', '12:30', '17:30'].map((time) => ({ dow, time }))));
        $('#runNow').onclick = busy($('#runNow'), async () => {
          const r = await api('/run-due', { method: 'POST' });
          toast(r.due ? `Published ${r.due} due post${r.due > 1 ? 's' : ''}` : 'Nothing was due', 'ok');
        });
      }];
    },

    integrations() {
      const apps = Object.values(state.connectors).filter((c) => c.app);
      return [`<div class="card card-pad form" style="max-width:none"><h2>Developer apps</h2>
        <p class="text-2">X, LinkedIn, Facebook/Instagram and Threads only allow posting through an app you register with them (free, a few minutes, once). Bluesky, Mastodon, Telegram and Discord need nothing here.</p>
        <div class="list" style="margin:0 -20px">${apps.map((c) => { const a = state.settings.apps[c.id]; return `<div class="item" style="grid-template-columns:minmax(0,1fr) auto"><div><b>${esc(c.label)}</b> ${a.configured ? '<span class="badge ok">Ready</span>' : '<span class="badge draft">Not set up</span>'}<div class="muted small" style="margin-top:4px">Redirect URL: <code>${esc(a.redirectUri)}</code></div></div><button class="btn sm" data-app="${c.id}">${a.configured ? 'Edit' : 'Set up'}</button></div>`; }).join('')}</div></div>`,
      () => { $('#sbody').onclick = async (e) => { const b = e.target.closest('[data-app]'); if (b && await appSetup(b.dataset.app)) { toast('Saved — now connect accounts from the Accounts page', 'ok'); draw(); } }; }];
    },
    async ai() {
      const ai = state.settings.ai;
      const spec = state.aiProviders[ai.provider];
      const hasKey = ai.hasKey[ai.provider];
      let models = spec.models || [];
      if (hasKey && !models.length) {
        try { models = await api('/ai/models'); } catch { models = [{ id: ai.model, label: ai.model }]; }
      }
      return [`<div class="card card-pad form"><h2>${icon('sparkle')} AI assistant</h2>
        <p class="text-2">Write, improve, shorten, add hashtags, change tone and adapt posts per network. You bring your own key, so you pay the provider directly (or nothing at all on Gemini's free tier).</p>
        <label class="field">Provider<select id="prov">${Object.values(state.aiProviders).map((p) => `<option value="${p.id}" ${p.id === ai.provider ? 'selected' : ''}>${esc(p.label)} — ${esc(p.note)}</option>`).join('')}</select></label>
        <label class="field">${esc(spec.label)} API key <span class="hint">${esc(spec.keyHint)} — <a href="${esc(spec.keyUrl)}" target="_blank" rel="noopener">get one</a>. Stored encrypted.</span>
          <input type="password" id="key" placeholder="${hasKey ? '•••••••• (saved)' : spec.id === 'gemini' ? 'AIza…' : 'sk-ant-…'}" autocomplete="off"></label>
        ${models.length ? `<label class="field">Model<select id="model">${models.map((m) => `<option value="${esc(m.id)}" ${ai.model === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
          ${spec.id === 'gemini' ? '<span class="hint">Flash models are the free ones. The list comes straight from Google, so it is always current.</span>' : ''}</label>` : `<p class="hint">Save your key to load the list of models.</p>`}
        <div class="row"><button class="btn primary" id="saveAi">Save</button>${hasKey ? `<button class="btn ghost" id="refreshModels">${icon('retry')} Refresh models</button><button class="btn ghost danger" id="rmKey">Remove key</button>` : ''}</div></div>`, () => {
        $('#prov').onchange = busy($('#prov'), async () => { await save({ ai: { provider: $('#prov').value } }); draw(); });
        $('#saveAi').onclick = busy($('#saveAi'), async () => {
          await save({ ai: { provider: $('#prov').value, apiKey: $('#key').value || undefined, model: $('#model')?.value } });
          draw();
        });
        $('#refreshModels')?.addEventListener('click', () => draw());
        $('#rmKey')?.addEventListener('click', async () => { await save({ ai: { apiKey: null } }, 'Key removed'); draw(); });
      }];
    },

    async assistant() {
      const keys = await api('/keys');
      const url = state.mcpUrl || `${location.origin}/mcp`;
      return [`<div class="card card-pad form" style="max-width:none"><h2>${icon('sparkle')} Assistant access</h2>
        <p class="text-2">Let an AI assistant (like Claude) use Social Poster for you: “draft three posts about X and queue them”, “what did best last month?”. Create a key, then add this address as a custom connector in Claude.</p>
        <label class="field">Connector URL${copyBox(url)}</label>
        <div class="list" style="margin:0 -20px">${keys.length ? keys.map((k) => `<div class="item" style="grid-template-columns:minmax(0,1fr) auto"><div><b>${esc(k.name)}</b><div class="muted small">created ${fmt.date(k.created_at)}</div></div><button class="btn sm ghost danger" data-del="${esc(k.id)}">Remove</button></div>`).join('') : '<div class="item"><span class="muted">No keys yet.</span></div>'}</div>
        <div class="row"><input type="text" id="kname" placeholder="What is it for? e.g. Claude" style="max-width:260px"><button class="btn primary" id="newkey">${icon('plus')} Create key</button></div>
        <p class="hint">A key can read and write your posts and publish them. Remove it here if you stop using it.</p>
        <div class="callout">${icon('info')}<div><b>In Claude:</b> Settings → Connectors → Add custom connector → paste the URL above. If it asks for a key, paste the one you created. (You can also add <code>?key=YOUR_KEY</code> to the end of the URL.)</div></div>
      </div>`, () => {
        $('#newkey').onclick = busy($('#newkey'), async () => {
          const k = await api('/keys', { method: 'POST', body: { name: $('#kname').value } });
          modal({ title: 'Your new key', body: `<p class="text-2">Copy it now — it is not shown again.</p>${copyBox(k.secret)}
            <label class="field">Or use this full URL${copyBox(`${url}?key=${k.secret}`)}</label>`, actions: [{ label: 'Done', kind: 'primary' }] });
          draw();
        });
        $('#sbody').onclick = async (e) => {
          const b = e.target.closest('[data-del]');
          if (b && await confirmBox('Remove this key? Anything using it stops working.', { ok: 'Remove', danger: true })) { await api(`/keys/${b.dataset.del}`, { method: 'DELETE' }); draw(); }
        };
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
        <p class="text-2">${state.storage === 'blob' ? 'Your data lives in your Postgres database and media in Vercel Blob. Keep your <code>SECRET_KEY</code> environment variable safe — without it saved logins can’t be decrypted.' : 'Everything lives in <code>data/</code>: the database (<code>poster.db</code>), the encryption key (<code>secret.key</code>) and uploaded media. Back up the whole folder — without <code>secret.key</code> saved logins can’t be decrypted.'}</p>
        <div class="row"><a class="btn" href="/api/export.csv" download>${icon('download')} Post history (CSV)</a><a class="btn" href="/api/export.json" download>${icon('download')} Everything (JSON)</a></div>
        <p class="hint">Add many posts from a CSV under Queue → Import / export.</p></div>`, () => {}];
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

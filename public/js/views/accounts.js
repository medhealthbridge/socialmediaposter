import { $, $$, api, state, refresh, esc, icon, avatar, netMark, netLabel, statusBadge, toast, modal, busy, confirmBox, copyBox, params } from '../core.js';

const DESCRIBE = {
  x: 'Posts, images, video', instagram: 'Business/Creator accounts', facebook: 'Pages you manage', tiktok: 'Videos & photo posts',
  youtube: 'Video uploads', linkedin: 'Your personal profile', pinterest: 'Pins — one account per board',
  threads: 'Posts & carousels', bluesky: 'App password — 1 minute', mastodon: 'Any server, one click', telegram: 'Channels & groups via a bot',
  discord: 'Channel webhooks', webhook: 'Zapier, Make, n8n…', mock: 'Dry run — nothing is posted',
};
const ORDER = ['x', 'instagram', 'facebook', 'tiktok', 'youtube', 'linkedin', 'pinterest', 'threads', 'bluesky', 'mastodon', 'telegram', 'discord', 'webhook', 'mock'];

/** Developer-app setup dialog (X, LinkedIn, Meta, Threads). Resolves true when saved. */
export function appSetup(connectorId, { thenConnect = false } = {}) {
  const c = state.connectors[connectorId];
  const cur = state.settings.apps[connectorId] || {};
  const https = state.settings.effectiveUrl.startsWith('https://');
  const needsHttps = ['meta', 'threads'].includes(connectorId);
  return new Promise((resolve) => {
    let saved = false;
    const m = modal({ title: `Set up ${esc(c.label)}`, wide: true, body: `
      <p class="text-2">${esc(c.label)} only lets apps post after you register your own (free) developer app. You do this once; afterwards connecting is a single click.</p>
      ${needsHttps && !https ? `<div class="callout warn">${icon('alert')}<div>${esc(c.label)} requires an <b>https://</b> address. Put Social Poster behind HTTPS (e.g. a domain with Caddy, or a Cloudflare Tunnel) and set it in <a href="#/settings?s=general">Settings → General</a> first.</div></div>` : ''}
      <ol class="steps">${c.app.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <label class="field">Callback / redirect URL <span class="hint">paste this into the developer portal</span>${copyBox(cur.redirectUri)}</label>
      <a class="btn sm" href="${esc(c.app.docs)}" target="_blank" rel="noopener" style="justify-self:start">${icon('ext')} Open developer portal</a>
      <div class="grid-2">${c.app.fields.map((f) => `<label class="field">${esc(f.label)}<input type="${f.secret ? 'password' : 'text'}" data-k="${f.key}" value="${esc(cur[f.key] || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off"></label>`).join('')}</div>`,
      actions: [{ label: 'Cancel' }, { label: thenConnect ? 'Save & connect' : 'Save', kind: 'primary', onClick: async (d) => {
        const vals = Object.fromEntries($$('input[data-k]', d).map((i) => [i.dataset.k, i.value]));
        for (const f of c.app.fields) if (!f.optional && !vals[f.key]) throw new Error(`${f.label} is required`);
        state.settings = await api('/settings', { method: 'PUT', body: { apps: { [connectorId]: vals } } });
        saved = true;
      } }] });
    m.el.addEventListener('close', () => resolve(saved));
  });
}

export async function connect(connectorId, input = {}) {
  try {
    const { url } = await api(`/connect/${connectorId}`, { method: 'POST', body: input });
    location.href = url;
  } catch (e) {
    if (e.data?.needsSetup) { if (await appSetup(connectorId, { thenConnect: true })) return connect(connectorId, input); return; }
    throw e;
  }
}

function formDialog(type, existing) {
  const p = state.providers[type];
  modal({ title: `Connect ${esc(p.label)}`, body: `
    ${type === 'mock' ? '<p class="text-2">A pretend account for trying things out. Posts are only written to the server log.</p>' : ''}
    ${type === 'bluesky' ? `<div class="callout">${icon('info')}<div>Create an app password in Bluesky: <b>Settings → Privacy and security → App passwords</b>. Never use your main password.</div></div>` : ''}
    ${type === 'telegram' ? `<div class="callout">${icon('info')}<div>Message <b>@BotFather</b> on Telegram → /newbot to get a token, then add the bot as an admin of your channel or group.</div></div>` : ''}
    <label class="field">Display name <span class="hint">optional</span><input type="text" id="accName" placeholder="Shown in the composer"></label>
    ${p.fields.map((f) => `<label class="field">${esc(f.label)}${f.optional ? ' <span class="hint">optional</span>' : ''}<input type="${f.secret ? 'password' : 'text'}" data-k="${f.key}" placeholder="${esc(f.placeholder || '')}" autocomplete="off"></label>`).join('')}`,
    actions: [{ label: 'Cancel' }, { label: 'Connect', kind: 'primary', onClick: async (d) => {
      const config = Object.fromEntries($$('input[data-k]', d).map((i) => [i.dataset.k, i.value.trim()]));
      const a = await api('/accounts', { method: 'POST', body: { type, name: $('#accName', d).value.trim(), config } });
      if (existing) await api(`/accounts/${existing.id}`, { method: 'DELETE' });
      await refresh(); toast(`${a.name} connected`, 'ok'); rerender();
    } }],
    onOpen: (d) => d.querySelector('input[data-k]')?.focus() ?? $('#accName', d).focus() });
}

function mastodonDialog() {
  modal({ title: 'Connect Mastodon', body: `<label class="field">Your server<input type="text" id="inst" placeholder="mastodon.social" autocomplete="off"></label>
    <p class="text-2 small">You'll log in on your server and approve access. No developer setup needed.</p>
    <a href="#" id="manual" class="small">Use an access token instead</a>`,
    actions: [{ label: 'Cancel' }, { label: 'Continue', kind: 'primary', onClick: async (d) => { await connect('mastodon', { instance: $('#inst', d).value }); return false; } }],
    onOpen: (d, close) => { $('#inst', d).focus(); $('#manual', d).onclick = (e) => { e.preventDefault(); close(); formDialog('mastodon'); }; } });
}

function startConnect(type) {
  const p = state.providers[type];
  if (type === 'mastodon') return mastodonDialog();
  if (p.connector) return connect(p.connector).catch((e) => toast(e.message, 'bad'));
  return formDialog(type);
}

/** Provider-specific per-account choices (TikTok privacy, YouTube visibility). */
export async function postSettings(account, after) {
  let opts;
  try { opts = await api(`/accounts/${account.id}/options`); }
  catch (e) { return toast(e.message, 'bad'); }
  if (!opts.length) return toast('This account has no extra settings');
  modal({
    title: `${esc(account.name)} — post settings`,
    body: opts.map((o) => `<label class="field">${esc(o.label)}${o.hint ? `<span class="hint">${esc(o.hint)}</span>` : ''}
      <select data-k="${esc(o.key)}">
        <option value="" ${o.value ? '' : 'selected'} disabled>Choose…</option>
        ${o.choices.map((c) => `<option value="${esc(c.value)}" ${c.value === o.value ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
      </select></label>`).join(''),
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async (d) => {
      for (const sel of $$('select[data-k]', d)) {
        if (!sel.value) throw new Error('Pick an option first');
        await api(`/accounts/${account.id}/options`, { method: 'POST', body: { key: sel.dataset.k, value: sel.value } });
      }
      toast('Saved', 'ok');
      await refresh();
      after?.();
    } }],
  });
}

let rerender = () => {};

/**
 * Put one account into groups. Groups are just names you type — the ones already in use are
 * offered so a category stays one group rather than three near-identical spellings.
 */
function groupDialog(acc, after) {
  const chosen = new Set(acc.groups || []);
  const draw = (d) => {
    const all = [...new Set([...(state.groups || []), ...chosen])].sort((a, b) => a.localeCompare(b));
    $('#gopts', d).innerHTML = all.length
      ? all.map((g) => `<button type="button" class="chip plain ${chosen.has(g) ? 'on' : ''}" data-g="${esc(g)}">${esc(g)}</button>`).join('')
      : '<span class="muted small">No groups yet — type one below.</span>';
  };
  modal({
    title: `Groups for ${esc(acc.name)}`,
    body: `<p class="text-2 small">Group your accounts by whatever they have in common — a topic, a brand, a language. In the composer one click then picks the whole group.</p>
      <div class="row" id="gopts"></div>
      <label class="field">Add a group<div class="row"><input type="text" id="gnew" class="grow" placeholder="Animals" maxlength="40"><button type="button" class="btn" id="gadd">Add</button></div></label>`,
    actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async () => {
      await api(`/accounts/${acc.id}`, { method: 'PATCH', body: { groups: [...chosen] } });
      await refresh(); after(); toast('Groups saved', 'ok');
    } }],
    onOpen: (d) => {
      draw(d);
      $('#gopts', d).onclick = (e) => { const b = e.target.closest('[data-g]'); if (!b) return; chosen.has(b.dataset.g) ? chosen.delete(b.dataset.g) : chosen.add(b.dataset.g); draw(d); };
      const add = () => { const v = $('#gnew', d).value.trim(); if (!v) return; chosen.add(v); $('#gnew', d).value = ''; draw(d); };
      $('#gadd', d).onclick = add;
      $('#gnew', d).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
      $('#gnew', d).focus();
    },
  });
}

export async function render(root) {
  const qs = params();
  if (qs.get('connected')) { toast(`Connected: ${qs.get('connected')}`, 'ok'); history.replaceState(null, '', '#/accounts'); await refresh(); }
  if (qs.get('error')) { toast(qs.get('error'), 'bad'); history.replaceState(null, '', '#/accounts'); }
  rerender = () => render(root);
  const accs = state.accounts;
  root.innerHTML = `<div class="page">
    <div class="page-head"><div class="grow"><h1>Accounts</h1><p class="sub">Connect the profiles, pages and channels you post to.</p></div></div>
    ${accs.length ? `<div class="grid-auto" id="accs">${accs.map((a) => `
      <div class="card acct" data-id="${a.id}">
        <div class="acct-top">${avatar(a, 'lg')}<div class="grow" style="min-width:0"><div class="bold ellipsis">${esc(a.name)}</div><div class="muted small ellipsis">${esc(a.handle || netLabel(a.type))}</div></div></div>
        <div class="row">${statusBadge(a.status)}<span class="muted small">${esc(netLabel(a.type))}</span>${a.profile_url ? `<a class="small right" href="${esc(a.profile_url)}" target="_blank" rel="noopener">Profile ${icon('ext')}</a>` : ''}</div>
        <div class="row tags">${(a.groups || []).map((g) => `<span class="tag">${esc(g)}</span>`).join('')}
          <button class="btn sm ghost tiny" data-act="groups">${(a.groups || []).length ? 'Edit groups' : '+ Add to a group'}</button></div>
        ${a.last_error && a.status !== 'ok' ? `<div class="err">${esc(a.last_error)}</div>` : ''}
        ${a.needs_setup ? `<div class="callout warn">${icon('alert')}<div>Choose who can see posts from this account before posting.</div></div>` : ''}
        <div class="row">
          ${a.needs_setup ? `<button class="btn sm primary" data-act="settings">${icon('settings')} Finish setup</button>` : ''}
          ${a.status !== 'ok' ? `<button class="btn sm primary" data-act="reconnect">${icon('retry')} Reconnect</button>` : ''}
          <button class="btn sm" data-act="check">Check</button>
          <button class="btn sm ghost" data-act="more" aria-label="More">⋯</button>
        </div>
      </div>`).join('')}</div>` : `<div class="card"><div class="empty">${icon('users')}<b>Connect your first account</b><span>Pick a network below. Try the “Test account” if you just want to explore.</span></div></div>`}
    <div><h2 style="margin-bottom:12px">Add an account</h2><div class="grid-auto" id="nets">${ORDER.filter((t) => state.providers[t]).map((t) => `
      <button class="net-tile" data-type="${t}">${netMark(t, 'lg')}<div class="grow" style="min-width:0"><div class="bold">${esc(netLabel(t))}</div><div class="desc">${esc(DESCRIBE[t] || '')}</div></div>${state.providers[t].connector && state.connectors[state.providers[t].connector]?.app && !state.settings.apps[state.providers[t].connector]?.configured ? '<span class="badge nodot" data-tip="One-time developer app setup">setup</span>' : ''}</button>`).join('')}</div></div>
  </div>`;

  $('#nets', root).onclick = (e) => { const t = e.target.closest('[data-type]'); if (t) startConnect(t.dataset.type); };
  $('#accs', root)?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = state.accounts.find((x) => x.id === Number(b.closest('[data-id]').dataset.id));
    const p = state.providers[a.type];
    const reconnect = () => (a.type === 'mastodon' && !a.fields.token ? mastodonDialog() : p.connector && !(a.type === 'mastodon' && a.fields.token) ? connect(p.connector).catch((err) => toast(err.message, 'bad')) : formDialog(a.type, a));
    if (b.dataset.act === 'reconnect') return reconnect();
    if (b.dataset.act === 'settings') return postSettings(a, rerender);
    if (b.dataset.act === 'groups') return groupDialog(a, rerender);
    if (b.dataset.act === 'check') return busy(b, async () => { const r = await api(`/accounts/${a.id}/check`, { method: 'POST' }); toast(r.message, r.ok ? 'ok' : 'bad'); await refresh(); rerender(); })();
    if (b.dataset.act === 'more') {
      const { menu } = await import('../core.js');
      menu(b, [
        { label: 'Rename', icon: 'edit', onClick: () => modal({ title: 'Rename account', body: `<input type="text" id="nm" value="${esc(a.name)}">`, actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async (d) => { await api(`/accounts/${a.id}`, { method: 'PATCH', body: { name: $('#nm', d).value } }); await refresh(); rerender(); } }], onOpen: (d) => $('#nm', d).select() }) },
        ...(state.providers[a.type]?.options ? [{ label: 'Post settings…', icon: 'settings', onClick: () => postSettings(a, rerender) }] : []),
        { label: 'Send a test post', icon: 'send', onClick: async () => { if (!(await confirmBox(`This publishes a short test post to ${a.name}.`, { ok: 'Send test' }))) return; try { const r = await api(`/accounts/${a.id}/test-post`, { method: 'POST' }); toast('Test post sent', 'ok'); if (r.url) window.open(r.url, '_blank', 'noopener'); } catch (err) { toast(err.message, 'bad'); } await refresh(); rerender(); } },
        { label: 'Reconnect / update login', icon: 'retry', onClick: reconnect },
        'sep',
        { label: 'Remove account', icon: 'trash', onClick: async () => { if (!(await confirmBox(`Remove ${a.name}? It is removed from queued posts. Nothing is deleted on ${netLabel(a.type)}.`, { ok: 'Remove', danger: true }))) return; await api(`/accounts/${a.id}`, { method: 'DELETE' }); await refresh(); rerender(); } },
      ]);
    }
  });
}

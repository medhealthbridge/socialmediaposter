import { $, $$, api, state, refresh, refreshCounts, icon, esc, toast, toastError, initTooltips, params } from './core.js';

const VIEWS = {
  compose: { label: 'Create post', icon: 'compose', load: () => import('./views/compose.js') },
  queue: { label: 'Queue', icon: 'queue', load: () => import('./views/posts.js') },
  agent: { label: 'Agent', icon: 'sparkle', load: () => import('./views/agent.js') },
  log: { label: 'Activity', icon: 'list', load: () => import('./views/log.js') },
  analytics: { label: 'Analytics', icon: 'chart', load: () => import('./views/analytics.js') },
  accounts: { label: 'Accounts', icon: 'users', load: () => import('./views/accounts.js') },
  library: { label: 'Library', icon: 'image', load: () => import('./views/library.js') },
  drive: { label: 'Google Drive', icon: 'download', load: () => import('./views/drive.js') },
  feeds: { label: 'RSS autopilot', icon: 'rss', load: () => import('./views/feeds.js') },
  settings: { label: 'Settings', icon: 'settings', load: () => import('./views/settings.js') },
};
const NAV = ['queue', 'agent', 'analytics', 'accounts', 'library', 'drive', 'feeds', 'log', 'settings'];

let current = null;

function authScreen(needsSetup) {
  $('#app').innerHTML = `<div class="auth"><form class="card" id="auth">
    <img class="logo" src="/icon.svg" alt="">
    <div><h1>${needsSetup ? 'Welcome to Social Poster' : 'Log in'}</h1>
    <p class="text-2" style="margin-top:4px">${needsSetup ? 'Create your account. You can connect your social networks right after.' : 'Plan, schedule and publish everywhere.'}</p></div>
    <label class="field">Email<input type="email" name="email" autocomplete="username" required></label>
    <label class="field">Password${needsSetup ? ' <span class="hint">at least 8 characters</span>' : ''}<input type="password" name="password" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" required minlength="${needsSetup ? 8 : 1}"></label>
    <button class="btn primary block">${needsSetup ? 'Create account' : 'Log in'}</button>
  </form></div>`;
  $('#auth').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#auth button'); btn.classList.add('loading');
    const f = new FormData(e.target);
    try {
      await api(needsSetup ? '/auth/signup' : '/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password'), tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      await start();
    } catch (err) { toastError(err); } finally { btn.classList.remove('loading'); }
  };
  $('#auth input').focus();
}

function shell() {
  $('#app').innerHTML = `<div class="shell" id="shell">
    <aside class="side" aria-label="Main">
      <div class="brand"><img src="/icon.svg" alt="">Social Poster</div>
      <a class="btn primary compose-btn" href="#/compose">${icon('plus')} Create post</a>
      <nav class="nav" id="nav">${NAV.map((k) => `<a href="#/${k}" data-k="${k}">${icon(VIEWS[k].icon)}<span>${VIEWS[k].label}</span></a>`).join('')}</nav>
      <div class="side-foot">
        <div class="who" title="${esc(state.user.email)}">${esc(state.user.email)}</div>
        <div class="row"><button class="btn sm ghost" id="theme" data-tip="Light / dark / auto">${icon('moon')} Theme</button><button class="btn sm ghost" id="logout">${icon('logout')} Log out</button></div>
      </div>
    </aside>
    <div class="grow" style="min-width:0">
      <div class="topbar"><button class="btn icon ghost" id="menuBtn" aria-label="Menu">${icon('menu')}</button><b>Social Poster</b><a class="btn sm primary right" href="#/compose">${icon('plus')} Post</a></div>
      <main class="main" id="main"></main>
    </div>
  </div>`;
  $('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); location.hash = ''; start(); };
  $('#menuBtn').onclick = (e) => { e.stopPropagation(); $('#shell').classList.toggle('menu'); };
  $('#main').addEventListener('click', () => $('#shell').classList.remove('menu'));
  $('#theme').onclick = () => {
    const order = ['auto', 'light', 'dark'];
    let cur; try { cur = localStorage.getItem('theme') || 'auto'; } catch { cur = 'auto'; }
    const next = order[(order.indexOf(cur) + 1) % 3];
    try { next === 'auto' ? localStorage.removeItem('theme') : localStorage.setItem('theme', next); } catch { /* storage blocked */ }
    if (next === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
    toast(`Theme: ${next}`);
  };
  updateBadges();
}

function updateBadges() {
  const badge = (k, n, title, cls = '') => {
    const link = $(`#nav a[data-k="${k}"]`);
    if (!link) return;
    link.querySelector('.count')?.remove();
    if (n) link.insertAdjacentHTML('beforeend', `<span class="count ${cls}" title="${title}">${n}</span>`);
  };
  badge('accounts', state.accounts.filter((a) => a.status !== 'ok').length, 'Needs attention');
  const c = state.counts || {};
  badge('queue', c.failed || c.queued, c.failed ? 'Failed posts' : 'Waiting in the queue', c.failed ? '' : 'neutral');
}

/** RSS feeds are checked whenever the app is opened — no background server needed. */
async function checkFeeds() {
  try {
    const r = await api('/feeds/check-due', { method: 'POST' });
    if (r.created) { toast(`RSS: ${r.created} new item${r.created > 1 ? 's' : ''} added`, 'ok'); await refreshCounts(); if (/^#\/queue/.test(location.hash) || location.hash === '' || location.hash === '#/') route(); }
  } catch { /* offline or not logged in */ }
}

async function route() {
  if (!state.user) return;
  const name = (location.hash.slice(2).split('?')[0] || '').split('/')[0];
  const key = VIEWS[name] ? name : name === 'posts' ? 'queue' : state.accounts.length ? 'queue' : 'accounts';
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.k === key));
  $('#shell')?.classList.remove('menu');
  current?.cleanup?.();
  const main = $('#main');
  const token = Symbol();
  route.token = token;
  // Each view gets its own box to draw in, and leaving a view takes the box away with it.
  // A request that was already in flight then writes into something nobody can see, instead
  // of into whatever happens to be on screen by the time it comes back.
  const host = document.createElement('div');
  try {
    const mod = await VIEWS[key].load();
    if (route.token !== token) return;
    main.replaceChildren(host);
    current = (await mod.render(host, params())) || null;
    if (route.token !== token) return;
    document.title = `${VIEWS[key].label} · Social Poster`;
  } catch (e) {
    if (route.token !== token) return;   // we have already moved on; the error is stale too
    console.error(e);
    host.innerHTML = `<div class="page"><div class="card card-pad"><h2>Something went wrong</h2><p class="text-2">${esc(e.message)}</p></div></div>`;
  }
}

async function start() {
  try {
    const st = await api('/auth/status');
    if (!st.user) return authScreen(st.needsSetup);
    await refresh();
    shell();
    route();
    checkFeeds();
  } catch (e) {
    $('#app').innerHTML = `<div class="boot">Could not reach the server. ${esc(e.message)}</div>`;
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('logged-out', () => { state.user = null; authScreen(false); });
window.addEventListener('state', updateBadges);
initTooltips();
start();

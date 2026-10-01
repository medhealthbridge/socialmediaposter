// Shared helpers for every view.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** App-wide state loaded from /api/bootstrap. */
export const state = { user: null, providers: {}, connectors: {}, accounts: [], settings: {}, snippets: [], aiModels: [], counts: { queued: 0, failed: 0, published: 0 }, storage: 'disk' };

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

export async function api(path, { method = 'GET', body, raw, headers = {}, onProgress } = {}) {
  if (raw && onProgress) return upload(path, raw, headers, onProgress);
  const res = await fetch('/api' + path, {
    method,
    headers: raw ? headers : body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) { window.dispatchEvent(new Event('logged-out')); throw new ApiError('Please log in again', 401, data); }
  if (!res.ok) throw new ApiError(data.error || res.statusText, res.status, data);
  return data;
}

function upload(path, file, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api' + path);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let d = {}; try { d = JSON.parse(x.responseText); } catch { /* empty */ }
      x.status < 300 ? resolve(d) : reject(new ApiError(d.error || 'Upload failed', x.status, d));
    };
    x.onerror = () => reject(new ApiError('Upload failed — check your connection', 0));
    x.send(file);
  });
}

/**
 * Upload a photo/video to the media library. On Vercel the browser sends the file straight to
 * Vercel Blob (no size limit from the serverless function); otherwise it goes to this server.
 */
export async function uploadFile(file, onProgress = () => {}) {
  if (state.storage === 'blob') {
    const { upload } = await import('/vendor/blob-upload.js');
    const safe = (file.name || 'upload').replace(/[^\w.-]+/g, '_').slice(-80);
    const b = await upload(`u${state.user.id}/${safe}`, file, {
      access: 'public', handleUploadUrl: '/api/media/blob-token', contentType: file.type || undefined,
      multipart: file.size > 20 * 1024 * 1024, onUploadProgress: (p) => onProgress(p.percentage / 100),
    });
    return api('/media/register', { method: 'POST', body: { url: b.url, filename: file.name } });
  }
  return api('/media', { raw: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name || 'upload') }, onProgress });
}

export async function refreshCounts() {
  try { state.counts = await api('/counts'); window.dispatchEvent(new Event('state')); } catch { /* ignore */ }
}

export async function refresh() {
  Object.assign(state, await api('/bootstrap'));
  window.dispatchEvent(new Event('state'));
}

// ---------- formatting (always in the user's chosen timezone)
const tz = () => state.user?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
export const fmt = {
  dateTime: (iso) => (iso ? new Date(iso).toLocaleString(undefined, { timeZone: tz(), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'),
  date: (iso) => new Date(iso).toLocaleDateString(undefined, { timeZone: tz(), month: 'short', day: 'numeric', year: 'numeric' }),
  time: (iso) => new Date(iso).toLocaleTimeString(undefined, { timeZone: tz(), hour: 'numeric', minute: '2-digit' }),
  num: (n) => (n == null ? '—' : Intl.NumberFormat(undefined, { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n)),
  pct: (n) => (n == null ? '—' : `${Math.round(n * 100)}%`),
  rel(iso) {
    const d = (new Date(iso) - Date.now()) / 1000, a = Math.abs(d);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    if (a < 60) return d < 0 ? 'just now' : 'in a moment';
    if (a < 3600) return rtf.format(Math.round(d / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(d / 3600), 'hour');
    return rtf.format(Math.round(d / 86400), 'day');
  },
  bytes: (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`),
};
/** Wall-clock parts of an instant in the user's timezone. */
export function zoned(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, key: `${p.year}-${p.month}-${p.day}`, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
/** Instant for a wall-clock time in the user's timezone. */
export function fromZoned(y, m, d, h, mi) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = (t) => { const z = zoned(new Date(t).toISOString()); return Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi) - Math.floor(t / 60000) * 60000; };
  let t = guess - off(guess); t = guess - off(t);
  return new Date(t);
}
export const toLocalInput = (iso) => { if (!iso) return ''; const z = zoned(iso); return `${z.key}T${String(z.h).padStart(2, '0')}:${String(z.mi).padStart(2, '0')}`; };
export const fromLocalInput = (v) => { if (!v) return null; const [d, t] = v.split('T'); const [y, m, dd] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return fromZoned(y, m, dd, h, mi).toISOString(); };

// ---------- icons (inline SVG, stroke-based)
const P = {
  compose: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 16v-4M12 16V8M17 16v-7"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  rss: '<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  queue: '<path d="M3 6h18M3 12h12M3 18h8"/><path d="m17 15 4 3-4 3"/>',
  draft: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  edit: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4h6v2"/>',
  retry: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>',
  repost: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  reply: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  chevL: '<path d="m15 18-6-6 6-6"/>', chevR: '<path d="m9 18 6-6-6-6"/>', chevD: '<path d="m6 9 6 6 6-6"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play: '<path d="m6 3 14 9-14 9Z"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  ext: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  recycle: '<path d="M7 19H4.8a1.8 1.8 0 0 1-1.6-2.7L5 13M11 19h8.2a1.8 1.8 0 0 0 1.6-2.7L19 13M14 16l-3 3 3 3M8.3 13.4 5 13l-.6 3.3M9.3 5.2 11 2.4a1.8 1.8 0 0 1 3 0l1.6 2.8M15 2.5l1 3.5-3.5.9"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
};
export const icon = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ''}</svg>`;

// ---------- networks & avatars
const LETTER = { x: 'X', instagram: 'IG', facebook: 'f', linkedin: 'in', threads: '@', bluesky: 'b', mastodon: 'M', telegram: 'T', discord: 'D', webhook: '⚡', mock: '✓' };
export const netColor = (type) => state.providers[type]?.color || '#888';
export const netLabel = (type) => state.providers[type]?.label || type;
export const netMark = (type, cls = '') => `<span class="netmark ${cls}" style="background:${netColor(type)}" title="${esc(netLabel(type))}">${LETTER[type] || '?'}</span>`;
export function avatar(acc, size = '') {
  const initials = esc((acc.name || '?').trim().slice(0, 1).toUpperCase());
  const img = acc.avatar
    ? `<img class="img" src="${esc(acc.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="${initials}" data-color="${netColor(acc.type)}">`
    : `<span class="img" style="background:${netColor(acc.type)}">${initials}</span>`;
  return `<span class="av ${size}">${img}<span class="net" style="background:${netColor(acc.type)}">${LETTER[acc.type] || ''}</span></span>`;
}
export const accountById = (id) => state.accounts.find((a) => a.id === Number(id));

export function statusBadge(s) {
  const label = { queued: 'In queue', draft: 'Draft', scheduled: 'Scheduled', publishing: 'Publishing…', published: 'Published', partial: 'Partly failed', failed: 'Failed', pending: 'Pending', ok: 'Connected', reauth: 'Reconnect needed', error: 'Error' }[s] || s;
  return `<span class="badge ${s}">${label}</span>`;
}

/** Character count per network, mirroring the server rules (links count as 23 on X/Mastodon). */
const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/g;
const seg = 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const graphemes = (t) => (seg ? [...seg.segment(t)].length : [...t].length);
export function countFor(type, text) {
  if (type === 'x' || type === 'mastodon') return graphemes(text.replace(URL_RE, 'x'.repeat(23)));
  if (type === 'bluesky' || type === 'threads') return graphemes(text);
  return [...text].length;
}
/** Highlight links/hashtags/mentions and mark the overflow past `limit`. */
export function richText(text, limit) {
  let cut = '';
  if (limit && [...text].length > limit) { const cs = [...text]; cut = cs.slice(limit).join(''); text = cs.slice(0, limit).join(''); }
  const fmtd = esc(text).replace(/https?:\/\/[^\s<]+/g, (u) => `<span class="lnk">${u}</span>`).replace(/(^|\s)([#@][\p{L}\p{N}_.]+)/gu, '$1<span class="tag">$2</span>');
  return fmtd + (cut ? `<span class="cut">${esc(cut)}</span>` : '');
}

// ---------- UI primitives
export function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.innerHTML = `${kind === 'ok' ? icon('check') : kind === 'bad' ? icon('alert') : ''}<span>${esc(msg)}</span>`;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3500);
}
export const toastError = (e) => toast(e.message || String(e), 'bad');

/** Wrap an async click handler: spinner on the button, errors become toasts. */
export function busy(btn, fn) {
  return async (...a) => {
    if (btn.classList.contains('loading')) return;
    btn.classList.add('loading');
    try { return await fn(...a); } catch (e) { toastError(e); } finally { btn.classList.remove('loading'); }
  };
}

export function modal({ title, body = '', actions = [], wide = false, onOpen } = {}) {
  const d = document.createElement('dialog');
  d.className = `modal ${wide ? 'wide' : ''}`;
  d.innerHTML = `<div class="modal-in"><div class="modal-head"><h2 class="grow">${title}</h2><button class="btn ghost icon sm" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body">${body}</div>${actions.length ? `<div class="modal-foot">${actions.map((a, i) => `<button class="btn ${a.kind || ''}" data-i="${i}">${a.label}</button>`).join('')}</div>` : ''}</div>`;
  document.body.append(d);
  const close = () => { d.close(); d.remove(); };
  d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) close(); });
  d.addEventListener('cancel', () => d.remove());
  $$('.modal-foot .btn', d).forEach((b) => {
    const a = actions[b.dataset.i];
    b.onclick = a.onClick ? busy(b, async () => { if ((await a.onClick(d, close)) !== false) close(); }) : close;
  });
  d.showModal();
  onOpen?.(d, close);
  return { el: d, close };
}
export function confirmBox(text, { ok = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({ title: 'Are you sure?', body: `<p class="text-2">${esc(text)}</p>`, actions: [
      { label: 'Cancel', onClick: () => { done = true; resolve(false); } },
      { label: ok, kind: danger ? 'primary danger' : 'primary', onClick: () => { done = true; resolve(true); } },
    ] });
    m.el.addEventListener('close', () => !done && resolve(false));
  });
}

/** Small popup menu anchored to a button. items: [{label, icon, onClick} | 'sep' | {heading}] */
export function menu(anchor, items) {
  $('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => (it === 'sep' ? '<div class="sep"></div>' : it.heading ? `<div class="lbl">${esc(it.heading)}</div>` : `<button role="menuitem" data-i="${i}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span></button>`)).join('');
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  m.style.top = `${r.bottom + h + 6 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  const close = () => { m.remove(); document.removeEventListener('mousedown', out, true); document.removeEventListener('keydown', key, true); };
  const out = (e) => { if (!m.contains(e.target)) close(); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  setTimeout(() => { document.addEventListener('mousedown', out, true); document.addEventListener('keydown', key, true); });
  m.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; close(); items[b.dataset.i].onClick(); };
  m.querySelector('button')?.focus();
}

/** Hover tooltip for any element with data-tip. */
export function initTooltips() {
  const tip = $('#tip');
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') { tip.hidden = true; return; }
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip;
    const r = t.getBoundingClientRect();
    tip.style.left = `${Math.min(innerWidth - 80, Math.max(80, r.left + r.width / 2))}px`;
    tip.style.top = `${r.top}px`;
    tip.hidden = false;
  });
  document.addEventListener('scroll', () => { tip.hidden = true; }, true);
}

export function copyBox(text) {
  return `<div class="copy"><code>${esc(text)}</code><button class="btn sm ghost" data-copy="${esc(text)}">${icon('copy')} Copy</button></div>`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (b) navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('Copied', 'ok'), () => toast('Copy failed', 'bad'));
});

export const go = (hash) => { location.hash = hash; };
export const params = () => new URLSearchParams(location.hash.split('?')[1] || '');
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Broken avatar images fall back to initials (CSP forbids inline onerror handlers).
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.dataset.fallback !== undefined) {
    const s = document.createElement('span');
    s.className = 'img'; s.style.background = img.dataset.color; s.textContent = img.dataset.fallback;
    img.replaceWith(s);
  }
}, true);

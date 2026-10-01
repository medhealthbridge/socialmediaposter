import { $, $$, api, state, esc, icon, zoned, fromZoned, fmt, go, toast, netColor } from '../core.js';
import { openPost } from './postcard.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let cursor = null; // {y, m}
let view = 'month';

export async function render(root) {
  const today = zoned(new Date().toISOString());
  cursor ??= { y: today.y, m: today.m, d: today.d };
  root.innerHTML = `<div class="page">
    <div class="page-head">
      <div class="grow"><h1 id="title"></h1><p class="sub">Drag posts to reschedule. Click a day to plan something.</p></div>
      <div class="seg" id="view"><button data-v="month">Month</button><button data-v="week">Week</button></div>
      <div class="row nowrap"><button class="btn icon" id="prev" aria-label="Previous">${icon('chevL')}</button><button class="btn" id="today">Today</button><button class="btn icon" id="next" aria-label="Next">${icon('chevR')}</button></div>
    </div>
    <div id="cal"></div>
    <div class="row small muted"><span class="badge scheduled">Scheduled</span><span class="badge published">Published</span><span class="badge failed">Failed</span><span class="badge draft">Draft</span><span class="right">Times in ${esc(state.user.tz)}</span></div>
  </div>`;

  async function draw() {
    $$('#view button', root).forEach((b) => b.classList.toggle('on', b.dataset.v === view));
    let start, days;
    if (view === 'month') {
      const first = new Date(Date.UTC(cursor.y, cursor.m - 1, 1));
      start = new Date(Date.UTC(cursor.y, cursor.m - 1, 1 - first.getUTCDay()));
      days = 42;
      $('#title', root).textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    } else {
      const d = new Date(Date.UTC(cursor.y, cursor.m - 1, cursor.d));
      start = new Date(Date.UTC(cursor.y, cursor.m - 1, cursor.d - d.getUTCDay()));
      days = 7;
      const end = new Date(start.getTime() + 6 * 864e5);
      $('#title', root).textContent = `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
    }
    const from = fromZoned(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate(), 0, 0);
    const to = new Date(from.getTime() + (days + 1) * 864e5);
    const posts = await api(`/posts?from=${from.toISOString()}&to=${to.toISOString()}&limit=2000`);
    const byDay = new Map();
    for (const p of posts) {
      const k = zoned(p.scheduled_at || p.created_at).key;
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(p);
    }
    for (const list of byDay.values()) list.sort((a, b) => (a.scheduled_at || a.created_at).localeCompare(b.scheduled_at || b.created_at));
    const max = view === 'month' ? 4 : 50;
    let html = DAYS.map((d) => `<div class="dh">${d}</div>`).join('');
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime() + i * 864e5);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      const list = byDay.get(key) || [];
      const other = view === 'month' && d.getUTCMonth() + 1 !== cursor.m;
      html += `<div class="day ${other ? 'other' : ''} ${key === today.key ? 'today' : ''}" data-day="${key}" style="${view === 'week' ? 'min-height:420px' : ''}">
        <div class="row nowrap"><span class="dn">${d.getUTCDate()}</span><a class="btn ghost sm icon add" href="#/compose?date=${key}" aria-label="New post on ${key}">${icon('plus')}</a></div>
        ${list.slice(0, max).map((p) => {
          const movable = ['scheduled', 'draft', 'failed'].includes(p.status) && p.scheduled_at;
          const dots = [...new Set(p.deliveries.map((x) => x.account_type))].slice(0, 4).map((t) => `<i style="background:${netColor(t)}"></i>`).join('');
          return `<div class="ev ${p.status}" data-id="${p.id}" ${movable ? 'draggable="true"' : ''} title="${esc(p.text.slice(0, 200))}"><span class="t">${p.scheduled_at ? fmt.time(p.scheduled_at) : 'Draft'}</span><span class="dots">${dots}</span><span class="s">${esc(p.text) || '(media)'}</span></div>`;
        }).join('')}
        ${list.length > max ? `<span class="more" data-more="${key}">+${list.length - max} more</span>` : ''}
      </div>`;
    }
    $('#cal', root).innerHTML = `<div class="cal">${html}</div>`;
  }

  const shift = (n) => {
    if (view === 'month') { const d = new Date(Date.UTC(cursor.y, cursor.m - 1 + n, 1)); cursor = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: 1 }; }
    else { const d = new Date(Date.UTC(cursor.y, cursor.m - 1, cursor.d + 7 * n)); cursor = { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; }
    draw();
  };
  $('#prev', root).onclick = () => shift(-1);
  $('#next', root).onclick = () => shift(1);
  $('#today', root).onclick = () => { cursor = { y: today.y, m: today.m, d: today.d }; draw(); };
  $('#view', root).onclick = (e) => { const b = e.target.closest('button'); if (b) { view = b.dataset.v; draw(); } };

  const cal = $('#cal', root);
  cal.addEventListener('click', (e) => {
    const ev = e.target.closest('.ev');
    if (ev) return openPost(ev.dataset.id, draw);
    const more = e.target.closest('[data-more]');
    if (more) { const [y, m, d] = more.dataset.more.split('-').map(Number); cursor = { y, m, d }; view = 'week'; draw(); }
  });
  // Drag & drop rescheduling: keeps the time of day, changes the date.
  let dragId = null;
  cal.addEventListener('dragstart', (e) => { const ev = e.target.closest('.ev'); if (!ev) return; dragId = ev.dataset.id; e.dataTransfer.effectAllowed = 'move'; });
  cal.addEventListener('dragover', (e) => { const day = e.target.closest('.day'); if (dragId && day) { e.preventDefault(); $$('.day.over', cal).forEach((x) => x.classList.remove('over')); day.classList.add('over'); } });
  cal.addEventListener('dragend', () => { dragId = null; $$('.day.over', cal).forEach((x) => x.classList.remove('over')); });
  cal.addEventListener('drop', async (e) => {
    const day = e.target.closest('.day'); if (!day || !dragId) return;
    e.preventDefault();
    const id = dragId; dragId = null;
    try {
      const p = await api(`/posts/${id}`);
      const t = zoned(p.scheduled_at);
      const [y, m, d] = day.dataset.day.split('-').map(Number);
      const when = fromZoned(y, m, d, t.h, t.mi);
      if (when < new Date()) { toast('Can’t move a post into the past', 'bad'); return draw(); }
      await api(`/posts/${id}`, { method: 'PUT', body: { scheduledAt: when.toISOString() } });
      toast(`Moved to ${fmt.dateTime(when.toISOString())}`, 'ok');
    } catch (err) { toast(err.message, 'bad'); }
    draw();
  });
  await draw();
}

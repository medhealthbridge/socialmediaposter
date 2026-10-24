/**
 * The month at a glance: what has gone out, what is waiting to, and which of your
 * weekly posting times are still free. Click a day to add something at that time.
 */
import { $, $$, api, state, esc, icon, avatar, fmt, go, accountById } from '../core.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Today's date in the person's own timezone, as YYYY-MM-DD. */
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const key = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export async function render(root, params) {
  const tz = state.user?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = todayIn(tz);
  let [year, month] = (params?.get('m') || today.slice(0, 7)).split('-').map(Number);
  month -= 1;

  root.innerHTML = `<div class="page">
    <div class="page-head"><div class="grow"><h1>Calendar</h1>
      <p class="sub">Everything scheduled and everything already out, in ${esc(tz)}.</p></div>
      <div class="row"><button class="btn ghost icon" id="prev" aria-label="Previous month">‹</button>
        <b id="label" style="min-width:150px;text-align:center"></b>
        <button class="btn ghost icon" id="next" aria-label="Next month">›</button>
        <button class="btn" id="today">Today</button></div></div>
    <div class="card card-pad"><div class="cal" id="cal"></div></div>
    <p class="hint">A faded time is one of your weekly posting slots that nothing is using yet — click it to write something for then.</p>
  </div>`;

  async function draw() {
    $('#label', root).textContent = `${MONTHS[month]} ${year}`;
    // Pull a little either side so the leading and trailing days of the grid are filled.
    const from = new Date(Date.UTC(year, month, 1) - 7 * 864e5).toISOString();
    const to = new Date(Date.UTC(year, month + 1, 1) + 14 * 864e5).toISOString();
    const cal = await api(`/calendar?from=${from}&to=${to}&tz=${encodeURIComponent(tz)}`);

    // Monday-first grid covering the whole month.
    const first = new Date(Date.UTC(year, month, 1));
    const lead = (first.getUTCDay() + 6) % 7;
    const total = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= total; d++) cells.push(d);
    while (cells.length % 7) cells.push(null);

    const slotsByDow = {};
    for (const s of cal.slots) (slotsByDow[s.dow] ??= []).push(s.time);

    $('#cal', root).innerHTML = DAYS.map((d) => `<div class="cal-head">${d}</div>`).join('')
      + cells.map((d) => {
        if (!d) return '<div class="cal-day empty"></div>';
        const k = key(year, month, d);
        const items = cal.days[k] || [];
        const dow = new Date(Date.UTC(year, month, d)).getUTCDay();
        const used = new Set(items.map((x) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(x.when))));
        const free = (slotsByDow[dow] || []).filter((t) => !used.has(t) && k >= today);
        return `<div class="cal-day ${k === today ? 'today' : ''} ${k < today ? 'past' : ''}" data-day="${k}">
          <div class="n">${d}</div>
          <div class="dots">${items.map((it) => {
            const accs = it.accountIds.map(accountById).filter(Boolean);
            return `<button type="button" class="cal-post ${esc(it.status)}" data-post="${it.id}"
              data-tip="${esc(`${fmt.time(it.when)} · ${it.text.slice(0, 80) || '(no text)'}${accs.length ? ` · ${accs.map((a) => a.name).join(', ')}` : ''}`)}">
              <span class="t">${esc(fmt.time(it.when))}</span>
              ${accs.slice(0, 2).map((a) => avatar(a, 'sm')).join('')}
              <span class="ellipsis">${esc(it.text.slice(0, 40) || (it.media ? 'media only' : '(no text)'))}</span>
            </button>`;
          }).join('')}</div>
          ${free.map((t) => `<button type="button" class="cal-slot" data-slot="${k}T${t}" data-tip="Free posting time — write something for ${esc(t)}">${esc(t)}</button>`).join('')}
        </div>`;
      }).join('');
  }

  const go_ = (delta) => { month += delta; if (month < 0) { month = 11; year--; } if (month > 11) { month = 0; year++; } draw(); };
  $('#prev', root).onclick = () => go_(-1);
  $('#next', root).onclick = () => go_(1);
  $('#today', root).onclick = () => { [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1]; draw(); };
  $('#cal', root).onclick = (e) => {
    const post = e.target.closest('[data-post]');
    if (post) return go(`#/compose?id=${post.dataset.post}`);
    const slot = e.target.closest('[data-slot]');
    if (slot) return go(`#/compose?at=${encodeURIComponent(slot.dataset.slot)}`);
  };

  await draw();
}

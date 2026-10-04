import { $, api, state, esc, icon, fmt, confirmBox, toast, debounce } from '../core.js';

const ACTOR = { you: 'You', agent: 'Agent', assistant: 'Assistant', timer: 'Timer', rss: 'RSS' };

export async function render(root) {
  let kind = '';
  let onlyProblems = false;

  root.innerHTML = `<div class="page">
    <div class="page-head"><div class="grow"><h1>Activity</h1><p class="sub">Everything that happened, including what ran while you were away.</p></div>
      <label class="check"><span class="switch"><input type="checkbox" id="prob"><span></span></span> Only problems</label>
      <button class="btn ghost sm" id="clear">${icon('trash')} Clear</button></div>
    <div class="row" id="kinds"></div>
    <div class="card"><div class="list" id="list"></div></div>
  </div>`;

  const kinds = state.eventKinds || {};
  $('#kinds', root).innerHTML = `<button class="chip plain on" data-k="">All</button>`
    + Object.entries(kinds).map(([k, v]) => `<button class="chip plain" data-k="${k}">${icon(v.icon)} ${esc(v.label)}</button>`).join('');

  async function draw() {
    const rows = await api(`/events?${new URLSearchParams({ ...(kind && { kind }), ...(onlyProblems && { level: 'problem' }), limit: 200 })}`);
    $('#list', root).innerHTML = rows.length ? rows.map((e) => `
      <div class="item log-item ${e.level}">
        <div class="when">${fmt.dateTime(e.created_at)}<div class="muted tiny">${fmt.rel(e.created_at)}</div></div>
        <div style="min-width:0">
          <div class="row" style="margin-bottom:4px">
            <span class="badge nodot ${e.level === 'error' ? 'failed' : e.level === 'warn' ? 'partial' : ''}">${icon(kinds[e.kind]?.icon || 'info')} ${esc(kinds[e.kind]?.label || e.kind)}</span>
            <span class="muted tiny">by ${esc(ACTOR[e.actor] || e.actor)}</span>
          </div>
          <div>${esc(e.summary)}</div>
          ${e.detail ? `<details class="small"><summary class="muted" style="cursor:pointer">Details</summary><pre class="detail">${esc(JSON.stringify(e.detail, null, 2))}</pre></details>` : ''}
        </div>
        <div>${e.post_id ? `<a class="btn sm ghost" href="#/queue?tab=all">Post #${e.post_id}</a>` : ''}</div>
      </div>`).join('')
      : `<div class="empty">${icon('list')}<b>Nothing here yet</b><span>${onlyProblems ? 'No problems — that is good news.' : 'Activity shows up as soon as you do something.'}</span></div>`;
  }

  $('#kinds', root).onclick = (e) => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    kind = b.dataset.k;
    $('#kinds', root).querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === b));
    draw();
  };
  $('#prob', root).onchange = (e) => { onlyProblems = e.target.checked; draw(); };
  $('#clear', root).onclick = async () => {
    if (!(await confirmBox('Clear the whole activity log? Your posts and accounts are not affected.', { ok: 'Clear', danger: true }))) return;
    await api('/events', { method: 'DELETE' }); toast('Cleared'); draw();
  };
  await draw();
}

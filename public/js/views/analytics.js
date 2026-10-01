import { $, api, esc, icon, fmt, toast, busy, netColor } from '../core.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let days = 30;

/** Single-series bar chart (one hue, rounded data-ends, hover tooltips). */
function barChart(data) {
  const W = 760, H = 200, pl = 34, pb = 22, pt = 8;
  const max = Math.max(1, ...data.map((d) => d.n));
  const step = Math.max(1, Math.ceil(max / 4));
  const top = step * Math.ceil(max / step);
  const bw = (W - pl) / data.length;
  const y = (v) => pt + (H - pt - pb) * (1 - v / top);
  const grid = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step)
    .map((v) => `<line class="gridline" x1="${pl}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const labelEvery = Math.ceil(data.length / 8);
  const bars = data.map((d, i) => {
    const x = pl + i * bw + bw * 0.18, w = Math.max(2, bw * 0.64), h = (H - pt - pb) - (y(d.n) - pt);
    const r = Math.min(4, w / 2, h);
    const path = h > 0 ? `<path class="bar" d="M${x},${y(0)} v${-(h - r)} q0,${-r} ${r},${-r} h${w - 2 * r} q${r},0 ${r},${r} v${h - r} z"/>` : '';
    const label = new Date(d.day + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return `<g>${path}<rect class="hit" x="${pl + i * bw}" y="${pt}" width="${bw}" height="${H - pt - pb}" data-tip="${esc(label)}: ${d.n} post${d.n === 1 ? '' : 's'}"/>${i % labelEvery === 0 ? `<text class="axis" x="${pl + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(label)}</text>` : ''}</g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Posts published per day">${grid}${bars}</svg>`;
}

function heatmap(cells) {
  const max = Math.max(0, ...cells.map((c) => c.avg));
  const bin = (v) => (v <= 0 ? 0 : Math.min(5, 1 + Math.floor((v / max) * 4.999)));
  let html = '<span></span>' + Array.from({ length: 24 }, (_, h) => `<span class="hl">${h % 3 === 0 ? h : ''}</span>`).join('');
  for (let d = 0; d < 7; d++) {
    html += `<span class="lbl">${DAYS[d]}</span>`;
    for (let h = 0; h < 24; h++) {
      const c = cells.find((x) => x.dow === d && x.hour === h);
      html += `<span class="c b${bin(c.avg)}" data-tip="${DAYS[d]} ${String(h).padStart(2, '0')}:00 — ${c.posts ? `${c.posts} post${c.posts > 1 ? 's' : ''}, avg engagement ${c.avg.toFixed(1)}` : 'no posts'}"></span>`;
    }
  }
  return `<div class="heat" role="img" aria-label="Average engagement by weekday and hour">${html}</div>
    <div class="legend" style="margin-top:10px">Less <i style="background:var(--heat-0)"></i><i style="background:var(--heat-1)"></i><i style="background:var(--heat-2)"></i><i style="background:var(--heat-3)"></i><i style="background:var(--heat-4)"></i><i style="background:var(--heat-5)"></i> More engagement</div>`;
}

export async function render(root) {
  root.innerHTML = `<div class="page">
    <div class="page-head"><div class="grow"><h1>Analytics</h1><p class="sub">How your posts are doing. Likes, reposts and replies are refreshed automatically every few hours.</p></div>
      <div class="seg" id="range">${[7, 30, 90, 365].map((d) => `<button data-d="${d}">${d === 365 ? '1 year' : `${d} days`}</button>`).join('')}</div>
      <button class="btn" id="refresh">${icon('retry')} Refresh metrics</button></div>
    <div id="body" class="col gap-lg"><div class="card card-pad muted">Loading…</div></div>
  </div>`;
  async function draw() {
    root.querySelectorAll('#range button').forEach((b) => b.classList.toggle('on', Number(b.dataset.d) === days));
    const s = await api(`/analytics?days=${days}`);
    const k = s.kpis;
    const maxNet = Math.max(1, ...s.perNetwork.map((n) => n.posts));
    $('#body', root).innerHTML = `
      <div class="kpis">
        <div class="card kpi"><div class="l">Published</div><div class="v">${fmt.num(k.published)}</div><div class="s">posts in ${days} days</div></div>
        <div class="card kpi"><div class="l">Engagement</div><div class="v">${fmt.num(k.engagement)}</div><div class="s">likes + 2×reposts + 3×replies</div></div>
        <div class="card kpi"><div class="l">Avg. per post</div><div class="v">${k.avgEngagement == null ? '—' : k.avgEngagement.toFixed(1)}</div><div class="s">posts with metrics</div></div>
        <div class="card kpi"><div class="l">Success rate</div><div class="v">${fmt.pct(k.successRate)}</div><div class="s">${k.failed} failed</div></div>
        <div class="card kpi"><div class="l">Scheduled</div><div class="v">${fmt.num(k.scheduled)}</div><div class="s">upcoming</div></div>
      </div>
      <div class="card"><div class="card-head"><h2 class="grow">Posts per day</h2></div><div class="card-body">${barChart(s.perDay)}</div></div>
      <div class="grid-2">
        <div class="card"><div class="card-head"><h2>By network</h2></div><div class="card-body">${s.perNetwork.length ? s.perNetwork.map((n) => `
          <div class="hbar"><span class="row nowrap"><span class="pill"><span class="dot" style="background:${netColor(n.type)}"></span>${esc(n.label)}</span></span>
          <div class="track" data-tip="${n.posts} posts · ${fmt.num(n.engagement)} engagement"><div class="fill" style="width:${(n.posts / maxNet) * 100}%"></div></div>
          <span class="small text-2" style="text-align:right">${n.posts} posts</span></div>`).join('') + `
          <table class="tbl" style="margin-top:12px"><thead><tr><th>Network</th><th class="num">Likes</th><th class="num">Reposts</th><th class="num">Replies</th><th class="num">Views</th></tr></thead><tbody>
          ${s.perNetwork.map((n) => `<tr><td>${esc(n.label)}</td><td class="num">${fmt.num(n.likes)}</td><td class="num">${fmt.num(n.reposts)}</td><td class="num">${fmt.num(n.replies)}</td><td class="num">${n.views ? fmt.num(n.views) : '—'}</td></tr>`).join('')}</tbody></table>`
          : '<div class="empty">No published posts in this period.</div>'}</div></div>
        <div class="card"><div class="card-head"><h2 class="grow">Best time to post</h2><span class="badge nodot">${s.bestTimes.source === 'yours' ? 'from your data' : 'typical — post more to personalize'}</span></div>
          <div class="card-body col">${heatmap(s.heatmap)}
          <div class="row small"><span class="text-2">Top times:</span>${s.bestTimes.times.map((t) => `<span class="pill">${DAYS[t.dow]} ${String(t.hour).padStart(2, '0')}:00</span>`).join('')}<span class="muted right">${esc(s.tz)}</span></div></div></div>
      </div>
      <div class="card"><div class="card-head"><h2>Top posts</h2></div>${s.top.length ? `<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Post</th><th>Account</th><th class="num">Likes</th><th class="num">Reposts</th><th class="num">Replies</th><th class="num">Score</th><th></th></tr></thead><tbody>
        ${s.top.map((t) => `<tr><td style="max-width:420px">${esc(t.text)}<div class="muted tiny">${fmt.dateTime(t.published_at)}</div></td><td>${esc(t.account)}</td><td class="num">${fmt.num(t.metrics.likes)}</td><td class="num">${fmt.num(t.metrics.reposts)}</td><td class="num">${fmt.num(t.metrics.replies)}</td><td class="num"><b>${fmt.num(t.score)}</b></td><td>${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener" aria-label="Open">${icon('ext')}</a>` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">Engagement numbers appear here a little while after your posts go live. (X needs a paid API plan for metrics; LinkedIn, Telegram, Discord and webhooks don’t offer them.)</div>'}</div>`;
    const bars = $('#body', root);
    bars.style.setProperty('--x', 0);
  }
  $('#range', root).onclick = (e) => { const b = e.target.closest('button'); if (b) { days = Number(b.dataset.d); draw(); } };
  $('#refresh', root).onclick = busy($('#refresh', root), async () => { const r = await api('/analytics/refresh', { method: 'POST' }); toast(`Updated ${r.updated} of ${r.checked} posts`, 'ok'); await draw(); });
  await draw();
}

/**
 * One place to see everything that has gone out.
 *
 * Totals across every account, a strip of accounts you can narrow by, then the posts
 * themselves newest first — each showing how it did and linking straight to the real
 * post on the network, so a Facebook post opens on Facebook.
 */
import { $, $$, api, state, esc, icon, avatar, netLabel, netMark, fmt, toast, busy, go } from '../core.js';

const METRICS = [
  ['likes', 'Likes', 'heart'],
  ['replies', 'Comments', 'reply'],
  ['reposts', 'Shares', 'repost'],
  ['views', 'Views', 'eye'],
];

export async function render(root) {
  let accountId = null;
  let group = null;

  root.innerHTML = `<div class="page">
    <div class="page-head"><div class="grow"><h1>Dashboard</h1>
      <p class="sub">Everything you have published, across every account.</p></div>
      <button class="btn" id="refresh">${icon('retry')} Refresh figures</button></div>
    <div id="kpis" class="kpis"></div>
    <div class="card card-pad col" id="filters"></div>
    <div class="card"><div class="list" id="feed"></div></div>
  </div>`;

  const num = (n) => fmt.num(Number(n || 0));

  function drawTotals(d) {
    $('#kpis', root).innerHTML = `
      <div class="card kpi"><div class="l">Published</div><div class="v">${num(d.totals.posts)}</div><div class="s">posts live</div></div>`
      + METRICS.map(([k, label]) => `<div class="card kpi"><div class="l">${label}</div><div class="v">${num(d.totals[k])}</div>
          <div class="s">across all accounts</div></div>`).join('');
  }

  function drawFilters(d) {
    const chip = (on, attr, val, inner, tip = '') =>
      `<button type="button" class="chip plain ${on ? 'on' : ''}" ${attr}="${esc(val)}" ${tip ? `data-tip="${esc(tip)}"` : ''}>${inner}</button>`;
    const adult = (g) => (state.adultGroups || []).some((x) => x.toLowerCase() === g.toLowerCase());
    $('#filters', root).innerHTML = `
      <div class="row"><span class="muted small" style="min-width:64px">Accounts</span>
        ${chip(!accountId, 'data-acc', '', 'Everything')}
        ${d.accounts.map((a) => chip(accountId === a.id, 'data-acc', a.id,
          `${avatar(a, 'sm')}<span class="ellipsis" style="max-width:130px">${esc(a.name)}</span><span class="n">${num(a.totals.posts)}</span>`,
          `${netLabel(a.type)} · ${num(a.totals.likes)} likes · ${num(a.totals.replies)} comments${a.canMeasure ? '' : ' · this network reports no figures'}`)).join('')
          || '<span class="muted small">No accounts connected yet.</span>'}</div>
      ${d.groups.length ? `<div class="row"><span class="muted small" style="min-width:64px">Groups</span>
        ${chip(!group, 'data-grp', '', 'All')}
        ${d.groups.map((g) => chip(group === g, 'data-grp', g, `${adult(g) ? '18+ ' : ''}${esc(g)}`)).join('')}</div>` : ''}`;
  }

  function drawFeed(d) {
    const box = $('#feed', root);
    if (!d.items.length) {
      box.innerHTML = `<div class="empty">${icon('chart')}<b>Nothing published here yet</b>
        <span>${accountId || group ? 'Nothing for this filter — try Everything.' : 'Once you post something it shows up here with its figures.'}</span></div>`;
      return;
    }
    box.innerHTML = d.items.map((it) => {
      const a = d.accounts.find((x) => x.id === it.accountId);
      const m = it.metrics;
      const pic = it.media[0];
      return `<div class="item feed-item">
        <div class="shot">${pic
          ? (pic.mime.startsWith('video/') ? `<video src="${esc(pic.url)}" muted preload="metadata"></video>` : `<img src="${esc(pic.url)}" alt="" loading="lazy">`)
          : `<span class="none">${icon('draft')}</span>`}</div>
        <div style="min-width:0">
          <div class="row" style="margin-bottom:4px">
            ${a ? avatar(a, 'sm') : ''}<b class="ellipsis">${esc(a?.name || 'Removed account')}</b>
            ${a ? netMark(a.type) : ''}
            <span class="muted tiny">${it.publishedAt ? fmt.rel(it.publishedAt) : 'not published'}</span>
          </div>
          <div class="txt text-2">${esc(it.text || '(no text)')}</div>
          ${it.status === 'failed' ? `<div class="err small" style="color:var(--bad)">${esc(it.error || 'failed')}</div>` : ''}
          ${m ? `<div class="row small" style="margin-top:6px">${METRICS.filter(([k]) => m[k] != null)
            .map(([k, label, ic]) => `<span class="stat" data-tip="${esc(label)}">${icon(ic)} ${num(m[k])}</span>`).join('')}
            ${it.metricsAt ? `<span class="muted tiny">checked ${fmt.rel(it.metricsAt)}</span>` : ''}</div>`
            : it.status === 'published' ? `<div class="muted tiny" style="margin-top:6px">${a?.canMeasure ? 'No figures yet — press Refresh figures.' : `${netLabel(a?.type)} does not report figures.`}</div>` : ''}
        </div>
        <div class="actions">
          ${it.url ? `<a class="btn sm primary" href="${esc(it.url)}" target="_blank" rel="noopener">Open on ${esc(netLabel(a?.type) || 'the network')} ${icon('ext')}</a>`
            : it.status === 'published' ? '<span class="muted tiny">no link</span>' : ''}
          <button class="btn sm ghost icon" data-post="${it.postId}" data-tip="Open this post here">${icon('eye')}</button>
        </div>
      </div>`;
    }).join('');
  }

  async function draw() {
    const qs = new URLSearchParams();
    if (accountId) qs.set('account', accountId);
    if (group) qs.set('group', group);
    const d = await api(`/dashboard${qs.toString() ? `?${qs}` : ''}`);
    drawTotals(d); drawFilters(d); drawFeed(d);
  }

  $('#filters', root).onclick = (e) => {
    const acc = e.target.closest('[data-acc]');
    const grp = e.target.closest('[data-grp]');
    if (acc) { accountId = acc.dataset.acc ? Number(acc.dataset.acc) : null; draw(); }
    else if (grp) { group = grp.dataset.grp || null; draw(); }
  };
  $('#feed', root).onclick = (e) => {
    const b = e.target.closest('[data-post]');
    if (b) go(`#/compose?id=${b.dataset.post}`);
  };
  $('#refresh', root).onclick = busy($('#refresh', root), async () => {
    const r = await api('/analytics/refresh', { method: 'POST' });
    toast(r.updated ? `Updated ${r.updated} post${r.updated === 1 ? '' : 's'}` : 'Nothing needed updating', 'ok');
    await draw();
  });

  await draw();
}

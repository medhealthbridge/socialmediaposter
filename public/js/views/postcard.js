import { api, esc, icon, avatar, fmt, statusBadge, toast, confirmBox, modal, go, accountById, refreshCounts } from '../core.js';

const metricHtml = (m) => (m ? `<span class="metric" data-tip="Likes">${icon('heart')}${fmt.num(m.likes)}</span><span class="metric" data-tip="Reposts">${icon('repost')}${fmt.num(m.reposts)}</span><span class="metric" data-tip="Replies">${icon('reply')}${fmt.num(m.replies)}</span>${m.views != null ? `<span class="metric" data-tip="Views">${icon('eye')}${fmt.num(m.views)}</span>` : ''}` : '');

export function deliveriesHtml(p) {
  if (!p.deliveries.length) return '<div class="deliv"><span class="muted small">No accounts picked yet — edit to choose where it goes</span></div>';
  return `<div class="deliv">${p.deliveries.map((d) => {
    const acc = accountById(d.account_id) || { name: d.account_name, type: d.account_type, avatar: d.account_avatar };
    const shown = p.status === 'queued' && d.status === 'pending' ? 'pending' : d.status;
    return `<span class="d ${shown}" data-tip="${esc(`${d.account_name}${shown !== 'pending' ? `: ${d.status}` : ''}${d.error ? ' — ' + d.error : ''}`)}">${avatar(acc, 'sm')}${esc(d.account_name)}
      ${d.status === 'published' ? (d.remote_url ? `<a href="${esc(d.remote_url)}" target="_blank" rel="noopener" aria-label="Open post">${icon('ext', '')}</a>` : icon('check')) : d.status === 'failed' ? icon('alert') : ''}
      ${metricHtml(d.metrics)}</span>`;
  }).join('')}${p.deliveries.filter((d) => d.error && d.status === 'failed').map((d) => `<div class="err">${esc(d.account_name)}: ${esc(d.error)}</div>`).join('')}</div>`;
}

/** One post row. `index` is its 1-based place in the queue (queued posts only). */
export function postItem(p, index) {
  const queued = p.status === 'queued';
  const waiting = queued || p.status === 'scheduled';
  const retry = p.status === 'failed' || p.status === 'partial';
  const media = p.mediaItems.filter((m) => !m.missing);
  return `<div class="item" data-id="${p.id}">
    <div class="when">${queued && index ? `<div class="row nowrap"><span class="qnum">#${index}</span><div class="order"><button class="btn sm ghost icon" data-act="up" data-tip="Move up" aria-label="Move up">${icon('chevL', 'rot90')}</button><button class="btn sm ghost icon" data-act="down" data-tip="Move down" aria-label="Move down">${icon('chevR', 'rot90')}</button></div></div>`
      : p.scheduled_at && p.status === 'scheduled' ? `${icon('clock')} ${fmt.dateTime(p.scheduled_at)}<div class="muted tiny">${fmt.rel(p.scheduled_at)}</div>`
      : p.posted_at ? `${fmt.dateTime(p.posted_at)}<div class="muted tiny">${fmt.rel(p.posted_at)}</div>` : `<span class="muted small">added ${fmt.rel(p.created_at)}</span>`}</div>
    <div style="min-width:0">
      <div class="row" style="margin-bottom:6px">${statusBadge(p.status)}${p.source !== 'manual' ? `<span class="badge nodot">${esc({ rss: 'from RSS', bulk: 'imported', assistant: 'from assistant', evergreen: 'evergreen' }[p.source] || p.source)}</span>` : ''}${p.recycle_days ? `<span class="badge nodot" data-tip="Reposts every ${p.recycle_days} days">${icon('recycle')} every ${p.recycle_days}d</span>` : ''}${p.notes ? `<span class="badge nodot" data-tip="${esc(p.notes)}">note</span>` : ''}</div>
      <div class="txt">${esc(p.text) || '<span class="muted">(media only)</span>'}</div>
      ${media.length ? `<div class="media-mini">${media.slice(0, 6).map((m) => (m.mime.startsWith('video/') ? `<video src="${esc(m.url)}" muted preload="metadata"></video>` : `<img src="${esc(m.url)}" alt="" loading="lazy">`)).join('')}</div>` : ''}
      ${deliveriesHtml(p)}
    </div>
    <div class="actions" style="align-items:center">
      ${waiting || retry ? `<button class="btn sm primary post-btn" data-act="post">${icon(retry ? 'retry' : 'send')} ${retry ? 'Retry' : p.status === 'scheduled' ? 'Post now' : 'Post'}</button>` : ''}
      ${p.status === 'published' || p.status === 'publishing' ? '' : `<button class="btn sm ghost icon" data-act="edit" data-tip="Edit">${icon('edit')}</button>`}
      <button class="btn sm ghost icon" data-act="dup" data-tip="${p.status === 'published' ? 'Post again (copy to queue)' : 'Duplicate'}">${icon('copy')}</button>
      <button class="btn sm ghost icon danger" data-act="del" data-tip="Delete">${icon('trash')}</button>
    </div>
  </div>`;
}

/** Summarise a publish result as a toast. */
export function publishToast(p) {
  const ok = p.deliveries.filter((d) => d.status === 'published').length;
  const bad = p.deliveries.filter((d) => d.status === 'failed');
  if (bad.length) toast(`Posted to ${ok} of ${p.deliveries.length}. Failed: ${bad.map((d) => `${d.account_name} (${d.error})`).join('; ')}`, 'bad');
  else toast(`Posted to ${ok} account${ok === 1 ? '' : 's'} ✓`, 'ok');
}

/** Click handler for post action buttons; calls `after()` when something changed. */
export async function postAction(e, after) {
  const b = e.target.closest('[data-act]');
  if (!b) return false;
  const id = b.closest('[data-id]').dataset.id;
  const act = b.dataset.act;
  b.classList.add('loading');
  try {
    if (act === 'edit') return go(`#/compose?id=${id}`);
    if (act === 'dup') { await api(`/posts/${id}/duplicate`, { method: 'POST' }); toast('Copied to the end of your queue', 'ok'); }
    if (act === 'post') publishToast(await api(`/posts/${id}/publish`, { method: 'POST' }));
    if (act === 'up' || act === 'down') await api(`/posts/${id}/move`, { method: 'POST', body: { dir: act } });
    if (act === 'del') { if (!(await confirmBox('Delete this post? Anything already published on a network stays there.', { ok: 'Delete', danger: true }))) return; await api(`/posts/${id}`, { method: 'DELETE' }); toast('Deleted'); }
    await refreshCounts();
    await after();
  } catch (err) {
    toast(err.message, 'bad');
    await after().catch(() => {});
  } finally { b.classList.remove('loading'); }
  return true;
}

export async function openPost(id, after) {
  const p = await api(`/posts/${id}`);
  const m = modal({ title: 'Post', wide: true, body: `<div class="list" style="margin:-4px -20px">${postItem(p)}</div>` });
  m.el.addEventListener('click', async (e) => { if (await postAction(e, after)) m.close(); });
}

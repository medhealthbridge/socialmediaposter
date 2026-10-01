import { api, esc, icon, avatar, fmt, statusBadge, toast, confirmBox, modal, go, accountById } from '../core.js';

const metricHtml = (m) => (m ? `<span class="metric" data-tip="Likes">${icon('heart')}${fmt.num(m.likes)}</span><span class="metric" data-tip="Reposts">${icon('repost')}${fmt.num(m.reposts)}</span><span class="metric" data-tip="Replies">${icon('reply')}${fmt.num(m.replies)}</span>${m.views != null ? `<span class="metric" data-tip="Views">${icon('eye')}${fmt.num(m.views)}</span>` : ''}` : '');

export function deliveriesHtml(p) {
  if (!p.deliveries.length) return '<div class="deliv"><span class="muted small">No accounts selected</span></div>';
  return `<div class="deliv">${p.deliveries.map((d) => {
    const acc = accountById(d.account_id) || { name: d.account_name, type: d.account_type, avatar: d.account_avatar };
    return `<span class="d ${d.status}" data-tip="${esc(`${d.account_name}: ${d.status}${d.error ? ' — ' + d.error : ''}`)}">${avatar(acc, 'sm')}${esc(d.account_name)}
      ${d.status === 'published' ? (d.remote_url ? `<a href="${esc(d.remote_url)}" target="_blank" rel="noopener" aria-label="Open post">${icon('ext', '')}</a>` : icon('check')) : d.status === 'failed' ? icon('alert') : ''}
      ${metricHtml(d.metrics)}</span>`;
  }).join('')}${p.deliveries.filter((d) => d.error).map((d) => `<div class="err">${esc(d.account_name)}: ${esc(d.error)}</div>`).join('')}</div>`;
}

export function postItem(p) {
  const done = ['published', 'publishing'].includes(p.status);
  const media = p.mediaItems.filter((m) => !m.missing);
  return `<div class="item" data-id="${p.id}">
    <div class="when">${p.scheduled_at ? `${fmt.dateTime(p.scheduled_at)}<div class="muted tiny">${fmt.rel(p.scheduled_at)}</div>` : `<span class="muted">No date</span>`}</div>
    <div style="min-width:0">
      <div class="row" style="margin-bottom:6px">${statusBadge(p.status)}${p.recycle_days ? `<span class="badge nodot" data-tip="Evergreen: reposts every ${p.recycle_days} days">${icon('recycle')} every ${p.recycle_days}d</span>` : ''}${p.source !== 'manual' ? `<span class="badge nodot">${esc({ rss: 'from RSS', recycle: 'evergreen', bulk: 'bulk import' }[p.source] || p.source)}</span>` : ''}${p.notes ? `<span class="badge nodot" data-tip="${esc(p.notes)}">note</span>` : ''}</div>
      <div class="txt">${esc(p.text) || '<span class="muted">(media only)</span>'}</div>
      ${media.length ? `<div class="media-mini">${media.slice(0, 6).map((m) => (m.mime.startsWith('video/') ? `<video src="${esc(m.url)}" muted preload="metadata"></video>` : `<img src="${esc(m.url)}" alt="" loading="lazy">`)).join('')}</div>` : ''}
      ${deliveriesHtml(p)}
    </div>
    <div class="actions">
      ${done ? '' : `<button class="btn sm ghost icon" data-act="edit" data-tip="Edit">${icon('edit')}</button>`}
      ${['draft', 'scheduled', 'failed', 'partial'].includes(p.status) ? `<button class="btn sm ghost icon" data-act="now" data-tip="${p.status === 'failed' || p.status === 'partial' ? 'Retry failed accounts' : 'Post now'}">${icon(p.status === 'failed' || p.status === 'partial' ? 'retry' : 'send')}</button>` : ''}
      <button class="btn sm ghost icon" data-act="dup" data-tip="Duplicate">${icon('copy')}</button>
      <button class="btn sm ghost icon danger" data-act="del" data-tip="Delete">${icon('trash')}</button>
    </div>
  </div>`;
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
    if (act === 'dup') { const d = await api(`/posts/${id}/duplicate`, { method: 'POST' }); toast('Duplicated as a draft', 'ok'); return go(`#/compose?id=${d.id}`); }
    if (act === 'now') { await api(`/posts/${id}/publish`, { method: 'POST' }); toast('Publishing…', 'ok'); setTimeout(after, 2500); }
    if (act === 'del') { if (!(await confirmBox('Delete this post? Posts already published on networks stay there.', { ok: 'Delete', danger: true }))) return; await api(`/posts/${id}`, { method: 'DELETE' }); toast('Deleted'); }
    await after();
  } catch (err) {
    toast(err.message, 'bad');
  } finally { b.classList.remove('loading'); }
  return true;
}

export async function openPost(id, after) {
  const p = await api(`/posts/${id}`);
  const m = modal({ title: 'Post', wide: true, body: `<div class="list" style="margin:-4px -20px">${postItem(p)}</div>` });
  m.el.addEventListener('click', async (e) => { if (await postAction(e, after)) m.close(); });
}

import { $, api, state, esc, icon, toast, modal, debounce, refreshCounts, busy } from '../core.js';
import { postItem, postAction, publishToast } from './postcard.js';

const TABS = [['queued', 'Queue'], ['published', 'Published'], ['failed', 'Needs attention'], ['all', 'All']];

export async function render(root, qs) {
  let tab = TABS.some(([k]) => k === qs.get('tab')) ? qs.get('tab') : 'queued';
  let search = '';
  root.innerHTML = `<div class="page">
    <div class="page-head"><div class="grow"><h1>Queue</h1><p class="sub">Your posts wait here until you click Post — nothing goes out on its own.</p></div>
      <input type="search" id="q" placeholder="Search…" style="max-width:220px" aria-label="Search">
      <button class="btn" id="more">${icon('download')} Import / export</button>
      <a class="btn primary" href="#/compose">${icon('plus')} New post</a></div>
    <div id="hero"></div>
    <div class="card"><div class="tabs" id="tabs" style="padding:0 12px"></div><div class="list" id="list"></div></div>
  </div>`;

  async function draw() {
    const [posts, counts] = await Promise.all([
      api(`/posts?${new URLSearchParams({ ...(tab !== 'all' && { status: tab }), ...(search && { q: search }), limit: 300 })}`),
      api('/counts'),
    ]);
    state.counts = counts;
    window.dispatchEvent(new Event('state'));
    const next = tab === 'queued' && !search ? posts[0] : null;
    $('#hero', root).innerHTML = counts.queued ? `<div class="card queue-hero">
        <div><div class="big">${counts.queued}</div><div class="text-2 small">post${counts.queued === 1 ? '' : 's'} waiting</div></div>
        <div class="grow" style="min-width:200px">${next ? `<div class="small muted">Up next</div><div class="ellipsis bold">${esc(next.text.slice(0, 140)) || '(media only)'}</div>` : '<div class="text-2 small">Ready when you are.</div>'}</div>
        <button class="btn primary" id="postNext">${icon('send')} Post next</button></div>` : '';
    $('#postNext', root)?.addEventListener('click', (e) => busy(e.currentTarget, async () => { publishToast(await api('/queue/next', { method: 'POST' })); await refreshCounts(); await draw(); })());
    $('#tabs', root).innerHTML = TABS.map(([k, l]) => {
      const n = k === 'queued' ? counts.queued : k === 'failed' ? counts.failed : k === 'published' ? counts.published : null;
      return `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${l}${n ? `<span class="n">${n}</span>` : ''}</button>`;
    }).join('');
    const empty = { queued: ['Your queue is empty', 'Write a few posts now, then publish them with one click whenever you like.'], published: ['Nothing published yet', ''], failed: ['All good', 'No failed posts.'], all: ['No posts yet', ''] }[tab];
    $('#list', root).innerHTML = posts.length ? posts.map((p, i) => postItem(p, tab === 'queued' && !search ? i + 1 : 0)).join('')
      : `<div class="empty">${icon(tab === 'failed' ? 'check' : 'queue')}<b>${empty[0]}</b><span>${search ? 'Try a different search.' : empty[1]}</span>${tab !== 'failed' ? `<a class="btn primary" href="#/compose">${icon('plus')} Create post</a>` : ''}</div>`;
  }
  $('#tabs', root).onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) { tab = b.dataset.t; history.replaceState(null, '', `#/queue?tab=${tab}`); draw(); } };
  $('#list', root).onclick = (e) => postAction(e, draw);
  $('#q', root).oninput = debounce((e) => { search = e.target.value.trim(); draw(); }, 250);
  $('#more', root).onclick = () => importExport(draw);
  await draw();
}

function importExport(after) {
  modal({ title: 'Import & export', wide: true, body: `
    <h3>Add many posts from a CSV</h3>
    <p class="text-2 small">Up to 500 rows, added to the end of your queue. Columns: <code>text</code> and <code>accounts</code> (account names separated by <code>;</code>).</p>
    <textarea id="csv" rows="7" style="font-family:ui-monospace,monospace;font-size:12.5px" placeholder='text,accounts\n"Hello world!","My Bluesky;My Mastodon"\n"Another one","My Bluesky"'></textarea>
    <div class="row"><input type="file" id="csvFile" accept=".csv,text/csv" style="max-width:260px"><span class="grow"></span><button class="btn primary" id="doImport">${icon('upload')} Import</button></div>
    <div id="importRes"></div>
    <div class="divider"></div>
    <h3>Export</h3>
    <p class="text-2 small">Download your posts and results (including likes, reposts and replies).</p>
    <div class="row"><a class="btn" href="/api/export.csv" download>${icon('download')} History (CSV)</a><a class="btn" href="/api/export.json" download>${icon('download')} Everything (JSON)</a></div>`,
  onOpen: (d) => {
    $('#csvFile', d).onchange = async (e) => { $('#csv', d).value = await e.target.files[0].text(); };
    $('#doImport', d).onclick = async (e) => {
      const b = e.currentTarget; b.classList.add('loading');
      try {
        const r = await api('/bulk', { method: 'POST', raw: $('#csv', d).value, headers: { 'content-type': 'text/csv' } });
        $('#importRes', d).innerHTML = `<div class="callout">${icon('check')}<div><b>${r.created} post${r.created === 1 ? '' : 's'} added to your queue.</b>${r.errors.map((x) => `<div class="small" style="color:var(--bad)">Row ${x.row}: ${esc(x.error)}</div>`).join('')}</div></div>`;
        if (r.created) { await refreshCounts(); after(); }
      } catch (err) { toast(err.message, 'bad'); } finally { b.classList.remove('loading'); }
    };
  } });
}

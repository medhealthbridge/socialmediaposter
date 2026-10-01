import { $, $$, api, esc, icon, toast, modal, debounce, params, go } from '../core.js';
import { postItem, postAction } from './postcard.js';

const TABS = [['scheduled', 'Scheduled'], ['draft', 'Drafts'], ['published', 'Published'], ['failed', 'Needs attention'], ['all', 'All']];

export async function render(root, qs) {
  let tab = TABS.some(([k]) => k === qs.get('tab')) ? qs.get('tab') : 'scheduled';
  let search = '';
  root.innerHTML = `<div class="page">
    <div class="page-head"><div class="grow"><h1>Posts</h1><p class="sub">Everything you've planned and published.</p></div>
      <input type="search" id="q" placeholder="Search posts…" style="max-width:240px" aria-label="Search">
      <button class="btn" id="more">${icon('download')} Import / export</button>
      <a class="btn primary" href="#/compose">${icon('plus')} New post</a></div>
    <div class="card"><div class="tabs" id="tabs" style="padding:0 12px"></div><div class="list" id="list"></div></div>
  </div>`;

  async function draw() {
    const posts = await api(`/posts?${new URLSearchParams({ ...(tab !== 'all' && { status: tab }), ...(search && { q: search }), limit: 300 })}`);
    $('#tabs', root).innerHTML = TABS.map(([k, l]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${l}${k === tab ? `<span class="n">${posts.length}</span>` : ''}</button>`).join('');
    const empty = { scheduled: ['Nothing scheduled yet', 'Plan your next post and it will show up here.'], draft: ['No drafts', 'Save ideas as drafts to finish later.'], published: ['Nothing published yet', ''], failed: ['All good', 'No failed posts.'], all: ['No posts yet', ''] }[tab];
    $('#list', root).innerHTML = posts.length ? posts.map(postItem).join('')
      : `<div class="empty">${icon(tab === 'failed' ? 'check' : 'list')}<b>${empty[0]}</b><span>${search ? 'Try a different search.' : empty[1]}</span>${tab !== 'failed' ? `<a class="btn primary" href="#/compose">${icon('plus')} Create post</a>` : ''}</div>`;
  }
  $('#tabs', root).onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) { tab = b.dataset.t; history.replaceState(null, '', `#/posts?tab=${tab}`); draw(); } };
  $('#list', root).onclick = (e) => postAction(e, draw);
  $('#q', root).oninput = debounce((e) => { search = e.target.value.trim(); draw(); }, 250);
  $('#more', root).onclick = () => importExport(draw);
  await draw();
}

function importExport(after) {
  modal({ title: 'Import & export', wide: true, body: `
    <h3>Bulk schedule from CSV</h3>
    <p class="text-2 small">Up to 500 posts. Columns: <code>text</code>, <code>scheduled_at</code> (e.g. <code>2026-11-02T09:00</code> in your timezone, <code>queue</code> for the next free slot, or empty for a draft), <code>accounts</code> (account names separated by <code>;</code>).</p>
    <textarea id="csv" rows="7" style="font-family:ui-monospace,monospace;font-size:12.5px" placeholder='text,scheduled_at,accounts\n"Hello world!",2026-11-02T09:00,"My Bluesky;My Mastodon"\n"Another one",queue,"My Bluesky"'></textarea>
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
        const csv = $('#csv', d).value;
        // scheduled_at values are in the user's timezone: convert to ISO before sending.
        const { fromLocalInput } = await import('../core.js');
        const fixed = csv.replace(/(^|,)(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})(?=,|$)/gm, (_, pre, v) => pre + fromLocalInput(v.replace(' ', 'T')));
        const r = await api('/bulk', { method: 'POST', raw: fixed, headers: { 'content-type': 'text/csv' } });
        $('#importRes', d).innerHTML = `<div class="callout">${icon('check')}<div><b>${r.created} post${r.created === 1 ? '' : 's'} created.</b>${r.errors.map((x) => `<div class="small" style="color:var(--bad)">Row ${x.row}: ${esc(x.error)}</div>`).join('')}</div></div>`;
        if (r.created) after();
      } catch (err) { toast(err.message, 'bad'); } finally { b.classList.remove('loading'); }
    };
  } });
}

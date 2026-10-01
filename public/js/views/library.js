import { $, $$, api, state, refresh, esc, icon, fmt, toast, modal, confirmBox, go } from '../core.js';

export async function render(root, qs) {
  let tab = qs.get('tab') === 'snippets' ? 'snippets' : 'media';
  root.innerHTML = `<div class="page">
    <div class="page-head"><div class="grow"><h1>Library</h1><p class="sub">Reusable images, videos, hashtag sets and text snippets.</p></div></div>
    <div class="card"><div class="tabs" id="tabs" style="padding:0 12px"></div><div class="card-body" id="body"></div></div>
  </div>`;

  async function media() {
    const items = await api('/media');
    $('#body', root).innerHTML = `<div class="row" style="margin-bottom:14px"><span class="text-2 small">JPEG, PNG, GIF, WebP up to 20 MB · MP4/MOV up to 1 GB. Drop files anywhere here.</span>
      <button class="btn primary right" id="up">${icon('upload')} Upload</button><input type="file" id="f" multiple hidden accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime"></div>
      ${items.length ? `<div class="media-grid" id="grid">${items.map((m) => `<div class="media-card" data-id="${m.id}">
        <div class="pic">${m.mime.startsWith('video/') ? `<video src="${esc(m.url)}" muted preload="metadata" controls></video>` : `<img src="${esc(m.url)}" alt="${esc(m.alt)}" loading="lazy">`}</div>
        <div class="meta"><span class="grow ellipsis" title="${esc(m.filename)}">${esc(m.filename)}<br><span class="muted tiny">${fmt.bytes(m.size)}${m.alt ? ' · alt ✓' : ''}</span></span>
        <button class="btn sm ghost icon" data-act="use" data-tip="Use in a new post">${icon('compose')}</button>
        <button class="btn sm ghost icon" data-act="alt" data-tip="Alt text">${icon('edit')}</button>
        <button class="btn sm ghost icon danger" data-act="del" data-tip="Delete">${icon('trash')}</button></div></div>`).join('')}</div>`
        : `<div class="empty">${icon('image')}<b>No media yet</b><span>Upload once, reuse in any post.</span></div>`}`;
    const upload = async (files) => {
      for (const f of files) {
        try { await api('/media', { raw: f, headers: { 'content-type': f.type || 'application/octet-stream', 'x-filename': encodeURIComponent(f.name) }, onProgress: () => {} }); }
        catch (e) { toast(`${f.name}: ${e.message}`, 'bad'); }
      }
      media();
    };
    $('#up', root).onclick = () => $('#f', root).click();
    $('#f', root).onchange = (e) => upload([...e.target.files]);
    const body = $('#body', root);
    body.ondragover = (e) => e.preventDefault();
    body.ondrop = (e) => { e.preventDefault(); upload([...e.dataTransfer.files]); };
    $('#grid', root)?.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const m = items.find((x) => x.id === Number(b.closest('[data-id]').dataset.id));
      if (b.dataset.act === 'use') go(`#/compose?media=${m.id}`);
      if (b.dataset.act === 'del' && await confirmBox('Delete this file? Scheduled posts using it will fail.', { ok: 'Delete', danger: true })) { await api(`/media/${m.id}`, { method: 'DELETE' }); media(); }
      if (b.dataset.act === 'alt') modal({ title: 'Alt text', body: `<textarea id="alt" rows="3" maxlength="1500" placeholder="Describe the image for people using screen readers">${esc(m.alt)}</textarea>`, actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async (d) => { await api(`/media/${m.id}`, { method: 'PATCH', body: { alt: $('#alt', d).value } }); media(); } }] });
    });
  }

  async function snippets() {
    await refresh();
    const list = state.snippets;
    $('#body', root).innerHTML = `<div class="row" style="margin-bottom:14px"><span class="text-2 small">Hashtag sets, signatures, calls to action — insert them from the composer's Snippets button.</span><button class="btn primary right" id="add">${icon('plus')} New snippet</button></div>
      ${list.length ? `<div class="list" style="margin:0 -20px">${list.map((s) => `<div class="item" data-id="${s.id}" style="grid-template-columns:minmax(0,1fr) auto"><div><b>${esc(s.name)}</b><div class="txt text-2" style="margin-top:4px">${esc(s.body)}</div></div>
        <div class="actions"><button class="btn sm ghost icon" data-act="edit" data-tip="Edit">${icon('edit')}</button><button class="btn sm ghost icon danger" data-act="del" data-tip="Delete">${icon('trash')}</button></div></div>`).join('')}</div>`
        : `<div class="empty">${icon('hash')}<b>No snippets yet</b><span>e.g. “Travel tags”: #travel #wanderlust #photography</span></div>`}`;
    const edit = (s = {}) => modal({ title: s.id ? 'Edit snippet' : 'New snippet', body: `<label class="field">Name<input type="text" id="n" value="${esc(s.name || '')}" placeholder="Travel hashtags"></label><label class="field">Text<textarea id="b" rows="4" placeholder="#travel #wanderlust">${esc(s.body || '')}</textarea></label>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async (d) => { await api(s.id ? `/snippets/${s.id}` : '/snippets', { method: s.id ? 'PUT' : 'POST', body: { name: $('#n', d).value, body: $('#b', d).value } }); snippets(); } }],
      onOpen: (d) => $('#n', d).focus() });
    $('#add', root).onclick = () => edit();
    $('#body', root).querySelector('.list')?.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const s = list.find((x) => x.id === Number(b.closest('[data-id]').dataset.id));
      if (b.dataset.act === 'edit') edit(s);
      if (b.dataset.act === 'del' && await confirmBox(`Delete “${s.name}”?`, { ok: 'Delete', danger: true })) { await api(`/snippets/${s.id}`, { method: 'DELETE' }); snippets(); }
    });
  }

  const draw = () => {
    $('#tabs', root).innerHTML = [['media', 'Media'], ['snippets', 'Snippets & hashtags']].map(([k, l]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('');
    return tab === 'media' ? media() : snippets();
  };
  $('#tabs', root).onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) { tab = b.dataset.t; draw(); } };
  await draw();
}

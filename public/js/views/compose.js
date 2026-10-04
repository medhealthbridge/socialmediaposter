import { $, $$, api, state, esc, icon, avatar, netLabel, netColor, countFor, richText, toast, toastError, busy, modal, menu, fmt, go, debounce, statusBadge, accountById, refresh, uploadFile, toLocalInput, fromLocalInput, NEEDS_BLOB } from '../core.js';

const DRAFT_KEY = 'composer-draft';

const store = {
  get() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; } },
  set(v) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  clear() { try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage unavailable */ } },
};

export async function render(root, params) {
  const s = { id: null, post: null, text: '', media: [], accountIds: new Set(), overrides: {}, customize: false, mode: 'queue', when: '', recycle: false, recycleDays: 7, recycleLeft: '', notes: '', uploads: 0 };

  if (params.get('id')) {
    const p = await api(`/posts/${params.get('id')}`);
    Object.assign(s, { id: p.id, post: p, text: p.text, media: p.mediaItems.filter((m) => !m.missing), accountIds: new Set(p.deliveries.map((d) => d.account_id)), overrides: { ...p.overrides }, customize: Object.keys(p.overrides).length > 0, notes: p.notes || '', recycle: !!p.recycle_days, recycleDays: p.recycle_days || 7, recycleLeft: p.recycle_left ?? '' });
    if (p.scheduled_at) { s.mode = 'schedule'; s.when = toLocalInput(p.scheduled_at); }
  } else {
    const saved = store.get();
    if (saved && !params.toString()) {
      Object.assign(s, { text: saved.text || '', overrides: saved.overrides || {}, customize: !!saved.customize, mode: ['now', 'schedule', 'slot'].includes(saved.mode) ? saved.mode : 'queue', when: saved.when || '', notes: saved.notes || '' });
      s.accountIds = new Set((saved.accountIds || []).filter((id) => accountById(id)));
      if (saved.media?.length) { const lib = await api('/media'); s.media = lib.filter((m) => saved.media.includes(m.id)); }
    } else {
      const last = store.get()?.accountIds || [];
      s.accountIds = new Set(last.filter((id) => accountById(id)));
    }
    if (params.get('text')) s.text = params.get('text');
    if (params.get('media')) { const ids = params.get('media').split(',').map(Number); const lib = await api('/media'); s.media = lib.filter((m) => ids.includes(m.id)); }
  }
  if (!state.accounts.length) s.mode = 'queue';
  const readOnly = s.post && ['published', 'publishing'].includes(s.post.status);

  root.innerHTML = `<div class="page">
    <div class="page-head">
      <div class="grow"><h1>${s.id ? `Edit post` : 'Create post'}</h1><p class="sub">${s.id ? `${statusBadge(s.post.status)} added ${fmt.dateTime(s.post.created_at)}` : 'Write once, publish everywhere — add it to your queue, then post when you’re ready.'}</p></div>
      ${s.id ? '' : `<button class="btn ghost sm" id="clear">${icon('x')} Clear</button>`}
    </div>
    ${readOnly ? `<div class="callout warn">${icon('info')}<div>This post is already published and can't be changed. <a href="#" id="dup">Duplicate it</a> to post it again.</div></div>` : ''}
    <div class="composer">
      <div class="col gap-lg">
        <section class="card card-pad col">
          <div class="row"><h3>Post to</h3><span class="muted small" id="selCount"></span><a class="small right" href="#/accounts">${icon('plus', '')} Connect accounts</a></div>
          <div class="row" id="accs"></div>
        </section>

        <section class="col">
          <div class="editor" id="editor">
            <textarea id="text" rows="7" placeholder="What would you like to share?" aria-label="Post text"></textarea>
            <div class="thumbs" id="thumbs"></div>
            <div class="tools">
              <button class="btn ghost sm" id="addMedia" data-tip="Add photos or videos (or drag & drop / paste)">${icon('image')} Media</button>
              <button class="btn ghost sm" id="snip" data-tip="Insert a saved hashtag set or snippet">${icon('hash')} Snippets</button>
              <button class="btn ghost sm" id="ai" data-tip="AI writing help">${icon('sparkle')} AI assist</button>
              <label class="check small" style="margin-left:6px" data-tip="Write a different version for each account"><span class="switch"><input type="checkbox" id="customize"><span></span></span> Customize per network</label>
              <div class="counts" id="counts"></div>
            </div>
            <input type="file" id="file" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime" multiple hidden>
          </div>
          <div id="overrides" class="col"></div>
        </section>

        <section class="card card-pad when-box">
          <div class="seg" id="mode">
            <button data-m="queue">${icon('queue')} Add to queue</button>
            <button data-m="schedule">${icon('clock')} Schedule</button>
            <button data-m="slot">${icon('calendar')} Next free time</button>
            <button data-m="now">${icon('send')} Post now</button>
          </div>
          <div id="whenDetail"></div>
          <div class="divider"></div>
          <label class="check"><span class="switch"><input type="checkbox" id="recycle"><span></span></span> ${icon('recycle')} Evergreen — repost this automatically</label>
          <div class="row" id="recycleBox">
            <span class="text-2 small">every</span><input type="number" id="rDays" min="1" max="365" style="width:80px"><span class="text-2 small">days,</span>
            <input type="number" id="rLeft" min="1" max="100" placeholder="∞" style="width:80px"><span class="text-2 small">more times (empty = forever)</span>
          </div>
          <details ${s.notes ? 'open' : ''}><summary class="small text-2" style="cursor:pointer">Private notes</summary><textarea id="notes" rows="2" placeholder="Only you see this" style="margin-top:8px"></textarea></details>
        </section>

        <div class="problems" id="problems"></div>
        <div class="footer-bar">
          ${s.id ? `<a class="btn ghost" href="#/queue">Cancel</a>` : ''}
          <button class="btn primary" id="submit">Post now</button>
        </div>
      </div>
      <aside class="previews" id="previews" aria-label="Previews"></aside>
    </div>
  </div>`;

  const ta = $('#text', root);
  ta.value = s.text;
  $('#notes', root).value = s.notes;
  $('#customize', root).checked = s.customize;
  $('#recycle', root).checked = s.recycle;
  $('#rDays', root).value = s.recycleDays;
  $('#rLeft', root).value = s.recycleLeft;

  const selected = () => [...s.accountIds].map(accountById).filter(Boolean);
  const textFor = (acc) => (s.customize && s.overrides[acc.id] !== undefined ? s.overrides[acc.id] : s.text);
  const persist = debounce(() => {
    if (s.id) return;
    store.set({ text: s.text, media: s.media.map((m) => m.id), accountIds: [...s.accountIds], overrides: s.overrides, customize: s.customize, mode: s.mode, when: s.when, notes: s.notes });
  }, 400);

  // ---------- accounts
  function renderAccounts() {
    const accs = state.accounts;
    $('#accs', root).innerHTML = accs.length
      ? accs.map((a) => `<button type="button" class="chip ${s.accountIds.has(a.id) ? 'on' : ''} ${a.status !== 'ok' ? 'warn' : ''}" data-id="${a.id}" aria-pressed="${s.accountIds.has(a.id)}" data-tip="${esc(`${netLabel(a.type)} · ${a.handle || a.name}${a.status !== 'ok' ? ' · needs attention' : ''}`)}">${avatar(a, 'sm')}<span class="ellipsis" style="max-width:150px">${esc(a.name)}</span></button>`).join('')
        + (accs.length > 1 ? `<button type="button" class="btn ghost sm" id="all">${s.accountIds.size === accs.length ? 'None' : 'All'}</button>` : '')
      : `<div class="callout">${icon('info')}<div>No accounts yet. <a href="#/accounts">Connect your first account</a> — you can still add this to your queue and pick accounts later.</div></div>`;
    $('#selCount', root).textContent = s.accountIds.size ? `${s.accountIds.size} selected` : '';
  }
  $('#accs', root).onclick = (e) => {
    if (e.target.closest('#all')) { s.accountIds = s.accountIds.size === state.accounts.length ? new Set() : new Set(state.accounts.map((a) => a.id)); }
    else { const c = e.target.closest('.chip'); if (!c) return; const id = Number(c.dataset.id); s.accountIds.has(id) ? s.accountIds.delete(id) : s.accountIds.add(id); }
    renderAccounts(); renderOverrides(); update();
  };

  // ---------- counters, previews, problems
  function renderCounts() {
    const types = [...new Set(selected().map((a) => a.type))];
    $('#counts', root).innerHTML = (s.customize ? [] : types).map((t) => {
      const n = countFor(t, s.text), lim = state.providers[t].limit;
      return `<span class="pill ${n > lim ? 'over' : ''}" data-tip="${esc(netLabel(t))}: ${n} of ${lim} characters"><span class="dot" style="background:${netColor(t)}"></span>${lim - n}</span>`;
    }).join('') || (s.customize ? '' : `<span class="muted small">${[...s.text].length} characters</span>`);
    $$('.override', root).forEach((el) => {
      const a = accountById(el.dataset.id); if (!a) return;
      const n = countFor(a.type, textFor(a)), lim = state.providers[a.type].limit;
      el.querySelector('.pill').className = `pill ${n > lim ? 'over' : ''}`;
      el.querySelector('.pill').textContent = `${n} / ${lim}`;
    });
  }

  const mediaHtml = (items, ig) => (items.length ? `<div class="pv-media ${ig ? 'ig' : `n${Math.min(items.length, 4)}`}">${(ig ? items.slice(0, 1) : items.slice(0, 4)).map((m) => (m.mime.startsWith('video/') ? `<video src="${esc(m.url)}" muted preload="metadata"></video>` : `<img src="${esc(m.url)}" alt="${esc(m.alt)}">`)).join('')}</div>${ig && items.length > 1 ? `<div class="center tiny muted">1 / ${items.length} · carousel</div>` : ''}` : '');
  function renderPreviews() {
    const accs = selected();
    if (!accs.length) { $('#previews', root).innerHTML = `<div class="card empty">${icon('eye')}<div>Pick accounts to see live previews.</div></div>`; return; }
    $('#previews', root).innerHTML = `<div class="row"><h3>Preview</h3><span class="muted small">how it will look</span></div>` + accs.slice(0, 8).map((a) => {
      const t = textFor(a), lim = state.providers[a.type].limit, ig = a.type === 'instagram';
      const body = `<div class="pv-text">${richText(t, lim)}</div>`;
      return `<article class="pv"><div class="pv-head">${avatar(a)}<div class="grow" style="min-width:0"><div class="pv-name ellipsis">${esc(a.name)}</div><div class="pv-handle ellipsis">${esc(a.handle || netLabel(a.type))} · now</div></div><span class="muted tiny">${esc(netLabel(a.type))}</span></div>
        ${ig ? mediaHtml(s.media, true) + body : body + mediaHtml(s.media, false)}
        ${ig && !s.media.length ? `<div class="problem">${icon('alert')}Instagram needs an image or video</div>` : ''}
        <div class="pv-foot"><span class="metric">${icon('reply')}</span><span class="metric">${icon('repost')}</span><span class="metric">${icon('heart')}</span></div></article>`;
    }).join('') + (accs.length > 8 ? `<p class="muted small center">+ ${accs.length - 8} more</p>` : '');
  }

  const checkProblems = debounce(async () => {
    const box = $('#problems', root);
    if (!box) return;
    if (!s.accountIds.size || (!s.text.trim() && !s.media.length)) { box.innerHTML = ''; return; }
    try {
      const { problems } = await api('/posts/check', { method: 'POST', body: payload() });
      box.innerHTML = problems.map((p) => `<div class="problem">${icon('alert')}<span>${esc(p)}</span></div>`).join('');
    } catch { /* offline — the server validates on submit anyway */ }
  }, 450);

  function update() { renderCounts(); renderPreviews(); checkProblems(); persist(); }
  ta.oninput = () => { s.text = ta.value; update(); };
  $('#notes', root).oninput = (e) => { s.notes = e.target.value; persist(); };

  // ---------- per-network overrides
  function renderOverrides() {
    const box = $('#overrides', root);
    if (!s.customize) { box.innerHTML = ''; return; }
    const accs = selected();
    box.innerHTML = accs.length ? accs.map((a) => `<div class="override" data-id="${a.id}">
      <div class="row">${avatar(a, 'sm')}<b class="grow ellipsis">${esc(a.name)}</b><span class="pill"></span>
        <button class="btn ghost sm" data-act="adapt" data-tip="Let AI adapt the main text for ${esc(netLabel(a.type))}">${icon('sparkle')}</button>
        <button class="btn ghost sm" data-act="reset" data-tip="Use the main text">${icon('retry')}</button></div>
      <textarea rows="3" placeholder="Same as main text">${esc(s.overrides[a.id] ?? '')}</textarea></div>`).join('')
      : '<p class="muted small">Select accounts above to customize each one.</p>';
    renderCounts();
  }
  $('#overrides', root).addEventListener('input', (e) => {
    const o = e.target.closest('.override'); if (!o) return;
    const v = e.target.value;
    if (v.trim()) s.overrides[o.dataset.id] = v; else delete s.overrides[o.dataset.id];
    update();
  });
  $('#overrides', root).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const o = b.closest('.override'); const a = accountById(o.dataset.id);
    if (b.dataset.act === 'reset') { delete s.overrides[a.id]; o.querySelector('textarea').value = ''; update(); }
    if (b.dataset.act === 'adapt') {
      busy(b, async () => {
        const pick = await aiOptions({ action: 'custom', instruction: `Adapt this post for ${netLabel(a.type)}: match the platform's style and conventions.`, text: s.text, networks: [a.type] });
        if (pick != null) { s.overrides[a.id] = pick; o.querySelector('textarea').value = pick; update(); }
      })();
    }
  });
  $('#customize', root).onchange = (e) => { s.customize = e.target.checked; renderOverrides(); update(); };

  // ---------- media
  function renderThumbs() {
    $('#thumbs', root).innerHTML = s.media.map((m, i) => `<div class="thumb" data-i="${i}">
      ${m.mime.startsWith('video/') ? `<video src="${esc(m.url)}" muted preload="metadata"></video><span class="vid">VIDEO</span>` : `<img src="${esc(m.url)}" alt="${esc(m.alt)}">`}
      <button class="x" data-act="rm" aria-label="Remove">✕</button>
      <button class="alt ${m.alt ? 'has' : ''}" data-act="alt" data-tip="${m.alt ? esc(m.alt) : 'Add a description for screen readers'}">ALT</button></div>`).join('')
      + Array.from({ length: s.uploads }, () => '<div class="thumb uploading"><span>Uploading…</span><span class="bar" style="width:0"></span></div>').join('');
  }
  async function addFiles(files) {
    for (const f of files) {
      s.uploads++; renderThumbs();
      try {
        const m = await uploadFile(f, (p) => { const bars = $$('.thumb.uploading .bar', root); if (bars[0]) bars[0].style.width = `${Math.round(p * 100)}%`; });
        s.media.push(m);
      } catch (e) { toastError(e); }
      s.uploads--; renderThumbs(); update();
    }
  }
  $('#addMedia', root).onclick = (e) => (state.storage === 'none' ? toast(NEEDS_BLOB, 'bad') : menu(e.currentTarget, [
    { label: 'Upload from device', icon: 'upload', onClick: () => $('#file', root).click() },
    { label: 'Choose from library', icon: 'image', onClick: pickFromLibrary },
  ]));
  $('#file', root).onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  const ed = $('#editor', root);
  ed.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); ed.classList.add('drag'); } });
  ed.addEventListener('dragleave', () => ed.classList.remove('drag'));
  ed.addEventListener('drop', (e) => { e.preventDefault(); ed.classList.remove('drag'); addFiles([...e.dataTransfer.files]); });
  ta.addEventListener('paste', (e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); addFiles(files); } });
  $('#thumbs', root).onclick = (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const i = Number(b.closest('.thumb').dataset.i), m = s.media[i];
    if (b.dataset.act === 'rm') { s.media.splice(i, 1); renderThumbs(); update(); }
    if (b.dataset.act === 'alt') {
      modal({ title: 'Describe this image', body: `<p class="text-2 small">Alt text helps people using screen readers. It's sent to networks that support it.</p><textarea id="altText" rows="3" maxlength="1500">${esc(m.alt)}</textarea>`,
        actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async (d) => { const r = await api(`/media/${m.id}`, { method: 'PATCH', body: { alt: $('#altText', d).value } }); m.alt = r.alt; renderThumbs(); renderPreviews(); } }],
        onOpen: (d) => $('#altText', d).focus() });
    }
  };
  async function pickFromLibrary() {
    const lib = await api('/media');
    const chosen = new Set();
    modal({ title: 'Media library', wide: true,
      body: lib.length ? `<div class="media-grid" id="pick">${lib.map((m) => `<div class="media-card" data-id="${m.id}" role="button" tabindex="0"><div class="pic">${m.mime.startsWith('video/') ? `<video src="${esc(m.url)}" muted preload="metadata"></video>` : `<img src="${esc(m.url)}" alt="" loading="lazy">`}</div><div class="meta ellipsis">${esc(m.filename)}</div></div>`).join('')}</div>` : '<div class="empty">Your library is empty — upload something first.</div>',
      actions: [{ label: 'Cancel' }, { label: 'Add selected', kind: 'primary', onClick: () => { for (const m of lib) if (chosen.has(m.id) && !s.media.some((x) => x.id === m.id)) s.media.push(m); renderThumbs(); update(); } }],
      onOpen: (d) => { $('#pick', d)?.addEventListener('click', (e) => { const c = e.target.closest('.media-card'); if (!c) return; const id = Number(c.dataset.id); chosen.has(id) ? chosen.delete(id) : chosen.add(id); c.classList.toggle('sel'); }); } });
  }

  // ---------- snippets
  function insertAtCursor(txt) {
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const pre = value.slice(0, a), sep = pre && !/\s$/.test(pre) ? (txt.startsWith('#') ? ' ' : '\n\n') : '';
    ta.value = pre + sep + txt + value.slice(b);
    ta.selectionStart = ta.selectionEnd = (pre + sep + txt).length;
    ta.focus(); s.text = ta.value; update();
  }
  $('#snip', root).onclick = (e) => menu(e.currentTarget, [
    ...(state.snippets.length ? [{ heading: 'Insert' }, ...state.snippets.map((sn) => ({ label: sn.name, onClick: () => insertAtCursor(sn.body) })), 'sep'] : []),
    { label: 'Save selection as snippet…', icon: 'plus', onClick: saveSnippet },
    { label: 'Manage snippets', icon: 'settings', onClick: () => go('#/library?tab=snippets') },
  ]);
  function saveSnippet() {
    const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd) || ta.value;
    if (!sel.trim()) return toast('Write or select some text first');
    modal({ title: 'Save snippet', body: `<label class="field">Name<input id="snName" type="text" placeholder="e.g. Travel hashtags"></label><label class="field">Text<textarea id="snBody" rows="3">${esc(sel)}</textarea></label>`,
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: async (d) => { await api('/snippets', { method: 'POST', body: { name: $('#snName', d).value, body: $('#snBody', d).value } }); await refresh(); toast('Snippet saved', 'ok'); } }],
      onOpen: (d) => $('#snName', d).focus() });
  }

  // ---------- AI
  async function aiOptions(body) {
    let res;
    try { res = await api('/ai', { method: 'POST', body }); }
    catch (e) {
      if (/API key/.test(e.message)) {
        modal({ title: 'Set up the AI assistant', body: `<p class="text-2">Add an API key in Settings — Google Gemini has a free tier, or you can use Anthropic Claude. It is stored encrypted on your server.</p>`, actions: [{ label: 'Later' }, { label: 'Open settings', kind: 'primary', onClick: () => go('#/settings?s=ai') }] });
        return null;
      }
      throw e;
    }
    return new Promise((resolve) => {
      let picked = null;
      const m = modal({ title: `${icon('sparkle')} Suggestions`, wide: true,
        body: res.options.map((o, i) => `<div class="option"><p>${esc(o)}</p><div class="row"><span class="muted tiny">${[...o].length} characters</span><button class="btn sm primary right" data-pick="${i}">Use this</button></div></div>`).join(''),
        actions: [{ label: 'Close' }],
        onOpen: (d, close) => d.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) { picked = res.options[b.dataset.pick]; close(); } }) });
      m.el.addEventListener('close', () => resolve(picked));
    });
  }
  const types = () => [...new Set(selected().map((a) => a.type))];
  const runAi = async (body) => {
    const btn = $('#ai', root);
    btn.classList.add('loading');
    try {
      const pick = await aiOptions({ ...body, networks: types() });
      if (pick != null) { ta.value = s.text = pick; update(); }
    } catch (e) { toastError(e); } finally { btn.classList.remove('loading'); }
  };
  const askThen = (title, placeholder, fn) => modal({ title, body: `<textarea id="aiIn" rows="3" placeholder="${esc(placeholder)}"></textarea>`,
    actions: [{ label: 'Cancel' }, { label: 'Generate', kind: 'primary', onClick: (d) => { const v = $('#aiIn', d).value.trim(); if (!v) return false; fn(v); } }],
    onOpen: (d) => $('#aiIn', d).focus() });
  $('#ai', root).onclick = (e) => menu(e.currentTarget, [
    { label: 'Write from an idea…', icon: 'compose', onClick: () => askThen('What should the post be about?', 'e.g. our new summer menu launches Friday, 20% off for the first week', (v) => runAi({ action: 'write', instruction: v, text: s.text })) },
    'sep',
    { label: 'Improve', icon: 'sparkle', onClick: () => runAi({ action: 'improve', text: s.text }) },
    { label: 'Shorten', onClick: () => runAi({ action: 'shorten', text: s.text }) },
    { label: 'Add hashtags', icon: 'hash', onClick: () => runAi({ action: 'hashtags', text: s.text }) },
    { label: 'Make it more engaging (hook)', onClick: () => runAi({ action: 'thread', text: s.text }) },
    { heading: 'Change tone' },
    ...['friendly', 'professional', 'funny', 'bold', 'inspirational'].map((tone) => ({ label: tone[0].toUpperCase() + tone.slice(1), onClick: () => runAi({ action: 'tone', tone, text: s.text }) })),
    'sep',
    { label: 'Custom instruction…', onClick: () => askThen('Tell the AI what to do', 'e.g. translate to Spanish, or add a call to action', (v) => runAi({ action: 'custom', instruction: v, text: s.text })) },
  ]);

  // ---------- when to post
  function renderWhen() {
    $$('#mode button', root).forEach((b) => b.classList.toggle('on', b.dataset.m === s.mode));
    const n = s.accountIds.size;
    const box = $('#whenDetail', root);
    if (s.mode === 'now') {
      box.innerHTML = `<p class="text-2 small">Publishes right away${n ? ` to ${n} account${n > 1 ? 's' : ''}` : ''} — you'll see the result in a few seconds.</p>`;
    } else if (s.mode === 'queue') {
      box.innerHTML = `<p class="text-2 small">Saved to your queue${state.counts.queued ? ` (${state.counts.queued} already waiting)` : ''}. Post it with one click whenever you're ready.</p>`;
    } else if (s.mode === 'slot') {
      box.innerHTML = state.slots.length
        ? `<p class="text-2 small">Goes out at your next free posting time: <b>${state.nextSlot ? fmt.dateTime(state.nextSlot) : '—'}</b>. <a href="#/settings?s=schedule">Edit times</a></p>`
        : `<div class="callout">${icon('info')}<div>Set your weekly posting times once, then just pick this. <a href="#/settings?s=schedule">Set up posting times</a></div></div>`;
    } else {
      if (!s.when) { const t = new Date(Date.now() + 3600e3); t.setMinutes(0, 0, 0); s.when = toLocalInput(t.toISOString()); }
      box.innerHTML = `<div class="row"><input type="datetime-local" id="when" value="${esc(s.when)}" style="max-width:240px"><span class="muted small">${esc(state.user.tz)}</span></div>
        <p class="hint" id="autoNote"></p>`;
      $('#when', box).onchange = (e) => { s.when = e.target.value; persist(); renderWhen(); };
      $('#autoNote', box).innerHTML = state.settings.autoPublish
        ? 'Published automatically at that time.'
        : `Automatic publishing is not switched on yet, so this will wait for you. <a href="#/settings?s=schedule">Turn it on</a> (free, takes a minute).`;
    }
    $('#submit', root).innerHTML = s.id
      ? (s.mode === 'now' ? `${icon('send')} Save & post now` : 'Save changes')
      : ({ now: `${icon('send')} Post now`, queue: `${icon('queue')} Add to queue`, schedule: `${icon('clock')} Schedule`, slot: `${icon('calendar')} Schedule` }[s.mode]);
    checkProblems();
  }
  $('#mode', root).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; s.mode = b.dataset.m; renderWhen(); persist(); };
  const syncRecycle = () => { $('#recycleBox', root).hidden = !$('#recycle', root).checked; };
  $('#recycle', root).onchange = syncRecycle; syncRecycle();

  // ---------- submit
  function payload() {
    return { text: s.text, media: s.media.map((m) => m.id), accountIds: [...s.accountIds], overrides: s.customize ? s.overrides : {} };
  }
  $('#submit', root).onclick = busy($('#submit', root), async () => {
    if (s.uploads) return toast('Wait for uploads to finish');
    const body = {
      ...payload(), notes: s.notes,
      publishNow: s.mode === 'now',
      useSlot: s.mode === 'slot',
      recycleDays: $('#recycle', root).checked ? Number($('#rDays', root).value) || 7 : null,
      recycleLeft: $('#recycle', root).checked && $('#rLeft', root).value ? Number($('#rLeft', root).value) : null,
    };
    if (s.mode === 'schedule') {
      if (!s.when) throw new Error('Pick a date and time');
      body.scheduledAt = fromLocalInput(s.when);
      if (new Date(body.scheduledAt) < new Date(Date.now() - 60e3)) throw new Error('That time is in the past');
    } else if (s.mode !== 'now' && s.id) body.scheduledAt = null;
    try {
      const p = s.id ? await api(`/posts/${s.id}`, { method: 'PUT', body }) : await api('/posts', { method: 'POST', body });
      store.clear();
      if (!s.id) store.set({ accountIds: [...s.accountIds] }); // remember the account selection
      if (s.mode === 'now') {
        const ok = p.deliveries.filter((d) => d.status === 'published').length, bad = p.deliveries.filter((d) => d.status === 'failed');
        if (bad.length) toast(`Posted to ${ok} of ${p.deliveries.length}. Failed: ${bad.map((d) => `${d.account_name} (${d.error})`).join('; ')}`, 'bad');
        else toast(`Posted to ${ok} account${ok === 1 ? '' : 's'} ✓`, 'ok');
      } else if (p.status === 'scheduled') toast(`Scheduled for ${fmt.dateTime(p.scheduled_at)}`, 'ok');
      else toast(s.id ? 'Saved' : 'Added to your queue', 'ok');
      await refresh();
      go(s.mode === 'now' ? `#/queue?tab=${p.status === 'published' ? 'published' : 'failed'}` : p.status === 'scheduled' ? '#/queue?tab=scheduled' : '#/queue');
    } catch (e) {
      if (e.data?.problems) $('#problems', root).innerHTML = e.data.problems.map((p) => `<div class="problem">${icon('alert')}<span>${esc(p)}</span></div>`).join('');
      throw e;
    }
  });

  $('#clear', root)?.addEventListener('click', () => { store.clear(); go('#/compose?new=' + Date.now()); });
  $('#dup', root)?.addEventListener('click', async (e) => { e.preventDefault(); const d = await api(`/posts/${s.id}/duplicate`, { method: 'POST' }); go(`#/compose?id=${d.id}`); });
  if (readOnly) $$('textarea, input, .seg button, #submit, .tools .btn', root).forEach((el) => { el.disabled = true; });

  renderAccounts(); renderThumbs(); renderOverrides(); renderWhen(); update();
  if (!readOnly) ta.focus();
}

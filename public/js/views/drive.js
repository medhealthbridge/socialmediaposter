/**
 * Import clips from a Google Drive folder.
 *
 * The convention is one text file beside each video, with the same name: the video's
 * description. Paste a folder link, see every pair, import one — the video lands in your
 * library and its description goes straight into the composer.
 */
import { $, api, state, esc, icon, fmt, toast, busy, modal, go } from '../core.js';

const LAST_LINK = 'drive-last-link';
const remember = { get() { try { return localStorage.getItem(LAST_LINK) || ''; } catch { return ''; } },
  set(v) { try { localStorage.setItem(LAST_LINK, v); } catch { /* storage unavailable */ } } };

const secs = (n) => (n == null ? '' : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`);

export const SETUP_STEPS = [
  'Open <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer noopener">Google Cloud → Drive API</a> and click <b>Enable</b> (make a project first if you have none — it is free and needs no card).',
  'Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer noopener">Credentials</a> → <b>Create credentials</b> → <b>API key</b>, and copy it.',
  'Paste the key in <b>Settings → Integrations → Google Drive</b>.',
  'In Drive, right-click your folder → <b>Share</b> → <b>Anyone with the link</b> → <b>Copy link</b>, and paste it here.',
];

/** The "how do I set this up" panel, also shown from Settings. */
export const setupHtml = () => `<ol class="steps">${SETUP_STEPS.map((x) => `<li>${x}</li>`).join('')}</ol>`;

/**
 * Pick a clip from Drive. Resolves with { media, description } or null.
 * Used by the composer's "Start from → Google Drive" and by this page.
 */
export function pickFromDrive() {
  return new Promise((resolve) => {
    let picked = null;
    const m = modal({
      title: 'Import from Google Drive', wide: true,
      body: `<div class="row"><input type="url" id="link" class="grow" placeholder="Paste a Drive folder link" value="${esc(remember.get())}">
          <button class="btn" id="load">${icon('download')} Open</button></div>
        <p class="hint">Each video takes its description from the text file with the same name beside it — <code>clip.mp4</code> + <code>clip.txt</code>.</p>
        <div id="out"></div>`,
      actions: [{ label: 'Close' }],
      onOpen: (d) => {
        const out = $('#out', d);
        const load = busy($('#load', d), async () => {
          const link = $('#link', d).value.trim();
          if (!link) return toast('Paste a Drive link first');
          out.innerHTML = `<div class="empty"><span>Looking in Drive…</span></div>`;
          let res;
          try { res = await api(`/drive?link=${encodeURIComponent(link)}`); }
          catch (e) { out.innerHTML = `<div class="callout warn">${icon('alert')}<div>${esc(e.message)}</div></div>${helpBox()}`; return; }
          remember.set(link);
          out.innerHTML = itemList(res);
          out.onclick = async (e) => {
            const b = e.target.closest('[data-id]'); if (!b) return;
            const item = res.items.find((x) => x.id === b.dataset.id);
            await busy(b, async () => {
              const got = await api('/drive/import', { method: 'POST', body: { fileId: item.id, textId: item.textId } });
              picked = got;
              toast(`“${item.name}” imported`, 'ok');
              d.close();
            })();
          };
        });
        $('#load', d).onclick = load;
        $('#link', d).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); load(); } };
        if (remember.get()) load();
        else $('#link', d).focus();
      },
    });
    m.el.addEventListener('close', () => resolve(picked));
  });
}

const helpBox = () => `<details class="card card-pad" style="margin-top:12px"><summary style="cursor:pointer"><b>How to set this up</b></summary>${setupHtml()}</details>`;

function itemList(res) {
  if (!res.items.length) {
    return `<div class="empty">${icon('download')}<b>Nothing to import here</b>
      <span>That folder has no MP4, MOV or picture files in it.</span></div>${helpBox()}`;
  }
  const missing = res.items.filter((i) => !i.textId).length;
  return `<div class="row small text-2" style="margin:10px 0 6px">
      ${res.folder ? `${icon('image')} <b>${esc(res.folder)}</b> ·` : ''} ${res.items.length} file${res.items.length === 1 ? '' : 's'}
      ${missing ? `<span class="right" style="color:var(--warn)">${missing} with no description file</span>` : ''}</div>
    <div class="list" style="margin:0 -20px;max-height:52vh;overflow:auto">
    ${res.items.map((i) => `<div class="item" style="grid-template-columns:auto minmax(0,1fr) auto">
      <span class="netmark" style="background:${i.kind === 'video' ? '#6d28d9' : '#0e7490'}">${i.kind === 'video' ? '▶' : '◻'}</span>
      <div style="min-width:0"><b class="ellipsis">${esc(i.name)}</b>
        <div class="muted small">${i.size ? fmt.bytes(i.size) : ''}${i.duration ? ` · ${secs(i.duration)}` : ''}${i.modifiedAt ? ` · ${fmt.rel(i.modifiedAt)}` : ''}</div>
        <div class="small" style="margin-top:4px">${i.textId
          ? `<span style="color:var(--ok)">${icon('check')} description from ${esc(i.textName)}</span>`
          : `<span class="muted">${icon('info')} no matching .txt — you'll write the description yourself</span>`}</div></div>
      <button class="btn sm primary" data-id="${esc(i.id)}">${icon('download')} Import</button></div>`).join('')}
    </div>`;
}

export async function render(root) {
  const hasKey = state.settings?.drive?.hasKey;
  root.innerHTML = `<div class="page">
    <div class="page-head"><div class="grow"><h1>Google Drive</h1>
      <p class="sub">Drop your clips in a Drive folder with a text file of the same name for each description, then import them here.</p></div>
      ${hasKey ? `<button class="btn primary" id="open">${icon('download')} Import a clip</button>` : `<a class="btn primary" href="#/settings?s=integrations">${icon('key')} Add your API key</a>`}</div>
    ${hasKey ? '' : `<div class="callout warn">${icon('alert')}<div>No Google API key yet. It is free and takes about two minutes.</div></div>`}
    <div class="card card-pad"><h3 style="margin-top:0">How it works</h3>
      <p class="text-2">In Drive, keep each video next to a text file with the same name:</p>
      <pre class="code">my-folder/
  launch-day.mp4
  launch-day.txt   ← the description for launch-day.mp4
  behind-scenes.mov
  behind-scenes.txt</pre>
      <p class="text-2">Import a clip and both arrive together: the video in your library, the text in the composer — where you can proofread it with one click before posting to every account you've linked.</p>
      ${setupHtml()}</div>
  </div>`;
  $('#open', root)?.addEventListener('click', async () => {
    const got = await pickFromDrive();
    if (!got) return;
    let text = got.description || '';
    // If the description was proofread on the way in, show the fixes before the composer opens.
    if (got.grammar?.changed) {
      const { showProof } = await import('../proof.js');
      text = (await showProof(got.grammar)) ?? text;
    } else if (got.grammarError) {
      toast(`Imported, but the grammar check failed: ${got.grammarError}`, 'bad');
    }
    go(`#/compose?media=${got.media.id}${text ? `&text=${encodeURIComponent(text)}` : ''}`);
  });
}

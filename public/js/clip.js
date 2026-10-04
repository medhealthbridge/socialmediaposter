/**
 * Turn a long video into a short vertical clip for TikTok, Reels and Shorts.
 *
 * All the work happens in your browser using ffmpeg compiled to WebAssembly, so the
 * video never goes to the server for processing and this still runs on a free host.
 * The first use downloads the video engine (about 32 MB), which the browser then caches.
 */
import { $, $$, esc, icon, modal, toast, uploadFile } from './core.js';
import { MAX_SECONDS, SHAPES, clipArgs, fmtTime } from './clipargs.js';

const CORE_VERSION = '0.12.10';
const LOCAL_CORE = '/vendor/ffmpeg-core';
const CDN_CORE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

let enginePromise = null;
let onEncodeProgress = null;

/** Loads ffmpeg once per page. Prefers a local copy, falls back to the public CDN. */
async function engine(onProgress) {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    const { FFmpeg } = await import('/vendor/ffmpeg/index.js');
    const { toBlobURL } = await import('/vendor/ffmpeg/util/index.js');
    let base = CDN_CORE;
    try {
      const probe = await fetch(`${LOCAL_CORE}/ffmpeg-core.js`, { method: 'HEAD' });
      if (probe.ok) base = LOCAL_CORE;
    } catch { /* use the CDN */ }
    const ff = new FFmpeg();
    ff.on('log', ({ message }) => console.debug('[ffmpeg]', message));
    // One listener for the life of the page; each clip swaps in its own reporter.
    ff.on('progress', (e) => onEncodeProgress?.(e));
    await ff.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript', true, (e) => onProgress?.(e.received / (e.total || 33e6))),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm', true, (e) => onProgress?.(e.received / (e.total || 33e6))),
    });
    return ff;
  })().catch((e) => { enginePromise = null; throw e; });
  return enginePromise;
}

/** Opens the clip maker for a video already in your library. Resolves with the new clip, or null. */
export async function makeClip(item) {
  if (!item.mime.startsWith('video/')) { toast('Pick a video to clip'); return null; }
  let made = null;

  return new Promise((resolve) => {
    let settled = false;
    const m = modal({
      title: `Make a clip from ${esc(item.filename)}`, wide: true,
      body: `
        <video id="src" src="${esc(item.url)}" controls playsinline style="width:100%;max-height:46vh;border-radius:10px;background:#000"></video>
        <div class="row"><button class="btn sm" id="setStart">${icon('clock')} Start here</button><button class="btn sm" id="setEnd">${icon('clock')} End here</button>
          <span class="right muted small" id="range">—</span></div>
        <label class="field">Shape<div class="row" id="shapes">${SHAPES.map((s, i) => `<button type="button" class="chip plain ${i === 0 ? 'on' : ''}" data-s="${s.id}" ${s.hint ? `data-tip="${esc(s.hint)}"` : ''}>${esc(s.label)}</button>`).join('')}</div></label>
        <label class="check"><span class="switch"><input type="checkbox" id="mute"><span></span></span> Remove the sound</label>
        <div id="progress" class="hint"></div>`,
      actions: [
        { label: 'Cancel' },
        { label: `${icon('send')} Make the clip`, kind: 'primary', onClick: async (d) => {
          const start = Number(d.dataset.start || 0);
          const end = Number(d.dataset.end || 0);
          if (!(end > start)) { toast('Set a start and an end first', 'bad'); return false; }
          if (end - start > MAX_SECONDS) { toast(`Clips are limited to ${MAX_SECONDS / 60} minutes`, 'bad'); return false; }
          const note = $('#progress', d);
          const say = (t) => { note.textContent = t; };
          try {
            say('Getting the video engine ready (first time only, about 32 MB)…');
            const ff = await engine((p) => say(`Downloading the video engine… ${Math.round(p * 100)}%`));
            say('Reading your video…');
            const buf = new Uint8Array(await (await fetch(item.url)).arrayBuffer());
            await ff.writeFile('in.mp4', buf);
            const total = end - start;
            onEncodeProgress = ({ time }) => say(`Making the clip… ${Math.min(99, Math.round((time / 1e6 / total) * 100))}%`);
            say('Making the clip…');
            const code = await ff.exec(clipArgs({ start, end, shape: $('#shapes .on', d).dataset.s, mute: $('#mute', d).checked }));
            if (code !== 0) throw new Error('the video could not be converted — it may use an unusual format');
            onEncodeProgress = null;
            const out = await ff.readFile('out.mp4');
            await ff.deleteFile('in.mp4').catch(() => {});
            await ff.deleteFile('out.mp4').catch(() => {});
            say('Uploading…');
            const name = `${item.filename.replace(/\.[^.]+$/, '')}-clip.mp4`;
            made = await uploadFile(new File([new Blob([out.buffer], { type: 'video/mp4' })], name, { type: 'video/mp4' }));
            toast('Clip saved to your library', 'ok');
          } catch (e) {
            onEncodeProgress = null;
            console.error(e);
            toast(`Could not make the clip: ${e.message}`, 'bad');
            say('');
            return false;
          }
        } },
      ],
      onOpen: (d) => {
        const v = $('#src', d);
        const show = () => {
          const s = Number(d.dataset.start || 0), e = Number(d.dataset.end || 0);
          $('#range', d).textContent = e > s ? `${fmtTime(s)} → ${fmtTime(e)}  (${(e - s).toFixed(1)}s)` : 'Play the video, then mark a start and an end';
        };
        v.onloadedmetadata = () => { d.dataset.start = '0'; d.dataset.end = String(Math.min(30, v.duration)); show(); };
        // Some browsers cannot play some formats. Say so rather than leaving an empty player.
        v.onerror = () => { $('#range', d).textContent = 'This browser cannot play this video, so it cannot be clipped here.'; };
        $('#setStart', d).onclick = () => { d.dataset.start = String(v.currentTime); if (Number(d.dataset.end) <= v.currentTime) d.dataset.end = String(Math.min(v.duration, v.currentTime + 30)); show(); };
        $('#setEnd', d).onclick = () => { d.dataset.end = String(v.currentTime); show(); };
        $('#shapes', d).onclick = (e) => { const b = e.target.closest('[data-s]'); if (!b) return; $$('#shapes .chip', d).forEach((c) => c.classList.toggle('on', c === b)); };
        show();
      },
    });
    m.el.addEventListener('close', () => { if (!settled) { settled = true; resolve(made); } });
  });
}

/**
 * Crop and resize pictures in the browser, so they fit each network's shape.
 * Nothing is sent anywhere until you save: the cropped copy is uploaded as a new file,
 * and the original is left untouched.
 */
import { $, $$, esc, icon, modal, toast, uploadFile } from './core.js';

export const RATIOS = [
  { id: 'free', label: 'Original', value: null, hint: '' },
  { id: '1:1', label: 'Square 1:1', value: 1, hint: 'Instagram, Pinterest, Facebook' },
  { id: '4:5', label: 'Portrait 4:5', value: 4 / 5, hint: 'Instagram — takes the most space in the feed' },
  { id: '9:16', label: 'Vertical 9:16', value: 9 / 16, hint: 'TikTok, Reels, Shorts, Stories' },
  { id: '16:9', label: 'Wide 16:9', value: 16 / 9, hint: 'YouTube, X, LinkedIn' },
  { id: '2:3', label: 'Tall 2:3', value: 2 / 3, hint: 'Pinterest pins' },
];
const MAX_SIDE = 2560;   // plenty for every network, keeps files small

const loadImage = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('could not open that image'));
  img.src = url;
});

/**
 * Opens the cropper. Resolves with the newly uploaded media item, or null if cancelled.
 */
export async function cropImage(item) {
  if (!item.mime.startsWith('image/')) { toast('Only pictures can be cropped'); return null; }
  let img;
  try { img = await loadImage(item.url); } catch (e) { toast(e.message, 'bad'); return null; }

  // view = the crop rectangle in picture coordinates
  let ratio = null, zoom = 1, cx = img.width / 2, cy = img.height / 2;
  let saved = null;

  return new Promise((resolve) => {
    let settled = false;
    let renderCrop = null;   // set once the dialog is open
    const m = modal({
      title: `Crop ${esc(item.filename)}`, wide: true,
      body: `
        <div class="row" id="ratios">${RATIOS.map((r) => `<button type="button" class="chip plain ${r.id === 'free' ? 'on' : ''}" data-r="${r.id}" ${r.hint ? `data-tip="${esc(r.hint)}"` : ''}>${esc(r.label)}</button>`).join('')}</div>
        <div class="cropper"><canvas id="cv"></canvas></div>
        <label class="field">Zoom<input type="range" id="zoom" min="100" max="400" value="100"></label>
        <p class="hint" id="size"></p>`,
      actions: [
        { label: 'Cancel' },
        { label: `${icon('check')} Save as a new picture`, kind: 'primary', onClick: async () => {
          const blob = await renderCrop(true);
          const name = item.filename.replace(/\.[^.]+$/, '') + (ratio ? `-${RATIOS.find((r) => r.value === ratio).id.replace(':', 'x')}` : '-crop') + (blob.type === 'image/png' ? '.png' : '.jpg');
          saved = await uploadFile(new File([blob], name, { type: blob.type }));
          toast('Cropped picture saved to your library', 'ok');
        } },
      ],
      onOpen: (d) => {
        const cv = $('#cv', d);
        const ctx = cv.getContext('2d');

        /** The crop rectangle, clamped so it always stays inside the picture. */
        function rect() {
          const r = ratio || img.width / img.height;
          // start from the biggest box of this shape that fits, then apply zoom
          let w = Math.min(img.width, img.height * r);
          let h = w / r;
          if (h > img.height) { h = img.height; w = h * r; }
          w /= zoom; h /= zoom;
          const x = Math.min(Math.max(cx - w / 2, 0), img.width - w);
          const y = Math.min(Math.max(cy - h / 2, 0), img.height - h);
          return { x, y, w, h };
        }

        async function render(final = false) {
          const { x, y, w, h } = rect();
          if (!final) {
            // preview: the picture dimmed, with the chosen area bright
            const scale = Math.min(620 / img.width, 420 / img.height, 1);
            cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
            ctx.clearRect(0, 0, cv.width, cv.height);
            ctx.globalAlpha = 0.3; ctx.drawImage(img, 0, 0, cv.width, cv.height); ctx.globalAlpha = 1;
            ctx.drawImage(img, x, y, w, h, x * scale, y * scale, w * scale, h * scale);
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
            ctx.strokeRect(x * scale, y * scale, w * scale, h * scale);
            const k = Math.min(1, MAX_SIDE / Math.max(w, h));
            const ow = Math.round(w * k), oh = Math.round(h * k);
            $('#size', d).innerHTML = `Will be saved at ${ow} × ${oh} pixels`
              + (Math.min(ow, oh) < 480 ? ` — <span style="color:var(--warn)">that is small; networks may show it blurry. Zoom out or start from a bigger picture.</span>` : '');
            return null;
          }
          const out = document.createElement('canvas');
          const k = Math.min(1, MAX_SIDE / Math.max(w, h));
          out.width = Math.round(w * k); out.height = Math.round(h * k);
          const octx = out.getContext('2d');
          octx.imageSmoothingQuality = 'high';
          if (item.mime !== 'image/png') { octx.fillStyle = '#fff'; octx.fillRect(0, 0, out.width, out.height); }
          octx.drawImage(img, x, y, w, h, 0, 0, out.width, out.height);
          const type = item.mime === 'image/png' ? 'image/png' : 'image/jpeg';
          return new Promise((res) => out.toBlob(res, type, 0.92));
        }
        renderCrop = render;

        $('#ratios', d).onclick = (e) => {
          const b = e.target.closest('[data-r]'); if (!b) return;
          ratio = RATIOS.find((r) => r.id === b.dataset.r).value;
          $$('#ratios .chip', d).forEach((c) => c.classList.toggle('on', c === b));
          render();
        };
        $('#zoom', d).oninput = (e) => { zoom = Number(e.target.value) / 100; render(); };

        // drag to choose which part of the picture to keep
        let dragging = false, last = null;
        const toPic = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * img.width, y: (e.clientY - r.top) / r.height * img.height }; };
        cv.addEventListener('pointerdown', (e) => { dragging = true; last = toPic(e); cv.setPointerCapture(e.pointerId); });
        cv.addEventListener('pointermove', (e) => {
          if (!dragging) return;
          const p = toPic(e);
          cx -= p.x - last.x; cy -= p.y - last.y; last = p;
          render();
        });
        cv.addEventListener('pointerup', () => { dragging = false; });
        render();
      },
    });
    m.el.addEventListener('close', () => { if (!settled) { settled = true; resolve(saved); } });
  });
}

/**
 * Download the video engine (ffmpeg compiled to WebAssembly) into public/vendor/ffmpeg-core.
 *
 * Optional. Without it the clip maker loads the engine from the jsDelivr CDN on first use,
 * which is fine and keeps the repository small. Run `npm run vendor:ffmpeg` if you would
 * rather serve it yourself — offline, behind a strict network, or to avoid the CDN entirely.
 * The files are about 32 MB together and are deliberately not committed.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const VERSION = '0.12.10';
const BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${VERSION}/dist/esm`;
const OUT = join(import.meta.dirname, '..', 'public', 'vendor', 'ffmpeg-core');

await mkdir(OUT, { recursive: true });
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  process.stdout.write(`${name} … `);
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`${BASE}/${name} replied ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await writeFile(join(OUT, name), bytes);
  console.log(`${(bytes.length / 1e6).toFixed(1)} MB`);
}
console.log(`\nSaved to public/vendor/ffmpeg-core. The clip maker will now use this copy.`);

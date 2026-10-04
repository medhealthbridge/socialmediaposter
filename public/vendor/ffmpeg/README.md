# ffmpeg.wasm library files

Copied, unmodified, from the ESM builds of two npm packages so the clip maker needs no
build step and no bundler:

- `*.js` (this folder) — [`@ffmpeg/ffmpeg`](https://github.com/ffmpegwasm/ffmpeg.wasm) 0.12.15, MIT
- `util/*.js` — `@ffmpeg/util` 0.12.2, MIT

The engine itself (`@ffmpeg/core` 0.12.10, LGPL-2.1 — about 32 MB) is **not** here. It is
loaded from the jsDelivr CDN the first time you make a clip, or from `../ffmpeg-core/` if
you ran `npm run vendor:ffmpeg` to download it.

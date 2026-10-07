/**
 * Media storage with three modes:
 *   - disk:  files in data/media, served from /media/<token>.<ext>   (self-hosting)
 *   - blob:  Vercel Blob (when BLOB_READ_WRITE_TOKEN is set); the browser uploads directly,
 *            so large videos never pass through a size-limited serverless function.
 *   - none:  a read-only host (Vercel) with no Blob store connected. Text posting works;
 *            uploads report what to connect instead of crashing the app.
 */
import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { readFile, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { httpError } from './errors.js';
import { inList } from './db.js';

export const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };
const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_VIDEO = 1024 * 1024 * 1024;
const BLOB_HOST = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i;

/** Check the file really is what it claims to be, so we never serve e.g. HTML. */
export function sniff(buf) {
  const hex = buf.subarray(0, 12).toString('hex');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 8).toString() === 'ftyp') return buf.subarray(8, 10).toString() === 'qt' ? 'video/quicktime' : 'video/mp4';
  return null;
}
/**
 * Read just enough of a stream to identify the file, then give back an equivalent stream
 * with those first bytes put back. Lets us check a file we are only passing through.
 */
async function sniffStream(chunks) {
  const it = chunks[Symbol.asyncIterator] ? chunks[Symbol.asyncIterator]() : chunks[Symbol.iterator]();
  const seen = [];
  let head = Buffer.alloc(0);
  while (head.length < 16) {
    const { value, done } = await it.next();
    if (done) break;
    const buf = Buffer.from(value);
    seen.push(buf);
    head = Buffer.concat([head, buf]);
  }
  async function* rest() {
    for (const b of seen) yield b;
    for (let r = await it.next(); !r.done; r = await it.next()) yield Buffer.from(r.value);
  }
  return { mime: sniff(head), rest };
}

const cleanName = (n) => String(n || 'upload').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload';

export function createMedia(db, { dir = process.env.MEDIA_DIR || 'data/media', blobToken = process.env.BLOB_READ_WRITE_TOKEN } = {}) {
  const kind = blobToken ? 'blob' : process.env.VERCEL && !process.env.MEDIA_DIR ? 'none' : 'disk';
  const NEEDS_BLOB = 'Photos and videos need a Blob store. In your Vercel project open Storage → connect Blob, then redeploy.';
  let dirReady = false;
  const ensureDir = () => {
    if (dirReady) return;
    try { mkdirSync(dir, { recursive: true }); dirReady = true; }
    catch (e) { throw httpError(500, `cannot write to the media folder (${dir}): ${e.message}`); }
  };
  const file = (r) => join(dir, `${r.token}.${TYPES[r.mime]}`);
  const urlOf = (r, base = '') => r.url || `${base}/media/${r.token}.${TYPES[r.mime]}`;
  const view = (r) => ({ id: r.id, filename: r.filename, mime: r.mime, size: r.size, alt: r.alt, url: urlOf(r), created_at: r.created_at });
  const blob = () => import('@vercel/blob');

  const m = {
    kind,
    /** Disk backend: stream an upload to a file. */
    async save(uid, chunks, { filename } = {}) {
      if (kind === 'none') throw httpError(400, NEEDS_BLOB);
      if (kind !== 'disk') throw httpError(400, 'uploads go directly to Blob storage on this server');
      ensureDir();
      const token = randomBytes(18).toString('base64url');
      const tmp = join(dir, `${token}.part`);
      const out = createWriteStream(tmp);
      let size = 0, head = Buffer.alloc(0);
      try {
        for await (const c of chunks) {
          size += c.length;
          if (head.length < 16) head = Buffer.concat([head, c]).subarray(0, 16);
          if (size > MAX_VIDEO) throw httpError(413, 'file too large (max 1 GB)');
          if (!out.write(c)) await new Promise((r) => out.once('drain', r));
        }
        await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
        const mime = sniff(head);
        if (!mime) throw httpError(415, 'only JPEG, PNG, GIF, WebP, MP4 and MOV files are supported');
        if (mime.startsWith('image/') && size > MAX_IMAGE) throw httpError(413, 'images must be under 20 MB');
        await rename(tmp, join(dir, `${token}.${TYPES[mime]}`));
        const id = await db.insert('INSERT INTO media(user_id,token,filename,mime,size) VALUES (?,?,?,?,?)', uid, token, cleanName(filename), mime, size);
        return m.get(uid, id);
      } catch (e) {
        out.destroy();
        await unlink(tmp).catch(() => {});
        throw e;
      }
    },

    /**
     * Store a file we are pulling in ourselves (today: Google Drive), whichever backend is in use.
     * The bytes stream straight through to storage, so a large video never sits in memory.
     */
    async fromStream(uid, chunks, { filename, size = 0 } = {}) {
      if (kind === 'none') throw httpError(400, NEEDS_BLOB);
      if (size > MAX_VIDEO) throw httpError(413, 'that file is larger than 1 GB');
      if (kind === 'disk') return m.save(uid, chunks, { filename });

      const { mime, rest } = await sniffStream(chunks);
      if (!mime) throw httpError(415, 'only JPEG, PNG, GIF, WebP, MP4 and MOV files are supported');
      if (mime.startsWith('image/') && size > MAX_IMAGE) throw httpError(413, 'images must be under 20 MB');
      const { Readable } = await import('node:stream');
      const { put } = await blob();
      const token = randomBytes(18).toString('base64url');
      // Count as we go: the size the other end claimed is not always the size that arrives.
      let real = 0;
      const counted = async function* () {
        for await (const b of rest()) {
          real += b.length;
          if (real > MAX_VIDEO) throw httpError(413, 'file too large (max 1 GB)');
          yield b;
        }
      };
      const saved = await put(`u${uid}/${token}.${TYPES[mime]}`, Readable.from(counted()), {
        token: blobToken, access: 'public', contentType: mime, addRandomSuffix: true,
      });
      const id = await db.insert('INSERT INTO media(user_id,token,filename,mime,size,url) VALUES (?,?,?,?,?,?)',
        uid, token, cleanName(filename), mime, real, saved.url);
      return m.get(uid, id);
    },

    /** Blob backend: issue a short-lived client upload token (browser → Vercel Blob directly). */
    async blobToken(uid, body, req) {
      if (kind !== 'blob') throw httpError(400, kind === 'none' ? NEEDS_BLOB : 'Blob storage is not configured');
      const { handleUpload } = await import('@vercel/blob/client');
      return handleUpload({
        body, request: req, token: blobToken,
        onBeforeGenerateToken: async (pathname) => {
          if (!pathname.startsWith(`u${uid}/`)) throw httpError(400, 'invalid upload path');
          return { allowedContentTypes: Object.keys(TYPES), maximumSizeInBytes: MAX_VIDEO, addRandomSuffix: true };
        },
      });
    },
    /** Blob backend: record an uploaded blob after checking it really is an allowed media file. */
    async register(uid, { url, filename }) {
      if (kind === 'none') throw httpError(400, NEEDS_BLOB);
      if (kind !== 'blob' || !BLOB_HOST.test(String(url))) throw httpError(400, 'invalid upload');
      const { head, del } = await blob();
      const info = await head(url, { token: blobToken });
      const res = await fetch(url, { headers: { range: 'bytes=0-15' } });
      const mime = sniff(Buffer.from(await res.arrayBuffer()));
      if (!mime || (mime.startsWith('image/') && info.size > MAX_IMAGE)) {
        await del(url, { token: blobToken }).catch(() => {});
        throw httpError(415, mime ? 'images must be under 20 MB' : 'only JPEG, PNG, GIF, WebP, MP4 and MOV files are supported');
      }
      const id = await db.insert('INSERT INTO media(user_id,token,filename,mime,size,url) VALUES (?,?,?,?,?,?)', uid, randomBytes(18).toString('base64url'), cleanName(filename), mime, info.size, url);
      return m.get(uid, id);
    },

    list: async (uid) => (await db.all('SELECT * FROM media WHERE user_id=? ORDER BY id DESC LIMIT 500', uid)).map(view),
    async get(uid, id) {
      const r = await db.get('SELECT * FROM media WHERE id=? AND user_id=?', id, uid);
      if (!r) throw httpError(404, 'media not found');
      return view(r);
    },
    async getMany(uid, ids) {
      if (!ids.length) return new Map();
      return new Map((await db.all(`SELECT * FROM media WHERE user_id=? AND id IN ${inList(ids)}`, uid, ...ids)).map((r) => [r.id, view(r)]));
    },
    async setAlt(uid, id, alt) {
      await m.get(uid, id);
      await db.run('UPDATE media SET alt=? WHERE id=?', String(alt || '').slice(0, 1500), id);
      return m.get(uid, id);
    },
    async remove(uid, id) {
      const r = await db.get('SELECT * FROM media WHERE id=? AND user_id=?', id, uid);
      if (!r) return { changes: 0 };
      await db.run('DELETE FROM media WHERE id=?', id);
      if (r.url) await (await blob()).del(r.url, { token: blobToken }).catch(() => {});
      else await unlink(file(r)).catch(() => {});
      return { changes: 1 };
    },
    /** Media objects handed to network providers. */
    async resolve(uid, ids, baseUrl) {
      const out = [];
      for (const id of ids) {
        const r = await db.get('SELECT * FROM media WHERE id=? AND user_id=?', id, uid);
        if (!r) throw httpError(400, `attached media #${id} no longer exists`);
        const read = r.url ? async () => Buffer.from(await (await fetch(r.url)).arrayBuffer()) : () => readFile(file(r));
        out.push({
          id: r.id, filename: `${r.filename.replace(/\.[^.]+$/, '')}.${TYPES[r.mime]}`, mime: r.mime, size: r.size, alt: r.alt,
          url: urlOf(r, baseUrl), read, blob: async () => new Blob([await read()], { type: r.mime }),
        });
      }
      return out;
    },
    /** Disk backend: the public /media/<token>.<ext> route. */
    async lookup(name) {
      if (kind !== 'disk') return null;
      const [token, ext] = String(name).split('.');
      const r = await db.get('SELECT * FROM media WHERE token=?', token || '');
      if (!r || r.url || TYPES[r.mime] !== ext) return null;
      const path = file(r);
      return { mime: r.mime, size: statSync(path).size, stream: (opts) => createReadStream(path, opts) };
    },
  };
  return m;
}

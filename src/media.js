import { createReadStream, createWriteStream, mkdirSync, statSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { httpError } from './errors.js';

export const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };
const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_VIDEO = 1024 * 1024 * 1024;

/** Check the file really is what it claims to be, so we never serve e.g. HTML from /media. */
export function sniff(buf) {
  const hex = buf.subarray(0, 12).toString('hex');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 8).toString() === 'ftyp') return buf.subarray(8, 10).toString() === 'qt' ? 'video/quicktime' : 'video/mp4';
  return null;
}

export function createMedia(db, { dir = process.env.MEDIA_DIR || 'data/media' } = {}) {
  mkdirSync(dir, { recursive: true });
  const q = (s) => db.prepare(s);
  const file = (row) => join(dir, `${row.token}.${TYPES[row.mime]}`);
  const view = (r) => ({ id: r.id, filename: r.filename, mime: r.mime, size: r.size, alt: r.alt, url: `/media/${r.token}.${TYPES[r.mime]}`, created_at: r.created_at });

  const m = {
    dir,
    async save(uid, chunks, { filename = 'upload' } = {}) {
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
        const { rename } = await import('node:fs/promises');
        await rename(tmp, join(dir, `${token}.${TYPES[mime]}`));
        const name = String(filename).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload';
        const r = q('INSERT INTO media(user_id,token,filename,mime,size) VALUES (?,?,?,?,?)').run(uid, token, name, mime, size);
        return view(q('SELECT * FROM media WHERE id=?').get(r.lastInsertRowid));
      } catch (e) {
        out.destroy();
        await unlink(tmp).catch(() => {});
        throw e;
      }
    },
    list: (uid) => q('SELECT * FROM media WHERE user_id=? ORDER BY id DESC LIMIT 500').all(uid).map(view),
    get(uid, id) {
      const r = q('SELECT * FROM media WHERE id=? AND user_id=?').get(id, uid);
      if (!r) throw httpError(404, 'media not found');
      return view(r);
    },
    setAlt(uid, id, alt) {
      m.get(uid, id);
      q('UPDATE media SET alt=? WHERE id=?').run(String(alt || '').slice(0, 1500), id);
      return m.get(uid, id);
    },
    async remove(uid, id) {
      const r = q('SELECT * FROM media WHERE id=? AND user_id=?').get(id, uid);
      if (!r) return;
      q('DELETE FROM media WHERE id=?').run(id);
      await unlink(file(r)).catch(() => {});
    },
    /** Media objects handed to providers. */
    resolve(uid, ids, baseUrl) {
      return ids.map((id) => {
        const r = q('SELECT * FROM media WHERE id=? AND user_id=?').get(id, uid);
        if (!r) throw httpError(400, `attached media #${id} no longer exists`);
        const path = file(r);
        return {
          id: r.id, filename: `${r.filename.replace(/\.[^.]+$/, '')}.${TYPES[r.mime]}`, mime: r.mime, size: r.size, alt: r.alt,
          url: `${baseUrl}/media/${r.token}.${TYPES[r.mime]}`,
          read: () => readFile(path),
          blob: async () => new Blob([await readFile(path)], { type: r.mime }),
        };
      });
    },
    /** For the public /media/<token>.<ext> route. */
    lookup(name) {
      const [token, ext] = String(name).split('.');
      const r = q('SELECT * FROM media WHERE token=?').get(token || '');
      if (!r || TYPES[r.mime] !== ext) return null;
      const path = file(r);
      return { mime: r.mime, path, size: statSync(path).size, stream: (opts) => createReadStream(path, opts) };
    },
  };
  return m;
}

/**
 * Import clips from a Google Drive folder.
 *
 * The convention: each video sits next to a text file with the same name, and that text
 * file holds the description.  video.mp4 + video.txt, holiday.mov + holiday.txt.
 *
 * Reading is done with a Google API key against a folder shared as "anyone with the link",
 * which needs no login dance and no token to keep fresh. The key is stored encrypted like
 * every other credential, and is never sent to the browser.
 */
import { request, ProviderError } from './providers/http.js';
import { httpError } from './errors.js';

export const endpoints = { drive: 'https://www.googleapis.com/drive/v3' };

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'qt'];
const TEXT_EXT = ['txt', 'md'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
/** Everything we are willing to pull in as media. */
const MEDIA_EXT = [...VIDEO_EXT, ...IMAGE_EXT];

const extOf = (name) => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const baseOf = (name) => String(name).replace(/\.[^.]+$/, '').trim().toLowerCase();

/**
 * Pull the id out of whatever Google Drive link was pasted. Handles folder links, file links,
 * the older ?id= forms, links with /u/0/ in them, and a bare id.
 */
export function parseDriveLink(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^[-\w]{12,}$/.test(raw)) return { kind: 'unknown', id: raw };
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/(^|\.)google\.com$/.test(u.hostname) && !/(^|\.)googleusercontent\.com$/.test(u.hostname)) return null;
  const byQuery = u.searchParams.get('id');
  const folder = u.pathname.match(/\/folders\/([-\w]+)/);
  if (folder) return { kind: 'folder', id: folder[1] };
  const file = u.pathname.match(/\/file\/d\/([-\w]+)/);
  if (file) return { kind: 'file', id: file[1] };
  const doc = u.pathname.match(/\/(?:document|presentation|spreadsheets)\/d\/([-\w]+)/);
  if (doc) return { kind: 'file', id: doc[1] };
  if (byQuery) return { kind: /folderview/i.test(u.pathname) ? 'folder' : 'unknown', id: byQuery };
  return null;
}

/**
 * Match each video (or picture) with the text file of the same name.
 * Returns one entry per media file, newest first, with its description file when there is one.
 */
export function pairFiles(files) {
  const texts = new Map();
  for (const f of files) {
    if (TEXT_EXT.includes(extOf(f.name))) texts.set(baseOf(f.name), f);
  }
  return files
    .filter((f) => MEDIA_EXT.includes(extOf(f.name)))
    .map((f) => {
      const note = texts.get(baseOf(f.name)) || null;
      return {
        id: f.id,
        name: f.name,
        kind: VIDEO_EXT.includes(extOf(f.name)) ? 'video' : 'image',
        size: Number(f.size) || 0,
        modifiedAt: f.modifiedTime || null,
        duration: f.videoMediaMetadata?.durationMillis ? Math.round(Number(f.videoMediaMetadata.durationMillis) / 1000) : null,
        thumbnail: f.thumbnailLink || null,
        textId: note?.id || null,
        textName: note?.name || null,
      };
    })
    .sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')));
}

/** Google's errors are wordy and unhelpful; say what the person actually needs to do. */
function explain(e, what) {
  const msg = String(e.message || '');
  if (e.status === 403 && /api key not valid|api_key_invalid|expired/i.test(msg)) {
    return httpError(400, 'That Google API key was rejected. Check it in Settings → Integrations → Google Drive.');
  }
  if (e.status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) {
    return httpError(400, 'The Google Drive API is not enabled for that key’s project yet. Enable “Google Drive API” in Google Cloud, wait a minute, then try again.');
  }
  if (e.status === 403 || e.status === 401) {
    return httpError(400, `Google would not let us read that ${what}. In Drive open Share and set it to “Anyone with the link”.`);
  }
  if (e.status === 404) {
    return httpError(404, `That ${what} was not found. Check the link, and that it is shared as “Anyone with the link”.`);
  }
  if (e.status === 429) return httpError(429, 'Google is rate limiting this key right now — wait a minute and try again.');
  return httpError(e.status && e.status < 500 ? 400 : 502, `Google Drive error: ${msg.replace(/^\d+ /, '')}`);
}

export function createDrive({ settings, media, events }) {
  const keyOf = async (uid) => {
    const key = (await settings.get(uid, 'driveApiKey')) || '';
    if (!key) throw httpError(400, 'Add your Google API key in Settings → Integrations → Google Drive first');
    return key;
  };
  const call = async (uid, path, { query = {}, what = 'file', ...rest } = {}) => {
    try {
      return await request(`${endpoints.drive}${path}`, { query: { key: await keyOf(uid), ...query }, ...rest });
    } catch (e) {
      if (e instanceof ProviderError) throw explain(e, what);
      throw e;
    }
  };

  const drive = {
    /** Is a key saved? (Never returns the key itself.) */
    async configured(uid) { return !!(await settings.get(uid, 'driveApiKey')); },

    /** Everything importable behind a pasted link, each video paired with its description file. */
    async list(uid, link) {
      const ref = parseDriveLink(link);
      if (!ref) throw httpError(400, 'That does not look like a Google Drive link. Copy it from Drive with Share → Copy link.');

      // A single file link: fetch just that file, and look for its text twin beside it.
      if (ref.kind === 'file') return { folder: null, items: await drive.one(uid, ref.id) };

      let items, folder = null;
      try {
        ({ items, folder } = await drive.folder(uid, ref.id));
      } catch (e) {
        // "unknown" links can be either; if listing as a folder failed, try it as a file.
        if (ref.kind !== 'unknown' || e.status === 400) throw e;
        return { folder: null, items: await drive.one(uid, ref.id) };
      }
      await events?.add(uid, 'drive', `Listed ${items.length} file${items.length === 1 ? '' : 's'} from Drive${folder ? ` folder “${folder}”` : ''}`, { detail: { link } });
      return { folder, items };
    },

    async folder(uid, id) {
      const { data: meta } = await call(uid, `/files/${encodeURIComponent(id)}`, { what: 'folder', query: { fields: 'id,name,mimeType', supportsAllDrives: 'true' } });
      if (meta.mimeType !== 'application/vnd.google-apps.folder') throw httpError(400, 'that link points at a file, not a folder');
      const files = [];
      let pageToken;
      do {
        const { data } = await call(uid, '/files', {
          what: 'folder',
          query: {
            q: `'${id.replace(/'/g, "\\'")}' in parents and trashed = false`,
            fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink,videoMediaMetadata/durationMillis)',
            pageSize: '1000', orderBy: 'modifiedTime desc', pageToken,
            supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
          },
        });
        files.push(...(data.files || []));
        pageToken = data.nextPageToken;
      } while (pageToken && files.length < 2000);
      return { folder: meta.name, items: pairFiles(files) };
    },

    /** One shared file on its own. Its description can only be found if we can see the folder too. */
    async one(uid, id) {
      const { data } = await call(uid, `/files/${encodeURIComponent(id)}`, {
        query: { fields: 'id,name,mimeType,size,modifiedTime,thumbnailLink,parents,videoMediaMetadata/durationMillis', supportsAllDrives: 'true' },
      });
      const [item] = pairFiles([data]);
      if (!item) throw httpError(400, `“${data.name}” is not a video or picture we can post`);
      // The twin text file lives in the same folder; we can only see it if that folder is shared too.
      for (const parent of data.parents || []) {
        try {
          const { items } = await drive.folder(uid, parent);
          const mine = items.find((x) => x.id === item.id);
          if (mine?.textId) return [mine];
        } catch { /* folder not shared — the video alone is still fine */ }
      }
      return [item];
    },

    /** The description that belongs to a video: its .txt twin, read as plain text. */
    async description(uid, textId) {
      if (!textId) return '';
      const { data } = await call(uid, `/files/${encodeURIComponent(textId)}`, { what: 'description file', query: { alt: 'media', supportsAllDrives: 'true' } });
      const text = typeof data === 'string' ? data : data.raw ?? '';
      return String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
    },

    /**
     * Copy one Drive file into your own media library and read its description.
     * The file is streamed straight through, so big videos never sit in memory.
     */
    async import(uid, { fileId, textId, baseUrl }) {
      if (!fileId) throw httpError(400, 'pick a file to import');
      const key = await keyOf(uid);
      const { data: meta } = await call(uid, `/files/${encodeURIComponent(fileId)}`, {
        query: { fields: 'id,name,mimeType,size', supportsAllDrives: 'true' },
      });
      const url = `${endpoints.drive}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(key)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
      if (!res.ok || !res.body) {
        throw explain(new ProviderError(`${res.status} ${(await res.text()).slice(0, 200)}`, res.status), 'file');
      }
      let item;
      try {
        item = await media.fromStream(uid, res.body, { filename: meta.name, size: Number(meta.size) || 0 });
      } catch (e) {
        await events?.add(uid, 'drive', `Could not import “${meta.name}” from Drive`, { level: 'error', detail: { error: e.message } });
        throw e;
      }
      const description = await drive.description(uid, textId).catch(() => '');
      await events?.add(uid, 'drive', `Imported “${meta.name}” from Google Drive`, {
        detail: { size: item.size, mime: item.mime, description: description ? `${description.length} characters` : 'none found' },
      });
      return { media: { ...item, url: item.url.startsWith('http') ? item.url : `${baseUrl || ''}${item.url}` }, description };
    },
  };
  return drive;
}

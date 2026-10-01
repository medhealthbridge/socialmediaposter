import { providers, lengthOf } from './providers/index.js';
import { addUtm } from './providers/text.js';
import { nextFreeSlot } from './slots.js';
import { createVault, loadKey } from './vault.js';
import { createSettings } from './settings.js';
import { createMedia } from './media.js';
import { httpError } from './errors.js';

export { httpError };
const MAX_ATTEMPTS = 3;
const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const isTransient = (e) => e.status === 0 || e.status === 429 || e.status >= 500;
const ints = (a) => [...new Set((Array.isArray(a) ? a : []).map(Number).filter(Number.isInteger))];

export function createService(db, { vault = createVault(loadKey()), mediaDir } = {}) {
  const q = (s) => db.prepare(s);
  const settings = createSettings(db, vault);
  const media = createMedia(db, { dir: mediaDir });
  const cfg = (a) => vault.open(a.config);
  const tzOf = (uid) => q('SELECT tz FROM users WHERE id=?').get(uid)?.tz || 'UTC';
  const saveConfig = (id) => (c) => q('UPDATE accounts SET config=? WHERE id=?').run(vault.seal(c), id);
  const providerCtx = (acc) => {
    const prov = providers[acc.type];
    return { config: cfg(acc), app: prov?.connector ? settings.app(acc.user_id, prov.connector) : null, account: acc, saveConfig: saveConfig(acc.id) };
  };

  const accountView = (a) => {
    const prov = providers[a.type];
    const c = cfg(a);
    const fields = {};
    for (const f of prov?.fields || []) fields[f.key] = f.secret ? (c[f.key] ? '••••••' : '') : c[f.key] ?? '';
    return { id: a.id, name: a.name, type: a.type, handle: a.handle, avatar: a.avatar, profile_url: a.profile_url, status: a.status, last_error: a.last_error, fields, created_at: a.created_at };
  };
  const uniqueName = (uid, base, exceptId = 0) => {
    let n = String(base || 'Account').trim().slice(0, 80) || 'Account', i = 2;
    const b = n;
    while (q('SELECT 1 FROM accounts WHERE user_id=? AND name=? AND id!=?').get(uid, n, exceptId)) n = `${b} (${i++})`;
    return n;
  };
  const ownedAccount = (uid, id) => {
    const a = q('SELECT * FROM accounts WHERE id=? AND user_id=?').get(id, uid);
    if (!a) throw httpError(404, 'account not found');
    return a;
  };

  const hydrate = (p) => {
    const ids = J(p.media, []);
    const mediaItems = ids.map((id) => { try { return media.get(p.user_id, id); } catch { return { id, missing: true }; } });
    const deliveries = q(`SELECT d.*, a.name AS account_name, a.type AS account_type, a.avatar AS account_avatar, a.handle AS account_handle
                          FROM deliveries d JOIN accounts a ON a.id = d.account_id WHERE d.post_id = ? ORDER BY d.id`).all(p.id)
      .map((d) => ({ ...d, metrics: J(d.metrics, null) }));
    const overrides = Object.fromEntries(deliveries.filter((d) => d.text_override).map((d) => [d.account_id, d.text_override]));
    return { ...p, media: ids, mediaItems, deliveries, overrides };
  };

  const normalize = (b) => ({
    text: typeof b.text === 'string' ? b.text.replace(/\r\n/g, '\n') : undefined,
    media: b.media === undefined ? undefined : ints(b.media).slice(0, 20),
    accountIds: b.accountIds === undefined ? undefined : ints(b.accountIds),
    overrides: b.overrides === undefined ? undefined : Object.fromEntries(Object.entries(b.overrides || {}).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [Number(k), v.replace(/\r\n/g, '\n')])),
    recycleDays: b.recycleDays === undefined ? undefined : (Number(b.recycleDays) > 0 ? Math.min(365, Math.floor(Number(b.recycleDays))) : null),
    recycleLeft: b.recycleLeft === undefined ? undefined : (b.recycleLeft === null || b.recycleLeft === '' ? null : Math.max(0, Math.floor(Number(b.recycleLeft)))),
    notes: typeof b.notes === 'string' ? b.notes.slice(0, 5000) : undefined,
  });

  const svc = {
    db, vault, settings, media, tzOf, providerCtx,

    // ---------------- accounts
    listAccounts: (uid) => q('SELECT * FROM accounts WHERE user_id=? ORDER BY type, name').all(uid).map(accountView),

    async addAccount(uid, { type, name, config = {} }) {
      const prov = providers[type];
      if (!prov?.fields) throw httpError(400, `${prov?.label || type} is connected with a login button, not a form`);
      const clean = {};
      for (const f of prov.fields) {
        const v = String(config[f.key] ?? '').trim();
        if (!v && !f.optional) throw httpError(400, `${f.label} is required`);
        if (v) clean[f.key] = v;
      }
      let info = {};
      if (prov.verify) {
        try { info = await prov.verify(clean); } catch (e) { throw httpError(400, `Could not connect: ${e.message.replace(/^\d+ /, '')}`); }
      }
      const r = q('INSERT INTO accounts(user_id,name,type,config,handle,avatar,external_id,profile_url) VALUES (?,?,?,?,?,?,?,?)')
        .run(uid, uniqueName(uid, name?.trim() || info.name || prov.label), type, vault.seal(clean), info.handle || null, info.avatar || null, info.external_id || null, info.profile_url || null);
      return accountView(q('SELECT * FROM accounts WHERE id=?').get(r.lastInsertRowid));
    },

    /** Create or refresh an account returned by an OAuth login. */
    upsertOAuthAccount(uid, acc) {
      const existing = acc.external_id && q('SELECT * FROM accounts WHERE user_id=? AND type=? AND external_id=?').get(uid, acc.type, String(acc.external_id));
      if (existing) {
        q("UPDATE accounts SET config=?, handle=?, avatar=?, profile_url=?, status='ok', last_error=NULL WHERE id=?")
          .run(vault.seal(acc.config), acc.handle || existing.handle, acc.avatar || existing.avatar, acc.profile_url || existing.profile_url, existing.id);
        return accountView(q('SELECT * FROM accounts WHERE id=?').get(existing.id));
      }
      const r = q('INSERT INTO accounts(user_id,name,type,config,handle,avatar,external_id,profile_url) VALUES (?,?,?,?,?,?,?,?)')
        .run(uid, uniqueName(uid, acc.name || providers[acc.type].label), acc.type, vault.seal(acc.config), acc.handle || null, acc.avatar || null, acc.external_id ? String(acc.external_id) : null, acc.profile_url || null);
      return accountView(q('SELECT * FROM accounts WHERE id=?').get(r.lastInsertRowid));
    },

    renameAccount(uid, id, name) {
      ownedAccount(uid, id);
      q('UPDATE accounts SET name=? WHERE id=?').run(uniqueName(uid, name, id), id);
      return accountView(ownedAccount(uid, id));
    },
    deleteAccount: (uid, id) => q('DELETE FROM accounts WHERE id=? AND user_id=?').run(id, uid),

    async checkAccount(uid, id) {
      const a = ownedAccount(uid, id);
      const prov = providers[a.type];
      try {
        if (prov.verify) {
          const c = cfg(a);
          const info = await prov.verify(c);
          q("UPDATE accounts SET config=?, avatar=COALESCE(?,avatar), handle=COALESCE(?,handle), status='ok', last_error=NULL WHERE id=?").run(vault.seal(c), info.avatar || null, info.handle || null, id);
        } else if (prov.refreshIfNeeded) {
          await prov.refreshIfNeeded(cfg(a), saveConfig(id));
        }
        return { ok: true, message: prov.verify ? 'Connection works' : 'Saved login looks fine (it is fully checked on the next post)' };
      } catch (e) {
        q('UPDATE accounts SET status=?, last_error=? WHERE id=?').run(e.status === 401 ? 'reauth' : 'error', e.message, id);
        return { ok: false, message: e.message };
      }
    },

    async testPost(uid, id) {
      const a = ownedAccount(uid, id);
      const res = await providers[a.type].publish({ ...providerCtx(a), text: `Test post from Social Poster ✓ ${new Date().toLocaleString('en-GB', { timeZone: tzOf(uid) })}`, media: [] });
      q("UPDATE accounts SET status='ok', last_error=NULL WHERE id=?").run(id);
      return res;
    },

    // ---------------- posts
    listPosts(uid, { from, to, status, q: search, limit = 500 } = {}) {
      let sql = 'SELECT * FROM posts WHERE user_id = ?';
      const args = [uid];
      if (from && to) { sql += ' AND COALESCE(scheduled_at, created_at) >= ? AND COALESCE(scheduled_at, created_at) < ?'; args.push(from, to); }
      if (status === 'failed') sql += " AND status IN ('failed','partial')";
      else if (status) { sql += ' AND status = ?'; args.push(status); }
      if (search) { sql += ' AND text LIKE ?'; args.push(`%${search}%`); }
      sql += status === 'scheduled' ? ' ORDER BY scheduled_at ASC' : ' ORDER BY COALESCE(scheduled_at, created_at) DESC';
      sql += ' LIMIT ?'; args.push(Math.min(Number(limit) || 500, 10000));
      return q(sql).all(...args).map(hydrate);
    },

    getPost(uid, id) {
      const p = q('SELECT * FROM posts WHERE id=? AND user_id=?').get(id, uid);
      if (!p) throw httpError(404, 'post not found');
      return hydrate(p);
    },

    /** Returns a list of human-readable problems for publishing this content to these accounts. */
    problems(uid, { text, media: mediaIds, accountIds, overrides = {} }) {
      const out = [];
      const items = mediaIds.map((id) => { try { return media.get(uid, id); } catch { out.push(`attached media #${id} no longer exists`); return null; } }).filter(Boolean);
      if (!accountIds.length) out.push('pick at least one account');
      for (const aid of accountIds) {
        const a = q('SELECT * FROM accounts WHERE id=? AND user_id=?').get(aid, uid);
        if (!a) { out.push(`unknown account ${aid}`); continue; }
        const p = providers[a.type];
        if (!p) { out.push(`${a.name}: network no longer supported`); continue; }
        const t = overrides[aid] ?? text;
        const where = `${a.name} (${p.label})`;
        if (!t.trim() && !items.length) out.push(`${where}: nothing to post`);
        const len = lengthOf(a.type, t);
        if (len > p.limit) out.push(`${where}: ${len}/${p.limit} characters`);
        const m = p.media || {};
        if (m.required && !items.length) out.push(`${where}: needs at least one image or video`);
        if (items.length > (m.max ?? 0)) out.push(`${where}: at most ${m.max} attachments`);
        const videos = items.filter((x) => x.mime.startsWith('video/'));
        if (videos.length && !m.video) out.push(`${where}: videos are not supported`);
        if (m.videoAlone && videos.length && items.length > 1) out.push(`${where}: a video must be the only attachment`);
        if (m.imageTypes) for (const x of items) if (x.mime.startsWith('image/') && !m.imageTypes.includes(x.mime)) out.push(`${where}: ${x.filename} must be JPEG`);
        if (m.maxImageBytes) for (const x of items) if (x.mime.startsWith('image/') && x.size > m.maxImageBytes) out.push(`${where}: ${x.filename} is over ${m.maxImageBytes / 1e6} MB`);
        if (m.maxBytes) for (const x of items) if (x.size > m.maxBytes) out.push(`${where}: ${x.filename} is too large`);
        const v = p.validate?.(t);
        if (v) out.push(`${where}: ${v}`);
      }
      return out;
    },
    validate(uid, content) {
      const errs = svc.problems(uid, content);
      if (errs.length) throw Object.assign(httpError(400, errs.join(' · ')), { problems: errs });
    },

    /** Decide scheduled_at/status from {publishNow, queue, scheduledAt}. undefined = keep. */
    resolveWhen(uid, b) {
      if (b.publishNow) return { status: 'scheduled', when: new Date().toISOString() };
      if (b.queue) {
        const slot = svc.nextSlot(uid);
        if (!slot) throw httpError(400, 'No queue times set yet — add some in Settings → Posting schedule');
        return { status: 'scheduled', when: slot.toISOString() };
      }
      if (b.scheduledAt) {
        const d = new Date(b.scheduledAt);
        if (Number.isNaN(d.getTime())) throw httpError(400, 'invalid date');
        return { status: 'scheduled', when: d.toISOString() };
      }
      if ('scheduledAt' in b) return { status: 'draft', when: null };
      return undefined;
    },

    insertPost(uid, c, { status, when, source = 'manual' }) {
      const r = q('INSERT INTO posts(user_id,text,media,scheduled_at,status,recycle_days,recycle_left,notes,source) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(uid, c.text, JSON.stringify(c.media), when, status, c.recycleDays ?? null, c.recycleLeft ?? null, c.notes ?? '', source);
      for (const aid of c.accountIds) q('INSERT INTO deliveries(post_id,account_id,text_override) VALUES (?,?,?)').run(r.lastInsertRowid, aid, c.overrides?.[aid] ?? null);
      return Number(r.lastInsertRowid);
    },

    createPost(uid, body, { source } = {}) {
      const n = normalize(body);
      const c = { text: n.text ?? '', media: n.media ?? [], accountIds: n.accountIds ?? [], overrides: n.overrides ?? {}, recycleDays: n.recycleDays, recycleLeft: n.recycleLeft, notes: n.notes };
      if (!c.text.trim() && !c.media.length) throw httpError(400, 'Write something or attach media');
      for (const aid of c.accountIds) ownedAccount(uid, aid);
      const sched = svc.resolveWhen(uid, body) || { status: 'draft', when: null };
      if (sched.status !== 'draft') svc.validate(uid, c);
      const id = svc.insertPost(uid, c, { ...sched, source });
      return svc.getPost(uid, id);
    },

    updatePost(uid, id, body) {
      const p = svc.getPost(uid, id);
      if (['published', 'publishing'].includes(p.status)) throw httpError(409, 'This post was already published — duplicate it instead');
      const n = normalize(body);
      const c = {
        text: n.text ?? p.text, media: n.media ?? p.media,
        accountIds: n.accountIds ?? p.deliveries.map((d) => d.account_id),
        overrides: n.overrides ?? p.overrides,
        recycleDays: n.recycleDays !== undefined ? n.recycleDays : p.recycle_days,
        recycleLeft: n.recycleLeft !== undefined ? n.recycleLeft : p.recycle_left,
        notes: n.notes ?? p.notes,
      };
      if (!c.text.trim() && !c.media.length) throw httpError(400, 'Write something or attach media');
      for (const aid of c.accountIds) ownedAccount(uid, aid);
      const sched = svc.resolveWhen(uid, body) || { status: p.status === 'draft' ? 'draft' : 'scheduled', when: p.scheduled_at };
      if (sched.status !== 'draft') svc.validate(uid, { ...c, accountIds: c.accountIds.filter((aid) => !p.deliveries.some((d) => d.account_id === aid && d.status === 'published')) });
      q('UPDATE posts SET text=?, media=?, scheduled_at=?, status=?, retry_at=NULL, recycle_days=?, recycle_left=?, notes=? WHERE id=?')
        .run(c.text, JSON.stringify(c.media), sched.when, sched.status, c.recycleDays ?? null, c.recycleLeft ?? null, c.notes ?? '', id);
      q("DELETE FROM deliveries WHERE post_id=? AND status!='published' AND account_id NOT IN (SELECT value FROM json_each(?))").run(id, JSON.stringify(c.accountIds));
      for (const aid of c.accountIds) {
        q(`INSERT INTO deliveries(post_id,account_id,text_override) VALUES (?,?,?)
           ON CONFLICT(post_id,account_id) DO UPDATE SET text_override=excluded.text_override`).run(id, aid, c.overrides[aid] ?? null);
      }
      q("UPDATE deliveries SET status='pending', error=NULL, attempts=0 WHERE post_id=? AND status='failed'").run(id);
      return svc.getPost(uid, id);
    },

    deletePost: (uid, id) => q('DELETE FROM posts WHERE id=? AND user_id=?').run(id, uid),

    publishNow(uid, id) {
      const p = svc.getPost(uid, id);
      if (['published', 'publishing'].includes(p.status)) throw httpError(409, 'already published');
      const pending = p.deliveries.filter((d) => d.status !== 'published');
      svc.validate(uid, { text: p.text, media: p.media, accountIds: pending.map((d) => d.account_id), overrides: p.overrides });
      q("UPDATE deliveries SET status='pending', error=NULL, attempts=0 WHERE post_id=? AND status='failed'").run(id);
      q("UPDATE posts SET status='scheduled', scheduled_at=?, retry_at=NULL WHERE id=?").run(new Date().toISOString(), id);
      return svc.getPost(uid, id);
    },

    duplicatePost(uid, id) {
      const p = svc.getPost(uid, id);
      const nid = svc.insertPost(uid, { text: p.text, media: p.media.filter((m) => p.mediaItems.some((x) => x.id === m && !x.missing)), accountIds: p.deliveries.map((d) => d.account_id), overrides: p.overrides, notes: p.notes }, { status: 'draft', when: null });
      return svc.getPost(uid, nid);
    },

    // ---------------- publishing
    isPaused: (uid) => !!settings.get(uid, 'paused'),

    async runDue(now = new Date()) {
      const due = q("SELECT id, user_id FROM posts WHERE status='scheduled' AND COALESCE(retry_at, scheduled_at) <= ? ORDER BY scheduled_at").all(now.toISOString());
      const paused = new Map();
      let n = 0;
      for (const { id, user_id: uid } of due) {
        if (!paused.has(uid)) paused.set(uid, svc.isPaused(uid));
        if (paused.get(uid)) continue;
        // Claim atomically so overlapping ticks never double-post.
        if (!q("UPDATE posts SET status='publishing' WHERE id=? AND status='scheduled'").run(id).changes) continue;
        n++;
        try { await svc.deliver(id, now); } catch (e) {
          console.error('deliver crashed', e);
          q("UPDATE posts SET status='failed' WHERE id=? AND status='publishing'").run(id);
        }
      }
      return n;
    },

    async deliver(postId, now = new Date()) {
      const p = q('SELECT * FROM posts WHERE id=?').get(postId);
      const uid = p.user_id;
      const pending = q("SELECT * FROM deliveries WHERE post_id=? AND status='pending'").all(postId);
      let items = [], mediaError = null;
      try { items = media.resolve(uid, J(p.media, []), settings.baseUrl(uid)); } catch (e) { mediaError = e.message; }
      const utm = settings.get(uid, 'utm');
      let retryAfter = 0;
      for (const d of pending) {
        const acc = q('SELECT * FROM accounts WHERE id=?').get(d.account_id);
        const prov = providers[acc.type];
        const attempts = d.attempts + 1;
        try {
          if (mediaError) throw httpError(400, mediaError);
          if (!prov) throw httpError(400, 'this network is no longer supported');
          let text = d.text_override ?? p.text;
          if (utm?.enabled) {
            const sub = (s) => String(s || '').replaceAll('{network}', acc.type);
            text = addUtm(text, { source: sub(utm.source), medium: sub(utm.medium), campaign: sub(utm.campaign) });
          }
          const res = await prov.publish({ ...providerCtx(acc), text, media: items });
          q("UPDATE deliveries SET status='published', remote_id=?, remote_url=?, error=NULL, attempts=?, published_at=? WHERE id=?")
            .run(res.id != null ? String(res.id) : null, res.url ?? null, attempts, new Date().toISOString(), d.id);
          if (acc.status !== 'ok') q("UPDATE accounts SET status='ok', last_error=NULL WHERE id=?").run(acc.id);
        } catch (e) {
          const msg = String(e.message).slice(0, 600);
          if (e.status === 401 || e.status === 403 && /token|session|expired|permission/i.test(msg)) {
            q("UPDATE accounts SET status='reauth', last_error=? WHERE id=?").run(msg, acc.id);
          }
          if (isTransient(e) && attempts < MAX_ATTEMPTS) {
            q('UPDATE deliveries SET error=?, attempts=? WHERE id=?').run(`${msg} (retrying)`, attempts, d.id);
            retryAfter = Math.max(retryAfter, 2 ** attempts); // minutes: 2, 4
          } else {
            q("UPDATE deliveries SET status='failed', error=?, attempts=? WHERE id=?").run(msg, attempts, d.id);
          }
        }
      }
      if (retryAfter) {
        q("UPDATE posts SET status='scheduled', retry_at=? WHERE id=?").run(new Date(now.getTime() + retryAfter * 60e3).toISOString(), postId);
        return;
      }
      const all = q('SELECT status FROM deliveries WHERE post_id=?').all(postId).map((r) => r.status);
      const status = all.length && all.every((s) => s === 'published') ? 'published' : all.some((s) => s === 'published') ? 'partial' : 'failed';
      q('UPDATE posts SET status=?, retry_at=NULL WHERE id=?').run(status, postId);
      if (status !== 'published') await svc.alert(uid, postId).catch((e) => console.error('alert failed:', e.message));
      if (status !== 'failed') svc.recycle(p, now);
    },

    async alert(uid, postId) {
      const aid = settings.get(uid, 'alertsAccountId');
      const acc = aid && q('SELECT * FROM accounts WHERE id=? AND user_id=?').get(aid, uid);
      if (!acc) return;
      const failed = q("SELECT d.error, a.name FROM deliveries d JOIN accounts a ON a.id=d.account_id WHERE d.post_id=? AND d.status='failed'").all(postId);
      const text = `⚠️ Social Poster: post #${postId} failed on ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}`.slice(0, 1000);
      await providers[acc.type].publish({ ...providerCtx(acc), text, media: [] });
    },

    /** Evergreen posts: schedule the next copy after `recycle_days`. */
    recycle(p, now) {
      if (!(p.recycle_days > 0) || (p.recycle_left !== null && p.recycle_left <= 0)) return null;
      const from = new Date(now.getTime() + p.recycle_days * 864e5);
      const when = (svc.nextSlot(p.user_id, from) || from).toISOString();
      const ds = q('SELECT account_id, text_override FROM deliveries WHERE post_id=?').all(p.id);
      return svc.insertPost(p.user_id, {
        text: p.text, media: J(p.media, []), accountIds: ds.map((d) => d.account_id),
        overrides: Object.fromEntries(ds.filter((d) => d.text_override).map((d) => [d.account_id, d.text_override])),
        recycleDays: p.recycle_days, recycleLeft: p.recycle_left === null ? null : p.recycle_left - 1, notes: p.notes,
      }, { status: 'scheduled', when, source: 'recycle' });
    },

    /** Keep long-lived tokens fresh even when an account isn't posting often. */
    async maintain() {
      for (const a of q("SELECT * FROM accounts WHERE status='ok'").all()) {
        const prov = providers[a.type];
        if (!prov?.refreshIfNeeded) continue;
        try { await prov.refreshIfNeeded(cfg(a), saveConfig(a.id)); } catch (e) {
          q("UPDATE accounts SET status='reauth', last_error=? WHERE id=?").run(e.message, a.id);
        }
      }
      q("DELETE FROM oauth_states WHERE created_at < ?").run(new Date(Date.now() - 3600e3).toISOString());
    },

    // ---------------- queue slots
    getSlots: (uid) => q('SELECT dow, time FROM slots WHERE user_id=? ORDER BY dow, time').all(uid),
    setSlots(uid, slots) {
      if (!Array.isArray(slots) || slots.length > 200) throw httpError(400, 'invalid slots');
      for (const s of slots) if (!(Number.isInteger(s.dow) && s.dow >= 0 && s.dow <= 6 && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time))) throw httpError(400, 'invalid slot');
      q('DELETE FROM slots WHERE user_id=?').run(uid);
      for (const s of slots) q('INSERT INTO slots(user_id,dow,time) VALUES (?,?,?)').run(uid, s.dow, s.time);
      return svc.getSlots(uid);
    },
    nextSlot(uid, from = new Date()) {
      const taken = new Set(q("SELECT scheduled_at FROM posts WHERE user_id=? AND status='scheduled'").all(uid).map((r) => r.scheduled_at));
      return nextFreeSlot(svc.getSlots(uid), tzOf(uid), taken, from);
    },

    // ---------------- snippets (hashtag sets, signatures, templates)
    listSnippets: (uid) => q('SELECT id, name, body FROM snippets WHERE user_id=? ORDER BY name').all(uid),
    saveSnippet(uid, { id, name, body }) {
      if (!String(name || '').trim() || !String(body || '').trim()) throw httpError(400, 'name and text are required');
      if (id) {
        if (!q('UPDATE snippets SET name=?, body=? WHERE id=? AND user_id=?').run(name.trim().slice(0, 80), body.slice(0, 5000), id, uid).changes) throw httpError(404, 'snippet not found');
        return { id: Number(id), name, body };
      }
      const r = q('INSERT INTO snippets(user_id,name,body) VALUES (?,?,?)').run(uid, name.trim().slice(0, 80), body.slice(0, 5000));
      return { id: Number(r.lastInsertRowid), name, body };
    },
    deleteSnippet: (uid, id) => q('DELETE FROM snippets WHERE id=? AND user_id=?').run(id, uid),

    // ---------------- bulk & export
    /** CSV: text,scheduled_at,accounts  (accounts = names separated by ';') */
    bulkImport(uid, csv) {
      const rows = parseCsv(csv);
      if (!rows.length) throw httpError(400, 'no rows');
      if (rows.length > 500) throw httpError(400, 'max 500 rows per import');
      const byName = new Map(svc.listAccounts(uid).map((a) => [a.name.toLowerCase(), a.id]));
      const created = [], errors = [];
      rows.forEach((r, i) => {
        try {
          const ids = (r.accounts || '').split(';').map((s) => s.trim().toLowerCase()).filter(Boolean).map((n) => {
            if (!byName.has(n)) throw new Error(`unknown account "${n}"`);
            return byName.get(n);
          });
          const when = r.scheduled_at?.toLowerCase();
          const body = { text: r.text, accountIds: ids, ...(when === 'queue' ? { queue: true } : { scheduledAt: r.scheduled_at || null }) };
          created.push(svc.createPost(uid, body, { source: 'bulk' }).id);
        } catch (e) { errors.push({ row: i + 2, error: e.message }); }
      });
      return { created: created.length, errors };
    },
    exportJson(uid) {
      return { exportedAt: new Date().toISOString(), posts: svc.listPosts(uid, { limit: 10000 }), snippets: svc.listSnippets(uid), slots: svc.getSlots(uid), accounts: svc.listAccounts(uid).map(({ fields, ...a }) => a) };
    },
    exportCsv(uid) {
      const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [['post_id', 'status', 'scheduled_at', 'account', 'network', 'delivery_status', 'published_at', 'url', 'likes', 'reposts', 'replies', 'views', 'text'].join(',')];
      for (const p of svc.listPosts(uid, { limit: 10000 })) {
        for (const d of p.deliveries.length ? p.deliveries : [{}]) {
          const m = d.metrics || {};
          lines.push([p.id, p.status, p.scheduled_at, d.account_name, d.account_type, d.status, d.published_at, d.remote_url, m.likes, m.reposts, m.replies, m.views, d.text_override ?? p.text].map(cell).join(','));
        }
      }
      return lines.join('\n');
    },
  };
  return svc;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

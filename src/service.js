/**
 * Core logic: accounts, the post queue and publishing.
 * There is no background scheduler: posts wait in a queue until you click “Post”, so the app
 * runs anywhere — including serverless hosts like Vercel.
 */
import { providers, lengthOf } from './providers/index.js';
import { addUtm } from './providers/text.js';
import { sleep } from './providers/http.js';
import { createVault, loadKey } from './vault.js';
import { createSettings } from './settings.js';
import { createMedia } from './media.js';
import { httpError } from './errors.js';
import { nextFreeSlot } from './tz.js';
import { inList } from './db.js';

export { httpError };
const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const isTransient = (e) => e.status === 0 || e.status === 429 || e.status >= 500;
const ints = (a) => [...new Set((Array.isArray(a) ? a : []).map(Number).filter(Number.isInteger))];
const now = () => new Date().toISOString();
const STALE_MS = 10 * 60e3; // a publish that never finished (e.g. a killed serverless function)

export function createService(db, { vault = createVault(loadKey()), mediaDir, blobToken, events = { add: async () => {} }, actor = 'you' } = {}) {
  const settings = createSettings(db, vault);
  const media = createMedia(db, { dir: mediaDir, ...(blobToken !== undefined && { blobToken }) });
  const cfg = (a) => vault.open(a.config);
  const tzOf = async (uid) => (await db.get('SELECT tz FROM users WHERE id=?', uid))?.tz || 'UTC';
  const saveConfig = (id) => (c) => db.run('UPDATE accounts SET config=? WHERE id=?', vault.seal(c), id);
  const providerCtx = async (acc) => {
    const prov = providers[acc.type];
    return { config: cfg(acc), app: prov?.connector ? await settings.app(acc.user_id, prov.connector) : null, account: acc, saveConfig: saveConfig(acc.id) };
  };

  const accountView = (a) => {
    const prov = providers[a.type];
    const c = cfg(a);
    const fields = {};
    for (const f of prov?.fields || []) fields[f.key] = f.secret ? (c[f.key] ? '••••••' : '') : c[f.key] ?? '';
    return {
      id: a.id, name: a.name, type: a.type, handle: a.handle, avatar: a.avatar, profile_url: a.profile_url,
      status: a.status, last_error: a.last_error, fields, created_at: a.created_at,
      needs_setup: !!prov?.needsSetup?.(c),
    };
  };
  const uniqueName = async (uid, base, exceptId = 0) => {
    const b = String(base || 'Account').trim().slice(0, 80) || 'Account';
    let n = b, i = 2;
    while (await db.get('SELECT 1 FROM accounts WHERE user_id=? AND name=? AND id!=?', uid, n, exceptId)) n = `${b} (${i++})`;
    return n;
  };
  const ownedAccount = async (uid, id) => {
    const a = await db.get('SELECT * FROM accounts WHERE id=? AND user_id=?', id, uid);
    if (!a) throw httpError(404, 'account not found');
    return a;
  };

  /** Attach deliveries and media to posts with two queries (not one per post). */
  async function hydrate(uid, posts) {
    if (!posts.length) return [];
    const ids = posts.map((p) => p.id);
    const ds = await db.all(`SELECT d.*, a.name AS account_name, a.type AS account_type, a.avatar AS account_avatar, a.handle AS account_handle
      FROM deliveries d JOIN accounts a ON a.id = d.account_id WHERE d.post_id IN ${inList(ids)} ORDER BY d.id`, ...ids);
    const mediaIds = [...new Set(posts.flatMap((p) => J(p.media, [])))];
    const mm = await media.getMany(uid, mediaIds);
    return posts.map((p) => {
      const mine = ds.filter((d) => d.post_id === p.id).map((d) => ({ ...d, metrics: J(d.metrics, null) }));
      const mids = J(p.media, []);
      return {
        ...p, media: mids, mediaItems: mids.map((id) => mm.get(id) || { id, missing: true }), deliveries: mine,
        overrides: Object.fromEntries(mine.filter((d) => d.text_override).map((d) => [d.account_id, d.text_override])),
      };
    });
  }

  const normalize = (b) => ({
    text: typeof b.text === 'string' ? b.text.replace(/\r\n/g, '\n') : undefined,
    media: b.media === undefined ? undefined : ints(b.media).slice(0, 20),
    accountIds: b.accountIds === undefined ? undefined : ints(b.accountIds),
    overrides: b.overrides === undefined ? undefined : Object.fromEntries(Object.entries(b.overrides || {}).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [Number(k), v.replace(/\r\n/g, '\n')])),
    notes: typeof b.notes === 'string' ? b.notes.slice(0, 5000) : undefined,
    recycleDays: b.recycleDays === undefined ? undefined : (Number(b.recycleDays) > 0 ? Math.min(365, Math.floor(Number(b.recycleDays))) : null),
    recycleLeft: b.recycleLeft === undefined ? undefined : (b.recycleLeft === null || b.recycleLeft === '' ? null : Math.max(0, Math.floor(Number(b.recycleLeft)))),
  });

/** Work out when a post should go out: a date, the next free weekly slot, or nothing (queue). */
const whenFrom = (body, slot) => {
  if (body.publishNow) return null;
  if (body.useSlot) return slot;
  if (body.scheduledAt) {
    const d = new Date(body.scheduledAt);
    if (Number.isNaN(d.getTime())) throw httpError(400, 'invalid date');
    return d;
  }
  return null;
};

  const svc = {
    db, vault, settings, media, tzOf, providerCtx, events,
    /** Who is acting — 'you', 'agent', 'assistant' or 'timer'. Fixed when the service is made. */
    actor,

    // ---------------- accounts
    listAccounts: async (uid) => (await db.all('SELECT * FROM accounts WHERE user_id=? ORDER BY type, name', uid)).map(accountView),

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
      const id = await db.insert('INSERT INTO accounts(user_id,name,type,config,handle,avatar,external_id,profile_url) VALUES (?,?,?,?,?,?,?,?)',
        uid, await uniqueName(uid, name?.trim() || info.name || prov.label), type, vault.seal(clean), info.handle || null, info.avatar || null, info.external_id || null, info.profile_url || null);
      const acc = accountView(await ownedAccount(uid, id));
      await events.add(uid, 'account', `Connected ${acc.name} (${prov.label})`, { actor: svc.actor, accountId: id });
      return acc;
    },

    /** Create or refresh an account returned by a login (OAuth) flow. */
    async upsertOAuthAccount(uid, acc) {
      const existing = acc.external_id && await db.get('SELECT * FROM accounts WHERE user_id=? AND type=? AND external_id=?', uid, acc.type, String(acc.external_id));
      if (existing) {
        await db.run("UPDATE accounts SET config=?, handle=?, avatar=?, profile_url=?, status='ok', last_error=NULL WHERE id=?",
          vault.seal(acc.config), acc.handle || existing.handle, acc.avatar || existing.avatar, acc.profile_url || existing.profile_url, existing.id);
        await events.add(uid, 'account', `Reconnected ${existing.name}`, { actor: svc.actor, accountId: existing.id });
        return accountView(await ownedAccount(uid, existing.id));
      }
      const id = await db.insert('INSERT INTO accounts(user_id,name,type,config,handle,avatar,external_id,profile_url) VALUES (?,?,?,?,?,?,?,?)',
        uid, await uniqueName(uid, acc.name || providers[acc.type].label), acc.type, vault.seal(acc.config), acc.handle || null, acc.avatar || null, acc.external_id ? String(acc.external_id) : null, acc.profile_url || null);
      const saved = accountView(await ownedAccount(uid, id));
      await events.add(uid, 'account', `Connected ${saved.name} (${providers[acc.type].label})`, { actor: svc.actor, accountId: id });
      return saved;
    },

    async renameAccount(uid, id, name) {
      await ownedAccount(uid, id);
      await db.run('UPDATE accounts SET name=? WHERE id=?', await uniqueName(uid, name, id), id);
      return accountView(await ownedAccount(uid, id));
    },
    async deleteAccount(uid, id) {
      const a = await db.get('SELECT name FROM accounts WHERE id=? AND user_id=?', id, uid);
      const r = await db.run('DELETE FROM accounts WHERE id=? AND user_id=?', id, uid);
      if (a) await events.add(uid, 'account', `Removed ${a.name}`, { actor: svc.actor, level: 'warn' });
      return r;
    },

    async checkAccount(uid, id) {
      const a = await ownedAccount(uid, id);
      const prov = providers[a.type];
      try {
        if (prov.verify) {
          const c = cfg(a);
          const info = await prov.verify(c);
          await db.run("UPDATE accounts SET config=?, avatar=COALESCE(?,avatar), handle=COALESCE(?,handle), status='ok', last_error=NULL WHERE id=?", vault.seal(c), info.avatar || null, info.handle || null, id);
        } else if (prov.refreshIfNeeded) {
          await prov.refreshIfNeeded(cfg(a), saveConfig(id));
        }
        return { ok: true, message: prov.verify ? 'Connection works' : 'Saved login looks fine (fully checked on the next post)' };
      } catch (e) {
        await db.run('UPDATE accounts SET status=?, last_error=? WHERE id=?', e.status === 401 ? 'reauth' : 'error', e.message, id);
        return { ok: false, message: e.message };
      }
    },

    /** Provider-specific per-account choices (e.g. who can see your TikTok posts). */
    async accountOptions(uid, id) {
      const a = await ownedAccount(uid, id);
      const prov = providers[a.type];
      if (!prov?.options) return [];
      return prov.options(await providerCtx(a));
    },

    async setAccountOption(uid, id, key, value) {
      const a = await ownedAccount(uid, id);
      const prov = providers[a.type];
      const opt = (prov?.options ? await prov.options(await providerCtx(a)) : []).find((o) => o.key === key);
      if (!opt) throw httpError(400, 'unknown setting');
      if (!opt.choices.some((ch) => ch.value === value)) throw httpError(400, 'that choice is not available for this account');
      await saveConfig(id)({ ...cfg(a), [key]: value });
      return accountView(await ownedAccount(uid, id));
    },

    async testPost(uid, id) {
      const a = await ownedAccount(uid, id);
      const res = await providers[a.type].publish({ ...(await providerCtx(a)), text: `Test post from Social Poster ✓ ${new Date().toLocaleString('en-GB', { timeZone: await tzOf(uid) })}`, media: [] });
      await db.run("UPDATE accounts SET status='ok', last_error=NULL WHERE id=?", id);
      return res;
    },

    /** Keep long-lived tokens fresh (Threads: 60 days). Called when the app is opened. */
    async maintain(uid) {
      for (const a of await db.all("SELECT * FROM accounts WHERE user_id=? AND status='ok'", uid)) {
        const prov = providers[a.type];
        if (!prov?.refreshIfNeeded) continue;
        try { await prov.refreshIfNeeded(cfg(a), saveConfig(a.id)); } catch (e) {
          await db.run("UPDATE accounts SET status='reauth', last_error=? WHERE id=?", e.message, a.id);
        }
      }
    },

    // ---------------- queue & posts
    async listPosts(uid, { status, q: search, limit = 500 } = {}) {
      // Recover posts stuck in "publishing" (e.g. the server stopped mid-publish).
      await db.run("UPDATE posts SET status='failed' WHERE user_id=? AND status='publishing' AND claimed_at < ?", uid, new Date(Date.now() - STALE_MS).toISOString());
      let sql = 'SELECT * FROM posts WHERE user_id = ?';
      const args = [uid];
      if (status === 'failed') sql += " AND status IN ('failed','partial')";
      else if (status) { sql += ' AND status = ?'; args.push(status); }
      if (search) { sql += ' AND LOWER(text) LIKE ?'; args.push(`%${String(search).toLowerCase()}%`); }
      if (status === 'queued') sql += ' ORDER BY position, id';
      else if (status === 'scheduled') sql += ' ORDER BY scheduled_at, id';
      else sql += ' ORDER BY COALESCE(posted_at, scheduled_at, created_at) DESC, id DESC';
      sql += ' LIMIT ?'; args.push(Math.min(Number(limit) || 500, 10000));
      return hydrate(uid, await db.all(sql, ...args));
    },

    async getPost(uid, id) {
      const p = await db.get('SELECT * FROM posts WHERE id=? AND user_id=?', id, uid);
      if (!p) throw httpError(404, 'post not found');
      return (await hydrate(uid, [p]))[0];
    },

    async counts(uid) {
      const rows = await db.all('SELECT status, COUNT(*) AS n FROM posts WHERE user_id=? GROUP BY status', uid);
      const c = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
      return { queued: c.queued || 0, scheduled: c.scheduled || 0, failed: (c.failed || 0) + (c.partial || 0), published: c.published || 0 };
    },

    /** Human-readable problems for publishing this content to these accounts. */
    async problems(uid, { text, media: mediaIds, accountIds, overrides = {} }) {
      const out = [];
      const mm = await media.getMany(uid, mediaIds);
      for (const id of mediaIds) if (!mm.has(id)) out.push(`attached media #${id} no longer exists`);
      const items = mediaIds.map((id) => mm.get(id)).filter(Boolean);
      if (!accountIds.length) out.push('pick at least one account');
      for (const aid of accountIds) {
        const a = await db.get('SELECT * FROM accounts WHERE id=? AND user_id=?', aid, uid);
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
        if (m.videoOnly && items.length && !videos.length) out.push(`${where}: only videos can be posted here`);
        if (m.imageTypes) for (const x of items) if (x.mime.startsWith('image/') && !m.imageTypes.includes(x.mime)) out.push(`${where}: ${x.filename} must be JPEG`);
        if (m.maxImageBytes) for (const x of items) if (x.mime.startsWith('image/') && x.size > m.maxImageBytes) out.push(`${where}: ${x.filename} is over ${m.maxImageBytes / 1e6} MB`);
        if (m.maxBytes) for (const x of items) if (x.size > m.maxBytes) out.push(`${where}: ${x.filename} is too large`);
        const v = p.validate?.(t);
        if (v) out.push(`${where}: ${v}`);
      }
      return out;
    },
    async validate(uid, content) {
      const errs = await svc.problems(uid, content);
      if (errs.length) throw Object.assign(httpError(400, errs.join(' · ')), { problems: errs });
    },

    async insertPost(uid, c, { source = 'manual', when = null } = {}) {
      const pos = (await db.get("SELECT COALESCE(MAX(position), 0) AS m FROM posts WHERE user_id=? AND status='queued'", uid)).m + 1;
      const id = await db.insert('INSERT INTO posts(user_id,text,media,status,position,notes,source,scheduled_at,recycle_days,recycle_left) VALUES (?,?,?,?,?,?,?,?,?,?)',
        uid, c.text, JSON.stringify(c.media), when ? 'scheduled' : 'queued', pos, c.notes ?? '', source,
        when ? when.toISOString() : null, c.recycleDays ?? null, c.recycleLeft ?? null);
      for (const aid of c.accountIds) await db.run('INSERT INTO deliveries(post_id,account_id,text_override) VALUES (?,?,?)', id, aid, c.overrides?.[aid] ?? null);
      return id;
    },

    /** Add a post to the queue; with publishNow it is published right away. */
    async createPost(uid, body, { source } = {}) {
      const n = normalize(body);
      const c = { text: n.text ?? '', media: n.media ?? [], accountIds: n.accountIds ?? [], overrides: n.overrides ?? {}, notes: n.notes, recycleDays: n.recycleDays, recycleLeft: n.recycleLeft };
      if (!c.text.trim() && !c.media.length) throw httpError(400, 'Write something or attach media');
      for (const aid of c.accountIds) await ownedAccount(uid, aid);
      if (body.useSlot && !(await svc.getSlots(uid)).length) throw httpError(400, 'No posting times set yet — add some in Settings → Scheduling');
      const when = whenFrom(body, await svc.nextSlot(uid));
      if (body.useSlot && !when) throw httpError(400, 'No free posting time in the next two months — add more times');
      if (body.publishNow || when) await svc.validate(uid, c);
      const id = await svc.insertPost(uid, c, { source, when });
      if (!body.publishNow) {
        await events.add(uid, when ? 'scheduled' : 'queued',
          when ? `Scheduled for ${when.toISOString()}` : 'Added to the queue',
          { actor: svc.actor, postId: id, detail: { text: c.text.slice(0, 200), accounts: c.accountIds.length, source } });
      }
      return body.publishNow ? svc.publish(uid, id) : svc.getPost(uid, id);
    },

    async updatePost(uid, id, body) {
      const p = await svc.getPost(uid, id);
      if (['published', 'publishing'].includes(p.status)) throw httpError(409, 'This post was already published — duplicate it instead');
      const n = normalize(body);
      const c = {
        text: n.text ?? p.text, media: n.media ?? p.media, notes: n.notes ?? p.notes,
        accountIds: n.accountIds ?? p.deliveries.map((d) => d.account_id), overrides: n.overrides ?? p.overrides,
        recycleDays: n.recycleDays !== undefined ? n.recycleDays : p.recycle_days,
        recycleLeft: n.recycleLeft !== undefined ? n.recycleLeft : p.recycle_left,
      };
      if (!c.text.trim() && !c.media.length) throw httpError(400, 'Write something or attach media');
      for (const aid of c.accountIds) await ownedAccount(uid, aid);
      // 'scheduledAt: null' moves it back to the queue; leaving it out keeps the current time.
      const reschedule = body.publishNow ? null
        : body.useSlot ? await svc.nextSlot(uid)
        : body.scheduledAt !== undefined ? whenFrom(body, null)
        : p.scheduled_at ? new Date(p.scheduled_at) : null;
      if (reschedule) await svc.validate(uid, { ...c, accountIds: c.accountIds });
      await db.run('UPDATE posts SET text=?, media=?, notes=?, scheduled_at=?, status=?, recycle_days=?, recycle_left=? WHERE id=?',
        c.text, JSON.stringify(c.media), c.notes ?? '', reschedule ? reschedule.toISOString() : null,
        reschedule ? 'scheduled' : p.status === 'scheduled' ? 'queued' : p.status,
        c.recycleDays ?? null, c.recycleLeft ?? null, id);
      for (const d of p.deliveries) {
        if (d.status !== 'published' && !c.accountIds.includes(d.account_id)) await db.run('DELETE FROM deliveries WHERE id=?', d.id);
      }
      for (const aid of c.accountIds) {
        await db.run(`INSERT INTO deliveries(post_id,account_id,text_override) VALUES (?,?,?)
          ON CONFLICT(post_id,account_id) DO UPDATE SET text_override=excluded.text_override`, id, aid, c.overrides[aid] ?? null);
      }
      await db.run("UPDATE deliveries SET status='pending', error=NULL WHERE post_id=? AND status='failed'", id);
      if (!body.publishNow) await events.add(uid, 'updated', `Edited post #${id}`, { actor: svc.actor, postId: id });
      return body.publishNow ? svc.publish(uid, id) : svc.getPost(uid, id);
    },

    async deletePost(uid, id) {
      const p = await db.get('SELECT text FROM posts WHERE id=? AND user_id=?', id, uid);
      const r = await db.run('DELETE FROM posts WHERE id=? AND user_id=?', id, uid);
      if (p) await events.add(uid, 'deleted', `Deleted post #${id}`, { actor: svc.actor, level: 'warn', detail: { text: p.text.slice(0, 200) } });
      return r;
    },

    /** Reorder the queue: dir = 'up' | 'down' | 'top'. */
    async move(uid, id, dir) {
      const q = await db.all("SELECT id, position FROM posts WHERE user_id=? AND status='queued' ORDER BY position, id", uid);
      const i = q.findIndex((p) => p.id === id);
      if (i < 0) throw httpError(404, 'not in the queue');
      const j = dir === 'top' ? 0 : dir === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= q.length || j === i) return svc.listPosts(uid, { status: 'queued' });
      const [item] = q.splice(i, 1);
      q.splice(j, 0, item);
      for (let k = 0; k < q.length; k++) if (q[k].position !== k + 1) await db.run('UPDATE posts SET position=? WHERE id=?', k + 1, q[k].id);
      return svc.listPosts(uid, { status: 'queued' });
    },

    async duplicatePost(uid, id) {
      const p = await svc.getPost(uid, id);
      const nid = await svc.insertPost(uid, {
        text: p.text, media: p.media.filter((m) => p.mediaItems.some((x) => x.id === m && !x.missing)),
        accountIds: p.deliveries.map((d) => d.account_id), overrides: p.overrides, notes: p.notes,
      });
      return svc.getPost(uid, nid);
    },

    // ---------------- publishing (runs while you wait)
    /** Publish a queued (or failed) post now. Only accounts not yet published are sent. */
    async publish(uid, id) {
      const p = await svc.getPost(uid, id);
      if (p.status === 'published') throw httpError(409, 'already published');
      const todo = p.deliveries.filter((d) => d.status !== 'published');
      await svc.validate(uid, { text: p.text, media: p.media, accountIds: todo.map((d) => d.account_id), overrides: p.overrides });
      const claim = await db.run("UPDATE posts SET status='publishing', claimed_at=? WHERE id=? AND (status IN ('queued','scheduled','failed','partial') OR (status='publishing' AND claimed_at < ?))",
        now(), id, new Date(Date.now() - STALE_MS).toISOString());
      if (!claim.changes) throw httpError(409, 'This post is already being published');
      await db.run("UPDATE deliveries SET status='pending', error=NULL WHERE post_id=? AND status='failed'", id);
      try { await svc.deliver(id); } catch (e) {
        console.error('publish crashed', e);
        await db.run("UPDATE posts SET status='failed' WHERE id=? AND status='publishing'", id);
      }
      return svc.getPost(uid, id);
    },

    // ---------------- weekly posting times
    getSlots: (uid) => db.all('SELECT dow, time FROM slots WHERE user_id=? ORDER BY dow, time', uid),

    async setSlots(uid, slots) {
      if (!Array.isArray(slots) || slots.length > 200) throw httpError(400, 'invalid posting times');
      for (const s of slots) {
        if (!(Number.isInteger(s.dow) && s.dow >= 0 && s.dow <= 6 && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time))) throw httpError(400, 'invalid posting time');
      }
      await db.run('DELETE FROM slots WHERE user_id=?', uid);
      const seen = new Set();
      for (const s of slots) {
        const key = `${s.dow}|${s.time}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await db.run('INSERT INTO slots(user_id,dow,time) VALUES (?,?,?)', uid, s.dow, s.time);
      }
      return svc.getSlots(uid);
    },

    /** The next weekly time that has nothing scheduled on it yet. */
    async nextSlot(uid, from = new Date()) {
      const slots = await svc.getSlots(uid);
      if (!slots.length) return null;
      const taken = new Set((await db.all("SELECT scheduled_at FROM posts WHERE user_id=? AND status='scheduled'", uid)).map((r) => r.scheduled_at));
      return nextFreeSlot(slots, await tzOf(uid), taken, from);
    },

    // ---------------- publishing on a schedule (driven by /api/cron)
    /** Publish everything that is due. Pass a user id to limit it to one person. */
    async runDue({ uid = null, now = new Date(), limit = 25 } = {}) {
      const due = await db.all(
        `SELECT id, user_id FROM posts WHERE status='scheduled' AND scheduled_at <= ? ${uid ? 'AND user_id = ?' : ''} ORDER BY scheduled_at LIMIT ?`,
        ...[now.toISOString(), ...(uid ? [uid] : []), limit]);
      const results = [];
      for (const row of due) {
        try {
          const p = await svc.publish(row.user_id, row.id);
          results.push({ id: p.id, status: p.status });
          if (p.status !== 'failed') await svc.recycle(row.user_id, p, now);
        } catch (e) {
          // Keep going: one bad post must not stop the rest.
          await db.run("UPDATE posts SET status='failed' WHERE id=? AND status IN ('scheduled','publishing')", row.id);
          results.push({ id: row.id, status: 'failed', error: e.message });
        }
      }
      return { due: due.length, results };
    },

    /** Evergreen: queue the next copy of a repeating post. */
    async recycle(uid, p, now = new Date()) {
      if (!(p.recycle_days > 0) || (p.recycle_left !== null && p.recycle_left <= 0)) return null;
      const when = new Date(now.getTime() + p.recycle_days * 864e5);
      const id = await svc.insertPost(uid, {
        text: p.text, media: p.media, accountIds: p.deliveries.map((d) => d.account_id),
        overrides: p.overrides, notes: p.notes,
        recycleDays: p.recycle_days, recycleLeft: p.recycle_left === null ? null : p.recycle_left - 1,
      }, { source: 'evergreen', when });
      await events.add(uid, 'scheduled', `Evergreen: next copy scheduled for ${when.toISOString()}`, { actor: 'timer', postId: id });
      return id;
    },

    async publishNext(uid) {
      const next = await db.get("SELECT id FROM posts WHERE user_id=? AND status='queued' ORDER BY position, id LIMIT 1", uid);
      if (!next) throw httpError(404, 'The queue is empty');
      return svc.publish(uid, next.id);
    },

    async deliver(postId) {
      const p = await db.get('SELECT * FROM posts WHERE id=?', postId);
      const uid = p.user_id;
      const pending = await db.all("SELECT * FROM deliveries WHERE post_id=? AND status='pending'", postId);
      let items = [], mediaError = null;
      try { items = await media.resolve(uid, J(p.media, []), await settings.baseUrl(uid)); } catch (e) { mediaError = e.message; }
      const utm = await settings.get(uid, 'utm');
      // Accounts are published in parallel so a slow network doesn't hold up the others.
      await Promise.all(pending.map(async (d) => {
        const acc = await db.get('SELECT * FROM accounts WHERE id=?', d.account_id);
        const prov = providers[acc.type];
        let attempts = d.attempts;
        for (let tryNo = 1; ; tryNo++) {
          attempts++;
          try {
            if (mediaError) throw httpError(400, mediaError);
            if (!prov) throw httpError(400, 'this network is no longer supported');
            let text = d.text_override ?? p.text;
            if (utm?.enabled) {
              const sub = (s) => String(s || '').replaceAll('{network}', acc.type);
              text = addUtm(text, { source: sub(utm.source), medium: sub(utm.medium), campaign: sub(utm.campaign) });
            }
            const res = await prov.publish({ ...(await providerCtx(acc)), text, media: items });
            await db.run("UPDATE deliveries SET status='published', remote_id=?, remote_url=?, error=NULL, attempts=?, published_at=? WHERE id=?",
              res.id != null ? String(res.id) : null, res.url ?? null, attempts, now(), d.id);
            if (acc.status !== 'ok') await db.run("UPDATE accounts SET status='ok', last_error=NULL WHERE id=?", acc.id);
            return;
          } catch (e) {
            if (isTransient(e) && tryNo < 2) { await sleep(svc.retryDelayMs); continue; } // one quick retry for hiccups
            const msg = String(e.message).slice(0, 600);
            if (e.status === 401 || (e.status === 403 && /token|session|expired|permission/i.test(msg))) {
              await db.run("UPDATE accounts SET status='reauth', last_error=? WHERE id=?", msg, acc.id);
            }
            await db.run("UPDATE deliveries SET status='failed', error=?, attempts=? WHERE id=?", msg, attempts, d.id);
            return;
          }
        }
      }));
      const rows = await db.all(`SELECT d.status, d.error, d.remote_url, a.name, a.type FROM deliveries d JOIN accounts a ON a.id=d.account_id WHERE d.post_id=?`, postId);
      const all = rows.map((r) => r.status);
      const status = all.length && all.every((s) => s === 'published') ? 'published' : all.some((s) => s === 'published') ? 'partial' : 'failed';
      await db.run('UPDATE posts SET status=?, posted_at=? WHERE id=?', status, now(), postId);
      const ok = rows.filter((r) => r.status === 'published');
      const bad = rows.filter((r) => r.status === 'failed');
      await events.add(uid, status === 'failed' ? 'failed' : 'published',
        status === 'published' ? `Published to ${ok.map((r) => r.name).join(', ')}`
          : status === 'partial' ? `Published to ${ok.map((r) => r.name).join(', ')}, failed on ${bad.map((r) => r.name).join(', ')}`
          : `Failed to publish: ${bad.map((r) => `${r.name} (${r.error})`).join('; ')}`,
        { actor: svc.actor, level: status === 'published' ? 'info' : status === 'partial' ? 'warn' : 'error', postId,
          detail: { results: rows.map((r) => ({ account: r.name, network: r.type, status: r.status, url: r.remote_url, error: r.error })) } });
      if (status !== 'published') await svc.alert(uid, postId).catch((e) => console.error('alert failed:', e.message));
    },
    retryDelayMs: 2000,

    async alert(uid, postId) {
      const aid = await settings.get(uid, 'alertsAccountId');
      const acc = aid && await db.get('SELECT * FROM accounts WHERE id=? AND user_id=?', aid, uid);
      if (!acc) return;
      const failed = await db.all("SELECT d.error, a.name FROM deliveries d JOIN accounts a ON a.id=d.account_id WHERE d.post_id=? AND d.status='failed'", postId);
      const text = `⚠️ Social Poster: post #${postId} failed on ${failed.map((f) => `${f.name} (${f.error})`).join('; ')}`.slice(0, 1000);
      await providers[acc.type].publish({ ...(await providerCtx(acc)), text, media: [] });
    },

    // ---------------- snippets
    listSnippets: (uid) => db.all('SELECT id, name, body FROM snippets WHERE user_id=? ORDER BY name', uid),
    async saveSnippet(uid, { id, name, body }) {
      if (!String(name || '').trim() || !String(body || '').trim()) throw httpError(400, 'name and text are required');
      if (id) {
        if (!(await db.run('UPDATE snippets SET name=?, body=? WHERE id=? AND user_id=?', name.trim().slice(0, 80), body.slice(0, 5000), id, uid)).changes) throw httpError(404, 'snippet not found');
        return { id: Number(id), name, body };
      }
      return { id: await db.insert('INSERT INTO snippets(user_id,name,body) VALUES (?,?,?)', uid, name.trim().slice(0, 80), body.slice(0, 5000)), name, body };
    },
    deleteSnippet: (uid, id) => db.run('DELETE FROM snippets WHERE id=? AND user_id=?', id, uid),

    // ---------------- bulk & export
    /** CSV with columns: text, accounts (account names separated by ';'). Rows are added to the queue. */
    async bulkImport(uid, csv) {
      const rows = parseCsv(csv);
      if (!rows.length) throw httpError(400, 'no rows');
      if (rows.length > 500) throw httpError(400, 'max 500 rows per import');
      const byName = new Map((await svc.listAccounts(uid)).map((a) => [a.name.toLowerCase(), a.id]));
      let created = 0;
      const errors = [];
      for (const [i, r] of rows.entries()) {
        try {
          const ids = (r.accounts || '').split(';').map((s) => s.trim().toLowerCase()).filter(Boolean).map((n) => {
            if (!byName.has(n)) throw new Error(`unknown account "${n}"`);
            return byName.get(n);
          });
          await svc.createPost(uid, { text: r.text, accountIds: ids }, { source: 'bulk' });
          created++;
        } catch (e) { errors.push({ row: i + 2, error: e.message }); }
      }
      return { created, errors };
    },
    async exportJson(uid) {
      return { exportedAt: now(), posts: await svc.listPosts(uid, { limit: 10000 }), snippets: await svc.listSnippets(uid), accounts: (await svc.listAccounts(uid)).map(({ fields, ...a }) => a) };
    },
    async exportCsv(uid) {
      const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [['post_id', 'status', 'posted_at', 'account', 'network', 'delivery_status', 'published_at', 'url', 'likes', 'reposts', 'replies', 'views', 'text'].join(',')];
      for (const p of await svc.listPosts(uid, { limit: 10000 })) {
        for (const d of p.deliveries.length ? p.deliveries : [{}]) {
          const m = d.metrics || {};
          lines.push([p.id, p.status, p.posted_at, d.account_name, d.account_type, d.status, d.published_at, d.remote_url, m.likes, m.reposts, m.replies, m.views, d.text_override ?? p.text].map(cell).join(','));
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

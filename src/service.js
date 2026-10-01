import { providers } from './providers/index.js';
import { nextFreeSlot } from './slots.js';
import { createVault, loadKey } from './vault.js';

const j = (s) => JSON.parse(s);
const MAX_ATTEMPTS = 3;
const isTransient = (msg) => /^(429|5\d\d)\b|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|timeout/i.test(msg);

export function createService(db, vault = createVault(loadKey())) {
  const q = (sql) => db.prepare(sql);
  const cfg = (a) => vault.open(a.config);

  const maskAccount = (a) => {
    const fields = providers[a.type]?.fields ?? [];
    const config = cfg(a);
    const masked = {};
    for (const f of fields) masked[f.key] = f.secret ? (config[f.key] ? '••••••' : '') : config[f.key] ?? '';
    return { id: a.id, name: a.name, type: a.type, config: masked };
  };

  const hydratePost = (p) => ({
    ...p,
    media: j(p.media),
    deliveries: q(`SELECT d.*, a.name AS account_name, a.type AS account_type
                   FROM deliveries d JOIN accounts a ON a.id = d.account_id
                   WHERE d.post_id = ? ORDER BY d.id`).all(p.id),
  });

  const svc = {
    listAccounts: (uid) => q('SELECT * FROM accounts WHERE user_id=? ORDER BY name').all(uid).map(maskAccount),

    addAccount(uid, { name, type, config = {} }) {
      const prov = providers[type];
      if (!name?.trim()) throw httpError(400, 'name required');
      if (!prov) throw httpError(400, `unknown type ${type}`);
      for (const f of prov.fields) {
        if (!f.label.includes('optional') && !config[f.key]) throw httpError(400, `${f.label} required`);
      }
      try {
        const r = q('INSERT INTO accounts(user_id,name,type,config) VALUES (?,?,?,?)').run(uid, name.trim(), type, vault.seal(config));
        return maskAccount(q('SELECT * FROM accounts WHERE id=?').get(r.lastInsertRowid));
      } catch (e) {
        if (/UNIQUE/.test(e.message)) throw httpError(409, 'an account with that name exists');
        throw e;
      }
    },

    deleteAccount: (uid, id) => q('DELETE FROM accounts WHERE id=? AND user_id=?').run(id, uid),

    listPosts(uid, { from, to } = {}) {
      let sql = 'SELECT * FROM posts WHERE user_id = ?';
      const args = [uid];
      if (from && to) {
        sql += ' AND COALESCE(scheduled_at, created_at) >= ? AND COALESCE(scheduled_at, created_at) < ?';
        args.push(from, to);
      }
      sql += ' ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 500';
      return q(sql).all(...args).map(hydratePost);
    },

    getPost(uid, id) {
      const p = q('SELECT * FROM posts WHERE id=? AND user_id=?').get(id, uid);
      if (!p) throw httpError(404, 'post not found');
      return hydratePost(p);
    },

    createPost(uid, { text, media = [], accountIds = [], scheduledAt = null, publishNow = false, queue = false }) {
      if (!text?.trim()) throw httpError(400, 'text required');
      if (!accountIds.length) throw httpError(400, 'pick at least one account');
      let when = null;
      if (queue) {
        const slot = svc.nextSlot(uid);
        if (!slot) throw httpError(400, 'no queue slots configured (Schedule tab)');
        scheduledAt = slot.toISOString();
      }
      if (scheduledAt) {
        const d = new Date(scheduledAt);
        if (Number.isNaN(d.getTime())) throw httpError(400, 'invalid scheduledAt');
        when = d.toISOString();
      }
      svc.checkLengths(uid, text, media, accountIds);
      const status = publishNow ? 'scheduled' : when ? 'scheduled' : 'draft';
      const r = q('INSERT INTO posts(user_id,text,media,scheduled_at,status) VALUES (?,?,?,?,?)')
        .run(uid, text.trim(), JSON.stringify(media), publishNow ? new Date().toISOString() : when, status);
      for (const aid of accountIds) q('INSERT INTO deliveries(post_id,account_id) VALUES (?,?)').run(r.lastInsertRowid, aid);
      return svc.getPost(uid, r.lastInsertRowid);
    },

    checkLengths(uid, text, media, accountIds) {
      for (const aid of accountIds) {
        const a = q('SELECT * FROM accounts WHERE id=? AND user_id=?').get(aid, uid);
        if (!a) throw httpError(400, `unknown account ${aid}`);
        const len = [text, ...media].join('\n').length;
        const limit = providers[a.type].limit;
        if (len > limit) throw httpError(400, `${a.name}: ${len}/${limit} characters`);
      }
    },

    updatePost(uid, id, { text, media, scheduledAt, accountIds }) {
      const p = svc.getPost(uid, id);
      if (['published', 'publishing'].includes(p.status)) throw httpError(409, 'already published');
      const newText = text ?? p.text;
      const newMedia = media ?? p.media;
      const ids = accountIds ?? p.deliveries.map((d) => d.account_id);
      svc.checkLengths(uid, newText, newMedia, ids);
      let when = p.scheduled_at;
      if (scheduledAt !== undefined) when = scheduledAt ? new Date(scheduledAt).toISOString() : null;
      const status = when ? 'scheduled' : 'draft';
      q('UPDATE posts SET text=?, media=?, scheduled_at=?, retry_at=NULL, status=? WHERE id=?')
        .run(newText.trim(), JSON.stringify(newMedia), when, status, id);
      if (accountIds) {
        q("DELETE FROM deliveries WHERE post_id=? AND status!='published'").run(id);
        for (const aid of accountIds) q('INSERT OR IGNORE INTO deliveries(post_id,account_id) VALUES (?,?)').run(id, aid);
      } else {
        q("UPDATE deliveries SET status='pending', error=NULL, attempts=0 WHERE post_id=? AND status='failed'").run(id);
      }
      return svc.getPost(uid, id);
    },

    deletePost: (uid, id) => q('DELETE FROM posts WHERE id=? AND user_id=?').run(id, uid),

    /** Queue a post for immediate publishing (used by "post now" and "retry"). */
    publishNow(uid, id) {
      const p = svc.getPost(uid, id);
      if (['published', 'publishing'].includes(p.status)) throw httpError(409, 'already published');
      q("UPDATE deliveries SET status='pending', error=NULL, attempts=0 WHERE post_id=? AND status='failed'").run(id);
      q("UPDATE posts SET status='scheduled', scheduled_at=?, retry_at=NULL WHERE id=?").run(new Date().toISOString(), id);
      return svc.getPost(uid, id);
    },

    duplicatePost(uid, id) {
      const p = svc.getPost(uid, id);
      return svc.createPost(uid, { text: p.text, media: p.media, accountIds: p.deliveries.map((d) => d.account_id) });
    },

    getSlots: (uid) => q('SELECT dow, time FROM slots WHERE user_id=? ORDER BY dow, time').all(uid),

    setSlots(uid, slots) {
      if (!Array.isArray(slots) || slots.length > 100) throw httpError(400, 'invalid slots');
      for (const s of slots) if (!(Number.isInteger(s.dow) && s.dow >= 0 && s.dow <= 6 && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time))) throw httpError(400, 'invalid slot');
      q('DELETE FROM slots WHERE user_id=?').run(uid);
      for (const s of slots) q('INSERT INTO slots(user_id,dow,time) VALUES (?,?,?)').run(uid, s.dow, s.time);
      return svc.getSlots(uid);
    },

    nextSlot(uid, from = new Date()) {
      const tz = q('SELECT tz FROM users WHERE id=?').get(uid)?.tz || 'UTC';
      const taken = new Set(q("SELECT scheduled_at FROM posts WHERE user_id=? AND status='scheduled'").all(uid).map((r) => r.scheduled_at));
      return nextFreeSlot(svc.getSlots(uid), tz, taken, from);
    },

    /** Publish all due posts. Returns number of posts processed. */
    async runDue(now = new Date()) {
      const due = q("SELECT id FROM posts WHERE status='scheduled' AND COALESCE(retry_at, scheduled_at) <= ?").all(now.toISOString());
      for (const { id } of due) {
        // Claim atomically so overlapping ticks never double-post.
        const claim = q("UPDATE posts SET status='publishing' WHERE id=? AND status='scheduled'").run(id);
        if (!claim.changes) continue;
        await svc.deliver(id, now);
      }
      return due.length;
    },

    async deliver(postId, now = new Date()) {
      const p = q('SELECT * FROM posts WHERE id=?').get(postId);
      const media = j(p.media);
      const pending = q("SELECT * FROM deliveries WHERE post_id=? AND status='pending'").all(postId);
      let retryAfter = 0;
      for (const d of pending) {
        const acc = q('SELECT * FROM accounts WHERE id=?').get(d.account_id);
        const attempts = d.attempts + 1;
        try {
          const res = await providers[acc.type].publish({ config: cfg(acc), text: p.text, media });
          q("UPDATE deliveries SET status='published', remote_url=?, error=NULL, attempts=?, published_at=? WHERE id=?")
            .run(res.url ?? null, attempts, new Date().toISOString(), d.id);
        } catch (e) {
          const msg = String(e.message).slice(0, 500);
          if (isTransient(msg) && attempts < MAX_ATTEMPTS) {
            q("UPDATE deliveries SET error=?, attempts=? WHERE id=?").run(`${msg} (retrying)`, attempts, d.id);
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
      const status = all.every((s) => s === 'published') ? 'published'
        : all.some((s) => s === 'published') ? 'partial' : 'failed';
      q('UPDATE posts SET status=?, retry_at=NULL WHERE id=?').run(status, postId);
    },

    async testAccount(uid, id) {
      const a = q('SELECT * FROM accounts WHERE id=? AND user_id=?').get(id, uid);
      if (!a) throw httpError(404, 'account not found');
      const res = await providers[a.type].publish({ config: cfg(a), text: `Test post from socialmediaposter ${new Date().toISOString()}`, media: [] });
      return res;
    },

    /** CSV: text,scheduled_at,accounts  (accounts = names separated by ';') */
    bulkImport(uid, csv) {
      const rows = parseCsv(csv);
      if (!rows.length) throw httpError(400, 'no rows');
      if (rows.length > 350) throw httpError(400, 'max 350 rows');
      const byName = new Map(svc.listAccounts(uid).map((a) => [a.name.toLowerCase(), a.id]));
      const created = [], errors = [];
      rows.forEach((r, i) => {
        try {
          const ids = (r.accounts || '').split(';').map((s) => s.trim().toLowerCase()).filter(Boolean).map((n) => {
            if (!byName.has(n)) throw new Error(`unknown account "${n}"`);
            return byName.get(n);
          });
          created.push(svc.createPost(uid, { text: r.text, accountIds: ids, scheduledAt: r.scheduled_at || null }).id);
        } catch (e) { errors.push({ row: i + 2, error: e.message }); }
      });
      return { created: created.length, errors };
    },

    stats(uid) {
      const by = (sql) => q(sql).all(uid);
      return {
        posts: by('SELECT status, COUNT(*) AS n FROM posts WHERE user_id=? GROUP BY status'),
        perAccount: by(`SELECT a.name, a.type,
            SUM(d.status='published') AS published, SUM(d.status='failed') AS failed, SUM(d.status='pending') AS pending
            FROM accounts a LEFT JOIN deliveries d ON d.account_id=a.id WHERE a.user_id=? GROUP BY a.id ORDER BY a.name`),
        perDay: by(`SELECT substr(d.published_at,1,10) AS day, COUNT(*) AS n FROM deliveries d JOIN accounts a ON a.id=d.account_id
            WHERE a.user_id=? AND d.status='published' AND d.published_at >= date('now','-30 day') GROUP BY day ORDER BY day`),
      };
    },
  };
  return svc;
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
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

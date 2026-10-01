import { providers } from './providers/index.js';

const j = (s) => JSON.parse(s);

export function createService(db) {
  const q = (sql) => db.prepare(sql);

  const maskAccount = (a) => {
    const fields = providers[a.type]?.fields ?? [];
    const config = j(a.config);
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
    listAccounts: () => q('SELECT * FROM accounts ORDER BY name').all().map(maskAccount),

    addAccount({ name, type, config = {} }) {
      const prov = providers[type];
      if (!name?.trim()) throw httpError(400, 'name required');
      if (!prov) throw httpError(400, `unknown type ${type}`);
      for (const f of prov.fields) {
        if (!f.label.includes('optional') && !config[f.key]) throw httpError(400, `${f.label} required`);
      }
      try {
        const r = q('INSERT INTO accounts(name,type,config) VALUES (?,?,?)').run(name.trim(), type, JSON.stringify(config));
        return maskAccount(q('SELECT * FROM accounts WHERE id=?').get(r.lastInsertRowid));
      } catch (e) {
        if (/UNIQUE/.test(e.message)) throw httpError(409, 'an account with that name exists');
        throw e;
      }
    },

    deleteAccount: (id) => q('DELETE FROM accounts WHERE id=?').run(id),

    listPosts({ from, to } = {}) {
      let sql = 'SELECT * FROM posts';
      const args = [];
      if (from && to) {
        sql += ' WHERE COALESCE(scheduled_at, created_at) >= ? AND COALESCE(scheduled_at, created_at) < ?';
        args.push(from, to);
      }
      sql += ' ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 500';
      return q(sql).all(...args).map(hydratePost);
    },

    getPost(id) {
      const p = q('SELECT * FROM posts WHERE id=?').get(id);
      if (!p) throw httpError(404, 'post not found');
      return hydratePost(p);
    },

    createPost({ text, media = [], accountIds = [], scheduledAt = null, publishNow = false }) {
      if (!text?.trim()) throw httpError(400, 'text required');
      if (!accountIds.length) throw httpError(400, 'pick at least one account');
      let when = null;
      if (scheduledAt) {
        const d = new Date(scheduledAt);
        if (Number.isNaN(d.getTime())) throw httpError(400, 'invalid scheduledAt');
        when = d.toISOString();
      }
      svc.checkLengths(text, media, accountIds);
      const status = publishNow ? 'scheduled' : when ? 'scheduled' : 'draft';
      const r = q('INSERT INTO posts(text,media,scheduled_at,status) VALUES (?,?,?,?)')
        .run(text.trim(), JSON.stringify(media), publishNow ? new Date().toISOString() : when, status);
      for (const aid of accountIds) q('INSERT INTO deliveries(post_id,account_id) VALUES (?,?)').run(r.lastInsertRowid, aid);
      return svc.getPost(r.lastInsertRowid);
    },

    checkLengths(text, media, accountIds) {
      for (const aid of accountIds) {
        const a = q('SELECT * FROM accounts WHERE id=?').get(aid);
        if (!a) throw httpError(400, `unknown account ${aid}`);
        const len = [text, ...media].join('\n').length;
        const limit = providers[a.type].limit;
        if (len > limit) throw httpError(400, `${a.name}: ${len}/${limit} characters`);
      }
    },

    updatePost(id, { text, media, scheduledAt, accountIds }) {
      const p = svc.getPost(id);
      if (['published', 'publishing'].includes(p.status)) throw httpError(409, 'already published');
      const newText = text ?? p.text;
      const newMedia = media ?? p.media;
      const ids = accountIds ?? p.deliveries.map((d) => d.account_id);
      svc.checkLengths(newText, newMedia, ids);
      let when = p.scheduled_at;
      if (scheduledAt !== undefined) when = scheduledAt ? new Date(scheduledAt).toISOString() : null;
      const status = when ? 'scheduled' : 'draft';
      q('UPDATE posts SET text=?, media=?, scheduled_at=?, status=? WHERE id=?')
        .run(newText.trim(), JSON.stringify(newMedia), when, status, id);
      if (accountIds) {
        q("DELETE FROM deliveries WHERE post_id=? AND status!='published'").run(id);
        for (const aid of accountIds) q('INSERT OR IGNORE INTO deliveries(post_id,account_id) VALUES (?,?)').run(id, aid);
      } else {
        q("UPDATE deliveries SET status='pending', error=NULL WHERE post_id=? AND status='failed'").run(id);
      }
      return svc.getPost(id);
    },

    deletePost: (id) => q('DELETE FROM posts WHERE id=?').run(id),

    /** Queue a post for immediate publishing (used by "post now" and "retry"). */
    publishNow(id) {
      svc.getPost(id);
      q("UPDATE deliveries SET status='pending', error=NULL WHERE post_id=? AND status='failed'").run(id);
      q("UPDATE posts SET status='scheduled', scheduled_at=? WHERE id=?").run(new Date().toISOString(), id);
      return svc.getPost(id);
    },

    /** Publish all due posts. Returns number of posts processed. */
    async runDue(now = new Date()) {
      const due = q("SELECT id FROM posts WHERE status='scheduled' AND scheduled_at <= ?").all(now.toISOString());
      for (const { id } of due) {
        // Claim atomically so overlapping ticks never double-post.
        const claim = q("UPDATE posts SET status='publishing' WHERE id=? AND status='scheduled'").run(id);
        if (!claim.changes) continue;
        await svc.deliver(id);
      }
      return due.length;
    },

    async deliver(postId) {
      const p = svc.getPost(postId);
      const pending = p.deliveries.filter((d) => d.status === 'pending');
      for (const d of pending) {
        const acc = q('SELECT * FROM accounts WHERE id=?').get(d.account_id);
        try {
          const res = await providers[acc.type].publish({ config: j(acc.config), text: p.text, media: p.media });
          q("UPDATE deliveries SET status='published', remote_url=?, error=NULL, attempts=attempts+1, published_at=? WHERE id=?")
            .run(res.url ?? null, new Date().toISOString(), d.id);
        } catch (e) {
          q("UPDATE deliveries SET status='failed', error=?, attempts=attempts+1 WHERE id=?").run(String(e.message).slice(0, 500), d.id);
        }
      }
      const all = q('SELECT status FROM deliveries WHERE post_id=?').all(postId).map((r) => r.status);
      const status = all.every((s) => s === 'published') ? 'published'
        : all.some((s) => s === 'published') ? 'partial' : 'failed';
      q('UPDATE posts SET status=? WHERE id=?').run(status, postId);
    },

    async testAccount(id) {
      const a = q('SELECT * FROM accounts WHERE id=?').get(id);
      if (!a) throw httpError(404, 'account not found');
      const res = await providers[a.type].publish({ config: j(a.config), text: `Test post from socialmediaposter ${new Date().toISOString()}`, media: [] });
      return res;
    },

    /** CSV: text,scheduled_at,accounts  (accounts = names separated by ';') */
    bulkImport(csv) {
      const rows = parseCsv(csv);
      if (!rows.length) throw httpError(400, 'no rows');
      if (rows.length > 350) throw httpError(400, 'max 350 rows');
      const byName = new Map(svc.listAccounts().map((a) => [a.name.toLowerCase(), a.id]));
      const created = [], errors = [];
      rows.forEach((r, i) => {
        try {
          const ids = (r.accounts || '').split(';').map((s) => s.trim().toLowerCase()).filter(Boolean).map((n) => {
            if (!byName.has(n)) throw new Error(`unknown account "${n}"`);
            return byName.get(n);
          });
          created.push(svc.createPost({ text: r.text, accountIds: ids, scheduledAt: r.scheduled_at || null }).id);
        } catch (e) { errors.push({ row: i + 2, error: e.message }); }
      });
      return { created: created.length, errors };
    },

    stats() {
      const by = (sql) => q(sql).all();
      return {
        posts: by('SELECT status, COUNT(*) AS n FROM posts GROUP BY status'),
        perAccount: by(`SELECT a.name, a.type,
            SUM(d.status='published') AS published, SUM(d.status='failed') AS failed, SUM(d.status='pending') AS pending
            FROM accounts a LEFT JOIN deliveries d ON d.account_id=a.id GROUP BY a.id ORDER BY a.name`),
        perDay: by(`SELECT substr(published_at,1,10) AS day, COUNT(*) AS n FROM deliveries
            WHERE status='published' AND published_at >= date('now','-30 day') GROUP BY day ORDER BY day`),
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

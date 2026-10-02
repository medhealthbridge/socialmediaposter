/**
 * Database layer with one async API for two backends:
 *   - SQLite file (default, for running on your own computer/server)
 *   - Postgres (when DATABASE_URL / POSTGRES_URL is set, e.g. Neon on Vercel)
 * Queries use "?" placeholders; they are translated for Postgres.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SQLITE_NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
const PG_NOW = `(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;

const schema = (pg) => {
  const id = pg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const now = pg ? PG_NOW : SQLITE_NOW;
  return `
  CREATE TABLE IF NOT EXISTS users (
    id ${id}, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, tz TEXT NOT NULL DEFAULT 'UTC',
    is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT ${now});
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
  CREATE TABLE IF NOT EXISTS accounts (
    id ${id}, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}', handle TEXT, avatar TEXT, external_id TEXT, profile_url TEXT,
    status TEXT NOT NULL DEFAULT 'ok', last_error TEXT, created_at TEXT NOT NULL DEFAULT ${now});
  CREATE TABLE IF NOT EXISTS posts (
    id ${id}, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, media TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'queued', position INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual', claimed_at TEXT, posted_at TEXT, created_at TEXT NOT NULL DEFAULT ${now});
  CREATE TABLE IF NOT EXISTS deliveries (
    id ${id}, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending',
    text_override TEXT, remote_id TEXT, remote_url TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    published_at TEXT, metrics TEXT, metrics_at TEXT, UNIQUE (post_id, account_id));
  CREATE TABLE IF NOT EXISTS media (
    id ${id}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, alt TEXT NOT NULL DEFAULT '', url TEXT,
    created_at TEXT NOT NULL DEFAULT ${now});
  CREATE TABLE IF NOT EXISTS snippets (
    id ${id}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS feeds (
    id ${id}, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, url TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
    account_ids TEXT NOT NULL DEFAULT '[]', mode TEXT NOT NULL DEFAULT 'queue', template TEXT NOT NULL DEFAULT '{title}
{link}',
    interval_min INTEGER NOT NULL DEFAULT 60, enabled INTEGER NOT NULL DEFAULT 1, seen TEXT NOT NULL DEFAULT '[]',
    last_checked TEXT, last_error TEXT);
  CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, connector TEXT NOT NULL,
    verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT ${now});
  CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_user_name ON accounts(user_id, name);
  CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_deliveries_post ON deliveries(post_id);
  CREATE INDEX IF NOT EXISTS idx_deliveries_account ON deliveries(account_id, status);`;
};

const clean = (args) => args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

async function openSqlite(path) {
  const { DatabaseSync } = await import('node:sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  // Upgrade databases created by the earlier scheduler version before applying the schema.
  const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
  if (cols('posts').size) {
    const add = { accounts: { user_id: 'INTEGER', handle: 'TEXT', avatar: 'TEXT', external_id: 'TEXT', profile_url: 'TEXT', status: "TEXT NOT NULL DEFAULT 'ok'", last_error: 'TEXT' },
      posts: { user_id: 'INTEGER', position: 'INTEGER NOT NULL DEFAULT 0', notes: "TEXT NOT NULL DEFAULT ''", source: "TEXT NOT NULL DEFAULT 'manual'", claimed_at: 'TEXT', posted_at: 'TEXT' },
      deliveries: { text_override: 'TEXT', remote_id: 'TEXT', metrics: 'TEXT', metrics_at: 'TEXT' }, media: { url: 'TEXT' } };
    for (const [t, defs] of Object.entries(add)) {
      const have = cols(t);
      if (!have.size) continue;
      for (const [c, type] of Object.entries(defs)) if (!have.has(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`);
    }
    db.exec("UPDATE posts SET status='queued', position=id WHERE status IN ('draft','scheduled')");
    db.exec(`UPDATE posts SET posted_at=COALESCE(posted_at, ${cols('posts').has('scheduled_at') ? 'scheduled_at, ' : ''}created_at) WHERE status IN ('published','partial','failed') AND posted_at IS NULL`);
    if (cols('feeds').size) db.exec("UPDATE feeds SET mode='queue' WHERE mode='draft'");
  }
  db.exec(schema(false));
  return {
    kind: 'sqlite',
    all: async (sql, ...a) => db.prepare(sql).all(...clean(a)).map((r) => ({ ...r })),
    get: async (sql, ...a) => { const r = db.prepare(sql).get(...clean(a)); return r ? { ...r } : undefined; },
    run: async (sql, ...a) => ({ changes: Number(db.prepare(sql).run(...clean(a)).changes) }),
    insert: async (sql, ...a) => Number(db.prepare(`${sql} RETURNING id`).get(...clean(a)).id),
    close: async () => db.close(),
  };
}

async function openPostgres(url) {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, (v) => Number(v)); // COUNT(*) etc. as numbers
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 10_000, ...(!local && !/sslmode=/.test(url) && { ssl: { rejectUnauthorized: true } }) });
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const query = (sql, a) => pool.query(toPg(sql), clean(a));
  // Idle connections can be closed by the server (e.g. Neon scaling to zero); log instead of crashing.
  pool.on('error', (e) => console.error('postgres pool error:', e.message));
  const client = await pool.connect();
  try {
    // A transaction-scoped lock also works through connection poolers (PgBouncer / Neon "-pooler" URLs)
    // and stops two cold starts from creating the tables at the same time.
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727274)');
    await client.query(schema(true));
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error(`could not set up the database: ${e.message}`);
  } finally {
    client.release();
  }
  return {
    kind: 'postgres',
    all: async (sql, ...a) => (await query(sql, a)).rows,
    get: async (sql, ...a) => (await query(sql, a)).rows[0],
    run: async (sql, ...a) => ({ changes: (await query(sql, a)).rowCount }),
    insert: async (sql, ...a) => Number((await query(`${sql} RETURNING id`, a)).rows[0].id),
    close: () => pool.end(),
  };
}

export function databaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
}

export async function openDb(target) {
  if (target === undefined && !databaseUrl() && process.env.VERCEL) {
    throw new Error('No database connected. In your Vercel project open Storage → connect a Neon (Postgres) database, then redeploy.');
  }
  const t = target ?? (databaseUrl() || process.env.DB_PATH || 'data/poster.db');
  return /^postgres(ql)?:\/\//.test(t) ? openPostgres(t) : openSqlite(t);
}

/** "(?, ?, ?)" for an IN list. */
export const inList = (arr) => `(${arr.map(() => '?').join(',') || 'NULL'})`;

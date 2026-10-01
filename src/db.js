import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const now = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export function openDb(path = process.env.DB_PATH || 'data/poster.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      tz TEXT NOT NULL DEFAULT 'UTC',
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT ${now}
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT ${now}
    );
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      media TEXT NOT NULL DEFAULT '[]',
      scheduled_at TEXT,
      retry_at TEXT,
      status TEXT NOT NULL DEFAULT 'draft', -- draft|scheduled|publishing|published|partial|failed
      created_at TEXT NOT NULL DEFAULT ${now}
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending', -- pending|published|failed
      remote_url TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      published_at TEXT,
      UNIQUE(post_id, account_id)
    );
    CREATE TABLE IF NOT EXISTS slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dow INTEGER NOT NULL,
      time TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,          -- public, unguessable file name
      filename TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      alt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT ${now}
    );
    CREATE TABLE IF NOT EXISTS snippets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      account_ids TEXT NOT NULL DEFAULT '[]',
      mode TEXT NOT NULL DEFAULT 'draft',  -- draft|queue|now
      template TEXT NOT NULL DEFAULT '{title}\n{link}',
      interval_min INTEGER NOT NULL DEFAULT 30,
      enabled INTEGER NOT NULL DEFAULT 1,
      seen TEXT NOT NULL DEFAULT '[]',
      last_checked TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connector TEXT NOT NULL,
      verifier TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT ${now}
    );
  `);
  const cols = {
    accounts: { user_id: 'INTEGER', handle: 'TEXT', avatar: 'TEXT', external_id: 'TEXT', profile_url: 'TEXT', status: "TEXT NOT NULL DEFAULT 'ok'", last_error: 'TEXT' },
    posts: { user_id: 'INTEGER', retry_at: 'TEXT', recycle_days: 'INTEGER', recycle_left: 'INTEGER', notes: "TEXT NOT NULL DEFAULT ''", source: "TEXT NOT NULL DEFAULT 'manual'" },
    deliveries: { text_override: 'TEXT', remote_id: 'TEXT', metrics: 'TEXT', metrics_at: 'TEXT' },
  };
  for (const [table, defs] of Object.entries(cols)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, type] of Object.entries(defs)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_user_name ON accounts(user_id, name);
    CREATE INDEX IF NOT EXISTS idx_posts_due ON posts(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
    CREATE INDEX IF NOT EXISTS idx_deliveries_account ON deliveries(account_id, status);
  `);
  return db;
}

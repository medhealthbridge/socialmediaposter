import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path = process.env.DB_PATH || 'data/poster.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      tz TEXT NOT NULL DEFAULT 'UTC',
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      media TEXT NOT NULL DEFAULT '[]',
      scheduled_at TEXT,
      retry_at TEXT,
      status TEXT NOT NULL DEFAULT 'draft', -- draft|scheduled|publishing|published|partial|failed
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
      dow INTEGER NOT NULL,      -- 0=Sunday
      time TEXT NOT NULL         -- HH:MM in the user's timezone
    );
  `);
  // Migrate databases created by the single-user version.
  for (const [table, col] of [['accounts', 'user_id'], ['posts', 'user_id'], ['posts', 'retry_at']]) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${col === 'retry_at' ? 'TEXT' : 'INTEGER'}`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_user_name ON accounts(user_id, name);
    CREATE INDEX IF NOT EXISTS idx_posts_due ON posts(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
  `);
  return db;
}

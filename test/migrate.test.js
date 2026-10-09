/**
 * Opening a database made by an older version must bring it up to date.
 *
 * CREATE TABLE IF NOT EXISTS leaves an existing table exactly as it was, so every column
 * added after the first release has to be added separately — on both backends. A database
 * that misses one does not fail loudly: it fails on the first query that names the column,
 * which is why this is tested rather than assumed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createVault } from '../src/vault.js';
import { createContext } from '../src/server.js';

const opened = [];
after(async () => { for (const d of opened) await d.close().catch(() => {}); });

/** The shape of the tables before any of the later columns existed. */
const OLD = (serial) => [
  `CREATE TABLE users (id ${serial}, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, tz TEXT NOT NULL DEFAULT 'UTC', is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '2024-01-01T00:00:00Z')`,
  `CREATE TABLE accounts (id ${serial}, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}')`,
  `CREATE TABLE posts (id ${serial}, text TEXT NOT NULL, media TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL DEFAULT '2024-01-01T00:00:00Z')`,
  `CREATE TABLE media (id ${serial}, user_id INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, alt TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '2024-01-01T00:00:00Z')`,
];

/** Every column the app relies on but that an old database would not have. */
const EXPECTED = {
  accounts: ['user_id', 'handle', 'avatar', 'external_id', 'profile_url', 'status', 'last_error', 'groups'],
  posts: ['user_id', 'position', 'notes', 'source', 'claimed_at', 'posted_at', 'scheduled_at', 'recycle_days', 'recycle_left', 'parts'],
  media: ['url'],
};

/** Makes an old-shape database and returns how to open it and read its columns. */
async function oldDatabase() {
  if (process.env.TEST_PG) {
    const pg = (await import('pg')).default;
    const name = `mig_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: `${process.env.TEST_PG}/postgres` });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = `${process.env.TEST_PG}/${name}`;
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    for (const sql of OLD('SERIAL PRIMARY KEY')) await c.query(sql);
    await c.query(`INSERT INTO users(email,password_hash) VALUES ('old@x.io','x')`);
    await c.query(`INSERT INTO accounts(name,type) VALUES ('Animals YT','youtube')`);
    await c.query(`INSERT INTO posts(text,status) VALUES ('an old draft','draft')`);
    await c.end();
    return { target: url, backend: 'postgres' };
  }
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(mkdtempSync(join(tmpdir(), 'sp-mig-')), 'old.db');
  const db = new DatabaseSync(file);
  for (const sql of OLD('INTEGER PRIMARY KEY AUTOINCREMENT')) db.exec(sql);
  db.exec(`INSERT INTO users(email,password_hash) VALUES ('old@x.io','x')`);
  db.exec(`INSERT INTO accounts(name,type) VALUES ('Animals YT','youtube')`);
  db.exec(`INSERT INTO posts(text,status) VALUES ('an old draft','draft')`);
  db.close();
  return { target: file, backend: 'sqlite' };
}

const columnsOf = async (db, table) => (db.kind === 'postgres'
  ? (await db.all('SELECT column_name AS n FROM information_schema.columns WHERE table_name=?', table))
  : (await db.all(`SELECT name AS n FROM pragma_table_info('${table}')`))).map((r) => r.n);

test('T-MIG-01 a database from an older version gains every column it is missing', async () => {
  const { target, backend } = await oldDatabase();
  const db = await openDb(target);
  opened.push(db);
  assert.equal(db.kind, backend);

  for (const [table, cols] of Object.entries(EXPECTED)) {
    const have = await columnsOf(db, table);
    const missing = cols.filter((c) => !have.includes(c));
    assert.deepEqual(missing, [], `${table} is still missing ${missing.join(', ')}`);
  }

  // The rows that were already there are kept, and the new columns have usable defaults.
  assert.equal((await db.get('SELECT email FROM users WHERE id=1')).email, 'old@x.io');
  const acc = await db.get('SELECT name, groups, status FROM accounts WHERE id=1');
  assert.equal(acc.name, 'Animals YT', 'the account survived');
  assert.equal(acc.groups, '[]', 'and can be read as an empty group list');
  assert.equal(acc.status, 'ok');
  assert.equal((await db.get('SELECT parts FROM posts WHERE id=1')).parts, '[]');

  // Opening it a second time must not fail or double-add anything.
  const again = await openDb(target);
  opened.push(again);
  assert.deepEqual((await columnsOf(again, 'accounts')).filter((c) => c === 'groups'), ['groups'], 'added once, not twice');
});

test('T-MIG-02 an upgraded database actually works — groups and threads included', async () => {
  const { target } = await oldDatabase();
  const db = await openDb(target);
  opened.push(db);
  const ctx = await createContext(db, { vault: createVault(randomBytes(32)), mediaDir: mkdtempSync(join(tmpdir(), 'sp-mig-m-')), blobToken: '' });
  const uid = (await ctx.auth.createUser({ email: 'new@x.io', password: 'password1', isAdmin: true })).id;

  // The features whose columns were added later must work on the upgraded database.
  const acc = await ctx.svc.addAccount(uid, { type: 'mock', name: 'Animals test', config: {} });
  const grouped = await ctx.svc.setAccountGroups(uid, acc.id, ['Animals']);
  assert.deepEqual(grouped.groups, ['Animals'], 'groups work (the column added by this wave)');
  assert.deepEqual(await ctx.svc.listGroups(uid), ['Animals']);

  const post = await ctx.svc.createPost(uid, {
    text: 'first part', accountIds: [acc.id],
    parts: [{ text: 'second part', media: [] }],                      // threads
    scheduledAt: new Date(Date.now() + 36e5).toISOString(),           // scheduling
  });
  assert.equal(post.parts.length, 1, 'threads work');
  assert.ok(post.scheduled_at, 'scheduling works');
  assert.equal((await ctx.svc.counts(uid)).scheduled, 1);

  // The old rows are still there and did not become anyone's data by accident.
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM posts WHERE user_id IS NULL')).n, 1, 'the pre-login draft is left unowned');
  assert.equal((await ctx.svc.listPosts(uid)).length, 1, 'and is not shown to the new account');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createService, parseCsv } from '../src/service.js';
import { createAuth } from '../src/auth.js';
import { createApp } from '../src/server.js';
import { createVault } from '../src/vault.js';
import { nextFreeSlot, zonedToUtc } from '../src/slots.js';

const setup = (opts) => {
  const db = openDb(':memory:');
  const svc = createService(db, createVault(randomBytes(32)));
  const auth = createAuth(db, opts);
  const u1 = auth.createUser({ email: 'a@x.io', password: 'password1', isAdmin: true });
  const u2 = auth.createUser({ email: 'b@x.io', password: 'password2' });
  return { db, svc, auth, u1: u1.id, u2: u2.id };
};
const iso = (ms) => new Date(Date.now() + ms).toISOString();

test('parseCsv handles quotes, commas and newlines', () => {
  const rows = parseCsv('text,scheduled_at,accounts\n"Hi, ""you""\nthere",2026-01-01T10:00,"a;b"\n');
  assert.equal(rows[0].text, 'Hi, "you"\nthere');
  assert.equal(rows[0].accounts, 'a;b');
});

test('scheduled post is only published once due, never twice', async () => {
  const { svc, u1 } = setup();
  const acc = svc.addAccount(u1, { name: 'm', type: 'mock' });
  const p = svc.createPost(u1, { text: 'later', accountIds: [acc.id], scheduledAt: iso(3600e3) });
  assert.equal(await svc.runDue(), 0);
  assert.equal(await svc.runDue(new Date(Date.now() + 7200e3)), 1);
  assert.equal(svc.getPost(u1, p.id).status, 'published');
  assert.equal(await svc.runDue(new Date(Date.now() + 9000e3)), 0);
});

test('partial failure then manual retry only re-sends the failed account', async () => {
  const { svc, u1 } = setup();
  const ok = svc.addAccount(u1, { name: 'ok', type: 'mock' });
  const bad = svc.addAccount(u1, { name: 'bad', type: 'mock', config: { failWith: '400 nope' } });
  const p = svc.createPost(u1, { text: 'x', accountIds: [ok.id, bad.id], publishNow: true });
  await svc.runDue();
  let got = svc.getPost(u1, p.id);
  assert.equal(got.status, 'partial');
  svc.publishNow(u1, p.id); await svc.runDue();
  got = svc.getPost(u1, p.id);
  assert.equal(got.deliveries.find((d) => d.account_name === 'ok').attempts, 1);
  assert.equal(got.deliveries.find((d) => d.account_name === 'bad').error, '400 nope');
});

test('transient errors retry with backoff, then fail after 3 attempts', async () => {
  const { svc, u1 } = setup();
  const a = svc.addAccount(u1, { name: 'flaky', type: 'mock', config: { failWith: '503 try later' } });
  const p = svc.createPost(u1, { text: 'x', accountIds: [a.id], publishNow: true });
  await svc.runDue();
  let got = svc.getPost(u1, p.id);
  assert.equal(got.status, 'scheduled');
  assert.match(got.deliveries[0].error, /retrying/);
  assert.equal(await svc.runDue(new Date(Date.now() + 60e3)), 0, 'backoff not elapsed');
  await svc.runDue(new Date(Date.now() + 3 * 60e3));
  await svc.runDue(new Date(Date.now() + 10 * 60e3));
  got = svc.getPost(u1, p.id);
  assert.equal(got.status, 'failed');
  assert.equal(got.deliveries[0].attempts, 3);
});

test('users cannot see or touch each other\'s data', () => {
  const { svc, u1, u2 } = setup();
  const a1 = svc.addAccount(u1, { name: 'm', type: 'mock' });
  const p1 = svc.createPost(u1, { text: 'secret', accountIds: [a1.id] });
  assert.equal(svc.listAccounts(u2).length, 0);
  assert.equal(svc.listPosts(u2).length, 0);
  assert.throws(() => svc.getPost(u2, p1.id), /not found/);
  assert.throws(() => svc.createPost(u2, { text: 'x', accountIds: [a1.id] }), /unknown account/);
  svc.deletePost(u2, p1.id); svc.deleteAccount(u2, a1.id);
  assert.equal(svc.listPosts(u1).length, 1);
  assert.equal(svc.listAccounts(u1).length, 1);
  const a2 = svc.addAccount(u2, { name: 'm', type: 'mock' }); // same name allowed per user
  assert.ok(a2.id);
});

test('credentials are encrypted at rest', () => {
  const { db, svc, u1 } = setup();
  svc.addAccount(u1, { name: 'd', type: 'discord', config: { webhookUrl: 'https://discord.com/api/webhooks/SECRET' } });
  const raw = db.prepare('SELECT config FROM accounts').get().config;
  assert.ok(raw.startsWith('enc1:'));
  assert.ok(!raw.includes('SECRET'));
});

test('queue picks next free slot in the user timezone and skips taken ones', () => {
  const { svc, u1 } = setup();
  const a = svc.addAccount(u1, { name: 'm', type: 'mock' });
  assert.throws(() => svc.createPost(u1, { text: 'x', accountIds: [a.id], queue: true }), /no queue slots/);
  svc.setSlots(u1, [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, time: '09:00' })));
  const p1 = svc.createPost(u1, { text: 'one', accountIds: [a.id], queue: true });
  const p2 = svc.createPost(u1, { text: 'two', accountIds: [a.id], queue: true });
  assert.ok(new Date(p2.scheduled_at) - new Date(p1.scheduled_at) === 864e5, 'second goes to the following day');
  assert.equal(new Date(p1.scheduled_at).getUTCHours(), 9);
  assert.throws(() => svc.setSlots(u1, [{ dow: 9, time: '25:00' }]), /invalid/);
});

test('slot math respects timezone and DST', () => {
  // 2026-07-01 09:00 in New York (EDT, UTC-4) = 13:00Z; in January (EST, UTC-5) = 14:00Z
  assert.equal(zonedToUtc(2026, 7, 1, 9, 0, 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(zonedToUtc(2026, 1, 1, 9, 0, 'America/New_York').toISOString(), '2026-01-01T14:00:00.000Z');
  const from = new Date('2026-07-01T14:00:00Z'); // already past 09:00 NY that day
  const next = nextFreeSlot([{ dow: 3, time: '09:00' }], 'America/New_York', new Set(), from); // Wednesday
  assert.equal(next.toISOString(), '2026-07-08T13:00:00.000Z');
});

test('text over a network limit is rejected; duplicate makes a draft', () => {
  const { svc, u1 } = setup();
  const b = svc.addAccount(u1, { name: 'bsky', type: 'bluesky', config: { handle: 'h', password: 'p' } });
  assert.throws(() => svc.createPost(u1, { text: 'x'.repeat(301), accountIds: [b.id] }), /300/);
  const p = svc.createPost(u1, { text: 'hi', accountIds: [b.id], scheduledAt: iso(1e6) });
  const d = svc.duplicatePost(u1, p.id);
  assert.equal(d.status, 'draft'); assert.equal(d.text, 'hi'); assert.equal(d.deliveries.length, 1);
});

test('bulk import reports per-row errors', () => {
  const { svc, u1 } = setup();
  svc.addAccount(u1, { name: 'M', type: 'mock' });
  const r = svc.bulkImport(u1, 'text,scheduled_at,accounts\nA,2026-12-01T09:00,m\nB,,nope\n');
  assert.equal(r.created, 1); assert.equal(r.errors[0].row, 3);
});

test('mastodon provider posts to the instance API and secrets are masked', async () => {
  let seen;
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(b) };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: '1', url: 'https://x/1' }));
    });
  }).listen(0);
  const { svc, u1 } = setup();
  const a = svc.addAccount(u1, { name: 'masto', type: 'mastodon', config: { instance: `http://127.0.0.1:${fake.address().port}`, token: 'sekret' } });
  assert.equal(a.config.token, '••••••');
  const p = svc.createPost(u1, { text: 'hello', accountIds: [a.id], publishNow: true });
  await svc.runDue(); fake.close();
  assert.equal(seen.auth, 'Bearer sekret');
  assert.equal(svc.getPost(u1, p.id).deliveries[0].remote_url, 'https://x/1');
});

test('HTTP: setup, login, sessions, isolation, admin-only, signup closed', async () => {
  const db = openDb(':memory:');
  const svc = createService(db, createVault(randomBytes(32)));
  const auth = createAuth(db, { allowSignup: false });
  const srv = createApp(svc, auth).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, cookie } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body && JSON.stringify(body) });
    return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0], json: r.status === 204 ? null : await r.json().catch(() => null) };
  };
  assert.equal((await call('/api/accounts')).status, 401);
  assert.equal((await call('/api/auth/status')).json.needsSetup, true);
  const admin = await call('/api/auth/signup', { method: 'POST', body: { email: 'boss@x.io', password: 'longenough' } });
  assert.equal(admin.status, 201); assert.ok(admin.json.is_admin);
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: { email: 'z@x.io', password: 'longenough' } })).status, 403);
  assert.equal((await call('/api/users', { method: 'POST', cookie: admin.cookie, body: { email: 'friend@x.io', password: 'friendpass1' } })).status, 201);
  const friend = await call('/api/auth/login', { method: 'POST', body: { email: 'friend@x.io', password: 'friendpass1' } });
  assert.equal((await call('/api/users', { cookie: friend.cookie })).status, 403);
  await call('/api/accounts', { method: 'POST', cookie: admin.cookie, body: { name: 'm', type: 'mock' } });
  assert.equal((await call('/api/accounts', { cookie: friend.cookie })).json.length, 0);
  assert.equal((await call('/api/accounts', { cookie: admin.cookie })).json.length, 1);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'boss@x.io', password: 'wrong' } })).status, 401);
  const csrf = await fetch(base + '/api/accounts', { method: 'POST', headers: { 'content-type': 'text/plain', cookie: admin.cookie }, body: '{}' });
  assert.equal(csrf.status, 415, 'non-JSON bodies rejected');
  await call('/api/auth/logout', { method: 'POST', cookie: friend.cookie });
  assert.equal((await call('/api/accounts', { cookie: friend.cookie })).status, 401);
  srv.close();
});

test('login is rate limited after repeated failures', () => {
  const { auth } = setup();
  for (let i = 0; i < 5; i++) assert.throws(() => auth.login({ email: 'a@x.io', password: 'bad' }, '1.1.1.1'), /invalid/);
  assert.throws(() => auth.login({ email: 'a@x.io', password: 'password1' }, '1.1.1.1'), /too many/);
});

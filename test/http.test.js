import { test, after } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault } from '../src/vault.js';
import { createContext, createHandler } from '../src/server.js';
import { PNG, freshDb } from './helpers.js';

const dbs = [];
after(async () => { for (const d of dbs) await d.close(); });
async function boot() {
  const db = await freshDb();
  dbs.push(db);
  const ctx = await createContext(db, { vault: createVault(randomBytes(32)), mediaDir: mkdtempSync(join(tmpdir(), 'sp-')), blobToken: '', allowSignup: false });
  const srv = http.createServer(createHandler(ctx)).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (path, { method = 'GET', body, cookie, headers = {}, raw } = {}) => {
    const r = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...(cookie && { cookie }), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, headers: r.headers, cookie: r.headers.get('set-cookie')?.split(';')[0], json, text };
  };
  return { ctx, srv, base, call };
}

test('setup, login, admin-only users, CSRF, settings secrets never returned', async () => {
  const { srv, call, base } = await boot();
  assert.equal((await call('/api/bootstrap')).status, 401);
  assert.equal((await call('/api/auth/status')).json.needsSetup, true);
  const admin = await call('/api/auth/signup', { method: 'POST', body: { email: 'me@x.io', password: 'longenough' } });
  assert.ok(admin.json.is_admin);
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: { email: 'z@x.io', password: 'longenough' } })).status, 403, 'signup closed after the first user');
  const c = admin.cookie;
  const boot1 = await call('/api/bootstrap', { cookie: c });
  assert.ok(boot1.json.providers.instagram);
  assert.ok(boot1.json.connectors.x.app.steps.length);
  assert.equal(boot1.json.settings.apps.x.redirectUri, `${base}/oauth/callback/x`, 'redirect URI derived from where the UI is opened');

  const evil = await call('/api/settings', { method: 'PUT', cookie: c, headers: { origin: 'https://evil.example' }, body: { paused: true } });
  assert.equal(evil.status, 403);
  const s = await call('/api/settings', { method: 'PUT', cookie: c, headers: { origin: base }, body: { apps: { x: { clientId: 'id', clientSecret: 'TOPSECRET' } }, ai: { apiKey: 'sk-SECRET' } } });
  assert.equal(s.status, 200);
  assert.doesNotMatch(s.text, /TOPSECRET|sk-SECRET/);
  assert.equal(s.json.apps.x.configured, true);

  assert.equal((await call('/api/users', { method: 'POST', cookie: c, body: { email: 'friend@x.io', password: 'friendpass1' } })).status, 201);
  const friend = await call('/api/auth/login', { method: 'POST', body: { email: 'friend@x.io', password: 'friendpass1' } });
  assert.equal((await call('/api/users', { cookie: friend.cookie })).status, 403);
  assert.equal((await call('/api/accounts', { method: 'POST', cookie: c, raw: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  await call('/api/auth/logout', { method: 'POST', cookie: friend.cookie });
  assert.equal((await call('/api/bootstrap', { cookie: friend.cookie })).status, 401);
  srv.closeAllConnections(); srv.close();
});

test('posting flow over HTTP, media upload/serve with ranges, exports, OAuth errors', async () => {
  const { srv, call } = await boot();
  const { cookie: c } = await call('/api/auth/signup', { method: 'POST', body: { email: 'me@x.io', password: 'longenough' } });
  const acc = (await call('/api/accounts', { method: 'POST', cookie: c, body: { type: 'mock' } })).json;
  const up = await call('/api/media', { method: 'POST', cookie: c, raw: PNG, headers: { 'content-type': 'image/png', 'x-filename': 'pic.png' } });
  assert.equal(up.status, 201);
  const pub = await call(up.json.url);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('content-type'), 'image/png');
  const part = await call(up.json.url, { headers: { range: 'bytes=0-3' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-3/${PNG.length}`);
  assert.equal((await call('/media/nope.png')).status, 404);

  const check = await call('/api/posts/check', { method: 'POST', cookie: c, body: { text: '', accountIds: [] } });
  assert.deepEqual(check.json.problems, ['pick at least one account']);
  const bad = await call('/api/posts', { method: 'POST', cookie: c, body: { text: 'x'.repeat(600), accountIds: [acc.id], publishNow: true } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.problems[0], /600\/500/);
  const p = await call('/api/posts', { method: 'POST', cookie: c, body: { text: 'hi', media: [up.json.id], accountIds: [acc.id], publishNow: true } });
  assert.equal(p.status, 201);
  assert.equal(p.json.status, 'published');
  const q1 = await call('/api/posts', { method: 'POST', cookie: c, body: { text: 'later', accountIds: [acc.id] } });
  assert.equal(q1.json.status, 'queued');
  assert.equal((await call('/api/counts', { cookie: c })).json.queued, 1);
  const next = await call('/api/queue/next', { method: 'POST', cookie: c });
  assert.equal(next.json.id, q1.json.id);
  assert.equal(next.json.status, 'published');
  assert.equal((await call('/api/queue/next', { method: 'POST', cookie: c })).status, 404);
  // Vercel rewrites every path to /api?__route=<path>
  assert.equal((await call('/api?__route=api/counts', { cookie: c })).json.published, 2);

  const csv = await call('/api/export.csv', { cookie: c });
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  assert.match(csv.text, /"published"/);

  const needs = await call('/api/connect/x', { method: 'POST', cookie: c, body: {} });
  assert.equal(needs.status, 400);
  assert.equal(needs.json.needsSetup, 'x');
  const cb = await call('/oauth/callback/x?code=1&state=forged');
  assert.equal(cb.status, 302);
  assert.match(cb.headers.get('location'), /^\/#\/accounts\?error=.*expired/);

  const page = await call('/');
  assert.match(page.text, /<div id="app"/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  srv.closeAllConnections(); srv.close();
});

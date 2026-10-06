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
const servers = [];
// Close everything even when a test fails partway through, so the run can't hang.
after(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  for (const d of dbs) await d.close();
});
async function boot() {
  const db = await freshDb();
  dbs.push(db);
  const ctx = await createContext(db, { vault: createVault(randomBytes(32)), mediaDir: mkdtempSync(join(tmpdir(), 'sp-')), blobToken: '', allowSignup: false });
  const srv = http.createServer(createHandler(ctx)).listen(0, '127.0.0.1');
  servers.push(srv);
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

test('works when the host pre-parses the request body (Vercel helpers)', async () => {
  const db = await freshDb();
  dbs.push(db);
  const ctx = await createContext(db, { vault: createVault(randomBytes(32)), mediaDir: mkdtempSync(join(tmpdir(), 'sp-')), blobToken: '' });
  const inner = createHandler(ctx);
  // Mimic a host that reads the body first and exposes it as req.body, leaving the stream drained.
  const srv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    if (raw && (req.headers['content-type'] || '').includes('json')) req.body = JSON.parse(raw);
    return inner(req, res);
  }).listen(0, '127.0.0.1');
  servers.push(srv);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const r = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'pre@x.io', password: 'longenough' }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).email, 'pre@x.io');
  srv.closeAllConnections(); srv.close();
});

test('a missing-setup error renders a readable page for browsers, JSON for the API', async () => {
  const handler = createHandler(() => { throw Object.assign(new Error('Set the SECRET_KEY environment variable'), { status: 500, expose: true }); });
  const srv = http.createServer(handler).listen(0, '127.0.0.1');
  servers.push(srv);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const page = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
  assert.equal(page.status, 500);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /Set the SECRET_KEY/);
  assert.match(html, /needs one more step/);
  const json = await fetch(`${base}/api/auth/status`);
  assert.match((await json.json()).error, /Set the SECRET_KEY/);
  srv.closeAllConnections(); srv.close();
});

test('MCP endpoint: tools need a valid key, then drive the queue end to end', async () => {
  const { srv, call, base } = await boot();
  const { cookie: c } = await call('/api/auth/signup', { method: 'POST', body: { email: 'me@x.io', password: 'longenough' } });
  const acc = (await call('/api/accounts', { method: 'POST', cookie: c, body: { type: 'mock', name: 'Test' } })).json;

  const rpc = (body, opts = {}) => call('/mcp' + (opts.query || ''), { method: 'POST', body, headers: opts.key ? { authorization: `Bearer ${opts.key}` } : {} });
  // Discovery works without a key, so a connector can be added before pasting one.
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.json.result.serverInfo.name, 'social-poster');
  const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = tools.json.result.tools.map((t) => t.name);
  assert.ok(names.includes('add_to_queue') && names.includes('publish_post'));
  for (const t of tools.json.result.tools) assert.equal(t.inputSchema.type, 'object');

  // Using a tool without a key is refused.
  const denied = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_accounts' } });
  assert.equal(denied.status, 401);
  assert.match(denied.json.error.message, /access key/i);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_accounts' } }, { key: 'sp_wrongkey000000000000' })).status, 401);

  const key = (await call('/api/keys', { method: 'POST', cookie: c, body: { name: 'Claude' } })).json;
  assert.match(key.secret, /^sp_/);
  assert.equal((await call('/api/keys', { cookie: c })).json[0].secret, undefined, 'the secret is never listed again');

  const listed = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_accounts' } }, { key: key.secret });
  assert.match(listed.json.result.content[0].text, /"network": "Test account/);
  // the key also works in the URL, for connectors that only take a URL
  assert.equal((await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_accounts' } }, { query: `?key=${key.secret}` })).json.result.content[0].text.includes('Test'), true);

  const added = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'add_to_queue', arguments: { text: 'Hello from the assistant', account_ids: [acc.id] } } }, { key: key.secret });
  const post = JSON.parse(added.json.result.content[0].text).added;
  assert.equal(post.status, 'queued');
  assert.equal((await call('/api/counts', { cookie: c })).json.queued, 1);

  const published = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'publish_post', arguments: { post_id: post.id } } }, { key: key.secret });
  assert.equal(JSON.parse(published.json.result.content[0].text).result.status, 'published');

  // A failing tool reports the problem instead of breaking the connection.
  const bad = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'publish_post', arguments: { post_id: 9999 } } }, { key: key.secret });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.result.isError, true);
  assert.match(bad.json.result.content[0].text, /not found/);

  // Notifications get no body; one user's key never reaches another user's data.
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, { key: key.secret })).status, 202);
  await call('/api/users', { method: 'POST', cookie: c, body: { email: 'friend@x.io', password: 'friendpass1' } });
  const friend = await call('/api/auth/login', { method: 'POST', body: { email: 'friend@x.io', password: 'friendpass1' } });
  const fkey = (await call('/api/keys', { method: 'POST', cookie: friend.cookie, body: { name: 'theirs' } })).json;
  const theirs = await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'list_posts', arguments: { status: 'all' } } }, { key: fkey.secret });
  assert.match(theirs.json.result.content[0].text, /"count": 0/);
  srv.closeAllConnections(); srv.close();
});

test('cron endpoint publishes due posts for its own user only', async () => {
  const { srv, call } = await boot();
  const { cookie: c } = await call('/api/auth/signup', { method: 'POST', body: { email: 'me@x.io', password: 'longenough' } });
  const acc = (await call('/api/accounts', { method: 'POST', cookie: c, body: { type: 'mock' } })).json;
  const past = new Date(Date.now() - 60e3).toISOString();
  await call('/api/posts', { method: 'POST', cookie: c, body: { text: 'due now', accountIds: [acc.id], scheduledAt: past } });
  assert.equal((await call('/api/counts', { cookie: c })).json.scheduled, 1);

  assert.equal((await call('/api/cron')).status, 401, 'no key');
  assert.equal((await call('/api/cron?key=cr_notarealkey0000000')).status, 401, 'wrong key');

  const { url } = (await call('/api/cron-url', { cookie: c })).json;
  assert.match(url, /\/api\/cron\?key=cr_/);
  const key = url.split('key=')[1];
  // A timer service hits it with a plain GET.
  const ran = await call(`/api/cron?key=${key}`);
  assert.equal(ran.status, 200);
  assert.equal(ran.json.ran[0].published.due, 1);
  assert.equal((await call('/api/counts', { cookie: c })).json.published, 1);
  assert.equal((await call(`/api/cron?key=${key}`)).json.ran[0].published.due, 0, 'nothing left to do');

  // Another user's posts are untouched by that key.
  await call('/api/users', { method: 'POST', cookie: c, body: { email: 'friend@x.io', password: 'friendpass1' } });
  const friend = await call('/api/auth/login', { method: 'POST', body: { email: 'friend@x.io', password: 'friendpass1' } });
  const facc = (await call('/api/accounts', { method: 'POST', cookie: friend.cookie, body: { type: 'mock' } })).json;
  await call('/api/posts', { method: 'POST', cookie: friend.cookie, body: { text: 'theirs', accountIds: [facc.id], scheduledAt: past } });
  await call(`/api/cron?key=${key}`);
  assert.equal((await call('/api/counts', { cookie: friend.cookie })).json.scheduled, 1, 'still waiting');
  srv.closeAllConnections(); srv.close();
});

test('CRON_SECRET runs every user, as Vercel Cron does', async () => {
  process.env.CRON_SECRET = 'top-secret-value';
  const { srv, call } = await boot();
  const { cookie: c } = await call('/api/auth/signup', { method: 'POST', body: { email: 'me@x.io', password: 'longenough' } });
  const acc = (await call('/api/accounts', { method: 'POST', cookie: c, body: { type: 'mock' } })).json;
  await call('/api/posts', { method: 'POST', cookie: c, body: { text: 'due', accountIds: [acc.id], scheduledAt: new Date(Date.now() - 1000).toISOString() } });
  const ran = await call('/api/cron', { headers: { authorization: 'Bearer top-secret-value' } });
  assert.equal(ran.status, 200);
  assert.equal(ran.json.ran[0].published.due, 1);
  assert.equal((await call('/api/cron', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  delete process.env.CRON_SECRET;
  srv.closeAllConnections(); srv.close();
});

test('a reply that carries its own list of changes is not mistaken for a database result', async () => {
  const { srv, ctx, call } = await boot();
  const cookie = (await call('/api/auth/signup', { method: 'POST', body: { email: 'me@x.io', password: 'longenough' } })).cookie;
  // Only a database write result (a numeric `changes`) collapses to {ok:true}; anything else
  // is the answer itself. The grammar check returns a list of changes and must survive.
  ctx.ai.grammar = async () => ({ corrected: 'fixed', changed: true, changes: [{ before: 'teh', after: 'the', why: 'typo' }] });
  const r = await call('/api/ai/grammar', { method: 'POST', cookie, body: { text: 'teh' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.corrected, 'fixed');
  assert.deepEqual(r.json.changes, [{ before: 'teh', after: 'the', why: 'typo' }]);
  srv.closeAllConnections(); srv.close();
});

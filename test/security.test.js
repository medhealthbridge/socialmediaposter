/**
 * Does one person's data stay their own?
 *
 * Everything here goes through HTTP, the way a real attacker would: a logged-in account
 * trying to reach another account's records by id, by reference and through the back doors
 * (exports, search, the cron URL, the assistant's key). Nothing calls into the modules
 * directly, so a refactor cannot quietly make these pass.
 */
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
after(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  for (const d of dbs) await d.close();
});

async function boot({ allowSignup = true } = {}) {
  const db = await freshDb();
  dbs.push(db);
  const ctx = await createContext(db, { vault: createVault(randomBytes(32)), mediaDir: mkdtempSync(join(tmpdir(), 'sp-sec-')), blobToken: '', allowSignup });
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

/** A real RSS feed on localhost, so feed tests do not depend on the outside world. */
async function feedServer() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Test feed</title>
      <item><title>Hello</title><link>https://example.com/1</link><guid>1</guid></item></channel></rss>`);
  }).listen(0, '127.0.0.1');
  servers.push(srv);
  await new Promise((r) => srv.once('listening', r));
  return `http://127.0.0.1:${srv.address().port}`;
}

/** Two separate people, each with one of everything, so every route has something to aim at. */
async function twoPeople(call) {
  const feedBase = await feedServer();
  const admin = await call('/api/auth/signup', { method: 'POST', body: { email: 'admin@x.io', password: 'adminpass1' } });
  const member = await call('/api/auth/signup', { method: 'POST', body: { email: 'member@x.io', password: 'memberpass1' } });
  assert.ok(admin.json.is_admin, 'the first account is the admin');
  assert.equal(member.json.is_admin, false, 'later accounts are not');

  const own = async (cookie, who) => {
    const acc = await call('/api/accounts', { method: 'POST', cookie, body: { type: 'mock', name: `${who} account`, config: {} } });
    const media = await call('/api/media', { method: 'POST', cookie, raw: PNG, headers: { 'content-type': 'application/octet-stream', 'x-filename': `${who}.png` } });
    const post = await call('/api/posts', { method: 'POST', cookie, body: { text: `${who} secret post`, accountIds: [acc.json.id] } });
    const snippet = await call('/api/snippets', { method: 'POST', cookie, body: { name: `${who} snippet`, body: 'shh' } });
    const feed = await call('/api/feeds', { method: 'POST', cookie, body: { url: `${feedBase}/${who}.xml`, accountIds: [acc.json.id] } });
    const key = await call('/api/keys', { method: 'POST', cookie, body: { name: `${who} key` } });
    for (const [what, r] of Object.entries({ acc, media, post, snippet, feed, key })) {
      assert.ok(r.status < 300, `${who}'s own ${what} should be created, got ${r.status} ${r.text.slice(0, 120)}`);
    }
    return { cookie, acc: acc.json, media: media.json, post: post.json, snippet: snippet.json, feed: feed.json, key: key.json };
  };
  return { A: await own(admin.cookie, 'admin'), B: await own(member.cookie, 'member') };
}

test('T-ISO-01 every :id route refuses another account’s record', async () => {
  const { call } = await boot();
  const { A, B } = await twoPeople(call);

  // One row per route that takes an id. A is the admin, so this also proves that being
  // an admin does not grant a peek at another person's content — only at the user list.
  const attempts = (t) => [
    ['GET', `/api/posts/${t.post.id}`],
    ['PUT', `/api/posts/${t.post.id}`, { text: 'hijacked' }],
    ['DELETE', `/api/posts/${t.post.id}`],
    ['POST', `/api/posts/${t.post.id}/publish`],
    ['POST', `/api/posts/${t.post.id}/move`, { dir: 'up' }],
    ['POST', `/api/posts/${t.post.id}/duplicate`],
    ['PATCH', `/api/accounts/${t.acc.id}`, { name: 'hijacked' }],
    ['DELETE', `/api/accounts/${t.acc.id}`],
    ['POST', `/api/accounts/${t.acc.id}/check`],
    ['POST', `/api/accounts/${t.acc.id}/test-post`],
    ['GET', `/api/accounts/${t.acc.id}/options`],
    ['POST', `/api/accounts/${t.acc.id}/options`, { key: 'privacyStatus', value: 'public' }],
    ['PATCH', `/api/media/${t.media.id}`, { alt: 'hijacked' }],
    ['DELETE', `/api/media/${t.media.id}`],
    ['PUT', `/api/snippets/${t.snippet.id}`, { name: 'hijacked', body: 'x' }],
    ['DELETE', `/api/snippets/${t.snippet.id}`],
    ['PUT', `/api/feeds/${t.feed.id}`, { enabled: false }],
    ['DELETE', `/api/feeds/${t.feed.id}`],
    ['POST', `/api/feeds/${t.feed.id}/check`],
    ['DELETE', `/api/keys/${t.key.id}`],
  ];

  const leaks = [];
  for (const [me, them] of [[A, B], [B, A]]) {
    for (const [method, path, body] of attempts(them)) {
      const r = await call(path, { method, cookie: me.cookie, body });
      if (r.status < 400) leaks.push(`${method} ${path} answered ${r.status}: ${r.text.slice(0, 160)}`);
    }
  }
  assert.deepEqual(leaks, [], 'no cross-account request may succeed');

  // The hard part: after all that, both people still have everything they started with,
  // unchanged. A refusal that still wrote something would be no refusal at all.
  for (const [who, t] of [['admin', A], ['member', B]]) {
    const post = await call(`/api/posts/${t.post.id}`, { cookie: t.cookie });
    assert.equal(post.status, 200, `${who}'s post survived`);
    assert.equal(post.json.text, `${who} secret post`, `${who}'s post text is untouched`);
    assert.equal((await call('/api/accounts', { cookie: t.cookie })).json.length, 1, `${who} still has their account`);
    assert.equal((await call('/api/accounts', { cookie: t.cookie })).json[0].name, `${who} account`, 'and it was not renamed');
    assert.equal((await call('/api/media', { cookie: t.cookie })).json.length, 1, `${who} still has their media`);
    assert.equal((await call('/api/snippets', { cookie: t.cookie })).json.length, 1, `${who} still has their snippet`);
    assert.equal((await call('/api/feeds', { cookie: t.cookie })).json.length, 1, `${who} still has their feed`);
    assert.equal((await call('/api/keys', { cookie: t.cookie })).json.length, 1, `${who} still has their key`);
  }
});

test('T-ISO-05 deleting what is not yours says so, instead of reporting success', async () => {
  const { call } = await boot();
  const { A, B } = await twoPeople(call);
  // A delete that removed nothing must not answer "ok" — the UI would tick it off as done.
  for (const path of [`/api/posts/${B.post.id}`, `/api/accounts/${B.acc.id}`, `/api/media/${B.media.id}`,
    `/api/snippets/${B.snippet.id}`, `/api/feeds/${B.feed.id}`, `/api/keys/${B.key.id}`]) {
    assert.equal((await call(path, { method: 'DELETE', cookie: A.cookie })).status, 404, `DELETE ${path}`);
  }
  for (const path of ['/api/posts/999999', '/api/media/999999', '/api/snippets/999999', '/api/feeds/999999']) {
    assert.equal((await call(path, { method: 'DELETE', cookie: A.cookie })).status, 404, `DELETE ${path}`);
  }
  // Your own things still delete cleanly, and clearing the whole log is not a "not found".
  assert.equal((await call(`/api/snippets/${A.snippet.id}`, { method: 'DELETE', cookie: A.cookie })).status, 200);
  assert.equal((await call('/api/events', { method: 'DELETE', cookie: A.cookie })).status, 200);
  assert.equal((await call('/api/events', { method: 'DELETE', cookie: A.cookie })).status, 200, 'clearing an empty log is fine');
});

test('T-ISO-02 listings, search, counts, exports and the log show only your own rows', async () => {
  const { call } = await boot();
  const { A, B } = await twoPeople(call);

  const mine = async (who) => ({
    posts: (await call('/api/posts', { cookie: who.cookie })).json,
    search: (await call('/api/posts?q=secret', { cookie: who.cookie })).json,
    media: (await call('/api/media', { cookie: who.cookie })).json,
    accounts: (await call('/api/accounts', { cookie: who.cookie })).json,
    snippets: (await call('/api/snippets', { cookie: who.cookie })).json,
    feeds: (await call('/api/feeds', { cookie: who.cookie })).json,
    keys: (await call('/api/keys', { cookie: who.cookie })).json,
    events: (await call('/api/events', { cookie: who.cookie })).json,
    json: (await call('/api/export.json', { cookie: who.cookie })).text,
    csv: (await call('/api/export.csv', { cookie: who.cookie })).text,
    boot: (await call('/api/bootstrap', { cookie: who.cookie })).text,
    analytics: (await call('/api/analytics', { cookie: who.cookie })).text,
  });
  const a = await mine(A), b = await mine(B);

  for (const [who, seen, otherWord] of [['admin', a, 'member'], ['member', b, 'admin']]) {
    for (const [what, rows] of Object.entries(seen)) {
      const text = typeof rows === 'string' ? rows : JSON.stringify(rows);
      assert.equal(text.includes(`${otherWord} secret post`), false, `${who}'s ${what} must not contain the other person's post`);
      assert.equal(text.includes(`${otherWord} snippet`), false, `${who}'s ${what} must not contain the other person's snippet`);
      assert.equal(text.includes(`${otherWord} account`), false, `${who}'s ${what} must not contain the other person's account`);
    }
    assert.equal(seen.posts.length, 1);
    assert.equal(seen.search.length, 1, 'search is scoped too');
    assert.equal(seen.media.length, 1);
    assert.equal(seen.keys.length, 1);
  }
  // Counts are per person, not per install.
  assert.deepEqual((await call('/api/counts', { cookie: A.cookie })).json.queued, 1);
});

test('T-ISO-03 a record cannot be made to point at another account’s rows', async () => {
  const { call } = await boot();
  const { A, B } = await twoPeople(call);

  // A post delivered to someone else's account would publish from their identity.
  const post = await call('/api/posts', { method: 'POST', cookie: A.cookie, body: { text: 'borrowed voice', accountIds: [B.acc.id] } });
  assert.ok(post.status >= 400, `a post must not accept another account id (got ${post.status} ${post.text.slice(0, 160)})`);

  // Same through an edit of a post you do own.
  const edit = await call(`/api/posts/${A.post.id}`, { method: 'PUT', cookie: A.cookie, body: { text: 'x', accountIds: [B.acc.id] } });
  assert.ok(edit.status >= 400, `an edit must not accept another account id (got ${edit.status})`);

  // A feed posts on a schedule; pointing it at someone else's account is the same theft.
  const feed = await call('/api/feeds', { method: 'POST', cookie: A.cookie, body: { url: `${await feedServer()}/x.xml`, accountIds: [B.acc.id] } });
  assert.ok(feed.status >= 400, `a feed must not accept another account id (got ${feed.status} ${feed.text.slice(0, 160)})`);

  // Attaching someone else's media would publish their file.
  const withMedia = await call('/api/posts', { method: 'POST', cookie: A.cookie, body: { text: 'borrowed picture', accountIds: [A.acc.id], media: [B.media.id] } });
  assert.ok(withMedia.status >= 400, `a post must not accept another account's media (got ${withMedia.status})`);

  // Failure alerts are sent to an account id from settings — it must be one of yours.
  const alerts = await call('/api/settings', { method: 'PUT', cookie: A.cookie, body: { alertsAccountId: B.acc.id } });
  assert.ok(alerts.status >= 400, `alerts must not accept another account id (got ${alerts.status})`);
});

test('T-PRIV-01 a member cannot become an admin or touch the user list', async () => {
  const { call } = await boot();
  const admin = await call('/api/auth/signup', { method: 'POST', body: { email: 'admin@x.io', password: 'adminpass1' } });
  const member = await call('/api/auth/signup', { method: 'POST', body: { email: 'member@x.io', password: 'memberpass1' } });

  // The admin-only routes are closed to a member.
  assert.equal((await call('/api/users', { cookie: member.cookie })).status, 403);
  assert.equal((await call('/api/users', { method: 'POST', cookie: member.cookie, body: { email: 'x@x.io', password: 'longenough' } })).status, 403);
  assert.equal((await call(`/api/users/${admin.json.id}`, { method: 'DELETE', cookie: member.cookie })).status, 403);

  // Extra fields smuggled into requests a member *is* allowed to make change nothing.
  for (const body of [{ is_admin: 1 }, { isAdmin: true }, { id: admin.json.id }, { user_id: admin.json.id }]) {
    await call('/api/me', { method: 'PUT', cookie: member.cookie, body: { tz: 'UTC', ...body } });
    await call('/api/settings', { method: 'PUT', cookie: member.cookie, body });
  }
  const after = (await call('/api/bootstrap', { cookie: member.cookie })).json.user;
  assert.equal(after.is_admin, false, 'still not an admin');
  assert.equal(after.id, member.json.id, 'still the same person');
  assert.equal((await call('/api/users', { cookie: member.cookie })).status, 403, 'and still locked out');

  // Signing up asking to be an admin does not make you one.
  const sneak = await call('/api/auth/signup', { method: 'POST', body: { email: 'sneak@x.io', password: 'sneakpass1', isAdmin: true, is_admin: 1 } });
  assert.equal(sneak.json.is_admin, false, 'only the very first account is an admin');
});

test('T-AUTH-01 sessions end when they should, and a closed install refuses signups', async () => {
  const { ctx, call } = await boot({ allowSignup: false });
  const me = await call('/api/auth/signup', { method: 'POST', body: { email: 'me@x.io', password: 'longenough' } });
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: { email: 'other@x.io', password: 'longenough' } })).status, 403,
    'the second person cannot sign themselves up');

  // Logging out kills the cookie for good.
  await call('/api/auth/logout', { method: 'POST', cookie: me.cookie });
  assert.equal((await call('/api/bootstrap', { cookie: me.cookie })).status, 401);

  // An expired session is refused even though the row still exists.
  const again = await call('/api/auth/login', { method: 'POST', body: { email: 'me@x.io', password: 'longenough' } });
  assert.equal((await call('/api/bootstrap', { cookie: again.cookie })).status, 200);
  await ctx.db.run('UPDATE sessions SET expires_at=?', new Date(Date.now() - 1000).toISOString());
  assert.equal((await call('/api/bootstrap', { cookie: again.cookie })).status, 401, 'an expired session is no session');

  // Changing the password signs every device out.
  const back = await call('/api/auth/login', { method: 'POST', body: { email: 'me@x.io', password: 'longenough' } });
  const other = await call('/api/auth/login', { method: 'POST', body: { email: 'me@x.io', password: 'longenough' } });
  assert.equal((await call('/api/me/password', { method: 'POST', cookie: back.cookie, body: { current: 'wrong-one', next: 'brandnewpass' } })).status, 403);
  assert.equal((await call('/api/me/password', { method: 'POST', cookie: back.cookie, body: { current: 'longenough', next: 'short' } })).status, 400);
  assert.equal((await call('/api/me/password', { method: 'POST', cookie: back.cookie, body: { current: 'longenough', next: 'brandnewpass' } })).status, 200);
  assert.equal((await call('/api/bootstrap', { cookie: other.cookie })).status, 401, 'the other device is signed out too');
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { email: 'me@x.io', password: 'longenough' } })).status, 401, 'the old password is dead');

  // A made-up cookie is nobody.
  assert.equal((await call('/api/bootstrap', { cookie: 'sid=' + 'f'.repeat(64) })).status, 401);
  assert.equal((await call('/api/posts')).status, 401, 'and no cookie at all is nobody');
});

test('T-AUTH-02 an assistant key and a timer key each reach one account only', async () => {
  const { call } = await boot();
  const { A, B } = await twoPeople(call);

  // An MCP key belongs to the person who made it: it must not list the other person's posts.
  const mcp = async (key) => call('/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_posts', arguments: {} } } });
  const asA = await mcp(A.key.secret);
  assert.match(asA.text, /admin secret post/, 'A’s key sees A’s post');
  assert.equal(asA.text.includes('member secret post'), false, 'A’s key must not see B’s post');
  assert.equal((await mcp('mk_not_a_real_key')).status, 401, 'an invented key is refused');

  // The timer URL carries a per-person key; it must only run that person's queue.
  const urlA = (await call('/api/cron-url', { cookie: A.cookie })).json.url;
  const keyA = new URL(urlA).searchParams.get('key');
  const ran = await call(`/api/cron?key=${encodeURIComponent(keyA)}`);
  assert.equal(ran.status, 200);
  assert.equal(ran.json.ran.length, 1, 'one person’s timer key runs one person’s queue');
  assert.equal((await call('/api/cron?key=cr_madeup')).status, 401);
});

test('T-ISO-04 deleting an account takes its data with it and never hands the id on', async () => {
  const { ctx, call } = await boot();
  const { A, B } = await twoPeople(call);
  const gone = B.post.id;

  assert.equal((await call(`/api/users/${B.acc.user_id ?? ''}`, { method: 'DELETE', cookie: A.cookie })).status < 500, true);
  const bId = (await ctx.db.get('SELECT id FROM users WHERE email=?', 'member@x.io'))?.id;
  assert.ok(bId, 'the member is still there — members are deleted by id, not by guesswork');
  assert.equal((await call(`/api/users/${bId}`, { method: 'DELETE', cookie: A.cookie })).status, 200);

  // Their rows go with them, so nothing is left behind to leak.
  for (const t of ['posts', 'media', 'accounts', 'snippets', 'feeds', 'events', 'settings', 'sessions']) {
    const n = (await ctx.db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id=?`, bId)).n;
    assert.equal(Number(n), 0, `${t} rows should be gone with the account`);
  }
  assert.equal((await ctx.db.get('SELECT COUNT(*) AS n FROM posts WHERE id=?', gone)).n, 0);

  // And the next person must not inherit the id — otherwise they would inherit the data.
  const next = await call('/api/users', { method: 'POST', cookie: A.cookie, body: { email: 'new@x.io', password: 'newpassword1' } });
  assert.equal(next.status, 201);
  assert.notEqual(next.json.id, bId, 'ids are never handed on to the next account');
});

test('T-VAL-01 junk input is refused cleanly, never with a crash', async () => {
  const { call } = await boot();
  const me = await call('/api/auth/signup', { method: 'POST', body: { email: 'me@x.io', password: 'longenough' } });
  const cookie = me.cookie;
  const acc = (await call('/api/accounts', { method: 'POST', cookie, body: { type: 'mock', name: 'A', config: {} } })).json;

  const nasty = [
    ['POST', '/api/posts', { text: 'x', accountIds: 'not-an-array' }],
    ['POST', '/api/posts', { text: 'x', accountIds: [acc.id], media: 'nope' }],
    ['POST', '/api/posts', { text: 'x', accountIds: [{ evil: 1 }] }],
    ['POST', '/api/posts', { text: null, accountIds: [acc.id] }],
    ['POST', '/api/posts', { text: 'x'.repeat(200000), accountIds: [acc.id] }],
    ['POST', '/api/posts', { text: 'x', accountIds: [acc.id], parts: 'nope' }],
    ['POST', '/api/posts', { text: 'x', accountIds: [acc.id], scheduledAt: 'the day after never' }],
    ['POST', '/api/posts', { text: 'x', accountIds: [acc.id], recycleDays: -5 }],
    ['PUT', '/api/me', { tz: 'Mars/Olympus_Mons' }],
    ['PUT', '/api/settings', { publicUrl: 'javascript:alert(1)' }],
    ['PUT', '/api/settings', { ai: { provider: 'not-a-provider' } }],
    ['PUT', '/api/settings', { utm: { enabled: 'yes', source: { nested: true } } }],
    ['PUT', '/api/slots', { slots: 'nope' }],
    ['PUT', '/api/slots', { slots: [{ dow: 99, time: '99:99' }] }],
    ['POST', '/api/snippets', { name: '', body: '' }],
    ['POST', '/api/feeds', { url: 'not a url' }],
    ['POST', '/api/feeds', { url: 'file:///etc/passwd' }],
    ['POST', '/api/accounts', { type: 'no-such-network', name: 'x', config: {} }],
    ['POST', '/api/bulk', { csv: 123 }],
    ['POST', '/api/ai', { action: 'no-such-action', text: 'x' }],
    ['GET', '/api/drive?link=file:///etc/passwd'],
    ['GET', '/api/events?limit=-1&kind=../../etc'],
    ['GET', '/api/analytics?days=abc'],
    ['GET', '/api/posts/not-a-number'],
    ['DELETE', '/api/media/not-a-number'],
  ];

  const crashes = [];
  for (const [method, path, body] of nasty) {
    const r = await call(path, { method, cookie, body });
    if (r.status >= 500) crashes.push(`${method} ${path} -> ${r.status} ${r.text.slice(0, 120)}`);
    // Whatever happens, the answer is JSON with a readable message, never a stack trace.
    if (r.status >= 400 && (!r.json || typeof r.json.error !== 'string')) crashes.push(`${method} ${path} -> unreadable error ${r.text.slice(0, 120)}`);
    if (/\s+at\s+\S+\(.*:\d+:\d+\)/.test(r.text)) crashes.push(`${method} ${path} -> leaked a stack trace`);
  }
  assert.deepEqual(crashes, [], 'bad input must be refused, not crash the server');

  // Malformed JSON and the wrong content type are refused too.
  assert.equal((await call('/api/posts', { method: 'POST', cookie, raw: '{not json', headers: { 'content-type': 'application/json' } })).status, 400);
  assert.equal((await call('/api/posts', { method: 'POST', cookie, raw: 'text', headers: { 'content-type': 'text/plain' } })).status, 415);

  // And after all of that the account is still intact.
  assert.equal((await call('/api/accounts', { cookie })).json.length, 1);
  assert.equal((await call('/api/bootstrap', { cookie })).json.user.is_admin, true);
});

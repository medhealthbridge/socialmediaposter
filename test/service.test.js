import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createService, parseCsv } from '../src/service.js';
import { createApp } from '../src/server.js';

const fresh = () => createService(openDb(':memory:'));

test('parseCsv handles quotes, commas and newlines', () => {
  const rows = parseCsv('text,scheduled_at,accounts\n"Hi, ""you""\nthere",2026-01-01T10:00,"a;b"\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'Hi, "you"\nthere');
  assert.equal(rows[0].accounts, 'a;b');
});

test('scheduled post is only published once it is due', async () => {
  const s = fresh();
  const acc = s.addAccount({ name: 'm', type: 'mock' });
  const p = s.createPost({ text: 'later', accountIds: [acc.id], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
  assert.equal(await s.runDue(), 0);
  assert.equal(s.getPost(p.id).status, 'scheduled');
  assert.equal(await s.runDue(new Date(Date.now() + 7200e3)), 1);
  assert.equal(s.getPost(p.id).status, 'published');
  assert.equal(await s.runDue(new Date(Date.now() + 9000e3)), 0, 'never double-posts');
});

test('partial failure then retry only re-sends failed account', async () => {
  const s = fresh();
  const ok = s.addAccount({ name: 'ok', type: 'mock' });
  const bad = s.addAccount({ name: 'bad', type: 'mock', config: { failWith: 'boom' } });
  const p = s.createPost({ text: 'x', accountIds: [ok.id, bad.id], publishNow: true });
  await s.runDue();
  let got = s.getPost(p.id);
  assert.equal(got.status, 'partial');
  assert.equal(got.deliveries.find((d) => d.account_name === 'bad').error, 'boom');
  const attemptsOk = got.deliveries.find((d) => d.account_name === 'ok').attempts;
  s.publishNow(p.id); await s.runDue();
  got = s.getPost(p.id);
  assert.equal(got.deliveries.find((d) => d.account_name === 'ok').attempts, attemptsOk);
  assert.equal(got.deliveries.find((d) => d.account_name === 'bad').attempts, 2);
});

test('rejects text over a network limit and unknown accounts', () => {
  const s = fresh();
  const a = s.addAccount({ name: 'bsky', type: 'bluesky', config: { handle: 'h', password: 'p' } });
  assert.throws(() => s.createPost({ text: 'x'.repeat(301), accountIds: [a.id] }), /300/);
  assert.throws(() => s.createPost({ text: 'x', accountIds: [999] }), /unknown account/);
});

test('bulk import reports per-row errors', () => {
  const s = fresh();
  s.addAccount({ name: 'M', type: 'mock' });
  const r = s.bulkImport('text,scheduled_at,accounts\nA,2026-12-01T09:00,m\nB,,nope\n');
  assert.equal(r.created, 1);
  assert.equal(r.errors[0].row, 3);
});

test('mastodon provider posts to the instance API and secrets are masked', async () => {
  let seen;
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(b) };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: '1', url: 'https://x/1' }));
    });
  }).listen(0);
  const port = fake.address().port;
  const s = fresh();
  const a = s.addAccount({ name: 'masto', type: 'mastodon', config: { instance: `http://127.0.0.1:${port}`, token: 'sekret' } });
  assert.equal(a.config.token, '••••••');
  const p = s.createPost({ text: 'hello', accountIds: [a.id], publishNow: true });
  await s.runDue();
  fake.close();
  assert.equal(seen.url, '/api/v1/statuses');
  assert.equal(seen.auth, 'Bearer sekret');
  assert.equal(s.getPost(p.id).deliveries[0].remote_url, 'https://x/1');
});

test('HTTP API + password protection', async () => {
  const s = fresh();
  const srv = createApp(s, { password: 'pw' }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  assert.equal((await fetch(`${base}/api/accounts`)).status, 401);
  const h = { authorization: 'Basic ' + Buffer.from('u:pw').toString('base64'), 'content-type': 'application/json' };
  const r = await fetch(`${base}/api/accounts`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'm', type: 'mock' }) });
  assert.equal(r.status, 201);
  assert.equal((await fetch(`${base}/`, { headers: h })).status, 200);
  srv.close();
});

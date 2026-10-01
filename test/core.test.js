import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, PNG, JPEG, chunks, iso, fakeServer } from './helpers.js';
import { parseCsv } from '../src/service.js';
import { blueskyFacets, linkedinText, addUtm, lengthUrlsAs } from '../src/providers/text.js';
import { nextFreeSlot, zonedToUtc } from '../src/slots.js';
import { parseFeed } from '../src/feeds.js';

test('text helpers: facets use UTF-8 byte offsets, LinkedIn escaping, UTM, URL length', () => {
  const t = '🎉 new post https://ex.com/a #launch';
  const f = blueskyFacets(t);
  const bytes = Buffer.from(t);
  const link = f.find((x) => x.features[0].uri);
  assert.equal(bytes.subarray(link.index.byteStart, link.index.byteEnd).toString(), 'https://ex.com/a');
  const tag = f.find((x) => x.features[0].tag);
  assert.equal(bytes.subarray(tag.index.byteStart, tag.index.byteEnd).toString(), '#launch');
  assert.equal(linkedinText('Hi (all) #news @me'), 'Hi \\(all\\) {hashtag|\\#|news} \\@me');
  assert.equal(addUtm('see https://ex.com/p?a=1.', { source: 'x', medium: 'social' }), 'see https://ex.com/p?a=1&utm_source=x&utm_medium=social.');
  assert.equal(addUtm('https://ex.com/?utm_source=keep', { source: 'x' }), 'https://ex.com/?utm_source=keep');
  assert.equal(lengthUrlsAs(23)('a https://example.com/' + 'x'.repeat(100)), 25);
});

test('parseCsv handles quotes, commas, newlines and BOM', () => {
  const rows = parseCsv('﻿text,scheduled_at,accounts\n"Hi, ""you""\nthere",2026-01-01T10:00,"a;b"\n');
  assert.equal(rows[0].text, 'Hi, "you"\nthere');
  assert.equal(rows[0].accounts, 'a;b');
});

test('scheduled post is published once when due, never twice', async () => {
  const { svc, u1 } = setup();
  const acc = await svc.addAccount(u1, { type: 'mock', config: {} });
  const p = svc.createPost(u1, { text: 'later', accountIds: [acc.id], scheduledAt: iso(3600e3) });
  assert.equal(await svc.runDue(), 0);
  assert.equal(await svc.runDue(new Date(Date.now() + 7200e3)), 1);
  assert.equal(svc.getPost(u1, p.id).status, 'published');
  assert.equal(await svc.runDue(new Date(Date.now() + 9000e3)), 0);
});

test('drafts may be incomplete; scheduling validates per network', async () => {
  const { svc, u1 } = setup();
  const d = svc.createPost(u1, { text: 'idea for later' });
  assert.equal(d.status, 'draft');
  const bsky = svc.upsertOAuthAccount(u1, { type: 'bluesky', name: 'B', external_id: 'did:1', config: { handle: 'h', password: 'p' } });
  const ig = svc.upsertOAuthAccount(u1, { type: 'instagram', name: 'IG', external_id: '9', config: { igId: '9', token: 't' } });
  assert.throws(() => svc.createPost(u1, { text: 'x'.repeat(301), accountIds: [bsky.id], scheduledAt: iso(1e6) }), /301\/300/);
  assert.throws(() => svc.createPost(u1, { text: 'hi', accountIds: [ig.id], scheduledAt: iso(1e6) }), /needs at least one image/);
  const png = await svc.media.save(u1, chunks(PNG), { filename: 'a.png' });
  assert.throws(() => svc.createPost(u1, { text: 'hi', media: [png.id], accountIds: [ig.id], scheduledAt: iso(1e6) }), /must be JPEG/);
  // per-network text override fixes the length problem
  const ok = svc.createPost(u1, { text: 'x'.repeat(301), accountIds: [bsky.id], overrides: { [bsky.id]: 'short' }, scheduledAt: iso(1e6) });
  assert.equal(ok.overrides[bsky.id], 'short');
  assert.throws(() => svc.publishNow(u1, d.id), /pick at least one account/);
});

test('per-account overrides and UTM tags are applied at publish time', async () => {
  const { svc, u1 } = setup();
  const fake = await fakeServer({ 'POST /api/v1/statuses': { id: '1', url: 'https://m/1' } });
  const m = svc.upsertOAuthAccount(u1, { type: 'mastodon', name: 'M', external_id: 'm:1', config: { instance: fake.url, token: 't' } });
  const t = await svc.addAccount(u1, { type: 'mock' });
  svc.settings.update(u1, { utm: { enabled: true, source: '{network}', medium: 'social', campaign: 'fall' } });
  svc.createPost(u1, { text: 'base https://ex.com', accountIds: [m.id, t.id], overrides: { [m.id]: 'masto version https://ex.com' }, publishNow: true });
  await svc.runDue();
  await fake.close();
  assert.equal(fake.calls[0].json.status, 'masto version https://ex.com/?utm_source=mastodon&utm_medium=social&utm_campaign=fall');
});

test('partial failure, manual retry only re-sends failed account; failure alert is sent', async () => {
  const { svc, u1 } = setup();
  const ok = await svc.addAccount(u1, { type: 'mock', name: 'ok' });
  const bad = svc.upsertOAuthAccount(u1, { type: 'mock', name: 'bad', external_id: 'b', config: { failWith: '400 nope' } });
  const fake = await fakeServer({ 'POST /api/v1/statuses': { id: '9', url: null } });
  const alerts = svc.upsertOAuthAccount(u1, { type: 'mastodon', name: 'alerts', external_id: 'a', config: { instance: fake.url, token: 't' } });
  svc.settings.update(u1, { alertsAccountId: alerts.id });
  const p = svc.createPost(u1, { text: 'x', accountIds: [ok.id, bad.id], publishNow: true });
  await svc.runDue();
  assert.equal(svc.getPost(u1, p.id).status, 'partial');
  assert.match(fake.calls[0].json.status, /post #\d+ failed on bad \(400 nope\)/);
  svc.publishNow(u1, p.id); await svc.runDue();
  const got = svc.getPost(u1, p.id);
  assert.equal(got.deliveries.find((d) => d.account_name === 'ok').attempts, 1);
  await fake.close();
});

test('transient errors retry with backoff, 401 marks account for reconnect', async () => {
  const { svc, u1 } = setup();
  const a = svc.upsertOAuthAccount(u1, { type: 'mock', name: 'flaky', external_id: 'f', config: { failWith: '503 try later' } });
  const p = svc.createPost(u1, { text: 'x', accountIds: [a.id], publishNow: true });
  await svc.runDue();
  assert.equal(svc.getPost(u1, p.id).status, 'scheduled');
  assert.equal(await svc.runDue(new Date(Date.now() + 60e3)), 0, 'backoff not elapsed');
  await svc.runDue(new Date(Date.now() + 3 * 60e3));
  await svc.runDue(new Date(Date.now() + 10 * 60e3));
  assert.equal(svc.getPost(u1, p.id).status, 'failed');
  const r = svc.upsertOAuthAccount(u1, { type: 'mock', name: 'expired', external_id: 'e', config: { failWith: '401 token expired' } });
  svc.createPost(u1, { text: 'y', accountIds: [r.id], publishNow: true });
  await svc.runDue();
  assert.equal(svc.listAccounts(u1).find((x) => x.id === r.id).status, 'reauth');
});

test('paused publishing holds posts; evergreen posts schedule their next run', async () => {
  const { svc, u1 } = setup();
  const a = await svc.addAccount(u1, { type: 'mock' });
  svc.settings.update(u1, { paused: true });
  const p = svc.createPost(u1, { text: 'evergreen', accountIds: [a.id], publishNow: true, recycleDays: 7, recycleLeft: 1 });
  assert.equal(await svc.runDue(), 0);
  svc.settings.update(u1, { paused: false });
  await svc.runDue();
  assert.equal(svc.getPost(u1, p.id).status, 'published');
  const next = svc.listPosts(u1, { status: 'scheduled' });
  assert.equal(next.length, 1);
  assert.equal(next[0].source, 'recycle');
  assert.equal(next[0].recycle_left, 0);
  assert.ok(new Date(next[0].scheduled_at) - Date.now() > 6.9 * 864e5);
  await svc.runDue(new Date(next[0].scheduled_at));
  assert.equal(svc.listPosts(u1, { status: 'scheduled' }).length, 0, 'stops when recycle_left hits 0');
});

test('users are isolated; credentials and settings are encrypted at rest', async () => {
  const { db, svc, u1, u2 } = setup();
  const a1 = await svc.addAccount(u1, { type: 'mock' });
  const p1 = svc.createPost(u1, { text: 'secret', accountIds: [a1.id] });
  assert.equal(svc.listAccounts(u2).length, 0);
  assert.equal(svc.listPosts(u2).length, 0);
  assert.throws(() => svc.getPost(u2, p1.id), /not found/);
  assert.throws(() => svc.createPost(u2, { text: 'x', accountIds: [a1.id] }), /not found/);
  svc.deletePost(u2, p1.id);
  assert.equal(svc.listPosts(u1).length, 1);
  svc.upsertOAuthAccount(u1, { type: 'x', name: 'X', external_id: '1', config: { accessToken: 'SECRET-TOKEN' } });
  svc.settings.update(u1, { apps: { x: { clientId: 'cid', clientSecret: 'SECRET-APP' } }, ai: { apiKey: 'sk-SECRET' } });
  const dump = JSON.stringify(db.prepare('SELECT config FROM accounts').all()) + JSON.stringify(db.prepare('SELECT value FROM settings').all());
  assert.ok(!/SECRET/.test(dump));
  const view = svc.settings.view(u1);
  assert.equal(view.apps.x.clientSecret, '••••••••');
  assert.equal(view.apps.x.configured, true);
  assert.equal(view.ai.hasKey, true);
  svc.settings.update(u1, { apps: { x: { clientId: 'cid2', clientSecret: '••••••••' } } });
  assert.equal(svc.settings.app(u1, 'x').clientSecret, 'SECRET-APP', 'masked value keeps the stored secret');
});

test('queue slots, timezone and DST', async () => {
  const { svc, u1 } = setup();
  const a = await svc.addAccount(u1, { type: 'mock' });
  assert.throws(() => svc.createPost(u1, { text: 'x', accountIds: [a.id], queue: true }), /No queue times/);
  svc.setSlots(u1, [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, time: '09:00' })));
  const p1 = svc.createPost(u1, { text: 'one', accountIds: [a.id], queue: true });
  const p2 = svc.createPost(u1, { text: 'two', accountIds: [a.id], queue: true });
  assert.equal(new Date(p2.scheduled_at) - new Date(p1.scheduled_at), 864e5);
  assert.equal(zonedToUtc(2026, 7, 1, 9, 0, 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(zonedToUtc(2026, 1, 1, 9, 0, 'America/New_York').toISOString(), '2026-01-01T14:00:00.000Z');
  assert.equal(nextFreeSlot([{ dow: 3, time: '09:00' }], 'America/New_York', new Set(), new Date('2026-07-01T14:00:00Z')).toISOString(), '2026-07-08T13:00:00.000Z');
});

test('media: verifies file type by content, serves by unguessable token', async () => {
  const { svc, u1, u2 } = setup();
  await assert.rejects(svc.media.save(u1, chunks(Buffer.from('<html><script>alert(1)</script>')), { filename: 'x.png' }), /only JPEG/);
  const m = await svc.media.save(u1, chunks(JPEG), { filename: 'photo.jpg' });
  assert.equal(m.mime, 'image/jpeg');
  assert.match(m.url, /^\/media\/[\w-]{20,}\.jpg$/);
  assert.throws(() => svc.media.get(u2, m.id), /not found/);
  const [r] = svc.media.resolve(u1, [m.id], 'https://poster.example');
  assert.equal(r.url, `https://poster.example${m.url}`);
  assert.equal((await r.read()).length, JPEG.length);
  assert.equal(svc.media.lookup(m.url.split('/').pop()).mime, 'image/jpeg');
  assert.equal(svc.media.lookup(m.url.split('/').pop().replace('.jpg', '.png')), null);
});

test('duplicate, snippets, bulk import, export', async () => {
  const { svc, u1 } = setup();
  const a = await svc.addAccount(u1, { type: 'mock', name: 'M' });
  const p = svc.createPost(u1, { text: 'hi', accountIds: [a.id], scheduledAt: iso(1e6) });
  const d = svc.duplicatePost(u1, p.id);
  assert.equal(d.status, 'draft'); assert.equal(d.deliveries.length, 1);
  const s = svc.saveSnippet(u1, { name: 'tags', body: '#a #b' });
  svc.saveSnippet(u1, { id: s.id, name: 'tags', body: '#c' });
  assert.equal(svc.listSnippets(u1)[0].body, '#c');
  const r = svc.bulkImport(u1, 'text,scheduled_at,accounts\nA,2030-12-01T09:00,m\nB,,nope\n');
  assert.equal(r.created, 1); assert.equal(r.errors[0].row, 3);
  assert.match(svc.exportCsv(u1), /post_id,status/);
  assert.equal(svc.exportJson(u1).posts.length, 3);
});

test('RSS/Atom parsing and feed polling only posts new items', async () => {
  const rss = (items) => `<?xml version="1.0"?><rss><channel><title>My Blog</title>${items.map((i) => `<item><title><![CDATA[${i} &amp; more]]></title><link>https://blog.ex/${i}</link><guid>${i}</guid></item>`).join('')}</channel></rss>`;
  const atom = parseFeed('<feed><title>A</title><entry><title>Hello</title><link rel="alternate" href="https://a.ex/1"/><id>tag:1</id></entry></feed>');
  assert.deepEqual(atom.items[0], { id: 'tag:1', title: 'Hello', link: 'https://a.ex/1', summary: '' });
  let items = ['one'];
  const fake = await fakeServer({ 'GET /feed': () => ({ headers: { 'content-type': 'application/rss+xml' }, body: rss(items) }) });
  const { svc, feeds, u1 } = setup();
  const a = await svc.addAccount(u1, { type: 'mock' });
  const f = await feeds.add(u1, { url: `${fake.url}/feed`, accountIds: [a.id], mode: 'now', template: 'New: {title} {link}' });
  assert.equal(f.title, 'My Blog');
  assert.equal((await feeds.checkNow(u1, f.id)).created, 0, 'existing items are not posted');
  items = ['two', 'one'];
  assert.equal((await feeds.checkNow(u1, f.id)).created, 1);
  const [post] = svc.listPosts(u1);
  assert.equal(post.text, 'New: two & more https://blog.ex/two');
  assert.equal(post.status, 'scheduled');
  await fake.close();
});

test('analytics: metrics refresh, KPIs, heatmap, best times', async () => {
  const { svc, analytics, u1 } = setup();
  const a = await svc.addAccount(u1, { type: 'mock' });
  for (let i = 0; i < 10; i++) svc.createPost(u1, { text: `p${i}`, accountIds: [a.id], publishNow: true });
  await svc.runDue();
  const r = await analytics.refreshMetrics({ uid: u1 });
  assert.equal(r.checked, 10);
  const s = analytics.stats(u1);
  assert.equal(s.kpis.published, 10);
  assert.equal(s.perDay.length, 30);
  assert.equal(s.perDay.at(-1).n, 10);
  assert.equal(s.heatmap.length, 7 * 24);
  assert.equal(s.bestTimes.source, 'yours');
  assert.equal(s.perNetwork[0].posts, 10);
});

test('login is rate limited after repeated failures', () => {
  const { auth } = setup();
  for (let i = 0; i < 5; i++) assert.throws(() => auth.login({ email: 'a@x.io', password: 'bad' }, '1.1.1.1'), /invalid/);
  assert.throws(() => auth.login({ email: 'a@x.io', password: 'password1' }, '1.1.1.1'), /too many/);
});

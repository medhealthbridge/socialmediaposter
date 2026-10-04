import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, PNG, JPEG, chunks, fakeServer, closeAll } from './helpers.js';
import { parseCsv } from '../src/service.js';
import { blueskyFacets, linkedinText, addUtm, lengthUrlsAs } from '../src/providers/text.js';
import { parseFeed } from '../src/feeds.js';

after(closeAll);

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
  const rows = parseCsv('﻿text,accounts\n"Hi, ""you""\nthere","a;b"\n');
  assert.equal(rows[0].text, 'Hi, "you"\nthere');
  assert.equal(rows[0].accounts, 'a;b');
});

test('queue: posts wait in order until you click Post; Post next takes the first', async () => {
  const { svc, u1 } = await setup();
  const acc = await svc.addAccount(u1, { type: 'mock' });
  const a = await svc.createPost(u1, { text: 'first', accountIds: [acc.id] });
  const b = await svc.createPost(u1, { text: 'second', accountIds: [acc.id] });
  const c = await svc.createPost(u1, { text: 'third', accountIds: [acc.id] });
  assert.equal(a.status, 'queued');
  assert.deepEqual((await svc.listPosts(u1, { status: 'queued' })).map((p) => p.text), ['first', 'second', 'third']);
  await svc.move(u1, c.id, 'top');
  await svc.move(u1, a.id, 'down');
  assert.deepEqual((await svc.listPosts(u1, { status: 'queued' })).map((p) => p.text), ['third', 'second', 'first']);
  const posted = await svc.publishNext(u1);
  assert.equal(posted.text, 'third');
  assert.equal(posted.status, 'published');
  assert.ok(posted.posted_at);
  await assert.rejects(svc.publish(u1, c.id), /already published/);
  const p2 = await svc.publish(u1, b.id);
  assert.equal(p2.status, 'published');
  assert.deepEqual(await svc.counts(u1), { queued: 1, scheduled: 0, failed: 0, published: 2 });
});

test('Post now from the composer publishes immediately', async () => {
  const { svc, u1 } = await setup();
  const acc = await svc.addAccount(u1, { type: 'mock' });
  const p = await svc.createPost(u1, { text: 'now!', accountIds: [acc.id], publishNow: true });
  assert.equal(p.status, 'published');
  assert.equal(p.deliveries[0].status, 'published');
});

test('queued items may be incomplete; publishing validates per network', async () => {
  const { svc, u1 } = await setup();
  const idea = await svc.createPost(u1, { text: 'idea for later' });
  assert.equal(idea.status, 'queued');
  await assert.rejects(svc.publish(u1, idea.id), /pick at least one account/);
  const bsky = await svc.upsertOAuthAccount(u1, { type: 'bluesky', name: 'B', external_id: 'did:1', config: { handle: 'h', password: 'p' } });
  const ig = await svc.upsertOAuthAccount(u1, { type: 'instagram', name: 'IG', external_id: '9', config: { igId: '9', token: 't' } });
  await assert.rejects(svc.createPost(u1, { text: 'x'.repeat(301), accountIds: [bsky.id], publishNow: true }), /301\/300/);
  await assert.rejects(svc.createPost(u1, { text: 'hi', accountIds: [ig.id], publishNow: true }), /needs at least one image/);
  const png = await svc.media.save(u1, chunks(PNG), { filename: 'a.png' });
  assert.match((await svc.problems(u1, { text: 'hi', media: [png.id], accountIds: [ig.id] })).join(), /must be JPEG/);
  const ok = await svc.createPost(u1, { text: 'x'.repeat(301), accountIds: [bsky.id], overrides: { [bsky.id]: 'short' } });
  assert.equal(ok.overrides[bsky.id], 'short');
  assert.equal((await svc.problems(u1, { text: ok.text, media: [], accountIds: [bsky.id], overrides: ok.overrides })).length, 0);
});

test('per-account overrides and UTM tags are applied at publish time', async () => {
  const { svc, u1 } = await setup();
  const fake = await fakeServer({ 'POST /api/v1/statuses': { id: '1', url: 'https://m/1' } });
  const m = await svc.upsertOAuthAccount(u1, { type: 'mastodon', name: 'M', external_id: 'm:1', config: { instance: fake.url, token: 't' } });
  const t = await svc.addAccount(u1, { type: 'mock' });
  await svc.settings.update(u1, { utm: { enabled: true, source: '{network}', medium: 'social', campaign: 'fall' } });
  await svc.createPost(u1, { text: 'base https://ex.com', accountIds: [m.id, t.id], overrides: { [m.id]: 'masto version https://ex.com' }, publishNow: true });
  await fake.close();
  assert.equal(fake.calls[0].json.status, 'masto version https://ex.com/?utm_source=mastodon&utm_medium=social&utm_campaign=fall');
});

test('partial failure: Retry only re-sends the failed account; failure alert is sent', async () => {
  const { svc, u1 } = await setup();
  const ok = await svc.addAccount(u1, { type: 'mock', name: 'ok' });
  const bad = await svc.upsertOAuthAccount(u1, { type: 'mock', name: 'bad', external_id: 'b', config: { failWith: '400 nope' } });
  const fake = await fakeServer({ 'POST /api/v1/statuses': { id: '9', url: null } });
  const alerts = await svc.upsertOAuthAccount(u1, { type: 'mastodon', name: 'alerts', external_id: 'a', config: { instance: fake.url, token: 't' } });
  await svc.settings.update(u1, { alertsAccountId: alerts.id });
  const p = await svc.createPost(u1, { text: 'x', accountIds: [ok.id, bad.id], publishNow: true });
  assert.equal(p.status, 'partial');
  assert.match(fake.calls[0].json.status, /post #\d+ failed on bad \(400 nope\)/);
  assert.equal((await svc.counts(u1)).failed, 1);
  const again = await svc.publish(u1, p.id);
  assert.equal(again.deliveries.find((d) => d.account_name === 'ok').attempts, 1, 'published account not re-sent');
  assert.equal(again.deliveries.find((d) => d.account_name === 'bad').attempts, 2);
  await fake.close();
});

test('temporary errors get one quick retry; 401 marks the account for reconnecting', async () => {
  const { svc, u1 } = await setup();
  let n = 0;
  const fake = await fakeServer({ 'POST /api/v1/statuses': () => (++n === 1 ? { status: 503, body: { error: 'busy' } } : { id: '1', url: 'https://m/1' }) });
  const m = await svc.upsertOAuthAccount(u1, { type: 'mastodon', name: 'M', external_id: 'm:1', config: { instance: fake.url, token: 't' } });
  const p = await svc.createPost(u1, { text: 'x', accountIds: [m.id], publishNow: true });
  assert.equal(p.status, 'published');
  assert.equal(p.deliveries[0].attempts, 2);
  await fake.close();
  const r = await svc.upsertOAuthAccount(u1, { type: 'mock', name: 'expired', external_id: 'e', config: { failWith: '401 token expired' } });
  const f = await svc.createPost(u1, { text: 'y', accountIds: [r.id], publishNow: true });
  assert.equal(f.status, 'failed');
  assert.equal((await svc.listAccounts(u1)).find((x) => x.id === r.id).status, 'reauth');
});

test('a publish that never finished is recovered and can be retried', async () => {
  const { svc, db, u1 } = await setup();
  const a = await svc.addAccount(u1, { type: 'mock' });
  const p = await svc.createPost(u1, { text: 'x', accountIds: [a.id] });
  await db.run("UPDATE posts SET status='publishing', claimed_at=? WHERE id=?", new Date(Date.now() - 3600e3).toISOString(), p.id);
  assert.equal((await svc.listPosts(u1, { status: 'failed' })).length, 1);
  assert.equal((await svc.publish(u1, p.id)).status, 'published');
});

test('users are isolated; credentials and settings are encrypted at rest', async () => {
  const { db, svc, u1, u2 } = await setup();
  const a1 = await svc.addAccount(u1, { type: 'mock' });
  const p1 = await svc.createPost(u1, { text: 'secret', accountIds: [a1.id] });
  assert.equal((await svc.listAccounts(u2)).length, 0);
  assert.equal((await svc.listPosts(u2)).length, 0);
  await assert.rejects(svc.getPost(u2, p1.id), /not found/);
  await assert.rejects(svc.createPost(u2, { text: 'x', accountIds: [a1.id] }), /not found/);
  await assert.rejects(svc.publish(u2, p1.id), /not found/);
  await svc.deletePost(u2, p1.id);
  assert.equal((await svc.listPosts(u1)).length, 1);
  await svc.upsertOAuthAccount(u1, { type: 'x', name: 'X', external_id: '1', config: { accessToken: 'SECRET-TOKEN' } });
  await svc.settings.update(u1, { apps: { x: { clientId: 'cid', clientSecret: 'SECRET-APP' } }, ai: { apiKey: 'sk-SECRET' } });
  const dump = JSON.stringify(await db.all('SELECT config FROM accounts')) + JSON.stringify(await db.all('SELECT value FROM settings'));
  assert.ok(!/SECRET/.test(dump));
  const view = await svc.settings.view(u1);
  assert.equal(view.apps.x.clientSecret, '••••••••');
  assert.equal(view.apps.x.configured, true);
  await svc.settings.update(u1, { apps: { x: { clientId: 'cid2', clientSecret: '••••••••' } } });
  assert.equal((await svc.settings.app(u1, 'x')).clientSecret, 'SECRET-APP', 'masked value keeps the stored secret');
});

test('media: verifies file type by content, serves by unguessable token', async () => {
  const { svc, u1, u2 } = await setup();
  await assert.rejects(svc.media.save(u1, chunks(Buffer.from('<html><script>alert(1)</script>')), { filename: 'x.png' }), /only JPEG/);
  const m = await svc.media.save(u1, chunks(JPEG), { filename: 'photo.jpg' });
  assert.equal(m.mime, 'image/jpeg');
  assert.match(m.url, /^\/media\/[\w-]{20,}\.jpg$/);
  await assert.rejects(svc.media.get(u2, m.id), /not found/);
  const [r] = await svc.media.resolve(u1, [m.id], 'https://poster.example');
  assert.equal(r.url, `https://poster.example${m.url}`);
  assert.equal((await r.read()).length, JPEG.length);
  assert.equal((await svc.media.lookup(m.url.split('/').pop())).mime, 'image/jpeg');
  assert.equal(await svc.media.lookup(m.url.split('/').pop().replace('.jpg', '.png')), null);
  await assert.rejects(svc.media.register(u1, { url: 'https://evil.example/x.png' }), /invalid upload/);
});

test('duplicate, snippets, bulk import, export', async () => {
  const { svc, u1 } = await setup();
  const a = await svc.addAccount(u1, { type: 'mock', name: 'M' });
  const p = await svc.createPost(u1, { text: 'hi', accountIds: [a.id], publishNow: true });
  const d = await svc.duplicatePost(u1, p.id);
  assert.equal(d.status, 'queued'); assert.equal(d.deliveries.length, 1);
  const s = await svc.saveSnippet(u1, { name: 'tags', body: '#a #b' });
  await svc.saveSnippet(u1, { id: s.id, name: 'tags', body: '#c' });
  assert.equal((await svc.listSnippets(u1))[0].body, '#c');
  const r = await svc.bulkImport(u1, 'text,accounts\nA,m\nB,nope\n');
  assert.equal(r.created, 1); assert.equal(r.errors[0].row, 3);
  assert.match(await svc.exportCsv(u1), /post_id,status/);
  assert.equal((await svc.exportJson(u1)).posts.length, 3);
});

test('RSS: only new items are added to the queue (or posted right away)', async () => {
  const rss = (items) => `<?xml version="1.0"?><rss><channel><title>My Blog</title>${items.map((i) => `<item><title><![CDATA[${i} &amp; more]]></title><link>https://blog.ex/${i}</link><guid>${i}</guid></item>`).join('')}</channel></rss>`;
  const atom = parseFeed('<feed><title>A</title><entry><title>Hello</title><link rel="alternate" href="https://a.ex/1"/><id>tag:1</id></entry></feed>');
  assert.deepEqual(atom.items[0], { id: 'tag:1', title: 'Hello', link: 'https://a.ex/1', summary: '' });
  let items = ['one'];
  const fake = await fakeServer({ 'GET /feed': () => ({ headers: { 'content-type': 'application/rss+xml' }, body: rss(items) }) });
  const { svc, feeds, u1 } = await setup();
  const a = await svc.addAccount(u1, { type: 'mock' });
  const f = await feeds.add(u1, { url: `${fake.url}/feed`, accountIds: [a.id], mode: 'queue', template: 'New: {title} {link}' });
  assert.equal(f.title, 'My Blog');
  assert.equal((await feeds.checkNow(u1, f.id)).created, 0, 'existing items are not posted');
  items = ['two', 'one'];
  assert.equal((await feeds.checkDue(u1, new Date(Date.now() + 2 * 3600e3))).created, 1);
  const [post] = await svc.listPosts(u1, { status: 'queued' });
  assert.equal(post.text, 'New: two & more https://blog.ex/two');
  await feeds.update(u1, f.id, { mode: 'now' });
  items = ['three', 'two', 'one'];
  await feeds.checkNow(u1, f.id);
  assert.equal((await svc.listPosts(u1, { status: 'published' }))[0].text, 'New: three & more https://blog.ex/three');
  await fake.close();
});

test('analytics: metrics refresh, KPIs, heatmap, best times', async () => {
  const { svc, analytics, u1 } = await setup();
  const a = await svc.addAccount(u1, { type: 'mock' });
  for (let i = 0; i < 10; i++) await svc.createPost(u1, { text: `p${i}`, accountIds: [a.id], publishNow: true });
  await svc.createPost(u1, { text: 'waiting', accountIds: [a.id] });
  const r = await analytics.refreshMetrics({ uid: u1 });
  assert.equal(r.checked, 10);
  const s = await analytics.stats(u1);
  assert.equal(s.kpis.published, 10);
  assert.equal(s.kpis.queued, 1);
  assert.equal(s.perDay.length, 30);
  assert.equal(s.perDay.at(-1).n, 10);
  assert.equal(s.heatmap.length, 7 * 24);
  assert.equal(s.bestTimes.source, 'yours');
});

test('login is rate limited after repeated failures', async () => {
  const { auth } = await setup();
  for (let i = 0; i < 5; i++) await assert.rejects(auth.login({ email: 'a@x.io', password: 'bad' }, '1.1.1.1'), /invalid/);
  await assert.rejects(auth.login({ email: 'A@x.io', password: 'password1' }, '1.1.1.1'), /too many/);
  assert.ok((await auth.login({ email: 'A@X.io', password: 'password1' }, '2.2.2.2')).token, 'email is case-insensitive');
});

test('a read-only host with no Blob store still runs; uploads explain what to connect', async () => {
  const prev = process.env.VERCEL;
  process.env.VERCEL = '1';
  try {
    const { svc, u1 } = await setup({ mediaDir: '/definitely/not/writable/media' });
    assert.equal(svc.media.kind, 'none');
    await assert.rejects(svc.media.save(u1, chunks(JPEG), { filename: 'a.jpg' }), /connect Blob/);
    await assert.rejects(svc.media.blobToken(u1, {}, {}), /connect Blob/);
    await assert.rejects(svc.media.register(u1, { url: 'https://x/y.png' }), /connect Blob/);
    assert.equal(await svc.media.lookup('abc.jpg'), null);
    assert.deepEqual(await svc.media.list(u1), []);
    // text-only posting is unaffected
    const a = await svc.addAccount(u1, { type: 'mock' });
    const p = await svc.createPost(u1, { text: 'text works without Blob', accountIds: [a.id], publishNow: true });
    assert.equal(p.status, 'published');
  } finally {
    if (prev === undefined) delete process.env.VERCEL; else process.env.VERCEL = prev;
  }
});

test('scheduling: posts go out when due, and only once', async () => {
  const { svc, u1 } = await setup();
  const a = await svc.addAccount(u1, { type: 'mock' });
  const soon = new Date(Date.now() + 3600e3);
  const p = await svc.createPost(u1, { text: 'later', accountIds: [a.id], scheduledAt: soon.toISOString() });
  assert.equal(p.status, 'scheduled');
  assert.equal(p.scheduled_at, soon.toISOString());
  assert.equal((await svc.counts(u1)).scheduled, 1);
  assert.equal((await svc.runDue({ uid: u1 })).due, 0, 'not due yet');
  const run = await svc.runDue({ uid: u1, now: new Date(Date.now() + 7200e3) });
  assert.equal(run.due, 1);
  assert.equal(run.results[0].status, 'published');
  assert.equal((await svc.runDue({ uid: u1, now: new Date(Date.now() + 9000e3) })).due, 0, 'never twice');
  assert.equal((await svc.getPost(u1, p.id)).status, 'published');
});

test('scheduling: a post that cannot publish is marked failed, the rest still go', async () => {
  const { svc, u1 } = await setup();
  const ok = await svc.addAccount(u1, { type: 'mock', name: 'ok' });
  const bad = await svc.upsertOAuthAccount(u1, { type: 'mock', name: 'bad', external_id: 'b', config: { failWith: '400 nope' } });
  const past = new Date(Date.now() - 60e3).toISOString();
  await svc.createPost(u1, { text: 'one', accountIds: [bad.id], scheduledAt: past });
  await svc.createPost(u1, { text: 'two', accountIds: [ok.id], scheduledAt: past });
  const run = await svc.runDue({ uid: u1 });
  assert.equal(run.due, 2);
  assert.deepEqual(run.results.map((r) => r.status), ['failed', 'published']);
});

test('weekly posting times: next free slot, no double booking, timezone aware', async () => {
  const { svc, auth, u1 } = await setup();
  const a = await svc.addAccount(u1, { type: 'mock' });
  await assert.rejects(svc.createPost(u1, { text: 'x', accountIds: [a.id], useSlot: true }), /No posting times/);
  await auth.setTz(u1, 'Asia/Manila');                       // UTC+8, no daylight saving
  await svc.setSlots(u1, [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, time: '09:00' })));
  const first = await svc.createPost(u1, { text: 'one', accountIds: [a.id], useSlot: true });
  const second = await svc.createPost(u1, { text: 'two', accountIds: [a.id], useSlot: true });
  assert.equal(first.status, 'scheduled');
  assert.equal(new Date(second.scheduled_at) - new Date(first.scheduled_at), 864e5, 'the next day, not the same time');
  assert.equal(new Date(first.scheduled_at).getUTCHours(), 1, '09:00 in Manila is 01:00 UTC');
  await assert.rejects(svc.setSlots(u1, [{ dow: 9, time: '99:00' }]), /invalid/);
  assert.equal((await svc.setSlots(u1, [{ dow: 1, time: '08:00' }, { dow: 1, time: '08:00' }])).length, 1, 'duplicates ignored');
});

test('evergreen posts queue their next copy after publishing, then stop', async () => {
  const { svc, u1 } = await setup();
  const a = await svc.addAccount(u1, { type: 'mock' });
  await svc.createPost(u1, { text: 'evergreen', accountIds: [a.id], scheduledAt: new Date(Date.now() - 1000).toISOString(), recycleDays: 7, recycleLeft: 1 });
  await svc.runDue({ uid: u1 });
  const next = await svc.listPosts(u1, { status: 'scheduled' });
  assert.equal(next.length, 1);
  assert.equal(next[0].source, 'evergreen');
  assert.equal(next[0].recycle_left, 0);
  assert.ok(new Date(next[0].scheduled_at) - Date.now() > 6.9 * 864e5);
  await svc.runDue({ uid: u1, now: new Date(next[0].scheduled_at) });
  assert.equal((await svc.listPosts(u1, { status: 'scheduled' })).length, 0, 'stops when the count runs out');
});

test('a scheduled post can be moved back to the queue and rescheduled', async () => {
  const { svc, u1 } = await setup();
  const a = await svc.addAccount(u1, { type: 'mock' });
  const p = await svc.createPost(u1, { text: 'x', accountIds: [a.id], scheduledAt: new Date(Date.now() + 864e5).toISOString() });
  const back = await svc.updatePost(u1, p.id, { scheduledAt: null });
  assert.equal(back.status, 'queued');
  assert.equal(back.scheduled_at, null);
  const again = await svc.updatePost(u1, p.id, { scheduledAt: new Date(Date.now() + 2 * 864e5).toISOString() });
  assert.equal(again.status, 'scheduled');
  const edited = await svc.updatePost(u1, p.id, { text: 'changed' });
  assert.equal(edited.status, 'scheduled', 'editing the text keeps the schedule');
  assert.equal(edited.scheduled_at, again.scheduled_at);
});

test('activity log records what happened, who did it, and problems', async () => {
  const { svc, events, u1 } = await setup();
  const ok = await svc.addAccount(u1, { type: 'mock', name: 'ok' });
  const bad = await svc.upsertOAuthAccount(u1, { type: 'mock', name: 'bad', external_id: 'b', config: { failWith: '400 nope' } });
  const p = await svc.createPost(u1, { text: 'hello log', accountIds: [ok.id] });
  await svc.publish(u1, p.id);
  const f = await svc.createPost(u1, { text: 'will fail', accountIds: [bad.id] });
  await svc.publish(u1, f.id);
  await svc.deletePost(u1, f.id);

  const all = await events.list(u1);
  const kinds = all.map((e) => e.kind);
  assert.ok(kinds.includes('account') && kinds.includes('queued') && kinds.includes('published') && kinds.includes('failed') && kinds.includes('deleted'));
  const published = all.find((e) => e.kind === 'published');
  assert.match(published.summary, /Published to ok/);
  assert.equal(published.detail.results[0].network, 'mock');
  assert.equal(published.actor, 'you');

  const problems = await events.list(u1, { level: 'problem' });
  assert.ok(problems.every((e) => e.level === 'error' || e.level === 'warn'));
  assert.ok(problems.some((e) => /400 nope/.test(e.summary)));
  assert.equal((await events.list(u1, { kind: 'published' })).length, 1);

  // Each person only sees their own log.
  const { events: e2, u2 } = { events, u2: (await setup()).u2 };
  assert.equal((await e2.list(u2)).length, 0);
});

test('the timer and RSS are logged under their own name', async () => {
  const rss = '<?xml version="1.0"?><rss><channel><title>Blog</title><item><title>Post one</title><link>https://b/1</link><guid>g1</guid></item></channel></rss>';
  let items = '';
  const fake = await fakeServer({ 'GET /feed': () => ({ headers: { 'content-type': 'application/rss+xml' }, body: items }) });
  const { svc, feeds, events, u1 } = await setup();
  const a = await svc.addAccount(u1, { type: 'mock' });
  items = '<?xml version="1.0"?><rss><channel><title>Blog</title></channel></rss>';
  const f = await feeds.add(u1, { url: `${fake.url}/feed`, accountIds: [a.id], mode: 'queue' });
  items = rss;
  await feeds.checkNow(u1, f.id);
  const rssEvent = (await events.list(u1, { kind: 'rss' }))[0];
  assert.match(rssEvent.summary, /Post one/);
  assert.equal(rssEvent.actor, 'rss');
  await fake.close();
});

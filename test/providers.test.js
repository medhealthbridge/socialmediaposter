import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, fakeServer, chunks, PNG, JPEG, closeAll } from './helpers.js';
import * as X from '../src/providers/x.js';
import * as LI from '../src/providers/linkedin.js';
import * as META from '../src/providers/meta.js';
import * as TH from '../src/providers/threads.js';
import * as SIMPLE from '../src/providers/simple.js';
import * as BSKY from '../src/providers/bluesky.js';
import * as TT from '../src/providers/tiktok.js';
import * as YT from '../src/providers/youtube.js';
import * as PIN from '../src/providers/pinterest.js';

after(closeAll);
const publishOne = (svc, uid, acc, body = {}) => svc.createPost(uid, { text: 'hello #world https://ex.com', accountIds: [acc.id], publishNow: true, ...body });

test('Mastodon: login flow registers an app automatically, then posts with media', async () => {
  const fake = await fakeServer({
    'POST /api/v1/apps': { client_id: 'cid', client_secret: 'csec' },
    'POST /oauth/token': { access_token: 'tok' },
    'GET /api/v1/accounts/verify_credentials': { id: '42', acct: 'me', display_name: 'Me', avatar: 'https://a/av.png', url: 'https://m/@me' },
    'POST /api/v2/media': { status: 202, body: { id: 'm1', url: null } },
    'GET /api/v1/media/m1': { id: 'm1', url: 'https://m/file.png' },
    'POST /api/v1/statuses': { id: 's1', url: 'https://m/@me/s1' },
    'GET /api/v1/statuses/s1': { favourites_count: 5, reblogs_count: 2, replies_count: 1 },
  });
  const { svc, oauth, analytics, u1 } = await setup();
  const { url } = await oauth.start(u1, 'mastodon', { instance: fake.url });
  const u = new URL(url);
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.match(u.searchParams.get('redirect_uri'), /\/oauth\/callback\/mastodon$/);
  await oauth.start(u1, 'mastodon', { instance: fake.url });
  assert.equal(fake.find('POST', '/api/v1/apps').length, 1, 'app registration is reused');
  const r = await oauth.callback('mastodon', { code: 'c', state: u.searchParams.get('state') });
  assert.equal(r.accounts[0].handle, `@me@${new URL(fake.url).host}`);
  await assert.rejects(oauth.callback('mastodon', { code: 'c', state: u.searchParams.get('state') }), /expired/, 'state is single-use');
  const m = await svc.media.save(u1, chunks(PNG), { filename: 'p.png' });
  await svc.media.setAlt(u1, m.id, 'a cat');
  const post = await publishOne(svc, u1, r.accounts[0], { media: [m.id] });
  assert.equal(post.status, 'published', JSON.stringify(post.deliveries));
  assert.equal(post.deliveries[0].remote_url, 'https://m/@me/s1');
  assert.match(fake.find('POST', '/api/v2/media')[0].raw, /a cat/);
  assert.deepEqual(fake.find('POST', '/api/v1/statuses')[0].json.media_ids, ['m1']);
  await analytics.refreshMetrics({ uid: u1 });
  assert.deepEqual((await svc.getPost(u1, post.id)).deliveries[0].metrics, { likes: 5, reposts: 2, replies: 1 });
  await fake.close();
});

test('X: PKCE login, token refresh before posting, image upload', async () => {
  const fake = await fakeServer({
    'POST /2/oauth2/token': (c) => ({ access_token: c.form.grant_type === 'refresh_token' ? 'new-tok' : 'tok', refresh_token: 'r2', expires_in: c.form.grant_type === 'refresh_token' ? 7200 : 1 }),
    'GET /2/users/me': { data: { id: '7', username: 'me', name: 'Me', profile_image_url: 'https://x/p.png' } },
    'POST /2/media/upload': { data: { id: 'media1' } },
    'POST /2/media/metadata': {},
    'POST /2/tweets': { data: { id: '99' } },
  });
  Object.assign(X.endpoints, { api: fake.url, authorize: `${fake.url}/authorize` });
  const { svc, oauth, u1 } = await setup();
  await assert.rejects(oauth.start(u1, 'x'), /Set up your X/);
  await svc.settings.update(u1, { apps: { x: { clientId: 'cid', clientSecret: 'sec' } } });
  const { url } = await oauth.start(u1, 'x');
  const u = new URL(url);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.match(u.searchParams.get('scope'), /offline\.access/);
  const { accounts: [acc] } = await oauth.callback('x', { code: 'c', state: u.searchParams.get('state') });
  const tokenCall = fake.find('POST', '/2/oauth2/token')[0];
  assert.equal(tokenCall.headers.authorization, 'Basic ' + Buffer.from('cid:sec').toString('base64'));
  assert.ok(tokenCall.form.code_verifier.length >= 43);
  const m = await svc.media.save(u1, chunks(PNG), { filename: 'p.png' });
  await svc.media.setAlt(u1, m.id, 'alt text');
  const post = await publishOne(svc, u1, acc, { media: [m.id] });
  assert.equal(post.status, 'published', JSON.stringify(post.deliveries));
  assert.equal(fake.find('POST', '/2/oauth2/token')[1].form.grant_type, 'refresh_token', 'expired token refreshed');
  const tweet = fake.find('POST', '/2/tweets')[0];
  assert.equal(tweet.headers.authorization, 'Bearer new-tok');
  assert.deepEqual(tweet.json.media, { media_ids: ['media1'] });
  assert.equal(post.deliveries[0].remote_url, 'https://x.com/me/status/99');
  await fake.close();
});

test('LinkedIn: posts with escaped text and an uploaded image', async () => {
  const fake = await fakeServer({
    'POST /oauth/v2/accessToken': { access_token: 'tok', expires_in: 5184000 },
    'GET /v2/userinfo': { sub: 'abc', name: 'Me', picture: 'https://li/p.jpg' },
    'POST /rest/images': { value: { uploadUrl: 'PLACEHOLDER', image: 'urn:li:image:1' } },
    'PUT /upload': { status: 201, body: '' },
    'POST /rest/posts': { status: 201, headers: { 'x-restli-id': 'urn:li:share:5' }, body: '' },
  });
  Object.assign(LI.endpoints, { oauth: `${fake.url}/oauth/v2`, api: fake.url });
  const { svc, oauth, u1 } = await setup();
  await svc.settings.update(u1, { apps: { linkedin: { clientId: 'cid', clientSecret: 'sec' } } });
  const { url } = await oauth.start(u1, 'linkedin');
  const { accounts: [acc] } = await oauth.callback('linkedin', { code: 'c', state: new URL(url).searchParams.get('state') });
  fake.calls.length = 0;
  // the upload URL must point at our fake too
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => realFetch(u === 'PLACEHOLDER' ? `${fake.url}/upload` : u, o);
  const m = await svc.media.save(u1, chunks(JPEG), { filename: 'p.jpg' });
  const post = await publishOne(svc, u1, acc, { media: [m.id] });
  globalThis.fetch = realFetch;
  assert.equal(post.status, 'published', JSON.stringify(post.deliveries));
  const body = fake.find('POST', '/rest/posts')[0];
  assert.equal(body.json.author, 'urn:li:person:abc');
  assert.equal(body.json.commentary, 'hello {hashtag|\\#|world} https://ex.com');
  assert.equal(body.json.content.media.id, 'urn:li:image:1');
  assert.match(body.headers['linkedin-version'], /^\d{6}$/);
  assert.equal(post.deliveries[0].remote_url, 'https://www.linkedin.com/feed/update/urn:li:share:5/');
  await fake.close();
});

test('Meta: one login adds Facebook Pages and linked Instagram accounts; Instagram carousel', async () => {
  let polls = 0;
  const fake = await fakeServer({
    'GET /v23.0/oauth/access_token': (c) => ({ access_token: c.query.grant_type ? 'long' : 'short' }),
    'GET /v23.0/me/accounts': { data: [{ id: 'P1', name: 'My Page', access_token: 'ptok', picture: { data: { url: 'https://fb/p.jpg' } }, instagram_business_account: { id: 'IG1', username: 'me.ig' } }] },
    'POST /v23.0/IG1/media': (c) => ({ id: c.form.media_type === 'CAROUSEL' ? 'CAR' : `C${fake.calls.length}` }),
    'GET /v23.0/*': (c) => (c.query.fields === 'permalink' ? { permalink: 'https://instagram.com/p/xyz' } : { status_code: ++polls > 1 ? 'FINISHED' : 'IN_PROGRESS' }),
    'POST /v23.0/IG1/media_publish': { id: 'IGPOST' },
    'POST /v23.0/P1/feed': { id: 'P1_55' },
  });
  Object.assign(META.endpoints, { www: fake.url, graph: fake.url, video: fake.url });
  const { svc, oauth, u1 } = await setup();
  await svc.settings.update(u1, { apps: { meta: { clientId: 'app', clientSecret: 'sec' } } });
  const { url } = await oauth.start(u1, 'meta');
  const { accounts } = await oauth.callback('meta', { code: 'c', state: new URL(url).searchParams.get('state') });
  assert.deepEqual(accounts.map((a) => a.type), ['facebook', 'instagram']);
  const fbPost = await publishOne(svc, u1, accounts[0]);
  assert.equal(fbPost.status, 'published');
  assert.equal(fake.find('POST', '/v23.0/P1/feed')[0].form.link, 'https://ex.com');
  const m1 = await svc.media.save(u1, chunks(JPEG), { filename: 'a.jpg' });
  const m2 = await svc.media.save(u1, chunks(JPEG), { filename: 'b.jpg' });
  // without a public HTTPS address Instagram can't fetch media
  let post = await publishOne(svc, u1, accounts[1], { media: [m1.id, m2.id] });
  assert.match(post.deliveries[0].error, /public HTTPS address/);
  await svc.settings.update(u1, { publicUrl: 'https://poster.example.com' });
  post = await publishOne(svc, u1, accounts[1], { media: [m1.id, m2.id] });
  assert.equal(post.status, 'published', JSON.stringify(post.deliveries));
  const containers = fake.find('POST', '/v23.0/IG1/media');
  assert.equal(containers.length, 3);
  assert.match(containers[0].form.image_url, /^https:\/\/poster\.example\.com\/media\//);
  assert.equal(containers[2].form.media_type, 'CAROUSEL');
  assert.equal(post.deliveries[0].remote_url, 'https://instagram.com/p/xyz');
  await fake.close();
});

test('Threads: text post via container + publish', async () => {
  const fake = await fakeServer({
    'POST /oauth/access_token': { access_token: 'short', user_id: 'U' },
    'GET /access_token': { access_token: 'long', expires_in: 5184000 },
    'GET /v1.0/me': { id: 'U', username: 'me' },
    'POST /v1.0/U/threads': { id: 'CONT' },
    'POST /v1.0/U/threads_publish': { id: 'T1' },
    'GET /v1.0/T1': { permalink: 'https://threads.net/@me/post/T1' },
  });
  Object.assign(TH.endpoints, { auth: fake.url, graph: fake.url });
  const { svc, oauth, u1 } = await setup();
  await svc.settings.update(u1, { apps: { threads: { clientId: 'a', clientSecret: 's' } } });
  const { url } = await oauth.start(u1, 'threads');
  const { accounts: [acc] } = await oauth.callback('threads', { code: 'c', state: new URL(url).searchParams.get('state') });
  const post = await publishOne(svc, u1, acc);
  assert.equal(post.status, 'published', JSON.stringify(post.deliveries));
  assert.equal(fake.find('POST', '/v1.0/U/threads')[0].form.media_type, 'TEXT');
  assert.equal(post.deliveries[0].remote_url, 'https://threads.net/@me/post/T1');
  await fake.close();
});

test('Telegram: verifies chat, sends media group and a separate long message', async () => {
  const fake = await fakeServer({
    'GET /botTOKEN/getChat': { ok: true, result: { id: -100, title: 'My Channel', username: 'mychan' } },
    'POST /botTOKEN/sendMediaGroup': { ok: true, result: [{ message_id: 10 }, { message_id: 11 }] },
    'POST /botTOKEN/sendMessage': { ok: true, result: { message_id: 12 } },
  });
  SIMPLE.endpoints.telegram = fake.url;
  const { svc, u1 } = await setup();
  const acc = await svc.addAccount(u1, { type: 'telegram', config: { token: 'TOKEN', chatId: '@mychan' } });
  assert.equal(acc.name, 'My Channel');
  const a = await svc.media.save(u1, chunks(PNG), { filename: 'a.png' });
  const b = await svc.media.save(u1, chunks(JPEG), { filename: 'b.jpg' });
  const post = await publishOne(svc, u1, acc, { text: 'x'.repeat(2000), media: [a.id, b.id] });
  assert.equal(post.status, 'published', JSON.stringify(post.deliveries));
  assert.doesNotMatch(fake.find('POST', '/botTOKEN/sendMediaGroup')[0].raw, /caption/, 'caption too long → sent separately');
  assert.equal(fake.find('POST', '/botTOKEN/sendMessage')[0].json.text.length, 2000);
  assert.equal(post.deliveries[0].remote_url, 'https://t.me/mychan/10');
  await assert.rejects(svc.addAccount(u1, { type: 'telegram', config: { token: 'BAD', chatId: '1' } }), /Could not connect/);
  await fake.close();
});

test('Bluesky: facets, image embed, size limit', async () => {
  const fake = await fakeServer({
    'POST /xrpc/com.atproto.server.createSession': { did: 'did:plc:me', handle: 'me.bsky.social', accessJwt: 'jwt' },
    'GET /xrpc/app.bsky.actor.getProfile': { displayName: 'Me', avatar: 'https://b/a.jpg' },
    'POST /xrpc/com.atproto.repo.uploadBlob': { blob: { $type: 'blob', ref: { $link: 'x' }, mimeType: 'image/png', size: 29 } },
    'POST /xrpc/com.atproto.repo.createRecord': { uri: 'at://did:plc:me/app.bsky.feed.post/3abc' },
  });
  BSKY.endpoints.appview = fake.url;
  const { svc, u1 } = await setup();
  const acc = await svc.addAccount(u1, { type: 'bluesky', config: { handle: 'me.bsky.social', password: 'app-pw', service: fake.url } });
  assert.equal(acc.name, 'Me');
  const m = await svc.media.save(u1, chunks(PNG), { filename: 'a.png' });
  const post = await publishOne(svc, u1, acc, { media: [m.id] });
  assert.equal(post.status, 'published', JSON.stringify(post.deliveries));
  const rec = fake.find('POST', '/xrpc/com.atproto.repo.createRecord')[0].json.record;
  assert.equal(rec.facets.length, 2);
  assert.equal(rec.embed.$type, 'app.bsky.embed.images');
  assert.equal(post.deliveries[0].remote_url, 'https://bsky.app/profile/me.bsky.social/post/3abc');
  await fake.close();
});

test('AI assistant uses the official SDK with server-side fallback and structured output', async () => {
  const fake = await fakeServer({
    'POST /v1/messages': { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify({ options: ['One', 'Two', 'Three'] }) }] },
  });
  process.env.ANTHROPIC_BASE_URL = fake.url;
  const { svc, ai, u1 } = await setup();
  await assert.rejects(ai.assist(u1, { action: 'improve', text: 'hi' }), /API key/);
  await svc.settings.update(u1, { ai: { apiKey: 'sk-test' } });
  const r = await ai.assist(u1, { action: 'improve', text: 'hello world', networks: ['x', 'bluesky'] });
  assert.deepEqual(r.options, ['One', 'Two', 'Three']);
  const call = fake.calls[0];
  assert.equal(call.json.model, 'claude-opus-5-5');
  assert.equal(call.json.fallbacks, 'default');
  assert.match(call.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(call.json.output_config.format.type, 'json_schema');
  assert.match(call.json.messages[0].content, /fit in 280 characters/);
  await svc.settings.update(u1, { ai: { model: 'claude-haiku-4-5' } });
  await ai.assist(u1, { action: 'write', instruction: 'coffee' });
  assert.equal(fake.calls[1].json.fallbacks, undefined, 'fallbacks only sent for models that support it');
  delete process.env.ANTHROPIC_BASE_URL;
  await fake.close();
});

const MP4 = Buffer.concat([Buffer.from('0000001c', 'hex'), Buffer.from('ftypisom'), Buffer.alloc(200)]);

test('TikTok: PKCE login, creator info, chunked file upload, privacy must be chosen', async () => {
  const puts = [];
  let status = 'PROCESSING_UPLOAD';
  const fake = await fakeServer({
    'POST /v2/oauth/token/': (c) => ({ access_token: c.form.grant_type === 'refresh_token' ? 'tok2' : 'tok', refresh_token: 'r', expires_in: 86400, open_id: 'OID' }),
    'GET /v2/user/info/': { data: { user: { open_id: 'OID', username: 'me', display_name: 'Me', avatar_url: 'https://t/a.jpg' } } },
    'POST /v2/post/publish/creator_info/query/': { data: { creator_username: 'me', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], comment_disabled: false, duet_disabled: true, stitch_disabled: false } },
    'POST /v2/post/publish/video/init/': { data: { publish_id: 'PID', upload_url: 'UPLOAD' } },
    'PUT /tt-upload': { status: 201, body: '' },
    'POST /v2/post/publish/status/fetch/': () => { const s = status; status = 'PUBLISH_COMPLETE'; return { data: { status: s, publicaly_available_post_id: ['VID1'] } }; },
  });
  Object.assign(TT.endpoints, { auth: fake.url, api: fake.url });
  const { svc, oauth, u1 } = await setup();
  await svc.settings.update(u1, { apps: { tiktok: { clientKey: 'ck', clientSecret: 'cs' } } });
  const { url } = await oauth.start(u1, 'tiktok');
  const u = new URL(url);
  assert.equal(u.searchParams.get('client_key'), 'ck');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.match(u.searchParams.get('scope'), /video\.publish/);
  const { accounts: [acc] } = await oauth.callback('tiktok', { code: 'c', state: u.searchParams.get('state') });
  assert.equal(acc.handle, '@me');
  assert.equal(acc.needs_setup, true, 'privacy must be chosen before posting');

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url2, o) => realFetch(url2 === 'UPLOAD' ? `${fake.url}/tt-upload` : url2, o);
  const m = await svc.media.save(u1, chunks(MP4), { filename: 'v.mp4' });
  let post = await svc.createPost(u1, { text: 'my clip', media: [m.id], accountIds: [acc.id], publishNow: true });
  assert.match(post.deliveries[0].error, /Choose who can see/);

  const opts = await svc.accountOptions(u1, acc.id);
  assert.deepEqual(opts[0].choices.map((c) => c.value), ['PUBLIC_TO_EVERYONE', 'SELF_ONLY']);
  assert.equal(opts[0].value, null, 'no default is pre-selected');
  await assert.rejects(svc.setAccountOption(u1, acc.id, 'privacyLevel', 'NOPE'), /not available/);
  const saved = await svc.setAccountOption(u1, acc.id, 'privacyLevel', 'SELF_ONLY');
  assert.equal(saved.needs_setup, false);

  post = await svc.publish(u1, post.id);
  globalThis.fetch = realFetch;
  assert.equal(post.status, 'published', JSON.stringify(post.deliveries));
  const init = fake.find('POST', '/v2/post/publish/video/init/')[0].json;
  assert.equal(init.post_info.privacy_level, 'SELF_ONLY');
  assert.equal(init.post_info.disable_duet, true, 'creator settings are respected');
  assert.equal(init.source_info.source, 'FILE_UPLOAD');
  assert.equal(init.source_info.video_size, MP4.length);
  const up = fake.find('PUT', '/tt-upload')[0];
  assert.equal(up.headers['content-range'], `bytes 0-${MP4.length - 1}/${MP4.length}`);
  assert.equal(post.deliveries[0].remote_url, 'https://www.tiktok.com/@me/video/VID1');
  await fake.close();
});

test('TikTok reports its own error bodies, which arrive with HTTP 200', async () => {
  const fake = await fakeServer({
    'POST /v2/oauth/token/': { access_token: 'tok', refresh_token: 'r', expires_in: 86400, open_id: 'O' },
    'POST /v2/post/publish/creator_info/query/': { error: { code: 'access_token_invalid', message: 'The access token is invalid', log_id: 'L1' } },
  });
  Object.assign(TT.endpoints, { auth: fake.url, api: fake.url });
  const { svc, u1 } = await setup();
  const acc = await svc.upsertOAuthAccount(u1, { type: 'tiktok', name: 'TT', external_id: 'O', config: { accessToken: 'tok', refreshToken: 'r', expiresAt: new Date(Date.now() + 9e6).toISOString(), privacyLevel: 'SELF_ONLY', username: 'me' } });
  const m = await svc.media.save(u1, chunks(MP4), { filename: 'v.mp4' });
  const post = await svc.createPost(u1, { text: 'x', media: [m.id], accountIds: [acc.id], publishNow: true });
  assert.equal(post.status, 'failed');
  assert.match(post.deliveries[0].error, /access token is invalid.*log L1/);
  await fake.close();
});

test('YouTube: resumable upload, title from the first line, visibility choice, stats', async () => {
  const fake = await fakeServer({
    'POST /token': (c) => ({ access_token: c.form.grant_type === 'refresh_token' ? 'new' : 'tok', refresh_token: 'r', expires_in: 3600 }),
    'GET /youtube/v3/channels': { items: [{ id: 'CH1', snippet: { title: 'My Channel', customUrl: '@mych', thumbnails: { default: { url: 'https://y/a.jpg' } } } }] },
    'POST /upload/youtube/v3/videos': { status: 200, headers: { location: 'RESUMABLE' }, body: {} },
    'PUT /resume': { id: 'VID9' },
    'GET /youtube/v3/videos': { items: [{ statistics: { viewCount: '120', likeCount: '7', commentCount: '2' } }] },
  });
  Object.assign(YT.endpoints, { auth: fake.url, token: fake.url, api: fake.url });
  const { svc, analytics, oauth, u1 } = await setup();
  await svc.settings.update(u1, { apps: { youtube: { clientId: 'cid', clientSecret: 'cs' } } });
  const { url } = await oauth.start(u1, 'youtube');
  const u = new URL(url);
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent', 'needed to receive a refresh token');
  const { accounts: [acc] } = await oauth.callback('youtube', { code: 'c', state: u.searchParams.get('state') });
  assert.equal(acc.name, 'My Channel');
  assert.equal(acc.needs_setup, true);
  await svc.setAccountOption(u1, acc.id, 'privacyStatus', 'unlisted');

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url2, o) => realFetch(url2 === 'RESUMABLE' ? `${fake.url}/resume` : url2, o);
  const m = await svc.media.save(u1, chunks(MP4), { filename: 'v.mp4' });
  const png = await svc.media.save(u1, chunks(PNG), { filename: 'p.png' });
  assert.match((await svc.problems(u1, { text: 'x', media: [png.id], accountIds: [acc.id] })).join(), /only videos/);
  assert.match((await svc.problems(u1, { text: 'x'.repeat(120) + '\nbody', media: [m.id], accountIds: [acc.id] })).join(), /100 characters or fewer/);
  const post = await svc.createPost(u1, { text: 'My holiday video\nShot last week.', media: [m.id], accountIds: [acc.id], publishNow: true });
  globalThis.fetch = realFetch;
  assert.equal(post.status, 'published', JSON.stringify(post.deliveries));
  const init = fake.find('POST', '/upload/youtube/v3/videos')[0];
  assert.equal(init.json.snippet.title, 'My holiday video');
  assert.equal(init.json.snippet.description, 'Shot last week.');
  assert.equal(init.json.status.privacyStatus, 'unlisted');
  assert.equal(init.headers['x-upload-content-length'], String(MP4.length));
  assert.equal(post.deliveries[0].remote_url, 'https://www.youtube.com/watch?v=VID9');
  await analytics.refreshMetrics({ uid: u1 });
  assert.deepEqual((await svc.getPost(u1, post.id)).deliveries[0].metrics, { likes: 7, replies: 2, reposts: 0, views: 120 });
  await fake.close();
});

test('Pinterest: one account per board, pin posted as base64 with a link', async () => {
  const fake = await fakeServer({
    'POST /v5/oauth/token': { access_token: 'tok', refresh_token: 'r', expires_in: 2592000 },
    'GET /v5/user_account': { username: 'me', profile_image: 'https://p/a.jpg' },
    'GET /v5/boards': { items: [{ id: 'B1', name: 'Recipes' }, { id: 'B2', name: 'Travel' }] },
    'POST /v5/pins': { id: 'PIN1' },
  });
  Object.assign(PIN.endpoints, { auth: fake.url, api: fake.url });
  const { svc, oauth, u1 } = await setup();
  await svc.settings.update(u1, { apps: { pinterest: { clientId: 'cid', clientSecret: 'cs' } } });
  const { url } = await oauth.start(u1, 'pinterest');
  const { accounts } = await oauth.callback('pinterest', { code: 'c', state: new URL(url).searchParams.get('state') });
  assert.deepEqual(accounts.map((a) => a.name), ['Recipes', 'Travel']);
  const tokenCall = fake.find('POST', '/v5/oauth/token')[0];
  assert.equal(tokenCall.headers.authorization, 'Basic ' + Buffer.from('cid:cs').toString('base64'));

  const jpg = await svc.media.save(u1, chunks(JPEG), { filename: 'food.jpg' });
  const png = await svc.media.save(u1, chunks(PNG), { filename: 'p.png' });
  assert.match((await svc.problems(u1, { text: 'x', media: [], accountIds: [accounts[0].id] })).join(), /needs at least one image/);
  assert.equal((await svc.problems(u1, { text: 'x', media: [png.id], accountIds: [accounts[0].id] })).length, 0, 'PNG is allowed');
  const post = await svc.createPost(u1, { text: 'Best pasta\nQuick midweek dinner https://blog.ex/pasta', media: [jpg.id], accountIds: [accounts[0].id], publishNow: true });
  assert.equal(post.status, 'published', JSON.stringify(post.deliveries));
  const pin = fake.find('POST', '/v5/pins')[0].json;
  assert.equal(pin.board_id, 'B1');
  assert.equal(pin.title, 'Best pasta');
  assert.equal(pin.description, 'Quick midweek dinner https://blog.ex/pasta');
  assert.equal(pin.link, 'https://blog.ex/pasta');
  assert.equal(pin.media_source.source_type, 'image_base64');
  assert.equal(Buffer.from(pin.media_source.data, 'base64').length, JPEG.length);
  assert.equal(post.deliveries[0].remote_url, 'https://www.pinterest.com/pin/PIN1/');
  await fake.close();
});

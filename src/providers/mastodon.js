import { request, waitFor, ProviderError } from './http.js';
import { lengthUrlsAs } from './text.js';

const normalize = (instance) => {
  let s = String(instance || '').trim();
  if (!s) throw new ProviderError('400 enter your Mastodon server, e.g. mastodon.social', 400);
  if (!/^https?:\/\//.test(s)) s = 'https://' + s.replace(/^@?[^@]+@/, ''); // allow "@me@server"
  return new URL(s).origin;
};
const auth = (c) => ({ authorization: `Bearer ${c.token}` });

export const connector = {
  id: 'mastodon',
  label: 'Mastodon',
  // Mastodon servers allow apps to register themselves, so no developer setup is needed.
  input: { key: 'instance', label: 'Your Mastodon server', placeholder: 'mastodon.social' },
  async start({ input, redirectUri, state, store }) {
    const base = normalize(input.instance);
    const key = `${base}|${redirectUri}`;
    let app = store.get(key);
    if (!app) {
      const { data } = await request(`${base}/api/v1/apps`, { json: { client_name: 'Social Poster', redirect_uris: redirectUri, scopes: 'read write' } });
      app = { clientId: data.client_id, clientSecret: data.client_secret };
      store.set(key, app);
    }
    const url = `${base}/oauth/authorize?` + new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'read write', state });
    return { url, data: { base } };
  },
  async callback({ code, redirectUri, data, store }) {
    const app = store.get(`${data.base}|${redirectUri}`);
    if (!app) throw new ProviderError('400 app registration missing, try again', 400);
    const { data: tok } = await request(`${data.base}/oauth/token`, {
      form: { grant_type: 'authorization_code', code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri, scope: 'read write' },
    });
    const config = { instance: data.base, token: tok.access_token };
    const { data: me } = await request(`${data.base}/api/v1/accounts/verify_credentials`, { headers: auth(config) });
    const host = new URL(data.base).host;
    return [{ type: 'mastodon', name: me.display_name || me.username, handle: `@${me.acct}@${host}`, external_id: `${host}:${me.id}`, avatar: me.avatar, profile_url: me.url, config }];
  },
};

export const provider = {
  id: 'mastodon', label: 'Mastodon', color: '#6364ff', limit: 500, length: lengthUrlsAs(23),
  media: { max: 4, video: true },
  connector: 'mastodon',
  // Manual alternative to the login flow.
  fields: [
    { key: 'instance', label: 'Server URL', placeholder: 'https://mastodon.social' },
    { key: 'token', label: 'Access token (Preferences → Development)', secret: true },
  ],
  async verify(config) {
    config.instance = normalize(config.instance);
    const { data: me } = await request(`${config.instance}/api/v1/accounts/verify_credentials`, { headers: auth(config) });
    return { name: me.display_name || me.username, handle: `@${me.acct}@${new URL(config.instance).host}`, avatar: me.avatar, profile_url: me.url, external_id: `${new URL(config.instance).host}:${me.id}` };
  },
  async publish({ config, text, media }) {
    const ids = [];
    for (const m of media) {
      const fd = new FormData();
      fd.append('file', await m.blob(), m.filename);
      if (m.alt) fd.append('description', m.alt);
      const { data } = await request(`${config.instance}/api/v2/media`, { headers: auth(config), form: fd });
      if (!data.url) {
        await waitFor(async () => (await request(`${config.instance}/api/v1/media/${data.id}`, { headers: auth(config) })).data.url, { tries: 60, every: 2000 });
      }
      ids.push(data.id);
    }
    const { data } = await request(`${config.instance}/api/v1/statuses`, {
      headers: { ...auth(config), 'idempotency-key': `${Date.now()}-${Math.random()}` },
      json: { status: text, media_ids: ids, visibility: config.visibility || 'public' },
    });
    return { id: data.id, url: data.url };
  },
  async metrics({ config, remoteId }) {
    const { data } = await request(`${config.instance}/api/v1/statuses/${remoteId}`, { headers: auth(config) });
    return { likes: data.favourites_count, reposts: data.reblogs_count, replies: data.replies_count };
  },
};

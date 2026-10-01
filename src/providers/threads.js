import { request, waitFor, ProviderError } from './http.js';
import { graphemes } from './text.js';
import { publicUrlOf } from './meta.js';

export const endpoints = { auth: 'https://threads.net', graph: 'https://graph.threads.net' };

export const connector = {
  id: 'threads',
  label: 'Threads',
  app: {
    fields: [
      { key: 'clientId', label: 'Threads App ID' },
      { key: 'clientSecret', label: 'Threads App Secret', secret: true },
    ],
    docs: 'https://developers.facebook.com/apps',
    steps: [
      'At Meta for Developers, create an app with the “Access the Threads API” use case.',
      'In the use case settings, enable threads_basic and threads_content_publish, and add the Redirect Callback URL shown below (needs HTTPS).',
      'Under App roles → Roles, add your Threads account as a Threads Tester and accept the invite in the Threads app (Settings → Account → Website permissions).',
      'Copy the Threads App ID and Threads App Secret here.',
    ],
  },
  start({ app, redirectUri, state }) {
    return { url: `${endpoints.auth}/oauth/authorize?` + new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, scope: 'threads_basic,threads_content_publish', response_type: 'code', state }) };
  },
  async callback({ app, code, redirectUri }) {
    const { data: short } = await request(`${endpoints.graph}/oauth/access_token`, { form: { client_id: app.clientId, client_secret: app.clientSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code } });
    const { data: long } = await request(`${endpoints.graph}/access_token`, { query: { grant_type: 'th_exchange_token', client_secret: app.clientSecret, access_token: short.access_token } });
    const config = { token: long.access_token, expiresAt: new Date(Date.now() + (long.expires_in || 5184000) * 1000).toISOString() };
    const { data: me } = await request(`${endpoints.graph}/v1.0/me`, { query: { access_token: config.token, fields: 'id,username,name,threads_profile_picture_url' } });
    config.userId = me.id;
    return [{ type: 'threads', name: me.name || me.username, handle: `@${me.username}`, external_id: me.id, avatar: me.threads_profile_picture_url, profile_url: `https://www.threads.net/@${me.username}`, config }];
  },
};

/** Long-lived Threads tokens last 60 days; refresh when fewer than 10 remain. */
export async function refreshIfNeeded(config, saveConfig) {
  if (!config.expiresAt || new Date(config.expiresAt) - Date.now() > 10 * 864e5) return config;
  const { data } = await request(`${endpoints.graph}/refresh_access_token`, { query: { grant_type: 'th_refresh_token', access_token: config.token } });
  const next = { ...config, token: data.access_token, expiresAt: new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString() };
  await saveConfig(next);
  return next;
}

export const provider = {
  id: 'threads', label: 'Threads', color: '#000000', limit: 500, length: graphemes,
  media: { max: 10, video: true },
  connector: 'threads',
  refreshIfNeeded,
  async publish({ config, text, media, saveConfig }) {
    const c = await refreshIfNeeded(config, saveConfig);
    const base = `${endpoints.graph}/v1.0/${c.userId}`;
    const create = async (params) => (await request(`${base}/threads`, { form: { access_token: c.token, ...params } })).data.id;
    const ready = (id) => waitFor(async () => {
      const { data } = await request(`${endpoints.graph}/v1.0/${id}`, { query: { access_token: c.token, fields: 'status,error_message' } });
      if (data.status === 'ERROR') throw new ProviderError(`400 Threads rejected the media: ${data.error_message || 'unknown error'}`, 400);
      return data.status === 'FINISHED';
    }, { tries: 100, every: 3000, what: 'Threads media processing' });
    const item = (m, extra) => (m.mime.startsWith('video/') ? { media_type: 'VIDEO', video_url: publicUrlOf(m, 'Threads'), ...extra } : { media_type: 'IMAGE', image_url: publicUrlOf(m, 'Threads'), ...extra });
    let id;
    if (!media.length) id = await create({ media_type: 'TEXT', text });
    else if (media.length === 1) id = await create(item(media[0], { text }));
    else {
      const children = [];
      for (const m of media) { const ch = await create(item(m, { is_carousel_item: true })); await ready(ch); children.push(ch); }
      id = await create({ media_type: 'CAROUSEL', children: children.join(','), text });
    }
    if (media.length) await ready(id);
    const { data } = await request(`${base}/threads_publish`, { form: { access_token: c.token, creation_id: id } });
    let url = null;
    try { url = (await request(`${endpoints.graph}/v1.0/${data.id}`, { query: { access_token: c.token, fields: 'permalink' } })).data.permalink; } catch { /* cosmetic */ }
    return { id: data.id, url };
  },
  async metrics({ config, remoteId }) {
    const { data } = await request(`${endpoints.graph}/v1.0/${remoteId}/insights`, { query: { access_token: config.token, metric: 'likes,replies,reposts,quotes,views' } });
    const val = (n) => { const d = data.data?.find((x) => x.name === n); return d?.total_value?.value ?? d?.values?.[0]?.value ?? 0; };
    return { likes: val('likes'), replies: val('replies'), reposts: val('reposts') + val('quotes'), views: val('views') };
  },
};

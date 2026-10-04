import { request, waitFor, b64, ProviderError } from './http.js';
import { lengthUrlsAs } from './text.js';

export const endpoints = { authorize: 'https://x.com/i/oauth2/authorize', api: 'https://api.x.com' };
const SCOPES = 'tweet.read tweet.write users.read media.write offline.access';
const basic = (app) => ({ authorization: 'Basic ' + b64(`${app.clientId}:${app.clientSecret}`) });

async function tokenRequest(app, form) {
  const { data } = await request(`${endpoints.api}/2/oauth2/token`, { headers: basic(app), form: { client_id: app.clientId, ...form } });
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: new Date(Date.now() + (data.expires_in || 7200) * 1000).toISOString() };
}

export const connector = {
  id: 'x',
  label: 'X (Twitter)',
  app: {
    fields: [
      { key: 'clientId', label: 'OAuth 2.0 Client ID' },
      { key: 'clientSecret', label: 'OAuth 2.0 Client Secret', secret: true },
    ],
    docs: 'https://developer.x.com/en/portal/dashboard',
    steps: [
      'Open the X Developer Portal and create a Project + App (posting needs at least the Free tier; reading metrics needs a paid tier).',
      'In the app, open “User authentication settings” → Set up. App permissions: Read and write. Type of App: Web App (confidential client).',
      'Paste the Callback URI shown below, and your site URL as Website URL. Save.',
      'Copy the OAuth 2.0 Client ID and Client Secret here.',
    ],
  },
  start({ app, redirectUri, state, challenge }) {
    return { url: `${endpoints.authorize}?` + new URLSearchParams({ response_type: 'code', client_id: app.clientId, redirect_uri: redirectUri, scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256' }) };
  },
  async callback({ app, code, redirectUri, verifier }) {
    const config = await tokenRequest(app, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
    const { data } = await request(`${endpoints.api}/2/users/me`, { headers: { authorization: `Bearer ${config.accessToken}` }, query: { 'user.fields': 'profile_image_url' } });
    const u = data.data;
    config.username = u.username;
    return [{ type: 'x', name: u.name, handle: `@${u.username}`, external_id: u.id, avatar: u.profile_image_url, profile_url: `https://x.com/${u.username}`, config }];
  },
};

async function fresh(config, app, saveConfig) {
  if (new Date(config.expiresAt).getTime() - Date.now() > 120_000) return config;
  if (!config.refreshToken) throw new ProviderError('401 session expired, reconnect the account', 401);
  if (!app?.clientId) throw new ProviderError('401 X app credentials missing (Settings → Integrations)', 401);
  const next = { ...config, ...(await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: config.refreshToken })) };
  await saveConfig(next);
  return next;
}

async function uploadMedia(m, headers) {
  if (m.mime.startsWith('image/')) {
    const fd = new FormData();
    fd.append('media', await m.blob(), m.filename);
    fd.append('media_category', m.mime === 'image/gif' ? 'tweet_gif' : 'tweet_image');
    const { data } = await request(`${endpoints.api}/2/media/upload`, { headers, form: fd });
    return data.data?.id ?? data.media_id_string;
  }
  // Video: chunked upload.
  const { data: init } = await request(`${endpoints.api}/2/media/upload/initialize`, { headers, json: { media_type: m.mime, total_bytes: m.size, media_category: 'tweet_video' } });
  const id = init.data.id;
  const buf = await m.read();
  const CHUNK = 4 * 1024 * 1024;
  for (let i = 0, seg = 0; i < buf.length; i += CHUNK, seg++) {
    const fd = new FormData();
    fd.append('media', new Blob([buf.subarray(i, i + CHUNK)]), m.filename);
    fd.append('segment_index', String(seg));
    await request(`${endpoints.api}/2/media/upload/${id}/append`, { headers, form: fd });
  }
  const { data: fin } = await request(`${endpoints.api}/2/media/upload/${id}/finalize`, { headers, method: 'POST' });
  if (fin.data?.processing_info) {
    await waitFor(async () => {
      const { data } = await request(`${endpoints.api}/2/media/upload`, { headers, query: { command: 'STATUS', media_id: id } });
      const st = data.data?.processing_info?.state;
      if (st === 'failed') throw new ProviderError(`400 X could not process the video: ${data.data.processing_info.error?.message || 'unknown'}`, 400);
      return !st || st === 'succeeded';
    }, { tries: 100, every: 3000, what: 'X video processing' });
  }
  return id;
}

export const provider = {
  id: 'x', label: 'X', color: '#111111', limit: 280, length: lengthUrlsAs(23),
  media: { max: 4, video: true },
  thread: 'native',
  connector: 'x',
  async publish({ config, app, text, media, saveConfig, replyTo }) {
    const c = await fresh(config, app, saveConfig);
    const headers = { authorization: `Bearer ${c.accessToken}` };
    const ids = [];
    for (const m of media) {
      const id = await uploadMedia(m, headers);
      if (m.alt && m.mime.startsWith('image/')) {
        await request(`${endpoints.api}/2/media/metadata`, { headers, json: { id, metadata: { alt_text: { text: m.alt.slice(0, 1000) } } } }).catch(() => {});
      }
      ids.push(id);
    }
    const { data } = await request(`${endpoints.api}/2/tweets`, {
      headers,
      json: { text, ...(ids.length && { media: { media_ids: ids } }), ...(replyTo && { reply: { in_reply_to_tweet_id: String(replyTo) } }) },
    });
    return { id: data.data.id, url: `https://x.com/${c.username || 'i'}/status/${data.data.id}`, ref: data.data.id };
  },
  async metrics({ config, app, remoteId, saveConfig }) {
    const c = await fresh(config, app, saveConfig);
    const { data } = await request(`${endpoints.api}/2/tweets/${remoteId}`, { headers: { authorization: `Bearer ${c.accessToken}` }, query: { 'tweet.fields': 'public_metrics' } });
    const m = data.data?.public_metrics;
    return m ? { likes: m.like_count, reposts: m.retweet_count + (m.quote_count || 0), replies: m.reply_count, views: m.impression_count } : null;
  },
};

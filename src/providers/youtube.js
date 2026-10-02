import { request, ProviderError } from './http.js';

export const endpoints = { auth: 'https://accounts.google.com', token: 'https://oauth2.googleapis.com', api: 'https://www.googleapis.com' };
const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

export const connector = {
  id: 'youtube',
  label: 'YouTube',
  app: {
    fields: [
      { key: 'clientId', label: 'OAuth Client ID' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
    ],
    docs: 'https://console.cloud.google.com/apis/credentials',
    steps: [
      'In Google Cloud Console create a project, then enable the “YouTube Data API v3” under APIs & Services → Library.',
      'OAuth consent screen: User type External, fill in the app name and your email, and add yourself under Test users.',
      'Credentials → Create credentials → OAuth client ID → Web application. Add the Authorized redirect URI shown below.',
      'Copy the Client ID and Client secret here.',
      'Note: until Google audits your project, uploads stay private on YouTube. That is Google’s rule, not a bug.',
    ],
  },
  start({ app, redirectUri, state, challenge }) {
    return { url: `${endpoints.auth}/o/oauth2/v2/auth?` + new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, code_challenge: challenge, code_challenge_method: 'S256' }) };
  },
  async callback({ app, code, redirectUri, verifier }) {
    const { data } = await request(`${endpoints.token}/token`, {
      form: { code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier },
    });
    const config = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString() };
    const { data: me } = await request(`${endpoints.api}/youtube/v3/channels`, { headers: { authorization: `Bearer ${config.accessToken}` }, query: { part: 'snippet', mine: 'true' } });
    const ch = me.items?.[0];
    if (!ch) throw new ProviderError('400 that Google account has no YouTube channel — create one first at youtube.com', 400);
    config.channelId = ch.id;
    return [{ type: 'youtube', name: ch.snippet.title, handle: ch.snippet.customUrl || '', external_id: ch.id, avatar: ch.snippet.thumbnails?.default?.url, profile_url: `https://www.youtube.com/channel/${ch.id}`, config }];
  },
};

async function fresh(config, app, saveConfig) {
  if (new Date(config.expiresAt).getTime() - Date.now() > 120_000) return config;
  if (!config.refreshToken) throw new ProviderError('401 YouTube login expired, reconnect the account', 401);
  if (!app?.clientId) throw new ProviderError('401 YouTube app credentials missing (Settings → Developer apps)', 401);
  const { data } = await request(`${endpoints.token}/token`, {
    form: { client_id: app.clientId, client_secret: app.clientSecret, refresh_token: config.refreshToken, grant_type: 'refresh_token' },
  });
  const next = { ...config, accessToken: data.access_token, expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString() };
  await saveConfig(next);
  return next;
}

/** First line becomes the video title, the rest the description. */
export function splitTitle(text) {
  const [first = '', ...rest] = text.split('\n');
  const title = (first.trim() || text.trim().slice(0, 100) || 'Untitled').slice(0, 100);
  return { title, description: rest.join('\n').trim().slice(0, 5000) };
}

export const provider = {
  id: 'youtube', label: 'YouTube', color: '#ff0000', limit: 5000,
  media: { max: 1, video: true, required: true, videoAlone: true, videoOnly: true },
  connector: 'youtube',
  needsSetup: (config) => !config.privacyStatus,
  async options({ config }) {
    return [{
      key: 'privacyStatus',
      label: 'Who can see your uploads',
      hint: 'Until Google audits your project, YouTube forces uploads to Private whatever you pick here.',
      value: config.privacyStatus ?? null,
      choices: [{ value: 'private', label: 'Private (only you)' }, { value: 'unlisted', label: 'Unlisted (anyone with the link)' }, { value: 'public', label: 'Public' }],
    }];
  },
  validate(text) {
    const [first = ''] = text.split('\n');
    if (first.trim().length > 100) return 'the first line becomes the video title and must be 100 characters or fewer';
  },

  async publish({ config, app, text, media, saveConfig }) {
    const c = await fresh(config, app, saveConfig);
    const video = media[0];
    if (!video?.mime.startsWith('video/')) throw new ProviderError('400 YouTube needs a video file', 400);
    const { title, description } = splitTitle(text);
    const start = await request(`${endpoints.api}/upload/youtube/v3/videos`, {
      query: { uploadType: 'resumable', part: 'snippet,status' },
      headers: { authorization: `Bearer ${c.accessToken}`, 'x-upload-content-length': String(video.size), 'x-upload-content-type': video.mime },
      json: { snippet: { title, description, categoryId: '22' }, status: { privacyStatus: c.privacyStatus || 'private', selfDeclaredMadeForKids: false } },
    });
    const location = start.headers.get('location');
    if (!location) throw new ProviderError('502 YouTube did not start the upload', 502);
    const { data } = await request(location, { method: 'PUT', headers: { 'content-type': video.mime }, body: await video.read(), timeout: 900_000 });
    if (!data.id) throw new ProviderError('502 YouTube did not return a video id', 502);
    return { id: data.id, url: `https://www.youtube.com/watch?v=${data.id}` };
  },

  async metrics({ config, app, remoteId, saveConfig }) {
    const c = await fresh(config, app, saveConfig);
    const { data } = await request(`${endpoints.api}/youtube/v3/videos`, { headers: { authorization: `Bearer ${c.accessToken}` }, query: { part: 'statistics', id: remoteId } });
    const s = data.items?.[0]?.statistics;
    return s ? { likes: Number(s.likeCount || 0), replies: Number(s.commentCount || 0), reposts: 0, views: Number(s.viewCount || 0) } : null;
  },
};

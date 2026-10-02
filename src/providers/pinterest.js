import { request, b64, ProviderError } from './http.js';

export const endpoints = { auth: 'https://www.pinterest.com', api: 'https://api.pinterest.com' };
const SCOPES = 'user_accounts:read,boards:read,pins:read,pins:write';
const basic = (app) => ({ authorization: 'Basic ' + b64(`${app.clientId}:${app.clientSecret}`) });

export const connector = {
  id: 'pinterest',
  label: 'Pinterest',
  app: {
    fields: [
      { key: 'clientId', label: 'App ID' },
      { key: 'clientSecret', label: 'App secret key', secret: true },
    ],
    docs: 'https://developers.pinterest.com/apps/',
    steps: [
      'At Pinterest developers, create an app (you need a free Pinterest business account — you can convert your personal one).',
      'Add the Redirect URI shown below to the app’s redirect URIs (needs HTTPS).',
      'Trial access is enough to post to your own boards; you only need a review to go beyond that.',
      'Copy the App ID and App secret key here.',
    ],
  },
  start({ app, redirectUri, state }) {
    return { url: `${endpoints.auth}/oauth/?` + new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES, state }) };
  },
  async callback({ app, code, redirectUri }) {
    const { data } = await request(`${endpoints.api}/v5/oauth/token`, {
      headers: basic(app),
      form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, continuous_refresh: 'true' },
    });
    const base = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: new Date(Date.now() + (data.expires_in || 2592000) * 1000).toISOString() };
    const auth = { authorization: `Bearer ${base.accessToken}` };
    const { data: me } = await request(`${endpoints.api}/v5/user_account`, { headers: auth });
    const { data: boards } = await request(`${endpoints.api}/v5/boards`, { headers: auth, query: { page_size: 100 } });
    const items = boards.items || [];
    if (!items.length) throw new ProviderError('400 no boards found — create a board on Pinterest first, then connect again', 400);
    // One entry per board, so you pick the board by picking the account.
    return items.map((b) => ({
      type: 'pinterest', name: b.name, handle: `@${me.username} · ${b.name}`, external_id: `${me.username}:${b.id}`,
      avatar: me.profile_image, profile_url: `https://www.pinterest.com/${me.username}/`,
      config: { ...base, boardId: b.id, boardName: b.name, username: me.username },
    }));
  },
};

async function fresh(config, app, saveConfig) {
  if (new Date(config.expiresAt).getTime() - Date.now() > 120_000) return config;
  if (!config.refreshToken) throw new ProviderError('401 Pinterest login expired, reconnect the account', 401);
  if (!app?.clientId) throw new ProviderError('401 Pinterest app credentials missing (Settings → Developer apps)', 401);
  const { data } = await request(`${endpoints.api}/v5/oauth/token`, {
    headers: basic(app),
    form: { grant_type: 'refresh_token', refresh_token: config.refreshToken, continuous_refresh: 'true' },
  });
  const next = { ...config, accessToken: data.access_token, refreshToken: data.refresh_token || config.refreshToken, expiresAt: new Date(Date.now() + (data.expires_in || 2592000) * 1000).toISOString() };
  await saveConfig(next);
  return next;
}

/** First line becomes the pin title, the rest the description. */
export function splitPin(text) {
  const [first = '', ...rest] = text.split('\n');
  const title = first.trim().slice(0, 100);
  const description = (rest.join('\n').trim() || (title ? '' : text.trim())).slice(0, 800);
  return { title, description };
}

export const provider = {
  id: 'pinterest', label: 'Pinterest', color: '#e60023', limit: 800,
  media: { max: 1, video: false, required: true, imageTypes: ['image/jpeg', 'image/png'] },
  connector: 'pinterest',
  async publish({ config, app, text, media, saveConfig }) {
    const c = await fresh(config, app, saveConfig);
    const image = media[0];
    if (!image) throw new ProviderError('400 a pin needs an image', 400);
    const { title, description } = splitPin(text);
    const link = (text.match(/https?:\/\/[^\s<>"']+/) || [])[0];
    const { data } = await request(`${endpoints.api}/v5/pins`, {
      headers: { authorization: `Bearer ${c.accessToken}` },
      json: {
        board_id: c.boardId, title: title || undefined, description: description || undefined, link,
        media_source: { source_type: 'image_base64', content_type: image.mime, data: (await image.read()).toString('base64') },
      },
      timeout: 300_000,
    });
    return { id: data.id, url: `https://www.pinterest.com/pin/${data.id}/` };
  },
};

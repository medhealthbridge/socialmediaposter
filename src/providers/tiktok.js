import { request, waitFor, ProviderError } from './http.js';
import { graphemes } from './text.js';
import { publicUrlOf } from './meta.js';

export const endpoints = { auth: 'https://www.tiktok.com', api: 'https://open.tiktokapis.com' };
const SCOPES = 'user.info.basic,video.publish';
const CHUNK = 10 * 1024 * 1024;        // TikTok requires 5–64 MB chunks
const SINGLE_CHUNK_MAX = 64 * 1024 * 1024;

/** TikTok answers 200 with an error body, so every response is checked. */
async function call(url, opts, token) {
  const { data, headers, status } = await request(url, {
    ...opts,
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...opts?.headers },
  });
  const err = data?.error;
  if (err && err.code && err.code !== 'ok') throw new ProviderError(`400 ${err.message || err.code}${err.log_id ? ` (log ${err.log_id})` : ''}`, 400);
  return { data, headers, status };
}

const tokenRequest = (app, form) => call(`${endpoints.api}/v2/oauth/token/`, {
  form: { client_key: app.clientKey, client_secret: app.clientSecret, ...form },
});

export const connector = {
  id: 'tiktok',
  label: 'TikTok',
  app: {
    fields: [
      { key: 'clientKey', label: 'Client key' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
    ],
    docs: 'https://developers.tiktok.com/apps',
    steps: [
      'At TikTok for Developers, create an app and add the “Content Posting API” product. Turn on “Direct Post”.',
      'Add the Login Kit product, and under it add the Redirect URI shown below (needs HTTPS).',
      'Request the scopes user.info.basic and video.publish.',
      'Copy the Client key and Client secret here.',
      'Note: until TikTok audits your app, every post it makes is visible only to you. That is TikTok’s rule, not a bug.',
    ],
  },
  start({ app, redirectUri, state, challenge }) {
    return { url: `${endpoints.auth}/v2/auth/authorize/?` + new URLSearchParams({ client_key: app.clientKey, scope: SCOPES, response_type: 'code', redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' }) };
  },
  async callback({ app, code, redirectUri, verifier }) {
    const { data } = await tokenRequest(app, { code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: verifier });
    const config = { accessToken: data.access_token, refreshToken: data.refresh_token, openId: data.open_id, expiresAt: new Date(Date.now() + (data.expires_in || 86400) * 1000).toISOString() };
    const { data: me } = await call(`${endpoints.api}/v2/user/info/`, { query: { fields: 'open_id,avatar_url,display_name,username' } }, config.accessToken);
    const u = me.data?.user || {};
    config.username = u.username;
    return [{ type: 'tiktok', name: u.display_name || u.username || 'TikTok', handle: u.username ? `@${u.username}` : '', external_id: data.open_id, avatar: u.avatar_url, profile_url: u.username ? `https://www.tiktok.com/@${u.username}` : null, config }];
  },
};

async function fresh(config, app, saveConfig) {
  if (new Date(config.expiresAt).getTime() - Date.now() > 120_000) return config;
  if (!config.refreshToken) throw new ProviderError('401 TikTok login expired, reconnect the account', 401);
  if (!app?.clientKey) throw new ProviderError('401 TikTok app credentials missing (Settings → Developer apps)', 401);
  const { data } = await tokenRequest(app, { grant_type: 'refresh_token', refresh_token: config.refreshToken });
  const next = { ...config, accessToken: data.access_token, refreshToken: data.refresh_token || config.refreshToken, expiresAt: new Date(Date.now() + (data.expires_in || 86400) * 1000).toISOString() };
  await saveConfig(next);
  return next;
}

const creatorInfo = async (token) => (await call(`${endpoints.api}/v2/post/publish/creator_info/query/`, { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8' } }, token)).data.data;

const PRIVACY_LABEL = {
  PUBLIC_TO_EVERYONE: 'Everyone', MUTUAL_FOLLOW_FRIENDS: 'Friends (mutual follows)',
  FOLLOWER_OF_CREATOR: 'Followers', SELF_ONLY: 'Only me (private)',
};

export const provider = {
  id: 'tiktok', label: 'TikTok', color: '#010101', limit: 2200, length: graphemes,
  media: { max: 35, video: true, required: true, videoAlone: true },
  connector: 'tiktok',
  // TikTok requires the privacy choice to be made by the person, with no default.
  needsSetup: (config) => !config.privacyLevel,
  async options({ config, app, saveConfig }) {
    const c = await fresh(config, app, saveConfig);
    const info = await creatorInfo(c.accessToken);
    return [{
      key: 'privacyLevel',
      label: 'Who can see your TikTok posts',
      hint: 'TikTok requires you to choose this yourself. Until TikTok audits your app, only “Only me” works.',
      value: c.privacyLevel ?? null,
      choices: (info.privacy_level_options || []).map((v) => ({ value: v, label: PRIVACY_LABEL[v] || v })),
    }];
  },

  async publish({ config, app, text, media, saveConfig }) {
    const c = await fresh(config, app, saveConfig);
    if (!c.privacyLevel) throw new ProviderError('400 Choose who can see your TikTok posts first: Accounts → ⋯ → Post settings', 400);
    const info = await creatorInfo(c.accessToken);
    if (!(info.privacy_level_options || []).includes(c.privacyLevel)) {
      throw new ProviderError(`400 TikTok no longer allows “${PRIVACY_LABEL[c.privacyLevel] || c.privacyLevel}” for this account — pick another in Accounts → ⋯ → Post settings`, 400);
    }
    const video = media.find((m) => m.mime.startsWith('video/'));
    const post_info = { title: text.slice(0, 2200), privacy_level: c.privacyLevel, disable_comment: !!info.comment_disabled, disable_duet: !!info.duet_disabled, disable_stitch: !!info.stitch_disabled };
    let publishId;

    if (video) {
      const single = video.size <= SINGLE_CHUNK_MAX;
      const chunkSize = single ? video.size : CHUNK;
      const chunks = single ? 1 : Math.floor(video.size / chunkSize);
      const { data } = await call(`${endpoints.api}/v2/post/publish/video/init/`, {
        json: { post_info, source_info: { source: 'FILE_UPLOAD', video_size: video.size, chunk_size: chunkSize, total_chunk_count: chunks } },
      }, c.accessToken);
      publishId = data.data.publish_id;
      const buf = await video.read();
      for (let i = 0; i < chunks; i++) {
        const start = i * chunkSize;
        const end = i === chunks - 1 ? video.size - 1 : start + chunkSize - 1;
        await request(data.data.upload_url, {
          method: 'PUT', body: buf.subarray(start, end + 1), timeout: 600_000,
          headers: { 'content-type': video.mime, 'content-range': `bytes ${start}-${end}/${video.size}` },
        });
      }
    } else {
      // TikTok fetches photos from a public address; it cannot receive them directly.
      const { data } = await call(`${endpoints.api}/v2/post/publish/content/init/`, {
        json: {
          media_type: 'PHOTO', post_mode: 'DIRECT_POST',
          post_info: { ...post_info, title: text.slice(0, 90), description: text.slice(0, 4000) },
          source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: media.map((m) => publicUrlOf(m, 'TikTok')) },
        },
      }, c.accessToken);
      publishId = data.data.publish_id;
    }

    const done = await waitFor(async () => {
      const { data } = await call(`${endpoints.api}/v2/post/publish/status/fetch/`, { json: { publish_id: publishId } }, c.accessToken);
      const s = data.data;
      if (s.status === 'FAILED') throw new ProviderError(`400 TikTok could not publish this: ${s.fail_reason || 'unknown reason'}`, 400);
      return s.status === 'PUBLISH_COMPLETE' ? s : null;
    }, { tries: 100, every: 3000, what: 'TikTok publishing' });

    const postId = done.publicaly_available_post_id?.[0] || done.publicly_available_post_id?.[0];
    return { id: postId || publishId, url: postId && c.username ? `https://www.tiktok.com/@${c.username}/video/${postId}` : null };
  },
};

import { request, ProviderError } from './http.js';
import { linkedinText } from './text.js';

export const endpoints = { oauth: 'https://www.linkedin.com/oauth/v2', api: 'https://api.linkedin.com' };

/** LinkedIn's versioned API keeps each monthly version for about a year; default to two months ago. */
export function defaultVersion(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 1));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}
const headers = (config, app) => ({
  authorization: `Bearer ${config.token}`,
  'LinkedIn-Version': app?.version || defaultVersion(),
  'X-Restli-Protocol-Version': '2.0.0',
});

export const connector = {
  id: 'linkedin',
  label: 'LinkedIn',
  app: {
    fields: [
      { key: 'clientId', label: 'Client ID' },
      { key: 'clientSecret', label: 'Primary Client Secret', secret: true },
      { key: 'version', label: 'API version YYYYMM (optional)', optional: true, placeholder: defaultVersion() },
    ],
    docs: 'https://www.linkedin.com/developers/apps',
    steps: [
      'Create an app at LinkedIn Developers (it must be linked to a LinkedIn Page you admin; any page works).',
      'Products tab: add “Share on LinkedIn” and “Sign In with LinkedIn using OpenID Connect”.',
      'Auth tab: add the Redirect URL shown below.',
      'Copy the Client ID and Primary Client Secret here.',
    ],
  },
  start({ app, redirectUri, state }) {
    return { url: `${endpoints.oauth}/authorization?` + new URLSearchParams({ response_type: 'code', client_id: app.clientId, redirect_uri: redirectUri, state, scope: 'openid profile w_member_social' }) };
  },
  async callback({ app, code, redirectUri }) {
    const { data: tok } = await request(`${endpoints.oauth}/accessToken`, { form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: app.clientId, client_secret: app.clientSecret } });
    const { data: me } = await request(`${endpoints.api}/v2/userinfo`, { headers: { authorization: `Bearer ${tok.access_token}` } });
    const config = { token: tok.access_token, sub: me.sub, expiresAt: new Date(Date.now() + (tok.expires_in || 5184000) * 1000).toISOString() };
    return [{ type: 'linkedin', name: me.name, handle: me.email || me.name, external_id: me.sub, avatar: me.picture, profile_url: null, config }];
  },
};

async function uploadImage(m, config, app, owner) {
  const { data } = await request(`${endpoints.api}/rest/images?action=initializeUpload`, { headers: headers(config, app), json: { initializeUploadRequest: { owner } } });
  await request(data.value.uploadUrl, { method: 'PUT', headers: { authorization: `Bearer ${config.token}`, 'content-type': m.mime }, body: await m.read() });
  return data.value.image;
}

async function uploadVideo(m, config, app, owner) {
  const { data } = await request(`${endpoints.api}/rest/videos?action=initializeUpload`, {
    headers: headers(config, app), json: { initializeUploadRequest: { owner, fileSizeBytes: m.size, uploadCaptions: false, uploadThumbnail: false } },
  });
  const buf = await m.read();
  const etags = [];
  for (const ins of data.value.uploadInstructions) {
    const r = await request(ins.uploadUrl, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: buf.subarray(ins.firstByte, ins.lastByte + 1) });
    etags.push(r.headers.get('etag'));
  }
  await request(`${endpoints.api}/rest/videos?action=finalizeUpload`, {
    headers: headers(config, app), json: { finalizeUploadRequest: { video: data.value.video, uploadToken: data.value.uploadToken || '', uploadedPartIds: etags } },
  });
  return data.value.video;
}

export const provider = {
  id: 'linkedin', label: 'LinkedIn', color: '#0a66c2', limit: 3000,
  media: { max: 9, video: true, videoAlone: true },
  connector: 'linkedin',
  async publish({ config, app, text, media }) {
    if (config.expiresAt && new Date(config.expiresAt) < new Date()) throw new ProviderError('401 LinkedIn login expired, reconnect the account', 401);
    const owner = `urn:li:person:${config.sub}`;
    const body = {
      author: owner, commentary: linkedinText(text), visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
    };
    const video = media.find((m) => m.mime.startsWith('video/'));
    if (video) body.content = { media: { id: await uploadVideo(video, config, app, owner) } };
    else if (media.length === 1) body.content = { media: { id: await uploadImage(media[0], config, app, owner), altText: media[0].alt || undefined } };
    else if (media.length > 1) {
      const images = [];
      for (const m of media) images.push({ id: await uploadImage(m, config, app, owner), altText: m.alt || undefined });
      body.content = { multiImage: { images } };
    }
    const r = await request(`${endpoints.api}/rest/posts`, { headers: headers(config, app), json: body });
    const urn = r.headers.get('x-restli-id') || r.data.id;
    return { id: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null };
  },
};

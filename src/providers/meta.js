import { request, waitFor, ProviderError } from './http.js';
import { hashtagCount, urlsIn } from './text.js';

export const endpoints = { www: 'https://www.facebook.com', graph: 'https://graph.facebook.com', video: 'https://graph-video.facebook.com' };
const DEFAULT_VERSION = 'v23.0';
const v = (app) => app?.version || DEFAULT_VERSION;
const SCOPES = 'pages_show_list,pages_read_engagement,pages_manage_posts,business_management,instagram_basic,instagram_content_publish';

export const connector = {
  id: 'meta',
  label: 'Facebook Pages & Instagram',
  app: {
    fields: [
      { key: 'clientId', label: 'App ID' },
      { key: 'clientSecret', label: 'App Secret', secret: true },
      { key: 'version', label: 'Graph API version (optional)', optional: true, placeholder: DEFAULT_VERSION },
    ],
    docs: 'https://developers.facebook.com/apps',
    steps: [
      'At Meta for Developers, create an app (type “Business”, or use case “Manage everything on your Page” + “Manage messaging & content on Instagram”).',
      'Add “Facebook Login for Business”. Under its Settings, add the Valid OAuth Redirect URI shown below (needs HTTPS).',
      'Instagram must be a Professional (Business/Creator) account linked to one of your Facebook Pages.',
      'While the app is in Development mode it works for you (an app admin) without App Review — perfect for personal use.',
      'Copy the App ID and App Secret (Settings → Basic) here.',
    ],
  },
  start({ app, redirectUri, state }) {
    return { url: `${endpoints.www}/${v(app)}/dialog/oauth?` + new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, state, scope: SCOPES, response_type: 'code' }) };
  },
  async callback({ app, code, redirectUri }) {
    const g = `${endpoints.graph}/${v(app)}`;
    const { data: short } = await request(`${g}/oauth/access_token`, { query: { client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri, code } });
    const { data: long } = await request(`${g}/oauth/access_token`, { query: { grant_type: 'fb_exchange_token', client_id: app.clientId, client_secret: app.clientSecret, fb_exchange_token: short.access_token } });
    const { data } = await request(`${g}/me/accounts`, { query: { access_token: long.access_token, limit: 100, fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}' } });
    const out = [];
    for (const p of data.data || []) {
      out.push({ type: 'facebook', name: p.name, handle: p.name, external_id: p.id, avatar: p.picture?.data?.url, profile_url: `https://www.facebook.com/${p.id}`, config: { pageId: p.id, token: p.access_token } });
      const ig = p.instagram_business_account;
      if (ig) out.push({ type: 'instagram', name: ig.name || ig.username, handle: `@${ig.username}`, external_id: ig.id, avatar: ig.profile_picture_url, profile_url: `https://www.instagram.com/${ig.username}`, config: { igId: ig.id, token: p.access_token } });
    }
    if (!out.length) throw new ProviderError('400 no Facebook Pages found — make sure you selected your Page(s) in the login dialog', 400);
    return out;
  },
};

export const facebook = {
  id: 'facebook', label: 'Facebook Page', color: '#0866ff', limit: 63206,
  media: { max: 10, video: true, videoAlone: true },
  connector: 'meta',
  async publish({ config, app, text, media }) {
    const g = `${endpoints.graph}/${v(app)}`;
    const token = config.token;
    const video = media.find((m) => m.mime.startsWith('video/'));
    if (video) {
      const fd = new FormData();
      fd.append('access_token', token); fd.append('description', text); fd.append('source', await video.blob(), video.filename);
      const { data } = await request(`${endpoints.video}/${v(app)}/${config.pageId}/videos`, { form: fd, timeout: 600_000 });
      return { id: data.id, url: `https://www.facebook.com/${data.id}` };
    }
    if (media.length === 1) {
      const fd = new FormData();
      fd.append('access_token', token); fd.append('caption', text); fd.append('source', await media[0].blob(), media[0].filename);
      const { data } = await request(`${g}/${config.pageId}/photos`, { form: fd });
      const id = data.post_id || data.id;
      return { id, url: `https://www.facebook.com/${id}` };
    }
    const form = { access_token: token, message: text };
    if (media.length > 1) {
      for (let i = 0; i < media.length; i++) {
        const fd = new FormData();
        fd.append('access_token', token); fd.append('published', 'false'); fd.append('source', await media[i].blob(), media[i].filename);
        const { data } = await request(`${g}/${config.pageId}/photos`, { form: fd });
        form[`attached_media[${i}]`] = { media_fbid: data.id };
      }
    } else {
      const link = urlsIn(text)[0];
      if (link) form.link = link;
    }
    const { data } = await request(`${g}/${config.pageId}/feed`, { form });
    return { id: data.id, url: `https://www.facebook.com/${data.id}` };
  },
  async metrics({ config, app, remoteId }) {
    const { data } = await request(`${endpoints.graph}/${v(app)}/${remoteId}`, { query: { access_token: config.token, fields: 'reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares' } });
    return { likes: data.reactions?.summary?.total_count, replies: data.comments?.summary?.total_count, reposts: data.shares?.count || 0 };
  },
};

/** Instagram & Threads both fetch media from a public URL, then publish a container. */
export function publicUrlOf(m, network) {
  if (!m.url || !m.url.startsWith('https://')) {
    throw new ProviderError(`400 ${network} downloads media from your server, so it needs a public HTTPS address. Set “Public URL” in Settings → General.`, 400);
  }
  return m.url;
}

export const instagram = {
  id: 'instagram', label: 'Instagram', color: '#e1306c', limit: 2200,
  media: { max: 10, video: true, required: true, imageTypes: ['image/jpeg'] },
  connector: 'meta',
  validate(text) { if (hashtagCount(text) > 30) return 'Instagram allows at most 30 hashtags'; },
  async publish({ config, app, text, media }) {
    if (!media.length) throw new ProviderError('400 Instagram posts need at least one image or video', 400);
    const g = `${endpoints.graph}/${v(app)}`;
    const token = config.token;
    const container = async (params) => (await request(`${g}/${config.igId}/media`, { form: { access_token: token, ...params } })).data.id;
    const ready = (id) => waitFor(async () => {
      const { data } = await request(`${g}/${id}`, { query: { access_token: token, fields: 'status_code,status' } });
      if (data.status_code === 'ERROR') throw new ProviderError(`400 Instagram rejected the media: ${data.status || 'unknown error'}`, 400);
      return data.status_code === 'FINISHED';
    }, { tries: 100, every: 3000, what: 'Instagram media processing' });
    const item = (m, extra) => {
      if (m.mime.startsWith('image/') && m.mime !== 'image/jpeg') throw new ProviderError(`400 Instagram only accepts JPEG images (${m.filename})`, 400);
      return m.mime.startsWith('video/') ? { media_type: extra.is_carousel_item ? 'VIDEO' : 'REELS', video_url: publicUrlOf(m, 'Instagram'), ...extra } : { image_url: publicUrlOf(m, 'Instagram'), ...extra };
    };
    let id;
    if (media.length === 1) id = await container(item(media[0], { caption: text }));
    else {
      const children = [];
      for (const m of media) { const c = await container(item(m, { is_carousel_item: true })); await ready(c); children.push(c); }
      id = await container({ media_type: 'CAROUSEL', children: children.join(','), caption: text });
    }
    await ready(id);
    const { data } = await request(`${g}/${config.igId}/media_publish`, { form: { access_token: token, creation_id: id } });
    let url = null;
    try { url = (await request(`${g}/${data.id}`, { query: { access_token: token, fields: 'permalink' } })).data.permalink; } catch { /* cosmetic */ }
    return { id: data.id, url };
  },
  async metrics({ config, app, remoteId }) {
    const { data } = await request(`${endpoints.graph}/${v(app)}/${remoteId}`, { query: { access_token: config.token, fields: 'like_count,comments_count' } });
    return { likes: data.like_count, replies: data.comments_count };
  },
};

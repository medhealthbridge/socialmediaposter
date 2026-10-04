import { request, ProviderError } from './http.js';
import { blueskyFacets, graphemes } from './text.js';

export const endpoints = { appview: 'https://public.api.bsky.app' };
const svcOf = (c) => (c.service || 'https://bsky.social').replace(/\/$/, '');

async function session(config) {
  const { data } = await request(`${svcOf(config)}/xrpc/com.atproto.server.createSession`, { json: { identifier: config.handle, password: config.password } });
  return data;
}

export const provider = {
  id: 'bluesky', label: 'Bluesky', color: '#1185fe', limit: 300, length: graphemes,
  media: { max: 4, video: false, maxImageBytes: 1_000_000 },
  thread: 'native',
  fields: [
    { key: 'handle', label: 'Handle or email', placeholder: 'you.bsky.social' },
    { key: 'password', label: 'App password (Settings → Privacy & security → App passwords)', secret: true },
    { key: 'service', label: 'PDS server (optional)', placeholder: 'https://bsky.social', optional: true },
  ],
  async verify(config) {
    const s = await session(config);
    config.handle = s.handle;
    let avatar = null, name = s.handle;
    try {
      const { data } = await request(`${endpoints.appview}/xrpc/app.bsky.actor.getProfile`, { query: { actor: s.did } });
      avatar = data.avatar; name = data.displayName || s.handle;
    } catch { /* profile is cosmetic */ }
    return { name, handle: `@${s.handle}`, avatar, external_id: s.did, profile_url: `https://bsky.app/profile/${s.handle}` };
  },
  async publish({ config, text, media, replyTo, threadRoot }) {
    const s = await session(config);
    const headers = { authorization: `Bearer ${s.accessJwt}` };
    const record = { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString(), facets: blueskyFacets(text) };
    // A reply names both the post above it and the first post of the thread.
    if (replyTo) record.reply = { root: threadRoot || replyTo, parent: replyTo };
    if (media.length) {
      const images = [];
      for (const m of media) {
        if (m.size > 1_000_000) throw new ProviderError(`400 Bluesky images must be under 1 MB (${m.filename} is ${(m.size / 1e6).toFixed(1)} MB)`, 400);
        const { data } = await request(`${svcOf(config)}/xrpc/com.atproto.repo.uploadBlob`, { headers: { ...headers, 'content-type': m.mime }, body: await m.read() });
        images.push({ alt: m.alt || '', image: data.blob });
      }
      record.embed = { $type: 'app.bsky.embed.images', images };
    }
    const { data } = await request(`${svcOf(config)}/xrpc/com.atproto.repo.createRecord`, { headers, json: { repo: s.did, collection: 'app.bsky.feed.post', record } });
    return { id: data.uri, url: `https://bsky.app/profile/${s.handle}/post/${data.uri.split('/').pop()}`, ref: { uri: data.uri, cid: data.cid } };
  },
  async metrics({ remoteId }) {
    const { data } = await request(`${endpoints.appview}/xrpc/app.bsky.feed.getPosts`, { query: { uris: remoteId } });
    const p = data.posts?.[0];
    return p ? { likes: p.likeCount, reposts: (p.repostCount || 0) + (p.quoteCount || 0), replies: p.replyCount } : null;
  },
};

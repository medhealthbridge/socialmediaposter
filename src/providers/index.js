// Each provider: { label, limit, fields, validate(config), publish({config,text,media}) -> {id,url} }
const post = async (url, { headers = {}, body }) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let json;
  try { json = raw ? JSON.parse(raw) : {}; } catch { json = { raw }; }
  if (!res.ok) throw new Error(`${res.status} ${json.error || json.message || json.description || raw.slice(0, 200)}`);
  return json;
};

const withMedia = (text, media) => [text, ...media].join('\n').trim();

export const providers = {
  mastodon: {
    label: 'Mastodon', limit: 500,
    fields: [
      { key: 'instance', label: 'Instance URL', placeholder: 'https://mastodon.social' },
      { key: 'token', label: 'Access token (write:statuses)', secret: true },
    ],
    async publish({ config, text, media }) {
      const base = config.instance.replace(/\/$/, '');
      const j = await post(`${base}/api/v1/statuses`, {
        headers: { authorization: `Bearer ${config.token}` },
        body: { status: withMedia(text, media), visibility: config.visibility || 'public' },
      });
      return { id: j.id, url: j.url };
    },
  },
  bluesky: {
    label: 'Bluesky', limit: 300,
    fields: [
      { key: 'handle', label: 'Handle', placeholder: 'you.bsky.social' },
      { key: 'password', label: 'App password', secret: true },
      { key: 'service', label: 'Service (optional)', placeholder: 'https://bsky.social' },
    ],
    async publish({ config, text, media }) {
      const svc = (config.service || 'https://bsky.social').replace(/\/$/, '');
      const s = await post(`${svc}/xrpc/com.atproto.server.createSession`, {
        body: { identifier: config.handle, password: config.password },
      });
      const body = withMedia(text, media);
      const r = await post(`${svc}/xrpc/com.atproto.repo.createRecord`, {
        headers: { authorization: `Bearer ${s.accessJwt}` },
        body: {
          repo: s.did, collection: 'app.bsky.feed.post',
          record: { $type: 'app.bsky.feed.post', text: body, createdAt: new Date().toISOString() },
        },
      });
      return { id: r.uri, url: `https://bsky.app/profile/${config.handle}/post/${r.uri.split('/').pop()}` };
    },
  },
  telegram: {
    label: 'Telegram channel/chat', limit: 4096,
    fields: [
      { key: 'token', label: 'Bot token', secret: true },
      { key: 'chatId', label: 'Chat ID or @channel' },
      { key: 'apiBase', label: 'API base (optional)', placeholder: 'https://api.telegram.org' },
    ],
    async publish({ config, text, media }) {
      const base = (config.apiBase || 'https://api.telegram.org').replace(/\/$/, '');
      const j = await post(`${base}/bot${config.token}/sendMessage`, {
        body: { chat_id: config.chatId, text: withMedia(text, media) },
      });
      return { id: String(j.result?.message_id), url: null };
    },
  },
  discord: {
    label: 'Discord webhook', limit: 2000,
    fields: [{ key: 'webhookUrl', label: 'Webhook URL', secret: true }],
    async publish({ config, text, media }) {
      const j = await post(`${config.webhookUrl}${config.webhookUrl.includes('?') ? '&' : '?'}wait=true`, {
        body: { content: withMedia(text, media) },
      });
      return { id: j.id, url: null };
    },
  },
  webhook: {
    label: 'Generic webhook (Zapier/Make/n8n → any network)', limit: 100000,
    fields: [{ key: 'url', label: 'URL', secret: true }],
    async publish({ config, text, media }) {
      await post(config.url, { body: { text, media } });
      return { id: String(Date.now()), url: null };
    },
  },
  mock: {
    label: 'Mock (dry run, logs only)', limit: 280, fields: [],
    async publish({ config, text }) {
      if (config.failWith) throw new Error(config.failWith);
      console.log(`[mock] ${text}`);
      return { id: `mock-${Date.now()}`, url: null };
    },
  },
};

export const publicProviders = () =>
  Object.fromEntries(Object.entries(providers).map(([k, { label, limit, fields }]) => [k, { label, limit, fields }]));

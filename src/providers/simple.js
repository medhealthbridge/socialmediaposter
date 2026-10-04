import { request, ProviderError } from './http.js';

export const endpoints = { telegram: 'https://api.telegram.org' };

export const telegram = {
  id: 'telegram', label: 'Telegram', color: '#229ed9', limit: 4096,
  media: { max: 10, video: true },
  thread: 'native',
  fields: [
    { key: 'token', label: 'Bot token (from @BotFather)', secret: true },
    { key: 'chatId', label: 'Channel/group: @username or numeric ID (add the bot as admin)' },
  ],
  async verify(config) {
    const api = `${endpoints.telegram}/bot${config.token}`;
    const { data } = await request(`${api}/getChat`, { query: { chat_id: config.chatId } });
    const chat = data.result;
    config.username = chat.username || null;
    return { name: chat.title || chat.username || String(chat.id), handle: chat.username ? `@${chat.username}` : String(chat.id), external_id: String(chat.id), profile_url: chat.username ? `https://t.me/${chat.username}` : null };
  },
  async publish({ config, text, media, replyTo }) {
    const api = `${endpoints.telegram}/bot${config.token}`;
    const reply = replyTo ? { reply_parameters: { message_id: Number(replyTo) } } : {};
    const link = (id) => (config.username && id ? `https://t.me/${config.username}/${id}` : null);
    const kind = (m) => (m.mime.startsWith('video/') ? 'video' : m.mime === 'image/gif' ? 'animation' : 'photo');
    if (!media.length) {
      const { data } = await request(`${api}/sendMessage`, { json: { chat_id: config.chatId, text, ...reply } });
      return { id: String(data.result.message_id), url: link(data.result.message_id), ref: data.result.message_id };
    }
    const caption = text.length <= 1024 ? text : undefined; // captions are limited to 1024 chars
    let first;
    if (media.length === 1) {
      const m = media[0], k = kind(m);
      const fd = new FormData();
      fd.append('chat_id', config.chatId);
      if (caption) fd.append('caption', caption);
      if (replyTo) fd.append('reply_parameters', JSON.stringify({ message_id: Number(replyTo) }));
      fd.append(k, await m.blob(), m.filename);
      const { data } = await request(`${api}/send${k[0].toUpperCase() + k.slice(1)}`, { form: fd });
      first = data.result.message_id;
    } else {
      const fd = new FormData();
      fd.append('chat_id', config.chatId);
      fd.append('media', JSON.stringify(media.map((m, i) => ({ type: kind(m) === 'video' ? 'video' : 'photo', media: `attach://f${i}`, ...(i === 0 && caption && { caption }) }))));
      for (let i = 0; i < media.length; i++) fd.append(`f${i}`, await media[i].blob(), media[i].filename);
      const { data } = await request(`${api}/sendMediaGroup`, { form: fd });
      first = data.result[0].message_id;
    }
    if (!caption) await request(`${api}/sendMessage`, { json: { chat_id: config.chatId, text } });
    return { id: String(first), url: link(first), ref: first };
  },
};

export const discord = {
  id: 'discord', label: 'Discord', color: '#5865f2', limit: 2000,
  media: { max: 10, video: true, maxBytes: 25 * 1024 * 1024 },
  thread: 'sequential',
  fields: [{ key: 'webhookUrl', label: 'Webhook URL (Channel settings → Integrations → Webhooks)', secret: true }],
  async verify(config) {
    if (!/^https:\/\/(\w+\.)?discord(app)?\.com\/api\/webhooks\//.test(config.webhookUrl) && !config.allowAnyUrl) throw new ProviderError('400 that does not look like a Discord webhook URL', 400);
    const { data } = await request(config.webhookUrl);
    return { name: data.name || 'Discord webhook', handle: data.channel_id ? `#${data.channel_id}` : '', avatar: data.avatar ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png` : null, external_id: data.id };
  },
  async publish({ config, text, media }) {
    const url = `${config.webhookUrl}${config.webhookUrl.includes('?') ? '&' : '?'}wait=true`;
    if (!media.length) {
      const { data } = await request(url, { json: { content: text } });
      return { id: data.id, url: null };
    }
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({ content: text }));
    for (let i = 0; i < media.length; i++) fd.append(`files[${i}]`, await media[i].blob(), media[i].filename);
    const { data } = await request(url, { form: fd });
    return { id: data.id, url: null };
  },
};

export const webhook = {
  id: 'webhook', label: 'Webhook (Zapier, Make, n8n…)', color: '#ff6d00', limit: 100000,
  media: { max: 20, video: true },
  thread: 'sequential',
  fields: [
    { key: 'url', label: 'Webhook URL', secret: true },
    { key: 'secret', label: 'Secret sent as X-Webhook-Secret header (optional)', secret: true, optional: true },
  ],
  async publish({ config, text, media, account }) {
    await request(config.url, {
      headers: config.secret ? { 'x-webhook-secret': config.secret } : {},
      json: { text, account: account?.name, media: media.map((m) => ({ url: m.url, mime: m.mime, alt: m.alt, filename: m.filename })) },
    });
    return { id: String(Date.now()), url: null };
  },
};

export const mock = {
  id: 'mock', label: 'Test account (dry run)', color: '#8a8f98', limit: 500,
  media: { max: 10, video: true },
  thread: 'sequential',
  fields: [],
  async verify() { return { name: 'Test account', handle: 'dry run' }; },
  async publish({ config, text, media }) {
    if (config.failWith) throw new ProviderError(config.failWith, Number(config.failWith.split(' ')[0]) || 500);
    console.log(`[dry run] ${text}${media.length ? ` (+${media.length} media)` : ''}`);
    const id = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    return { id, url: null, ref: id };
  },
  async metrics({ remoteId }) {
    const n = Number(String(remoteId).slice(-3)) || 0;
    return { likes: n % 17, reposts: n % 5, replies: n % 3 };
  },
};

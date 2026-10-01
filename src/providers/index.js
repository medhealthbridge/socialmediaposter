import * as mastodon from './mastodon.js';
import * as bluesky from './bluesky.js';
import * as x from './x.js';
import * as linkedin from './linkedin.js';
import * as meta from './meta.js';
import * as threads from './threads.js';
import * as simple from './simple.js';

export const providers = Object.fromEntries([
  x.provider, meta.instagram, meta.facebook, linkedin.provider, threads.provider,
  bluesky.provider, mastodon.provider, simple.telegram, simple.discord, simple.webhook, simple.mock,
].map((p) => [p.id, p]));

export const connectors = Object.fromEntries([x.connector, meta.connector, linkedin.connector, threads.connector, mastodon.connector].map((c) => [c.id, c]));

export const lengthOf = (type, text) => (providers[type].length ? providers[type].length(text) : [...text].length);

export function publicProviders() {
  return Object.fromEntries(Object.values(providers).map((p) => [p.id, {
    id: p.id, label: p.label, color: p.color, limit: p.limit, media: p.media, connector: p.connector || null,
    fields: p.fields || null, metrics: !!p.metrics,
  }]));
}

export function publicConnectors() {
  return Object.fromEntries(Object.values(connectors).map((c) => [c.id, {
    id: c.id, label: c.label, input: c.input || null,
    app: c.app ? { fields: c.app.fields, docs: c.app.docs, steps: c.app.steps } : null,
  }]));
}

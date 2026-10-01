import { createHash, randomBytes } from 'node:crypto';
import { connectors } from './providers/index.js';
import { httpError } from './errors.js';

export function createOAuth(svc) {
  const q = (s) => svc.db.prepare(s);
  return {
    async start(uid, connectorId, input = {}) {
      const c = connectors[connectorId];
      if (!c) throw httpError(404, 'unknown network');
      const app = c.app ? svc.settings.app(uid, connectorId) : null;
      if (c.app && !c.app.fields.every((f) => f.optional || app?.[f.key])) {
        throw Object.assign(httpError(400, `Set up your ${c.label} developer app first`), { needsSetup: connectorId });
      }
      const redirectUri = `${svc.settings.baseUrl(uid)}/oauth/callback/${connectorId}`;
      const state = randomBytes(24).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      let r;
      try { r = await c.start({ app, input, redirectUri, state, challenge, store: svc.settings.store(uid, 'oauthStore') }); }
      catch (e) { throw httpError(e.status && e.status < 500 ? 400 : 502, e.message.replace(/^\d+ /, '')); }
      q('INSERT INTO oauth_states(state,user_id,connector,verifier,redirect_uri,data) VALUES (?,?,?,?,?,?)')
        .run(state, uid, connectorId, verifier, redirectUri, JSON.stringify(r.data || {}));
      return { url: r.url };
    },

    /** Handles the redirect back from the network. The state ties it to the user who started it. */
    async callback(connectorId, { code, state, error, error_description: desc }) {
      q('DELETE FROM oauth_states WHERE created_at < ?').run(new Date(Date.now() - 20 * 60e3).toISOString());
      const row = state && q('SELECT * FROM oauth_states WHERE state=?').get(String(state));
      if (!row || row.connector !== connectorId) throw httpError(400, 'This login link has expired. Please try connecting again.');
      q('DELETE FROM oauth_states WHERE state=?').run(row.state);
      if (error || !code) throw httpError(400, desc || error || 'Login was cancelled');
      const c = connectors[connectorId];
      const accounts = await c.callback({
        app: c.app ? svc.settings.app(row.user_id, connectorId) : null,
        code: String(code), redirectUri: row.redirect_uri, verifier: row.verifier, data: JSON.parse(row.data),
        store: svc.settings.store(row.user_id, 'oauthStore'),
      });
      const saved = accounts.map((a) => svc.upsertOAuthAccount(row.user_id, a));
      return { uid: row.user_id, accounts: saved };
    },
  };
}

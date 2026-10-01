import { connectors } from './providers/index.js';
import { httpError } from './errors.js';

/** Per-user settings, all stored encrypted. Everything is configured from the web UI. */
export function createSettings(db, vault) {
  const s = {
    async get(uid, key, def = null) {
      const row = await db.get('SELECT value FROM settings WHERE user_id=? AND key=?', uid, key);
      return row ? vault.open(row.value) : def;
    },
    set: (uid, key, value) => db.run('INSERT INTO settings(user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value', uid, key, vault.seal(value)),
    async app(uid, connectorId) { return (await s.get(uid, 'apps', {}))[connectorId] || null; },
    async baseUrl(uid) {
      return (await s.get(uid, 'publicUrl')) || (await s.get(uid, 'detectedUrl')) || `http://localhost:${process.env.PORT || 3000}`;
    },
    /** Remember where the UI is opened from — the default for OAuth redirects and media links. */
    async noteOrigin(uid, origin) {
      if (origin && (await s.get(uid, 'detectedUrl')) !== origin) await s.set(uid, 'detectedUrl', origin);
    },
    /** Small key/value store used by Mastodon's automatic app registration. */
    store(uid, key) {
      return {
        get: async (k) => (await s.get(uid, key, {}))[k],
        set: async (k, v) => { const all = await s.get(uid, key, {}); all[k] = v; await s.set(uid, key, all); },
      };
    },
    async view(uid) {
      const apps = await s.get(uid, 'apps', {});
      const ai = await s.get(uid, 'ai', {});
      const base = await s.baseUrl(uid);
      const appsView = {};
      for (const c of Object.values(connectors)) {
        if (!c.app) continue;
        const cur = apps[c.id] || {};
        appsView[c.id] = Object.fromEntries(c.app.fields.map((f) => [f.key, f.secret ? (cur[f.key] ? '••••••••' : '') : cur[f.key] || '']));
        appsView[c.id].configured = c.app.fields.every((f) => f.optional || cur[f.key]);
        appsView[c.id].redirectUri = `${base}/oauth/callback/${c.id}`;
      }
      return {
        publicUrl: (await s.get(uid, 'publicUrl')) || '',
        effectiveUrl: base,
        alertsAccountId: await s.get(uid, 'alertsAccountId'),
        utm: await s.get(uid, 'utm', { enabled: false, source: '{network}', medium: 'social', campaign: '' }),
        ai: { model: ai.model || 'claude-opus-5-5', hasKey: !!ai.apiKey },
        apps: appsView,
      };
    },
    async update(uid, patch) {
      if ('publicUrl' in patch) {
        let u = String(patch.publicUrl || '').trim().replace(/\/+$/, '');
        if (u) {
          try { const p = new URL(u); if (!/^https?:$/.test(p.protocol)) throw 0; u = p.origin + p.pathname.replace(/\/+$/, ''); }
          catch { throw httpError(400, 'Public URL must look like https://poster.example.com'); }
        }
        await s.set(uid, 'publicUrl', u || null);
      }
      if ('alertsAccountId' in patch) await s.set(uid, 'alertsAccountId', patch.alertsAccountId ? Number(patch.alertsAccountId) : null);
      if (patch.utm) {
        const u = patch.utm;
        await s.set(uid, 'utm', { enabled: !!u.enabled, source: String(u.source ?? '').slice(0, 100), medium: String(u.medium ?? '').slice(0, 100), campaign: String(u.campaign ?? '').slice(0, 100) });
      }
      if (patch.ai) {
        const cur = await s.get(uid, 'ai', {});
        const next = { ...cur, model: String(patch.ai.model || cur.model || 'claude-opus-5-5') };
        if (patch.ai.apiKey === null) delete next.apiKey;
        else if (patch.ai.apiKey && !patch.ai.apiKey.startsWith('••')) next.apiKey = String(patch.ai.apiKey).trim();
        await s.set(uid, 'ai', next);
      }
      if (patch.apps) {
        const all = await s.get(uid, 'apps', {});
        for (const [id, vals] of Object.entries(patch.apps)) {
          const c = connectors[id];
          if (!c?.app) throw httpError(400, `unknown integration ${id}`);
          const cur = all[id] || {};
          for (const f of c.app.fields) {
            const v = vals[f.key];
            if (v === undefined || (f.secret && String(v).startsWith('••'))) continue;
            cur[f.key] = String(v).trim();
          }
          all[id] = cur;
        }
        await s.set(uid, 'apps', all);
      }
      return s.view(uid);
    },
  };
  return s;
}

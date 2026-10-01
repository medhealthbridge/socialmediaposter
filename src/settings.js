import { connectors } from './providers/index.js';
import { httpError } from './errors.js';

/** Per-user settings, all stored encrypted. Everything the app needs is configured from the web UI. */
export function createSettings(db, vault) {
  const q = (s) => db.prepare(s);
  const s = {
    get(uid, key, def = null) {
      const row = q('SELECT value FROM settings WHERE user_id=? AND key=?').get(uid, key);
      return row ? vault.open(row.value) : def;
    },
    set(uid, key, value) {
      q('INSERT INTO settings(user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value')
        .run(uid, key, vault.seal(value));
    },
    app(uid, connectorId) { return s.get(uid, 'apps', {})[connectorId] || null; },
    baseUrl(uid) {
      return s.get(uid, 'publicUrl') || s.get(uid, 'detectedUrl') || `http://localhost:${process.env.PORT || 3000}`;
    },
    /** Remember where the UI is served from, as a default for OAuth redirects and media links. */
    noteOrigin(uid, origin) {
      if (origin && s.get(uid, 'detectedUrl') !== origin) s.set(uid, 'detectedUrl', origin);
    },
    /** Key/value store used by Mastodon's dynamic app registration. */
    store(uid, key) {
      return {
        get: (k) => s.get(uid, key, {})[k],
        set: (k, v) => { const all = s.get(uid, key, {}); all[k] = v; s.set(uid, key, all); },
      };
    },
    view(uid) {
      const apps = s.get(uid, 'apps', {});
      const ai = s.get(uid, 'ai', {});
      const appsView = {};
      for (const c of Object.values(connectors)) {
        if (!c.app) continue;
        const cur = apps[c.id] || {};
        appsView[c.id] = Object.fromEntries(c.app.fields.map((f) => [f.key, f.secret ? (cur[f.key] ? '••••••••' : '') : cur[f.key] || '']));
        appsView[c.id].configured = c.app.fields.every((f) => f.optional || cur[f.key]);
        appsView[c.id].redirectUri = `${s.baseUrl(uid)}/oauth/callback/${c.id}`;
      }
      return {
        publicUrl: s.get(uid, 'publicUrl') || '',
        effectiveUrl: s.baseUrl(uid),
        paused: !!s.get(uid, 'paused'),
        alertsAccountId: s.get(uid, 'alertsAccountId'),
        utm: s.get(uid, 'utm', { enabled: false, source: '{network}', medium: 'social', campaign: '' }),
        ai: { model: ai.model || 'claude-opus-5-5', hasKey: !!ai.apiKey },
        apps: appsView,
      };
    },
    update(uid, patch) {
      if ('publicUrl' in patch) {
        let u = String(patch.publicUrl || '').trim().replace(/\/+$/, '');
        if (u) {
          try { const p = new URL(u); if (!/^https?:$/.test(p.protocol)) throw 0; u = p.origin + p.pathname.replace(/\/+$/, ''); }
          catch { throw httpError(400, 'Public URL must look like https://poster.example.com'); }
        }
        s.set(uid, 'publicUrl', u || null);
      }
      if ('paused' in patch) s.set(uid, 'paused', !!patch.paused);
      if ('alertsAccountId' in patch) s.set(uid, 'alertsAccountId', patch.alertsAccountId ? Number(patch.alertsAccountId) : null);
      if (patch.utm) {
        const u = patch.utm;
        s.set(uid, 'utm', { enabled: !!u.enabled, source: String(u.source ?? '').slice(0, 100), medium: String(u.medium ?? '').slice(0, 100), campaign: String(u.campaign ?? '').slice(0, 100) });
      }
      if (patch.ai) {
        const cur = s.get(uid, 'ai', {});
        const next = { ...cur, model: String(patch.ai.model || cur.model || 'claude-opus-5-5') };
        if (patch.ai.apiKey === null) delete next.apiKey;
        else if (patch.ai.apiKey && !patch.ai.apiKey.startsWith('••')) next.apiKey = String(patch.ai.apiKey).trim();
        s.set(uid, 'ai', next);
      }
      if (patch.apps) {
        const all = s.get(uid, 'apps', {});
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
        s.set(uid, 'apps', all);
      }
      return s.view(uid);
    },
  };
  return s;
}

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { connectors } from './providers/index.js';
import { AI_PROVIDERS } from './ai.js';
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
    /** A stable secret for this user's cron URL, made on first use. */
    async cronKey(uid) {
      let key = await s.get(uid, 'cronKey');
      if (!key) { key = `cr_${randomBytes(18).toString('base64url')}`; await s.set(uid, 'cronKey', key); }
      return key;
    },

    /** Which user a cron key belongs to, or null. */
    async ownerOfCronKey(key) {
      if (!key || !/^cr_[\w-]{10,}$/.test(key)) return null;
      for (const u of await db.all('SELECT id FROM users')) {
        const mine = await s.get(u.id, 'cronKey');
        if (mine && mine.length === key.length && timingSafeEqual(Buffer.from(mine), Buffer.from(key))) return u.id;
      }
      return null;
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
      const lastCronAt = await s.get(uid, 'lastCronAt');
      return {
        publicUrl: (await s.get(uid, 'publicUrl')) || '',
        lastCronAt,
        // "Working" means a timer actually called us recently — not just that it was set up.
        autoPublish: !!lastCronAt && Date.now() - new Date(lastCronAt).getTime() < 3 * 3600e3,
        effectiveUrl: base,
        alertsAccountId: await s.get(uid, 'alertsAccountId'),
        agentCanPublish: !!(await s.get(uid, 'agentCanPublish')),
        drive: {
          // The key itself never leaves the server; the UI only needs to know whether one is set.
          hasKey: !!(await s.get(uid, 'driveApiKey')),
          autoGrammar: !!(await s.get(uid, 'driveAutoGrammar')),
        },
        utm: await s.get(uid, 'utm', { enabled: false, source: '{network}', medium: 'social', campaign: '' }),
        ai: {
          provider: AI_PROVIDERS[ai.provider] ? ai.provider : 'gemini',
          model: ai.model || AI_PROVIDERS[AI_PROVIDERS[ai.provider] ? ai.provider : 'gemini'].defaultModel,
          hasKey: Object.fromEntries(Object.values(AI_PROVIDERS).map((p) => [p.id, !!ai[p.keyField]])),
        },
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
      if ('alertsAccountId' in patch) {
        const aid = patch.alertsAccountId ? Number(patch.alertsAccountId) : null;
        // Sending alerts re-checks this anyway, so a stray id is harmless — but saving one
        // would quietly give you an alert setting that never fires.
        if (aid && !(await db.get('SELECT 1 FROM accounts WHERE id=? AND user_id=?', aid, uid))) throw httpError(404, 'account not found');
        await s.set(uid, 'alertsAccountId', aid);
      }
      if ('agentCanPublish' in patch) await s.set(uid, 'agentCanPublish', !!patch.agentCanPublish);
      if (patch.drive) {
        if ('apiKey' in patch.drive) {
          const k = patch.drive.apiKey;
          if (k === null || k === '') await s.set(uid, 'driveApiKey', null);
          else if (!String(k).startsWith('••')) await s.set(uid, 'driveApiKey', String(k).trim());
        }
        if ('autoGrammar' in patch.drive) await s.set(uid, 'driveAutoGrammar', !!patch.drive.autoGrammar);
      }
      if (patch.utm) {
        const u = patch.utm;
        await s.set(uid, 'utm', { enabled: !!u.enabled, source: String(u.source ?? '').slice(0, 100), medium: String(u.medium ?? '').slice(0, 100), campaign: String(u.campaign ?? '').slice(0, 100) });
      }
      if (patch.ai) {
        const cur = await s.get(uid, 'ai', {});
        const next = { ...cur };
        if (patch.ai.provider) {
          if (!AI_PROVIDERS[patch.ai.provider]) throw httpError(400, 'unknown AI provider');
          if (patch.ai.provider !== cur.provider) next.model = null; // models differ per provider
          next.provider = patch.ai.provider;
        }
        const spec = AI_PROVIDERS[next.provider || 'gemini'];
        if (patch.ai.model !== undefined) next.model = patch.ai.model ? String(patch.ai.model).slice(0, 120) : null;
        if (patch.ai.apiKey === null) delete next[spec.keyField];
        else if (patch.ai.apiKey && !patch.ai.apiKey.startsWith('••')) next[spec.keyField] = String(patch.ai.apiKey).trim();
        if (!next.model) next.model = spec.defaultModel;
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

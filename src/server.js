import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createService, httpError } from './service.js';
import { createAuth } from './auth.js';
import { createFeeds } from './feeds.js';
import { createAnalytics } from './analytics.js';
import { createAI, AI_PROVIDERS } from './ai.js';
import { createOAuth } from './oauth.js';
import { createMcp } from './mcp.js';
import { createEvents, KINDS } from './events.js';
import { createAgent } from './agent.js';
import { publicProviders, publicConnectors } from './providers/index.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
// The clip maker runs ffmpeg as WebAssembly inside a worker it builds from a blob, so
// script-src needs blob: and 'wasm-unsafe-eval', and the engine itself may come from jsDelivr.
const CSP = "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:; child-src 'self' blob:; connect-src 'self' blob: https://*.vercel-storage.com https://vercel.com https://cdn.jsdelivr.net; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const timingSafeEqualStr = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cookieOf = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
const hostOf = (req) => req.headers['x-forwarded-host'] || req.headers.host;
const sameHost = (req) => { try { return new URL(req.headers.origin).host === hostOf(req); } catch { return false; } };
const originOf = (req) => `${req.headers['x-forwarded-proto']?.split(',')[0] || (req.socket?.encrypted ? 'https' : 'http')}://${hostOf(req)}`;
const clientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || '';

/** Wires every module together. */
export async function createContext(db, opts = {}) {
  const events = createEvents(db);
  // One service per actor, so the activity log can say who did something —
  // you, the assistant, the agent or the timer. They are stateless, so they are reused.
  const byActor = new Map();
  const serviceAs = (actor) => {
    if (!byActor.has(actor)) byActor.set(actor, createService(db, { ...opts, events, actor }));
    return byActor.get(actor);
  };
  const svc = serviceAs('you');
  const analytics = createAnalytics(svc);
  const ai = createAI(svc.settings);
  return {
    db, svc, serviceAs, events, analytics, ai,
    auth: createAuth(db, opts), feeds: createFeeds(serviceAs('rss')), oauth: createOAuth(svc),
    mcp: createMcp({ svc: serviceAs('assistant'), analytics, db }),
    agent: createAgent({ serviceAs, analytics, settings: svc.settings }),
  };
}

function buildRoutes({ svc, auth, feeds, analytics, ai, oauth, mcp, events, agent }) {
  const routes = [];
  const r = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, ...opts });
  };
  const id = (p) => Number(p.id);

  r('GET', '/api/auth/status', async ({ me }) => ({ needsSetup: (await auth.userCount()) === 0, user: me }), { public: true });

  // Everything the UI needs on load. Also refreshes long-lived tokens when needed.
  r('GET', '/api/bootstrap', async ({ uid, me, req }) => {
    await svc.settings.noteOrigin(uid, originOf(req));
    await svc.maintain(uid).catch(() => {});
    return {
      user: me, providers: publicProviders(), connectors: publicConnectors(), aiProviders: AI_PROVIDERS, storage: svc.media.kind, eventKinds: KINDS,
      accounts: await svc.listAccounts(uid), settings: await svc.settings.view(uid), snippets: await svc.listSnippets(uid), counts: await svc.counts(uid),
      mcpUrl: `${await svc.settings.baseUrl(uid)}/mcp`,
      slots: await svc.getSlots(uid), nextSlot: await svc.nextSlot(uid), agentTools: agent.tools,
    };
  });

  r('PUT', '/api/me', async ({ uid, body }) => { if (body.tz) await auth.setTz(uid, body.tz); return { ok: true }; });
  r('POST', '/api/me/password', async ({ uid, body }) => { await auth.changePassword(uid, body.current, body.next); return { ok: true }; });
  r('GET', '/api/users', () => auth.listUsers(), { admin: true });
  r('POST', '/api/users', ({ body }) => auth.createUser(body), { admin: true, status: 201 });
  r('DELETE', '/api/users/:id', ({ params }) => auth.deleteUser(id(params)), { admin: true });

  r('GET', '/api/settings', ({ uid }) => svc.settings.view(uid));
  r('PUT', '/api/settings', async ({ uid, body }) => {
    const out = await svc.settings.update(uid, body);
    await events.add(uid, 'settings', `Changed settings: ${Object.keys(body).join(', ')}`);
    return out;
  });

  r('GET', '/api/accounts', ({ uid }) => svc.listAccounts(uid));
  r('POST', '/api/accounts', ({ uid, body }) => svc.addAccount(uid, body), { status: 201 });
  r('PATCH', '/api/accounts/:id', ({ uid, params, body }) => svc.renameAccount(uid, id(params), body.name));
  r('DELETE', '/api/accounts/:id', ({ uid, params }) => svc.deleteAccount(uid, id(params)));
  r('POST', '/api/accounts/:id/check', ({ uid, params }) => svc.checkAccount(uid, id(params)));
  r('POST', '/api/accounts/:id/test-post', ({ uid, params }) => svc.testPost(uid, id(params)));
  r('GET', '/api/accounts/:id/options', ({ uid, params }) => svc.accountOptions(uid, id(params)));
  r('POST', '/api/accounts/:id/options', ({ uid, params, body }) => svc.setAccountOption(uid, id(params), body.key, body.value));
  r('POST', '/api/connect/:connector', ({ uid, params, body }) => oauth.start(uid, params.connector, body));

  r('GET', '/api/posts', ({ uid, query }) => svc.listPosts(uid, { status: query.get('status'), q: query.get('q'), limit: query.get('limit') }));
  r('GET', '/api/counts', ({ uid }) => svc.counts(uid));
  r('POST', '/api/posts', ({ uid, body }) => svc.createPost(uid, body), { status: 201 });
  r('POST', '/api/posts/check', async ({ uid, body }) => ({ problems: await svc.problems(uid, { text: body.text || '', media: (body.media || []).map(Number), accountIds: (body.accountIds || []).map(Number), overrides: body.overrides || {} }) }));
  r('POST', '/api/queue/next', ({ uid }) => svc.publishNext(uid));
  r('GET', '/api/posts/:id', ({ uid, params }) => svc.getPost(uid, id(params)));
  r('PUT', '/api/posts/:id', ({ uid, params, body }) => svc.updatePost(uid, id(params), body));
  r('DELETE', '/api/posts/:id', ({ uid, params }) => svc.deletePost(uid, id(params)));
  r('POST', '/api/posts/:id/publish', ({ uid, params }) => svc.publish(uid, id(params)));
  r('POST', '/api/posts/:id/move', ({ uid, params, body }) => svc.move(uid, id(params), body.dir));
  r('POST', '/api/posts/:id/duplicate', ({ uid, params }) => svc.duplicatePost(uid, id(params)), { status: 201 });
  r('POST', '/api/bulk', ({ uid, body }) => svc.bulkImport(uid, body.csv ?? ''));
  r('GET', '/api/export.json', ({ uid }) => svc.exportJson(uid), { download: 'social-poster-export.json' });
  r('GET', '/api/export.csv', ({ uid }) => svc.exportCsv(uid), { download: 'social-poster-history.csv', type: 'text/csv; charset=utf-8' });

  r('GET', '/api/media', ({ uid }) => svc.media.list(uid));
  r('POST', '/api/media', ({ uid, req }) => svc.media.save(uid, req, { filename: decodeURIComponent(req.headers['x-filename'] || 'upload') }), { raw: true, status: 201 });
  r('POST', '/api/media/blob-token', ({ uid, body, req }) => svc.media.blobToken(uid, body, req));
  r('POST', '/api/media/register', ({ uid, body }) => svc.media.register(uid, body), { status: 201 });
  r('PATCH', '/api/media/:id', ({ uid, params, body }) => svc.media.setAlt(uid, id(params), body.alt));
  r('DELETE', '/api/media/:id', ({ uid, params }) => svc.media.remove(uid, id(params)));

  r('GET', '/api/slots', async ({ uid }) => ({ slots: await svc.getSlots(uid), next: await svc.nextSlot(uid) }));
  r('PUT', '/api/slots', async ({ uid, body }) => ({ slots: await svc.setSlots(uid, body.slots), next: await svc.nextSlot(uid) }));
  r('GET', '/api/cron-url', async ({ uid }) => ({ url: `${await svc.settings.baseUrl(uid)}/api/cron?key=${await svc.settings.cronKey(uid)}` }));
  r('POST', '/api/run-due', ({ uid }) => svc.runDue({ uid }));

  r('GET', '/api/snippets', ({ uid }) => svc.listSnippets(uid));
  r('POST', '/api/snippets', ({ uid, body }) => svc.saveSnippet(uid, body), { status: 201 });
  r('PUT', '/api/snippets/:id', ({ uid, params, body }) => svc.saveSnippet(uid, { ...body, id: id(params) }));
  r('DELETE', '/api/snippets/:id', ({ uid, params }) => svc.deleteSnippet(uid, id(params)));

  r('GET', '/api/feeds', ({ uid }) => feeds.list(uid));
  r('POST', '/api/feeds', ({ uid, body }) => feeds.add(uid, body), { status: 201 });
  r('POST', '/api/feeds/check-due', ({ uid }) => feeds.checkDue(uid));
  r('PUT', '/api/feeds/:id', ({ uid, params, body }) => feeds.update(uid, id(params), body));
  r('DELETE', '/api/feeds/:id', ({ uid, params }) => feeds.remove(uid, id(params)));
  r('POST', '/api/feeds/:id/check', ({ uid, params }) => feeds.checkNow(uid, id(params)));

  r('GET', '/api/keys', ({ uid }) => mcp.keys.list(uid));
  r('POST', '/api/keys', ({ uid, body }) => mcp.keys.create(uid, body.name), { status: 201 });
  r('DELETE', '/api/keys/:id', ({ uid, params }) => mcp.keys.remove(uid, params.id));

  r('GET', '/api/events', ({ uid, query }) => events.list(uid, { kind: query.get('kind'), level: query.get('level'), limit: query.get('limit'), before: query.get('before') }));
  r('DELETE', '/api/events', ({ uid }) => events.clear(uid));

  r('GET', '/api/analytics', ({ uid, query }) => analytics.stats(uid, { days: Math.min(365, Math.max(7, Number(query.get('days')) || 30)) }));
  r('POST', '/api/analytics/refresh', ({ uid }) => analytics.refreshMetrics({ uid, limit: 40 }));
  r('POST', '/api/agent', ({ uid, body }) => agent.chat(uid, body));
  r('GET', '/api/ai/models', ({ uid }) => ai.models(uid));
  r('POST', '/api/ai', ({ uid, body }) => ai.assist(uid, body));
  return routes;
}

function parseBody(raw, type) {
  if (!raw) return {};
  if (type.includes('text/csv')) return { csv: raw };
  if (!type.includes('application/json')) throw httpError(415, 'send JSON');
  return JSON.parse(raw);
}

async function readJson(req) {
  if (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD') return {};
  const type = req.headers['content-type'] || '';
  // Some hosts (Vercel's Node helpers) parse the body before the handler runs, which drains
  // the stream. Use what they parsed when it's there, otherwise read the stream ourselves.
  let pre;
  try { pre = req.body; } catch { pre = undefined; }
  if (pre !== null && pre !== undefined && typeof pre !== 'function') {
    if (Buffer.isBuffer(pre)) return parseBody(pre.toString(), type);
    if (typeof pre === 'string') return parseBody(pre, type);
    if (typeof pre === 'object') return pre;
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 4e6) throw httpError(413, 'request too large'); chunks.push(c); }
  return parseBody(Buffer.concat(chunks).toString(), type);
}

/** Returns a Node (req, res) request handler. Works with http.createServer and as a Vercel function. */
export function createHandler(ctxOrFactory) {
  const factory = typeof ctxOrFactory === 'function' ? ctxOrFactory : () => ctxOrFactory;
  let ctxP = null;
  let routes = null;

  return async function handler(req, res) {
    const headers = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'content-security-policy': CSP };
    const send = (code, body, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(code, { ...headers, 'content-type': type, 'cache-control': 'no-store', ...extra });
      res.end(body === undefined || body === null ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const setCookie = (token, maxAge) => {
      const secure = process.env.COOKIE_SECURE === '1' || !!process.env.VERCEL || req.headers['x-forwarded-proto'] === 'https' || !!req.socket?.encrypted;
      return { 'set-cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}` };
    };
    try {
      let ctx;
      try { ctx = await (ctxP ??= Promise.resolve(factory())); } catch (e) { ctxP = null; throw Object.assign(new Error(`Server setup problem: ${e.message}`), { status: 500, expose: true }); }
      routes ??= buildRoutes(ctx);
      const { svc, auth, oauth, mcp } = ctx;
      const url = new URL(req.url, 'http://x');
      // On Vercel every dynamic path is rewritten to /api?__route=<original path>.
      const path = url.searchParams.has('__route') ? `/${url.searchParams.get('__route')}` : url.pathname;
      url.searchParams.delete('__route');
      const token = cookieOf(req, 'sid');

      if (path.startsWith('/api/')) {
        if (req.method !== 'GET' && req.headers.origin && !sameHost(req)) throw httpError(403, 'cross-site request blocked');
        const me = await auth.userFromToken(token);

        // Called by a timer (Vercel Cron, cron-job.org, …) to publish whatever is due.
        if (path === '/api/cron') {
          const given = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1] || url.searchParams.get('key');
          const secret = process.env.CRON_SECRET;
          // The install-wide secret covers every user; a personal key covers just that user.
          const uids = secret && given && timingSafeEqualStr(given, secret)
            ? (await ctx.db.all('SELECT id FROM users')).map((u) => u.id)
            : [await svc.settings.ownerOfCronKey(given)].filter((x) => x != null);
          if (!uids.length) return send(401, { error: 'invalid cron key' });
          const timer = ctx.serviceAs('timer');
          const out = [];
          for (const id of uids) {
            await svc.settings.set(id, 'lastCronAt', new Date().toISOString());
            const published = await timer.runDue({ uid: id, limit: 50 });
            const feedRun = await ctx.feeds.checkDue(id).catch((e) => ({ error: e.message }));
            if (published.due || feedRun?.created) {
              await ctx.events.add(id, 'cron', `Timer ran: ${published.due} post(s) due, ${feedRun?.created || 0} from RSS`, { actor: 'timer' });
            }
            out.push({ user: id, published, feeds: feedRun });
          }
          return send(200, { ok: true, ran: out });
        }

        if (path === '/api/auth/signup' || path === '/api/auth/login') {
          if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
          const body = await readJson(req);
          if (path === '/api/auth/signup') await auth.signup(body);
          const s = await auth.login(body, clientIp(req));
          await ctx.events.add(s.user.id, 'auth', path.endsWith('signup') ? 'Account created' : 'Signed in', { detail: { ip: clientIp(req) } });
          return send(200, s.user, undefined, setCookie(s.token, s.maxAge));
        }
        if (path === '/api/auth/logout') { await auth.logout(token); return send(200, { ok: true }, undefined, setCookie('', 0)); }

        for (const rt of routes) {
          if (rt.method !== req.method) continue;
          const m = rt.re.exec(path);
          if (!m) continue;
          if (!rt.public && !me) return send(401, { error: 'login required' });
          if (rt.admin && !me.is_admin) return send(403, { error: 'admin only' });
          const body = rt.raw ? null : await readJson(req);
          const params = Object.fromEntries(rt.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const out = await rt.handler({ req, me, uid: me?.id, body, params, query: url.searchParams });
          if (rt.download) return send(200, typeof out === 'string' ? out : JSON.stringify(out, null, 2), rt.type || 'application/json; charset=utf-8', { 'content-disposition': `attachment; filename="${rt.download}"` });
          return send(rt.status || 200, out === undefined || out?.changes !== undefined ? { ok: true } : out);
        }
        return send(404, { error: 'not found' });
      }

      // MCP endpoint for assistants (Claude custom connector). Authenticated by an access key.
      if (path === '/mcp') {
        const cors = {
          'access-control-allow-origin': req.headers.origin || '*',
          'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version, mcp-session-id',
          'access-control-allow-methods': 'POST, GET, OPTIONS',
          'access-control-expose-headers': 'mcp-session-id',
          'access-control-max-age': '86400',
        };
        if (req.method === 'OPTIONS') return send(204, '', 'text/plain', cors);
        if (req.method !== 'POST') return send(405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'use POST' } }, undefined, cors);
        const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
        const uid = await mcp.userForKey(bearer || url.searchParams.get('key'));
        const body = await readJson(req);
        if (uid == null && (Array.isArray(body) ? body : [body]).some((m) => m?.method === 'tools/call')) {
          return send(401, { jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32001, message: 'Invalid or missing access key. Create one in Social Poster → Settings → Assistant access.' } }, undefined,
            { ...cors, 'www-authenticate': 'Bearer realm="social-poster"' });
        }
        const out = await mcp.handle(uid, body);
        return out === null ? send(202, '', 'text/plain', cors) : send(200, out, undefined, cors);
      }

      // OAuth redirect back from a network. No session cookie needed: the state identifies the user.
      const cb = /^\/oauth\/callback\/(\w+)$/.exec(path);
      if (cb) {
        try {
          const r = await oauth.callback(cb[1], Object.fromEntries(url.searchParams));
          return send(302, '', 'text/plain', { location: `/#/accounts?connected=${encodeURIComponent(r.accounts.map((a) => a.name).join(', '))}` });
        } catch (e) {
          return send(302, '', 'text/plain', { location: `/#/accounts?error=${encodeURIComponent(e.message.replace(/^\d+ /, ''))}` });
        }
      }

      // Uploaded media on disk (public: Instagram/Threads fetch it from here).
      const mm = /^\/media\/([\w-]+\.\w+)$/.exec(path);
      if (mm) {
        const f = await svc.media.lookup(mm[1]);
        if (!f) return send(404, 'not found', 'text/plain');
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        const base = { ...headers, 'content-type': f.mime, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=31536000, immutable', 'content-security-policy': "default-src 'none'" };
        if (range && (range[1] || range[2])) {
          let start = range[1] ? Number(range[1]) : f.size - Number(range[2]);
          let end = range[1] && range[2] ? Number(range[2]) : f.size - 1;
          start = Math.max(0, start); end = Math.min(end, f.size - 1);
          if (start > end) { res.writeHead(416, { 'content-range': `bytes */${f.size}` }); return res.end(); }
          res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${f.size}`, 'content-length': end - start + 1 });
          return f.stream({ start, end }).pipe(res);
        }
        res.writeHead(200, { ...base, 'content-length': f.size });
        if (req.method === 'HEAD') return res.end();
        return f.stream().pipe(res);
      }

      // Static UI (on Vercel these files are served by the CDN instead).
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed', 'text/plain');
      if (path === '/favicon.ico') return send(301, '', 'text/plain', { location: '/icon.svg' });
      const file = normalize(path === '/' ? '/index.html' : path);
      if (file.includes('..') || file.includes('\0')) return send(400, 'bad path', 'text/plain');
      try {
        return send(200, await readFile(join(PUBLIC, file)), MIME[extname(file)] || 'application/octet-stream', { 'cache-control': 'no-cache' });
      } catch { return send(404, 'not found', 'text/plain'); }
    } catch (e) {
      const status = e.status || (e instanceof SyntaxError ? 400 : 500);
      if (status >= 500) console.error(e);
      const message = e.status || e.expose ? e.message : e instanceof SyntaxError ? 'bad JSON' : 'internal error';
      if (res.headersSent) return res.destroy();
      // A browser asking for a page gets a readable message, not raw JSON.
      if (e.expose && (req.headers.accept || '').includes('text/html')) {
        return send(status, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Setup needed</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#14171c}
.c{max-width:560px;padding:32px;background:#fff;border:1px solid #e2e5ea;border-radius:12px;margin:16px}h1{font-size:20px;margin:0 0 8px}p{margin:8px 0}code{background:#f1f3f6;padding:2px 6px;border-radius:5px}</style>
<div class="c"><h1>Social Poster needs one more step</h1><p>${esc(message)}</p>
<p class="m">Add it in your Vercel project, then <b>redeploy</b>. Everything else is already set up.</p></div>`, 'text/html; charset=utf-8');
      }
      send(status, { error: message, ...(e.problems && { problems: e.problems }), ...(e.needsSetup && { needsSetup: e.needsSetup }) });
    }
  };
}

/** Default handler (Vercel function and `npm start`); the database is opened on the first request. */
export const handler = createHandler(async () => createContext(await openDb()));

/**
 * Default export so this file also works when a host (e.g. Vercel) treats it as the
 * function entry point directly, not just via api/index.js.
 */
export default handler;

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = +process.env.PORT || 3000;
  const host = process.env.HOST || '127.0.0.1';
  http.createServer(handler).listen(port, host, () => console.log(`Social Poster running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
}

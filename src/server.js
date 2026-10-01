import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createService, httpError } from './service.js';
import { createAuth } from './auth.js';
import { createFeeds } from './feeds.js';
import { createAnalytics } from './analytics.js';
import { createAI, AI_MODELS } from './ai.js';
import { createOAuth } from './oauth.js';
import { publicProviders, publicConnectors } from './providers/index.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CSP = "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const cookieOf = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
const sameHost = (req) => { try { return new URL(req.headers.origin).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch { return false; } };
const originOf = (req) => `${req.headers['x-forwarded-proto']?.split(',')[0] || (req.socket.encrypted ? 'https' : 'http')}://${req.headers['x-forwarded-host'] || req.headers.host}`;

/** Wires every module together. Exposed for tests. */
export function createContext(db, opts = {}) {
  const svc = createService(db, opts);
  return { db, svc, auth: createAuth(db, opts), feeds: createFeeds(svc), analytics: createAnalytics(svc), ai: createAI(svc.settings), oauth: createOAuth(svc) };
}

function buildRoutes({ svc, auth, feeds, analytics, ai, oauth }) {
  const routes = [];
  const r = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, ...opts });
  };
  const id = (p) => Number(p.id);

  // ---- public
  r('GET', '/api/auth/status', ({ me }) => ({ needsSetup: auth.userCount() === 0, user: me }), { public: true });

  // ---- bootstrap (everything the UI needs on load)
  r('GET', '/api/bootstrap', ({ uid, me, req }) => {
    svc.settings.noteOrigin(uid, originOf(req));
    return {
      user: me, providers: publicProviders(), connectors: publicConnectors(), aiModels: AI_MODELS,
      accounts: svc.listAccounts(uid), settings: svc.settings.view(uid), slots: svc.getSlots(uid),
      nextSlot: svc.nextSlot(uid), snippets: svc.listSnippets(uid),
    };
  });

  // ---- me / users
  r('PUT', '/api/me', ({ uid, body }) => { if (body.tz) auth.setTz(uid, body.tz); return { ok: true }; });
  r('POST', '/api/me/password', ({ uid, body }) => { auth.changePassword(uid, body.current, body.next); return { ok: true }; });
  r('GET', '/api/users', () => auth.listUsers(), { admin: true });
  r('POST', '/api/users', ({ body }) => auth.createUser(body), { admin: true, status: 201 });
  r('DELETE', '/api/users/:id', ({ params }) => auth.deleteUser(id(params)), { admin: true });

  // ---- settings
  r('GET', '/api/settings', ({ uid }) => svc.settings.view(uid));
  r('PUT', '/api/settings', ({ uid, body }) => svc.settings.update(uid, body));

  // ---- accounts
  r('GET', '/api/accounts', ({ uid }) => svc.listAccounts(uid));
  r('POST', '/api/accounts', ({ uid, body }) => svc.addAccount(uid, body), { status: 201 });
  r('PATCH', '/api/accounts/:id', ({ uid, params, body }) => svc.renameAccount(uid, id(params), body.name));
  r('DELETE', '/api/accounts/:id', ({ uid, params }) => svc.deleteAccount(uid, id(params)));
  r('POST', '/api/accounts/:id/check', ({ uid, params }) => svc.checkAccount(uid, id(params)));
  r('POST', '/api/accounts/:id/test-post', ({ uid, params }) => svc.testPost(uid, id(params)));
  r('POST', '/api/connect/:connector', ({ uid, params, body }) => oauth.start(uid, params.connector, body));

  // ---- posts
  r('GET', '/api/posts', ({ uid, query }) => svc.listPosts(uid, { from: query.get('from'), to: query.get('to'), status: query.get('status'), q: query.get('q'), limit: query.get('limit') }));
  r('POST', '/api/posts', ({ uid, body }) => { const p = svc.createPost(uid, body); if (body.publishNow) kick(); return p; }, { status: 201 });
  r('POST', '/api/posts/check', ({ uid, body }) => ({ problems: svc.problems(uid, { text: body.text || '', media: body.media || [], accountIds: (body.accountIds || []).map(Number), overrides: body.overrides || {} }) }));
  r('GET', '/api/posts/:id', ({ uid, params }) => svc.getPost(uid, id(params)));
  r('PUT', '/api/posts/:id', ({ uid, params, body }) => { const p = svc.updatePost(uid, id(params), body); if (body.publishNow) kick(); return p; });
  r('DELETE', '/api/posts/:id', ({ uid, params }) => svc.deletePost(uid, id(params)));
  r('POST', '/api/posts/:id/publish', ({ uid, params }) => { const p = svc.publishNow(uid, id(params)); kick(); return p; });
  r('POST', '/api/posts/:id/duplicate', ({ uid, params }) => svc.duplicatePost(uid, id(params)), { status: 201 });
  r('POST', '/api/bulk', ({ uid, body }) => svc.bulkImport(uid, body.csv ?? ''));
  r('GET', '/api/export.json', ({ uid }) => svc.exportJson(uid), { download: 'social-poster-export.json' });
  r('GET', '/api/export.csv', ({ uid }) => svc.exportCsv(uid), { download: 'social-poster-history.csv', type: 'text/csv; charset=utf-8' });

  // ---- media
  r('GET', '/api/media', ({ uid }) => svc.media.list(uid));
  r('POST', '/api/media', ({ uid, req }) => svc.media.save(uid, req, { filename: decodeURIComponent(req.headers['x-filename'] || 'upload') }), { raw: true, status: 201 });
  r('PATCH', '/api/media/:id', ({ uid, params, body }) => svc.media.setAlt(uid, id(params), body.alt));
  r('DELETE', '/api/media/:id', ({ uid, params }) => svc.media.remove(uid, id(params)));

  // ---- queue, snippets, feeds
  r('GET', '/api/slots', ({ uid }) => ({ slots: svc.getSlots(uid), next: svc.nextSlot(uid) }));
  r('PUT', '/api/slots', ({ uid, body }) => ({ slots: svc.setSlots(uid, body.slots), next: svc.nextSlot(uid) }));
  r('GET', '/api/snippets', ({ uid }) => svc.listSnippets(uid));
  r('POST', '/api/snippets', ({ uid, body }) => svc.saveSnippet(uid, body), { status: 201 });
  r('PUT', '/api/snippets/:id', ({ uid, params, body }) => svc.saveSnippet(uid, { ...body, id: id(params) }));
  r('DELETE', '/api/snippets/:id', ({ uid, params }) => svc.deleteSnippet(uid, id(params)));
  r('GET', '/api/feeds', ({ uid }) => feeds.list(uid));
  r('POST', '/api/feeds', ({ uid, body }) => feeds.add(uid, body), { status: 201 });
  r('PUT', '/api/feeds/:id', ({ uid, params, body }) => feeds.update(uid, id(params), body));
  r('DELETE', '/api/feeds/:id', ({ uid, params }) => feeds.remove(uid, id(params)));
  r('POST', '/api/feeds/:id/check', ({ uid, params }) => feeds.checkNow(uid, id(params)));

  // ---- analytics & AI
  r('GET', '/api/analytics', ({ uid, query }) => analytics.stats(uid, { days: Math.min(365, Math.max(7, Number(query.get('days')) || 30)) }));
  r('POST', '/api/analytics/refresh', ({ uid }) => analytics.refreshMetrics({ uid, limit: 100 }));
  r('POST', '/api/ai', ({ uid, body }) => ai.assist(uid, body));

  let kicking = null;
  const kick = () => { kicking ??= svc.runDue().catch(console.error).finally(() => { kicking = null; }); };
  return { routes, kick };
}

export function createApp(ctx) {
  const { svc, auth, oauth } = ctx;
  const { routes, kick } = buildRoutes(ctx);

  const server = http.createServer(async (req, res) => {
    const headers = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'content-security-policy': CSP };
    const send = (code, body, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(code, { ...headers, 'content-type': type, 'cache-control': 'no-store', ...extra });
      res.end(body === undefined || body === null ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    const setCookie = (token, maxAge) => {
      const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;
      return { 'set-cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}` };
    };
    try {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;
      const token = cookieOf(req, 'sid');

      // ---------- API
      if (path.startsWith('/api/')) {
        // CSRF: browsers always send Origin on cross-site POSTs; reject mismatches.
        if (req.method !== 'GET' && req.headers.origin && !sameHost(req)) throw httpError(403, 'cross-site request blocked');
        const me = auth.userFromToken(token);

        if (path === '/api/auth/signup' || path === '/api/auth/login') {
          if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
          const body = await readJson(req);
          if (path === '/api/auth/signup') auth.signup(body);
          const s = auth.login(body, req.socket.remoteAddress);
          return send(200, s.user, undefined, setCookie(s.token, s.maxAge));
        }
        if (path === '/api/auth/logout') { auth.logout(token); return send(200, { ok: true }, undefined, setCookie('', 0)); }

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

      // ---------- OAuth redirect back from a network (no session cookie needed; state identifies the user)
      const cb = /^\/oauth\/callback\/(\w+)$/.exec(path);
      if (cb) {
        try {
          const r = await oauth.callback(cb[1], Object.fromEntries(url.searchParams));
          return send(302, '', 'text/plain', { location: `/#/accounts?connected=${encodeURIComponent(r.accounts.map((a) => a.name).join(', '))}` });
        } catch (e) {
          return send(302, '', 'text/plain', { location: `/#/accounts?error=${encodeURIComponent(e.message.replace(/^\d+ /, ''))}` });
        }
      }

      // ---------- uploaded media (public: Instagram/Threads fetch it from here)
      const mm = /^\/media\/([\w-]+\.\w+)$/.exec(path);
      if (mm) {
        const f = svc.media.lookup(mm[1]);
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

      // ---------- static UI
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed', 'text/plain');
      if (path === '/favicon.ico') return send(301, '', 'text/plain', { location: '/icon.svg' });
      const file = normalize(path === '/' ? '/index.html' : path);
      if (file.includes('..') || file.includes('\0')) return send(400, 'bad path', 'text/plain');
      try {
        const data = await readFile(join(PUBLIC, file));
        return send(200, data, MIME[extname(file)] || 'application/octet-stream', { 'cache-control': 'no-cache' });
      } catch { return send(404, 'not found', 'text/plain'); }
    } catch (e) {
      const status = e.status || (e instanceof SyntaxError ? 400 : 500);
      if (status >= 500 && !e.status) console.error(e);
      if (!res.headersSent) send(status, { error: e.status ? e.message : e instanceof SyntaxError ? 'bad JSON' : 'internal error', ...(e.problems && { problems: e.problems }), ...(e.needsSetup && { needsSetup: e.needsSetup }) });
      else res.destroy();
    }
  });
  server.kick = kick;
  return server;
}

async function readJson(req) {
  if (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD') return {};
  const type = req.headers['content-type'] || '';
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 5e6) throw httpError(413, 'request too large'); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return {};
  if (type.includes('text/csv')) return { csv: raw };
  if (!type.includes('application/json')) throw httpError(415, 'send JSON');
  return JSON.parse(raw);
}

/** Background jobs: publishing, RSS, metrics, token upkeep. */
export function startJobs(ctx) {
  const { db, svc, auth, feeds, analytics } = ctx;
  const every = (ms, name, fn) => {
    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      try { await fn(); } catch (e) { console.error(`${name}:`, e); } finally { busy = false; }
    };
    run();
    return setInterval(run, ms);
  };
  db.exec("UPDATE posts SET status='scheduled' WHERE status='publishing'"); // crash recovery; published accounts are never re-sent
  return [
    every(15_000, 'publish', () => svc.runDue()),
    every(60_000, 'feeds', () => feeds.runDue()),
    every(10 * 60_000, 'metrics', () => analytics.refreshMetrics()),
    every(6 * 3600_000, 'maintenance', async () => { await svc.maintain(); auth.purgeExpired(); }),
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ctx = createContext(openDb());
  startJobs(ctx);
  const port = +process.env.PORT || 3000;
  const host = process.env.HOST || '127.0.0.1';
  createApp(ctx).listen(port, host, () => console.log(`Social Poster running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
}

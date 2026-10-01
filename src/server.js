import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createService, httpError } from './service.js';
import { createAuth } from './auth.js';
import { publicProviders } from './providers/index.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const cookieOf = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];

export function createApp(svc, auth) {
  return http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json', extra = {}) => {
      res.writeHead(code, {
        'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'", ...extra,
      });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    const setCookie = (token, maxAge) => {
      const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
      return { 'set-cookie': `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}` };
    };
    try {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;

      if (path.startsWith('/api/')) {
        let body = {};
        if (req.method !== 'GET' && req.method !== 'DELETE') {
          const chunks = []; let size = 0;
          for await (const c of req) { size += c.length; if (size > 2e6) throw httpError(413, 'too large'); chunks.push(c); }
          const raw = Buffer.concat(chunks).toString();
          const type = req.headers['content-type'] || '';
          if (!type.includes('application/json') && !type.includes('text/csv')) throw httpError(415, 'unsupported content type');
          if (raw) body = type.includes('text/csv') ? { csv: raw } : JSON.parse(raw);
        }
        const token = cookieOf(req, 'sid');
        const M = req.method;
        let r;

        // ---- public auth endpoints
        if (path === '/api/auth/status') return send(200, { needsSetup: auth.userCount() === 0, user: auth.userFromToken(token) });
        if (path === '/api/auth/signup' && M === 'POST') {
          auth.signup(body);
          const s = auth.login(body, req.socket.remoteAddress);
          return send(201, s.user, 'application/json', setCookie(s.token, s.maxAge));
        }
        if (path === '/api/auth/login' && M === 'POST') {
          const s = auth.login(body, req.socket.remoteAddress);
          return send(200, s.user, 'application/json', setCookie(s.token, s.maxAge));
        }
        if (path === '/api/auth/logout' && M === 'POST') { auth.logout(token); return send(204, '', 'text/plain', setCookie('', 0)); }

        // ---- everything below needs a session
        const me = auth.userFromToken(token);
        if (!me) return send(401, { error: 'login required' });
        const uid = me.id;
        const m = (re) => re.exec(path);

        if (path === '/api/me' && M === 'PUT') { if (body.tz) auth.setTz(uid, body.tz); return send(200, { ...me, tz: body.tz || me.tz }); }
        if (path === '/api/me/password' && M === 'POST') { auth.changePassword(uid, body.current, body.next); return send(204, '', 'text/plain', setCookie('', 0)); }

        if (path === '/api/users' || m(/^\/api\/users\/\d+$/)) {
          if (!me.is_admin) throw httpError(403, 'admin only');
          if (path === '/api/users' && M === 'GET') return send(200, auth.listUsers());
          if (path === '/api/users' && M === 'POST') return send(201, auth.createUser(body));
          if (M === 'DELETE') { auth.deleteUser(+path.split('/').pop()); return send(204, '', 'text/plain'); }
        }

        if (path === '/api/providers') r = publicProviders();
        else if (path === '/api/accounts' && M === 'GET') r = svc.listAccounts(uid);
        else if (path === '/api/accounts' && M === 'POST') return send(201, svc.addAccount(uid, body));
        else if ((r = m(/^\/api\/accounts\/(\d+)$/)) && M === 'DELETE') { svc.deleteAccount(uid, +r[1]); return send(204, '', 'text/plain'); }
        else if ((r = m(/^\/api\/accounts\/(\d+)\/test$/)) && M === 'POST') r = await svc.testAccount(uid, +r[1]);
        else if (path === '/api/slots' && M === 'GET') r = { tz: me.tz, slots: svc.getSlots(uid), next: svc.nextSlot(uid) };
        else if (path === '/api/slots' && M === 'PUT') { svc.setSlots(uid, body.slots); r = { tz: me.tz, slots: svc.getSlots(uid), next: svc.nextSlot(uid) }; }
        else if (path === '/api/posts' && M === 'GET') r = svc.listPosts(uid, { from: url.searchParams.get('from'), to: url.searchParams.get('to') });
        else if (path === '/api/posts' && M === 'POST') {
          const post = svc.createPost(uid, body);
          if (body.publishNow) svc.runDue().catch(console.error);
          return send(201, post);
        }
        else if ((r = m(/^\/api\/posts\/(\d+)$/))) {
          const id = +r[1];
          if (M === 'GET') r = svc.getPost(uid, id);
          else if (M === 'PUT') r = svc.updatePost(uid, id, body);
          else if (M === 'DELETE') { svc.deletePost(uid, id); return send(204, '', 'text/plain'); }
          else return send(405, { error: 'method not allowed' });
        }
        else if ((r = m(/^\/api\/posts\/(\d+)\/publish$/)) && M === 'POST') { r = svc.publishNow(uid, +r[1]); svc.runDue().catch(console.error); }
        else if ((r = m(/^\/api\/posts\/(\d+)\/duplicate$/)) && M === 'POST') return send(201, svc.duplicatePost(uid, +r[1]));
        else if (path === '/api/bulk' && M === 'POST') r = svc.bulkImport(uid, body.csv ?? '');
        else if (path === '/api/stats') r = svc.stats(uid);
        else return send(404, { error: 'not found' });
        return send(200, r);
      }

      if (path === '/favicon.ico') return send(204, '', 'text/plain');
      const file = normalize(path === '/' ? '/index.html' : path);
      if (file.includes('..')) return send(400, 'bad path', 'text/plain');
      try { return send(200, await readFile(join(PUBLIC, file)), MIME[extname(file)] || 'application/octet-stream'); }
      catch { return send(404, 'not found', 'text/plain'); }
    } catch (e) {
      send(e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.status ? e.message : e instanceof SyntaxError ? 'bad JSON' : 'internal error' });
      if (!e.status && !(e instanceof SyntaxError)) console.error(e);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  db.exec("UPDATE posts SET status='scheduled' WHERE status='publishing'"); // crash recovery; delivered accounts are not re-sent
  const svc = createService(db);
  const auth = createAuth(db);
  const port = +process.env.PORT || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const tick = () => { svc.runDue().catch((e) => console.error('scheduler:', e)); auth.purgeExpired(); };
  setInterval(tick, 15_000);
  tick();
  createApp(svc, auth).listen(port, host, () => console.log(`socialmediaposter on http://${host}:${port} — open it to create the admin account`));
}

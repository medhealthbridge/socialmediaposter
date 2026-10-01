import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openDb } from './db.js';
import { createService } from './service.js';
import { publicProviders } from './providers/index.js';

const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export function createApp(svc, { password = process.env.APP_PASSWORD } = {}) {
  const authOk = (req) => {
    if (!password) return true;
    const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const given = Buffer.from(Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':'));
    const want = Buffer.from(password);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  return http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      if (!authOk(req)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="socialmediaposter"' });
        return res.end('Auth required');
      }
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;

      if (path.startsWith('/api/')) {
        let body = {};
        if (req.method !== 'GET' && req.method !== 'DELETE') {
          const chunks = [];
          let size = 0;
          for await (const c of req) { size += c.length; if (size > 2e6) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
          const raw = Buffer.concat(chunks).toString();
          if (raw) body = req.headers['content-type']?.includes('text/csv') ? { csv: raw } : JSON.parse(raw);
        }
        const m = (re) => re.exec(path);
        let r;
        if (path === '/api/providers') r = publicProviders();
        else if (path === '/api/accounts' && req.method === 'GET') r = svc.listAccounts();
        else if (path === '/api/accounts' && req.method === 'POST') return send(201, svc.addAccount(body));
        else if ((r = m(/^\/api\/accounts\/(\d+)$/)) && req.method === 'DELETE') { svc.deleteAccount(+r[1]); return send(204, ''); }
        else if ((r = m(/^\/api\/accounts\/(\d+)\/test$/)) && req.method === 'POST') r = await svc.testAccount(+r[1]);
        else if (path === '/api/posts' && req.method === 'GET') r = svc.listPosts({ from: url.searchParams.get('from'), to: url.searchParams.get('to') });
        else if (path === '/api/posts' && req.method === 'POST') {
          const post = svc.createPost(body);
          if (body.publishNow) svc.runDue().catch(console.error);
          return send(201, post);
        }
        else if ((r = m(/^\/api\/posts\/(\d+)$/))) {
          const id = +r[1];
          if (req.method === 'GET') r = svc.getPost(id);
          else if (req.method === 'PUT') r = svc.updatePost(id, body);
          else if (req.method === 'DELETE') { svc.deletePost(id); return send(204, ''); }
          else return send(405, { error: 'method not allowed' });
        }
        else if ((r = m(/^\/api\/posts\/(\d+)\/publish$/)) && req.method === 'POST') {
          r = svc.publishNow(+r[1]);
          svc.runDue().catch(console.error);
        }
        else if (path === '/api/bulk' && req.method === 'POST') r = svc.bulkImport(body.csv ?? '');
        else if (path === '/api/stats') r = svc.stats();
        else return send(404, { error: 'not found' });
        return send(200, r);
      }

      if (path === '/favicon.ico') return send(204, '', 'text/plain');
      const file = normalize(path === '/' ? '/index.html' : path);
      if (file.includes('..')) return send(400, 'bad path', 'text/plain');
      try {
        const data = await readFile(join(PUBLIC, file));
        return send(200, data, MIME[extname(file)] || 'application/octet-stream');
      } catch { return send(404, 'not found', 'text/plain'); }
    } catch (e) {
      send(e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.message });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  db.exec("UPDATE posts SET status='scheduled' WHERE status='publishing'"); // recover from crash; delivered accounts are not re-sent
  const svc = createService(db);
  const port = +process.env.PORT || 3000;
  const host = process.env.HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && !process.env.APP_PASSWORD) {
    console.warn('WARNING: listening on a public interface without APP_PASSWORD set. Set APP_PASSWORD!');
  }
  const tick = () => svc.runDue().catch((e) => console.error('scheduler:', e));
  setInterval(tick, 15_000);
  tick();
  createApp(svc).listen(port, host, () => console.log(`socialmediaposter on http://${host}:${port}`));
}

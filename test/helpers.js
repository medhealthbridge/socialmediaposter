import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createVault } from '../src/vault.js';
import { createContext } from '../src/server.js';

export function setup(opts = {}) {
  const db = openDb(':memory:');
  const mediaDir = mkdtempSync(join(tmpdir(), 'sp-media-'));
  const ctx = createContext(db, { vault: createVault(randomBytes(32)), mediaDir, ...opts });
  const u1 = ctx.auth.createUser({ email: 'a@x.io', password: 'password1', isAdmin: true, tz: 'UTC' }).id;
  const u2 = ctx.auth.createUser({ email: 'b@x.io', password: 'password2' }).id;
  return { ...ctx, u1, u2 };
}

/** A fake HTTP API. `routes` maps "METHOD /path" (or a function) to a response. Records every request. */
export async function fakeServer(routes) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, raw: body.toString('latin1') };
    try { call.json = JSON.parse(body.toString()); } catch { /* not json */ }
    if ((req.headers['content-type'] || '').includes('x-www-form-urlencoded')) call.form = Object.fromEntries(new URLSearchParams(body.toString()));
    calls.push(call);
    const key = `${req.method} ${url.pathname}`;
    let handler = routes[key] ?? Object.entries(routes).find(([k]) => k.includes('*') && new RegExp('^' + k.replace(/[.?+^$()[\]{}|\\]/g, '\\$&').replace(/\*/g, '[^/]+') + '$').test(key))?.[1];
    if (typeof handler === 'function') handler = await handler(call);
    if (!handler) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"no route ' + key + '"}'); }
    const { status = 200, headers = {}, body: out = {} } = handler.status || handler.body !== undefined ? handler : { body: handler };
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof out === 'string' ? out : JSON.stringify(out));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { url, calls, close: () => new Promise((r) => srv.close(r)), find: (m, p) => calls.filter((c) => c.method === m && c.path === p) };
}

export const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
export const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.alloc(100)]);
export async function* chunks(buf) { yield buf; }
export const iso = (ms) => new Date(Date.now() + ms).toISOString();

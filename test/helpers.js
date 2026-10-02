import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { createVault } from '../src/vault.js';
import { createContext } from '../src/server.js';

/**
 * A fresh database per test. SQLite in memory by default; set TEST_PG=postgres://user@host:port
 * to run the same tests against a real Postgres (a new database is created for each test).
 */
export async function freshDb() {
  if (!process.env.TEST_PG) return openDb(':memory:');
  const pg = (await import('pg')).default;
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: `${process.env.TEST_PG}/postgres` });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  return openDb(`${process.env.TEST_PG}/${name}`);
}

const opened = [];
export async function setup(opts = {}) {
  const db = await freshDb();
  opened.push(db);
  const mediaDir = mkdtempSync(join(tmpdir(), 'sp-media-'));
  const ctx = await createContext(db, { vault: createVault(randomBytes(32)), mediaDir, blobToken: '', ...opts });
  ctx.svc.retryDelayMs = 10;
  const u1 = (await ctx.auth.createUser({ email: 'a@x.io', password: 'password1', isAdmin: true, tz: 'UTC' })).id;
  const u2 = (await ctx.auth.createUser({ email: 'b@x.io', password: 'password2' })).id;
  return { ...ctx, u1, u2 };
}
const servers = [];
/** Closes every database and fake server, even when a test failed partway through. */
export const closeAll = async () => {
  for (const db of opened.splice(0)) await db.close().catch(() => {});
  for (const srv of servers.splice(0)) await srv.close().catch(() => {});
};

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
  const close = () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); });
  const fake = { url, calls, close, find: (m, p) => calls.filter((c) => c.method === m && c.path === p) };
  servers.push(fake);
  return fake;
}

export const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
export const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.alloc(100)]);
export async function* chunks(buf) { yield buf; }
export const iso = (ms) => new Date(Date.now() + ms).toISOString();

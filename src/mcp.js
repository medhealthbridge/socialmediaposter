/**
 * A small MCP (Model Context Protocol) server so an assistant can use your poster:
 * list accounts, draft to the queue, publish, and read how posts are doing.
 *
 * Transport: JSON-RPC over HTTP POST /mcp (the "streamable HTTP" transport).
 * Auth: an access key you create in Settings → Assistant access, sent as
 *   Authorization: Bearer <key>   or   /mcp?key=<key>
 */
import { createHash, randomBytes } from 'node:crypto';
import { TOOLS, createToolRunner } from './tools.js';
import { httpError } from './errors.js';

export const PROTOCOL_VERSION = '2025-06-18';
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });

/** Access keys live in the user's encrypted settings. */
export function createKeys(settings) {
  return {
    async list(uid) {
      return (await settings.get(uid, 'mcpKeys', [])).map(({ hash, ...k }) => k);
    },
    async create(uid, name) {
      const keys = await settings.get(uid, 'mcpKeys', []);
      if (keys.length >= 10) throw httpError(400, 'you already have 10 keys — remove one first');
      const secret = `sp_${randomBytes(24).toString('base64url')}`;
      const key = { id: randomBytes(6).toString('hex'), name: String(name || 'Assistant').slice(0, 60), created_at: new Date().toISOString(), hash: sha(secret) };
      await settings.set(uid, 'mcpKeys', [...keys, key]);
      return { ...key, hash: undefined, secret }; // shown once
    },
    async remove(uid, id) {
      const keys = await settings.get(uid, 'mcpKeys', []);
      const left = keys.filter((k) => k.id !== id);
      await settings.set(uid, 'mcpKeys', left);
      return { changes: keys.length - left.length };
    },
  };
}

/** Finds the user a key belongs to. */
async function userForKey(db, settings, secret) {
  if (!secret || !/^sp_[\w-]{10,}$/.test(secret)) return null;
  const want = sha(secret);
  for (const u of await db.all('SELECT id FROM users')) {
    const keys = await settings.get(u.id, 'mcpKeys', []);
    if (keys.some((k) => k.hash === want)) return u.id;
  }
  return null;
}

export function createMcp({ svc, analytics, db }) {
  const settings = svc.settings;
  const keys = createKeys(settings);
  const run = createToolRunner({ svc, analytics });  // svc is already tagged as the assistant

  async function callTool(uid, name, args = {}) {
    const out = await run(uid, name, args);
    await svc.events.add(uid, 'agent', `Assistant used ${name}`, { actor: 'assistant', detail: { args } });
    return text(out);
  }

  /** One JSON-RPC message in, one response out (or null for notifications). */
  async function handleRpc(uid, msg) {
    const { id = null, method, params = {} } = msg || {};
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    try {
      switch (method) {
        case 'initialize':
          return ok({
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'social-poster', title: 'Social Poster', version: '1.0.0' },
            instructions: 'Posts social media updates. Put posts in the queue with add_to_queue; only call publish_post when the person asks for it to go out now.',
          });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: TOOLS });
        case 'tools/call': {
          if (uid == null) throw httpError(401, 'unauthorized');
          const out = await callTool(uid, params.name, params.arguments || {});
          return ok(out);
        }
        case 'resources/list': return ok({ resources: [] });
        case 'prompts/list': return ok({ prompts: [] });
        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
      }
    } catch (e) {
      // Tool failures come back as a result with isError, so the assistant can read and retry.
      if (method === 'tools/call') return ok({ ...text(`Error: ${e.message}`), isError: true });
      return { jsonrpc: '2.0', id, error: { code: e.status === 401 ? -32001 : -32603, message: e.message } };
    }
  }

  return {
    keys,
    tools: TOOLS,
    userForKey: (secret) => userForKey(db, settings, secret),
    /** `body` is a single JSON-RPC message or a batch. Returns a response body, or null. */
    async handle(uid, body) {
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map((m) => handleRpc(uid, m)))).filter(Boolean);
        return out.length ? out : null;
      }
      return handleRpc(uid, body);
    },
  };
}

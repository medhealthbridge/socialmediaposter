/**
 * A small MCP (Model Context Protocol) server so an assistant can use your poster:
 * list accounts, draft to the queue, publish, and read how posts are doing.
 *
 * Transport: JSON-RPC over HTTP POST /mcp (the "streamable HTTP" transport).
 * Auth: an access key you create in Settings → Assistant access, sent as
 *   Authorization: Bearer <key>   or   /mcp?key=<key>
 */
import { createHash, randomBytes } from 'node:crypto';
import { providers } from './providers/index.js';
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
      await settings.set(uid, 'mcpKeys', (await settings.get(uid, 'mcpKeys', [])).filter((k) => k.id !== id));
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

const TOOLS = [
  {
    name: 'list_accounts',
    title: 'List connected social accounts',
    description: 'List the social media accounts connected to Social Poster, with their network, id and whether they are ready to post. Call this before posting so you can pass the right account ids.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'add_to_queue',
    title: 'Add a post to the queue',
    description: 'Write a post and put it in the queue. It is NOT published; the person publishes it themselves from the app, or you can call publish_post afterwards if they ask you to. Use this by default.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The post text.' },
        account_ids: { type: 'array', items: { type: 'integer' }, description: 'Accounts to post to (from list_accounts). Leave empty to save it without accounts.' },
        per_account_text: { type: 'object', description: 'Optional different text per account id, e.g. {"3": "shorter version"}.', additionalProperties: { type: 'string' } },
        notes: { type: 'string', description: 'Private note for the person, not posted anywhere.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'publish_post',
    title: 'Publish a queued post now',
    description: 'Publish a post from the queue to its networks immediately. This is public and cannot be undone from here, so only call it when the person has clearly asked for it.',
    inputSchema: { type: 'object', properties: { post_id: { type: 'integer', description: 'Id of the queued post.' } }, required: ['post_id'], additionalProperties: false },
  },
  {
    name: 'list_posts',
    title: 'List posts',
    description: 'List posts and how they did. status can be queued, published, failed or all.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['queued', 'published', 'failed', 'all'], description: 'Which posts to list (default queued).' },
        search: { type: 'string', description: 'Only posts containing this text.' },
        limit: { type: 'integer', description: 'How many to return (default 20).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'update_post',
    title: 'Edit a queued post',
    description: 'Change the text, accounts or notes of a post that has not been published yet.',
    inputSchema: {
      type: 'object',
      properties: {
        post_id: { type: 'integer' },
        text: { type: 'string' },
        account_ids: { type: 'array', items: { type: 'integer' } },
        notes: { type: 'string' },
      },
      required: ['post_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_post',
    title: 'Delete a post',
    description: 'Remove a post from Social Poster. Anything already published on a network stays there.',
    inputSchema: { type: 'object', properties: { post_id: { type: 'integer' } }, required: ['post_id'], additionalProperties: false },
  },
  {
    name: 'check_post',
    title: 'Check a post against each network',
    description: 'Check text and accounts against each network’s rules (length limits, media requirements) without saving anything. Returns a list of problems, empty when it is fine.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, account_ids: { type: 'array', items: { type: 'integer' } } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_analytics',
    title: 'Get posting analytics',
    description: 'How posts have performed: totals, per network, best times and top posts.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', description: 'Days to cover (default 30).' } }, additionalProperties: false },
  },
];

const summarisePost = (p) => ({
  id: p.id, status: p.status, text: p.text, notes: p.notes || undefined,
  media_count: p.media.length || undefined,
  accounts: p.deliveries.map((d) => ({ id: d.account_id, name: d.account_name, network: d.account_type, status: d.status, url: d.remote_url || undefined, error: d.error || undefined, metrics: d.metrics || undefined })),
});

export function createMcp({ svc, analytics, db }) {
  const settings = svc.settings;
  const keys = createKeys(settings);
  const limit = (n, d, max) => Math.min(Math.max(Number(n) || d, 1), max);

  async function callTool(uid, name, args = {}) {
    switch (name) {
      case 'list_accounts': {
        const accounts = await svc.listAccounts(uid);
        if (!accounts.length) return text('No accounts connected yet. The person needs to connect one in Social Poster → Accounts.');
        return text(accounts.map((a) => ({
          id: a.id, name: a.name, network: providers[a.type]?.label || a.type, handle: a.handle || undefined,
          character_limit: providers[a.type]?.limit,
          needs_image_or_video: providers[a.type]?.media?.required || undefined,
          ready: a.status === 'ok' && !a.needs_setup,
          problem: a.status !== 'ok' ? `needs reconnecting: ${a.last_error || a.status}` : a.needs_setup ? 'needs its post settings chosen in the app' : undefined,
        })));
      }
      case 'add_to_queue': {
        const p = await svc.createPost(uid, {
          text: args.text, accountIds: args.account_ids || [], notes: args.notes,
          overrides: Object.fromEntries(Object.entries(args.per_account_text || {}).map(([k, v]) => [Number(k), v])),
        }, { source: 'assistant' });
        const problems = await svc.problems(uid, { text: p.text, media: p.media, accountIds: p.deliveries.map((d) => d.account_id), overrides: p.overrides });
        return text({ added: summarisePost(p), problems_if_published_now: problems, next: 'The person can publish it from the app, or ask you to call publish_post.' });
      }
      case 'publish_post':
        return text({ result: summarisePost(await svc.publish(uid, Number(args.post_id))) });
      case 'list_posts': {
        const status = args.status === 'all' ? null : args.status || 'queued';
        const posts = await svc.listPosts(uid, { status, q: args.search, limit: limit(args.limit, 20, 100) });
        return text({ count: posts.length, posts: posts.map(summarisePost) });
      }
      case 'update_post':
        return text({ updated: summarisePost(await svc.updatePost(uid, Number(args.post_id), { text: args.text, accountIds: args.account_ids, notes: args.notes })) });
      case 'delete_post':
        await svc.deletePost(uid, Number(args.post_id));
        return text('Deleted.');
      case 'check_post':
        return text({ problems: await svc.problems(uid, { text: args.text || '', media: [], accountIds: (args.account_ids || []).map(Number), overrides: {} }) });
      case 'get_analytics': {
        const s = await analytics.stats(uid, { days: limit(args.days, 30, 365) });
        return text({ period_days: s.days, totals: s.kpis, per_network: s.perNetwork, best_times: s.bestTimes, top_posts: s.top.slice(0, 5) });
      }
      default:
        throw httpError(400, `unknown tool ${name}`);
    }
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

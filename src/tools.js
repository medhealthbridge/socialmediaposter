/**
 * The tools that both the MCP connector and the built-in agent can use.
 * One definition, so an assistant and the agent always behave the same way.
 */
import { providers } from './providers/index.js';
import { httpError } from './errors.js';

export const TOOLS = [
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
        scheduled_at: { type: 'string', description: 'Optional ISO date-time to publish automatically, e.g. 2026-10-09T09:00:00Z. Leave out to keep it in the queue.' },
        use_next_free_time: { type: 'boolean', description: 'Schedule it at the next free weekly posting time instead of giving a date.' },
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
        scheduled_at: { type: 'string', description: 'New ISO date-time, or null to move it back to the queue.' },
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
    name: 'get_activity_log',
    title: 'Read the activity log',
    description: 'What has happened in Social Poster recently: posts published or failed, accounts connected, timer runs, RSS items. Use this to answer "what happened" or "why did that fail".',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Only this kind: published, failed, queued, scheduled, account, cron, rss, agent.' },
        only_problems: { type: 'boolean', description: 'Only warnings and errors.' },
        limit: { type: 'integer', description: 'How many entries (default 25).' },
      },
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


const limit = (n, d, max) => Math.min(Math.max(Number(n) || d, 1), max);

/** Runs a tool for one user. `svc` should already be tagged with the right actor. */
export function createToolRunner({ svc, analytics, canPublish = true }) {
  return async function callTool(uid, name, args = {}) {
    switch (name) {
      case 'list_accounts': {
        const accounts = await svc.listAccounts(uid);
        if (!accounts.length) return 'No accounts connected yet. Connect one in Social Poster → Accounts.';
        return accounts.map((a) => ({
          id: a.id, name: a.name, network: providers[a.type]?.label || a.type, handle: a.handle || undefined,
          character_limit: providers[a.type]?.limit,
          needs_image_or_video: providers[a.type]?.media?.required || undefined,
          ready: a.status === 'ok' && !a.needs_setup,
          problem: a.status !== 'ok' ? `needs reconnecting: ${a.last_error || a.status}` : a.needs_setup ? 'needs its post settings chosen in the app' : undefined,
        }));
      }
      case 'add_to_queue': {
        const p = await svc.createPost(uid, {
          text: args.text, accountIds: args.account_ids || [], notes: args.notes,
          scheduledAt: args.scheduled_at || undefined,
          useSlot: !!args.use_next_free_time,
          overrides: Object.fromEntries(Object.entries(args.per_account_text || {}).map(([k, v]) => [Number(k), v])),
        }, { source: svc.actor === 'agent' ? 'agent' : 'assistant' });
        const problems = await svc.problems(uid, { text: p.text, media: p.media, accountIds: p.deliveries.map((d) => d.account_id), overrides: p.overrides });
        return { added: summarisePost(p), problems_if_published_now: problems };
      }
      case 'publish_post': {
        if (!canPublish) {
          return { refused: 'Publishing is switched off for the agent. Ask the person to turn on "Let the agent publish" in Settings → Agent, or to press Post in the queue.' };
        }
        return { result: summarisePost(await svc.publish(uid, Number(args.post_id))) };
      }
      case 'list_posts': {
        const status = args.status === 'all' ? null : args.status || 'queued';
        const posts = await svc.listPosts(uid, { status, q: args.search, limit: limit(args.limit, 20, 100) });
        return { count: posts.length, posts: posts.map(summarisePost) };
      }
      case 'update_post':
        return { updated: summarisePost(await svc.updatePost(uid, Number(args.post_id), { text: args.text, accountIds: args.account_ids, notes: args.notes, scheduledAt: args.scheduled_at })) };
      case 'delete_post':
        await svc.deletePost(uid, Number(args.post_id));
        return 'Deleted.';
      case 'check_post':
        return { problems: await svc.problems(uid, { text: args.text || '', media: [], accountIds: (args.account_ids || []).map(Number), overrides: {} }) };
      case 'get_analytics': {
        const s = await analytics.stats(uid, { days: limit(args.days, 30, 365) });
        return { period_days: s.days, totals: s.kpis, per_network: s.perNetwork, best_times: s.bestTimes, top_posts: s.top.slice(0, 5) };
      }
      case 'get_activity_log': {
        const rows = await svc.events.list(uid, { kind: args.kind, level: args.only_problems ? 'problem' : undefined, limit: limit(args.limit, 25, 200) });
        return { count: rows.length, events: rows.map((e) => ({ at: e.created_at, kind: e.kind, level: e.level, by: e.actor, what: e.summary })) };
      }
      default:
        throw httpError(400, `unknown tool ${name}`);
    }
  };
}

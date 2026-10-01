import Anthropic from '@anthropic-ai/sdk';
import { providers } from './providers/index.js';
import { httpError } from './errors.js';

export const AI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best quality)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (fast, cheaper)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest, cheapest)' },
];

const SYSTEM = `You are a social media copywriter helping one person write posts for their own accounts.
Write in a natural, human voice. No clichés like "Unlock", "Dive in", "game-changer". Use emoji sparingly and only when it suits the tone.
Respect every character limit you are given; links count as written. Keep any links, @mentions and facts from the original exactly.
Return exactly 3 distinct options.`;

const SCHEMA = {
  type: 'object',
  properties: { options: { type: 'array', items: { type: 'string' } } },
  required: ['options'],
  additionalProperties: false,
};

function buildPrompt({ action, text, networks, tone, instruction }) {
  const nets = networks.map((id) => providers[id]).filter(Boolean);
  const limit = nets.length ? Math.min(...nets.map((p) => p.limit)) : 500;
  const where = nets.length ? `It will be posted to: ${nets.map((p) => `${p.label} (max ${p.limit} characters)`).join(', ')}. Every option must fit in ${limit} characters.` : `Keep it under ${limit} characters.`;
  const post = text?.trim() ? `\n\nCurrent post:\n"""\n${text.trim()}\n"""` : '';
  switch (action) {
    case 'write': return `Write a social media post about: ${instruction || text}.\n${where}${post}`;
    case 'improve': return `Improve this post so it is clearer and more engaging, keeping its meaning and voice.\n${where}${post}`;
    case 'shorten': return `Shorten this post, keeping the key message.\n${where}${post}`;
    case 'hashtags': return `Add 2-5 relevant, commonly used hashtags to this post (at the end, unless they fit naturally inline). Don't change the rest.\n${where}${post}`;
    case 'tone': return `Rewrite this post in a ${tone || 'friendly'} tone.\n${where}${post}`;
    case 'thread': return `Turn this into a short hook-first version that makes people want to read more.\n${where}${post}`;
    case 'custom': return `${instruction}\n${where}${post}`;
    default: throw httpError(400, 'unknown AI action');
  }
}

export function createAI(settings) {
  return {
    models: AI_MODELS,
    async assist(uid, body) {
      const { apiKey, model = 'claude-opus-5-5' } = await settings.get(uid, 'ai', {});
      if (!apiKey) throw httpError(400, 'Add your Anthropic API key in Settings → AI assistant first');
      if (!body.text?.trim() && !body.instruction?.trim()) throw httpError(400, 'Write a few words or a topic first');
      const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
      const params = {
        model, max_tokens: 4000, system: SYSTEM,
        messages: [{ role: 'user', content: buildPrompt({ ...body, networks: body.networks || [] }) }],
        output_config: { format: { type: 'json_schema', schema: SCHEMA }, ...(!/haiku/.test(model) && { effort: 'low' }) },
      };
      let res;
      try {
        res = /^claude-(opus-5|sonnet-5-5|fable)/.test(model)
          // Server-side fallback: if the model declines, the API retries on a suitable fallback model.
          ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          : await client.messages.create(params);
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw httpError(400, 'Your Anthropic API key was rejected — check it in Settings → AI assistant');
        if (e instanceof Anthropic.RateLimitError) throw httpError(429, 'AI rate limit reached, try again in a minute');
        if (e instanceof Anthropic.APIError) throw httpError(502, `AI error: ${e.message}`);
        throw httpError(502, `AI unavailable: ${e.message}`);
      }
      if (res.stop_reason === 'refusal') throw httpError(422, 'The AI declined this request — try rephrasing it');
      const raw = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      let options;
      try { options = JSON.parse(raw).options; } catch { throw httpError(502, 'The AI returned an unexpected answer, please try again'); }
      return { options: options.filter((o) => typeof o === 'string' && o.trim()).slice(0, 5), model: res.model };
    },
  };
}

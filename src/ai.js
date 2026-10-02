/**
 * The writing assistant. Two providers, both using your own key:
 *   - Google Gemini  (has a free tier — the default)
 *   - Anthropic Claude (paid, via the official SDK)
 */
import Anthropic from '@anthropic-ai/sdk';
import { providers } from './providers/index.js';
import { request } from './providers/http.js';
import { httpError } from './errors.js';

export const endpoints = { gemini: 'https://generativelanguage.googleapis.com' };

export const AI_PROVIDERS = {
  gemini: {
    id: 'gemini', label: 'Google Gemini', note: 'Has a free tier — no card needed',
    keyField: 'geminiKey', keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'Create a free key in Google AI Studio',
    defaultModel: 'gemini-2.5-flash',
  },
  anthropic: {
    id: 'anthropic', label: 'Anthropic Claude', note: 'Paid — usually a fraction of a cent per suggestion',
    keyField: 'anthropicKey', keyUrl: 'https://console.anthropic.com/settings/keys', keyHint: 'From the Anthropic console',
    defaultModel: 'claude-opus-5-5',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best quality)' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (fast, cheaper)' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest, cheapest)' },
    ],
  },
};

const SYSTEM = `You are a social media copywriter helping one person write posts for their own accounts.
Write in a natural, human voice. No clichés like "Unlock", "Dive in", "game-changer". Use emoji sparingly and only when it suits the tone.
Respect every character limit you are given; links count as written. Keep any links, @mentions and facts from the original exactly.
Return exactly 3 distinct options.`;

const SCHEMA = { type: 'object', properties: { options: { type: 'array', items: { type: 'string' } } }, required: ['options'], additionalProperties: false };
const GEMINI_SCHEMA = { type: 'OBJECT', properties: { options: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['options'] };

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

/** Pull "options" out of a reply, coping with code fences or a bare list. */
function parseOptions(raw) {
  const body = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();
  try {
    const parsed = JSON.parse(body);
    const list = Array.isArray(parsed) ? parsed : parsed.options;
    if (Array.isArray(list)) return list.filter((o) => typeof o === 'string' && o.trim());
  } catch { /* fall through */ }
  const m = body.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const list = JSON.parse(m[0]);
      if (Array.isArray(list)) return list.filter((o) => typeof o === 'string' && o.trim());
    } catch { /* fall through */ }
  }
  return [];
}

// Google is moving from generationConfig.responseMimeType/responseSchema to responseFormat.
// Both shapes are tried, newest-known-good first, so this keeps working either way.
const SHAPES = ['responseSchema', 'responseFormat'];
let geminiShape = null;
const generationConfig = (shape) => (shape === 'responseFormat'
  ? { responseFormat: { mimeType: 'application/json', schema: GEMINI_SCHEMA }, maxOutputTokens: 8192 }
  : { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA, maxOutputTokens: 8192 });
const rejectedShape = (e) => e.status === 400 && /unknown name|invalid json payload|response_?schema|response_?mime_?type|response_?format/i.test(e.message);

async function askGemini({ apiKey, model, prompt }) {
  const send = (shape) => request(`${endpoints.gemini}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    headers: { 'x-goog-api-key': apiKey },
    json: {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: generationConfig(shape),
    },
    timeout: 90_000,
  });

  const order = geminiShape ? [geminiShape, ...SHAPES.filter((s) => s !== geminiShape)] : SHAPES;
  let data, failure;
  for (const shape of order) {
    try { ({ data } = await send(shape)); geminiShape = shape; break; }
    catch (e) {
      if (!rejectedShape(e)) throw e;
      failure = e;
    }
  }
  if (!data) throw failure;

  if (data.promptFeedback?.blockReason) throw httpError(422, `Gemini declined this request (${data.promptFeedback.blockReason}) — try rephrasing it`);
  const cand = data.candidates?.[0];
  if (!cand) throw httpError(502, 'Gemini returned nothing — try again');
  if (cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT') throw httpError(422, 'Gemini declined this request — try rephrasing it');
  const text = (cand.content?.parts || []).map((p) => p.text || '').join('');
  if (!text && cand.finishReason === 'MAX_TOKENS') throw httpError(502, 'Gemini ran out of room before answering — try a shorter post');
  return { text, model: data.modelVersion || model };
}

async function askClaude({ apiKey, model, prompt }) {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  const params = {
    model, max_tokens: 4000, system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA }, ...(!/haiku/.test(model) && { effort: 'low' }) },
  };
  const res = /^claude-(opus-5|sonnet-5-5|fable)/.test(model)
    // Server-side fallback: if the model declines, the API retries on a suitable fallback model.
    ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await client.messages.create(params);
  if (res.stop_reason === 'refusal') throw httpError(422, 'Claude declined this request — try rephrasing it');
  return { text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''), model: res.model };
}

export function createAI(settings) {
  const conf = async (uid) => {
    const ai = await settings.get(uid, 'ai', {});
    const provider = AI_PROVIDERS[ai.provider] ? ai.provider : 'gemini';
    const spec = AI_PROVIDERS[provider];
    return { provider, spec, model: ai.model || spec.defaultModel, apiKey: ai[spec.keyField] };
  };

  return {
    providers: AI_PROVIDERS,

    /** Models this key can use. Gemini is asked directly, so the list is always current. */
    async models(uid) {
      const { provider, spec, apiKey } = await conf(uid);
      if (!apiKey) throw httpError(400, `Add your ${spec.label} API key first`);
      if (provider !== 'gemini') return spec.models;
      const { data } = await request(`${endpoints.gemini}/v1beta/models`, { headers: { 'x-goog-api-key': apiKey }, query: { pageSize: 200 }, timeout: 30_000 });
      const models = (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && !/embedding|aqa|imagen|veo|tts|image|native-audio/i.test(m.name))
        .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name.replace(/^models\//, '') }));
      // Flash models are the ones on the free tier, so show them first.
      models.sort((a, b) => (/flash/i.test(b.id) - /flash/i.test(a.id)) || a.id.localeCompare(b.id));
      if (!models.length) throw httpError(502, 'Google returned no usable models for this key');
      return models;
    },

    async assist(uid, body) {
      const { provider, spec, model, apiKey } = await conf(uid);
      if (!apiKey) throw httpError(400, `Add your ${spec.label} API key in Settings → AI assistant first`);
      if (!body.text?.trim() && !body.instruction?.trim()) throw httpError(400, 'Write a few words or a topic first');
      const prompt = buildPrompt({ ...body, networks: body.networks || [] });

      let out;
      try {
        out = provider === 'gemini' ? await askGemini({ apiKey, model, prompt }) : await askClaude({ apiKey, model, prompt });
      } catch (e) {
        if (e.status === 401 || e.status === 403 || /api key not valid|invalid x-goog-api-key|authentication/i.test(e.message)) {
          throw httpError(400, `Your ${spec.label} API key was rejected — check it in Settings → AI assistant`);
        }
        if (e.status === 429 || /quota|rate limit|RESOURCE_EXHAUSTED/i.test(e.message)) {
          throw httpError(429, provider === 'gemini' ? 'Gemini’s free limit is reached for now — wait a minute and try again' : 'AI rate limit reached, try again in a minute');
        }
        if (e.status === 404 && provider === 'gemini') throw httpError(400, `Gemini has no model called “${model}” — pick another in Settings → AI assistant`);
        if (e.status) throw e;
        throw httpError(502, `AI error: ${e.message}`);
      }

      const options = parseOptions(out.text);
      if (!options.length) throw httpError(502, 'The AI returned an unexpected answer, please try again');
      return { options: options.slice(0, 5), model: out.model, provider };
    },
  };
}

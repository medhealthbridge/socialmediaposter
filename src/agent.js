/**
 * The built-in agent: you type what you want in plain words, it uses the app's own tools
 * to do it. Runs on your own API key (Gemini or Claude) and writes everything it does
 * to the activity log.
 */
import Anthropic from '@anthropic-ai/sdk';
import { request } from './providers/http.js';
import { TOOLS, createToolRunner } from './tools.js';
import { AI_PROVIDERS, endpoints } from './ai.js';
import { httpError } from './errors.js';

const MAX_STEPS = 8;            // tool calls allowed in one turn
const MAX_HISTORY = 24;         // messages of context kept

const SYSTEM = `You are the assistant built into Social Poster, a tool one person uses to post to their own social media accounts.

How to behave:
- Use the tools to actually do things. Don't claim you did something unless a tool confirmed it.
- Call list_accounts before writing posts, so you use real account ids and respect each network's limits.
- Add posts to the queue by default. Only publish when the person clearly asks you to publish, post, or send now.
- Write posts in a natural human voice. No clichés like "Unlock" or "Dive in". Use emoji sparingly.
- Keep each post within the character limit of every account it goes to; shorten per account with per_account_text when limits differ.
- When something fails, read the error, say plainly what went wrong, and suggest the fix.
- Be brief. Say what you did in a sentence or two, not a report.`;

/** Gemini's schema dialect: uppercase types, no additionalProperties. */
function toGeminiSchema(node) {
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'additionalProperties') continue;
    if (k === 'type') out.type = String(v).toUpperCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === 'items') out.items = toGeminiSchema(v);
    else out[k] = v;
  }
  return out;
}
const geminiTools = () => [{
  functionDeclarations: TOOLS.map((t) => {
    const params = toGeminiSchema(t.inputSchema);
    // Gemini rejects an empty parameter object, so leave it out entirely.
    return { name: t.name, description: t.description, ...(Object.keys(params.properties || {}).length ? { parameters: params } : {}) };
  }),
}];
const claudeTools = () => TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

export function createAgent({ serviceAs, analytics, settings }) {
  const svc = serviceAs('agent');
  const conf = async (uid) => {
    const ai = await settings.get(uid, 'ai', {});
    const provider = AI_PROVIDERS[ai.provider] ? ai.provider : 'gemini';
    const spec = AI_PROVIDERS[provider];
    return { provider, spec, model: ai.model || spec.defaultModel, apiKey: ai[spec.keyField] };
  };

  /** One exchange: the person's message in, the agent's reply plus what it did out. */
  async function chat(uid, { message, history = [] }) {
    if (!String(message || '').trim()) throw httpError(400, 'Type what you would like me to do');
    const { provider, spec, model, apiKey } = await conf(uid);
    if (!apiKey) throw httpError(400, `Add your ${spec.label} API key in Settings → AI assistant first`);

    const canPublish = !!(await settings.get(uid, 'agentCanPublish'));
    const run = createToolRunner({ svc, analytics, canPublish });
    const used = [];

    const callTool = async (name, args) => {
      let result;
      try {
        result = await run(uid, name, args || {});
        used.push({ name, args, ok: true });
        await svc.events.add(uid, 'agent', `Agent used ${name}`, { actor: 'agent', detail: { args } });
      } catch (e) {
        result = { error: e.message };
        used.push({ name, args, ok: false, error: e.message });
        await svc.events.add(uid, 'agent', `Agent tried ${name} and it failed: ${e.message}`, { actor: 'agent', level: 'warn', detail: { args } });
      }
      return result;
    };

    const trimmed = history.slice(-MAX_HISTORY).filter((m) => m && typeof m.text === 'string' && ['you', 'agent'].includes(m.role));
    const reply = provider === 'gemini'
      ? await runGemini({ apiKey, model, message, history: trimmed, callTool })
      : await runClaude({ apiKey, model, message, history: trimmed, callTool });

    await svc.events.add(uid, 'agent', `You asked: ${String(message).slice(0, 160)}`, { actor: 'agent', detail: { reply: reply.slice(0, 500), tools: used.map((u) => u.name) } });
    return { reply, used, canPublish, provider, model };
  }

  return { chat, tools: TOOLS.map((t) => ({ name: t.name, title: t.title })) };
}

// ---------------------------------------------------------------- Gemini
async function runGemini({ apiKey, model, message, history, callTool }) {
  const contents = [
    ...history.map((m) => ({ role: m.role === 'you' ? 'user' : 'model', parts: [{ text: m.text }] })),
    { role: 'user', parts: [{ text: message }] },
  ];
  for (let step = 0; step < MAX_STEPS; step++) {
    const { data } = await request(`${endpoints.gemini}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      headers: { 'x-goog-api-key': apiKey },
      json: { systemInstruction: { parts: [{ text: SYSTEM }] }, contents, tools: geminiTools(), generationConfig: { maxOutputTokens: 4096 } },
      timeout: 120_000,
    });
    if (data.promptFeedback?.blockReason) throw httpError(422, 'Gemini declined that request — try rephrasing it');
    const parts = data.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    const said = parts.map((p) => p.text || '').join('').trim();
    if (!calls.length) return said || 'Done.';
    contents.push({ role: 'model', parts });
    const responses = [];
    for (const c of calls) {
      const result = await callTool(c.name, c.args);
      responses.push({ functionResponse: { name: c.name, response: { result } } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return 'I stopped after several steps to avoid going in circles. Tell me what to do next.';
}

// ---------------------------------------------------------------- Claude
async function runClaude({ apiKey, model, message, history, callTool }) {
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  const messages = [
    ...history.map((m) => ({ role: m.role === 'you' ? 'user' : 'assistant', content: m.text })),
    { role: 'user', content: message },
  ];
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.messages.create({ model, max_tokens: 4000, system: SYSTEM, tools: claudeTools(), messages });
    if (res.stop_reason === 'refusal') throw httpError(422, 'Claude declined that request — try rephrasing it');
    const calls = res.content.filter((b) => b.type === 'tool_use');
    const said = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!calls.length) return said || 'Done.';
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const c of calls) {
      const result = await callTool(c.name, c.input);
      results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: results });
  }
  return 'I stopped after several steps to avoid going in circles. Tell me what to do next.';
}

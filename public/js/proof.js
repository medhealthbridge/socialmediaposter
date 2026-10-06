/**
 * The grammar check: spelling, grammar and typos only.
 *
 * It never rewrites your voice and never changes anything on its own — every fix is shown
 * first, and the corrected text is only used if you say so.
 */
import { $, api, esc, icon, modal, toast, go } from './core.js';

/** Ask the AI to proofread. Returns null if there is no API key yet (and offers to set one up). */
export async function checkGrammar(text) {
  if (!text.trim()) { toast('Write something first'); return null; }
  try {
    return await api('/ai/grammar', { method: 'POST', body: { text } });
  } catch (e) {
    if (!/API key/.test(e.message)) throw e;
    modal({
      title: 'Set up the AI assistant',
      body: `<p class="text-2">The grammar check uses the same AI key as the writing assistant. Google Gemini has a free tier — no card needed.</p>`,
      actions: [{ label: 'Later' }, { label: 'Open settings', kind: 'primary', onClick: () => go('#/settings?s=ai') }],
    });
    return null;
  }
}

/**
 * Show what the proofreader would change. Resolves with the text to use, or null to keep
 * the original. Clean text resolves to null straight away, with a quiet confirmation.
 */
export function showProof(res) {
  if (!res) return Promise.resolve(null);
  if (!res.changed) { toast('No spelling or grammar problems found', 'ok'); return Promise.resolve(null); }
  return new Promise((resolve) => {
    let accepted = null;
    const m = modal({
      title: `${icon('check')} Suggested fixes`, wide: true,
      body: `${res.changes.length ? `<div class="diffs">${res.changes.map((c) => `<div class="d"><div><del>${esc(c.before)}</del> → <ins>${esc(c.after)}</ins></div>${c.why ? `<div class="why">${esc(c.why)}</div>` : ''}</div>`).join('')}</div>` : ''}
        <label class="field">Corrected text<textarea id="fixed" rows="7">${esc(res.corrected)}</textarea></label>
        <p class="hint">Edit it here if you like — nothing changes until you accept.</p>`,
      actions: [
        { label: 'Keep mine' },
        { label: `${icon('check')} Use the corrected text`, kind: 'primary', onClick: (d) => { accepted = $('#fixed', d).value; } },
      ],
    });
    m.el.addEventListener('close', () => resolve(accepted));
  });
}

/** Proofread some text and hand back what to use. */
export async function proofread(text) {
  const res = await checkGrammar(text);
  return showProof(res);
}

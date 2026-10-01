export class ProviderError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const b64 = (s) => Buffer.from(s).toString('base64');

/**
 * Small fetch wrapper. Options: method, headers, json, form (object -> urlencoded, FormData -> multipart),
 * body (raw), query, timeout. Throws ProviderError("<status> <message>") on non-2xx.
 */
export async function request(url, { method, headers = {}, json, form, body, query, timeout = 120_000 } = {}) {
  if (query) url += (url.includes('?') ? '&' : '?') + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null));
  const h = { ...headers };
  let b = body;
  if (json !== undefined) { b = JSON.stringify(json); h['content-type'] = 'application/json'; }
  else if (form instanceof FormData) b = form;
  else if (form) b = new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]));
  let res;
  try {
    res = await fetch(url, { method: method || (b === undefined ? 'GET' : 'POST'), headers: h, body: b, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    throw new ProviderError(`network error: ${e.cause?.code || e.message}`, 0);
  }
  const raw = await res.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!res.ok) {
    const e = data.error;
    const msg = data.error_description || e?.error_user_msg || e?.message || (typeof e === 'string' ? e : null)
      || data.detail || data.message || data.description || data.title || data.errors?.[0]?.message || raw.slice(0, 300) || res.statusText;
    throw new ProviderError(`${res.status} ${msg}`, res.status);
  }
  return { data, headers: res.headers, status: res.status };
}

/** Poll fn() until it returns truthy (or throws). */
export async function waitFor(fn, { tries = 60, every = 3000, what = 'media processing' } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await fn();
    if (r) return r;
    await sleep(every);
  }
  throw new ProviderError(`timed out waiting for ${what}`, 504);
}

/**
 * The intake webhook: one address anything can POST a finished video or picture to.
 *
 * Built for generators that tell you when they are done — Higgsfield, Eromify, Make,
 * Zapier, n8n — so a clip that finishes at three in the morning is queued without you.
 * The address carries its own key, so it needs no login, and it only ever reaches the
 * one account that key belongs to.
 *
 *   POST /api/intake?key=hk_…
 *   { "text": "…", "url": "https://…/clip.mp4", "group": "Animals", "publish": false }
 *
 * `url` may also be `media` (a list). `group` or `accounts` choose where it goes; with
 * neither, it waits in the queue for you to pick.
 */
import { httpError } from './errors.js';

const MAX_TEXT = 20_000;

export function createIntake({ svc, events, ai }) {
  return {
    /** Handle one delivery. Returns what was made, or explains what was wrong with it. */
    async receive(uid, body = {}) {
      const text = String(body.text ?? body.caption ?? body.description ?? '').slice(0, MAX_TEXT);
      const urls = [body.url, body.video, body.image, ...(Array.isArray(body.media) ? body.media : [])]
        .flatMap((u) => (typeof u === 'string' ? [u] : u && typeof u.url === 'string' ? [u.url] : []))
        .filter(Boolean)
        .slice(0, 10);
      if (!text.trim() && !urls.length) throw httpError(400, 'send at least "text" or "url"');

      // Pull each file in and keep it, so nothing depends on the sender's link staying alive.
      const media = [];
      for (const url of urls) {
        let parsed;
        try { parsed = new URL(url); } catch { throw httpError(400, `"${String(url).slice(0, 80)}" is not a URL`); }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw httpError(400, 'media URLs must be http or https');
        const res = await fetch(parsed, { signal: AbortSignal.timeout(300_000) }).catch((e) => {
          throw httpError(502, `could not fetch ${parsed.hostname}: ${e.cause?.code || e.message}`);
        });
        if (!res.ok || !res.body) throw httpError(502, `${parsed.hostname} answered ${res.status}`);
        media.push(await svc.media.fromStream(uid, res.body, {
          filename: decodeURIComponent(parsed.pathname.split('/').pop() || 'incoming'),
          size: Number(res.headers.get('content-length')) || 0,
        }));
      }

      // Where it goes: an explicit list of accounts, or everything in a group, or nowhere yet.
      const all = await svc.listAccounts(uid);
      let accountIds = [];
      if (Array.isArray(body.accounts) && body.accounts.length) {
        const want = body.accounts.map((x) => String(x).toLowerCase());
        accountIds = all.filter((a) => want.includes(String(a.id)) || want.includes(a.name.toLowerCase())).map((a) => a.id);
        if (!accountIds.length) throw httpError(400, 'none of those accounts exist');
      } else if (body.group) {
        const g = String(body.group).toLowerCase();
        accountIds = all.filter((a) => a.groups.some((x) => x.toLowerCase() === g)).map((a) => a.id);
        if (!accountIds.length) throw httpError(400, `no accounts are in the group "${body.group}"`);
      }

      let caption = text;
      // Proofreading is opt-in and must never stop something arriving.
      if (caption.trim() && body.proofread) {
        try { caption = (await ai.grammar(uid, caption)).corrected; }
        catch (e) { await events.add(uid, 'ai', `Could not proofread an incoming post: ${e.message}`, { level: 'warn', actor: 'timer' }); }
      }

      const post = await svc.createPost(uid, {
        text: caption,
        media: media.map((m) => m.id),
        accountIds,
        publishNow: !!body.publish && accountIds.length > 0,
        allowRisky: !!body.allowRisky,
      }, { source: 'intake' });

      await events.add(uid, 'queued', `Received “${(caption || media[0]?.filename || 'a post').slice(0, 60)}” from ${body.from || 'the intake address'}`,
        { actor: 'timer', postId: post.id, detail: { media: media.length, accounts: accountIds.length, published: !!body.publish } });
      return { id: post.id, status: post.status, media: media.length, accounts: accountIds.length };
    },
  };
}

import { request } from './providers/http.js';
import { httpError } from './errors.js';

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/<[^>]+>/g, '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? m[1] : ''; };

/** Minimal RSS 2.0 / Atom parser — enough for blogs, YouTube channels, podcasts, news sites. */
export function parseFeed(xml) {
  const blocks = String(xml).match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  const items = blocks.map((b) => {
    let link = decode(tag(b, 'link'));
    if (!link) {
      const links = [...b.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
      const pick = links.find((a) => /rel=["']alternate["']/.test(a)) || links.find((a) => !/rel=/.test(a)) || links[0] || '';
      link = (pick.match(/href=["']([^"']+)["']/) || [])[1] || '';
    }
    link = link.replace(/&amp;/g, '&');
    const id = decode(tag(b, 'guid')) || decode(tag(b, 'id')) || link;
    return { id, title: decode(tag(b, 'title')), link, summary: decode(tag(b, 'description') || tag(b, 'summary')).slice(0, 300) };
  }).filter((i) => i.id);
  const head = String(xml).replace(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, '');
  return { title: decode(tag(head, 'title')), items };
}

export function createFeeds(svc) {
  const db = svc.db;
  const view = (f) => ({ ...f, account_ids: JSON.parse(f.account_ids), seen: undefined, enabled: !!f.enabled });
  const UA = { 'user-agent': 'SocialPoster/1.0 (+RSS)', accept: 'application/rss+xml, application/atom+xml, text/xml, */*' };

  const feeds = {
    list: async (uid) => (await db.all('SELECT * FROM feeds WHERE user_id=? ORDER BY id', uid)).map(view),
    async get(uid, id) {
      const f = await db.get('SELECT * FROM feeds WHERE id=? AND user_id=?', id, uid);
      if (!f) throw httpError(404, 'feed not found');
      return f;
    },
    async clean(uid, b) {
      const accountIds = [...new Set((b.accountIds || []).map(Number))];
      for (const a of accountIds) if (!(await db.get('SELECT 1 FROM accounts WHERE id=? AND user_id=?', a, uid))) throw httpError(400, 'unknown account');
      const mode = b.mode === 'now' ? 'now' : 'queue';
      if (mode === 'now' && !accountIds.length) throw httpError(400, 'pick the accounts to post to');
      return { accountIds, mode, template: String(b.template || '{title}\n{link}').slice(0, 2000), interval: Math.min(1440, Math.max(10, Number(b.intervalMin) || 60)) };
    },
    async add(uid, b) {
      let url;
      try { url = new URL(String(b.url).trim()); if (!/^https?:$/.test(url.protocol)) throw 0; } catch { throw httpError(400, 'enter a valid feed URL'); }
      const c = await feeds.clean(uid, b);
      let parsed;
      try { parsed = parseFeed((await request(url.href, { headers: UA, timeout: 20_000 })).data.raw); }
      catch (e) { throw httpError(400, `could not read that feed: ${e.message}`); }
      if (!parsed.items.length && !parsed.title) throw httpError(400, 'that URL is not an RSS or Atom feed');
      // Existing items are marked as seen, so only future items are posted.
      const id = await db.insert('INSERT INTO feeds(user_id,url,title,account_ids,mode,template,interval_min,seen,last_checked) VALUES (?,?,?,?,?,?,?,?,?)',
        uid, url.href, parsed.title || url.host, JSON.stringify(c.accountIds), c.mode, c.template, c.interval, JSON.stringify(parsed.items.map((i) => i.id).slice(0, 500)), new Date().toISOString());
      return view(await feeds.get(uid, id));
    },
    async update(uid, id, b) {
      const f = await feeds.get(uid, id);
      const c = await feeds.clean(uid, { accountIds: JSON.parse(f.account_ids), mode: f.mode, template: f.template, intervalMin: f.interval_min, ...b });
      await db.run('UPDATE feeds SET account_ids=?, mode=?, template=?, interval_min=?, enabled=? WHERE id=?',
        JSON.stringify(c.accountIds), c.mode, c.template, c.interval, b.enabled === undefined ? f.enabled : b.enabled ? 1 : 0, id);
      return view(await feeds.get(uid, id));
    },
    remove: (uid, id) => db.run('DELETE FROM feeds WHERE id=? AND user_id=?', id, uid),

    /** Fetch one feed; new items go to the queue (or are published right away in "now" mode). */
    async poll(f) {
      try {
        const { data } = await request(f.url, { headers: UA, timeout: 20_000 });
        const { items } = parseFeed(data.raw);
        const seen = new Set(JSON.parse(f.seen));
        const fresh = items.filter((i) => !seen.has(i.id)).slice(0, 5).reverse();
        // Mark as seen first so two overlapping checks never create duplicates.
        await db.run('UPDATE feeds SET seen=?, last_checked=?, last_error=NULL WHERE id=?',
          JSON.stringify([...new Set([...items.map((i) => i.id), ...seen])].slice(0, 500)), new Date().toISOString(), f.id);
        let created = 0;
        for (const it of fresh) {
          const text = f.template.replaceAll('{title}', it.title).replaceAll('{link}', it.link).replaceAll('{summary}', it.summary).trim();
          const accountIds = JSON.parse(f.account_ids);
          try { await svc.createPost(f.user_id, { text, accountIds, publishNow: f.mode === 'now' }, { source: 'rss' }); }
          catch (e) { await svc.createPost(f.user_id, { text, accountIds, notes: `From RSS — could not post automatically: ${e.message}` }, { source: 'rss' }); }
          created++;
        }
        return created;
      } catch (e) {
        await db.run('UPDATE feeds SET last_checked=?, last_error=? WHERE id=?', new Date().toISOString(), String(e.message).slice(0, 300), f.id);
        return 0;
      }
    },
    checkNow: async (uid, id) => ({ created: await feeds.poll(await feeds.get(uid, id)) }),
    /** Check this user's feeds that are due. The app calls this when you open it — no background timer needed. */
    async checkDue(uid, now = new Date()) {
      const due = (await db.all('SELECT * FROM feeds WHERE user_id=? AND enabled=1', uid))
        .filter((f) => !f.last_checked || new Date(f.last_checked).getTime() + f.interval_min * 60e3 <= now.getTime());
      let created = 0;
      for (const f of due) created += await feeds.poll(f);
      return { checked: due.length, created };
    },
  };
  return feeds;
}

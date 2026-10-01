import { providers } from './providers/index.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const score = (m) => (m ? (m.likes || 0) + 2 * (m.reposts || 0) + 3 * (m.replies || 0) : 0);
// Broad industry averages, used until you have enough of your own data.
const TYPICAL = [{ dow: 2, hour: 9 }, { dow: 3, hour: 12 }, { dow: 4, hour: 17 }];

function localParts(iso, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { dow: DAYS.indexOf(p.weekday), hour: Number(p.hour) % 24, day: `${p.year}-${p.month}-${p.day}` };
}

export function createAnalytics(svc) {
  const q = (s) => svc.db.prepare(s);
  return {
    /** Pull likes/reposts/replies for recent posts. Runs in the background; failures are ignored. */
    async refreshMetrics({ now = new Date(), limit = 25, uid = null } = {}) {
      const since = new Date(now.getTime() - 30 * 864e5).toISOString();
      const stale = new Date(now.getTime() - 3 * 3600e3).toISOString();
      const rows = q(`SELECT d.id AS delivery_id, d.remote_id, d.account_id FROM deliveries d JOIN accounts a ON a.id=d.account_id
                      WHERE d.status='published' AND d.remote_id IS NOT NULL AND d.published_at >= ?
                      AND (d.metrics_at IS NULL OR d.metrics_at < ?) ${uid ? 'AND a.user_id = ?' : ''}
                      ORDER BY d.metrics_at IS NOT NULL, d.metrics_at LIMIT ?`).all(...[since, stale, ...(uid ? [uid] : []), limit]);
      let ok = 0;
      for (const r of rows) {
        const { delivery_id: deliveryId, remote_id: remoteId } = r;
        const acc = q('SELECT * FROM accounts WHERE id=?').get(r.account_id);
        const prov = providers[acc.type];
        let m = null;
        if (prov?.metrics) {
          try { m = await prov.metrics({ ...svc.providerCtx(acc), remoteId }); ok++; } catch { /* e.g. paid API tier needed */ }
        }
        q('UPDATE deliveries SET metrics=COALESCE(?, metrics), metrics_at=? WHERE id=?').run(m ? JSON.stringify(m) : null, now.toISOString(), deliveryId);
      }
      return { checked: rows.length, updated: ok };
    },

    stats(uid, { days = 30, now = new Date() } = {}) {
      const tz = svc.tzOf(uid);
      const since = new Date(now.getTime() - days * 864e5).toISOString();
      const rows = q(`SELECT d.*, a.name AS account_name, a.type, p.text, p.id AS post_id FROM deliveries d
                      JOIN accounts a ON a.id=d.account_id JOIN posts p ON p.id=d.post_id
                      WHERE a.user_id=? AND d.published_at >= ? AND d.status='published'`).all(uid, since)
        .map((r) => ({ ...r, metrics: r.metrics ? JSON.parse(r.metrics) : null }));
      const failed = q(`SELECT COUNT(*) AS n FROM deliveries d JOIN accounts a ON a.id=d.account_id JOIN posts p ON p.id=d.post_id
                        WHERE a.user_id=? AND d.status='failed' AND COALESCE(p.scheduled_at,p.created_at) >= ?`).get(uid, since).n;
      const scheduled = q("SELECT COUNT(*) AS n FROM posts WHERE user_id=? AND status='scheduled'").get(uid).n;
      const withM = rows.filter((r) => r.metrics);
      const eng = withM.reduce((s, r) => s + score(r.metrics), 0);

      const perDay = new Map();
      for (let i = days - 1; i >= 0; i--) perDay.set(localParts(new Date(now.getTime() - i * 864e5).toISOString(), tz).day, 0);
      for (const r of rows) { const d = localParts(r.published_at, tz).day; if (perDay.has(d)) perDay.set(d, perDay.get(d) + 1); }

      const net = {};
      for (const r of rows) {
        const n = (net[r.type] ||= { type: r.type, label: providers[r.type]?.label || r.type, posts: 0, measured: 0, likes: 0, reposts: 0, replies: 0, views: 0, engagement: 0 });
        n.posts++;
        if (r.metrics) { n.measured++; for (const k of ['likes', 'reposts', 'replies', 'views']) n[k] += r.metrics[k] || 0; n.engagement += score(r.metrics); }
      }

      const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ posts: 0, score: 0 })));
      for (const r of withM) { const { dow, hour } = localParts(r.published_at, tz); heat[dow][hour].posts++; heat[dow][hour].score += score(r.metrics); }
      const cells = heat.flatMap((row, dow) => row.map((c, hour) => ({ dow, hour, posts: c.posts, avg: c.posts ? c.score / c.posts : 0 })));
      const mine = withM.length >= 8 ? cells.filter((c) => c.posts).sort((a, b) => b.avg - a.avg).slice(0, 3) : [];

      return {
        tz, days,
        kpis: { published: rows.length, failed, scheduled, engagement: eng, avgEngagement: withM.length ? eng / withM.length : null, successRate: rows.length + failed ? rows.length / (rows.length + failed) : null },
        perDay: [...perDay].map(([day, n]) => ({ day, n })),
        perNetwork: Object.values(net).sort((a, b) => b.posts - a.posts),
        top: withM.sort((a, b) => score(b.metrics) - score(a.metrics)).slice(0, 10)
          .map((r) => ({ post_id: r.post_id, text: (r.text_override || r.text).slice(0, 200), account: r.account_name, type: r.type, url: r.remote_url, published_at: r.published_at, metrics: r.metrics, score: score(r.metrics) })),
        heatmap: cells,
        bestTimes: mine.length ? { source: 'yours', times: mine } : { source: 'typical', times: TYPICAL },
      };
    },
  };
}

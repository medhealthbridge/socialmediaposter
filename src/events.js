/**
 * The activity log: a plain record of everything the app did, so you can always
 * answer "what happened?" — especially for things that ran without you watching
 * (the timer, RSS, the assistant and the built-in agent).
 */
const KEEP = 2000; // rows per user; older ones are trimmed away

export const KINDS = {
  published: { label: 'Published', icon: 'send' },
  failed: { label: 'Failed', icon: 'alert' },
  queued: { label: 'Added', icon: 'plus' },
  scheduled: { label: 'Scheduled', icon: 'clock' },
  updated: { label: 'Edited', icon: 'edit' },
  deleted: { label: 'Deleted', icon: 'trash' },
  account: { label: 'Account', icon: 'users' },
  cron: { label: 'Timer', icon: 'retry' },
  rss: { label: 'RSS', icon: 'rss' },
  ai: { label: 'AI', icon: 'sparkle' },
  agent: { label: 'Agent', icon: 'sparkle' },
  settings: { label: 'Settings', icon: 'settings' },
  auth: { label: 'Sign in', icon: 'key' },
};

export function createEvents(db) {
  let trimCounter = 0;

  const events = {
    /** Never throws: logging must not be able to break the thing it is logging. */
    async add(uid, kind, summary, { level = 'info', detail = null, actor = 'you', postId = null, accountId = null } = {}) {
      if (!uid) return;
      try {
        await db.run('INSERT INTO events(user_id,kind,level,summary,detail,actor,post_id,account_id) VALUES (?,?,?,?,?,?,?,?)',
          uid, kind, level, String(summary).slice(0, 500), detail ? JSON.stringify(detail).slice(0, 4000) : null, actor, postId, accountId);
        if (++trimCounter % 50 === 0) {
          await db.run('DELETE FROM events WHERE user_id=? AND id <= (SELECT MAX(id) - ? FROM events WHERE user_id=?)', uid, KEEP, uid);
        }
      } catch (e) {
        console.error('could not write to the activity log:', e.message);
      }
    },

    async list(uid, { kind, level, limit = 100, before } = {}) {
      let sql = 'SELECT * FROM events WHERE user_id=?';
      const args = [uid];
      if (kind && KINDS[kind]) { sql += ' AND kind=?'; args.push(kind); }
      if (level === 'problem') sql += " AND level IN ('error','warn')";
      if (before) { sql += ' AND id < ?'; args.push(Number(before)); }
      sql += ' ORDER BY id DESC LIMIT ?';
      args.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
      return (await db.all(sql, ...args)).map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null }));
    },

    clear: (uid) => db.run('DELETE FROM events WHERE user_id=?', uid),
  };
  return events;
}

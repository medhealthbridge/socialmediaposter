// Weekly queue slots in the user's timezone -> next free UTC instant. No dependencies (uses Intl).
function parts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return Object.fromEntries(f.formatToParts(date).map((x) => [x.type, +x.value]));
}
const offsetMs = (date, tz) => {
  const p = parts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
};
export function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}
export const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

/** slots: [{dow,time:'HH:MM'}]; taken: Set of ISO strings already used. */
export function nextFreeSlot(slots, tz, taken = new Set(), from = new Date()) {
  const seen = new Set();
  for (let i = 0; i <= 62; i++) {
    const p = parts(new Date(from.getTime() + i * 864e5), tz);
    const key = `${p.year}-${p.month}-${p.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    const cands = slots.filter((s) => s.dow === dow).map((s) => {
      const [h, mi] = s.time.split(':').map(Number);
      return zonedToUtc(p.year, p.month, p.day, h, mi, tz);
    }).filter((d) => d > from && !taken.has(d.toISOString())).sort((a, b) => a - b);
    if (cands.length) return cands[0];
  }
  return null;
}

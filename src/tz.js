export const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

const parts = (date, tz) => Object.fromEntries(
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).map((x) => [x.type, +x.value]));

/** The instant when a wall-clock time happens in `tz`. Correct across daylight-saving changes. */
export function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offset = (t) => { const p = parts(new Date(t), tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000; };
  let t = guess - offset(guess);
  return new Date(guess - offset(t));
}

/**
 * The next weekly slot that is free, in the user's timezone.
 * slots: [{dow, time:'HH:MM'}] with dow 0 = Sunday. `taken` holds ISO strings already used.
 */
export function nextFreeSlot(slots, tz, taken = new Set(), from = new Date()) {
  if (!slots.length) return null;
  const seen = new Set();
  for (let i = 0; i <= 62; i++) {
    const p = parts(new Date(from.getTime() + i * 864e5), tz);
    const key = `${p.year}-${p.month}-${p.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    const candidates = slots.filter((s) => s.dow === dow)
      .map((s) => { const [h, mi] = s.time.split(':').map(Number); return zonedToUtc(p.year, p.month, p.day, h, mi, tz); })
      .filter((d) => d > from && !taken.has(d.toISOString()))
      .sort((a, b) => a - b);
    if (candidates.length) return candidates[0];
  }
  return null;
}

const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/g;
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_]+)/gu;
const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export const graphemes = (t) => [...seg.segment(t)].length;
export const urlsIn = (t) => t.match(URL_RE) || [];
/** Length where every URL counts as `n` characters (X, Mastodon). */
export const lengthUrlsAs = (n) => (t) => graphemes(t.replace(URL_RE, 'x'.repeat(n)));
export const hashtagCount = (t) => [...t.matchAll(TAG_RE)].length;

/** Bluesky rich-text facets (links + hashtags) with UTF-8 byte offsets. */
export function blueskyFacets(text) {
  const enc = new TextEncoder();
  const at = (i) => enc.encode(text.slice(0, i)).length;
  const facets = [];
  for (const m of text.matchAll(URL_RE)) {
    facets.push({ index: { byteStart: at(m.index), byteEnd: at(m.index + m[0].length) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] });
  }
  for (const m of text.matchAll(TAG_RE)) {
    const start = m.index + m[1].length;
    facets.push({ index: { byteStart: at(start), byteEnd: at(start + 1 + m[2].length) }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2] }] });
  }
  return facets;
}

/** LinkedIn "little text" format: escape reserved characters, turn #tags into hashtag templates. */
export function linkedinText(text) {
  const esc = (s) => s.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => '\\' + c);
  let out = '', last = 0;
  for (const m of text.matchAll(TAG_RE)) {
    const start = m.index + m[1].length;
    out += esc(text.slice(last, start)) + `{hashtag|\\#|${m[2]}}`;
    last = start + 1 + m[2].length;
  }
  return out + esc(text.slice(last));
}

/** Append UTM parameters to every link that doesn't already carry them. */
export function addUtm(text, { source, medium, campaign } = {}) {
  if (!source && !medium && !campaign) return text;
  return text.replace(URL_RE, (u) => {
    try {
      const url = new URL(u);
      if ([...url.searchParams.keys()].some((k) => k.startsWith('utm_'))) return u;
      if (source) url.searchParams.set('utm_source', source);
      if (medium) url.searchParams.set('utm_medium', medium);
      if (campaign) url.searchParams.set('utm_campaign', campaign);
      return url.toString();
    } catch { return u; }
  });
}

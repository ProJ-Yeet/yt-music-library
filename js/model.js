// Library data model shared by the site (and mirrored in the userscript).
// Pure functions only, so it runs under Node for the tests.

export const CATEGORIES = [
  { id: 'song', name: 'Song', short: 'S', hint: 'Songs with lyrics' },
  { id: 'music', name: 'Music', short: 'M', hint: 'Instrumental, no words' },
  { id: 'relax', name: 'Relax', short: 'R', hint: 'Ambient, for working' },
  { id: 'slow', name: 'Slow', short: 'Sl', hint: 'Songs on the slow side' },
  { id: 'electric', name: 'Electric', short: 'E', hint: 'EDM' },
  { id: 'classical', name: 'Classical', short: 'C', hint: 'Classical' },
  { id: 'pop', name: 'Pop', short: 'P', hint: 'Pop' },
  { id: 'rock', name: 'Rock', short: 'Ro', hint: 'Rock' },
  { id: 'epic', name: 'Epic', short: 'Ep', hint: 'Epic' },
  { id: 'minecraft', name: 'Minecraft', short: 'Mc', hint: 'Minecraft' },
  { id: 'hololive', name: 'Hololive', short: 'H', hint: 'Hololive talents' },
];
export const CAT_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

// Flairs are single letters stored together in `f`, always sorted.
export const FLAIRS = [
  { id: 'L', name: 'Long', hint: 'Longer than 15 minutes' },
  { id: 'S', name: 'Secondary', hint: 'Second-tier pick' },
];
export const LONG_SECONDS = 15 * 60;

// The library lives in CHUNKS documents library/c00..c31, each holding a
// map v: { videoId: record }, plus library/meta. Grouping keeps a full load
// at ~33 document reads instead of one per video.
export const CHUNKS = 32;
export function chunkOf(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
  return h % CHUNKS;
}
export const chunkDocId = (i) => 'c' + String(i).padStart(2, '0');

export function normFlairs(f) {
  return [...new Set(String(f || '').split(''))]
    .filter((x) => FLAIRS.some((fl) => fl.id === x))
    .sort()
    .join('');
}

// Long is automatic past 15 minutes; it is never removed automatically.
export function withAutoFlairs(f, durationSec) {
  return normFlairs((f || '') + (durationSec > LONG_SECONDS ? 'L' : ''));
}

// Stars + category + flairs decide which YouTube playlist a video lives in.
export function bucketKey(v) {
  const f = normFlairs(v.f);
  return `${v.s}-${v.c}${f ? '-' + f : ''}`;
}
export function parseBucketKey(key) {
  const [s, c, f = ''] = String(key).split('-');
  return { s: Number(s), c, f };
}
export function bucketName(key) {
  const { s, c, f } = parseBucketKey(key);
  const cat = CAT_BY_ID[c] ? CAT_BY_ID[c].name : c;
  const fl = FLAIRS.filter((x) => f.includes(x.id)).map((x) => ` · ${x.name}`).join('');
  return `${s}★ ${cat}${fl}`;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

// filters: { cats:Set, stars:Set, long:'any'|'only'|'no', secondary:'any'|'only'|'no',
//            minMin:number|null, maxMin:number|null, q:string }
export function matches(v, flt) {
  if (flt.cats && flt.cats.size && !flt.cats.has(v.c)) return false;
  if (flt.stars && flt.stars.size && !flt.stars.has(v.s)) return false;
  const f = v.f || '';
  if (flt.long === 'only' && !f.includes('L')) return false;
  if (flt.long === 'no' && f.includes('L')) return false;
  if (flt.secondary === 'only' && !f.includes('S')) return false;
  if (flt.secondary === 'no' && f.includes('S')) return false;
  if (flt.minMin != null && (v.d || 0) < flt.minMin * 60) return false;
  if (flt.maxMin != null && (v.d || 0) > flt.maxMin * 60) return false;
  if (flt.q) {
    const hay = `${v.t || ''} ${v.a || ''}`.toLowerCase();
    for (const word of flt.q.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (!hay.includes(word)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shuffles
// ---------------------------------------------------------------------------

export function shuffle(ids, rng = Math.random) {
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Stable 0..1 number per (video, time heard). Songs heard together in one
// session get different cool-downs from it, so they do not all come back on
// the same day as a batch.
export function jitter(id, heardAt) {
  let h = 2166136261 >>> 0;
  const s = id + ':' + heardAt;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return (h % 100000) / 100000;
}

const DAY = 24 * 60 * 60 * 1000;

// "Shuffle unheard": nothing heard within its cool-down plays until the
// fresh songs run out. Never-heard songs weigh 1. Once a song's cool-down
// (cooldownDays, stretched by up to +50% per song) has passed, its weight
// climbs from 0.15 back to 1 over the next two cool-downs. Order is a
// weighted random permutation (Efraimidis–Spirakis: key = u^(1/w)), so
// heavier songs tend to come first but nothing is fixed.
// Songs still cooling down go last, longest-ago first.
export function shuffleUnheard(ids, heard, { now = Date.now(), cooldownDays = 7, rng = Math.random } = {}) {
  const ready = [];
  const cooling = [];
  const cool = Math.max(0, cooldownDays) * DAY;
  for (const id of ids) {
    const at = heard[id];
    if (!at) {
      ready.push({ id, key: rng() });
      continue;
    }
    const myCool = cool * (1 + 0.5 * jitter(id, at));
    const age = now - at;
    if (age < myCool) {
      cooling.push({ id, at });
      continue;
    }
    const w = cool > 0 ? 0.15 + 0.85 * Math.min(1, (age - myCool) / (2 * cool)) : 1;
    ready.push({ id, key: Math.pow(rng(), 1 / w) });
  }
  ready.sort((a, b) => b.key - a.key);
  cooling.sort((a, b) => a.at - b.at);
  return { order: ready.map((x) => x.id).concat(cooling.map((x) => x.id)), fresh: ready.length };
}

// ---------------------------------------------------------------------------
// Share links: filters <-> URL hash
// ---------------------------------------------------------------------------

export function filtersToHash(flt, extra = {}) {
  const p = new URLSearchParams();
  if (flt.cats && flt.cats.size) p.set('c', [...flt.cats].join(','));
  if (flt.stars && flt.stars.size) p.set('s', [...flt.stars].sort().join(','));
  if (flt.long && flt.long !== 'any') p.set('long', flt.long);
  if (flt.secondary && flt.secondary !== 'any') p.set('sec', flt.secondary);
  if (flt.minMin != null) p.set('min', String(flt.minMin));
  if (flt.maxMin != null) p.set('max', String(flt.maxMin));
  if (flt.q) p.set('q', flt.q);
  for (const [k, v] of Object.entries(extra)) if (v != null && v !== '') p.set(k, String(v));
  return p.toString();
}

export function hashToFilters(hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const num = (k) => (p.has(k) && p.get(k) !== '' && !isNaN(Number(p.get(k))) ? Number(p.get(k)) : null);
  return {
    filters: {
      cats: new Set((p.get('c') || '').split(',').filter((c) => CAT_BY_ID[c])),
      stars: new Set((p.get('s') || '').split(',').map(Number).filter((n) => n >= 1 && n <= 5)),
      long: ['only', 'no'].includes(p.get('long')) ? p.get('long') : 'any',
      secondary: ['only', 'no'].includes(p.get('sec')) ? p.get('sec') : 'any',
      minMin: num('min'),
      maxMin: num('max'),
      q: p.get('q') || '',
    },
    params: p,
  };
}

export function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

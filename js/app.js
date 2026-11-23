import { firebaseConfig, FIREBASE_SDK } from './firebase-config.js';
import {
  CATEGORIES, CAT_BY_ID, FLAIRS, CHUNKS, chunkOf, chunkDocId, withAutoFlairs, normFlairs,
  bucketKey, bucketName, matches, shuffle, shuffleUnheard, filtersToHash, hashToFilters, formatDuration,
} from './model.js';
import { Player, UNPLAYABLE } from './player.js';

const [{ initializeApp }, fs, au] = await Promise.all([
  import(`${FIREBASE_SDK}/firebase-app.js`),
  import(`${FIREBASE_SDK}/firebase-firestore.js`),
  import(`${FIREBASE_SDK}/firebase-auth.js`),
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
const LS = { heard: 'ytml-heard-v1', settings: 'ytml-settings-v1', queue: 'ytml-queue-v1' };
function lsGet(key, dflt) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : dflt; } catch { return dflt; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode / full */ }
}
let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function ago(ms) {
  const d = Math.floor((Date.now() - ms) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}
const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const ytUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

// ---------------------------------------------------------------------------
// Firebase
// ---------------------------------------------------------------------------
const app = initializeApp(firebaseConfig);
let db;
try {
  db = fs.initializeFirestore(app, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
  });
} catch {
  db = fs.getFirestore(app);
}
// Local persistence keeps the session in localStorage, where the companion
// userscript (on this page only) can pick it up to write ratings from YouTube.
const auth = au.initializeAuth(app, {
  persistence: [au.browserLocalPersistence],
  popupRedirectResolver: au.browserPopupRedirectResolver,
});
const metaRef = fs.doc(db, 'library', 'meta');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const chunkMaps = Array(CHUNKS).fill(null);
let byId = new Map();
let lib = [];
let meta = {};
let plToBucket = new Map();
let user = null;
let isOwner = false;
let heard = lsGet(LS.heard, {});
const settings = Object.assign({ cooldownDays: 7 }, lsGet(LS.settings, {}));
const randomKey = new Map();

const initial = hashToFilters(location.hash);
const filters = initial.filters;
let sortMode = initial.params.get('sort') || 'added';

// ---------------------------------------------------------------------------
// Data subscriptions (real time)
// ---------------------------------------------------------------------------
let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 60);
}
function rebuild() {
  byId = new Map();
  for (const m of chunkMaps) {
    if (!m) continue;
    for (const [id, r] of Object.entries(m)) byId.set(id, { id, ...r });
  }
  lib = [...byId.values()];
  for (const v of lib) if (!randomKey.has(v.id)) randomKey.set(v.id, Math.random());
  render({ keep: true });
  refreshQueueList();
}

function setLive(fromServer) {
  const dot = $('liveDot');
  dot.classList.toggle('on', fromServer);
  dot.title = fromServer ? 'Live: changes appear instantly' : 'Offline copy';
}

let metaJson = '';
fs.onSnapshot(metaRef, { includeMetadataChanges: true }, (snap) => {
  setLive(!snap.metadata.fromCache);
  const json = JSON.stringify(snap.exists() ? snap.data() : {});
  if (json === metaJson) return;
  metaJson = json;
  meta = JSON.parse(json);
  plToBucket = new Map();
  for (const [key, lists] of Object.entries(meta.buckets || {})) {
    for (const pl of lists || []) plToBucket.set(pl.id, key);
  }
  claimOwner();
  updateOwner();
  render({ keep: true });
}, (err) => showNotice(`Could not load the library (${err.code || err.message}).`));

for (let i = 0; i < CHUNKS; i++) {
  fs.onSnapshot(fs.doc(db, 'library', chunkDocId(i)), (snap) => {
    chunkMaps[i] = snap.exists() ? (snap.data().v || {}) : {};
    scheduleRebuild();
  }, (err) => showNotice(`Could not load part of the library (${err.code || err.message}).`));
}

// ---------------------------------------------------------------------------
// Owner / auth
// ---------------------------------------------------------------------------
au.onAuthStateChanged(auth, (u) => {
  user = u;
  $('signInBtn').textContent = u ? 'Sign out' : 'Sign in';
  claimOwner();
  updateOwner();
});

let claiming = false;
async function claimOwner() {
  // The first sign-in by the account the security rules allow records its
  // uid as owner. Anyone else's attempt is rejected by the rules.
  if (!user || meta.ownerUid || claiming) return;
  claiming = true;
  try {
    await fs.setDoc(metaRef, { ownerUid: user.uid }, { merge: true });
  } catch { /* not the owner */ }
  claiming = false;
}

function updateOwner() {
  const was = isOwner;
  isOwner = !!(user && meta.ownerUid && meta.ownerUid === user.uid);
  $('ownerBadge').hidden = !isOwner;
  if (user && meta.ownerUid && !isOwner) $('signInBtn').title = 'Signed in (view only)';
  if (was !== isOwner) render({ keep: true });
}

$('signInBtn').addEventListener('click', async () => {
  try {
    if (user) await au.signOut(auth);
    else await au.signInWithPopup(auth, new au.GoogleAuthProvider());
  } catch (e) {
    if (e && e.code !== 'auth/popup-closed-by-user') toast(`Sign-in failed: ${e.code || e.message}`);
  }
});

async function updateVideo(id, patch) {
  const v = byId.get(id);
  if (!v || !isOwner) return;
  const next = { ...v, ...patch };
  next.f = withAutoFlairs(normFlairs(next.f), next.d);
  const args = [];
  for (const k of ['c', 's', 'f']) {
    if (next[k] !== v[k]) args.push(new fs.FieldPath('v', id, k), next[k]);
  }
  if (!args.length) return;
  args.push(new fs.FieldPath('v', id, 'u'), Date.now());
  try {
    await fs.updateDoc(fs.doc(db, 'library', chunkDocId(chunkOf(id))), ...args);
  } catch (e) {
    toast(`Could not save: ${e.code || e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Filter panel
// ---------------------------------------------------------------------------
function buildFilterPanel() {
  const cats = $('catChips');
  cats.replaceChildren(...CATEGORIES.map((c) => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(filters.cats.has(c.id)), title: c.hint,
    dataset: { cat: c.id },
    onclick: (e) => { toggle(filters.cats, c.id); e.currentTarget.setAttribute('aria-pressed', String(filters.cats.has(c.id))); changed(); },
  }, h('span', { class: 'cat', 'data-c': c.id }, c.short), c.name, h('span', { class: 'n' }))));

  const stars = $('starChips');
  stars.replaceChildren(...[5, 4, 3, 2, 1].map((n) => h('button', {
    class: 'chip star-chip', type: 'button', 'aria-pressed': String(filters.stars.has(n)), dataset: { star: n },
    onclick: (e) => { toggle(filters.stars, n); e.currentTarget.setAttribute('aria-pressed', String(filters.stars.has(n))); changed(); },
  }, '★'.repeat(n), h('span', { class: 'n' }))));

  seg($('longSeg'), 'long');
  seg($('secSeg'), 'secondary');

  $('q').value = filters.q;
  $('minMin').value = filters.minMin ?? '';
  $('maxMin').value = filters.maxMin ?? '';
  $('sort').value = sortMode;
  $('deadBtn').setAttribute('aria-pressed', String(filters.dead === 'only'));
}
$('deadBtn').addEventListener('click', () => {
  filters.dead = filters.dead === 'only' ? 'hide' : 'only';
  $('deadBtn').setAttribute('aria-pressed', String(filters.dead === 'only'));
  changed();
});
function seg(el, key) {
  const opts = [['any', 'Any'], ['only', 'Only'], ['no', 'Hide']];
  el.replaceChildren(...opts.map(([val, label]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(filters[key] === val),
    onclick: () => {
      filters[key] = val;
      for (const b of el.children) b.setAttribute('aria-checked', String(b.textContent === label));
      changed();
    },
  }, label)));
}
function toggle(set, v) { if (set.has(v)) set.delete(v); else set.add(v); }

let qTimer = null;
$('q').addEventListener('input', () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { filters.q = $('q').value.trim(); changed(); }, 180);
});
for (const id of ['minMin', 'maxMin']) {
  $(id).addEventListener('change', () => {
    const v = $(id).value.trim();
    filters[id] = v === '' ? null : Math.max(0, Number(v));
    changed();
  });
}
$('sort').addEventListener('change', () => { sortMode = $('sort').value; changed(); });
$('resetBtn').addEventListener('click', () => {
  filters.cats.clear(); filters.stars.clear();
  filters.long = 'any'; filters.secondary = 'any';
  filters.minMin = null; filters.maxMin = null; filters.q = '';
  filters.dead = 'hide';
  buildFilterPanel();
  changed();
});
$('filtersToggle').addEventListener('click', () => $('filters').classList.toggle('open'));

function changed() {
  history.replaceState(null, '', '#' + filtersToHash(filters, { sort: sortMode !== 'added' ? sortMode : '' }));
  render();
}

function updateCounts() {
  const cat = {};
  const star = {};
  const noCat = { ...filters, cats: null };
  const noStar = { ...filters, stars: null };
  for (const v of lib) {
    if (matches(v, noCat)) cat[v.c] = (cat[v.c] || 0) + 1;
    if (matches(v, noStar)) star[v.s] = (star[v.s] || 0) + 1;
  }
  for (const b of $('catChips').children) b.querySelector('.n').textContent = (cat[b.dataset.cat] || 0).toLocaleString();
  for (const b of $('starChips').children) b.querySelector('.n').textContent = (star[b.dataset.star] || 0).toLocaleString();
  $('deadN').textContent = lib.reduce((n, v) => n + (v.z ? 1 : 0), 0).toLocaleString();
}

// ---------------------------------------------------------------------------
// List + grid
// ---------------------------------------------------------------------------
const SORTS = {
  added: (a, b) => (b.x || 0) - (a.x || 0),
  stars: (a, b) => b.s - a.s || (b.x || 0) - (a.x || 0),
  random: (a, b) => randomKey.get(a.id) - randomKey.get(b.id),
  title: (a, b) => (a.t || '').localeCompare(b.t || ''),
  channel: (a, b) => (a.a || '').localeCompare(b.a || '') || (a.t || '').localeCompare(b.t || ''),
  long: (a, b) => (b.d || 0) - (a.d || 0),
  short: (a, b) => (a.d || 0) - (b.d || 0),
};
let list = [];
let rendered = 0;
const PAGE = 120;

function computeList() {
  const sort = filters.dead === 'only'
    ? (a, b) => (b.z.at || 0) - (a.z.at || 0) // newest death first
    : SORTS[sortMode] || SORTS.added;
  return lib.filter((v) => matches(v, filters)).sort(sort);
}

function render({ keep = false } = {}) {
  list = computeList();
  const count = keep ? Math.max(rendered, PAGE) : PAGE;
  rendered = 0;
  $('grid').replaceChildren();
  const deadView = filters.dead === 'only';
  for (const id of ['playBtn', 'shuffleBtn', 'unheardBtn', 'ytBtn']) $(id).hidden = deadView;
  $('copyDeadBtn').hidden = !deadView;
  if (!list.length) {
    $('grid').append(h('div', { class: 'empty' }, deadView
      ? 'No dead videos on record.'
      : lib.length ? 'Nothing matches these filters.' : 'The library is empty for now.'));
  }
  renderMore(count);
  updateSummary();
  updateCounts();
}

function renderMore(n = PAGE) {
  const end = Math.min(list.length, rendered + n);
  const frag = document.createDocumentFragment();
  for (let i = rendered; i < end; i++) frag.append(card(list[i]));
  $('grid').append(frag);
  rendered = end;
}
new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && rendered < list.length) renderMore();
}, { rootMargin: '800px' }).observe($('sentinel'));

function updateSummary() {
  const secs = list.reduce((t, v) => t + (v.d || 0), 0);
  const hours = Math.round(secs / 360) / 10;
  const now = Date.now();
  const cool = settings.cooldownDays * 86400000;
  const fresh = list.reduce((n, v) => n + (!heard[v.id] || now - heard[v.id] >= cool ? 1 : 0), 0);
  $('summary').replaceChildren(
    `${list.length.toLocaleString()} videos`,
    h('small', {}, `${hours.toLocaleString()} h · ${fresh.toLocaleString()} not heard in ${settings.cooldownDays} days`),
  );
}

function starsEl(v) {
  const wrap = h('div', { class: 'stars', 'aria-label': `${v.s} stars` });
  for (let n = 1; n <= 5; n++) {
    if (isOwner) {
      wrap.append(h('button', {
        type: 'button', class: n <= v.s ? '' : 'off', title: `${n} star${n > 1 ? 's' : ''}`,
        onclick: () => updateVideo(v.id, { s: n }),
      }, '★'));
    } else {
      wrap.append(h('span', { class: n <= v.s ? '' : 'off' }, '★'));
    }
  }
  return wrap;
}

// A video that looks dead to whoever is browsing (blank thumbnail, or the
// player refuses it) is reported once. Anyone may file a report; the owner's
// userscript checks each one from the owner's country before acting on it.
const reported = new Set();
function reportDead(id, why) {
  const v = byId.get(id);
  if (!v || v.z || reported.has(id)) return;
  reported.add(id);
  // Fails quietly when this video is already reported (the rules allow a
  // report to be created, never changed).
  fs.setDoc(fs.doc(db, 'reports', id), { why, at: fs.serverTimestamp() }).catch(() => {});
}
// YouTube answers a missing video's thumbnail with a 120×90 placeholder.
const checkThumb = (id) => (e) => { if (e.currentTarget.naturalWidth === 120) reportDead(id, 'thumb'); };

// Dead songs: where they were, and a search for another upload.
function playlistName(pid, fallback = '') {
  for (const chain of Object.values(meta.buckets || {})) for (const p of chain || []) if (p.id === pid) return p.name;
  return fallback || pid || '';
}
const searchUrl = (v) => `https://www.youtube.com/results?search_query=${encodeURIComponent(`${v.t || ''} ${v.a || ''}`.trim())}`;
const dayStr = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
function deadInfo(v) {
  const z = v.z || {};
  return h('div', { class: 'deadinfo' },
    h('div', {}, `🪦 ${dayStr(z.at)} · ${z.why || 'unavailable'}`),
    h('div', {}, `was in ${playlistName(z.pl, z.pn) || '?'} · `,
      h('a', { href: searchUrl(v), target: '_blank', rel: 'noopener' }, 'find another upload ↗'), ' · ',
      h('a', { href: ytUrl(v.id), target: '_blank', rel: 'noopener' }, 'old link')));
}
$('copyDeadBtn').addEventListener('click', async () => {
  const text = list.map((v) => [dayStr(v.z.at), v.z.why || 'unavailable', playlistName(v.z.pl, v.z.pn),
    v.t || '', v.a || '', ytUrl(v.id)].join(' | ')).join('\n');
  const head = `Dead videos in the Music Library (${list.length}) — date | reason | playlist | title | channel | old link\n`;
  try { await navigator.clipboard.writeText(head + text); toast(`Copied ${list.length} dead videos.`); }
  catch { prompt('Copy the report:', head + text); }
});

function card(v) {
  if (v.z) return deadCard(v);
  const cat = CAT_BY_ID[v.c];
  const f = v.f || '';
  const catEl = isOwner
    ? h('button', { class: 'cat', 'data-c': v.c, type: 'button', title: `${cat ? cat.name : v.c}: change category / flairs`,
      onclick: (e) => { e.stopPropagation(); openMenu(v.id, e.currentTarget); } }, cat ? cat.short : '?')
    : h('span', { class: 'cat', 'data-c': v.c, title: cat ? cat.name : v.c }, cat ? cat.short : '?');
  const pending = isOwner && v.p && plToBucket.size && plToBucket.get(v.p) !== bucketKey(v);
  const playing = queue && queue.ids[queue.i] === v.id;
  return h('article', { class: 'card' + (playing ? ' playing' : ''), dataset: { id: v.id } },
    h('div', { class: 'thumb', onclick: () => playFromList(v.id), title: 'Play from here' },
      h('img', { src: thumb(v.id), alt: '', loading: 'lazy', decoding: 'async', onload: checkThumb(v.id) }),
      catEl,
      pending ? h('span', { class: 'pending', title: `Moves to "${bucketName(bucketKey(v))}" next time YouTube is open with the userscript` }, '⟳') : null,
      h('span', { class: 'flairs' }, FLAIRS.filter((x) => f.includes(x.id)).map((x) => h('span', { class: 'flair', title: x.name }, x.id === 'L' ? 'Long' : '2nd'))),
      heard[v.id] ? h('span', { class: 'heard' }, `heard ${ago(heard[v.id])}`) : null,
      h('span', { class: 'dur' }, formatDuration(v.d)),
    ),
    starsEl(v),
    h('div', { class: 'meta' },
      h('div', { class: 'title', title: v.t }, v.t || v.id),
      h('div', { class: 'chan' }, v.a || ''),
    ),
  );
}

function deadCard(v) {
  const cat = CAT_BY_ID[v.c];
  return h('article', { class: 'card dead', dataset: { id: v.id } },
    h('a', { class: 'thumb', href: searchUrl(v), target: '_blank', rel: 'noopener', title: 'Search YouTube for another upload' },
      h('img', { src: thumb(v.id), alt: '', loading: 'lazy', decoding: 'async' }),
      h('span', { class: 'cat', 'data-c': v.c, title: cat ? cat.name : v.c }, cat ? cat.short : '?'),
      h('span', { class: 'dur' }, formatDuration(v.d)),
    ),
    h('div', { class: 'stars', 'aria-label': `${v.s} stars` },
      [1, 2, 3, 4, 5].map((n) => h('span', { class: n <= v.s ? '' : 'off' }, '★'))),
    h('div', { class: 'meta' },
      h('div', { class: 'title', title: v.t }, v.t || v.id),
      h('div', { class: 'chan' }, v.a || ''),
      deadInfo(v),
    ),
  );
}

function patchCards(id) {
  const v = byId.get(id);
  for (const el of document.querySelectorAll(`.card[data-id="${CSS.escape(id)}"]`)) {
    if (v) el.replaceWith(card(v));
  }
}

// ---------------------------------------------------------------------------
// Owner edit menu
// ---------------------------------------------------------------------------
const menu = $('menu');
function openMenu(id, anchor) {
  const v = byId.get(id);
  if (!v) return;
  const f = v.f || '';
  const longAuto = (v.d || 0) > 15 * 60;
  menu.replaceChildren(
    h('h4', {}, 'Category'),
    h('div', { class: 'cat-grid' }, CATEGORIES.map((c) => h('button', {
      type: 'button', 'aria-pressed': String(v.c === c.id),
      onclick: () => { updateVideo(id, { c: c.id }); closeMenu(); },
    }, h('span', { class: 'cat', 'data-c': c.id }, c.short), c.name))),
    h('h4', {}, 'Flairs'),
    h('div', { class: 'flair-row' }, FLAIRS.map((fl) => h('button', {
      type: 'button', 'aria-pressed': String(f.includes(fl.id)),
      disabled: fl.id === 'L' && longAuto,
      title: fl.id === 'L' && longAuto ? 'Over 15 minutes, so always Long' : fl.hint,
      onclick: () => {
        const nf = f.includes(fl.id) ? f.replace(fl.id, '') : f + fl.id;
        updateVideo(id, { f: nf });
        closeMenu();
      },
    }, fl.name))),
    h('a', { href: ytUrl(id), target: '_blank', rel: 'noopener' }, 'Open on YouTube ↗'),
  );
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const hgt = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + hgt + 8 < innerHeight ? r.bottom + 6 : Math.max(8, r.top - hgt - 6)}px`;
}
function closeMenu() { menu.hidden = true; }
document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
addEventListener('scroll', closeMenu, { passive: true });

// ---------------------------------------------------------------------------
// Player + queue
// ---------------------------------------------------------------------------
let queue = lsGet(LS.queue, null);
let heardLogged = false;
const unplayable = new Set();

const player = new Player($('ytmount'), {
  onTick: (t, dur) => {
    if (!heardLogged && (t >= 30 || (dur > 0 && t >= dur * 0.5))) markHeard();
  },
  onEnded: () => { markHeard(); next(); },
  onError: (code) => {
    const id = queue && queue.ids[queue.i];
    if (UNPLAYABLE.has(code) && id) {
      unplayable.add(id);
      reportDead(id, `e${code}`);
      toast('This one can’t play outside YouTube, skipping. (Open it on YouTube from its card menu.)');
      setTimeout(next, 1200);
    }
  },
});

function markHeard() {
  const id = queue && queue.ids[queue.i];
  if (!id || heardLogged) return;
  heardLogged = true;
  heard[id] = Date.now();
  lsSet(LS.heard, heard);
  patchCards(id);
  updateSummary();
}

const MODE_LABEL = { play: 'In order', shuffle: 'Shuffled', unheard: 'Shuffle unheard', pick: 'From your pick' };
function startQueue(ids, mode, i = 0) {
  if (!ids.length) { toast('Nothing to play with these filters.'); return; }
  queue = { ids, i, mode };
  saveQueue();
  playCurrent();
}
function saveQueue() { lsSet(LS.queue, queue); }

function playCurrent() {
  const id = queue && queue.ids[queue.i];
  if (!id) return;
  $('dock').hidden = false;
  document.body.style.setProperty('--dock-h', `${$('dock').offsetHeight}px`);
  heardLogged = false;
  player.play(id);
  const v = byId.get(id);
  $('npTitle').textContent = v ? v.t : id;
  const cat = v && CAT_BY_ID[v.c];
  $('npMeta').textContent = v ? `${v.a || ''} · ${cat ? cat.name : ''} · ${'★'.repeat(v.s || 0)} · ${formatDuration(v.d)}` : '';
  $('modeLabel').textContent = `${MODE_LABEL[queue.mode] || ''} · ${queue.i + 1} / ${queue.ids.length}`;
  document.title = `${v ? v.t : id} · Music Library`;
  for (const el of document.querySelectorAll('.card.playing')) el.classList.remove('playing');
  for (const el of document.querySelectorAll(`.card[data-id="${CSS.escape(id)}"]`)) el.classList.add('playing');
  refreshQueueList();
}
function next() {
  if (!queue) return;
  if (queue.i < queue.ids.length - 1) { queue.i++; saveQueue(); playCurrent(); } else toast('End of the list.');
}
function prev() {
  if (!queue || queue.i === 0) return;
  queue.i--; saveQueue(); playCurrent();
}
function refreshQueueList() {
  const ol = $('queueList');
  if (ol.hidden || !queue) return;
  const start = queue.i;
  ol.start = start + 1;
  ol.replaceChildren(...queue.ids.slice(start, start + 50).map((id, k) => {
    const v = byId.get(id);
    return h('li', { class: k === 0 ? 'cur' : '', onclick: () => { queue.i = start + k; saveQueue(); playCurrent(); } },
      v ? `${v.t} — ${v.a || ''}` : id);
  }));
}

function playFromList(id) {
  const ids = list.map((v) => v.id);
  startQueue(ids, 'pick', Math.max(0, ids.indexOf(id)));
}
$('playBtn').addEventListener('click', () => startQueue(list.map((v) => v.id), 'play'));
$('shuffleBtn').addEventListener('click', () => startQueue(shuffle(list.map((v) => v.id)), 'shuffle'));
$('unheardBtn').addEventListener('click', () => {
  const { order, fresh } = shuffleUnheard(list.map((v) => v.id), heard, { cooldownDays: settings.cooldownDays });
  if (!fresh) toast(`Everything here was heard in the last ${settings.cooldownDays}+ days; playing the longest-ago first.`);
  startQueue(order, 'unheard');
});
$('ytBtn').addEventListener('click', () => {
  const ids = (queue && !$('dock').hidden ? queue.ids.slice(queue.i) : list.map((v) => v.id)).slice(0, 50);
  if (!ids.length) return;
  window.open(`https://www.youtube.com/watch_videos?video_ids=${ids.join(',')}`, '_blank', 'noopener');
});
$('shareBtn').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#${filtersToHash(filters, { sort: sortMode !== 'added' ? sortMode : '' })}`;
  try { await navigator.clipboard.writeText(url); toast('Link copied. Anyone with it sees these filters.'); }
  catch { prompt('Copy this link:', url); }
});

$('prevBtn').addEventListener('click', prev);
$('nextBtn').addEventListener('click', () => next());
$('ppBtn').addEventListener('click', () => player.toggle());
$('queueBtn').addEventListener('click', () => {
  $('queueList').hidden = !$('queueList').hidden;
  refreshQueueList();
  document.body.style.setProperty('--dock-h', `${$('dock').offsetHeight}px`);
});
$('closeDock').addEventListener('click', () => {
  $('dock').hidden = true;
  document.body.style.setProperty('--dock-h', '0px');
  player.stop();
  for (const el of document.querySelectorAll('.card.playing')) el.classList.remove('playing');
});

// Keyboard: space play/pause, arrows next/prev, ctrl+arrows seek, 0-9 jump.
document.addEventListener('keydown', (e) => {
  if ($('dock').hidden) return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || e.altKey || e.metaKey) return;
  if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); if (e.ctrlKey) player.seekBy(5); else next(); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); if (e.ctrlKey) player.seekBy(-5); else prev(); }
  else if (/^Digit\d$/.test(e.code) && !e.ctrlKey) player.seekFraction(Number(e.code.slice(5)) / 10);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
$('settingsBtn').addEventListener('click', () => {
  $('cooldown').value = settings.cooldownDays;
  $('heardStats').textContent = `You have heard ${Object.keys(heard).length.toLocaleString()} songs on this device.`;
  $('settingsDlg').showModal();
});
$('cooldown').addEventListener('change', () => {
  settings.cooldownDays = Math.max(0, Math.min(365, Number($('cooldown').value) || 0));
  lsSet(LS.settings, settings);
  updateSummary();
});
$('clearHeard').addEventListener('click', () => {
  if (!confirm('Forget every song you have heard on this device?')) return;
  heard = {};
  lsSet(LS.heard, heard);
  $('heardStats').textContent = 'Listening history cleared.';
  render({ keep: true });
});

function showNotice(msg) {
  const n = $('notice');
  n.textContent = msg;
  n.hidden = false;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
buildFilterPanel();
render();

// Local testing hook: lets a dev console load sample rows without Firestore.
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.__ytml = { chunkMaps, scheduleRebuild, setOwner: (on) => { isOwner = on; render({ keep: true }); } };
}

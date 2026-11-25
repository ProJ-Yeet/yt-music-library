import { firebaseConfig, FIREBASE_SDK } from './firebase-config.js?v=10';
import {
  CATEGORIES, CAT_BY_ID, FLAIRS, CHUNKS, chunkOf, chunkDocId, withAutoFlairs, normFlairs,
  bucketKey, bucketName, matches, shuffle, shuffleUnheard, filtersToHash, hashToFilters, formatDuration,
} from './model.js?v=10';
import { Player, UNPLAYABLE } from './player.js?v=10';

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
const LS = { heard: 'ytml-heard-v1', settings: 'ytml-settings-v1', queue: 'ytml-queue-v1', review: 'ytml-review-v1' };
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
  renderNpRate();
  if ($('approveDlg').open) renderApprove();
  if ($('bulkDlg').open) renderBulk();
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
  // Setting a rating during a review run (even to the same value) counts as judged: tick it.
  if (review && !v.r && (review.listened[id] || review.ids.includes(id))) {
    apTicks.set(id, true);
    noteListened(id, 'heard');
    review.listened[id].rated = true; // only songs you rated start ticked
    saveReview();
    if ($('approveDlg').open) renderApprove();
  }
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
  seg($('revSeg'), 'reviewed');

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
  filters.reviewed = 'any';
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
  const alive = lib.filter((v) => !v.z);
  $('revCount').textContent = `(${alive.filter((v) => v.r).length.toLocaleString()} of ${alive.length.toLocaleString()})`;
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
  $('revSection').hidden = !isOwner;
  $('reviewBtn').hidden = !isOwner || deadView;
  $('bulkBtn').hidden = !isOwner || deadView;
  updateReviewUi();
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
  // Inside an open dialog the menu must live in it, or the dialog covers it.
  const host = document.querySelector('dialog[open]') || document.body;
  if (menu.parentElement !== host) host.append(menu);
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
      if (queue.mode === 'review') noteListened(id, 'unplayable');
      toast('This one can’t play outside YouTube, skipping. (Open it on YouTube from its card menu.)');
      setTimeout(next, 1200);
    }
  },
  onState: (s) => onPlayerState(s),
  // Spinning at 0:00 with no error: try the song once more in a fresh player, then move on.
  onStuck: () => {
    if (userPaused) return;
    if (stuckTries++ === 0) { toast('Stuck loading, retrying…'); player.rebuild(); }
    else if (++stuckSongs >= 3) { toast('Several songs in a row would not start. Press ⏯ to try again.'); userPaused = true; }
    else { toast('Still stuck, skipping to the next song.'); next(); }
  },
});
let stuckTries = 0;
let stuckSongs = 0; // in a row; a song that really plays resets it

// ---------------------------------------------------------------------------
// Playing on with the screen off / in another app (phones)
//
// Phones pause a page's video when it goes to the background. Two things
// push back: a silent audio loop on this page (it keeps the page counted as
// "playing audio", so it is not frozen, and it puts play/pause/next on the
// lock screen), and a keep-alive that restarts the song when it was paused
// while hidden and not by you. Some browsers still stop it (iOS Safari);
// Brave's "background play" setting covers those cases.
// ---------------------------------------------------------------------------
let userPaused = false;
let revivals = [];
let silent = null;
function silentAudio() {
  if (silent) return silent;
  // 1 s of 8 kHz 8-bit mono silence as a WAV.
  const n = 8000;
  const buf = new Uint8Array(44 + n);
  const dv = new DataView(buf.buffer);
  const str = (o, s) => [...s].forEach((c, i) => buf[o + i] = c.charCodeAt(0));
  str(0, 'RIFF'); dv.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  str(36, 'data'); dv.setUint32(40, n, true); buf.fill(128, 44);
  silent = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
  silent.loop = true;
  return silent;
}
function keepAwake(on) {
  const a = silentAudio();
  if (on) a.play().catch(() => {}); else a.pause();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
}
function onPlayerState(s) {
  if (s === 1) { userPaused = false; stuckSongs = 0; keepAwake(true); return; }
  if (s !== 2) return;
  if (!document.hidden) { userPaused = true; keepAwake(false); return; } // paused on the page: that was you
  if (userPaused) return;
  // Paused by the phone while in the background: play on (a few times a minute at most).
  const now = Date.now();
  revivals = revivals.filter((t) => now - t < 60000);
  if (revivals.length >= 6) return;
  revivals.push(now);
  setTimeout(() => { if (!userPaused) player.resume(); }, 400);
}
function togglePlay() {
  if (player.isPlaying()) { userPaused = true; player.pause(); keepAwake(false); }
  else { userPaused = false; player.resume(); keepAwake(true); }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden && queue && !$('dock').hidden && !userPaused) {
    setTimeout(() => { if (!userPaused && !player.isPlaying()) player.resume(); }, 800);
  }
});
if ('mediaSession' in navigator) {
  const on = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch { /* unsupported */ } };
  on('play', () => { userPaused = false; player.resume(); keepAwake(true); });
  on('pause', () => { userPaused = true; player.pause(); keepAwake(false); });
  on('nexttrack', () => next());
  on('previoustrack', () => prev());
}
function setNowPlayingMeta(v) {
  if (!('mediaSession' in navigator) || !v) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: v.t || v.id, artist: v.a || '', album: 'Music Library',
      artwork: [{ src: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' }],
    });
  } catch { /* older browser */ }
}

function markHeard() {
  const id = queue && queue.ids[queue.i];
  if (!id || heardLogged) return;
  heardLogged = true;
  heard[id] = Date.now();
  lsSet(LS.heard, heard);
  if (queue.mode === 'review') noteListened(id, 'heard');
  patchCards(id);
  updateSummary();
}

const MODE_LABEL = { play: 'In order', shuffle: 'Shuffled', unheard: 'Shuffle unheard', pick: 'From your pick', review: '🎧 Review run' };
function startQueue(ids, mode, i = 0) {
  if (!ids.length) { toast('Nothing to play with these filters.'); return; }
  queue = { ids, i, mode };
  saveQueue();
  playCurrent();
}
function saveQueue() { lsSet(LS.queue, queue); }

let reviewPlaying = null; // the review song on now, to requeue if left before it counts as heard
function playCurrent() {
  const id = queue && queue.ids[queue.i];
  if (!id) return;
  if (queue.mode === 'review' && review && reviewPlaying && reviewPlaying !== id &&
      !review.listened[reviewPlaying] && !reviewDone(reviewPlaying) &&
      queue.ids.lastIndexOf(reviewPlaying) <= queue.i) {
    requeueReview([reviewPlaying]); // skipped: it comes round again later in the run
  }
  reviewPlaying = queue.mode === 'review' ? id : null;
  $('dock').hidden = false;
  document.body.style.setProperty('--dock-h', `${$('dock').offsetHeight}px`);
  heardLogged = false;
  userPaused = false;
  stuckTries = 0;
  player.play(id);
  keepAwake(true);
  const v = byId.get(id);
  $('npTitle').textContent = v ? v.t : id;
  setNowPlayingMeta(v || { id });
  const cat = v && CAT_BY_ID[v.c];
  $('npMeta').textContent = v ? `${v.a || ''} · ${cat ? cat.name : ''} · ${'★'.repeat(v.s || 0)} · ${formatDuration(v.d)}` : '';
  $('modeLabel').textContent = `${MODE_LABEL[queue.mode] || ''} · ${queue.i + 1} / ${queue.ids.length}`;
  document.title = `${v ? v.t : id} · Music Library`;
  if (queue.mode === 'review' && review) review.i = queue.i; // noted as "heard" once enough of it has played
  renderNpRate();
  for (const el of document.querySelectorAll('.card.playing')) el.classList.remove('playing');
  for (const el of document.querySelectorAll(`.card[data-id="${CSS.escape(id)}"]`)) el.classList.add('playing');
  refreshQueueList();
}
function next() {
  if (!queue) return;
  let i = queue.i + 1;
  // A review run plays each song once: skip ones approved or dead meanwhile.
  if (queue.mode === 'review') {
    while (i < queue.ids.length && reviewDone(queue.ids[i])) i++;
  }
  if (i < queue.ids.length) { queue.i = i; saveQueue(); playCurrent(); }
  else toast(queue.mode === 'review' ? 'End of the review run. Approve what you heard with ✅.' : 'End of the list.');
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

// ---------------------------------------------------------------------------
// Review run (owner): the chosen songs shuffled once, each played once, kept
// in this browser. Whatever has played waits in "listened" until approved;
// approving writes v.r (the date) to the library, which ends its review.
// ---------------------------------------------------------------------------
let review = lsGet(LS.review, null); // { ids, i, listened: { id: { k, t } } }
const saveReview = () => lsSet(LS.review, review);
const apTicks = new Map(); // id → ticked in the Approve dialog
// Put songs back at the end of the run, to hear them again later.
function requeueReview(ids) {
  for (const id of ids) { delete review.listened[id]; apTicks.delete(id); review.ids.push(id); }
  if (queue && queue.mode === 'review') { queue.ids = review.ids.slice(); saveQueue(); }
  saveReview();
}
// Older versions saved skipped songs as "skipped"; send those back into the run.
if (review) {
  const skipped = Object.keys(review.listened).filter((id) => review.listened[id].k === 'skipped');
  if (skipped.length) requeueReview(skipped);
}
const reviewDone = (id) => { const v = byId.get(id); return !v || !!v.r || !!v.z; };
function reviewLeft() {
  if (!review) return 0;
  let n = 0;
  for (let k = review.i; k < review.ids.length; k++) if (!reviewDone(review.ids[k]) && !review.listened[review.ids[k]]) n++;
  return n;
}
function noteListened(id, k) {
  if (!review || !isOwner) return;
  const rank = { skipped: 0, unplayable: 1, heard: 2 };
  const old = review.listened[id];
  if (old && rank[old.k] >= rank[k]) return;
  review.listened[id] = { k, t: Date.now() };
  saveReview();
  updateReviewUi();
}
function pendingApprovals() {
  if (!review) return [];
  return Object.entries(review.listened)
    .filter(([id, x]) => x.k !== 'skipped' && byId.has(id) && !reviewDone(id))
    .sort((a, b) => b[1].t - a[1].t);
}
function updateReviewUi() {
  if (!isOwner) { $('approveBtn').hidden = true; return; }
  const n = pendingApprovals().length;
  $('approveBtn').hidden = !n;
  $('approveBtn').textContent = `✅ Approve (${n})`;
  const left = reviewLeft();
  $('reviewBtn').textContent = review && left ? `🎧 Continue review (${left.toLocaleString()} left)` : '🎧 Review run';
}

$('reviewBtn').addEventListener('click', () => {
  if (review && reviewLeft() && confirm(`Continue your review run? ${reviewLeft().toLocaleString()} songs are left.\n\nOK = continue, Cancel = start a new run from the songs shown now.`)) {
    startQueue(review.ids, 'review', Math.max(0, review.i));
    return;
  }
  const ids = shuffle(list.filter((v) => !v.r && !v.z).map((v) => v.id));
  if (!ids.length) { toast('Every song shown here is already approved.'); return; }
  // Songs heard but not approved yet stay waiting for approval.
  review = { ids, i: 0, listened: review ? Object.fromEntries(pendingApprovals()) : {}, startedAt: Date.now() };
  saveReview();
  startQueue(ids, 'review', 0);
  toast(`Review run: ${ids.length.toLocaleString()} songs, shuffled, each played once.`);
});

// The playing song's rating, editable while it plays (owner).
function renderNpRate() {
  const box = $('npRate');
  const id = queue && queue.ids[queue.i];
  const v = id && byId.get(id);
  if (!isOwner || !v) { box.hidden = true; return; }
  const cat = CAT_BY_ID[v.c];
  box.replaceChildren(...[
    h('button', { class: 'cat', 'data-c': v.c, type: 'button', title: 'Change category / flairs',
      onclick: (e) => { e.stopPropagation(); openMenu(v.id, e.currentTarget); } }, cat ? cat.short : '?'),
    starsEl(v),
    h('span', { class: 'np-flairs' }, FLAIRS.filter((x) => (v.f || '').includes(x.id)).map((x) => x.id === 'L' ? 'Long' : '2nd').join(' · ')),
    h('button', { class: v.r ? 'np-ok np-approve on' : 'np-approve', type: 'button', 'aria-pressed': String(!!v.r),
      title: v.r ? `Approved ${dayStr(v.r)}. Click to unapprove.` : 'Approve this rating as it is',
      onclick: () => setApproved(v.id, !v.r) }, v.r ? '✓ Approved' : '✅ Approve'),
  ]);
  box.hidden = false;
}
// One-click approve / unapprove of a single song (the playing one).
async function setApproved(id, on) {
  if (!isOwner || !byId.has(id)) return;
  try {
    await fs.updateDoc(fs.doc(db, 'library', chunkDocId(chunkOf(id))),
      new fs.FieldPath('v', id, 'r'), on ? Date.now() : fs.deleteField());
    if (on && review && review.listened[id]) { delete review.listened[id]; apTicks.delete(id); saveReview(); }
    updateReviewUi();
  } catch (e) {
    toast(`Could not save: ${e.code || e.message}`);
  }
}

// Approve dialog
function renderApprove() {
  const items = pendingApprovals();
  for (const [id, x] of items) if (!apTicks.has(id)) apTicks.set(id, !!x.rated);
  const note = { unplayable: 'could not play here', heard: '' };
  const shown = $('apHideTicked').checked ? items.filter(([id]) => !apTicks.get(id)) : items;
  $('apList').replaceChildren(...shown.map(([id, x]) => {
    const v = byId.get(id);
    const cat = CAT_BY_ID[v.c];
    const box = h('input', { type: 'checkbox', checked: apTicks.get(id) || null,
      onchange: (e) => { apTicks.set(id, e.currentTarget.checked); if ($('apHideTicked').checked) renderApprove(); else countApprove(); } });
    const on = apPreviewId === id;
    return h('li', { class: on ? 'previewing' : '' },
      box,
      h('button', { class: 'ap-play', type: 'button', 'aria-pressed': String(on),
        title: on ? 'Stop' : 'Play it again here', onclick: () => apPreview(on ? null : id) }, on ? '■' : '▶'),
      h('img', { src: thumb(id), alt: '', loading: 'lazy' }),
      h('div', { class: 'ap-text' },
        h('div', { class: 'title', title: v.t }, v.t || id),
        h('div', { class: 'chan' }, [v.a || '', note[x.k] ? ` · ${note[x.k]}` : ''].join(''))),
      h('button', { class: 'cat', 'data-c': v.c, type: 'button', title: 'Change category / flairs',
        onclick: (e) => { e.stopPropagation(); openMenu(id, e.currentTarget); } }, cat ? cat.short : '?'),
      starsEl(v));
  }));
  countApprove();
}
function countApprove() {
  const items = pendingApprovals();
  const n = items.filter(([id]) => apTicks.get(id)).length;
  $('apCount').textContent = `${n} of ${items.length} ticked`;
  $('apGo').textContent = `Approve ticked (${n})`;
  $('apGo').disabled = !n;
}
// Listen to a song again from the Approve dialog. One embed above the list,
// so a re-render (after a rating change) does not restart it.
let apPreviewId = null;
function apPreview(id) {
  apPreviewId = id;
  const v = id && byId.get(id);
  $('apPreview').hidden = !v;
  if (v) {
    if (player.isPlaying()) { userPaused = true; player.pause(); keepAwake(false); }
    $('apFrame').src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
    $('apPreviewTitle').textContent = `${v.t || id} — ${v.a || ''}`;
  } else {
    $('apFrame').removeAttribute('src');
  }
  renderApprove();
}
$('apPreviewStop').addEventListener('click', () => apPreview(null));
$('approveDlg').addEventListener('close', () => { if (apPreviewId) apPreview(null); });
$('approveBtn').addEventListener('click', () => { renderApprove(); $('approveDlg').showModal(); });
$('apHideTicked').addEventListener('change', renderApprove);
$('apAll').addEventListener('click', () => { for (const [id] of pendingApprovals()) apTicks.set(id, true); renderApprove(); });
$('apNone').addEventListener('click', () => { for (const [id] of pendingApprovals()) apTicks.set(id, false); renderApprove(); });
$('apBack').addEventListener('click', () => {
  const back = pendingApprovals().filter(([id]) => !apTicks.get(id)).map(([id]) => id);
  if (!back.length) { toast('Nothing unticked.'); return; }
  requeueReview(back);
  renderApprove();
  updateReviewUi();
  toast(`${back.length} song${back.length === 1 ? '' : 's'} will come round again later in the run.`);
});
$('apGo').addEventListener('click', async () => {
  const ids = pendingApprovals().map(([id]) => id).filter((id) => apTicks.get(id));
  if (!ids.length || !isOwner) return;
  $('apGo').disabled = true;
  const now = Date.now();
  const byChunk = new Map();
  for (const id of ids) {
    const c = chunkDocId(chunkOf(id));
    if (!byChunk.has(c)) byChunk.set(c, []);
    byChunk.get(c).push(id);
  }
  try {
    const batch = fs.writeBatch(db);
    for (const [c, part] of byChunk) {
      batch.update(fs.doc(db, 'library', c), ...part.flatMap((id) => [new fs.FieldPath('v', id, 'r'), now]));
    }
    await batch.commit();
    for (const id of ids) { delete review.listened[id]; apTicks.delete(id); }
    saveReview();
    toast(`Approved ${ids.length} song${ids.length === 1 ? '' : 's'}.`);
    renderApprove();
    updateReviewUi();
    if (!pendingApprovals().length) $('approveDlg').close();
  } catch (e) {
    toast(`Could not save: ${e.code || e.message}`);
  }
  countApprove();
});

// ---------------------------------------------------------------------------
// Bulk edit (owner): stars / category for every song of chosen channels,
// among the songs shown now. Leaves approvals (v.r) alone.
// ---------------------------------------------------------------------------
const bkPicked = new Set();
$('bkStars').replaceChildren(h('option', { value: '' }, 'no change'), ...[5, 4, 3, 2, 1].map((n) => h('option', { value: n }, '★'.repeat(n))));
$('bkCat').replaceChildren(h('option', { value: '' }, 'no change'), ...CATEGORIES.map((c) => h('option', { value: c.id }, c.name)));
const bulkSongs = () => list.filter((v) => !v.z && bkPicked.has(v.a || ''));
function bulkChanges() {
  const s = Number($('bkStars').value) || 0;
  const c = $('bkCat').value;
  return { s, c, songs: bulkSongs().filter((v) => (s && v.s !== s) || (c && v.c !== c)) };
}
function renderBulk() {
  const counts = new Map();
  for (const v of list) if (!v.z) counts.set(v.a || '', (counts.get(v.a || '') || 0) + 1);
  const q = $('bkQ').value.trim().toLowerCase();
  const rows = [...counts]
    .filter(([a]) => bkPicked.has(a) || !q || a.toLowerCase().includes(q))
    .sort((x, y) => bkPicked.has(y[0]) - bkPicked.has(x[0]) || y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, 300);
  $('bkList').replaceChildren(...rows.map(([a, n]) => h('li', {}, h('label', {},
    h('input', { type: 'checkbox', checked: bkPicked.has(a) || null,
      onchange: (e) => { if (e.currentTarget.checked) bkPicked.add(a); else bkPicked.delete(a); countBulk(); } }),
    h('span', { class: 'bk-name', title: a }, a || '(no channel)'),
    h('span', { class: 'n' }, n.toLocaleString())))));
  countBulk();
}
function countBulk() {
  const picked = bulkSongs();
  const stars = {};
  for (const v of picked) stars[v.s] = (stars[v.s] || 0) + 1;
  const mix = Object.keys(stars).sort().reverse().map((k) => `${k}★ ${stars[k]}`).join(', ');
  const { songs } = bulkChanges();
  $('bkCount').textContent = bkPicked.size
    ? `${bkPicked.size} channel${bkPicked.size === 1 ? '' : 's'} · ${picked.length.toLocaleString()} songs (${mix}) · ${songs.length.toLocaleString()} would change`
    : 'No channel ticked.';
  $('bkGo').textContent = `Change ${songs.length.toLocaleString()} song${songs.length === 1 ? '' : 's'}`;
  $('bkGo').disabled = !songs.length;
}
$('bulkBtn').addEventListener('click', () => { $('bkQ').value = ''; renderBulk(); $('bulkDlg').showModal(); });
$('bkQ').addEventListener('input', renderBulk);
for (const id of ['bkStars', 'bkCat']) $(id).addEventListener('change', countBulk);
$('bkClear').addEventListener('click', () => { bkPicked.clear(); renderBulk(); });
$('bkGo').addEventListener('click', async () => {
  const { s, c, songs } = bulkChanges();
  if (!songs.length || !isOwner) return;
  const what = [s ? '★'.repeat(s) : '', c ? CAT_BY_ID[c].name : ''].filter(Boolean).join(' ');
  if (!confirm(`Set ${songs.length.toLocaleString()} songs to ${what}? Approvals are kept.`)) return;
  $('bkGo').disabled = true;
  const now = Date.now();
  const byChunk = new Map();
  for (const v of songs) {
    const k = chunkDocId(chunkOf(v.id));
    if (!byChunk.has(k)) byChunk.set(k, []);
    const args = byChunk.get(k);
    if (s && v.s !== s) args.push(new fs.FieldPath('v', v.id, 's'), s);
    if (c && v.c !== c) args.push(new fs.FieldPath('v', v.id, 'c'), c);
    args.push(new fs.FieldPath('v', v.id, 'u'), now);
  }
  try {
    const batch = fs.writeBatch(db);
    for (const [k, args] of byChunk) batch.update(fs.doc(db, 'library', k), ...args);
    await batch.commit();
    toast(`Changed ${songs.length.toLocaleString()} songs.`);
  } catch (e) {
    toast(`Could not save: ${e.code || e.message}`);
  }
  countBulk();
});

$('prevBtn').addEventListener('click', prev);
$('nextBtn').addEventListener('click', () => next());
$('ppBtn').addEventListener('click', togglePlay);
$('queueBtn').addEventListener('click', () => {
  $('queueList').hidden = !$('queueList').hidden;
  refreshQueueList();
  document.body.style.setProperty('--dock-h', `${$('dock').offsetHeight}px`);
});
$('closeDock').addEventListener('click', () => {
  $('dock').hidden = true;
  document.body.style.setProperty('--dock-h', '0px');
  player.stop();
  userPaused = true;
  keepAwake(false);
  for (const el of document.querySelectorAll('.card.playing')) el.classList.remove('playing');
});

// Keyboard: space play/pause, arrows next/prev, ctrl+arrows seek, 0-9 jump.
document.addEventListener('keydown', (e) => {
  if ($('dock').hidden) return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || e.altKey || e.metaKey) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
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

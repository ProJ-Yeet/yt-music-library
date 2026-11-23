// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bucketKey, bucketName, parseBucketKey, withAutoFlairs, normFlairs, chunkOf, CHUNKS,
  matches, shuffle, shuffleUnheard, filtersToHash, hashToFilters, formatDuration,
} from '../js/model.js';

const DAY = 86400000;

test('bucket keys combine stars, category and sorted flairs', () => {
  assert.equal(bucketKey({ s: 4, c: 'song', f: '' }), '4-song');
  assert.equal(bucketKey({ s: 3, c: 'song', f: 'SL' }), '3-song-LS');
  assert.deepEqual(parseBucketKey('3-relax-L'), { s: 3, c: 'relax', f: 'L' });
  assert.equal(bucketName('3-song-LS'), '3★ Song · Long · Secondary');
  assert.equal(bucketName('5-hololive'), '5★ Hololive');
});

test('long flair is added past 15 minutes and never removed', () => {
  assert.equal(withAutoFlairs('', 900), '');
  assert.equal(withAutoFlairs('', 901), 'L');
  assert.equal(withAutoFlairs('S', 2000), 'LS');
  assert.equal(withAutoFlairs('L', 60), 'L');
  assert.equal(normFlairs('XSLS'), 'LS');
});

test('chunkOf is stable and in range', () => {
  for (const id of ['dQw4w9WgXcQ', '-abc_123XYZ', 'zzzzzzzzzzz']) {
    const c = chunkOf(id);
    assert.ok(c >= 0 && c < CHUNKS);
    assert.equal(chunkOf(id), c);
  }
});

test('filters', () => {
  const v = { t: 'Blue Bird', a: 'Ikimonogakari', d: 1000, c: 'song', s: 4, f: 'L' };
  const base = { cats: new Set(), stars: new Set(), long: 'any', secondary: 'any', minMin: null, maxMin: null, q: '' };
  assert.ok(matches(v, base));
  assert.ok(matches(v, { ...base, cats: new Set(['song', 'pop']) }));
  assert.ok(!matches(v, { ...base, cats: new Set(['pop']) }));
  assert.ok(!matches(v, { ...base, stars: new Set([5]) }));
  assert.ok(!matches(v, { ...base, long: 'no' }));
  assert.ok(matches(v, { ...base, long: 'only' }));
  assert.ok(!matches(v, { ...base, secondary: 'only' }));
  assert.ok(matches(v, { ...base, q: 'bird ikimono' }));
  assert.ok(!matches(v, { ...base, q: 'red' }));
  assert.ok(!matches(v, { ...base, maxMin: 10 }));
});

test('plain shuffle keeps every id', () => {
  const ids = Array.from({ length: 50 }, (_, i) => 'v' + i);
  assert.deepEqual(shuffle(ids).slice().sort(), ids.slice().sort());
});

test('shuffle unheard: cooling songs go last, oldest first', () => {
  const now = 100 * DAY;
  const heard = { a: now - 1 * DAY, b: now - 3 * DAY, c: now - 60 * DAY };
  const { order, fresh } = shuffleUnheard(['a', 'b', 'c', 'd'], heard, { now, cooldownDays: 7 });
  assert.equal(fresh, 2); // c (long cooled) and d (never heard)
  assert.deepEqual(new Set(order.slice(0, 2)), new Set(['c', 'd']));
  assert.deepEqual(order.slice(2), ['b', 'a']);
});

test('shuffle unheard: a batch heard together comes back spread out', () => {
  const now = 100 * DAY;
  const at = now - 8 * DAY; // just past a 7-day cool-down
  const ids = Array.from({ length: 200 }, (_, i) => 'song' + i);
  const heard = Object.fromEntries(ids.map((id) => [id, at]));
  const { fresh } = shuffleUnheard(ids, heard, { now, cooldownDays: 7 });
  // Per-song jitter stretches cool-downs to 7–10.5 days, so only part of
  // the batch is back after 8 days.
  assert.ok(fresh > 20 && fresh < 180, `fresh=${fresh}`);
});

test('shuffle unheard prefers never-heard songs over recently cooled ones', () => {
  const now = 1000 * DAY;
  const ids = [];
  const heard = {};
  for (let i = 0; i < 300; i++) ids.push('new' + i);
  for (let i = 0; i < 300; i++) { ids.push('old' + i); heard['old' + i] = now - 11 * DAY; }
  const { order } = shuffleUnheard(ids, heard, { now, cooldownDays: 7, rng: Math.random });
  const firstHundred = order.slice(0, 100);
  const newCount = firstHundred.filter((id) => id.startsWith('new')).length;
  assert.ok(newCount > 65, `newCount=${newCount}`);
});

test('share hash round-trips', () => {
  const flt = { cats: new Set(['song', 'pop']), stars: new Set([4, 5]), long: 'no', secondary: 'any', minMin: 2, maxMin: null, q: 'blue' };
  const back = hashToFilters('#' + filtersToHash(flt, { mode: 'unheard' }));
  assert.deepEqual([...back.filters.cats], ['song', 'pop']);
  assert.deepEqual([...back.filters.stars], [4, 5]);
  assert.equal(back.filters.long, 'no');
  assert.equal(back.filters.minMin, 2);
  assert.equal(back.filters.maxMin, null);
  assert.equal(back.filters.q, 'blue');
  assert.equal(back.params.get('mode'), 'unheard');
});

test('formatDuration', () => {
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3725), '1:02:05');
});

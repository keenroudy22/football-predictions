'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Shuffle = require('../site/shuffle.js');
const Board = require('../site/board.js');
const now = Date.parse('2026-09-17T16:00:00Z');
const row = (key, extra = {}) => ({ key, title: `${key} OVER 4.5 receptions`, subject: key, athleteId: key, league: 'NFL', gameId: 'NFL-1', gameState: 'pre', kickoff: '2026-09-20T17:00:00Z', market: 'receptions', marketWindow: 'Full game', direction: 'OVER', line: 4.5, book: 'DraftKings', odds: -110, status: 'current', quoteType: 'sportsbook', sourceType: 'market', quotedAt: '2026-09-17T15:30:00Z', expiresAt: '2026-09-17T17:00:00Z', source: 'https://example.com/quote', ...extra });
const stable = () => .999;
const keys = value => value.rows.map(item => item.key).sort();

test('same-game current lines form a personal draft without inventing a combined price', () => {
  const result = Shuffle.generate([row('a'), row('b')], { mode: 'current' }, now, stable);
  assert.equal(result.available, true); assert.equal(result.quoteMode, 'current'); assert.deepEqual(keys(result), ['a', 'b']);
  assert.equal(Board.summarizeTicket(result.rows, 1, 'units', 1, now).available, false);
  assert.equal(result.odds, undefined); assert.match(result.reason, /sportsbook must quote/);
});

test('ideas may use sourced expired prices but current mode rejects them and keeps the old draft', () => {
  const catalog = [row('a', { status: 'stale' }), row('b', { expiresAt: '2026-09-17T15:00:00Z', quoteType: 'comparison feed' })];
  const ideas = Shuffle.generate(catalog, {}, now, stable); assert.equal(ideas.available, true); assert.equal(ideas.quoteMode, 'ideas'); assert.equal(ideas.odds, undefined);
  const previous = [row('old')], current = Shuffle.generate(catalog, { mode: 'current', previous }, now, stable);
  assert.equal(current.available, false); assert.deepEqual(current.rows, previous);
});

test('closed, paused, unknown, unpriced, unsafe and partial-game lines cannot enter ideas', () => {
  const invalid = [{ gameState: 'in' }, { gameState: null }, { kickoff: '2026-09-17T16:00:00Z' }, { gameCompleted: true }, { entryNote: 'Entries paused.' }, { status: 'withdrawn' }, { gameId: null }, { odds: null }, { odds: true }, { odds: 0 }, { source: 'javascript:bad' }, { source: 'https://' }, { quotedAt: null }, { quotedAt: '2026-09-17T18:00:00Z' }, { marketWindow: '1Q' }, { marketWindow: '1H' }];
  for (const extra of invalid) {
    const result = Shuffle.generate([row('good'), row('bad', extra)], {}, now, stable);
    assert.equal(result.available, false, JSON.stringify(extra));
  }
});

test('league, football week, game and normalized sportsbook filters apply before sampling', () => {
  const catalog = [row('a', { book: 'Draft Kings' }), row('b'), row('fd', { book: 'FanDuel' }), row('other-game', { gameId: 'NFL-2' }), row('later', { kickoff: '2026-09-29T00:15:00Z' }), row('nba', { league: 'NBA' })];
  const result = Shuffle.generate(catalog, { league: 'NFL', week: '2026-09-15', game: 'NFL-1', book: 'DraftKings' }, now, () => 0);
  assert.equal(result.available, true); assert.deepEqual(keys(result), ['a', 'b']);
});

test('college lines require verified Indiana availability even in ideas mode', () => {
  const a = row('a', { league: 'CFB' }), b = row('b', { league: 'CFB' });
  assert.equal(Shuffle.generate([a, b], { league: 'CFB' }, now, stable).available, false);
  const jurisdiction = { state: 'IN', status: 'verified', allowed: true, source: 'https://example.com/rules' };
  assert.equal(Shuffle.generate([{ ...a, jurisdiction }, { ...b, jurisdiction }], { league: 'CFB' }, now, stable).available, true);
});

test('same athlete, aliases and opposing team/game markets cannot be combined', () => {
  for (const pair of [[row('a'), row('b', { athleteId: 'a', market: 'receiving yards', line: 50.5 })], [row('a', { subject: 'D.J. Moore', athleteId: null }), row('b', { subject: 'DJ Moore', athleteId: null })], [row('a', { position: 'Game', market: 'Total points' }), row('b', { position: 'Game', market: 'Total points', direction: 'UNDER' })], [row('a', { kind: 'gamePicks', subject: 'Away', market: 'Spread' }), row('b', { kind: 'gamePicks', subject: 'Home', market: 'Moneyline' })]]) {
    assert.equal(Shuffle.generate(pair, {}, now, stable).available, false);
  }
  assert.equal(Shuffle.generate([row('a'), row('b', { book: 'FanDuel' })], { book: 'all' }, now, stable).available, false);
});

test('locked rows survive a successful shuffle and previous combination is avoided', () => {
  const a = row('a'), b = row('b'), c = row('c');
  const result = Shuffle.generate([a, b, c], { locked: [a], previous: [a, b] }, now, stable);
  assert.equal(result.available, true); assert.deepEqual(keys(result), ['a', 'c']); assert.equal(result.rows[0], a);
});

test('invalid or repriced locks fail without erasing or silently replacing previous selections', () => {
  const a = row('a'), b = row('b'), previous = [a, b];
  for (const catalog of [[{ ...a, odds: 125 }, b], [{ ...a, status: 'withdrawn' }, b], [b]]) {
    const result = Shuffle.generate(catalog, { locked: [a], previous }, now, stable);
    assert.equal(result.available, false); assert.deepEqual(result.rows, previous); assert.match(result.reason, /locked leg/);
  }
});

test('when no alternative exists the intact draft is returned with an explicit reason', () => {
  const previous = [row('a'), row('b')];
  const result = Shuffle.generate(previous, { previous }, now, stable);
  assert.equal(result.available, true); assert.deepEqual(keys(result), ['a', 'b']); assert.match(result.reason, /only compatible combination found/);
});

test('target odds only select priceable current quotes from different games', () => {
  const a = row('a', { odds: -200 }), same = row('same'), b = row('b', { gameId: 'NFL-2', odds: 150 }), c = row('c', { gameId: 'NFL-3', odds: 500 });
  const result = Shuffle.generate([a, same, b, c], { mode: 'current', target: 275 }, now, stable);
  assert.equal(result.available, true); assert.deepEqual(keys(result), ['a', 'b']); assert.equal(Board.summarizeTicket(result.rows, 1, 'money', 1, now).odds, 275);
  assert.match(result.reason, /Closest compatible draft found in this shuffle: illustrative \+275 \(target \+275\)/);
  assert.equal(Shuffle.generate([a, same], { mode: 'current', target: 275 }, now, stable).available, false);
  assert.equal(Shuffle.generate([a, b], { mode: 'ideas', target: 275 }, now, stable).available, false);
  assert.equal(Shuffle.generate([a, b], { mode: 'current', target: -150 }, now, stable).available, false);
  const distant = Shuffle.generate([a, b], { mode: 'current', target: 10000 }, now, stable);
  assert.match(distant.reason, /illustrative \+275 \(target \+10000\)/); assert.doesNotMatch(distant.reason, /near your target/);
});

test('ideas need dated source observations and reject omissions or future observations', () => {
  const a = row('a'), reference = row('b', { quotedAt: null, status: 'reference', quoteType: 'comparison feed' });
  assert.equal(Shuffle.generate([a, reference], {}, now, stable).available, false);
  assert.equal(Shuffle.generate([a, { ...reference, observedAt: '2026-09-17T18:00:00Z' }], {}, now, stable).available, false);
  assert.equal(Shuffle.generate([a, { ...reference, observedAt: '2026-09-16T18:00:00Z' }], {}, now, stable).available, true);
});

test('two to four unique legs and deterministic random sampling respect the bounded pool', () => {
  const catalog = Array.from({ length: 100 }, (_, i) => row(`p${i}`, { gameId: `NFL-${i}` }));
  const first = Shuffle.generate(catalog, { count: 4 }, now, stable), changed = Shuffle.generate(catalog, { count: 4 }, now, () => 0);
  assert.equal(first.rows.length, 4); assert.equal(new Set(first.rows.map(r => r.key)).size, 4); assert.notDeepEqual(keys(first), keys(changed));
  assert.deepEqual(keys(first), keys(Shuffle.generate(catalog, { count: 4 }, now, stable)));
  for (const count of [1, 5, null, true, 2.5]) assert.equal(Shuffle.generate(catalog, { count }, now, stable).available, false);
});

test('missing capacity or invalid randomness preserves a nonempty personal draft', () => {
  const previous = [row('old-a'), row('old-b')];
  const result = Shuffle.generate([row('a')], { count: 4, previous }, now, stable); assert.equal(result.available, false); assert.deepEqual(result.rows, previous);
  const randomFailure = Shuffle.generate([row('a'), row('b')], { previous }, now, () => NaN); assert.equal(randomFailure.available, false); assert.deepEqual(randomFailure.rows, previous);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../site/core.js');

const KEYS = ['recYds', 'rec', 'recLong', 'snapPct'];
// [eventId, date, season, week, seasonType, team, opp, home, ...stats]
const row = (date, opp, home, recYds, rec, extra = {}) =>
  ['e' + date, date, Number(date.slice(0, 4)), 1, 2, '1', opp, home, recYds, rec, extra.recLong ?? null, extra.snapPct ?? null];

test('text helpers escape markup and format numbers without claiming precision', () => {
  assert.equal(C.esc('<b>"x" & y</b>'), '&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
  assert.equal(C.odds(150), '+150');
  assert.equal(C.odds(-110), '-110');
  assert.equal(C.odds(null), C.DASH);
  assert.equal(C.signed(2.25), '+2.3');
  assert.equal(C.signed(-3), '-3.0');
  assert.equal(C.signed(0), '0.0');
  assert.equal(C.spreadText('ATL', 2.5), 'ATL +2.5');
  assert.equal(C.spreadText('ATL', -3), 'ATL -3');
  assert.equal(C.spreadText('ATL', 0), 'ATL PK');
  assert.equal(C.modelSpread('ATL', 'CAR', 4.3), 'ATL -4.3');
  assert.equal(C.modelSpread('ATL', 'CAR', -2), 'CAR -2.0');
  assert.equal(C.modelSpread('ATL', 'CAR', 0.01), 'Even');
});

test('leans name the team and the total direction the model prefers', () => {
  const game = { home: { abbr: 'ATL' }, away: { abbr: 'CAR' }, lean: { spread: 6.8, side: 'home', total: -2.3 } };
  assert.deepEqual(C.leanText(game), { side: { team: 'ATL', points: 6.8 }, total: { direction: 'Under', points: 2.3 } });
  assert.deepEqual(C.leanText({ ...game, lean: { spread: 1, side: 'home', total: 0.5 } }, 2), {});
  assert.equal(C.leanText({ home: {}, away: {} }), null);
});

test('windows count back from the newest game and report their true sample', () => {
  const rows = [row('2025-09-07', '2', 1, 50, 4), row('2025-09-14', '3', 0, 80, 6), row('2026-09-10', '4', 1, 120, 9)];
  const w = C.windows(rows, KEYS, 'recYds', [2, 5]);
  assert.equal(w.last2.n, 2);
  assert.equal(w.last2.avg, 100);
  assert.equal(w.last5.n, 3);
  assert.equal(w.season.n, 1, 'the season is the newest game’s season');
  assert.equal(w.season.avg, 120);
});

test('a listed player without a counting stat had zero, but longest and snaps stay unknown', () => {
  const r = row('2026-09-10', '4', 1, null, null);
  assert.equal(C.cell(r, KEYS, 'recYds'), 0);
  assert.equal(C.cell(r, KEYS, 'recLong'), null);
  assert.equal(C.cell(r, KEYS, 'snapPct'), null);
  assert.equal(C.cell(r, KEYS, 'notAKey'), null);
});

test('splits separate home, away and neutral and list head-to-head meetings', () => {
  const rows = [row('2025-09-07', '2', 1, 50, 4), row('2025-09-14', '2', 0, 80, 6), row('2026-01-04', '3', -1, 20, 1)];
  const s = C.splits(rows, KEYS, 'recYds', '2');
  assert.equal(s.home.avg, 50);
  assert.equal(s.away.avg, 80);
  assert.equal(s.neutral.avg, 20);
  assert.equal(s.vs.summary.n, 2);
  assert.deepEqual(s.vs.games.map(g => g.value), [50, 80]);
  assert.deepEqual(C.hits([50, 80, 20, 60.5], 60.5), { over: 1, under: 2, push: 1, n: 4 });
});

test('defense ranks put the stingiest first, share ranks on ties and ignore missing rows', () => {
  const rows = { A: { g: 2, WR: { recYds: 150 } }, B: { g: 2, WR: { recYds: 100 } }, C: { g: 2, WR: { recYds: 150 } }, D: { g: 2, TE: { recYds: 40 } } };
  const ranked = C.rankDefenses(rows, 'WR', 'recYds');
  assert.deepEqual(ranked.map(r => [r.team, r.rank]), [['B', 1], ['A', 2], ['C', 2]]);
  assert.deepEqual(C.rankOf(rows, 'C', 'WR', 'recYds'), { rank: 2, of: 3, value: 150 });
  assert.equal(C.rankOf(rows, 'D', 'WR', 'recYds'), null);
  assert.equal(C.rankTone(30, 32), 'soft');
  assert.equal(C.rankTone(3, 32), 'tough');
  assert.equal(C.rankTone(16, 32), 'neutral');
});

const now = Date.parse('2026-09-19T12:00:00Z');
const leg = (id, odds, extra = {}) => ({ id, odds, book: 'DraftKings', gameId: 'NFL-' + id, state: 'open', kickoff: '2026-09-20T17:00:00Z', title: 'Leg ' + id, ...extra });

test('an illustrative parlay multiplies separate-game prices at one book', () => {
  const t = C.summarizeTicket([leg('1', -110), leg('2', 150)], 1, 'units', 10, now);
  assert.equal(t.available, true);
  assert.ok(Math.abs(t.decimal - (1 + 100 / 110) * 2.5) < 1e-9);
  assert.equal(t.odds, 377);
  assert.ok(Math.abs(t.dollars.profit - 37.73) < 0.01);
  assert.equal(C.american(2), 100);
  assert.equal(C.american(1.5), -200);
});

test('a ticket refuses what the sportsbook would price differently or not at all', () => {
  const reason = rows => C.summarizeTicket(rows, 1, 'units', 10, now).reason;
  assert.match(reason([leg('1', -110)]), /at least two/);
  assert.match(reason([leg('1', -110), leg('2', 150, { book: 'FanDuel' })]), /Mixed sportsbooks/);
  assert.match(reason([leg('1', -110), leg('2', 150, { gameId: 'NFL-1' })]), /Same-game/);
  assert.match(reason([leg('1', -110), leg('2', 150, { kickoff: '2026-09-18T17:00:00Z' })]), /current, priced/);
  assert.match(reason([leg('1', -110), leg('2', null)]), /current, priced/);
  assert.match(C.summarizeTicket([leg('1', -110), leg('2', 150)], 0, 'units', 10, now).reason, /positive stake/);
  assert.match(C.ticketText([leg('1', -110)]), /not an official ticket/);
});

test('the record counts priced picks only and withholds ROI below ten', () => {
  const picks = [
    { result: 'win', odds: 150 }, { result: 'loss', odds: -110 }, { result: 'push', odds: -110 },
    { result: 'win', odds: null }, { result: 'void', odds: -110 }, { result: null, odds: -110 }];
  const r = C.recordOf(picks);
  assert.equal(r.wins, 2);
  assert.equal(r.losses, 1);
  assert.equal(r.priced, 3, 'an unpriced win and a void never enter returns');
  assert.deepEqual([r.pricedWins, r.pricedLosses, r.unpriced], [1, 1, 1]);
  assert.ok(Math.abs(r.units - 0.5) < 1e-9);
  assert.equal(r.roi, null);
  assert.equal(r.pending, 1);
  const ten = Array.from({ length: 10 }, (_, i) => ({ result: i < 6 ? 'win' : 'loss', odds: 100 }));
  assert.equal(C.recordOf(ten).roi, 20);
});

test('the Week 1 import counts in the win-loss record but claims no units', () => {
  const fs = require('node:fs');
  const report = JSON.parse(fs.readFileSync('research/2026-09-14-NFL-week-1-import.json', 'utf8'));
  const five = new Set(['w1-loveland-rec', 'w1-mayfield-pass', 'w1-otton-rec', 'w1-pollard-carries', 'w1-bateman-rec']);
  const picks = ['props', 'riskyProps', 'gamePicks', 'parlays'].flatMap(k => report[k] || []);
  const all = C.recordOf(picks), favorites = C.recordOf(picks.filter(p => five.has(p.id)));
  assert.equal(picks.length, 26);
  assert.equal(all.priced, 0);
  assert.equal(all.units, null, 'no price was recorded, so no return is claimed');
  assert.equal(all.unpriced, all.wins + all.losses + all.pushes);
  assert.deepEqual([favorites.wins, favorites.losses], [1, 4]);
});

test('pick types match the old results page', () => {
  assert.equal(C.category({ kind: 'gamePicks', marketType: 'total' }), 'Totals');
  assert.equal(C.category({ kind: 'gamePicks', marketType: 'spread' }), 'Spreads');
  assert.equal(C.category({ kind: 'props' }), 'Straights');
  assert.equal(C.category({ kind: 'riskyProps' }), 'Risky lines');
  assert.equal(C.category({ kind: 'parlays', parlayType: 'longshot' }), 'Longshots');
  assert.equal(C.category({ kind: 'parlays' }), 'Parlays');
});

test('old links land on the matching new pages', () => {
  const cases = {
    '': { view: 'today' }, '#sports': { view: 'today' }, '#home': { view: 'today' },
    '#record': { view: 'record' }, '#scores': { view: 'games' }, '#props': { view: 'board' }, '#parlays': { view: 'ticket' },
    '#players': { view: 'stats' }, '#research': { view: 'research' }, '#game/NFL-401872932': { view: 'game', id: 'NFL-401872932' },
    '#player/NFL/4430878': { view: 'player', league: 'NFL', id: '4430878' }, '#player/cfb/5': { view: 'player', league: 'CFB', id: '5' },
    '#sport/MLB': { view: 'scores', league: 'MLB' }, '#stats/defense': { view: 'stats', tab: 'defense' },
    '#team/CFB/2390': { view: 'team', league: 'CFB', id: '2390' }, '#nonsense': { view: 'today' },
  };
  for (const [hash, expected] of Object.entries(cases)) assert.deepEqual(C.parseRoute(hash), expected, hash);
  assert.equal(C.shardOf('4430878', 32), 4430878 % 32);
});

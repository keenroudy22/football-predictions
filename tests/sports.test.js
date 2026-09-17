const test = require('node:test');
const assert = require('node:assert/strict');
const sports = require('../site/sports.js');
const now = Date.parse('2026-09-17T16:00:00Z');
const game = { id: 'MLB-1', league: 'MLB', date: '2026-09-17', kickoff: '2026-09-17T20:00:00Z', status: 'scheduled', teams: { away: { name: 'Away club', abbreviation: 'AWY' }, home: { name: 'Home club', abbreviation: 'HME' } }, scores: { away: 0, home: 0 }, source: { url: 'https://www.espn.com/mlb/game/_/gameId/1' } };
const snapshot = { status: 'ok', lastSuccessfulAt: '2026-09-17T15:30:00Z', window: { from: '2026-09-17', through: '2026-09-19' }, source: { url: 'https://www.espn.com/mlb/scoreboard' }, games: [game] };
const football = { id: 'NFL-1', league: 'NFL', state: 'pre', kickoff: '2026-09-18T00:15:00Z', away: { short: 'Lions' }, home: { short: 'Bills' } };
const pick = { id: 'favorite', favorite: true, status: 'active', title: 'Player OVER 29.5 receiving yards', gameIds: ['NFL-1'], odds: -115, book: 'DraftKings', confidence: 6, projection: 33, quotedAt: '2026-09-17T15:30:00Z', expiresAt: '2026-09-17T16:30:00Z', cutoff: '29.5 at -115 or better only.' };
const state = props => ({ slate: { games: [football] }, reports: [{ league: 'NFL', publishedAt: '2026-09-17T15:35:00Z', props }] });

test('sports routes do not capture existing football routes', () => {
  for (const route of ['', '#sports', '#sport/NBA', '#sport/MLB']) assert.equal(sports.matches(route), true);
  for (const route of ['#props', '#record', '#game/NFL-1', '#scores', '#sport/NFL', '#sport/anything']) assert.equal(sports.matches(route), false);
});
test('pre-game scoreboard never presents seed zeroes as actual scores', () => {
  const html = sports.scoreCard(game);
  assert.equal((html.match(/<strong>—<\/strong>/g) || []).length, 2);
  assert.doesNotMatch(html, /<strong>0<\/strong>/);
  const final = sports.scoreCard({ ...game, status: 'final', scores: { away: 0, home: 3 } });
  assert.match(final, /<strong>0<\/strong>/); assert.match(final, /<strong>3<\/strong>/); assert.match(final, /Final/);
});
test('feed failures and old snapshots cannot look fresh', () => {
  assert.equal(sports.freshness(snapshot, now).warning, false);
  assert.equal(sports.freshness({ ...snapshot, status: 'stale' }, now).warning, true);
  assert.equal(sports.freshness({ ...snapshot, lastSuccessfulAt: '2026-09-16T15:30:00Z' }, now).warning, true);
  assert.equal(sports.freshness(null, now).warning, true);
  assert.match(sports.leagueHTML('MLB', null, now), /not fully available/);
});
test('honest empty league does not imply missing picks or publish fabricated coverage', () => {
  const html = sports.leagueHTML('NBA', { ...snapshot, games: [] }, now);
  assert.match(html, /No games on this board/); assert.match(html, /Picks and forecasts are not enabled for NBA/);
  assert.doesNotMatch(html, /NaN|Invalid Date|undefined/);
});
test('a failed football feed is not presented as a verified empty slate', () => {
  const html = sports.homeHTML({ footballError: true, slate: { games: [] }, reports: [] }, { leagues: { MLB: snapshot } }, now);
  assert.match(html, /Football feed unavailable/); assert.match(html, /have not been verified on this visit/);
  assert.doesNotMatch(html, /No football games listed today/); assert.match(html, /Away club/);
});
test('active favorite outranks expired higher confidence and points to its game', () => {
  const expired = { ...pick, id: 'expired', confidence: 9, title: 'Old player OVER 3.5 receptions', status: 'expired' };
  assert.equal(sports.latestFavorite(state([expired, pick]), now).id, pick.id);
  const html = sports.homeHTML(state([expired, pick]), { leagues: { MLB: snapshot } }, now);
  assert.match(html, /href="#game\/NFL-1"/); assert.match(html, /Price limit:/); assert.match(html, /29.5 at -115 or better/);
  assert.match(html, /Verified quote/); assert.doesNotMatch(html, /Old player/);
});
test('expired status overrides a future expiry and finished games drop out of favorites', () => {
  const html = sports.homeHTML(state([{ ...pick, status: 'expired' }]), {}, now);
  assert.match(html, /price recheck needed/); assert.doesNotMatch(html, /Verified quote/);
  const done = state([pick]); done.slate.games[0] = { ...football, state: 'in' };
  assert.equal(sports.latestFavorite(done, now), null);
});
test('dates filter the scoreboard without merging different events or doubleheaders', () => {
  const tomorrow = { ...game, id: 'MLB-2', date: '2026-09-18', kickoff: '2026-09-18T20:00:00Z' };
  const doubleheader = { ...game, id: 'MLB-3', kickoff: '2026-09-17T23:00:00Z' };
  const html = sports.leagueHTML('MLB', { ...snapshot, games: [game, tomorrow, doubleheader] }, now, '2026-09-17');
  assert.equal((html.match(/class="sports-scorecard"/g) || []).length, 2);
  assert.match(html, /aria-pressed="true">Today/);
});
test('TBD and delayed games retain their actual source status', () => {
  assert.match(sports.scoreCard({ ...game, timeConfirmed: false }), /Time TBD/);
  assert.match(sports.scoreCard({ ...game, status: 'delayed' }), /Delayed/);
  assert.match(sports.scoreCard({ ...game, status: 'suspended' }), /Suspended/);
});
test('external source strings are escaped and only HTTPS links are emitted', () => {
  const html = sports.scoreCard({ ...game, teams: { away: { name: '<script>bad()</script>' } }, source: { url: 'javascript:alert(1)' } });
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|href="javascript:/);
});

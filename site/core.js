/* KeenRoudy Sports core: formatting, stat windows, ranks, ticket and record math,
   routes. Pure functions with no DOM access, shared by the browser app and the
   Node tests. Every number shown comes from the pipeline's payloads; this file
   only summarizes them. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KRCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- text ---------- */

  const esc = value => String(value ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const DASH = '–';  // en dash for empty cells and ranges
  const odds = value => value == null || value === '' ? DASH : (Number(value) > 0 ? '+' + Number(value) : String(value));
  const signed = (value, places = 1) => {
    if (value == null || Number.isNaN(Number(value))) return DASH;
    const n = Number(value);
    const text = Number.isInteger(n) && places === 0 ? String(n) : n.toFixed(places);
    return n > 0 ? '+' + text : text;
  };
  const fixed = (value, places = 1) => value == null || Number.isNaN(Number(value)) ? DASH : Number(value).toFixed(places);
  const pct = (value, places = 0) => value == null ? DASH : (100 * value).toFixed(places) + '%';

  const ET = 'America/New_York';
  const date = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : d; };
  const when = iso => {
    const d = date(iso);
    return d ? d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: ET }) + ' ET' : '';
  };
  const whenShort = iso => {
    const d = date(iso);
    return d ? d.toLocaleString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: ET }).replace(',', '') : '';
  };
  const dayLabel = iso => {
    const d = date(iso);
    return d ? d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: ET }) : '';
  };
  const ago = (iso, now = Date.now()) => {
    const d = date(iso);
    if (!d) return 'time not recorded';
    const mins = Math.round((now - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    const days = Math.round(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  };

  /* A home spread as the book writes it: -3.5 means the home team gives 3.5. */
  const spreadText = (abbr, spread) => spread == null ? DASH : `${abbr} ${spread > 0 ? '+' : ''}${spread === 0 ? 'PK' : spread}`;

  /* The model's margin written as a spread for the side it favors. */
  const modelSpread = (home, away, margin) => {
    if (margin == null) return DASH;
    if (Math.abs(margin) < 0.05) return 'Even';
    return margin > 0 ? `${home} -${Math.abs(margin).toFixed(1)}` : `${away} -${Math.abs(margin).toFixed(1)}`;
  };

  /* Where the model sits against the market, in plain words. */
  const leanText = (game, threshold = 0) => {
    const lean = game && game.lean;
    if (!lean) return null;
    const out = {};
    if (lean.spread != null && Math.abs(lean.spread) >= threshold && lean.side) {
      out.side = { team: lean.side === 'home' ? game.home.abbr : game.away.abbr, points: Math.abs(lean.spread) };
    }
    if (lean.total != null && Math.abs(lean.total) >= threshold && lean.total !== 0) {
      out.total = { direction: lean.total > 0 ? 'Over' : 'Under', points: Math.abs(lean.total) };
    }
    return out;
  };

  /* ---------- stat windows ---------- */

  /* Log rows are arrays: [eventId, date, season, week, seasonType, team, opp, home, ...stats]. */
  const BASE = 8;
  const column = (keys, key) => { const i = keys.indexOf(key); return i < 0 ? -1 : BASE + i; };
  const LONGEST = new Set(['rushLong', 'recLong']);
  /* A listed player without a counting stat recorded none; longest plays and snaps have no zero. */
  const cell = (row, keys, key) => {
    const i = column(keys, key);
    if (i < 0) return null;
    const v = row[i];
    if (v == null) return LONGEST.has(key) || key === 'snaps' || key === 'snapPct' ? null : 0;
    return v;
  };

  const summarize = values => {
    const list = values.filter(v => v != null && !Number.isNaN(v));
    if (!list.length) return null;
    const sorted = [...list].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return { n: list.length, avg: list.reduce((a, b) => a + b, 0) / list.length, median, min: sorted[0], max: sorted[sorted.length - 1] };
  };

  /* Last-N windows counting back from the newest game; short logs report their true n. */
  const windows = (rows, keys, key, sizes = [5, 10, 20], filter = null) => {
    const list = (filter ? rows.filter(filter) : rows).slice().sort((a, b) => String(b[1]).localeCompare(String(a[1])));
    const values = list.map(r => cell(r, keys, key));
    const out = {};
    for (const size of sizes) out['last' + size] = summarize(values.slice(0, size));
    out.season = null;
    if (list.length) {
      const season = list[0][2];
      out.season = summarize(list.filter(r => r[2] === season).map(r => cell(r, keys, key)));
    }
    return out;
  };

  const splits = (rows, keys, key, opponent = null) => {
    const pick = test => summarize(rows.filter(test).map(r => cell(r, keys, key)));
    const out = { home: pick(r => r[7] === 1), away: pick(r => r[7] === 0), neutral: pick(r => r[7] === -1) };
    if (opponent != null) {
      const meetings = rows.filter(r => String(r[6]) === String(opponent));
      out.vs = { summary: summarize(meetings.map(r => cell(r, keys, key))), games: meetings.map(r => ({ eventId: r[0], date: r[1], value: cell(r, keys, key) })) };
    }
    return out;
  };

  /* Over/under counts against a line, for describing history (not a probability). */
  const hits = (values, line) => {
    const list = values.filter(v => v != null);
    return { over: list.filter(v => v > line).length, under: list.filter(v => v < line).length, push: list.filter(v => v === line).length, n: list.length };
  };

  /* Which stats matter for a position, in display order. */
  const POSITION_STATS = {
    QB: ['passYds', 'cmp', 'att', 'passTD', 'int', 'rushYds', 'car'],
    RB: ['rushYds', 'car', 'recYds', 'rec', 'targets', 'rzCar'],
    FB: ['rushYds', 'car', 'recYds', 'rec', 'targets'],
    WR: ['recYds', 'rec', 'targets', 'rzTgt', 'recLong'],
    TE: ['recYds', 'rec', 'targets', 'rzTgt', 'recLong'],
    PK: ['kPts', 'fgm', 'fga', 'xpm'],
  };
  const LABEL = {
    passYds: 'Pass yds', cmp: 'Completions', att: 'Attempts', passTD: 'Pass TD', int: 'INT', sacks: 'Sacked',
    rushYds: 'Rush yds', car: 'Carries', rushTD: 'Rush TD', rushLong: 'Long rush', targets: 'Targets', rec: 'Receptions',
    recYds: 'Rec yds', recTD: 'Rec TD', recLong: 'Long rec', rzTgt: 'RZ targets', i10Tgt: 'Inside-10 tgts',
    rzCar: 'RZ carries', i10Car: 'Inside-10 car', i5Car: 'Inside-5 car', scrambles: 'Scrambles', fumLost: 'Fum lost',
    fgm: 'FG made', fga: 'FG att', xpm: 'XP made', kPts: 'Kick pts', snaps: 'Snaps', snapPct: 'Snap %',
    receptions: 'Receptions', carries: 'Carries',
  };
  /* Projection stats and the prop market key each lines up with. */
  const PROJECTION_MARKET = { receptions: 'rec', recYds: 'recYds', carries: 'car', rushYds: 'rushYds', att: 'att', cmp: 'cmp', passYds: 'passYds' };

  /* ---------- defense ranks ---------- */

  /* Rank defenses by what they allow; 1 allows the least. Ties share a rank. */
  const rankDefenses = (rows, pos, stat, minGames = 1) => {
    const list = Object.entries(rows || {})
      .filter(([, r]) => r && r.g >= minGames && r[pos] && r[pos][stat] != null)
      .map(([team, r]) => ({ team, value: r[pos][stat], games: r.g }))
      .sort((a, b) => a.value - b.value || String(a.team).localeCompare(String(b.team)));
    let rank = 0, previous = null;
    list.forEach((row, i) => { if (row.value !== previous) { rank = i + 1; previous = row.value; } row.rank = rank; });
    return list;
  };
  const rankOf = (rows, team, pos, stat) => {
    const list = rankDefenses(rows, pos, stat);
    const hit = list.find(r => String(r.team) === String(team));
    return hit ? { rank: hit.rank, of: list.length, value: hit.value } : null;
  };
  /* Tone for a rank from the offense's point of view: a generous defense is good news. */
  const rankTone = (rank, of) => !rank || !of ? 'neutral' : rank > of * 2 / 3 ? 'soft' : rank <= of / 3 ? 'tough' : 'neutral';

  /* ---------- tickets ---------- */

  const decimal = price => { const n = Number(price); return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n); };
  const american = value => value >= 2 ? Math.round((value - 1) * 100) : Math.round(-100 / (value - 1));
  const bookName = book => String(book || '').replace(/\s+/g, '').toLowerCase();

  const eligible = (row, now) => row.state === 'open' && row.odds != null
    && (!row.expiresAt || Date.parse(row.expiresAt) > now) && (!row.kickoff || Date.parse(row.kickoff) > now);

  /* An illustrative parlay from separate-game quotes at one book. The sportsbook
     sets the real ticket price; same-game legs need its correlated price. */
  const summarizeTicket = (selected, stake = 1, mode = 'units', unitValue = 1, now = Date.now()) => {
    const risk = Number(stake), value = Number(unitValue), units = mode === 'units';
    let reason = '';
    if (selected.length < 2) reason = 'Add at least two lines to build a ticket.';
    else if (selected.some(row => !eligible(row, now))) reason = 'Every leg needs a current, priced sportsbook quote before kickoff.';
    else if (new Set(selected.map(row => bookName(row.book))).size !== 1) reason = 'Mixed sportsbooks need one combined sportsbook quote.';
    else if (new Set(selected.map(row => row.gameId)).size !== selected.length) reason = 'Same-game legs need the sportsbook’s own parlay price.';
    else if (!(risk > 0) || (units && !(value > 0))) reason = 'Enter a positive stake and a dollar value per unit.';
    if (reason) return { available: false, reason };
    const price = selected.reduce((n, row) => n * decimal(row.odds), 1);
    const profit = risk * (price - 1);
    return { available: true, odds: american(price), decimal: price, stake: risk, profit, total: risk * price,
      dollars: units ? { stake: risk * value, profit: profit * value, total: risk * price * value } : null,
      reason: 'Illustrative: separate-game quotes multiplied. The sportsbook sets the actual ticket price.' };
  };

  const ticketText = selected => ['KeenRoudy Sports: personal draft, not an official ticket',
    ...selected.map((row, i) => `${i + 1}. ${row.title || row.player || 'Line'} | ${row.book || 'Book unavailable'} ${odds(row.odds)} | seen ${row.observedAt || 'time unavailable'}`),
    'Check every market, price and the sportsbook’s ticket total yourself.'].join('\n');

  /* ---------- the record ---------- */

  const unitsFor = pick => {
    if (!pick.odds || !['win', 'loss', 'push'].includes(pick.result)) return null;
    if (pick.result === 'win') return pick.odds > 0 ? pick.odds / 100 : 100 / Math.abs(pick.odds);
    return pick.result === 'loss' ? -1 : 0;
  };
  /* Units and ROI use recorded original prices only; a result without one stays in the win-loss
     record and out of returns. No price is ever assumed. ROI waits for ten priced picks. */
  const category = p => p.kind === 'gamePicks' ? (p.marketType === 'total' ? 'Totals' : 'Spreads')
    : p.kind === 'props' ? 'Straights' : p.kind === 'riskyProps' ? 'Risky lines'
      : p.parlayType === 'longshot' ? 'Longshots' : 'Parlays';
  const recordOf = (picks, minimum = 10) => {
    const settled = picks.filter(p => ['win', 'loss', 'push', 'void'].includes(p.result));
    const priced = picks.filter(p => unitsFor(p) != null);
    const units = priced.reduce((sum, p) => sum + unitsFor(p), 0);
    const wins = settled.filter(p => p.result === 'win').length, losses = settled.filter(p => p.result === 'loss').length;
    return { wins, losses, pushes: settled.filter(p => p.result === 'push').length, voids: settled.filter(p => p.result === 'void').length,
      pending: picks.filter(p => !p.result).length, hitRate: wins + losses ? 100 * wins / (wins + losses) : null,
      priced: priced.length, pricedWins: priced.filter(p => p.result === 'win').length, pricedLosses: priced.filter(p => p.result === 'loss').length,
      unpriced: settled.filter(p => p.result !== 'void').length - priced.length,
      units: priced.length ? units : null, roi: priced.length >= minimum ? 100 * units / priced.length : null, roiMinimum: minimum };
  };

  /* ---------- routes ---------- */

  const LEGACY = { '': 'today', sports: 'today', home: 'today', overview: 'today', scores: 'games', props: 'board',
    parlays: 'ticket', lines: 'board', results: 'record', research: 'research', players: 'stats' };
  /* Old links keep working: #game/<id>, #player/<league>/<id>, #record, #players and the rest. */
  const parseRoute = hash => {
    const parts = String(hash || '').replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    let [view, ...rest] = parts;
    view = view || '';
    if (view === 'sport') return { view: 'scores', league: (rest[0] || 'NBA').toUpperCase() };
    if (view === 'player') return { view: 'player', league: (rest[0] || 'NFL').toUpperCase(), id: rest[1] };
    if (view === 'team') return { view: 'team', league: (rest[0] || 'NFL').toUpperCase(), id: rest[1] };
    if (view === 'game') return { view: 'game', id: rest.join('/') };
    if (view === 'stats') return { view: 'stats', tab: rest[0] || 'players' };
    if (view === 'defense') return { view: 'stats', tab: 'defense' };
    /* Bare #scores was the old football board; only #scores/<league> is the other-sports page. */
    if (view === 'scores' && rest[0]) return { view: 'scores', league: rest[0].toUpperCase() };
    const known = ['today', 'games', 'stats', 'model', 'record', 'board', 'ticket', 'research', 'more'];
    if (known.includes(view)) return { view };
    return { view: LEGACY[view] || 'today' };
  };

  const shardOf = (id, shards) => Number(id) % shards;

  return { esc, DASH, odds, signed, fixed, pct, when, whenShort, dayLabel, ago, spreadText, modelSpread, leanText,
    column, cell, summarize, windows, splits, hits, POSITION_STATS, LABEL, PROJECTION_MARKET,
    rankDefenses, rankOf, rankTone, decimal, american, eligible, summarizeTicket, ticketText,
    unitsFor, recordOf, category, parseRoute, shardOf, BASE };
});

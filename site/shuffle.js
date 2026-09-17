(function (root, factory) {
  'use strict';
  const board = typeof module === 'object' && module.exports ? require('./board.js') : root.KeenBoard;
  const api = factory(board);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KeenShuffle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Board) {
  'use strict';
  const normalize = value => String(value ?? '').trim().toLowerCase();
  const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
  const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const validOdds = value => numeric(value) != null && Math.abs(numeric(value)) >= 100;
  const bookName = value => ({ draftkings: 'draftkings', fanduel: 'fanduel', betmgm: 'betmgm' }[normalize(value).replace(/[^a-z0-9]/g, '')] || normalize(value));
  const safeSource = value => { try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password; } catch { return false; } };
  const personName = value => normalize(value).replace(/[^a-z0-9 ]/g, '').replace(/\s+(?:jr|sr|ii|iii|iv)$/, '').replace(/\s+/g, '');
  const combination = rows => rows.map(row => row.key).sort().join('\n');
  const participant = row => row.athleteId != null ? `${row.league}:${row.athleteId}` : null;
  const gameMarket = row => row.position === 'Game' || row.sourceType === 'game-market' || row.kind === 'gamePicks' || /\b(?:spread|total points|moneyline|team total)\b/.test(normalize(row.market));
  const filterValue = value => value != null && value !== '' && normalize(value) !== 'all';

  function allowed(row, options, now) {
    if (!row || typeof row.key !== 'string' || !row.key || !row.title || !row.gameId || row.gameState !== 'pre' || row.gameCompleted || row.changed || row.missing) return false;
    if (instant(row.kickoff) == null || instant(row.kickoff) <= now || !validOdds(row.odds) || !safeSource(row.source)) return false;
    const observed = instant(row.quotedAt || row.observedAt);
    if (observed == null || observed > now) return false;
    if (normalize(row.marketWindow).replace(/-/g, ' ') !== 'full game' || !row.market || !row.subject) return false;
    if (['withdrawn', 'replaced', 'historical', 'closed'].includes(normalize(row.status)) || /paus/i.test(row.entryNote || '')) return false;
    if (!bookName(row.book) || ['reference', 'comparison feed', 'book unavailable'].includes(bookName(row.book))) return false;
    if (filterValue(options.league) && row.league !== options.league) return false;
    if (filterValue(options.week) && Board.dateWeek(row.kickoff) !== options.week) return false;
    if (filterValue(options.game) && row.gameId !== options.game) return false;
    if (filterValue(options.book) && bookName(row.book) !== bookName(options.book)) return false;
    if (row.league === 'CFB' && !(row.jurisdiction?.state === 'IN' && row.jurisdiction.status === 'verified' && row.jurisdiction.allowed === true && safeSource(row.jurisdiction.source))) return false;
    return options.mode !== 'current' || Board.quoteState(row, now).eligible;
  }

  function compatible(row, chosen, distinctGames) {
    return chosen.every(other => {
      if (row.key === other.key || bookName(row.book) !== bookName(other.book)) return false;
      if (distinctGames && row.gameId === other.gameId) return false;
      if (row.league === other.league && participant(row) && participant(row) === participant(other)) return false;
      if (row.gameId !== other.gameId || row.league !== other.league) return true;
      // Do not double up on a player through aliases or opposing/alternate markets.
      if (!gameMarket(row) && !gameMarket(other) && personName(row.subject) === personName(other.subject)) return false;
      // One team/game market per event avoids opposing totals, sides and team props.
      if (gameMarket(row) && gameMarket(other)) return false;
      return true;
    });
  }

  function shuffled(values, rng) {
    const result = values.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const random = rng();
      if (typeof random !== 'number' || !Number.isFinite(random) || random < 0 || random >= 1) throw new TypeError('Random source must return a number in [0, 1).');
      const j = Math.floor(random * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  /** Pure personal-draft generator. Failure preserves previous; never grades or publishes a ticket. */
  function generate(catalog, options = {}, now = Date.now(), rng = Math.random) {
    const settings = { count: 2, book: 'DraftKings', game: 'all', mode: 'ideas', locked: [], previous: [], target: null, ...options };
    const previous = Array.isArray(settings.previous) ? settings.previous.slice() : [];
    const failure = reason => ({ rows: previous, reason, available: false, quoteMode: settings.mode === 'current' ? 'current' : 'ideas' });
    if (!Board || !Array.isArray(catalog) || !Number.isFinite(now)) return failure('The line board is unavailable. Your draft was kept.');
    const count = numeric(settings.count);
    if (!Number.isInteger(count) || count < 2 || count > 4) return failure('Choose two, three or four legs. Your draft was kept.');
    if (!['ideas', 'current'].includes(settings.mode)) return failure('Choose saved-price ideas or current quotes. Your draft was kept.');
    if (!Array.isArray(settings.locked) || settings.locked.length > count) return failure('Unlock a leg or increase the leg count. Your draft was kept.');
    const hasTarget = settings.target != null && settings.target !== '';
    const target = numeric(settings.target);
    if (hasTarget && (settings.mode !== 'current' || !validOdds(target) || target < 100 || target > 10000)) return failure('Target odds require current quotes and American odds from +100 to +10000. Your draft was kept.');
    const byKey = new Map();
    for (const row of catalog) if (row?.key && !byKey.has(row.key)) byKey.set(row.key, row);
    const locked = [];
    for (const saved of settings.locked) {
      const row = byKey.get(saved?.key);
      if (!row || !allowed(row, settings, now) || saved.changed || saved.missing || Board.saveRow(row).signature !== Board.saveRow(saved).signature || participant(row) !== participant(saved) || !compatible(row, locked, hasTarget)) return failure('A locked leg changed, expired for this mode, conflicts, or is outside your filters. Review it first; your draft was kept.');
      locked.push(row);
    }
    let pool;
    try {
      // Shuffle before the bound so catalog ordering does not privilege the first sources.
      pool = shuffled([...byKey.values()].filter(row => allowed(row, settings, now) && !locked.some(item => item.key === row.key) && compatible(row, locked, hasTarget)), rng).slice(0, 64);
    } catch { return failure('A new draft could not be shuffled. Your draft was kept.'); }
    if (pool.length + locked.length < count) return failure('Not enough compatible lines for these filters. Your draft was kept.');
    const oldKey = combination(previous), targetDecimal = hasTarget ? (target > 0 ? 1 + target / 100 : 1 + 100 / Math.abs(target)) : null;
    let best = null, fallback = null, score = Infinity, nodes = 0;
    const visit = (start, chosen) => {
      if (++nodes > 12000) return;
      if (chosen.length === count) {
        const ticket = hasTarget ? Board.summarizeTicket(chosen, 1, 'money', 1, now) : null;
        if (hasTarget && (!ticket.available || !Number.isFinite(ticket.decimal))) return;
        const result = chosen.slice();
        if (combination(result) === oldKey) { fallback = result; return; }
        const distance = hasTarget ? Math.abs(Math.log(ticket.decimal / targetDecimal)) : 0;
        if (!best || distance < score) { best = result; score = distance; }
        return;
      }
      for (let i = start; i <= pool.length - (count - chosen.length) && nodes < 12000; i++) {
        if (!compatible(pool[i], chosen, hasTarget)) continue;
        visit(i + 1, [...chosen, pool[i]]);
        if (best && !hasTarget) return;
      }
    };
    visit(0, locked);
    const selected = best || fallback;
    if (!selected) return failure(hasTarget ? 'No priceable combination found: target drafts need current prices from one book and different games. Your draft was kept.' : 'No compatible combination found for these filters. Your draft was kept.');
    const unchanged = !best;
    const targetTicket = hasTarget ? Board.summarizeTicket(selected, 1, 'money', 1, now) : null;
    const targetNote = targetTicket ? `Closest compatible draft found in this shuffle: illustrative ${targetTicket.odds > 0 ? '+' : ''}${targetTicket.odds} (target +${target}). Verify the sportsbook price.` : '';
    const unchangedNote = 'The current draft is the only compatible combination found. Unlock a leg or broaden the filters to try another.';
    const reason = hasTarget ? `${targetNote}${unchanged ? ' ' + unchangedNote : ''}` : unchanged ? unchangedNote : settings.mode === 'ideas' ? 'A personal idea using saved source prices. Recheck every leg; no combined price is implied.' : new Set(selected.map(row => row.gameId)).size < selected.length ? 'Current individual quotes, with same-game legs. The sportsbook must quote the combined ticket.' : 'Current individual quotes. Any combined odds remain illustrative until the sportsbook confirms them.';
    return { rows: selected, reason, available: true, quoteMode: settings.mode };
  }
  return { generate };
});

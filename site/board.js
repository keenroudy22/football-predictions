(function (root, factory) {
  'use strict';
  const records = typeof module === 'object' && module.exports ? require('./records.js') : typeof FootballRecords !== 'undefined' ? FootballRecords : null;
  const players = typeof module === 'object' && module.exports ? require('./players.js') : root.KeenPlayers;
  const api = factory(records, players);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KeenBoard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Records, Players) {
  'use strict';
  const VERSION = 1, STORAGE = 'keenroudy-sports-draft-v1';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
  const time = value => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const stamp = value => time(value) != null ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) + ' ET' : 'Time unavailable';
  const validOdds = value => number(value) != null && Math.abs(number(value)) >= 100;
  const oddsText = value => validOdds(value) ? `${number(value) > 0 ? '+' : ''}${number(value)}` : '—';
  const safeURL = value => typeof value === 'string' && /^https:\/\//.test(value);
  const normalize = value => String(value || '').trim().toLowerCase();
  const bookName = value => value == null ? null : ({ draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM' }[normalize(value).replace(/[^a-z0-9]/g, '')] || String(value).trim());
  const dateWeek = value => {
    if (time(value) == null) return null;
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
    const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 5) % 7)); return d.toISOString().slice(0, 10);
  };
  const parse = title => {
    const m = String(title || '').match(/^(.+?)\s+(?:[—–-]\s*)?(OVER|UNDER)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);
    return m ? { subject: m[1], direction: m[2].toUpperCase(), line: Number(m[3]), market: m[4] } : null;
  };
  const defaults = () => ({ scope: 'live', query: '', game: 'all', position: 'all', market: 'all', book: 'all', sort: 'favorites', saved: [], stake: 1, stakeMode: 'units', unitValue: 1, target: '', detail: null, slipOpen: false, copyStatus: '', ticketTab: 'build', poolOpen: false, advancedOpen: false, locked: [], undo: null, shuffleCount: '2', shuffleBook: 'DraftKings', shuffleGame: 'all', shuffleMode: 'ideas', shuffleMessage: '' });
  let currentView = defaults(), loaded = false, boundContent = null, handlers = null, rendering = null, returnFocus = null;

  function rows(state = {}) {
    const games = new Map((state.slate?.games || []).map(g => [g.id, g]));
    const profileKeys = new Set((Players?.index(state) || []).map(player => `${player.league}:${player.athleteId}`));
    const out = new Map(), first = new Map();
    for (const report of [...(state.reports || [])].sort((a, b) => (time(a.publishedAt) || 0) - (time(b.publishedAt) || 0))) for (const kind of ['props', 'riskyProps', 'gamePicks']) for (const p of report[kind] || []) if (!first.has(p.id)) first.set(p.id, p);
    const add = row => {
      if (!row.key || !row.title) return;
      const game = games.get(row.gameId), parsed = parse(row.title), saved = state.history?.picks?.[row.id];
      const athleteId = row.athleteId || saved?.athleteId || null;
      const merged = { marketWindow: 'Full game', official: false, favorite: false, sources: [], ...row, athleteId: athleteId == null ? null : String(athleteId), line: number(row.line ?? parsed?.line), odds: validOdds(row.odds) ? number(row.odds) : null, direction: row.direction || parsed?.direction || '', market: row.market || parsed?.market || 'Other', subject: row.subject || parsed?.subject || row.title, position: row.position || saved?.position || (row.sourceType === 'game-market' || row.kind === 'gamePicks' ? 'Game' : 'Other'), game, kickoff: game?.kickoff || row.kickoff || null, gameLabel: game ? `${game.away?.abbreviation || game.away?.name} @ ${game.home?.abbreviation || game.home?.name}` : row.gameLabel || 'Game not verified', gameState: game?.state || null, gameCompleted: Boolean(game?.completed), league: row.league || game?.league || 'Unknown' };
      merged.book = bookName(merged.book);
      merged.profile = Players?.hrefFor ? Players.hrefFor({ ...row, athleteId, gameIds: row.gameId ? [row.gameId] : [], league: merged.league }, state) : '#players';
      if (merged.profile === '#players' || !profileKeys.has(`${merged.league}:${merged.athleteId}`)) merged.profile = null;
      const identity = state.identities?.players?.[`${merged.league}/${merged.athleteId}`];
      const team = identity?.status === 'ok' && game && [game.home?.id, game.away?.id].some(id => id != null && String(id) === String(identity.team?.id)) ? identity.team : null;
      const color = typeof team?.color === 'string' ? team.color.replace(/^#/, '') : '';
      merged.teamColor = /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : null;
      out.set(merged.key, merged);
    };
    for (const p of Records?.latest(state.reports || []) || []) {
      if (!['props', 'riskyProps', 'gamePicks'].includes(p.kind)) continue;
      const original = first.get(p.id) || p, gameId = (p.originalGameIds || p.gameIds || [])[0], title = p.originalTitle || p.title;
      add({ key: `official:${p.league}:${p.id}`, id: p.id, sourceType: 'official', official: true, favorite: Records.favorite(p), kind: p.kind, league: p.league, title, gameId, athleteId: p.athleteId, position: p.position, line: p.originalLine ?? parse(title)?.line, direction: p.originalDirection || parse(title)?.direction, market: original.marketType || parse(title)?.market, marketWindow: original.marketWindow || p.marketWindow || 'Full game', book: p.originalBook, odds: p.originalOdds, quotedAt: original.quotedAt || null, observedAt: original.quotedAt || null, expiresAt: original.expiresAt || null, status: p.status, quoteType: p.status === 'historical' ? 'historical import' : 'sportsbook', source: (original.sources || []).find(safeURL), sources: [...new Set([...(original.sources || []), ...(p.sources || [])])], publishedAt: p.originalPublishedAt, updatedAt: p.publishedAt, projection: p.originalProjection, confidence: p.originalConfidence, cutoff: original.cutoff, why: p.quickWhy || p.why, risk: p.risk, entryNote: p.entryNote, jurisdiction: p.jurisdiction, result: p.result, raw: p });
    }
    const watches = new Map();
    for (const report of [...(state.reports || [])].sort((a, b) => (time(a.publishedAt) || 0) - (time(b.publishedAt) || 0))) for (const w of report.gameWatch || []) if (w.id) watches.set(`${report.league}:${w.id}`, { ...w, league: report.league, publishedAt: report.publishedAt });
    for (const w of watches.values()) {
      const parsed = parse(w.marketTitle || w.title), title = w.marketTitle || w.title;
      if (!w.athleteId && !w.player && !parsed) continue;
      const snapshots = (w.marketSnapshots || []).filter(s => number(s.line) != null && safeURL(s.source) && time(s.observedAt) != null).sort((a, b) => time(b.observedAt) - time(a.observedAt));
      const matching = snapshots.find(s => !parsed || (number(s.line) === parsed.line && normalize(s.direction) === normalize(parsed.direction) && normalize(s.market) === normalize(parsed.market)));
      add({ key: `watch:${w.league}:${w.id}`, id: w.id, sourceType: 'research', kind: 'watch', league: w.league, title, subject: w.player || parsed?.subject, athleteId: w.athleteId, position: w.position, gameId: w.gameId, line: parsed?.line ?? matching?.line, direction: parsed?.direction || matching?.direction, market: parsed?.market || matching?.market, marketWindow: matching?.window || 'Full game', book: matching?.book || w.book || 'Reference', odds: matching?.odds ?? w.odds, observedAt: matching?.observedAt || w.publishedAt, quotedAt: null, quoteType: matching?.quoteType || 'research reference', status: 'reference', source: matching?.source || (w.sources || []).find(safeURL), sources: w.sources || [], publishedAt: w.publishedAt, why: w.why, risk: w.risk, needs: w.needs, quoteNote: w.quoteNote || 'Research reference; price needs rechecking.', raw: w });
    }
    for (const line of state.marketLines?.lines || []) {
      if (!line.id || !line.gameId || !line.title) continue;
      add({ ...line, key: `market:${line.id}`, sourceType: 'market', kind: 'available', official: false, favorite: false, subject: line.player || parse(line.title)?.subject, quotedAt: line.quoteType === 'sportsbook' ? (line.quotedAt || line.observedAt || null) : null, sources: [line.source].filter(safeURL), status: line.quoteStatus || line.status || 'reference', why: line.reason || 'Observed market, not an official recommendation.' });
    }
    for (const game of games.values()) {
      const market = game.market;
      if (!market) continue;
      const base = { id: game.id, sourceType: 'game-market', kind: 'game-market', gameId: game.id, league: game.league, position: 'Game', book: market.provider || 'Comparison feed', observedAt: game.marketRetrievedAt || (state.slate?.sources || []).find(source => source.league === game.league)?.retrievedAt || null, quotedAt: null, status: 'reference', quoteType: 'comparison feed', source: safeURL(market.link) ? market.link : game.source, sources: [game.source, market.link].filter(safeURL), why: 'Game-market comparison feed. This is not a published spread or total pick.' };
      if (number(market.spread) != null) add({ ...base, key: `game:${game.id}:home-spread`, title: `${game.home?.abbreviation || game.home?.name} ${number(market.spread) > 0 ? '+' : ''}${number(market.spread)} spread`, subject: game.home?.name || game.home?.abbreviation, market: 'Spread', direction: 'HOME', line: market.spread, odds: market.spreadOdds });
      if (number(market.total) != null) {
        let sides = 0;
        for (const [direction, odds] of [['OVER', market.overOdds], ['UNDER', market.underOdds]]) if (validOdds(odds)) { sides++; add({ ...base, key: `game:${game.id}:total:${direction}`, title: `${game.away?.abbreviation} @ ${game.home?.abbreviation} ${direction} ${number(market.total)} total points`, subject: `${game.away?.abbreviation} @ ${game.home?.abbreviation}`, market: 'Total points', direction, line: market.total, odds }); }
        if (!sides) add({ ...base, key: `game:${game.id}:total-reference`, title: `${game.away?.abbreviation} @ ${game.home?.abbreviation} total ${number(market.total)}`, subject: `${game.away?.abbreviation} @ ${game.home?.abbreviation}`, market: 'Total points', line: market.total, direction: '', odds: null });
      }
    }
    const unique = new Map(), priority = row => row.official ? 6 : row.sourceType === 'market' && row.quoteType === 'sportsbook' ? (['current', 'active'].includes(row.status) && validOdds(row.odds) ? 5 : 4) : row.sourceType === 'research' ? 3 : row.sourceType === 'market' ? 2 : 1;
    const contextKey = row => JSON.stringify([row.league, row.gameId, normalize(row.subject), normalize(row.market), normalize(row.marketWindow), normalize(row.direction), row.line, normalize(row.book), row.odds, time(row.quotedAt || row.observedAt), row.source]);
    const contextIds = new Map();
    for (const row of out.values()) if (row.athleteId) { const context = contextKey(row); if (!contextIds.has(context)) contextIds.set(context, new Set()); contextIds.get(context).add(row.athleteId); }
    for (const row of out.values()) {
      const matchingIds = contextIds.get(contextKey(row));
      const verifiedId = row.athleteId || (matchingIds?.size === 1 ? [...matchingIds][0] : null);
      const fingerprint = JSON.stringify([row.league, row.gameId, verifiedId || normalize(row.subject), normalize(row.market), normalize(row.marketWindow), normalize(row.direction), row.line, normalize(row.book), row.odds, time(row.quotedAt || row.observedAt)]);
      const previous = unique.get(fingerprint);
      if (!previous) { unique.set(fingerprint, row); continue; }
      const winner = priority(row) > priority(previous) ? row : previous, other = winner === row ? previous : row, research = [winner, other].find(r => r.sourceType === 'research' || r.hasResearch);
      unique.set(fingerprint, { ...winner, athleteId: winner.athleteId || other.athleteId, profile: winner.profile || other.profile, teamColor: winner.teamColor || other.teamColor, hasResearch: Boolean(research), ...(!winner.official && research ? { why: research.why || winner.why, risk: research.risk || winner.risk, needs: research.needs || winner.needs } : {}), sources: [...new Set([winner.source, other.source, ...(winner.sources || []), ...(other.sources || [])].filter(safeURL))], observations: [...new Map([...(winner.observations || winner.raw?.marketSnapshots || []), ...(other.observations || other.raw?.marketSnapshots || [])].map(o => [JSON.stringify(o), o])).values()] });
    }
    return [...unique.values()];
  }
  function quoteState(row, now = Date.now()) {
    if (row.gameCompleted || (row.gameState && row.gameState !== 'pre') || (time(row.kickoff) != null && time(row.kickoff) <= now)) return { type: 'closed', label: 'Game closed', eligible: false };
    if (/paus/i.test(row.entryNote || '') || ['withdrawn', 'replaced'].includes(row.status)) return { type: 'expired', label: 'Entries paused', eligible: false };
    if (row.league === 'CFB' && !(row.jurisdiction?.state === 'IN' && row.jurisdiction.allowed === true && row.jurisdiction.status === 'verified' && safeURL(row.jurisdiction.source))) return { type: 'reference', label: 'Indiana availability unverified', eligible: false };
    if (['expired', 'stale'].includes(row.status)) return { type: 'expired', label: 'Quote expired · recheck', eligible: false };
    if (row.status === 'missing-price' || !validOdds(row.odds)) return { type: 'reference', label: 'Price unavailable', eligible: false };
    if (row.quoteType !== 'sportsbook' || !['active', 'current'].includes(row.status) || ['research', 'game-market'].includes(row.sourceType)) return { type: 'reference', label: row.status === 'historical' ? 'Historical import' : 'Reference · recheck', eligible: false };
    if (!validOdds(row.odds) || !row.book || !row.gameId || row.gameState !== 'pre' || time(row.kickoff) == null || time(row.quotedAt) == null || time(row.quotedAt) > now || time(row.expiresAt) == null || time(row.expiresAt) <= now || !safeURL(row.source)) return { type: 'expired', label: 'Quote needs recheck', eligible: false };
    return { type: 'current', label: 'Current quote', eligible: true };
  }
  const STATE_ORDER = { current: 0, reference: 1, expired: 2, closed: 3 };
  const stateRank = (row, now) => STATE_ORDER[quoteState(row, now).type] ?? 4;
  const eligible = (row, now) => !row.changed && !row.missing && quoteState(row, now).eligible;
  const saveable = row => Boolean(row?.key && row.gameId && row.title);
  const signature = row => JSON.stringify([row.key, row.line, row.direction, row.market, row.marketWindow, row.book, row.odds, row.quotedAt, row.observedAt, row.expiresAt]);
  function snapshot(row) {
    const result = {};
    for (const key of ['key', 'id', 'title', 'subject', 'league', 'gameId', 'gameLabel', 'kickoff', 'gameState', 'gameCompleted', 'athleteId', 'position', 'market', 'marketWindow', 'direction', 'line', 'book', 'odds', 'quotedAt', 'observedAt', 'expiresAt', 'quoteType', 'status', 'sourceType', 'source', 'official', 'favorite', 'cutoff', 'entryNote', 'jurisdiction']) result[key] = row[key] ?? null;
    return result;
  }
  function saveRow(row) { return { key: row.key, signature: signature(row), snapshot: snapshot(row) }; }
  function reconcileSaved(saved, catalog) {
    const current = new Map(catalog.map(row => [row.key, row]));
    return (saved || []).filter(item => item && typeof item.key === 'string' && item.snapshot?.key === item.key).slice(0, 20).map(item => {
      const row = current.get(item.key), changed = Boolean(row && signature(row) !== item.signature);
      return { ...(row || item.snapshot), ...(changed ? item.snapshot : {}), savedSnapshot: item.snapshot, changed, missing: !row, current: row || null };
    });
  }
  const decimal = odds => odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
  const american = value => value >= 2 ? Math.round((value - 1) * 100) : Math.round(-100 / (value - 1));
  function summarizeTicket(selected, stake = 1, mode = 'units', unitValue = 1, now = Date.now()) {
    const risk = number(stake), value = number(unitValue), units = mode === 'units';
    let reason = '';
    if (selected.length < 2) reason = 'Save at least two lines to build a ticket.';
    else if (selected.some(row => row.changed)) reason = 'A saved quote changed. Review and accept its latest snapshot.';
    else if (selected.some(row => row.missing || !eligible(row, now))) reason = 'Reference or stale lines need a fresh sportsbook quote.';
    else if (new Set(selected.map(row => normalize(bookName(row.book)))).size !== 1) reason = 'Mixed sportsbooks require one combined sportsbook quote.';
    else if (new Set(selected.map(row => row.gameId)).size !== selected.length) reason = 'Same-game legs require a sportsbook parlay price.';
    else if (risk == null || risk <= 0 || (units && (value == null || value <= 0))) reason = 'Enter a positive stake and dollar value per unit.';
    if (reason) return { available: false, reason, odds: null, profit: null, total: null };
    const price = selected.reduce((n, row) => n * decimal(row.odds), 1), profit = risk * (price - 1), total = risk * price;
    return { available: true, reason: 'Illustrative multiplication of separate-game quotes; the sportsbook sets the actual ticket price.', odds: american(price), decimal: price, stake: risk, profit, total, dollars: units ? { stake: risk * value, profit: profit * value, total: total * value } : null };
  }
  function suggestions(catalog, target = 200, now = Date.now()) {
    if (number(target) == null || target < 100 || target > 10000) return [];
    const candidates = catalog.filter(row => eligible(row, now)).slice(0, 60), out = [];
    for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
      const pair = [candidates[i], candidates[j]], ticket = summarizeTicket(pair, 1, 'money', 1, now);
      if (ticket.available) out.push({ rows: pair, odds: ticket.odds, distance: Math.abs(ticket.odds - target) });
    }
    return out.sort((a, b) => a.distance - b.distance).slice(0, 3);
  }
  function filteredRows(state, catalog, view, now = Date.now()) {
    const savedKeys = new Set((view.saved || []).map(item => item.key));
    return catalog.filter(row => (view.scope === 'live' ? quoteState(row, now).type !== 'closed' : view.scope === 'settled' ? quoteState(row, now).type === 'closed' : true) && (view.scope === 'saved' ? savedKeys.has(row.key) : (!state.league || row.league === state.league) && (!state.week || dateWeek(row.kickoff) === state.week)) && (view.scope !== 'favorites' || row.favorite) && (view.scope !== 'research' || row.sourceType === 'research' || row.hasResearch) && (view.scope !== 'official' || row.official) && (view.game === 'all' || row.gameId === view.game) && (view.position === 'all' || row.position === view.position) && (view.market === 'all' || row.market === view.market) && (view.book === 'all' || row.book === view.book) && (!view.query || normalize(`${row.title} ${row.subject} ${row.gameLabel}`).includes(normalize(view.query)))).sort((a, b) => view.sort === 'time' ? (time(a.kickoff) || 0) - (time(b.kickoff) || 0) || a.title.localeCompare(b.title) : view.sort === 'player' ? a.subject.localeCompare(b.subject) : Number(b.favorite) - Number(a.favorite) || Number(b.official) - Number(a.official) || stateRank(a) - stateRank(b) || (time(a.kickoff) || 0) - (time(b.kickoff) || 0) || a.title.localeCompare(b.title));
  }
  function select(field, label, options, value) { return `<label>${esc(label)}<select data-kr-field="${field}">${options.map(([key, text]) => `<option value="${esc(key)}"${key === value ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`; }
  function rowHTML(row, view) {
    const quote = quoteState(row), saved = view.saved.some(item => item.key === row.key), line = row.line != null ? normalize(row.market) === 'spread' ? `${row.line > 0 ? '+' : ''}${row.line} spread` : `${row.direction ? row.direction + ' ' : ''}${row.line} ${row.market}` : row.market && row.market !== 'Other' ? row.market : row.title;
    const accent = /^#[0-9a-f]{6}$/i.test(row.teamColor || '') ? ` style="--pick-team-color:${row.teamColor}"` : '';
    const lean = row.favorite || row.official ? quote.type !== 'current' ? ' kr-lean-red' : Number(row.confidence) >= 7 ? ' kr-lean-green' : ' kr-lean-yellow' : '';
    return `<article class="kr-row kr-${quote.type}${lean}"${accent} data-kr-row="${esc(row.key)}"><div class="kr-row-main"><div><span class="kr-badge ${row.favorite ? 'favorite' : row.official ? 'official' : 'reference'}">${row.favorite ? '★ Favorite' : row.official ? 'Official pick' : row.sourceType === 'research' ? 'Research' : 'Market line'}</span>${row.marketWindow !== 'Full game' ? `<span class="kr-badge">${esc(row.marketWindow)}</span>` : ''}</div><button type="button" class="kr-row-player" data-kr-action="detail" data-kr-key="${esc(row.key)}">${esc(row.subject)}</button><strong class="kr-row-line">${esc(line)}</strong><small class="kr-row-context">${esc(row.gameLabel)} · ${esc(stamp(row.kickoff))}${row.position !== 'Game' && row.position !== 'Other' ? ` · ${esc(row.position)}` : ''}</small></div><div class="kr-row-price"><strong>${oddsText(row.odds)}</strong><small>${esc(row.book || 'Book unavailable')}</small><span class="kr-row-state">${esc(quote.label)}</span><small>${row.quotedAt ? `Quoted ${esc(stamp(row.quotedAt))}` : `Observed ${esc(stamp(row.observedAt))}`}</small></div><div class="kr-row-actions"><button type="button" data-kr-action="save" data-kr-key="${esc(row.key)}" aria-pressed="${saved}"${saveable(row) ? '' : ' disabled'}>${saved ? '✓ Saved' : saveable(row) ? '+ Save line' : 'Awaiting line'}</button><button type="button" data-kr-action="detail" data-kr-key="${esc(row.key)}" aria-label="Details for ${esc(row.title)}">Details →</button></div></article>`;
  }
  function ticketText(selected) { return ['KeenRoudy Sports — personal draft, not an official ticket', ...selected.map((row, i) => `${i + 1}. ${row.title} | ${row.marketWindow || 'Full game'} | ${row.gameLabel} | ${row.book || 'Book unavailable'} ${oddsText(row.odds)} | ${row.changed ? 'QUOTE CHANGED — needs review' : quoteState(row).label} | observed ${row.quotedAt || row.observedAt || 'time unavailable'}${row.cutoff ? ' | limit: ' + row.cutoff : ''}`), 'Verify every market, availability, price and sportsbook ticket total. Do not submit automatically.'].join('\n'); }
  function slipHTML(catalog, view, suffix = 'rail') {
    const selected = reconcileSaved(view.saved, catalog), ticket = summarizeTicket(selected, view.stake, view.stakeMode, view.unitValue), symbol = view.stakeMode === 'money' ? '$' : '', unit = view.stakeMode === 'units' ? 'u' : '', builder = suffix === 'builder';
    const title = `<div class="kr-slip-title"><div><h3 id="kr-slip-title-${suffix}">Your draft${selected.length ? ` · ${selected.length} legs` : ''}</h3><small>Personal picks · separate from our record</small></div>${suffix === 'modal' ? '<button class="kr-modal-close" type="button" data-kr-action="close-slip" aria-label="Close ticket">×</button>' : ''}</div>`;
    if (!selected.length) return `${title}<div class="kr-slip-empty"><strong>${builder ? 'Start with a shuffle.' : 'Make a ticket your way.'}</strong><p>${builder ? 'Choose your settings above, or add your own lines below.' : 'Save a line, or try different combinations in the builder.'}</p></div>${!builder ? '<div class="kr-slip-footer"><a href="#parlays">Open parlay builder →</a></div>' : ''}`;
    return `${title}<div class="kr-slip-items">${selected.map((row,i) => {
      const locked = (view.locked || []).includes(row.key);
      return `<div class="kr-slip-leg"${/^#[0-9a-f]{6}$/i.test(row.teamColor || '') ? ` style="--pick-team-color:${row.teamColor}"` : ''}><div><small>LEG ${i+1}${locked ? ' · LOCKED' : ''}</small><strong>${esc(row.title)}</strong><small>${esc(row.book || 'Book unavailable')} ${oddsText(row.odds)} · ${esc(row.gameLabel)} · ${esc(row.marketWindow || 'Full game')}</small><small>${row.quotedAt ? 'Quoted' : 'Observed'} ${esc(stamp(row.quotedAt || row.observedAt))}</small><span class="kr-slip-status">${row.missing ? 'No longer on the board · recheck' : row.changed ? `Quote changed · saved ${esc(row.savedSnapshot.title)} · ${esc(row.savedSnapshot.book)} ${oddsText(row.savedSnapshot.odds)} / latest ${esc(row.current?.title)} · ${esc(row.current?.book)} ${oddsText(row.current?.odds)}` : quoteState(row).label}</span></div><div class="kr-leg-tools">${builder ? `<button type="button" data-kr-action="lock" data-kr-key="${esc(row.key)}" aria-pressed="${locked}" aria-label="${locked ? 'Unlock' : 'Lock'} ${esc(row.title)}">${locked ? '✓ Locked' : 'Lock'}</button><button type="button" data-kr-action="detail" data-kr-key="${esc(row.key)}" aria-label="Research for ${esc(row.title)}">Research</button>` : ''}<button type="button" data-kr-action="remove" data-kr-key="${esc(row.key)}" aria-label="Remove ${esc(row.title)}">×</button></div>${row.changed ? `<button type="button" data-kr-action="reprice" data-kr-key="${esc(row.key)}">Use latest snapshot</button>` : ''}</div>`;
    }).join('')}</div><div class="kr-slip-controls"><label>Stake<input data-kr-field="stake" type="number" min="0.01" step="0.25" value="${esc(view.stake)}"></label>${select('stakeMode', 'Measure', [['units', 'Units'], ['money', 'Dollars']], view.stakeMode)}${view.stakeMode === 'units' ? `<label>$ per unit<input data-kr-field="unitValue" type="number" min="0.01" step="1" value="${esc(view.unitValue)}"></label>` : ''}</div><div class="kr-slip-total">${ticket.available ? `<span>Illustrative odds <strong>${oddsText(ticket.odds)}</strong></span><span>Potential profit <strong>${symbol}${ticket.profit.toFixed(2)}${unit}</strong></span><span>Total return <strong>${symbol}${ticket.total.toFixed(2)}${unit}</strong></span>${ticket.dollars ? `<small>At $${Number(view.unitValue).toFixed(2)}/unit: $${ticket.dollars.profit.toFixed(2)} profit · $${ticket.dollars.total.toFixed(2)} total return.</small>` : ''}` : '<strong>Check the combined price in your book</strong>'}<p>${esc(ticket.reason)}</p></div><details class="kr-ticket-text"><summary>How pricing works</summary><p>Only fresh, same-book quotes from different games receive an illustrative estimate. Same-game, mixed-book and stale lines require an actual sportsbook ticket price. Payout is not a win probability.</p></details><div class="kr-slip-footer"><button type="button" data-kr-action="copy">Copy ticket</button><a href="https://gambly.com/gambly-bot" target="_blank" rel="noopener noreferrer">Open Gambly ↗</a>${!builder ? '<a href="#parlays">Shuffle & edit in builder →</a>' : ''}<button type="button" data-kr-action="clear">Clear draft</button></div><p class="kr-copy-status" role="status">${esc(view.copyStatus)}</p><details class="kr-ticket-text"><summary>View copyable ticket</summary><textarea readonly aria-label="Ticket text for Gambly">${esc(ticketText(selected))}</textarea><p>Paste into Gambly and review its matched markets. This site does not place bets.</p></details>`;
  }
  function builderHTML(state, catalog, view) {
    const base = catalog.filter(row => row.league === state.league && (!state.week || dateWeek(row.kickoff) === state.week) && row.gameState === 'pre' && time(row.kickoff) > Date.now());
    const games = [...new Map(base.map(row => [row.gameId, row.gameLabel])).entries()];
    const books = [...new Set(['DraftKings', 'FanDuel', ...base.map(row => row.book).filter(Boolean)])];
    return `<section class="kr-builder"><div class="kr-builder-top"><span>PERSONAL PARLAY BUILDER</span><h3>Make it your own.</h3><p>Shuffle ideas. Lock the legs you like. Check the ticket in your book.</p></div><div class="kr-generator-controls">${select('shuffleGame','Game',[['all','All upcoming games'],...games],view.shuffleGame)}${select('shuffleBook','Sportsbook',books.map(b => [b,b]),view.shuffleBook)}${select('shuffleCount','Legs',[['2','2 legs'],['3','3 legs'],['4','4 legs']],view.shuffleCount)}${select('shuffleMode','Line pool',[['ideas','Research ideas · recheck'],['current','Current quotes only']],view.shuffleMode)}</div><details class="kr-shuffle-advanced"${view.advancedOpen ? ' open' : ''}><summary>Target a payout</summary><label>Target American odds (optional)<input type="number" min="100" max="10000" step="25" data-kr-field="target" placeholder="e.g. +400" value="${esc(view.target ?? '')}"${view.shuffleMode !== 'current' ? ' disabled' : ''}></label><p>Available with current quotes from different games at one book. A target is an approximate match, not a sportsbook offer or a risk rating.${view.shuffleMode !== 'current' ? ' Choose Current quotes only to use a target.' : ''}</p></details><div class="kr-shuffle-actions"><button type="button" class="kr-shuffle-primary" data-kr-action="shuffle">⇄ ${view.saved.length ? 'Shuffle unlocked legs' : 'Shuffle a draft'}</button>${view.undo ? '<button type="button" data-kr-action="undo-shuffle">Undo shuffle</button>' : ''}</div><p class="kr-shuffle-feedback" role="status">${esc(view.shuffleMessage || (view.shuffleMode === 'ideas' ? 'Uses sourced reference lines, including older quotes. Recheck every leg; these are randomized ideas, not our recommendations.' : 'Uses unexpired sportsbook quotes only. Random combinations are not recommendations.'))}</p><section class="kr-draft-workspace" aria-labelledby="kr-slip-title-builder">${slipHTML(catalog,view,'builder')}</section></section>`;
  }
  function rowHistory(row, state, window = '10') {
    if (!row.athleteId || number(row.line) == null || !['OVER', 'UNDER'].includes(String(row.direction).toUpperCase()) || normalize(row.marketWindow) !== 'full game' || !Players?.historyView) return null;
    const aliases = { player_receiving_yards: 'receiving yards', player_receptions: 'receptions', player_rushing_yards: 'rushing yards', player_passing_yards: 'passing yards', carries: 'rushing attempts' };
    const stat = aliases[normalize(row.market)] || normalize(row.market), player = Players.index(state).find(p => p.league === row.league && p.athleteId === String(row.athleteId));
    const candidates = [...(player?.records || []).map(r => r.recentForm), ...Object.values(state.history?.picks || {}).filter(p => String(p.athleteId) === String(row.athleteId)).map(p => p.recentForm)].filter(f => f && (aliases[normalize(f.stat)] || normalize(f.stat)) === stat && safeURL(f.source) && Array.isArray(f.historyGames));
    if (!candidates.length) return null;
    candidates.sort((a, b) => (time(b.checkedAt) || 0) - (time(a.checkedAt) || 0));
    const latest = candidates[0], raw = candidates.flatMap(f => f.historyGames), title = `${row.subject} ${String(row.direction).toUpperCase()} ${row.line} ${stat}`;
    const recentForm = { ...latest, stat, statKey: undefined, line: row.line, direction: String(row.direction).toUpperCase(), historyGames: raw };
    const result = Players.historyView({ title, recentForm, gameIds: [row.gameId], publishedAt: row.quotedAt || row.observedAt }, state, { historyWindow: window });
    return { ...result, source: latest.source, label: title };
  }
  function detailHistoryHTML(row, state, helpers) {
    const recent = rowHistory(row, state, '10');
    if (!recent || !recent.sample) return '<section class="kr-detail-history"><h3>Player form</h3><p>Verified exact-stat history is not available for this line or market window yet.</p></section>';
    const five = rowHistory(row, state, '5'), hit = r => r?.decisions ? `${r.hits}/${r.decisions} · ${r.hitRate.toFixed(0)}%` : '—';
    const form = { stat: recent.stat, line: recent.line, source: recent.source, games: recent.rows.map(r => ({ ...r, label: `${r.date.slice(0, 10)} · ${r.opponent?.abbreviation || 'Opponent unavailable'}` })) };
    return `<section class="kr-detail-history"><h3>Past games at this line</h3><div class="kr-detail-facts"><div><span>Last 5 matching games</span><strong>${hit(five)}</strong><small>${five?.sample || 0} verified · ${five?.pushes || 0} pushes</small></div><div><span>Last 10 matching games</span><strong>${hit(recent)}</strong><small>${recent.sample} verified · ${recent.pushes} pushes</small></div><div><span>Average / median</span><strong>${recent.average.toFixed(1)} / ${recent.median.toFixed(1)}</strong></div></div>${helpers.formChart && !recent.pushes && recent.rows.every(r => r.value >= 0) ? helpers.formChart(form) : '<p>The source-linked log below preserves signed values and pushes.</p>'}<p>Recalculated from sourced game values at ${esc(recent.direction.toUpperCase())} ${recent.line}. ${recent.sample < 10 ? `Incomplete sample: ${recent.sample} of 10 games.` : ''} Pushes are excluded from hit percentages; this is descriptive history, not a win probability.</p><details><summary>Source-linked games</summary><ul>${recent.rows.slice().reverse().map(r => `<li><a href="${esc(r.source)}" target="_blank" rel="noopener noreferrer">${esc(r.date.slice(0, 10))} · ${esc(r.opponent?.abbreviation || 'Opponent unavailable')} ↗</a> ${r.value} · ${r.push ? 'Push' : r.hit ? 'Hit' : 'Miss'}</li>`).join('')}</ul></details></section>`;
  }
  function observationHTML(row) {
    const observations = (row.observations || row.raw?.marketSnapshots || []).filter(o => safeURL(o.source) && time(o.observedAt) != null);
    if (observations.length < 2) return '';
    return `<details class="kr-observations"><summary>Saved observations · ${observations.length}</summary><div class="record-table"><table><thead><tr><th>Observed</th><th>Book / source</th><th>Line</th><th>Price</th></tr></thead><tbody>${observations.map(o => `<tr><td><a href="${esc(o.source)}" target="_blank" rel="noopener noreferrer">${esc(stamp(o.observedAt))} ↗</a><small>${time(row.kickoff) != null && time(o.observedAt) >= time(row.kickoff) ? 'Post-start observation' : 'Pregame observation'}</small></td><td>${esc(o.book || row.book || 'Book unavailable')}<small>${esc(o.quoteType || row.quoteType)}${o.sourcePart ? ` · ${esc(o.sourcePart)}` : ''}</small></td><td>${number(o.line) == null ? '—' : number(o.line)}</td><td>${oddsText(o.odds)}</td></tr>`).join('')}</tbody></table></div><p>These are separate saved observations. No cause of a price change is established here.</p></details>`;
  }
  function detailHTML(row, state = {}, helpers = {}, view = {}) {
    if (!row) return '<button type="button" class="kr-modal-close" data-kr-action="close-detail">Close</button><p>This line is no longer available in the saved board.</p>';
    const q = quoteState(row), links = [...new Set([row.source, ...(row.sources || [])].filter(safeURL))];
    const saved = (view.saved || []).some(item => item.key === row.key);
    return `<div class="kr-detail-head"><div><span class="kr-badge ${row.favorite ? 'favorite' : 'reference'}">${row.favorite ? '★ Favorite' : row.official ? 'Official pick' : 'Observed line · not a recommendation'}</span><h2 id="kr-detail-title">${esc(row.title)}</h2><p>${esc(row.gameLabel)} · ${esc(stamp(row.kickoff))}</p></div><button type="button" class="kr-modal-close" data-kr-action="close-detail" aria-label="Close line details">×</button></div><div class="kr-detail-facts"><div><span>${row.official ? 'Original quote' : 'Observed quote'}</span><strong>${esc(row.book || 'Book unavailable')} ${oddsText(row.odds)}</strong></div><div><span>Availability</span><strong>${esc(q.label)}</strong></div>${row.projection != null ? `<div><span>Original projection</span><strong>${esc(row.projection)}</strong></div>` : ''}${row.confidence != null ? `<div><span>Research confidence</span><strong>${esc(row.confidence)}/10</strong></div>` : ''}</div><div class="kr-detail-body"><p>${row.quotedAt ? `Quoted ${esc(stamp(row.quotedAt))}` : `Observed ${esc(stamp(row.observedAt))}`}${row.expiresAt ? ` · Quote expiry ${esc(stamp(row.expiresAt))}` : ''}. ${esc(row.quoteType || 'Reference snapshot')}.</p>${row.sourcePart ? `<p><strong>Source section:</strong> ${esc(row.sourcePart)}</p>` : ''}${row.sourceTimeNote ? `<p>${esc(row.sourceTimeNote)}</p>` : ''}${row.cutoff ? `<p><strong>Original playable limit:</strong> ${esc(row.cutoff)}</p>` : ''}${row.entryNote ? `<p class="kr-note">${esc(row.entryNote)}</p>` : ''}${detailHistoryHTML(row, state, helpers)}${[['Why', row.why], ['Risk', row.risk], ['Before a pick', row.needs], ['Quote note', row.quoteNote]].filter(([, value]) => value).map(([label, value]) => `<p><strong>${label}:</strong> ${esc(value)}</p>`).join('')}${!row.official ? '<p class="kr-note">This line is market information or research. Saving it does not make it an official recommendation.</p>' : '<p class="kr-note">Original recommendations stay fixed for the record. A historical quote is not a promise of current availability.</p>'}<div class="sources">${links.map((link, i) => `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Source ${i + 1} ↗</a>`).join('')}</div>${observationHTML(row)}</div><div class="kr-detail-actions">${saveable(row) ? `<button type="button" data-kr-action="save" data-kr-key="${esc(row.key)}" aria-pressed="${saved}">${saved ? '✓ Saved · remove' : 'Save to draft'}</button>` : ''}${row.profile ? `<a href="${row.profile}">Full player stats & history →</a>` : ''}${row.gameId ? `<a href="#game/${encodeURIComponent(row.gameId)}">Game breakdown →</a>` : ''}</div>`;
  }
  function pageHTML(state = {}, view = {}, helpers = {}) {
    const v = { ...defaults(), ...view }, catalog = rows(state), shown = filteredRows(state, catalog, v), base = catalog.filter(row => (!state.league || row.league === state.league) && (!state.week || dateWeek(row.kickoff) === state.week));
    const liveCount = base.filter(row => quoteState(row).type !== 'closed').length, settledCount = base.length - liveCount;
    const options = (key, title) => [['all', title], ...[...new Set(base.map(row => row[key]).filter(Boolean))].sort().map(value => [value, key === 'gameId' ? base.find(row => row.gameId === value).gameLabel : value])];
    const favorites = shown.filter(row => row.favorite), others = shown.filter(row => !row.favorite), activeFilters = ['game', 'position', 'market', 'book'].some(key => v[key] !== 'all');
    const parlayPage = v.route === 'parlays', published = Records?.latest(state.reports || []).filter(p => p.kind === 'parlays' && p.league === state.league && (p.gameIds || []).some(id => { const g = (state.slate?.games || []).find(x => x.id === id); return g && (!state.week || dateWeek(g.kickoff) === state.week); })) || [];
    const heading = `<div class="kr-board-heading"><div><h2>${parlayPage ? 'Parlay lab' : 'Picks & lines'}</h2><p>${parlayPage ? 'Build your draft or explore our published tickets.' : `${liveCount} open · ${base.filter(row => row.favorite).length} of ours · ${settledCount} settled`}</p></div><a href="${parlayPage ? '#props' : '#parlays'}">${parlayPage ? 'Back to picks & lines →' : '⇄ Build a parlay →'}</a></div>${state.footballError ? '<p class="kr-note">Football data could not load. Missing lines may reflect that failure.</p>' : ''}`;
    const lines = `<div class="kr-tabs" aria-label="Line selection">${[['live', `Open${liveCount ? ' · ' + liveCount : ''}`], ['favorites', 'Our picks'], ['official', 'Official'], ['research', 'Research'], ['saved', 'Saved'], ['settled', `Settled${settledCount ? ' · ' + settledCount : ''}`]].map(([key, label]) => `<button type="button" data-kr-action="scope" data-kr-scope="${key}" aria-pressed="${v.scope === key}">${label}</button>`).join('')}</div><div class="kr-lean-guide" aria-label="Pick color guide"><span class="green">Green · strong qualified lean</span><span class="yellow">Yellow · qualified with caution</span><span class="red">Red · no current entry</span></div><div class="kr-board-tools"><label class="kr-search">Search<input type="search" data-kr-field="query" placeholder="Player, team or market" value="${esc(v.query)}"></label><details class="kr-filter-disclosure"${activeFilters ? ' open' : ''}><summary>Game, position, market & book${activeFilters ? ' · filters applied' : ''}</summary><div class="kr-filters">${select('game', 'Game', options('gameId', 'All games'), v.game)}${select('position', 'Position', options('position', 'All positions'), v.position)}${select('market', 'Market', options('market', 'All markets'), v.market)}${select('book', 'Book', options('book', 'All books'), v.book)}${select('sort', 'Sort', [['favorites', 'Favorites first'], ['time', 'Game time'], ['player', 'Player / team']], v.sort)}<button type="button" data-kr-action="clear-filters">Clear filters</button></div></details></div>${!shown.length ? (v.scope === 'live' && settledCount && !v.query && !activeFilters ? `<div class="kr-empty"><h3>Nothing open right now</h3><p>${settledCount} ${settledCount === 1 ? 'line has' : 'lines have'} already kicked off. They stay in the record, out of the way.</p><button type="button" data-kr-action="scope" data-kr-scope="settled">Show settled lines</button></div>` : '<div class="kr-empty"><h3>No lines in this view</h3><p>Try another filter or week. No market is invented to fill the board.</p></div>') : ''}${favorites.length ? `<section class="kr-favorites"><div class="kr-list-heading"><h3>Our favorites</h3><span>${favorites.length} original selections</span></div><div class="kr-list">${favorites.map(row => rowHTML(row, v)).join('')}</div></section>` : ''}${others.length ? `<section><div class="kr-list-heading"><h3>${v.scope === 'research' ? 'Research candidates' : v.scope === 'saved' ? 'Saved lines' : v.scope === 'settled' ? 'Settled lines' : 'Other open lines'}</h3><span>${others.length} rows</span></div><div class="kr-list">${others.map(row => rowHTML(row, v)).join('')}</div></section>` : ''}<p class="kr-note">Official picks are marked. Market and research rows are references unless a current sportsbook quote is explicitly shown. Quote times are individual snapshots; availability can change.</p>${state.marketLines?.coverage ? `<details class="kr-coverage"><summary>Market coverage & sources</summary><p>${esc(typeof state.marketLines.coverage === 'string' ? state.marketLines.coverage : state.marketLines.coverage.note || 'Only verified source rows are listed; coverage is incomplete.')}</p><p>Feed ${esc(state.marketLines.status || 'status unavailable')} · ${esc(stamp(state.marketLines.updatedAt))}</p></details>` : ''}`;
    const detail = `<dialog id="kr-detail" class="kr-detail" aria-labelledby="kr-detail-title">${detailHTML(catalog.find(row => row.key === v.detail), state, helpers, v)}</dialog>`;
    if (parlayPage) {
      const tabs = `<nav class="kr-ticket-tabs" aria-label="Parlay sections">${[['build','Build a ticket'],['published',`Our published tickets · ${published.length}`]].map(([key,label]) => `<button type="button" data-kr-action="ticket-tab" data-kr-tab="${key}" aria-pressed="${v.ticketTab === key}">${label}</button>`).join('')}</nav>`;
      const publishedHTML = `<section class="kr-published-tickets"><h3>Our published tickets</h3><p>These are tracked at 1u each. Your shuffled drafts stay separate.</p>${published.length && helpers.parlayBoard ? helpers.parlayBoard(published) : '<p class="kr-empty">No verified parlay published for this slate yet.</p>'}</section>`;
      return `<div class="kr-board kr-ticket-page"><section class="kr-board-main">${heading}${tabs}${v.ticketTab === 'published' ? publishedHTML : `${builderHTML(state,catalog,v)}<details class="kr-ticket-pool"${v.poolOpen ? ' open' : ''}><summary>Add your own lines</summary>${lines}</details>`}</section></div>${detail}`;
    }
    return `<div class="kr-board"><section class="kr-board-main">${heading}${lines}</section><aside class="kr-slip" aria-labelledby="kr-slip-title-rail">${slipHTML(catalog, v)}</aside></div><button type="button" class="kr-slip-dock" data-kr-action="open-slip">${v.saved.length ? `Review ${v.saved.length} legs` : 'Build a ticket'}</button><dialog id="kr-slip-dialog" class="kr-slip-dialog" aria-labelledby="kr-slip-title-modal">${slipHTML(catalog, v, 'modal')}</dialog>${detail}`;
  }

  function readSaved(storage) {
    try {
      const data = JSON.parse(storage?.getItem(STORAGE) || 'null');
      if (data?.version !== VERSION || !Array.isArray(data.saved)) return {};
      const saved = data.saved.filter(item => typeof item?.key === 'string' && item.key.length < 500 && item.snapshot?.key === item.key && typeof item.signature === 'string' && saveable(item.snapshot)).slice(0, 20).map(item => ({ key: item.key, signature: item.signature, snapshot: snapshot(item.snapshot) }));
      return { locked: Array.isArray(data.locked) ? data.locked.filter(key => saved.some(item => item.key === key)) : [], saved: [...new Map(saved.map(item => [item.key, item])).values()], stake: number(data.stake) > 0 ? number(data.stake) : 1, stakeMode: data.stakeMode === 'money' ? 'money' : 'units', unitValue: number(data.unitValue) > 0 ? number(data.unitValue) : 1 };
    } catch { return {}; }
  }
  function persist(storage, view) { try { storage?.setItem(STORAGE, JSON.stringify({ version: VERSION, locked: view.locked || [], saved: view.saved.map(item => ({ key: item.key, signature: item.signature, snapshot: snapshot(item.snapshot) })), stake: view.stake, stakeMode: view.stakeMode, unitValue: view.unitValue })); return true; } catch { return false; } }
  function render({ state, helpers = {} }) {
    if (typeof document === 'undefined') return;
    const content = document.querySelector('#content'); if (!content) return;
    if (!loaded) { let storage; try { storage = localStorage; } catch {} currentView = { ...currentView, ...readSaved(storage) }; loaded = true; }
    const route = location.hash === '#parlays' ? 'parlays' : 'props';
    if (currentView.route !== route || !content.querySelector('.kr-board')) { currentView.detail = null; currentView.slipOpen = false; }
    if (currentView.context && currentView.context !== `${state.league}:${state.week}`) { for (const field of ['game', 'position', 'market', 'book', 'shuffleGame']) currentView[field] = 'all'; currentView.shuffleMessage = ''; }
    currentView.context = `${state.league}:${state.week}`; currentView.route = route;
    const draw = () => {
      const pool = content.querySelector('.kr-ticket-pool'); if (pool) currentView.poolOpen = pool.open;
      const advanced = content.querySelector('.kr-shuffle-advanced'); if (advanced) currentView.advancedOpen = advanced.open;
      const previousDialog = content.querySelector('dialog[open]'), dialogScroll = previousDialog?.scrollTop || 0, pageScroll = window.scrollY, active = document.activeElement;
      const activeAction = previousDialog?.contains(active) ? active?.dataset?.krAction : null;
      const builderFocus = !previousDialog && active?.dataset?.krAction ? {action:active.dataset.krAction,key:active.dataset.krKey,tab:active.dataset.krTab,scope:active.dataset.krScope} : null;
      content.innerHTML = pageHTML(state, currentView, helpers);
      const dialog = currentView.detail ? content.querySelector('#kr-detail') : currentView.slipOpen ? content.querySelector('#kr-slip-dialog') : null;
      if (dialog) { dialog.showModal(); if (previousDialog?.id === dialog.id) { dialog.scrollTop = dialogScroll; if (activeAction) [...dialog.querySelectorAll('[data-kr-action]')].find(button => button.dataset.krAction === activeAction)?.focus({ preventScroll: true }); } }
      else if (previousDialog && returnFocus) {
        const target = returnFocus.kind === 'slip' ? content.querySelector('[data-kr-action="open-slip"]') : [...content.querySelectorAll('.kr-draft-workspace [data-kr-action="detail"], .kr-row [data-kr-action="detail"]')].find(button => button.dataset.krKey === returnFocus.key);
        target?.focus({ preventScroll: true }); returnFocus = null;
      }
      if (!dialog && builderFocus) [...content.querySelectorAll('[data-kr-action]')].find(button => button.dataset.krAction === builderFocus.action && button.dataset.krKey === builderFocus.key && button.dataset.krTab === builderFocus.tab && button.dataset.krScope === builderFocus.scope)?.focus({preventScroll:true});
      if (previousDialog) window.scrollTo({ top: pageScroll, behavior: 'instant' });
    };
    rendering = { state, helpers, draw };
    if (boundContent !== content) {
      if (boundContent && handlers) { boundContent.removeEventListener('click', handlers.click); boundContent.removeEventListener('change', handlers.change); boundContent.removeEventListener('input', handlers.input); boundContent.removeEventListener('cancel', handlers.cancel, true); }
      const save = () => { let storage; try { storage = localStorage; } catch {} persist(storage, currentView); };
      const redraw = () => rendering.draw();
      const click = async event => {
        const navigation = event.target.closest('a[href^="#"]');
        if (navigation) { currentView.detail = null; currentView.slipOpen = false; content.querySelector('#kr-detail')?.close(); content.querySelector('#kr-slip-dialog')?.close(); return; }
        const action = event.target.closest('[data-kr-action]'); if (!action) { const rowElement = event.target.closest('[data-kr-row]'); if (rowElement && !event.target.closest('a,button,input,select,textarea')) { currentView.detail = rowElement.dataset.krRow; currentView.slipOpen = false; returnFocus = { kind: 'detail', key: currentView.detail }; redraw(); } return; }
        const catalog = rows(rendering.state), row = catalog.find(r => r.key === action.dataset.krKey), kind = action.dataset.krAction;
        if (kind === 'detail') { currentView.detail = row?.key || null; currentView.slipOpen = false; returnFocus = { kind: 'detail', key: row?.key }; }
        else if (kind === 'close-detail') currentView.detail = null;
        else if (kind === 'open-slip') { currentView.slipOpen = true; currentView.detail = null; returnFocus = { kind: 'slip' }; }
        else if (kind === 'close-slip') currentView.slipOpen = false;
        else if (kind === 'ticket-tab') { currentView.ticketTab = action.dataset.krTab; currentView.detail = null; }
        else if (kind === 'scope') currentView.scope = action.dataset.krScope;
        else if (kind === 'clear-filters') { currentView.query = ''; for (const field of ['game', 'position', 'market', 'book']) currentView[field] = 'all'; }
        else if (kind === 'save' && row && saveable(row)) { const exists = currentView.saved.some(item => item.key === row.key); currentView.saved = exists ? currentView.saved.filter(item => item.key !== row.key) : [...currentView.saved, saveRow(row)].slice(0, 20); currentView.locked = currentView.locked.filter(key => currentView.saved.some(item => item.key === key)); currentView.copyStatus = ''; save(); }
        else if (kind === 'remove') { currentView.saved = currentView.saved.filter(item => item.key !== action.dataset.krKey); currentView.locked = currentView.locked.filter(key => key !== action.dataset.krKey); currentView.shuffleMessage = ''; save(); }
        else if (kind === 'reprice' && row) { currentView.saved = currentView.saved.map(item => item.key === row.key ? saveRow(row) : item); save(); }
        else if (kind === 'clear') { currentView.saved = []; currentView.locked = []; currentView.undo = null; currentView.shuffleMessage = ''; save(); }
        else if (kind === 'lock') { currentView.locked = currentView.locked.includes(action.dataset.krKey) ? currentView.locked.filter(key => key !== action.dataset.krKey) : [...currentView.locked,action.dataset.krKey]; save(); }
        else if (kind === 'shuffle') {
          const previous = reconcileSaved(currentView.saved,catalog), generator = typeof window !== 'undefined' && window.KeenShuffle;
          const result = generator?.generate(catalog,{count:Number(currentView.shuffleCount),book:currentView.shuffleBook,game:currentView.shuffleGame,mode:currentView.shuffleMode,league:rendering.state.league,week:rendering.state.week,locked:previous.filter(row => currentView.locked.includes(row.key)),previous,target:currentView.shuffleMode === 'current' && currentView.target !== '' ? currentView.target : null});
          currentView.shuffleMessage = result?.reason || 'The shuffle tool could not load. Your draft is unchanged; reload to try again.';
          if (result?.available && JSON.stringify(result.rows.map(row => saveRow(row).signature).sort()) !== JSON.stringify(currentView.saved.map(item => item.signature).sort())) { currentView.undo = {saved:currentView.saved.map(item => ({...item})),locked:[...currentView.locked]}; currentView.saved = result.rows.map(saveRow); currentView.locked = currentView.locked.filter(key => result.rows.some(row => row.key === key)); currentView.copyStatus = ''; save(); }
        }
        else if (kind === 'undo-shuffle' && currentView.undo) { currentView.saved = currentView.undo.saved; currentView.locked = currentView.undo.locked; currentView.undo = null; currentView.shuffleMessage = 'Previous draft restored. Quote freshness is checked again.'; save(); }
        else if (kind === 'suggestion') { try { const keys = JSON.parse(action.dataset.krKeys), chosen = keys.map(key => catalog.find(r => r.key === key)); if (chosen.length === 2 && summarizeTicket(chosen.filter(Boolean)).available) { currentView.saved = chosen.map(saveRow); save(); } } catch {} }
        else if (kind === 'copy') { try { await navigator.clipboard.writeText(ticketText(reconcileSaved(currentView.saved, catalog))); currentView.copyStatus = 'Copied. Paste into Gambly and review the matched markets.'; } catch { currentView.copyStatus = 'Copy unavailable. Open the copyable ticket below and copy it manually.'; } }
        redraw();
      };
      const changeField = (event, typing) => {
        const control = event.target.closest('[data-kr-field]'); if (!control || (typing && control.dataset.krField !== 'query')) return;
        const field = control.dataset.krField; if (!['query', 'game', 'position', 'market', 'book', 'sort', 'stake', 'stakeMode', 'unitValue', 'target', 'shuffleCount', 'shuffleBook', 'shuffleGame', 'shuffleMode'].includes(field)) return;
        const start = field === 'query' ? control.selectionStart : null, modal = Boolean(control.closest('dialog'));
        currentView[field] = ['stake', 'unitValue', 'target'].includes(field) && control.value !== '' ? number(control.value) : control.value; if (field.startsWith('shuffle')) currentView.shuffleMessage = ''; save(); redraw();
        const replacement = content.querySelector(`${modal ? 'dialog[open] ' : '.kr-board '}[data-kr-field="${field}"]`); replacement?.focus(); if (start != null) replacement?.setSelectionRange(start, start);
      };
      const change = event => changeField(event, false), input = event => changeField(event, true), cancel = event => { if (!['kr-detail', 'kr-slip-dialog'].includes(event.target.id)) return; event.preventDefault(); currentView.detail = null; currentView.slipOpen = false; redraw(); };
      handlers = { click, change, input, cancel }; content.addEventListener('click', click); content.addEventListener('change', change); content.addEventListener('input', input); content.addEventListener('cancel', cancel, true); boundContent = content;
    }
    draw();
  }
  return { rows, pageHTML, render, quoteState, eligible, saveable, saveRow, reconcileSaved, summarizeTicket, suggestions, ticketText, readSaved, persist, filteredRows, dateWeek, rowHistory };
});


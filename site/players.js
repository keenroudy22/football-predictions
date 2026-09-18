(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KeenPlayers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const leagues = { NFL: 'NFL', CFB: 'College football', NBA: 'NBA', MLB: 'MLB' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const validTime = value => Boolean(value) && Number.isFinite(Date.parse(value));
  const stamp = value => validTime(value) ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) + ' ET' : 'Time not recorded';
  const url = value => typeof value === 'string' && /^https:\/\//.test(value);
  const sourceLinks = values => `<div class="sources">${[...new Set((values || []).filter(url))].map((value, i) => `<a href="${esc(value)}" target="_blank" rel="noopener noreferrer">Source ${i + 1} ↗</a>`).join('')}</div>`;
  const idValue = value => value != null && /^[a-zA-Z0-9_-]+$/.test(String(value)) ? String(value) : null;
  const normalize = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const statName = value => ({ carries: 'rushing attempts', 'rush attempts': 'rushing attempts', catches: 'receptions', 'rec yards': 'receiving yards', 'rush yards': 'rushing yards', 'pass yards': 'passing yards' }[normalize(value)] || normalize(value));
  const parsedMarket = title => {
    const match = String(title || '').match(/^(.+?)\s+(?:[—–-]\s*)?(OVER|UNDER)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);
    return match ? { name: match[1].trim(), direction: match[2].toLowerCase(), line: Number(match[3]), stat: statName(match[4]) } : null;
  };
  const playerName = record => record.player || record.playerName || parsedMarket(record.marketTitle || record.title)?.name || String(record.title || '').match(/^(.+?)\s+(?:—\s*)?(?:anytime|ATTD)\b/i)?.[1]?.trim() || null;
  const route = (league, athleteId) => `#player/${league}/${encodeURIComponent(athleteId)}`;
  let filters = { query: '', league: 'All', position: 'All', market: '', historyWindow: '10', historyOpponent: 'all', historyVenue: 'all' }, lastRoute = '';

  function matches(hash) { return hash === '#players' || /^#player\//.test(hash || ''); }
  function reportRecords(report) {
    return [['props', report.props], ['riskyProps', report.riskyProps], ['watch', report.gameWatch]].flatMap(([kind, records]) => (records || []).map(p => ({ ...p, kind, league: report.league, publishedAt: report.publishedAt })));
  }
  function leagueFor(p, state) {
    if (leagues[p.league]) return p.league;
    const matches = [...new Set((state.reports || []).filter(r => reportRecords(r).some(x => x.id === p.id)).map(r => r.league))];
    return matches.length === 1 && leagues[matches[0]] ? matches[0] : null;
  }
  function identity(p, state, league) {
    const watch = p.kind === 'watch' || p.kind === 'gameWatch' || Boolean(p.gameId && !p.gameIds);
    const saved = watch ? null : state.history?.picks?.[p.id];
    const athleteId = idValue(p.athleteId) || idValue(saved?.athleteId);
    return league && athleteId ? { league, athleteId } : null;
  }
  function hrefFor(p, state) {
    const found = identity(p || {}, state || {}, leagueFor(p || {}, state || {}));
    return found ? route(found.league, found.athleteId) : '#players';
  }
  function exactForm(form, record) {
    if (!form || !url(form.source)) return null;
    const market = parsedMarket(record.marketTitle || record.title);
    if (!market || typeof form.line !== 'number' || !Number.isFinite(form.line) || market.line !== Number(form.line) || market.stat !== statName(form.stat)) return null;
    if (form.direction && normalize(form.direction) !== market.direction) return null;
    const games = Array.isArray(form.games) ? form.games : [];
    if (!games.length || games.some(g => typeof g.value !== 'number' || !Number.isFinite(g.value) || typeof g.hit !== 'boolean' || g.hit !== (market.direction === 'over' ? g.value > market.line : g.value < market.line))) return null;
    return form;
  }
  function recordForm(record, saved, state) {
    if (record.kind === 'watch') {
      if (!saved || saved.gameId !== record.gameId || !record.marketTitle || saved.marketTitle !== record.marketTitle) return null;
      return exactForm(saved.recentForm, record);
    }
    const embedded = exactForm(record.recentForm, record);
    if (!saved || (record.athleteId && saved.athleteId && String(record.athleteId) !== String(saved.athleteId))) return embedded;
    if (saved.gameId && !(record.gameIds || []).includes(saved.gameId)) return embedded;
    if (saved.marketTitle && saved.marketTitle !== (record.marketTitle || record.title)) return embedded;
    const enriched = exactForm(saved.recentForm, record);
    if (enriched?.historyGames?.length && validTime(enriched.checkedAt) && (!validTime(embedded?.checkedAt) || Date.parse(enriched.checkedAt) >= Date.parse(embedded.checkedAt))) return enriched;
    return embedded || enriched;
  }
  function index(state = {}) {
    const latest = new Map();
    const records = (state.reports || []).flatMap(reportRecords).filter(p => leagues[p.league] && p.id).sort((a, b) => (Date.parse(a.publishedAt) || 0) - (Date.parse(b.publishedAt) || 0));
    records.forEach(p => {
      const key = `${p.league}:${p.kind}:${p.id}`, previous = latest.get(key);
      if (p.kind === 'watch') { latest.set(key, p); return; }
      const merged = { ...previous, ...p, originalPublishedAt: previous ? previous.originalPublishedAt : p.publishedAt };
      for (const field of ['title', 'marketTitle', 'gameIds', 'projection', 'confidence', 'favorite', 'line', 'direction', 'odds', 'book', 'quotedAt', 'expiresAt', 'cutoff']) {
        const original = `original${field[0].toUpperCase()}${field.slice(1)}`;
        merged[original] = previous ? previous[original] : p[field];
      }
      latest.set(key, merged);
    });
    const players = new Map();
    latest.forEach(latestRecord => {
      const p = { ...latestRecord };
      if (p.kind !== 'watch') for (const field of ['title', 'marketTitle', 'gameIds', 'projection', 'confidence', 'favorite', 'line', 'direction', 'odds', 'book', 'quotedAt', 'expiresAt', 'cutoff']) p[field] = p[`original${field[0].toUpperCase()}${field.slice(1)}`];
      const found = identity(p, state, p.league), name = playerName(p);
      if (!found || !name) return;
      const saved = p.kind === 'watch' ? state.history?.watches?.[p.id] : state.history?.picks?.[p.id];
      const gameIds = p.gameIds?.length ? p.gameIds : p.gameId ? [p.gameId] : saved?.gameId ? [saved.gameId] : [];
      const recentForm = recordForm({ ...p, gameIds }, saved, state);
      const record = { ...p, key: `${p.kind}:${p.id}`, official: p.kind !== 'watch', gameIds, athleteId: found.athleteId, recentForm, historyReason: recentForm ? '' : 'Exact-market history is not verified for this recorded line and direction.' };
      const key = `${found.league}:${found.athleteId}`;
      if (!players.has(key)) players.set(key, { key, ...found, name, position: p.position || saved?.position || 'Unknown', href: route(found.league, found.athleteId), lastUpdatedAt: p.publishedAt, records: [] });
      const player = players.get(key);
      player.name = name;
      player.position = p.position || saved?.position || player.position;
      player.lastUpdatedAt = p.publishedAt;
      player.records.push(record);
    });
    for (const player of players.values()) {
      player.records.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0) || Number(b.official) - Number(a.official));
      player.lastUpdatedAt = player.records[0].publishedAt;
      player.name = playerName(player.records[0]) || player.name;
      player.position = player.records[0].position || player.position;
      const meta = state.identities?.players?.[`${player.league}/${player.athleteId}`];
      if (meta && String(meta.athleteId) === player.athleteId && meta.league === player.league && url(meta.source)) {
        player.identity = meta;
        player.name = meta.name || player.name;
        player.position = meta.position || player.position;
        player.team = meta.team || null;
      }
    }
    return [...players.values()].sort((a, b) => {
      const aOfficial=a.records.some(r=>r.official),bOfficial=b.records.some(r=>r.official);
      return Number(bOfficial)-Number(aOfficial)||(Date.parse(b.lastUpdatedAt)||0)-(Date.parse(a.lastUpdatedAt)||0)||b.records.length-a.records.length||a.name.localeCompare(b.name);
    });
  }
  function select(id, label, options, value) { return `<label>${esc(label)}<select id="${id}">${options.map(([key, text]) => `<option value="${esc(key)}"${key === value ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`; }
  function identityNote(player) {
    const m = player.identity;
    return m ? `<p class="player-profile-meta">${player.team?.name ? `Team snapshot: ${esc(player.team.name)} · ` : ''}${identityStale(m) ? 'Older roster snapshot · refresh due. ' : ''}Checked ${esc(stamp(m.checkedAt))}. <a href="${esc(m.source)}" target="_blank" rel="noopener noreferrer">Player source ↗</a></p>` : '<p class="player-profile-meta">Team and roster verification unavailable. No current team is inferred from a matchup.</p>';
  }
  function identityStale(m) { return !validTime(m?.checkedAt) || Date.now() - Date.parse(m.checkedAt) > 7 * 86400000 || ['stale', 'unavailable', 'error', 'failed'].includes(m.status); }
  function directory(state, view) {
    const players = index(state), league = leagues[view.league] ? view.league : 'All';
    const positions = [...new Set(players.filter(p => league === 'All' || p.league === league).map(p => p.position))].sort();
    const position = positions.includes(view.position) ? view.position : 'All';
    const query = normalize(view.query);
    const shown = players.filter(p => (league === 'All' || p.league === league) && (position === 'All' || p.position === position) && (!query || normalize(`${p.name} ${p.team?.name || ''} ${p.team?.abbreviation || ''}`).includes(query)));
    const empty = league === 'NBA' || league === 'MLB' ? `No tracked ${league} player research yet. Those sports currently have schedules and scores only.` : 'No players match this view. Try another name, sport or position. Only players with a verified athlete ID appear.';
    return `<section class="players-page"><div class="players-heading"><div><h2>Find a player</h2><p class="players-coverage">Players we follow, from collected research; not every player.</p></div><a href="#props">Back to picks →</a></div><div class="player-search-controls"><label>Search players<input id="player-search" type="search" value="${esc(view.query || '')}" placeholder="Player or verified team name" autocomplete="off"></label>${select('player-league', 'Sport', [['All', 'All sports'], ...Object.entries(leagues)], league)}${select('player-position', 'Position', [['All', 'All positions'], ...positions.map(p => [p, p])], position)}</div><p class="players-coverage">${shown.length} player${shown.length === 1 ? '' : 's'} · Research spans recorded games and seasons. Availability and prices belong to their original snapshots.</p><div class="player-results">${shown.length ? shown.map(p => `<a class="player-tile" href="${p.href}"><div><span class="tag">${esc(leagues[p.league])} · ${esc(p.position)}</span><h3>${esc(p.name)}</h3>${p.team?.name ? `<p>${esc(p.team.name)} · ${identityStale(p.identity) ? 'older roster snapshot' : 'roster snapshot'} · ${esc(stamp(p.identity?.checkedAt))}</p>` : ''}<p>${p.records.filter(r => r.official).length} official selection${p.records.filter(r => r.official).length === 1 ? '' : 's'} · ${p.records.filter(r => !r.official).length} research look${p.records.filter(r => !r.official).length === 1 ? '' : 's'}</p><small>Research ${esc(stamp(p.lastUpdatedAt))}</small></div><strong>View player →</strong></a>`).join('') : `<div class="player-history-empty"><h3>No tracked players in this view</h3><p>${esc(empty)}</p></div>`}</div></section>`;
  }
  function gameContext(record, state) {
    const games = new Map((state.slate?.games || []).map(g => [g.id, g]));
    return (record.gameIds || []).map(id => {
      const g = games.get(id);
      return g ? `<p class="player-game-context"><a href="#game/${esc(id)}">${esc(g.away?.abbreviation || g.away?.name)} @ ${esc(g.home?.abbreviation || g.home?.name)} →</a> · ${esc(stamp(g.kickoff))}</p>` : '<p class="player-game-context">Recorded game context unavailable.</p>';
    }).join('') || '<p class="player-game-context">No linked game has been verified.</p>';
  }
  function rate(value, size, form) {
    return value && value.sample === size && Number.isInteger(value.hits) && value.hits >= 0 && value.hits <= size && form.games.length >= size && form.games.slice(-size).filter(g => g.hit).length === value.hits ? `${value.hits}/${size} · ${(value.hits / size * 100).toFixed(0)}%` : 'Not verified';
  }
  function historyView(record, state = {}, view = {}) {
    const form = record?.recentForm, market = parsedMarket(record?.marketTitle || record?.title);
    const empty = { rows: [], allRows: [], sample: 0, hits: 0, misses: 0, pushes: 0, decisions: 0, hitRate: null, average: null, median: null, requested: null, complete: false, excluded: 0, opponentId: null, opponentLabel: 'Recorded opponent', targetSeason: null, cutoffAt: null, status: form?.status || 'unavailable', coverage: form?.coverage || null };
    const marketKeys = { 'receiving yards': 'receivingYards', receptions: 'receptions', 'passing yards': 'passingYards', completions: 'completions', 'rushing yards': 'rushingYards', 'rushing attempts': 'rushingAttempts', 'passing attempts': 'passingAttempts' };
    if (!market || !form || !url(form.source) || typeof form.line !== 'number' || market.line !== form.line || market.stat !== statName(form.stat) || (form.direction && normalize(form.direction) !== market.direction) || (form.statKey && form.statKey !== marketKeys[market.stat])) return empty;
    const targetGames = (record.gameIds || (record.gameId ? [record.gameId] : [])).map(id => (state.slate?.games || []).find(g => g.id === id)).filter(Boolean);
    const targets = new Set((record.gameIds || (record.gameId ? [record.gameId] : [])).map(id => String(id).split('-').at(-1)));
    const cutoffs = [form.cutoffAt, record.originalPublishedAt || record.publishedAt, ...targetGames.map(g => g.kickoff)].filter(validTime).map(Date.parse);
    if (!cutoffs.length) return empty;
    const cutoff = Math.min(...cutoffs), sourceRows = Array.isArray(form.historyGames) ? form.historyGames : Array.isArray(form.games) ? form.games : [];
    const unique = new Map(), conflicts = new Set();
    for (const row of sourceRows) {
      const eventId = idValue(row.eventId), sourceId = url(row.source) ? row.source.match(/\/gameId\/([^/?#]+)/)?.[1] : null;
      if (!eventId || eventId !== sourceId || targets.has(eventId) || typeof row.value !== 'number' || !Number.isFinite(row.value) || !validTime(row.date) || Date.parse(row.date) >= cutoff || !['regular', 2, '2'].includes(row.seasonType) || !Number.isInteger(row.season)) continue;
      if (conflicts.has(eventId)) continue;
      if (unique.has(eventId) && unique.get(eventId).value !== row.value) { unique.delete(eventId); conflicts.add(eventId); continue; }
      unique.set(eventId, { ...row, eventId, hit: market.direction === 'over' ? row.value > market.line : row.value < market.line, push: row.value === market.line });
    }
    const allRows = [...unique.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const opponentId = idValue(form.vsOpponent?.opponentId), opponent = allRows.find(r => opponentId && String(r.opponent?.id) === opponentId)?.opponent || targetGames.flatMap(g => [g.away, g.home]).find(team => opponentId && String(team?.id) === opponentId);
    const opponentLabel = opponent?.name || opponent?.abbreviation || (opponentId ? `Opponent ${opponentId}` : 'Recorded opponent');
    const targetSeason = targetGames.find(g => Number.isInteger(g.season))?.season ?? null;
    const window = ['5', '10', '20', 'season'].includes(String(view.historyWindow)) ? String(view.historyWindow) : '10';
    let rows = allRows.filter(row => (view.historyOpponent !== 'opponent' || (opponentId && String(row.opponent?.id) === opponentId)) && (view.historyVenue !== 'home' || row.isHome === true) && (view.historyVenue !== 'away' || row.isHome === false));
    if (window === 'season') rows = rows.filter(row => targetSeason != null && row.season === targetSeason);
    else rows = rows.slice(-Number(window));
    const sample = rows.length, hits = rows.filter(row => row.hit).length, pushes = rows.filter(row => row.push).length, misses = sample - hits - pushes, decisions = hits + misses;
    const values = rows.map(row => row.value).sort((a, b) => a - b);
    return { ...empty, rows, allRows, line: market.line, direction: market.direction, stat: form.stat, sample, hits, misses, pushes, decisions, hitRate: decisions ? 100 * hits / decisions : null, average: sample ? values.reduce((sum, value) => sum + value, 0) / sample : null, median: sample ? (values[Math.floor((sample - 1) / 2)] + values[Math.floor(sample / 2)]) / 2 : null, requested: window === 'season' ? null : Number(window), complete: window !== 'season' && sample === Number(window), excluded: sourceRows.length - allRows.length, opponentId, opponentLabel, targetSeason, cutoffAt: new Date(cutoff).toISOString(), checkedAt: form.checkedAt || null };
  }
  function historyChart(snapshot) {
    const rows = snapshot.rows.slice(-20);
    if (!rows.length) return '<p class="player-history-empty">No verified games match these filters.</p>';
    const low = Math.min(0, ...rows.map(row => row.value)), high = Math.max(snapshot.line || 0, ...rows.map(row => row.value), 0), range = Math.max(high - low, 1), zero = -low / range * 100;
    const bars = rows.map(row => {
      const outcome = row.push ? 'Push' : row.hit ? 'Hit' : 'Miss', opponent = row.opponent?.abbreviation || row.opponent?.name || 'Unknown opponent';
      const height = Math.abs(row.value) / range * 100, bottom = (Math.min(0, row.value) - low) / range * 100;
      return `<li class="form-game ${outcome.toLowerCase()}${row.value < 0 ? ' negative' : ''}" data-value="${row.value}" title="${esc(row.date.slice(0, 10))} · ${esc(opponent)}: ${row.value} · ${outcome}"><span class="form-outcome">${outcome.toUpperCase()}</span><span class="form-bar" style="position:absolute;left:50%;transform:translateX(-50%);min-height:0;bottom:${bottom.toFixed(3)}%;height:${height.toFixed(3)}%"><span>${row.value}</span></span><small>${esc(opponent)}</small></li>`;
    }).join('');
    return `<figure class="form-chart player-history-chart"><figcaption><strong>Game-by-game ${esc(snapshot.stat)}</strong><span>${rows.length < snapshot.rows.length ? `Latest ${rows.length} of ${snapshot.rows.length} shown` : 'Oldest → newest'}</span></figcaption><ol style="position:relative"><li class="history-zero-line" aria-hidden="true" style="position:absolute;left:0;right:0;bottom:${zero.toFixed(3)}%;border-top:1px dashed #80939f;list-style:none;pointer-events:none"><span style="position:absolute;left:0;bottom:0;font-size:9px">0</span></li>${bars}</ol><p class="form-chart-line">Recorded line: ${esc(snapshot.direction.toUpperCase())} ${snapshot.line} · pushes are separate.${low < 0 ? ' Negative values extend below zero.' : ''}</p>${rows.length > 10 ? '<p class="player-chart-scroll-hint">Swipe or scroll the chart sideways on a narrow screen.</p>' : ''}</figure>`;
  }
  function historyPanel(record, helpers, state, view) {
    const f = record.recentForm;
    if (!f) return `<section class="player-panel player-history-empty"><h3>Recent form</h3><p>${esc(record.historyReason)}</p><p>We do not reuse hit rates from a different line, direction or matchup. More history will appear after verification.</p></section>`;
    const structured = Array.isArray(f.historyGames) || (f.games || []).some(row => row.eventId && row.date);
    if (structured) {
      const snapshot = historyView(record, state, view), selectedWindow = ['5', '10', '20', 'season'].includes(String(view.historyWindow)) ? String(view.historyWindow) : '10';
      const display = value => value == null ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(1);
      const coverage = snapshot.requested != null ? snapshot.complete ? `${snapshot.sample} matching games` : `Incomplete sample: ${snapshot.sample} of ${snapshot.requested} matching games available` : `${snapshot.sample} observed game${snapshot.sample === 1 ? '' : 's'} in recorded season ${snapshot.targetSeason ?? 'unavailable'}`;
      const seasons = [...new Set(snapshot.allRows.map(r => r.season))].sort().join(', ');
      const filteredForm = { ...f, games: snapshot.rows };
      const log = snapshot.rows.length ? `<details class="stat-log player-history-log"><summary>Source-linked game log · ${snapshot.rows.length} games</summary><div class="record-table"><table><thead><tr><th>Game</th><th>Venue</th><th>${esc(f.stat)}</th><th>At ${esc(snapshot.direction)} ${snapshot.line}</th></tr></thead><tbody>${snapshot.rows.slice().reverse().map(row => `<tr><td><a href="${esc(row.source)}" target="_blank" rel="noopener noreferrer">${esc(row.date.slice(0, 10))} · ${esc(row.opponent?.abbreviation || row.opponent?.name || 'Opponent unavailable')} ↗</a><small>${row.season} regular season</small></td><td>${row.isHome === true ? 'Home' : row.isHome === false ? 'Away' : 'Not verified'}</td><td>${row.value}</td><td>${row.push ? 'Push' : row.hit ? 'Hit' : 'Miss'}</td></tr>`).join('')}</tbody></table></div></details>` : '';
      return `<section class="player-panel player-history-explorer"><h3>Player game history</h3><p>${esc(record.marketTitle || record.title)} · original line stays fixed.</p><div class="player-history-controls">${select('player-history-window', 'Games', [['5', 'Last 5'], ['10', 'Last 10'], ['20', 'Last 20'], ['season', 'Recorded season']], selectedWindow)}${select('player-history-opponent', 'Matchup', [['all', 'All opponents'], ['opponent', `Vs ${snapshot.opponentLabel}`]], view.historyOpponent === 'opponent' ? 'opponent' : 'all')}${select('player-history-venue', 'Venue', [['all', 'Home & away'], ['home', 'Home'], ['away', 'Away']], ['home', 'away'].includes(view.historyVenue) ? view.historyVenue : 'all')}</div><p class="player-history-coverage">${coverage}${f.status === 'stale' ? ' · Saved data; refresh delayed' : ''}</p><div class="player-rates player-history-stats"><div><span>Hit rate</span><strong>${snapshot.hitRate == null ? '—' : snapshot.hitRate.toFixed(0) + '%'}</strong><small>${snapshot.hits} hit · ${snapshot.misses} miss · ${snapshot.pushes} push</small></div><div><span>Average</span><strong>${display(snapshot.average)}</strong></div><div><span>Median</span><strong>${display(snapshot.median)}</strong></div><div><span>Sample</span><strong>${snapshot.sample}</strong></div></div>${historyChart(snapshot)}<p class="player-notice">Hit rate excludes pushes. Filters use the most recent matching games before ${esc(stamp(snapshot.cutoffAt))}. Descriptive regular-season history${seasons ? `: ${esc(seasons)}` : ''}; this is not a full career history or a win probability. Missing statistics never count as zero.</p>${snapshot.checkedAt ? `<p class="player-history-coverage">History checked ${esc(stamp(snapshot.checkedAt))}</p>` : ''}${sourceLinks([f.source])}${log}${helpers.workloadPanel ? helpers.workloadPanel(filteredForm) : '<p>Workload detail is not attached.</p>'}</section>`;
    }
    const chart = helpers.formChart ? helpers.formChart(f) : `<ul>${f.games.slice(-10).map(g => `<li>${esc(g.label || g.date)} · ${esc(g.value)} · ${g.hit ? 'Hit' : 'Miss'}</li>`).join('')}</ul>`;
    return `<section class="player-panel"><h3>Recent form at this line</h3><p>${esc(record.marketTitle || record.title)} · ${esc(f.stat)}. Games were gathered before the recorded matchup.</p><div class="player-rates"><div><span>Last 5</span><strong>${rate(f.last5, 5, f)}</strong></div><div><span>Last 10</span><strong>${rate(f.last10, 10, f)}</strong></div><div><span>Verified games</span><strong>${f.games.length}</strong></div></div>${chart}<p class="player-notice">Historical hit rates describe these games; they are not a forecast or win probability. This may be an older season, not the player's latest games today.</p>${sourceLinks([f.source])}${helpers.workloadPanel ? helpers.workloadPanel(f) : '<p>Workload detail is not attached.</p>'}${f.lastVsOpponent ? `<div class="prior-opponent"><strong>Last sourced meeting with this opponent</strong><p>${esc(f.lastVsOpponent.value)} ${esc(f.stat)} · ${esc(f.lastVsOpponent.date)}</p>${sourceLinks([f.lastVsOpponent.source])}<small>One meeting; roles and personnel may have changed.</small></div>` : '<p class="player-notice">No verified player-specific prior meeting attached.</p>'}</section>`;
  }
  function quoteState(record, state) {
    if (!record.official) return 'Early research · not an official pick';
    const games = (record.gameIds || []).map(id => (state.slate?.games || []).find(g => g.id === id));
    if (record.status === 'historical') return 'Historical import · original price may be unavailable';
    if (record.status === 'withdrawn' || record.status === 'replaced') return 'Withdrawn / replaced · preserved for history';
    if (games.some(g => g && (g.state !== 'pre' || Date.parse(g.kickoff) <= Date.now()))) return 'Game started · original selection locked';
    if (/paus/i.test(record.entryNote || '')) return 'Entries paused';
    if (record.status !== 'active' || !validTime(record.expiresAt) || Date.parse(record.expiresAt) <= Date.now()) return 'Quote expired · original selection preserved';
    return 'Published selection · verify the book and playable limit';
  }
  function analysisPanel(record, state, helpers) {
    const odds = Number.isFinite(Number(record.odds)) && record.odds != null ? `${record.odds > 0 ? '+' : ''}${record.odds}` : 'Price unavailable';
    const fields = record.official ? [['Why', record.why], ['Risk', record.risk], ['Estimated edge', record.edge], ['Entry update', record.entryNote]] : [['Why we are watching', record.why], ['Defense matchup', record.defense], ['Offensive-line health', record.lineHealth], ['Blocking performance', record.lineSkill], ['Risk / counterargument', record.risk], ['Before an official pick', record.needs]];
    return `<section class="player-panel"><span class="tag">${record.official ? 'Official selection' : 'Early research'}</span><h3>${esc(record.title)}</h3><p class="player-notice">${esc(quoteState(record, state))}</p>${gameContext(record, state)}${record.official ? `<div class="player-market-facts"><p><strong>Original quote:</strong> ${esc(record.book || 'Book unavailable')} ${esc(odds)}</p>${record.projection != null ? `<p><strong>Projection:</strong> ${esc(record.projection)}</p>` : ''}${record.confidence != null ? `<p><strong>Confidence:</strong> ${esc(record.confidence)}/10</p>` : ''}<p><strong>Playable limit:</strong> ${esc(record.cutoff || 'Not recorded')}</p><p>Original published ${esc(stamp(record.originalPublishedAt || record.publishedAt))}</p><p>Quoted ${esc(stamp(record.quotedAt))}${record.expiresAt ? ` · Expires ${esc(stamp(record.expiresAt))}` : ''}</p></div>` : `<p><strong>${esc(record.lineLabel || 'Waiting for line')}</strong></p><p>${esc(record.quoteNote || 'No verified current price')}</p>`}${fields.filter(([, value]) => value).map(([label, value]) => `<p><strong>${label}:</strong> ${esc(value)}</p>`).join('')}<p class="player-notice">Research recorded ${esc(stamp(record.publishedAt))}${record.nextReviewAt ? ` · Next review ${esc(stamp(record.nextReviewAt))}` : ''}. Missing injury data does not establish availability.</p>${sourceLinks(record.sources)}${helpers.playerMovement ? helpers.playerMovement(record) : '<p>Comparable price history is not attached to this view.</p>'}${record.official && helpers.pickCard ? `<details class="player-ticket-details"><summary>Original pick, payout calculator & settlement</summary>${helpers.pickCard({ ...record, publishedAt: record.originalPublishedAt || record.publishedAt }, 0)}</details>` : ''}</section>`;
  }
  function profile(state, hash, helpers, view) {
    const match = String(hash).match(/^#player\/(NFL|CFB|NBA|MLB)\/([a-zA-Z0-9_-]+)$/);
    const player = match ? index(state).find(p => p.league === match[1] && p.athleteId === match[2]) : null;
    if (!player) return '<section class="players-page"><a href="#players">← Find a player</a><div class="player-history-empty"><h2>Player not found in collected research</h2><p>This profile is not available. Search the players we follow; no identity or statistics are inferred from the URL.</p></div></section>';
    const record = player.records.find(r => r.key === view.market) || player.records[0];
    return `<section class="player-profile"><div class="player-return-links"><a class="back-board" href="#props">← Picks & lines</a><a class="back-board" href="#players">Find a player →</a></div><header class="player-profile-head"><div><p class="eyebrow">${esc(leagues[player.league])} · ${esc(player.position)}</p><h2>${esc(player.name)}</h2><p>Gathered player research · ${player.records.length} tracked market${player.records.length === 1 ? '' : 's'}</p></div></header>${identityNote(player)}<div class="player-market-picker">${select('player-market', 'Choose a recorded market', player.records.map(r => [r.key, `${r.official ? 'Official' : 'Research'} · ${r.marketTitle || r.title} · ${stamp(r.publishedAt)}`]), record.key)}</div><p class="players-coverage">Each market keeps its own line, game and source date. Research looks are not official picks.</p><nav class="player-jumps" aria-label="Player research sections"><button data-game-section="player-history-section">Game history</button><button data-game-section="player-analysis-section">Pick analysis</button><button data-game-section="player-defense-section">Defense matchup</button></nav><div class="player-profile-grid"><div id="player-history-section">${historyPanel(record, helpers, state, view)}</div><div id="player-analysis-section">${analysisPanel(record, state, helpers)}</div></div><div id="player-defense-section">${helpers.matchupPanel ? helpers.matchupPanel(record, player, state) : ''}</div></section>`;
  }
  function pageHTML(state = {}, hash = '#players', helpers = {}, view = {}) {
    const options = { query: '', league: 'All', position: 'All', market: '', historyWindow: '10', historyOpponent: 'all', historyVenue: 'all', ...view };
    const warning = state.footballError ? '<p class="player-notice">Football research could not load on this visit. Missing profiles or markets may reflect that failure; they do not confirm there is no research. Retry when the source is available.</p>' : '';
    return warning + (hash === '#players' ? directory(state, options) : profile(state, hash, helpers, options));
  }
  function render({ state, helpers = {} }) {
    if (typeof document === 'undefined') return;
    const hash = location.hash;
    if (hash !== lastRoute) { filters.market = ''; filters.historyWindow = '10'; filters.historyOpponent = 'all'; filters.historyVenue = 'all'; lastRoute = hash; }
    filters.league = state.playerLeague || 'All';
    filters.query = state.playerSearch || '';
    filters.position = state.playerPosition || 'All';
    const content = document.querySelector('#content');
    if (!content) return;
    const draw = () => {
      content.innerHTML = pageHTML(state, hash, helpers, filters);
      for (const [id, key] of [['player-search', 'query'], ['player-league', 'league'], ['player-position', 'position'], ['player-market', 'market'], ['player-history-window', 'historyWindow'], ['player-history-opponent', 'historyOpponent'], ['player-history-venue', 'historyVenue']]) {
        const control = content.querySelector(`#${id}`);
        if (!control) continue;
        control.addEventListener(key === 'query' ? 'input' : 'change', () => {
          const start = key === 'query' ? control.selectionStart : null;
          filters[key] = control.value;
          if (key === 'league') { filters.position = 'All'; state.playerPosition = 'All'; }
          if (key === 'market') { filters.historyOpponent = 'all'; filters.historyVenue = 'all'; }
          if (key === 'league') state.playerLeague = filters.league;
          if (key === 'query') state.playerSearch = filters.query;
          if (key === 'position') state.playerPosition = filters.position;
          draw();
          const replacement = content.querySelector(`#${id}`);
          replacement?.focus();
          if (key === 'query' && start != null) replacement?.setSelectionRange(start, start);
        });
      }
    };
    draw();
  }
  return { matches, hrefFor, index, pageHTML, historyView, render };
});


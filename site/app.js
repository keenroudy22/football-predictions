/* KeenRoudy Sports. Hash-routed views over small page payloads in data/app/.
   The pipeline records every number; this file only lays them out. No framework. */
(() => {
  'use strict';

  const C = window.KRCore;
  const { esc, DASH, odds, signed, fixed, when, whenShort, dayLabel, ago } = C;
  const $ = selector => document.querySelector(selector);

  /* ---------- storage and state ---------- */

  const saved = {
    get(key, fallback) { try { const v = localStorage.getItem('kr:' + key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem('kr:' + key, JSON.stringify(value)); } catch (e) { /* private mode: keep it in memory */ } },
  };

  const state = {
    league: saved.get('league', 'NFL'),
    gamesScope: 'upcoming', boardScope: 'open', boardSort: 'best', boardQuery: '', playerQuery: '',
    stat: null, defensePos: 'WR', defenseStat: 'recYds', defenseScope: 'season', defenseOrder: 'soft',
    logSeason: 'all', scoresLeague: 'MLB', scoresDate: null, recordScope: 'all',
    ticket: saved.get('ticket', []), stake: saved.get('stake', { amount: 1, mode: 'units', unit: 10 }),
  };

  const cache = new Map();
  const get = path => {
    if (!cache.has(path)) {
      const request = fetch('data/' + path, { cache: 'no-cache' })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`${path} returned HTTP ${r.status}`)));
      request.catch(() => cache.delete(path));
      cache.set(path, request);
    }
    return cache.get(path);
  };
  const maybe = path => get(path).catch(() => null);

  const dataLeague = () => state.league === 'CFB' ? 'CFB' : 'NFL';
  const inLeague = row => state.league === 'ALL' || row.league === state.league;
  const leagueName = league => league === 'CFB' ? 'College' : league;

  /* ---------- small fragments ---------- */

  const icon = path => `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const ICONS = {
    today: '<path d="M3 12l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    games: '<ellipse cx="12" cy="12" rx="9" ry="6"/><path d="M8 12h8"/>',
    stats: '<path d="M4 19V10"/><path d="M10 19V5"/><path d="M16 19v-6"/><path d="M22 19H2"/>',
    model: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    record: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
    more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  };
  const TABS = [['today', 'Today'], ['games', 'Games'], ['stats', 'Stats'], ['model', 'Model'], ['record', 'Record'], ['more', 'More']];
  const TAB_FOR = { game: 'games', player: 'stats', team: 'stats', board: 'more', ticket: 'more', research: 'more', scores: 'more' };

  const empty = (title, text, action = '') => `<div class="empty"><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
  const head = (title, text, back = '') => `<div class="page-head">${back}<h1${back ? ' style="margin-top:8px"' : ''}>${esc(title)}</h1>${text ? `<p>${text}</p>` : ''}</div>`;
  const section = (title, body, link = '') => `<div class="section"><div class="section-head"><p class="eyebrow">${esc(title)}</p>${link}</div>${body}</div>`;
  const seg = (key, options, current) => `<div class="seg" role="group">${options.map(([value, label]) =>
    `<button type="button" data-set="${esc(key)}:${esc(value)}" aria-pressed="${String(current) === String(value)}">${esc(label)}</button>`).join('')}</div>`;
  const stat = (label, value, note = '', tone = '') => `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value num ${tone}">${value}</div>${note ? `<div class="stat-note">${note}</div>` : ''}</div>`;
  const teamRow = (team, score) => `<div class="game-team"><span class="game-chip" style="background:${esc(team.color || '#64748b')}"></span><span>${esc(team.abbr || DASH)}</span>${score != null ? `<span class="score" style="margin-left:auto">${esc(score)}</span>` : ''}</div>`;
  const external = (url, label) => /^https:\/\//.test(url || '') ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>` : '';
  const espnGame = id => { const [league, event] = String(id).split('-'); return `https://www.espn.com/${league === 'CFB' ? 'college-football' : 'nfl'}/game/_/gameId/${event}`; };

  const hasLean = game => { const lean = C.leanText(game); return Boolean(game.fcs || (lean && (lean.side || lean.total))); };
  /* Same colors as the board: green only on a solid sample, amber for a thin one or a small gap. */
  const leanChips = (game, strong = 3) => {
    if (game.fcs) return '<span class="row-meta">FBS vs FCS: v2 is not reliable here</span>';
    const lean = C.leanText(game);
    if (!lean || (!lean.side && !lean.total)) return '<span class="row-meta">no model call</span>';
    const thin = Boolean((game.v2 || {}).sparse);
    const chip = (text, size) => `<span class="lean ${size >= strong && !thin ? 'lean-strong' : size >= 1.5 ? 'lean-mild' : ''}">${esc(text)}</span>`;
    return `<span class="leans">${lean.side ? chip(`Lean ${lean.side.team} · ${lean.side.points.toFixed(1)} pts`, lean.side.points) : ''}${lean.total ? chip(`Lean ${lean.total.direction} · ${lean.total.points.toFixed(1)} pts`, lean.total.points) : ''}</span>`;
  };

  const gameRow = game => {
    const m = game.market || {}, v2 = game.v2, v1 = game.v1;
    const final = game.completed;
    const score = v2 ? `${fixed(v2.away, 0)}–${fixed(v2.home, 0)}` : v1 ? `${v1.away}–${v1.home}` : DASH;
    return `<a class="game-row" href="#game/${esc(game.id)}">
      <span class="game-teams">${teamRow(game.away, final ? game.away.score : null)}${teamRow(game.home, final ? game.home.score : null)}</span>
      <span class="game-mid">${esc(whenShort(game.kickoff))}${final ? ' · <b>Final</b>' : ''}<br>
        Market <b>${m.spread != null ? esc(C.spreadText(game.home.abbr, m.spread)) : DASH}</b> · <b>${m.total != null ? 'O/U ' + esc(m.total) : 'no total'}</b></span>
      <span class="game-model"><span class="num">${score}</span><div class="row-meta">${v2 ? 'v2 ' + esc(C.modelSpread(game.home.abbr, game.away.abbr, v2.margin)) : v1 ? 'v1 only' : 'no forecast'}</div></span>
      ${!final && hasLean(game) ? `<span class="game-leans">${leanChips(game)}</span>` : ''}
    </a>`;
  };

  const pickRow = pick => {
    const tone = pick.result === 'win' ? 'var(--green)' : pick.result === 'loss' ? 'var(--rose)' : 'var(--mint)';
    return `<button class="row" type="button" data-pick="${esc(pick.id)}">
      <span class="row-rail" style="background:${pick.result ? tone : esc(pick.color || 'var(--mint)')}"></span>
      <span class="row-main"><span class="row-top"><span class="row-name">${esc(pick.title || pick.player)}</span>
        ${pick.favorite ? '<span class="pill pill-ours">Favorite</span>' : ''}${C.isLongshot(pick) ? '<span class="pill pill-stale">Longshot</span>' : ''}${pick.historicalImport ? '<span class="pill pill-reference">Imported</span>' : ''}
        <span class="pill pill-${C.pickState(pick).tone}">${esc(C.pickState(pick).word)}</span></span>
        <span class="row-market">${pick.actual ? esc(pick.actual) : pick.projection != null ? 'Our number ' + esc(pick.projection) : esc(pick.kind || '')}</span>
        <span class="row-meta">${esc(whenShort(pick.kickoff || pick.publishedAt))}${pick.confidence != null ? ` · confidence ${esc(pick.confidence)}/10` : ''}${pick.quotedAt ? ' · quoted ' + esc(ago(pick.quotedAt)) : ''}</span></span>
      <span class="row-price"><span class="row-odds num">${odds(pick.odds)}</span><span class="row-book">${esc(pick.book || 'No book')}</span></span>
    </button>`;
  };

  /* ---------- today ---------- */

  const upcoming = games => games.filter(g => !g.completed && g.state === 'pre').sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const slate = games => {
    const rows = upcoming(games);
    if (!rows.length) return rows;
    const cutoff = Date.parse(rows[0].kickoff) + 72 * 3600 * 1000;
    return rows.filter(g => Date.parse(g.kickoff) <= cutoff);
  };
  const disagreement = g => Math.max(Math.abs((g.lean || {}).spread || 0), Math.abs((g.lean || {}).total || 0));

  async function viewToday() {
    const data = await get('app/today.json');
    const games = data.games.filter(inLeague);
    const now = slate(games);
    const first = now[0];
    const gaps = now.filter(g => g.v2 && g.lean && !g.fcs).sort((a, b) => disagreement(b) - disagreement(a)).slice(0, 8);
    const picks = data.picks.filter(inLeague);
    const live = picks.filter(p => !p.result && !p.historicalImport)
      .sort((a, b) => (C.isOpen(b) - C.isOpen(a)) || String(a.kickoff).localeCompare(String(b.kickoff)));
    const forecasts = now.filter(g => g.v2).length;
    return `${head(first ? dayLabel(first.kickoff) : 'No games scheduled',
      first ? `${now.length} games on this slate · ${forecasts} with a v2 forecast · market lines from ${esc((first.market || {}).book || 'the book')}` : 'Nothing kicks off in the next eight days in this league.')}
      <div class="two-col"><div>
        ${section('Where the model and the market disagree', gaps.length ? `<p class="row-meta" style="margin:0 0 8px">A lean is how many points v2 sits from the current line, and on which side. It is not a pick.</p><div class="card">${gaps.map(gameRow).join('')}</div>`
          : empty('No model calls yet', 'The model publishes after the hosted refresh runs. Every game still shows the market number.'), '<a href="#games">All games →</a>')}
        ${section('Our picks', live.length ? `<div class="card"><div class="rows">${live.map(pickRow).join('')}</div></div>`
          : empty('No picks waiting to settle', 'Nothing has cleared the bar for this slate. Fewer picks, or none, is part of the process.', '<a class="btn" href="#board">Open the board</a>'), '<a href="#record">Record →</a>')}
      </div><div>
        ${section('The record', recordCard(C.recordOf(picks), true), '<a href="#record">Details →</a>')}
        ${section('How the model is doing', modelCard(data.model), '<a href="#model">Scoreboard →</a>')}
        ${section('Data freshness', freshnessCard(data))}
      </div></div>`;
  }

  const recordCard = (r, compact) => {
    if (!r || !(r.wins + r.losses + r.pushes + r.voids + r.pending)) return empty('No record yet', 'Settled picks appear here.');
    const graded = r.wins + r.losses;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    return `<div class="card" style="padding:16px"><div style="text-align:center">
      <div class="num" style="font-size:${compact ? 42 : 56}px;line-height:1">${r.wins}<span class="faint">–</span>${r.losses}<span class="faint">–</span>${r.pushes}</div>
      <div class="row-meta" style="margin-top:7px;font-size:13px">${graded ? r.hitRate.toFixed(1) + '% hit rate' : 'nothing settled'} · ${r.pending} pending</div></div>
      <div class="stats" style="margin-top:12px">
        ${stat('Net units', r.units == null ? DASH : signed(r.units, 2) + 'u', r.priced ? `${plural(r.priced, 'priced pick')}, ${r.pricedWins}–${r.pricedLosses}` : 'no recorded prices yet', r.units > 0 ? 'up' : r.units < 0 ? 'down' : '')}
        ${stat('ROI', r.roi == null ? DASH : signed(r.roi, 1) + '%', r.roi != null ? 'priced picks only' : r.priced ? `shows at ${r.roiMinimum} priced · ${r.priced} so far` : 'needs recorded prices')}
      </div>
      ${r.unpriced ? `<p class="row-meta" style="margin:12px 0 0">${plural(r.unpriced, 'pick')} ${r.unpriced === 1 ? 'has' : 'have'} no recorded price, so ${r.unpriced === 1 ? 'it counts' : 'they count'} in the record but not in units or ROI.</p>` : ''}
    </div>`;
  };

  const modelCard = model => {
    const rows = ((model || {}).live || []).filter(inLeague);
    const back = ((model || {}).backtest || []).filter(inLeague).filter(r => r.model !== 'v1 replay' && r.season === 2025);
    const line = r => `<div class="row" style="cursor:default"><span class="row-main"><span class="row-top"><span class="row-name">${esc(leagueName(r.league))} ${esc(r.model)}</span><span class="row-meta">${esc(r.season)}${r.backtest ? ' backtest' : ' live'}</span></span>
      <span class="row-market">Average miss ${fixed(r.summary.marginMiss)} vs the close’s ${fixed(r.summary.closeMarginMiss)} · against the close ${r.summary.side[0]}–${r.summary.side[1]}</span>
      <span class="row-meta">${r.summary.games} graded games</span></span></div>`;
    return `<div class="card"><div class="rows">${rows.map(line).join('') || '<div class="row" style="cursor:default"><span class="row-main"><span class="row-name">No live grades yet</span><span class="row-meta" style="display:block">Forecasts are graded once their games finish.</span></span></div>'}
      ${back.map(r => line({ ...r, backtest: true })).join('')}</div></div>`;
  };

  const freshnessCard = data => {
    const f = data.freshness || {};
    const item = (label, iso) => `<div><span>${esc(label)}</span><strong style="font-size:12px">${esc(ago(iso))}</strong></div>`;
    return `<div class="card" style="padding:12px"><div class="kv">${item('Schedule & lines', f.slate)}${item('Box scores', f.boxscores)}${item('Model', f.forecasts)}${item('Injuries', f.injuries)}${item('Prop lines', f.props)}</div>
      <p class="row-meta" style="margin:10px 2px 0">Hosted refreshes run through the day and can run late. These are the latest successful checks, not a live feed.</p></div>`;
  };

  /* ---------- games ---------- */

  async function viewGames() {
    const data = await get('app/today.json');
    let games = data.games.filter(inLeague);
    games = state.gamesScope === 'final' ? games.filter(g => g.completed).sort((a, b) => b.kickoff.localeCompare(a.kickoff))
      : upcoming(games);
    const groups = new Map();
    for (const g of games) { const day = dayLabel(g.kickoff); if (!groups.has(day)) groups.set(day, []); groups.get(day).push(g); }
    return `${head('Games', 'Every game with the model’s score next to the market’s spread and total. The chips show how far the model is from the market.')}
      <div class="toolbar">${seg('gamesScope', [['upcoming', 'Upcoming'], ['final', 'Recent finals']], state.gamesScope)}</div>
      ${games.length ? [...groups].map(([day, rows]) => section(day, `<div class="card">${rows.map(gameRow).join('')}</div>`)).join('')
        : empty(state.gamesScope === 'final' ? 'No recent finals' : 'No upcoming games', 'Nothing in this league inside the current window.')}`;
  }

  /* ---------- one game ---------- */

  async function viewGame(route) {
    const [today, detail] = await Promise.all([get('app/today.json'), maybe(`app/games/${route.id}.json`)]);
    const card = detail || today.games.find(g => g.id === route.id);
    const back = '<a class="back" href="#games">← Games</a>';
    if (!card) {
      return `${head('Game not in the current window', 'This page covers games from three days back to eight days ahead.', back)}
        <div class="inline-links">${external(espnGame(route.id), 'ESPN game page')}<a href="#model">Model scoreboard →</a></div>`;
    }
    const league = card.league;
    const teams = await maybe(`app/teams/${league}.json`);
    const m = card.market || {}, v2 = card.v2;
    const f = detail && detail.forecast;
    const final = card.completed && detail && detail.final;
    const title = `${card.away.abbr} @ ${card.home.abbr}`;
    const status = card.completed ? `Final ${card.away.abbr} ${card.away.score}, ${card.home.abbr} ${card.home.score}` : esc(when(card.kickoff));
    const win = v2 ? (v2.winProb >= 0.5 ? `${card.home.abbr} ${Math.round(100 * v2.winProb)}%` : `${card.away.abbr} ${Math.round(100 * (1 - v2.winProb))}%`) : DASH;
    let html = `${head(title, `${status}${card.neutral ? ' · neutral site' : ''} · ${esc(leagueName(league))}`, back)}
      <div class="stats">
        ${stat('Model score', v2 ? `${fixed(v2.away, 0)}–${fixed(v2.home, 0)}` : DASH, v2 ? `${esc(card.away.abbr)} ${fixed(v2.away)}, ${esc(card.home.abbr)} ${fixed(v2.home)} · ${esc(v2.model)}` : 'no v2 forecast yet')}
        ${stat('Win chance', win, v2 ? 'model estimate' : '')}
        ${stat('Model spread', v2 ? esc(C.modelSpread(card.home.abbr, card.away.abbr, v2.margin)) : DASH, v2 && v2.range ? `80%: ${signed(v2.range.margin[0])} to ${signed(v2.range.margin[1])} (home)` : '')}
        ${stat('Market spread', m.spread != null ? esc(C.spreadText(card.home.abbr, m.spread)) : DASH, m.spreadOpen != null && m.spreadOpen !== m.spread ? `opened ${esc(C.spreadText(card.home.abbr, m.spreadOpen))}` : esc(m.book || ''))}
        ${stat('Model total', v2 ? fixed(v2.total) : DASH, v2 && v2.range ? `80%: ${fixed(v2.range.total[0])} to ${fixed(v2.range.total[1])}` : '')}
        ${stat('Market total', m.total != null ? esc(m.total) : DASH, m.totalOpen != null && m.totalOpen !== m.total ? `opened ${esc(m.totalOpen)}` : esc(m.book || ''))}
      </div>
      ${card.lean && !card.completed ? `<div style="margin-top:10px">${leanChips(card)}</div>` : ''}
      ${v2 && v2.sparse ? '<div class="notice" style="margin-top:12px"><strong>Thin history.</strong> One of these teams has fewer than three games this season, so this forecast leans on last season and the league average.</div>' : ''}`;
    if (final) html += finalSection(card, detail, teams);
    if (f) {
      html += section('Why the model says this', `<div class="card" style="padding:14px"><p class="prose" style="margin:0">${esc(f.why)}</p>
        <p class="row-meta" style="margin:8px 0 0">Published ${esc(when(f.publishedAt))}${f.history && f.history.length > 1 ? ` · ${f.history.length} versions, each kept` : ''}. Injury coverage: ${esc(f.inputs.injuryCoverage)}.</p></div>`);
      if (f.history && f.history.length > 1) {
        html += section('Forecast history', `<div class="table-wrap"><table class="data"><thead><tr><th>Published</th><th>Home margin</th><th>Total</th></tr></thead><tbody>
          ${f.history.map(h => `<tr><td>${esc(whenShort(h.at))}</td><td>${signed(h.margin)}</td><td>${fixed(h.total)}</td></tr>`).join('')}</tbody></table></div>`);
      }
      html += projectionSection(card, detail);
    } else if (!card.completed) {
      html += section('Player projections', empty('No projection yet', 'Player projections publish with the model, from each player’s recent share of the team’s volume.'));
    }
    html += matchupSection(card, detail, teams);
    html += formSection(card, detail, teams);
    if (detail) html += injurySection(card, detail);
    if (detail && (detail.picks.length || detail.lines.length)) {
      html += section('Our picks and lines in this game', `<div class="card"><div class="rows">${detail.picks.map(pickRow).join('')}${detail.lines.map(lineRow).join('')}</div></div>`);
    }
    html += `<div class="section inline-links">${external(espnGame(card.id), 'ESPN game page')}<a href="#team/${esc(league)}/${esc(card.away.id)}">${esc(card.away.abbr)} team page</a><a href="#team/${esc(league)}/${esc(card.home.id)}">${esc(card.home.abbr)} team page</a></div>`;
    return html;
  }

  const finalSection = (card, detail, teams) => {
    const fin = detail.final;
    const periods = fin.periods || {};
    const quarter = periods.home && periods.away ? `<div class="table-wrap" style="margin-bottom:10px"><table class="data"><thead><tr><th>Team</th>${periods.home.map((_, i) => `<th>${i < 4 ? 'Q' + (i + 1) : 'OT'}</th>`).join('')}<th>Final</th></tr></thead><tbody>
      <tr><td>${esc(card.away.abbr)}</td>${periods.away.map(v => `<td>${v}</td>`).join('')}<td><b>${fin.away}</b></td></tr>
      <tr><td>${esc(card.home.abbr)}</td>${periods.home.map(v => `<td>${v}</td>`).join('')}<td><b>${fin.home}</b></td></tr></tbody></table></div>` : '';
    const close = fin.close || {};
    const grades = (detail.grades || []).map(g => `<tr><td>${esc(g.model)}</td><td>${signed(g.margin)}</td><td>${fixed(g.total)}</td><td>${g.side ? esc(g.side) : DASH}</td><td>${g.ou ? esc(g.ou) : DASH}</td></tr>`).join('');
    const names = id => ((teams || {}).teams || {})[id] ? teams.teams[id].abbr : id;
    const leaders = (fin.leaders || []).map(p => `<tr><td><a href="#player/${esc(card.league)}/${esc(p.id)}">${esc(p.name)}</a><span class="sub">${esc(names(p.team))} ${esc(p.pos || '')}</span></td><td>${esc(Object.entries(p.line).map(([k, v]) => `${v} ${C.LABEL[k] || k}`).join(' · '))}</td></tr>`).join('');
    return section('Final', `${quarter}
      <div class="stats" style="margin-bottom:10px">${stat('Closing spread', close.spread != null ? esc(C.spreadText(card.home.abbr, close.spread)) : DASH, esc(fin.provider || ''))}${stat('Closing total', close.total != null ? esc(close.total) : DASH, esc(fin.provider || ''))}${stat('Result', `${signed(fin.home - fin.away, 0)}`, `home margin · ${fin.home + fin.away} total`)}</div>
      ${grades ? `<div class="table-wrap" style="margin-bottom:10px"><table class="data"><caption>Graded against the close</caption><thead><tr><th>Model</th><th>Home margin</th><th>Total</th><th>Side</th><th>O/U</th></tr></thead><tbody>${grades}</tbody></table></div>` : ''}
      ${leaders ? `<div class="table-wrap"><table class="data"><caption>Leaders</caption><tbody>${leaders}</tbody></table></div>` : ''}
      <div class="inline-links" style="margin-top:10px">${external(fin.source, 'ESPN box score')}</div>`);
  };

  const PROJ_COLS = [['targets', 'Tgt'], ['receptions', 'Rec'], ['recYds', 'Rec yds'], ['carries', 'Car'], ['rushYds', 'Rush yds'], ['att', 'Att'], ['cmp', 'Cmp'], ['passYds', 'Pass yds']];

  const projectionSection = (card, detail) => {
    const f = detail.forecast;
    const lines = (detail.props || {}).lines || {};
    const table = side => {
      const block = f.players[side] || {};
      const team = card[side];
      const players = block.players || [];
      if (!players.length) return empty(`${team.abbr}: no projections`, 'Not enough recent games for this team.');
      const cols = PROJ_COLS.filter(([key]) => players.some(p => p[key]));
      const vol = block.volume || {};
      return `<div class="table-wrap"><table class="data"><caption>${esc(team.abbr)} · ${fixed(vol.plays, 0)} plays, ${Math.round(100 * (vol.passRate || 0))}% pass</caption>
        <thead><tr><th>Player</th>${cols.map(([, label]) => `<th>${label}</th>`).join('')}</tr></thead><tbody>
        ${players.map(p => `<tr><td><a href="#player/${esc(card.league)}/${esc(p.id)}">${esc(p.name)}</a><span class="sub">${esc(p.pos)}</span></td>${cols.map(([key]) => {
          const value = p[key];
          if (!value) return `<td class="faint">${DASH}</td>`;
          const market = (lines[p.id] || {})[C.PROJECTION_MARKET[key]];
          const gap = market ? value[0] - market[0] : null;
          return `<td title="80% range ${value[1]} to ${value[2]}">${fixed(value[0])}${market ? `<span class="sub ${gap > 0 ? 'up' : gap < 0 ? 'down' : ''}">line ${market[0]} (${signed(gap)})</span>` : `<span class="sub">${value[1]}–${value[2]}</span>`}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table></div>`;
    };
    const props = detail.props;
    return section('Player projections', `<div class="grid-2">${table('away')}${table('home')}</div>
      <p class="row-meta" style="margin:8px 2px 0">Means with 80% ranges. ${props ? `DraftKings lines captured ${esc(when(props.capturedAt))} from ESPN’s feed (no prices). Green means the projection is above the line.` : card.league === 'NFL' ? 'No DraftKings lines captured for this game yet.' : 'College prop lines are not in the feed.'} Players ruled out on the injury report are removed and their share goes to teammates.</p>`);
  };

  const MATCHUP = [['QB', 'passYds'], ['RB', 'rushYds'], ['WR', 'recYds'], ['TE', 'recYds']];
  const matchupSection = (card, detail, teams) => {
    if (!teams || !teams.defense) return '';
    const rows = teams.defense.rows || {};
    if (!Object.keys(rows).length) return '';
    const side = (offense, defense) => `<div class="table-wrap"><table class="data"><caption>${esc(offense.abbr)} offense vs ${esc(defense.abbr)} defense</caption>
      <thead><tr><th>Position</th><th>Allowed per game</th><th>Rank</th></tr></thead><tbody>
      ${MATCHUP.map(([pos, key]) => {
        const hit = C.rankOf(rows, defense.id, pos, key);
        if (!hit) return `<tr><td>${pos} ${esc(C.LABEL[key])}</td><td class="faint">${DASH}</td><td></td></tr>`;
        const tone = C.rankTone(hit.rank, hit.of);
        return `<tr><td>${pos} ${esc(C.LABEL[key])}</td><td>${fixed(hit.value)}</td><td><span class="rank ${tone === 'soft' ? 'rank-soft' : tone === 'tough' ? 'rank-tough' : ''}">${hit.rank}/${hit.of}</span></td></tr>`;
      }).join('')}</tbody></table></div>`;
    return section('Matchup: what each defense allows', `<div class="grid-2">${side(card.away, card.home)}${side(card.home, card.away)}</div>
      <p class="row-meta" style="margin:8px 2px 0">This season, regular season only. Rank 1 allows the least. Green marks defenses that allow the most, red the least. Position groups combine every player at that position.</p>`, '<a href="#stats/defense">All defenses →</a>');
  };

  const formSection = (card, detail, teams) => {
    if (!detail || !detail.teams) return '';
    const name = id => ((teams || {}).teams || {})[id] ? teams.teams[id].abbr : id;
    const table = side => {
      const form = detail.teams[side].form || [];
      if (!form.length) return empty(`${card[side].abbr}: no stored games`, 'Form appears after the team’s first stored game.');
      return `<div class="table-wrap"><table class="data"><caption>${esc(card[side].abbr)} last ${form.length}</caption><thead><tr><th>Game</th><th>Score</th><th>Yds</th><th>Allowed</th><th>Success</th><th>TO</th></tr></thead><tbody>
        ${form.map(g => `<tr><td><a href="#game/${esc(g.gameId)}">${esc(g.date.slice(5))} ${g.home === false ? '@' : 'vs'} ${esc(name(g.opp))}</a></td><td class="${g.pf > g.pa ? 'up' : g.pf < g.pa ? 'down' : ''}">${g.pf}–${g.pa}</td><td>${g.yards ?? DASH}</td><td>${g.yardsAllowed ?? DASH}</td><td>${g.success != null ? Math.round(100 * g.success) + '%' : DASH}</td><td>${g.turnovers ?? DASH}</td></tr>`).join('')}</tbody></table></div>`;
    };
    return section('Recent form', `<div class="grid-2">${table('away')}${table('home')}</div>`);
  };

  const injurySection = (card, detail) => {
    const block = side => {
      const list = detail.teams[side].injuries || [];
      if (!list.length) return `<p class="row-meta">${esc(card[side].abbr)}: nobody listed. A missing listing is not proof of health.</p>`;
      return `<div class="card"><div class="rows">${list.map(p => `<div class="row" style="cursor:default"><span class="row-main"><span class="row-top"><span class="row-name">${esc(p.name)}</span><span class="row-meta">${esc(p.position || '')}</span>
        <span class="pill ${/out|reserve/i.test(p.status) ? 'pill-out' : 'pill-q'}">${esc(p.status)}</span></span><span class="row-meta">${esc(p.injury || 'injury not listed')} · reported ${esc(ago(p.reportedAt))}</span></span></div>`).join('')}</div></div>`;
    };
    if (card.league !== 'NFL') return section('Injuries', '<p class="row-meta">College injury reports are not covered by the feed. Check team sources before relying on a projection.</p>');
    return section('Injury report', `<div class="grid-2"><div><p class="eyebrow">${esc(card.away.abbr)}</p>${block('away')}</div><div><p class="eyebrow">${esc(card.home.abbr)}</p>${block('home')}</div></div>`);
  };

  const RAIL = { strong: 'var(--green)', lean: 'var(--amber)' };
  const lineText = v => v === 0 ? 'PK' : `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}`;
  const lineRow = row => {
    const inTicket = state.ticket.some(t => t.id === row.id);
    const g = C.gradeOf(row.grade, row.gradeNote);
    const open = row.state === 'open';
    return `<div class="row${open ? '' : ' row-closed'}" style="cursor:default">
      <span class="row-rail" style="background:${open && RAIL[g.tier] || 'var(--line)'}"></span>
      <span class="row-main"><span class="row-top"><span class="row-name">${esc(row.player || row.title || 'Line')}</span>${row.position ? `<span class="row-meta">${esc(row.position)}</span>` : ''}
        ${!open ? `<span class="pill pill-${esc(row.state)}">${esc({ stale: 'Recheck price', closed: 'Closed', unpriced: 'No price', reference: 'Unverified price' }[row.state] || row.state)}</span>` : ''}
        ${row.move && typeof row.line === 'number' ? `<span class="move">opened ${esc(lineText(row.line - row.move))}</span>` : ''}</span>
        ${row.player ? `<span class="row-market">${esc([row.direction, row.line, row.market].filter(v => v != null && v !== '').join(' '))}</span>` : ''}
        ${open ? `<span class="grade grade-${g.tier}"><b>${esc(g.word)}</b>${g.detail ? `<span>${esc(g.detail)}</span>` : ''}</span>` : ''}
        <span class="row-meta">${esc(whenShort(row.kickoff))}${row.observedAt ? ' · seen ' + esc(ago(row.observedAt)) : ''}</span></span>
      <span class="row-price"><span class="row-odds num">${odds(row.odds)}</span><span class="row-book">${esc(row.book || 'No book')}</span></span>
      ${row.state === 'open' && row.odds != null ? `<button class="add" type="button" data-add="${esc(row.id)}" aria-pressed="${inTicket}" aria-label="${inTicket ? 'Remove from ticket' : 'Add to ticket'}">${inTicket ? '✓' : '+'}</button>` : ''}
    </div>`;
  };

  /* ---------- stats: players, defenses, teams ---------- */

  async function viewStats(route) {
    const league = dataLeague();
    const tab = route.tab || 'players';
    const note = state.league === 'ALL' ? '<p class="row-meta">Stats are per league; showing NFL. Switch to College above.</p>' : '';
    const tabs = `<div class="toolbar"><div class="seg" role="group">${[['players', 'Players'], ['defense', 'Defenses'], ['teams', 'Teams']].map(([id, label]) =>
      `<a class="chip" style="display:inline-flex;align-items:center" href="#stats/${id}" aria-pressed="${tab === id}">${label}</a>`).join('')}</div></div>`;
    if (tab === 'defense') return head('Defense vs position', `What each ${leagueName(league)} defense allows per game, by position group.`) + note + tabs + await defenseView(league);
    if (tab === 'teams') return head('Teams', `${leagueName(league)} teams with stored games.`) + note + tabs + await teamsList(league);
    return head('Players', `Every ${leagueName(league)} player with a stored stat line: last 5, 10 and 20 games, splits and head-to-head.`) + note + tabs + await playerSearch(league);
  }

  async function playerSearch(league) {
    const index = await get(`app/players/${league}.json`);
    return `<input class="search" type="search" data-input="playerQuery" placeholder="Search ${esc(index.players.length.toLocaleString())} players by name" value="${esc(state.playerQuery)}" aria-label="Search players" autocomplete="off">
      <div id="player-results">${playerResults(index, league)}</div>`;
  }

  const playerResults = (index, league) => {
    const query = state.playerQuery.trim().toLowerCase();
    if (query.length < 2) return empty('Search for a player', 'Type at least two letters of a name. Every player with a stat line in the last two seasons is here, with every game stored since 2023.');
    const words = query.split(/\s+/);
    const found = index.players.filter(p => words.every(w => String(p[1]).toLowerCase().includes(w)))
      .sort((a, b) => String(b[5]).localeCompare(String(a[5])) || b[6] - a[6]).slice(0, 40);
    if (!found.length) return empty('No player by that name', 'Check the spelling, or switch leagues.');
    return `<div class="card results">${found.map(p => `<a href="#player/${league}/${esc(p[0])}"><span><b>${esc(p[1])}</b> <small>${esc(p[2] || '')} · ${esc(p[4] || '')}</small></span><small>${p[6]} games · last ${esc(p[5])}</small></a>`).join('')}</div>`;
  };

  const DEFENSE_STATS = { QB: ['passYds', 'passTD', 'att', 'cmp', 'int', 'sacks', 'rushYds'], RB: ['rushYds', 'car', 'rushTD', 'recYds', 'rec', 'targets'],
    WR: ['recYds', 'rec', 'targets', 'recTD'], TE: ['recYds', 'rec', 'targets', 'recTD'] };

  async function defenseView(league) {
    const data = await get(`app/teams/${league}.json`);
    const pos = state.defensePos, stats = DEFENSE_STATS[pos];
    const key = stats.includes(state.defenseStat) ? state.defenseStat : stats[0];
    const scope = state.defenseScope;
    const rows = scope === 'last5' ? data.defense.last5 : scope === 'prior' ? data.defense.prior.rows : data.defense.rows;
    const season = scope === 'prior' ? data.defense.prior.season : data.defense.season;
    let ranked = C.rankDefenses(rows, pos, key, 1);
    if (league === 'CFB') ranked = C.rankDefenses(Object.fromEntries(Object.entries(rows).filter(([team]) => (data.teams[team] || {}).fbs)), pos, key, 1);
    const max = Math.max(1, ...ranked.map(r => r.value));
    const ordered = state.defenseOrder === 'soft' ? [...ranked].reverse() : ranked;
    return `<div class="toolbar">${seg('defensePos', [['QB', 'QB'], ['RB', 'RB'], ['WR', 'WR'], ['TE', 'TE']], pos)}
        <select class="pick" data-select="defenseStat" aria-label="Stat">${stats.map(s => `<option value="${s}" ${s === key ? 'selected' : ''}>${esc(C.LABEL[s])}</option>`).join('')}</select>
        ${seg('defenseScope', [['season', String(data.defense.season)], ['last5', 'Last 5'], ['prior', String(data.defense.prior.season)]], scope)}
        ${seg('defenseOrder', [['soft', 'Most allowed'], ['tough', 'Least allowed']], state.defenseOrder)}</div>
      ${ranked.length ? `<div class="table-wrap"><table class="data"><caption>${esc(pos)} ${esc(C.LABEL[key])} allowed per game · ${esc(season)} regular season${scope === 'last5' ? ', each team’s last 5' : ''}</caption>
        <thead><tr><th>Defense</th><th>Rank</th><th>Games</th><th>Per game</th></tr></thead><tbody>
        ${ordered.map(r => { const team = data.teams[r.team] || {}; return `<tr><td><a href="#team/${league}/${esc(r.team)}">${esc(team.short || team.name || team.abbr || r.team)}</a></td><td><span class="rank">${r.rank}/${ranked.length}</span></td><td>${r.games}</td>
          <td><span class="barcell">${fixed(r.value)}<i style="width:${Math.round(60 * r.value / max)}px"></i></span></td></tr>`; }).join('')}</tbody></table></div>`
        : empty('No games yet', 'Rankings appear once teams have played.')}
      <p class="row-meta" style="margin:8px 2px 0">Rank 1 allows the least. Position groups sum every player at the position; college targets come from play-by-play. Small samples early in the season swing hard.</p>`;
  }

  async function teamsList(league) {
    const data = await get(`app/teams/${league}.json`);
    const list = Object.entries(data.teams).filter(([, t]) => league === 'NFL' || t.fbs)
      .sort((a, b) => String(a[1].name || a[1].abbr).localeCompare(String(b[1].name || b[1].abbr)));
    return `<div class="card results">${list.map(([id, t]) => `<a href="#team/${league}/${esc(id)}"><span><b>${esc(t.name || t.abbr)}</b></span><small>${esc(t.abbr || '')}</small></a>`).join('')}</div>`;
  }

  /* ---------- one player ---------- */

  async function nextGameFor(teamId, league) {
    const today = await get('app/today.json');
    const game = upcoming(today.games).find(g => g.league === league && (g.home.id === String(teamId) || g.away.id === String(teamId)));
    if (!game) return null;
    const detail = await maybe(`app/games/${game.id}.json`);
    return { game, detail, side: game.home.id === String(teamId) ? 'home' : 'away' };
  }

  async function viewPlayer(route) {
    const league = route.league === 'CFB' ? 'CFB' : 'NFL';
    const index = await get(`app/players/${league}.json`);
    const entry = index.players.find(p => String(p[0]) === String(route.id));
    const back = '<a class="back" href="#stats/players">← Players</a>';
    if (!entry) return head('Player not found', 'No stored games for this player in this league.', back);
    const shard = await get(`app/players/${league}/${C.shardOf(route.id, index.shards)}.json`);
    const data = shard.players[route.id];
    const keys = shard.keys;
    const rows = data.rows;
    const pos = data.pos;
    const options = [...new Set([...(C.POSITION_STATS[pos] || C.POSITION_STATS.WR), 'snapPct'])].filter(k => keys.includes(k) && rows.some(r => C.cell(r, keys, k)));
    const key = options.includes(state.stat) ? state.stat : options[0] || (C.POSITION_STATS[pos] || C.POSITION_STATS.WR)[0];
    const [teams, next] = await Promise.all([get(`app/teams/${league}.json`), nextGameFor(entry[3], league)]);
    const team = teams.teams[entry[3]] || {};
    const abbr = id => (teams.teams[id] || {}).abbr || id;
    let projection = null, line = null;
    if (next && next.detail && next.detail.forecast) {
      const block = next.detail.forecast.players[next.side] || {};
      projection = (block.players || []).find(p => String(p.id) === String(route.id)) || null;
      const captured = ((next.detail.props || {}).lines || {})[route.id];
      if (captured && captured[key]) line = captured[key][0];
    }
    const win = C.windows(rows, keys, key);
    const recent = [...rows].sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 20).reverse();
    const values = recent.map(r => C.cell(r, keys, key));
    const opponent = next ? (next.side === 'home' ? next.game.away.id : next.game.home.id) : null;
    const vsNext = next ? C.splits(rows, keys, key, opponent).vs : null;
    const split = C.splits(rows, keys, key);
    const tile = (label, s) => stat(label, s ? fixed(s.avg) : DASH, s ? `n ${s.n} · median ${fixed(s.median)} · ${fixed(s.min, 0)} to ${fixed(s.max, 0)}` : 'no games');
    const projKey = { rec: 'receptions', car: 'carries' }[key] || key;
    const over = w => { if (line == null) return ''; const h = C.hits(values.slice(-w), line); return `${h.over} of ${h.n} over in the last ${h.n}`; };
    return `${back}<div class="page-head who"><span class="badge" style="background:${esc(team.color || 'var(--raised)')}">${esc(pos || '?')}</span>
        <div><h1>${esc(data.name)}</h1><p>${esc(pos || '')} · <a href="#team/${league}/${esc(entry[3])}">${esc(team.name || entry[4] || '')}</a> · ${rows.length} stored games since ${esc(String(rows[0][1]).slice(0, 4))}</p></div></div>
      <div class="toolbar"><div class="seg" role="group">${options.map(k => `<button type="button" data-set="stat:${k}" aria-pressed="${k === key}">${esc(C.LABEL[k] || k)}</button>`).join('')}</div></div>
      <div class="tiles">${tile('Last 5', win.last5)}${tile('Last 10', win.last10)}${tile('Last 20', win.last20)}${tile('This season', win.season)}</div>
      ${next ? section(`Next: ${next.side === 'home' ? 'vs' : '@'} ${abbr(opponent)} · ${whenShort(next.game.kickoff)}`,
        `<div class="stats">${stat('Projection', projection && projection[projKey] ? fixed(projection[projKey][0]) : DASH, projection && projection[projKey] ? `80%: ${projection[projKey][1]} to ${projection[projKey][2]}` : 'none for this stat')}
          ${stat('DraftKings line', line != null ? esc(line) : DASH, line != null ? over(10) : 'none captured')}
          ${stat('Vs this opponent', vsNext && vsNext.summary ? fixed(vsNext.summary.avg) : DASH, vsNext && vsNext.summary ? `${vsNext.summary.n} meeting${vsNext.summary.n === 1 ? '' : 's'} since 2023` : 'no meetings stored')}</div>`,
        `<a href="#game/${esc(next.game.id)}">Game page →</a>`) : ''}
      ${section(`Last ${values.length} games · ${C.LABEL[key] || key}`, chart(recent, values, line, abbr))}
      ${section('Splits', `<div class="stats">${stat('Home', split.home ? fixed(split.home.avg) : DASH, split.home ? `n ${split.home.n}` : '')}${stat('Away', split.away ? fixed(split.away.avg) : DASH, split.away ? `n ${split.away.n}` : '')}${split.neutral ? stat('Neutral site', fixed(split.neutral.avg), `n ${split.neutral.n}`) : ''}</div>`)}
      ${section('Game log', gameLog(rows, keys, pos, abbr, league))}
      <p class="row-meta" style="margin-top:10px">Averages count games with a recorded stat; a game where the player recorded nothing has no line, because no feed here proves the player was on the field. Last-N rates are history, not a probability.${league === 'NFL' ? ' Snap counts are from nflverse (Pro Football Reference).' : ' College targets come from play-by-play.'}</p>`;
  }

  const chart = (recent, values, line, abbr) => {
    if (!values.some(v => v != null)) return empty('No values for this stat', 'Try another stat.');
    const max = Math.max(line || 0, ...values.filter(v => v != null), 1);
    const bars = recent.map((r, i) => {
      const v = values[i];
      const cls = line == null || v == null ? '' : v > line ? 'over' : v < line ? 'under' : 'push';
      const height = v == null ? 0 : Math.max(2, Math.round(78 * v / max));
      const shown = v == null ? '' : Number.isInteger(v) ? String(v) : v < 1 ? Math.round(100 * v) + '%' : fixed(v);
      return `<div class="col" title="${esc(r[1])} ${r[7] === 0 ? '@' : 'vs'} ${esc(abbr(r[6]))}: ${v ?? 'no value'}"><span class="v">${esc(shown)}</span><span class="b ${cls}" style="height:${height}%"></span><span class="x">${esc(abbr(r[6]))}</span></div>`;
    }).join('');
    const marker = line != null ? `<div class="line" style="bottom:calc(6px + 13px + (100% - 43px) * ${(0.78 * line / max).toFixed(3)})"><span>line ${esc(line)}</span></div>` : '';
    return `<div class="card"><div class="chart" role="img" aria-label="Recent games">${bars}${marker}</div></div>`;
  };

  const LOG_COLS = { QB: ['cmp', 'att', 'passYds', 'passTD', 'int', 'car', 'rushYds'], RB: ['car', 'rushYds', 'rushTD', 'targets', 'rec', 'recYds', 'rzCar'],
    WR: ['targets', 'rec', 'recYds', 'recTD', 'recLong', 'rzTgt'], TE: ['targets', 'rec', 'recYds', 'recTD', 'recLong', 'rzTgt'], PK: ['fgm', 'fga', 'xpm', 'kPts'] };

  const gameLog = (rows, keys, pos, abbr, league) => {
    const cols = [...(LOG_COLS[pos] || LOG_COLS.WR), ...(keys.includes('snapPct') && rows.some(r => C.cell(r, keys, 'snapPct') != null) ? ['snapPct'] : [])];
    const seasons = [...new Set(rows.map(r => r[2]))].sort((a, b) => b - a);
    const season = seasons.includes(Number(state.logSeason)) ? Number(state.logSeason) : null;
    const list = rows.filter(r => season == null || r[2] === season).sort((a, b) => String(b[1]).localeCompare(String(a[1])));
    return `<div class="toolbar">${seg('logSeason', [['all', 'All'], ...seasons.map(s => [String(s), String(s)])], season == null ? 'all' : String(season))}</div>
      <div class="table-wrap"><table class="data"><thead><tr><th>Game</th>${cols.map(c => `<th>${esc(C.LABEL[c] || c)}</th>`).join('')}</tr></thead><tbody>
      ${list.map(r => `<tr><td><a href="#game/${league}-${esc(r[0])}">${esc(r[1])}</a><span class="sub">${r[7] === 0 ? '@' : r[7] === -1 ? 'vs (neutral)' : 'vs'} ${esc(abbr(r[6]))}${r[4] === 3 ? ' · postseason' : ''}</span></td>
        ${cols.map(c => { const v = C.cell(r, keys, c); return `<td>${v == null ? DASH : c === 'snapPct' ? Math.round(100 * v) + '%' : esc(v)}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
  };

  /* ---------- one team ---------- */

  async function viewTeam(route) {
    const league = route.league === 'CFB' ? 'CFB' : 'NFL';
    const [teams, team, index] = await Promise.all([get(`app/teams/${league}.json`), maybe(`app/teams/${league}/${route.id}.json`), get(`app/players/${league}.json`)]);
    const back = '<a class="back" href="#stats/teams">← Teams</a>';
    if (!team) return head('Team not found', 'No stored games for this team.', back);
    const abbr = id => (teams.teams[id] || {}).abbr || id;
    const season = teams.defense.season;
    const games = team.games.filter(g => g.season === season);
    const wins = games.filter(g => g.pf > g.pa).length, losses = games.filter(g => g.pf < g.pa).length;
    const cover = g => {
      if (!g.close || g.close.spread == null || g.home == null) return DASH;
      const line = g.home ? g.close.spread : -g.close.spread;
      const margin = g.pf - g.pa + line;
      return margin > 0 ? 'Covered' : margin < 0 ? 'Missed' : 'Push';
    };
    const roster = index.players.filter(p => String(p[3]) === String(route.id) && String(p[5]).slice(0, 4) >= String(season)).sort((a, b) => b[6] - a[6]).slice(0, 30);
    const allowed = team.defense.filter(d => d.season === season).reverse();
    return `${back}<div class="page-head who"><span class="badge" style="background:${esc(team.color || 'var(--raised)')}">${esc(team.abbr || '')}</span>
        <div><h1>${esc(team.name || team.abbr)}</h1><p>${esc(season)}: ${wins}–${losses} · ${esc(leagueName(league))}</p></div></div>
      ${section('Results', games.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Game</th><th>Score</th><th>Close</th><th>ATS</th><th>Yds</th><th>Allowed</th></tr></thead><tbody>
        ${[...games].reverse().map(g => `<tr><td><a href="#game/${esc(g.gameId)}">${esc(g.date)}</a><span class="sub">${g.home === false ? '@' : g.home === null ? 'neutral' : 'vs'} ${esc(abbr(g.opp))}</span></td>
          <td class="${g.pf > g.pa ? 'up' : 'down'}">${g.pf}–${g.pa}</td><td>${g.close && g.close.spread != null ? signed(g.home === false ? -g.close.spread : g.close.spread) : DASH}</td><td>${cover(g)}</td><td>${g.off.yards ?? DASH}</td><td>${g.def.yards ?? DASH}</td></tr>`).join('')}</tbody></table></div>` : empty('No games yet', 'Results appear after the first game.'))}
      ${section('What this defense allowed', allowed.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Game</th><th>QB pass yds</th><th>RB rush yds</th><th>WR rec yds</th><th>TE rec yds</th></tr></thead><tbody>
        ${allowed.map(d => `<tr><td><a href="#game/${esc(d.gameId)}">${esc(d.date)}</a><span class="sub">${esc(abbr(d.opp))}</span></td><td>${(d.allowed.QB || {}).passYds ?? 0}</td><td>${(d.allowed.RB || {}).rushYds ?? 0}</td><td>${(d.allowed.WR || {}).recYds ?? 0}</td><td>${(d.allowed.TE || {}).recYds ?? 0}</td></tr>`).join('')}</tbody></table></div>` : empty('Nothing yet', 'Appears after the first game.'), '<a href="#stats/defense">Rankings →</a>')}
      ${section('Players this season', roster.length ? `<div class="card results">${roster.map(p => `<a href="#player/${league}/${esc(p[0])}"><span><b>${esc(p[1])}</b> <small>${esc(p[2] || '')}</small></span><small>${p[6]} games stored</small></a>`).join('')}</div>` : empty('No players yet', 'Players appear after their first stat line.'))}`;
  }

  /* ---------- model scoreboard ---------- */

  async function viewModel() {
    const board = await get('scoreboard.json');
    const live = (board.live || []).filter(inLeague);
    const back = (board.backtest || []).filter(inLeague);
    const rec = r => `${r[0]}–${r[1]}${r[2] ? '–' + r[2] : ''}`;
    const rate = r => r[0] + r[1] ? Math.round(100 * r[0] / (r[0] + r[1])) + '%' : DASH;
    const table = (rows, caption) => `<div class="table-wrap"><table class="data"><caption>${caption}</caption><thead><tr><th>Model</th><th>Games</th><th>Vs close</th><th>Margin miss</th><th>Close miss</th><th>Totals</th><th>Total miss</th><th>Closer</th><th>Line moved our way</th><th>80% held</th></tr></thead><tbody>
      ${rows.map(r => { const s = r.summary; return `<tr><td>${esc(leagueName(r.league))} ${esc(r.model)}<span class="sub">${esc(r.season)}</span></td><td>${s.games}</td><td>${rec(s.side)}<span class="sub">${rate(s.side)}</span></td>
        <td>${fixed(s.marginMiss)}</td><td>${fixed(s.closeMarginMiss)}</td><td>${rec(s.ou)}<span class="sub">${rate(s.ou)}</span></td><td>${fixed(s.totalMiss)}<span class="sub">close ${fixed(s.closeTotalMiss)}</span></td>
        <td>${rate(s.closerMargin)}</td><td>${rate(s.movedToward)}</td><td>${s.within80 != null ? Math.round(100 * s.within80) + '%' : DASH}</td></tr>`; }).join('')}</tbody></table></div>`;
    const weeks = rows => rows.map(r => `<details class="card" style="padding:0 12px;margin-top:8px"><summary style="padding:12px 0;cursor:pointer;font-size:13px;font-weight:600">${esc(leagueName(r.league))} ${esc(r.model)} ${esc(r.season)} by week</summary>
      <div class="table-wrap" style="margin-bottom:12px"><table class="data"><thead><tr><th>Week</th><th>Games</th><th>Vs close</th><th>Margin miss</th><th>Close miss</th><th>Totals</th></tr></thead><tbody>
      ${r.weeks.map(w => `<tr><td>${esc(w.week === 'post' ? 'Postseason' : 'Week ' + w.week)}</td><td>${w.games}</td><td>${rec(w.side)}</td><td>${fixed(w.marginMiss)}</td><td>${fixed(w.closeMarginMiss)}</td><td>${rec(w.ou)}</td></tr>`).join('')}</tbody></table></div></details>`).join('');
    const props = (board.props || {}).markets || [];
    const picks = (board.picks || {}).rows || [];
    return `${head('The scoreboard', 'Every forecast published before kickoff, graded against the closing line and the final score. The point is to see how well the model actually does, not to sell it.')}
      <div class="notice"><strong>How to read this.</strong> “Vs close” takes the side the model preferred against the closing spread; 52.4% breaks even at -110. “Miss” is the average distance from the final margin or total, next to the closing line’s own miss. “Line moved our way” counts games where the market moved from its open toward the model, a faster signal than wins and losses.</div>
      ${section('Live record', live.length ? table(live, 'Published before kickoff') + weeks(live) : empty('Nothing graded yet', 'Live grades start when the first v2 forecasts reach kickoff.'))}
      ${section('Backtests', back.length ? table(back, 'Retrospective walk-forward, never published') + weeks(back) : empty('No backtests', ''))}
      ${section('Player projections vs DraftKings lines', props.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Market</th><th>Graded</th><th>Record</th><th>Closer than line</th><th>Projection miss</th><th>Line miss</th></tr></thead><tbody>
        ${props.map(p => `<tr><td>${esc(C.LABEL[p.market] || p.market)}</td><td>${p.graded}</td><td>${rec(p.record)}</td><td>${rate(p.closerThanLine)}</td><td>${fixed(p.projectionMiss)}</td><td>${fixed(p.lineMiss)}</td></tr>`).join('')}</tbody></table></div>`
        : empty('Nothing graded yet', 'NFL projections are compared with the last DraftKings line captured before kickoff once games finish.'))}
      ${section('Closing-line value on our picks', picks.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Pick</th><th>Posted</th><th>Last before kickoff</th><th>CLV</th><th>Result</th></tr></thead><tbody>
        ${picks.map(p => `<tr><td>${esc(p.title)}<span class="sub">${esc(p.book || '')} ${odds(p.postedOdds)}</span></td><td>${p.postedLine ?? DASH}</td><td>${p.closeLine ?? DASH}${p.closeAt ? `<span class="sub">${esc(p.closeSource)} · ${esc(p.minutesBeforeKickoff)} min before</span>` : ''}</td>
          <td class="${p.clv > 0 ? 'up' : p.clv < 0 ? 'down' : ''}">${p.clv == null ? DASH : signed(p.clv)}</td><td>${esc(p.result || 'pending')}</td></tr>`).join('')}</tbody></table></div>` : empty('No picks yet', ''))}
      ${section('Method', `<div class="card" style="padding:14px"><ul class="list">${Object.values(board.method || {}).map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`)}`;
  }

  /* ---------- the record ---------- */

  async function viewRecord() {
    const [data, board] = await Promise.all([get('app/today.json'), maybe('scoreboard.json')]);
    const clv = new Map((((board || {}).picks || {}).rows || []).map(r => [r.id, r]));
    const league = data.picks.filter(inLeague);
    const picks = state.recordScope === 'favorites' ? league.filter(p => p.favorite) : league;
    const settled = picks.filter(p => p.result).sort((a, b) => String(b.settledAt || b.publishedAt).localeCompare(String(a.settledAt || a.publishedAt)));
    const r = C.recordOf(picks);
    const types = [...new Set(picks.map(C.category))].map(name => [name, C.recordOf(picks.filter(p => C.category(p) === name))]);
    const typeRow = ([name, t]) => `<tr><th scope="row">${esc(name)}</th><td class="num">${t.wins}–${t.losses}–${t.pushes}</td><td class="num">${t.units == null ? DASH : signed(t.units, 2) + 'u'}</td><td class="num">${t.priced}</td></tr>`;
    return `${head('The record', 'Every published pick at one unit, win or lose. Original prices are frozen; later moves are logged, never re-priced.')}
      <div class="toolbar">${seg('recordScope', [['all', `All picks (${league.length})`], ['favorites', `Favorites (${league.filter(p => p.favorite).length})`]], state.recordScope)}</div>
      ${recordCard(r, false)}
      ${types.length > 1 ? section('By type', `<div class="table-wrap"><table class="data"><thead><tr><th>Type</th><th>W–L–P</th><th>Net units</th><th>Priced</th></tr></thead><tbody>${types.map(typeRow).join('')}</tbody></table></div>`) : ''}
      ${section('Every settled pick', settled.length ? `<div class="card"><div class="rows">${settled.map(p => {
        const c = clv.get(p.id);
        return pickRow({ ...p, actual: [p.actual, c && c.clv != null ? `CLV ${signed(c.clv)}` : null].filter(Boolean).join(' · ') });
      }).join('')}</div></div>` : empty('Nothing settled yet', ''))}`;
  }

  /* ---------- board and tickets ---------- */

  async function viewBoard() {
    const data = await get('app/lines.json');
    const all = data.lines.filter(inLeague);
    const query = state.boardQuery.trim().toLowerCase();
    let shown = all.filter(l => state.boardScope === 'open' ? l.state === 'open' || l.state === 'reference'
      : state.boardScope === 'settled' ? l.state === 'closed' : true);
    if (query) shown = shown.filter(l => `${l.player || ''} ${l.title || ''} ${l.market || ''}`.toLowerCase().includes(query));
    const rank = { open: 0, reference: 1, stale: 2, unpriced: 3, closed: 4 };
    const byKickoff = (a, b) => String(a.kickoff).localeCompare(String(b.kickoff)) || String(a.player || a.title).localeCompare(String(b.player || b.title));
    shown.sort((a, b) => (rank[a.state] - rank[b.state]) || (state.boardSort === 'best' ? C.byGrade(a, b) : 0) || byKickoff(a, b));
    const open = all.filter(l => l.state === 'open');
    const liked = open.filter(l => (l.grade || {}).tier === 'strong').length, leans = open.filter(l => (l.grade || {}).tier === 'lean').length;
    return `${head('The board', `${open.length} open lines. The model likes ${liked} and leans slightly on ${leans}. These are prices we saw, not picks; only our picks are selections.`)}
      <div class="toolbar">${seg('boardScope', [['open', 'Open'], ['all', 'Everything'], ['settled', 'Closed']], state.boardScope)}${seg('boardSort', [['best', 'Best first'], ['time', 'By kickoff']], state.boardSort)}</div>
      <p class="row-meta" style="margin:0 0 10px">Each line shows v2's chance of winning it next to what its price needs. <b class="grade-word grade-strong">Model likes it</b> is 5+ points clear; <b class="grade-word grade-lean">Slight lean</b> is 2 to 5, or any edge on a thin early-season sample. v2 has not beaten the closing line yet: this is where to look, not what to bet.</p>
      <input class="search" type="search" data-input="boardQuery" placeholder="Player, team or market" value="${esc(state.boardQuery)}" aria-label="Search lines">
      <div id="board-rows">${shown.length ? `<div class="card"><div class="rows">${shown.slice(0, 250).map(lineRow).join('')}</div></div>` : empty('Nothing matches', 'Try another search or scope.')}</div>
      <p class="row-meta" style="margin-top:10px">Tap + to add a priced, current line to your ticket. Tickets stay on this device and never enter the record.</p>`;
  }

  async function viewTicket() {
    const data = await get('app/lines.json');
    const current = new Map(data.lines.map(l => [l.id, l]));
    const rows = state.ticket.map(item => {
      const now = current.get(item.id);
      if (!now) return { ...item, state: 'closed', missing: true };
      return { ...now, changed: now.odds !== item.odds || now.line !== item.line, previous: item };
    });
    const summary = C.summarizeTicket(rows.filter(r => !r.changed), state.stake.amount, state.stake.mode, state.stake.unit);
    const money = n => '$' + Number(n).toFixed(2);
    return `${head('Your ticket', 'A personal draft that stays on this device. It is not a pick and never enters the record.')}
      ${rows.length ? `<div class="card"><div class="rows">${rows.map(r => `<div class="row" style="cursor:default"><span class="row-main"><span class="row-top"><span class="row-name">${esc(r.player || r.title)}</span>
          ${r.missing ? '<span class="pill pill-closed">Gone</span>' : r.changed ? '<span class="pill pill-stale">Price changed</span>' : ''}</span>
          <span class="row-market">${esc([r.direction, r.line, r.market].filter(v => v != null && v !== '').join(' '))}</span>
          <span class="row-meta">${esc(r.book || '')} ${odds(r.odds)}${r.changed ? ` · was ${esc(odds(r.previous.odds))}${r.previous.line !== r.line ? ' at ' + esc(r.previous.line) : ''}` : ''}</span></span>
          ${r.changed ? `<button class="btn" type="button" data-accept="${esc(r.id)}" style="align-self:center;margin-right:6px">Accept</button>` : ''}
          <button class="add" type="button" data-add="${esc(r.id)}" aria-pressed="true" aria-label="Remove">×</button></div>`).join('')}</div></div>` : empty('Your ticket is empty', 'Add current, priced lines from the board.', '<a class="btn" href="#board">Open the board</a>')}
      ${rows.length ? section('Stake', `<div class="card" style="padding:14px"><div class="toolbar">${seg('stakeMode', [['units', 'Units'], ['money', 'Dollars']], state.stake.mode)}</div>
        <div class="stats"><label class="field">Stake<input type="number" min="0" step="0.5" inputmode="decimal" data-stake="amount" value="${esc(state.stake.amount)}"></label>
        ${state.stake.mode === 'units' ? `<label class="field">Dollars per unit<input type="number" min="0" step="1" inputmode="decimal" data-stake="unit" value="${esc(state.stake.unit)}"></label>` : ''}</div>
        <div id="ticket-summary" style="margin-top:12px">${ticketSummary(summary, money)}</div>
        <div class="toolbar" style="margin-top:12px"><button class="btn" type="button" data-copy-ticket>Copy ticket text</button><button class="btn" type="button" data-clear-ticket>Clear</button></div></div>`) : ''}`;
  }

  const ticketSummary = (summary, money) => summary.available
    ? `<div class="stats">${stat('Illustrative price', odds(summary.odds), `${summary.decimal.toFixed(2)} decimal`)}${stat('Profit', summary.dollars ? money(summary.dollars.profit) : summary.profit.toFixed(2), summary.dollars ? `${summary.profit.toFixed(2)}u` : 'on your stake')}${stat('Return', summary.dollars ? money(summary.dollars.total) : summary.total.toFixed(2), 'stake included')}</div><p class="row-meta" style="margin:8px 0 0">${esc(summary.reason)}</p>`
    : `<div class="notice">${esc(summary.reason)}</div>`;

  /* ---------- research ---------- */

  async function viewResearch() {
    const [data, today] = await Promise.all([get('app/research.json'), get('app/today.json')]);
    const league = dataLeague();
    const inj = data.injuries[league] || {};
    const teams = Object.entries(inj.teams || {}).sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)));
    const notes = data.notes.filter(n => state.league === 'ALL' || n.league === state.league);
    const gameName = id => { const g = today.games.find(x => x.id === id); return g ? `${g.away.abbr} @ ${g.home.abbr}` : id; };
    const text = item => typeof item === 'string' ? item : item.text || item.summary || JSON.stringify(item);
    const changes = data.changes.filter(c => c.league === league).slice(-12).reverse();
    return `${head('Research desk', 'Injuries, status changes and the analyst’s notes. Context for research, separate from the model and the picks.')}
      ${section(`${leagueName(league)} injury report`, league === 'CFB' ? '<p class="row-meta">College injury reports are not covered by the feed.</p>' : teams.length ? `<div class="card"><div class="rows">${teams.map(([, t]) => `<details class="row" style="display:block;cursor:default"><summary style="padding:12px;cursor:pointer"><b>${esc(t.name)}</b> <span class="row-meta">${t.players.length} listed</span></summary>
          <div style="padding:0 12px 12px">${t.players.map(p => `<div class="row-meta" style="padding:3px 0"><span class="pill ${/out|reserve/i.test(p.status) ? 'pill-out' : 'pill-q'}">${esc(p.status)}</span> <b style="color:var(--text)">${esc(p.name)}</b> ${esc(p.position || '')} · ${esc(p.injury || 'not listed')} · ${esc(ago(p.reportedAt))}</div>`).join('')}</div></details>`).join('')}</div></div>
          <p class="row-meta" style="margin-top:8px">Checked ${esc(ago(inj.checkedAt))}. A missing listing is not proof of health.</p>` : empty('Nobody listed', 'No recent injury entries in the feed.'))}
      ${changes.length ? section('Status changes', `<div class="card"><div class="rows">${changes.map(c => `<div class="row" style="cursor:default"><span class="row-main"><span class="row-name">${esc(c.name)}</span><span class="row-market">${esc(c.from)} → ${esc(c.to)}</span><span class="row-meta">${esc(ago(c.observedAt))}</span></span></div>`).join('')}</div></div>`) : ''}
      ${section('Analyst notes', notes.length ? notes.map(n => `<div class="card" style="padding:14px;margin-bottom:8px"><p class="eyebrow">${esc(leagueName(n.league))} · ${esc(when(n.publishedAt))}</p>
          ${n.takeaways.length ? `<ul class="list">${n.takeaways.map(t => `<li>${esc(text(t))}</li>`).join('')}</ul>` : ''}
          ${n.weeklyReview.length ? `<p class="eyebrow" style="margin-top:10px">Review</p><ul class="list">${n.weeklyReview.map(t => `<li>${esc(text(t))}</li>`).join('')}</ul>` : ''}
          ${n.watch.length ? `<p class="eyebrow" style="margin-top:10px">Watching</p><ul class="list">${n.watch.map(w => `<li><b>${esc(w.title)}</b>${w.gameId ? ` (<a href="#game/${esc(w.gameId)}">${esc(gameName(w.gameId))}</a>)` : ''}: ${esc(w.why || '')}${w.needs ? ` <span class="faint">Needs: ${esc(Array.isArray(w.needs) ? w.needs.join('; ') : w.needs)}</span>` : ''}</li>`).join('')}</ul>` : ''}</div>`).join('')
        : empty('No notes yet', 'Notes appear when the research run publishes.'))}`;
  }

  /* ---------- NBA and MLB scores ---------- */

  async function viewScores(route) {
    const data = await get('sports.json');
    const league = route.league === 'NBA' || route.league === 'MLB' ? route.league : state.scoresLeague;
    const block = (data.leagues || {})[league] || {};
    const games = (block.games || []).slice().sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));
    const days = [...new Set(games.map(g => g.date))];
    const day = days.includes(state.scoresDate) ? state.scoresDate : days[0];
    const shown = games.filter(g => g.date === day);
    const side = (team, score) => `<div class="game-team"><span>${esc(team.abbreviation || team.shortName || DASH)}</span>${score != null ? `<span class="score" style="margin-left:auto">${esc(score)}</span>` : ''}</div>`;
    return `${head(`${league} scores`, `${esc(block.coverageNote || 'Schedules and scores only.')} Checked ${esc(ago(block.checkedAt))}.`)}
      <div class="toolbar"><div class="seg" role="group"><a class="chip" href="#scores/NBA" aria-pressed="${league === 'NBA'}" style="display:inline-flex;align-items:center">NBA</a><a class="chip" href="#scores/MLB" aria-pressed="${league === 'MLB'}" style="display:inline-flex;align-items:center">MLB</a></div>
        ${days.length ? seg('scoresDate', days.map(d => [d, new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })]), day) : ''}</div>
      ${shown.length ? `<div class="card">${shown.map(g => `<div class="game-row"><span class="game-teams" style="width:92px">${side(g.teams.away, g.teams.away.score)}${side(g.teams.home, g.teams.home.score)}</span>
          <span class="game-mid">${esc(g.statusDetail || g.status)}</span>${external(g.link || g.source, 'ESPN')}</div>`).join('')}</div>`
        : empty(`No ${league} games in the window`, block.status === 'ok' ? 'The provider returned no games for these dates.' : 'The feed is unavailable; the last good data is kept.')}`;
  }

  /* ---------- more ---------- */

  async function viewMore() {
    const count = state.ticket.length;
    const link = (href, label, note) => `<a href="${href}"><span>${label}</span><small>${note}</small></a>`;
    return `${head('More', '')}
      <div class="card menu">${link('#board', 'The board', 'Lines we observe, with sources')}${link('#ticket', 'Your ticket', count ? `${count} line${count === 1 ? '' : 's'}` : 'Parlay builder')}
      ${link('#research', 'Research desk', 'Injuries and analyst notes')}${link('#stats/defense', 'Defense vs position', 'Rankings')}${link('#scores/NBA', 'NBA scores', 'Schedules and scores')}${link('#scores/MLB', 'MLB scores', 'Schedules and scores')}</div>
      <div class="section card" style="padding:14px"><p class="prose" style="margin:0"><b>About.</b> KeenRoudy Sports is a stats engine graded against the betting market. The model publishes score and player projections before kickoff, every forecast is kept, and the scoreboard grades them against the closing line. Stats come from ESPN’s public feeds and nflverse. For entertainment only; nothing here is betting advice.</p></div>`;
  }

  /* ---------- pick details ---------- */

  async function openPick(id) {
    const data = await get('app/today.json');
    const p = data.picks.find(x => x.id === id);
    if (!p) return;
    const dialog = $('#detail');
    const hostOf = (url, i) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return 'Source ' + (i + 1); } };
    /* Reports are hand-written JSON: a field may be text, a list or an object. Show whichever it is as text. */
    const prose = v => v == null ? '' : typeof v === 'string' ? v : Array.isArray(v) ? v.map(prose).join(' · ')
      : typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}: ${prose(x)}`).join(' · ') : String(v);
    const leg = l => typeof l === 'string' ? l : l.title || [l.player, l.direction, l.line, l.market].filter(x => x != null && x !== '').join(' ');
    const closed = !p.result && !p.historicalImport && C.pickState(p).tone === 'closed';
    const started = p.kickoff && Date.parse(p.kickoff) <= Date.now();
    dialog.innerHTML = `<div class="detail-inner"><div class="detail-head"><div><div class="row-top">${p.result ? `<span class="pill pill-${p.result === 'win' ? 'win' : p.result === 'loss' ? 'loss' : 'closed'}">${esc(p.result)}</span>` : '<span class="pill pill-ours">Our pick</span>'}</div>
      <h3 style="margin:7px 0 0;font-size:17px">${esc(p.title)}</h3><p class="row-meta" style="margin:4px 0 0">${esc(when(p.kickoff || p.publishedAt))}</p></div><button class="close" type="button" data-close aria-label="Close">×</button></div>
      <div class="detail-body"><div class="kv"><div><span>Price</span><strong>${esc(p.book || 'No book')} ${odds(p.odds)}</strong></div><div><span>Our number</span><strong>${p.projection ?? DASH}</strong></div><div><span>Confidence</span><strong>${p.confidence != null ? p.confidence + '/10' : DASH}</strong></div><div><span>Quoted</span><strong style="font-size:12px">${esc(ago(p.quotedAt))}</strong></div></div>
      ${closed ? `<div class="notice" style="margin-top:12px"><strong>Closed to new entries.</strong> ${esc(prose(p.entryNote) || (p.status === 'withdrawn' ? 'Withdrawn before kickoff.' : started ? 'The game has started.' : 'The quote has expired.'))} The original is still graded at its published price.</div>` : ''}
      ${(p.legs || []).length ? `<h4>Legs</h4><ul style="margin:0;padding-left:18px">${p.legs.map(l => `<li>${esc(leg(l))}</li>`).join('')}</ul>` : ''}${p.correlation ? `<h4>How the legs relate</h4><p>${esc(prose(p.correlation))}</p>` : ''}
      ${p.cutoff ? `<h4>Worst number we would take</h4><p>${esc(prose(p.cutoff))}</p>` : ''}${p.why ? `<h4>Why</h4><p>${esc(prose(p.why))}</p>` : ''}${p.risk ? `<h4>What could go wrong</h4><p>${esc(prose(p.risk))}</p>` : ''}${p.edge ? `<h4>Edge estimate</h4><p>${esc(prose(p.edge))}</p>` : ''}
      ${p.actual ? `<h4>Result</h4><p>${esc(prose(p.actual))}</p>` : ''}${p.settlementReason ? `<p>${esc(prose(p.settlementReason))}</p>` : ''}
      ${(p.sources || []).length ? `<h4>Sources</h4><div class="sources">${p.sources.filter(s => /^https:/.test(s)).map((s, i) => `<a href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(hostOf(s, i))} ↗</a>`).join('')}</div>` : ''}
      <p class="row-meta" style="margin-top:14px">Recorded at one unit. The original price is kept for grading even after the line moves.</p></div></div>`;
    dialog.showModal();
  }

  /* ---------- shell ---------- */

  const VIEWS = { today: viewToday, games: viewGames, game: viewGame, stats: viewStats, player: viewPlayer, team: viewTeam,
    model: viewModel, record: viewRecord, board: viewBoard, ticket: viewTicket, research: viewResearch, scores: viewScores, more: viewMore };

  function chrome(route) {
    const active = TAB_FOR[route.view] || route.view;
    $('#tabs').innerHTML = TABS.map(([id, label]) => `<a href="#${id}" ${active === id ? 'aria-current="page"' : ''}>${icon(ICONS[id])}<span>${label}</span></a>`).join('');
    $('#leagues').innerHTML = [['NFL', 'NFL'], ['CFB', 'College'], ['ALL', 'All']].map(([value, label]) =>
      `<button type="button" data-league="${value}" aria-pressed="${state.league === value}">${label}</button>`).join('');
    const bar = $('#ticket-bar');
    const show = state.ticket.length > 0 && route.view !== 'ticket';
    bar.hidden = !show;
    if (show) bar.innerHTML = `<span>Ticket · ${state.ticket.length} line${state.ticket.length === 1 ? '' : 's'}</span><span>Open →</span>`;
  }

  let token = 0;
  async function render() {
    const route = C.parseRoute(location.hash);
    const mine = ++token;
    chrome(route);
    const view = $('#view');
    const slow = setTimeout(() => { if (mine === token) view.innerHTML = '<div class="loading">Loading…</div>'; }, 120);
    try {
      const html = await (VIEWS[route.view] || viewToday)(route);
      if (mine !== token) return;
      view.innerHTML = html;
    } catch (error) {
      if (mine !== token) return;
      view.innerHTML = `<div class="empty" style="margin-top:32px"><h3>Could not load this page</h3><p>${esc(error.message)}</p><button class="btn" type="button" data-retry>Try again</button></div>`;
    } finally {
      clearTimeout(slow);
    }
  }

  const saveTicket = () => saved.set('ticket', state.ticket);

  async function toggleLine(id) {
    const existing = state.ticket.findIndex(t => t.id === id);
    if (existing >= 0) state.ticket.splice(existing, 1);
    else {
      const data = await get('app/lines.json');
      const row = data.lines.find(l => l.id === id);
      if (row) state.ticket.push({ id: row.id, title: row.title, player: row.player, market: row.market, line: row.line, direction: row.direction,
        odds: row.odds, book: row.book, gameId: row.gameId, kickoff: row.kickoff, expiresAt: row.expiresAt, observedAt: row.observedAt, state: row.state });
    }
    saveTicket();
    render();
  }

  document.addEventListener('click', event => {
    const target = event.target;
    const league = target.closest('[data-league]');
    if (league) { state.league = league.dataset.league; saved.set('league', state.league); render(); return; }
    const setter = target.closest('[data-set]');
    if (setter) {
      const [key, value] = setter.dataset.set.split(':');
      if (key === 'stakeMode') { state.stake.mode = value; saved.set('stake', state.stake); } else state[key] = value;
      render();
      return;
    }
    const add = target.closest('[data-add]');
    if (add) { toggleLine(add.dataset.add); return; }
    const accept = target.closest('[data-accept]');
    if (accept) {
      get('app/lines.json').then(data => {
        const row = data.lines.find(l => l.id === accept.dataset.accept);
        const item = state.ticket.find(t => t.id === accept.dataset.accept);
        if (row && item) Object.assign(item, { odds: row.odds, line: row.line, observedAt: row.observedAt, state: row.state, expiresAt: row.expiresAt });
        saveTicket();
        render();
      });
      return;
    }
    if (target.closest('[data-copy-ticket]')) {
      const text = C.ticketText(state.ticket);
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard')))
        .then(() => { target.textContent = 'Copied'; }).catch(() => { window.prompt('Copy the ticket text:', text); });
      return;
    }
    if (target.closest('[data-clear-ticket]')) { state.ticket = []; saveTicket(); render(); return; }
    if (target.closest('[data-retry]')) { cache.clear(); render(); return; }
    if (target.closest('[data-close]')) { $('#detail').close(); return; }
    const pick = target.closest('[data-pick]');
    if (pick) openPick(pick.dataset.pick);
  });

  document.addEventListener('change', event => {
    const select = event.target.closest('[data-select]');
    if (select) { state[select.dataset.select] = select.value; render(); }
  });

  document.addEventListener('input', event => {
    const field = event.target;
    if (field.dataset.input === 'playerQuery') {
      state.playerQuery = field.value;
      get(`app/players/${dataLeague()}.json`).then(index => { const box = $('#player-results'); if (box) box.innerHTML = playerResults(index, dataLeague()); });
    } else if (field.dataset.input === 'boardQuery') {
      state.boardQuery = field.value;
      const caret = field.selectionStart;
      render().then(() => { const box = document.querySelector('[data-input="boardQuery"]'); if (box) { box.focus(); box.setSelectionRange(caret, caret); } });
    } else if (field.dataset.stake) {
      state.stake[field.dataset.stake] = Number(field.value);
      saved.set('stake', state.stake);
      get('app/lines.json').then(data => {
        const current = new Map(data.lines.map(l => [l.id, l]));
        const rows = state.ticket.map(t => current.get(t.id) || { ...t, state: 'closed' });
        const box = $('#ticket-summary');
        if (box) box.innerHTML = ticketSummary(C.summarizeTicket(rows, state.stake.amount, state.stake.mode, state.stake.unit), n => '$' + Number(n).toFixed(2));
      });
    }
  });

  window.addEventListener('hashchange', () => { render().then(() => window.scrollTo(0, 0)); });
  render();
})();

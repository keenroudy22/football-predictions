(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KeenSports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const names = { NFL: 'NFL', CFB: 'College football', NBA: 'NBA', MLB: 'MLB' };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const validTime = value => value != null && Number.isFinite(typeof value === 'number' ? value : Date.parse(value));
  const time = (value, options = {}) => validTime(value) ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', ...options }).format(new Date(value)) : 'Not available';
  const stamp = value => time(value, { hour: 'numeric', minute: '2-digit' }) + (validTime(value) ? ' ET' : '');
  const dateKey = value => validTime(value) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : '';
  const external = (url, label, className = '') => /^https:\/\//.test(url || '') ? `<a class="${escape(className)}" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(label)} ↗</a>` : '';
  const badge = league => `<span class="sport-label sport-${escape(league.toLowerCase())}">${escape(names[league] || league)}</span>`;
  let data = null, request = null, selectedDate = 'all', currentLeague = null;

  function matches(hash) { return !hash || hash === '#' || hash === '#sports' || /^#sport\/(NBA|MLB)$/.test(hash); }
  function freshness(league, now = Date.now()) {
    if (!league || !validTime(league.lastSuccessfulAt)) return { label: 'Feed unavailable', warning: true };
    if (['unavailable', 'stale', 'partial'].includes(league.status)) return { label: league.status === 'partial' ? 'Partial schedule · check source' : 'Update delayed · saved scores', warning: true };
    const age = now - Date.parse(league.lastSuccessfulAt);
    return age > 12 * 3600000 || age < -300000 ? { label: 'Saved snapshot · refresh due', warning: true } : { label: 'Latest saved scoreboard', warning: false };
  }
  function scoreCard(game) {
    const status = game.status || 'unknown';
    const hasScore = ['in_progress', 'final'].includes(status);
    const row = side => {
      const team = game.teams?.[side] || {}, score = game.scores?.[side];
      return `<div class="score-team"><span class="team-initial">${escape(team.abbreviation || 'TBD')}</span><span>${escape(team.shortName || team.name || 'Team to be confirmed')}</span><strong>${hasScore && typeof score === 'number' && Number.isFinite(score) ? escape(score) : '—'}</strong></div>`;
    };
    const label = { scheduled: game.timeConfirmed === false ? 'Time TBD' : time(game.kickoff, { hour: 'numeric', minute: '2-digit' }) + ' ET', in_progress: 'In progress · snapshot', final: 'Final', postponed: 'Postponed', suspended: 'Suspended', delayed: 'Delayed', cancelled: 'Cancelled', unknown: 'Status unavailable' }[status] || 'Status unavailable';
    return `<article class="sports-scorecard"><div class="sports-card-top">${badge(game.league)}<span class="game-state ${status === 'in_progress' ? 'game-underway' : ''}">${escape(label)}</span></div>${row('away')}${row('home')}<div class="sports-card-bottom"><span>${escape(game.statusDetail || '')}</span>${external(game.source?.url, 'Game details')}</div></article>`;
  }
  function leaguePanel(league, snapshot, now = Date.now(), compact = false, date = 'all') {
    const live = freshness(snapshot, now), all = snapshot?.games || [];
    const filtered = (date === 'all' ? all : all.filter(g => (g.date || dateKey(g.kickoff)) === date)).slice().sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
    const games = compact ? filtered.slice(0, 3) : filtered;
    const windowText = snapshot?.window ? `${time(snapshot.window.from + 'T12:00:00Z')}–${time(snapshot.window.through + 'T12:00:00Z')}` : 'Current window';
    let body;
    if (!games.length) body = `<div class="sport-empty"><strong>${live.warning ? 'The schedule is not fully available.' : 'No games on this board.'}</strong><p>${live.warning ? 'Check the source schedule while we wait for a successful refresh.' : `${escape(date === 'all' ? windowText : time(date + 'T12:00:00Z'))} has no listed ${escape(league)} games. Check back for the next slate.`}</p></div>`;
    else body = `<div class="sports-score-grid">${games.map(scoreCard).join('')}</div>`;
    return `<section class="sport-board" aria-label="${escape(league)} scoreboard"><div class="sports-section-heading"><div>${badge(league)}<h2>${compact ? `${escape(league)} scoreboard` : 'On the schedule'}</h2></div>${compact ? `<a class="text-link" href="#sport/${league}">All ${escape(league)} games →</a>` : `<span class="board-count">${games.length} game${games.length === 1 ? '' : 's'}</span>`}</div><p class="scoreboard-freshness${live.warning ? ' delayed' : ''}">${escape(live.label)} · ${snapshot?.lastSuccessfulAt ? `Updated ${escape(stamp(snapshot.lastSuccessfulAt))}` : 'No successful check yet'}${snapshot?.status === 'partial' && snapshot.checkedAt ? ` · Attempted ${escape(stamp(snapshot.checkedAt))}` : ''}</p>${body}<div class="sport-source">${external(snapshot?.source?.url, `${league} source schedule`)}<span>Scores only · Picks and forecasts are not enabled for ${escape(league)}.</span></div></section>`;
  }
  function actionable(pick, now) {
    const odds = Number(pick?.odds);
    return pick?.status === 'active' && validTime(pick?.expiresAt) && Date.parse(pick.expiresAt) > now && validTime(pick.quotedAt) && Date.parse(pick.quotedAt) <= now && Number.isFinite(odds) && Math.abs(odds) >= 100 && Boolean(pick.book);
  }
  function latestFavorite(state, now) {
    const latest = new Map();
    for (const report of [...(state.reports || [])].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))) {
      for (const pick of report.props || []) latest.set(pick.id, { ...pick, publishedAt: pick.publishedAt || report.publishedAt, league: report.league });
    }
    const games = new Map((state.slate?.games || []).map(g => [g.id, g]));
    return [...latest.values()].filter(p => p.favorite && !['withdrawn', 'replaced'].includes(p.status) && (p.gameIds || []).some(id => {
      const g = games.get(id); return g && dateKey(g.kickoff) === dateKey(now) && g.state === 'pre' && !g.completed && Date.parse(g.kickoff) > now;
    })).sort((a, b) => Number(actionable(b, now)) - Number(actionable(a, now)) || (b.confidence || 0) - (a.confidence || 0) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt))[0] || null;
  }
  function footballPreview(state, now) {
    if (state.footballError) return '<section class="football-desk"><div class="sports-section-heading"><h2>Football feed unavailable.</h2></div><p class="quiet-state">The football board could not load. Its games, picks and records have not been verified on this visit. Please try again shortly. NBA and MLB scoreboards remain available below.</p></section>';
    const today = dateKey(now), games = (state.slate?.games || []).filter(g => dateKey(g.kickoff) === today).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
    return `<section class="football-desk"><div class="sports-section-heading"><div><p class="eyebrow">FOOTBALL DESK</p><h2>Tonight starts here.</h2></div><a class="text-link" href="#scores">Full football board →</a></div>${games.length ? `<div class="tonight-list">${games.slice(0, 6).map(g => `<a class="tonight-game" href="#game/${escape(g.id)}">${badge(g.league)}<strong>${escape(g.away?.short || g.away?.abbreviation)} <span>at</span> ${escape(g.home?.short || g.home?.abbreviation)}</strong><span>${g.completed ? `Final · ${escape(g.away?.score)}–${escape(g.home?.score)}` : g.state === 'in' ? 'In progress · snapshot' : time(g.kickoff, { hour: 'numeric', minute: '2-digit' }) + ' ET'}</span><span aria-hidden="true">↗</span></a>`).join('')}</div>` : '<p class="quiet-state">No football games listed today. Explore the upcoming slate and early player research.</p>'}</section>`;
  }
  function homeHTML(state, snapshot, now = Date.now()) {
    const pick = state.footballError ? null : latestFavorite(state, now);
    const paused = /paus/i.test(pick?.entryNote || '');
    const quoteActive = actionable(pick, now) && !paused;
    const favorite = pick ? `<section class="kr-home-favorite"><div class="kr-home-favorite-label"><span aria-hidden="true">★</span> TODAY’S FEATURED PICK <small>${paused ? 'Original pick · entries paused' : quoteActive ? 'Verified quote · check cutoff' : 'Published pick · price recheck needed'}</small></div><div class="kr-home-favorite-body"><div><h2>${escape(pick.title)}</h2><p>${escape(pick.book)} ${pick.odds > 0 ? '+' : ''}${escape(pick.odds)} <span>· Original published selection · 1u tracked</span></p></div><a href="#game/${escape(pick.gameIds[0])}">View research →</a></div><details><summary>Price limit & quote time</summary><p><strong>Price limit:</strong> ${escape(pick.cutoff || 'Recheck the current book price.')}</p><p>Quoted ${escape(stamp(pick.quotedAt))}. ${quoteActive ? 'Verify availability before entry.' : 'The saved quote is no longer actionable.'}</p></details></section>` : '';
    return `<section class="kr-home-start"><div><p class="eyebrow">YOUR RESEARCH. YOUR CALL.</p><h2>Find a line.<br>See the whole picture.</h2><p>Compare the numbers, explore the matchup and put your ideas together. Our favorites are marked along the way.</p><div class="kr-home-actions"><a class="kr-home-primary" href="#props">Explore picks & lines <span aria-hidden="true">→</span></a><a href="#players">Find a player</a></div></div><ol class="kr-home-steps"><li><span>01</span><div><strong>Scan the board</strong><p>Compact lines, book prices and favorites.</p></div></li><li><span>02</span><div><strong>Find your angle</strong><p>Game logs, workload and defense matchups.</p></div></li><li><span>03</span><div><strong>Build your ticket</strong><p>Save ideas and compare a personal draft.</p></div></li></ol></section>${favorite}<nav class="kr-home-links" aria-label="Research tools"><a href="#props"><span aria-hidden="true">↗</span><div><strong>Picks & lines</strong><small>Browse the collected market board</small></div></a><a href="#players"><span aria-hidden="true">⌁</span><div><strong>Player explorer</strong><small>History, volume and matchup context</small></div></a><a href="#parlays"><span aria-hidden="true">＋</span><div><strong>Ticket builder</strong><small>Make a draft from the lines you find</small></div></a><a href="#record"><span aria-hidden="true">✓</span><div><strong>Track record</strong><small>Original picks, outcomes and returns</small></div></a></nav>${footballPreview(state, now)}<div class="sports-coverage-note"><strong>Know what’s covered.</strong><p>NFL and college football have researched picks and records. The line board contains sourced observations, not every sportsbook market. NBA and MLB currently have schedules and scores.</p><a href="#research">Latest research & takeaways →</a></div>${['MLB', 'NBA'].map(league => leaguePanel(league, snapshot?.leagues?.[league], now, true)).join('')}`;
  }
  function leagueHTML(league, snapshot, now = Date.now(), date = 'all') {
    const dates = [...new Set((snapshot?.games || []).map(g => g.date || dateKey(g.kickoff)))].filter(Boolean).sort();
    return `<div class="sport-page-intro"><div><p class="eyebrow">${escape(league)} · SCORES & SCHEDULES</p><h2>${league === 'MLB' ? 'Every inning has a story.' : 'Follow the next tip-off.'}</h2><p>Game times, score snapshots and direct game details. Research, props and picks will arrive separately.</p></div><span class="coverage-pill">Scoreboard coverage</span></div>${dates.length ? `<div class="sports-date-filters" role="group" aria-label="Scoreboard date"><button type="button" data-sports-date="all" aria-pressed="${date === 'all'}">All dates</button>${dates.map(d => `<button type="button" data-sports-date="${escape(d)}" aria-pressed="${date === d}">${d === dateKey(now) ? 'Today' : time(d + 'T12:00:00Z', { weekday: 'short' })}</button>`).join('')}</div>` : ''}${leaguePanel(league, snapshot, now, false, date)}<div class="sports-return"><a href="#sports">← Back to all sports</a><a href="#props">Explore football picks →</a></div>`;
  }
  function syncNavigation(league = 'NFL', recordLeague = 'All') {
    if (typeof document === 'undefined') return;
    const route = typeof location === 'undefined' ? '' : location.hash, sports = matches(route), results = route === '#record', players = route === '#players' || route.startsWith('#player/'), active = results ? (recordLeague === 'All' ? 'all' : recordLeague) : players ? (route.startsWith('#player/') ? route.split('/')[1] : 'all') : route.startsWith('#sport/') ? route.slice(7) : sports ? 'all' : league;
    document.body.dataset.activeSport = active;
    document.body.dataset.pageView = route === '#props' ? 'props' : players ? 'players' : route === '#parlays' ? 'parlays' : '';
    document.querySelectorAll('[data-sport]').forEach(a => { const selected = a.dataset.sport === active; a.classList.toggle('selected', selected); selected ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
    document.querySelectorAll('[data-league]').forEach(button => { const selected = button.dataset.league === active; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
    const sections = document.querySelector('.sections'); if (sections) sections.hidden = sports;
    const week = document.querySelector('.week-label'); if (week) week.hidden = sports || results || players;
    const text = results ? ['RESULTS', 'Results', 'Picks, score accuracy and performance by league.'] : players ? ['RESEARCH', 'Player research', 'Explore the players, markets and data we follow.'] : route === '#parlays' ? ['TICKET LAB', 'Your ticket, your call.', 'Explore published parlays and build a personal draft.'] : route === '#props' ? ['LINE BOARD', `${names[league]} picks & lines`, 'Find a line. Open the research. Build your draft.'] : active === 'all' ? ['KEENROUDY SPORTS', 'Today’s board', 'Games, picks and the latest research.'] : active === 'NBA' ? ['BASKETBALL', 'NBA scoreboard', 'Game times, scores and the upcoming schedule.'] : active === 'MLB' ? ['BASEBALL', 'MLB scoreboard', 'Game times, scores and the upcoming schedule.'] : ['FOOTBALL', `${names[league]} board`, 'Picks, matchup research and season results.'];
    ['hero-eyebrow', 'hero-title', 'hero-description'].forEach((id, i) => { const element = document.getElementById(id); if (element) element.textContent = text[i]; });
  }
  async function load() {
    if (!request) request = (async () => { try { const response = await fetch(`data/sports.json?refresh=${Date.now()}`, { cache: 'no-store' }); if (!response.ok) throw new Error('Unavailable'); data = await response.json(); } catch (_) { data = null; } return data; })();
    return request;
  }
  function render({ state, now = Date.now() }) {
    const league = /^#sport\/(NBA|MLB)$/.test(location.hash) ? location.hash.slice(7) : null;
    if (league !== currentLeague) { selectedDate = 'all'; currentLeague = league; }
    syncNavigation(state.league);
    const notice = document.getElementById('notice');
    const relevant = league ? [data?.leagues?.[league]] : ['NBA', 'MLB'].map(x => data?.leagues?.[x]);
    const warning = relevant.some(value => freshness(value, now).warning);
    notice.classList.toggle('warn', warning);
    notice.textContent = warning ? 'Some score sources are delayed or incomplete. Saved snapshots are labeled below; use the source links for the latest status.' : 'Score snapshots, not a live feed. Football picks have their own quote times and price limits.';
    const checked = relevant.map(x => x?.lastSuccessfulAt).filter(validTime).sort();
    document.getElementById('freshness').textContent = checked.length ? `Scoreboard checked ${stamp(checked[0])}` : 'Scoreboard source unavailable';
    const content = document.getElementById('content');
    content.innerHTML = league ? leagueHTML(league, data?.leagues?.[league], now, selectedDate) : homeHTML(state, data, now);
    content.querySelectorAll('[data-sports-date]').forEach(button => button.addEventListener('click', () => { selectedDate = button.dataset.sportsDate; render({ state }); }));
  }
  return { matches, freshness, scoreCard, latestFavorite, homeHTML, leagueHTML, syncNavigation, load, render };
});

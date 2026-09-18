/* KeenRoudy Sports - the board.
   One payload, four views, no framework. Every number here comes from
   site/data/next/board.json, which is built from the same files the old site
   uses. Nothing is computed in the browser that the pipeline did not record. */

(() => {
  'use strict';

  const state = { data: null, league: 'NFL', scope: 'open', query: '', error: null };
  const $ = sel => document.querySelector(sel);
  const esc = value => String(value ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- formatting ---------- */

  const odds = value => value == null ? '—' : (value > 0 ? '+' + value : String(value));
  const signed = value => value == null ? '—' : (value > 0 ? '+' + value : String(value));

  const when = iso => {
    if (!iso) return '';
    const date = new Date(iso);
    if (isNaN(date)) return '';
    return date.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: 'America/New_York',
    }) + ' ET';
  };

  const whenShort = iso => {
    if (!iso) return '';
    const date = new Date(iso);
    if (isNaN(date)) return '';
    return date.toLocaleString('en-US', {
      weekday: 'short', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
    }).replace(',', '');
  };

  const ago = iso => {
    if (!iso) return 'time not recorded';
    const mins = Math.round((Date.now() - new Date(iso)) / 60000);
    if (isNaN(mins)) return 'time not recorded';
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    const days = Math.round(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  };

  const STATE_LABEL = {
    open: 'Open', stale: 'Recheck', closed: 'Settled',
    unpriced: 'No price', reference: 'Reference',
  };
  const STATE_RANK = { open: 0, reference: 1, stale: 2, unpriced: 3, closed: 4 };

  const icon = path =>
    `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

  const ICONS = {
    today: '<path d="M3 12l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    board: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>',
    games: '<ellipse cx="12" cy="12" rx="9" ry="6"/><path d="M8 12h8"/>',
    record: '<path d="M4 19V10"/><path d="M10 19V5"/><path d="M16 19v-6"/><path d="M22 19H2"/>',
  };

  /* ---------- selectors over the payload ---------- */

  const inLeague = row => state.league === 'ALL' || row.league === state.league;
  const games = () => (state.data.games || []).filter(inLeague);
  const lines = () => (state.data.lines || []).filter(inLeague);
  const picks = () => (state.data.picks || []).filter(inLeague);
  const gameById = id => (state.data.games || []).find(g => g.id === id);

  const upcoming = () => games()
    .filter(g => !g.completed && g.state === 'pre')
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));

  /* Today is this slate, not the whole nine-day payload. Without this the page
     mixes next week's games in and two different Sundays look identical. */
  const thisSlate = () => {
    const rows = upcoming();
    if (!rows.length) return rows;
    const first = new Date(rows[0].kickoff);
    const cutoff = new Date(first.getTime() + 1000 * 60 * 60 * 72);
    return rows.filter(g => new Date(g.kickoff) <= cutoff);
  };

  const livePicks = () => picks().filter(p => !p.result);

  /* Games where our number disagrees most with the book's total. Both numbers
     are recorded; the disagreement is just their difference. */
  const disagreements = (limit = 6) => thisSlate()
    .filter(g => g.totalEdge != null && Math.abs(g.totalEdge) >= 3)
    .sort((a, b) => Math.abs(b.totalEdge) - Math.abs(a.totalEdge))
    .slice(0, limit);

  const movers = (limit = 5) => thisSlate()
    .filter(g => g.market && g.market.spreadMove != null && Math.abs(g.market.spreadMove) >= 1)
    .sort((a, b) => Math.abs(b.market.spreadMove) - Math.abs(a.market.spreadMove))
    .slice(0, limit);

  /* ---------- shared fragments ---------- */

  const statePill = row =>
    `<span class="pill pill-${row.state}">${STATE_LABEL[row.state] || row.state}</span>`;

  const teamRow = (team, score) => `
    <div class="game-team">
      <span class="game-chip" style="background:${esc(team.color)}"></span>
      <span>${esc(team.abbr || '—')}</span>
      ${score != null ? `<span class="score" style="margin-left:auto">${esc(score)}</span>` : ''}
    </div>`;

  const lineRow = row => {
    const name = row.player || row.title || 'Line';
    const market = row.player
      ? `${row.direction ? esc(row.direction.toUpperCase()) + ' ' : ''}${row.line ?? ''} ${esc(row.market || '')}`.trim()
      : '';
    const move = row.move != null && row.move !== 0
      ? `<span class="move ${row.move > 0 ? 'move-up' : 'move-down'}">${signed(row.move)}</span>` : '';
    return `
      <button class="row" type="button" data-line="${esc(row.id)}">
        <span class="row-rail" style="background:${esc(row.color)}"></span>
        <span class="row-main">
          <span class="row-top">
            <span class="row-name">${esc(name)}</span>
            ${row.position ? `<span class="row-meta">${esc(row.position)}</span>` : ''}
            ${row.ours ? '<span class="pill pill-ours">Our pick</span>' : ''}
            ${row.state !== 'open' ? statePill(row) : ''}
            ${move}
          </span>
          ${market ? `<span class="row-market">${market}</span>` : ''}
          <span class="row-meta">${esc(whenShort(row.kickoff))}${row.observedAt ? ' · seen ' + esc(ago(row.observedAt)) : ''}</span>
        </span>
        <span class="row-price">
          <span class="row-odds num">${odds(row.odds)}</span>
          <span class="row-book">${esc(row.book || 'No book')}</span>
        </span>
      </button>`;
  };

  /* ---------- views ---------- */

  function viewToday() {
    const open = lines().filter(l => l.state === 'open');
    const ours = livePicks();
    const gaps = disagreements();
    const moved = movers();
    const slate = thisSlate();
    const next = slate[0];

    return `
      <div class="page-head">
        <h1>${next ? esc(new Date(next.kickoff).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' })) : 'Today'}</h1>
        <p>${slate.length} games on this slate · ${open.length} open lines · ${gaps.length} where we disagree by 3+</p>
      </div>

      <div class="two-col">
        <div>
          <div class="section">
            <div class="section-head"><p class="eyebrow">Our picks</p>
              <a href="#record">Record →</a></div>
            ${ours.length ? ours.map(p => lineRow({
              id: 'pick-' + p.id, player: p.player || p.title, position: p.position,
              direction: p.direction, line: p.line, market: p.kind === 'parlays' ? 'parlay' : '',
              odds: p.odds, book: p.book, color: p.color, kickoff: p.kickoff,
              observedAt: p.quotedAt, state: 'open', ours: true,
            })).join('') : `
              <div class="empty">
                <h3>No live picks right now</h3>
                <p>Nothing has cleared the bar for this slate yet. Watch candidates are on the board, and they are not bets.</p>
                <a class="btn" href="#board">Open the board</a>
              </div>`}
          </div>

          <div class="section">
            <div class="section-head"><p class="eyebrow">Where we disagree with the book</p>
              <a href="#games">All games →</a></div>
            ${gaps.length ? `<div class="card">${gaps.map(gameRow).join('')}</div>` : `
              <div class="empty"><h3>No big gaps</h3>
                <p>Our total is within 3 points of the book on every upcoming game. That usually means the market and the model agree, not that there is nothing to bet.</p></div>`}
          </div>

          ${moved.length ? `
          <div class="section">
            <div class="section-head"><p class="eyebrow">Biggest line moves</p></div>
            <div class="card">${moved.map(g => `
              <a class="game-row" href="#game/${esc(g.id)}">
                <span class="game-teams">${teamRow(g.away)}${teamRow(g.home)}</span>
                <span class="game-mid">
                  <b>${esc(g.market.spreadOpen ?? '—')}</b> → <b>${esc(g.market.spread ?? '—')}</b><br>
                  ${esc(whenShort(g.kickoff))}
                </span>
                <span class="game-edge">
                  <span class="game-edge-num num ${Math.abs(g.market.spreadMove) >= 2 ? 'move-up' : ''}"
                    style="color:${Math.abs(g.market.spreadMove) >= 2 ? 'var(--amber)' : 'var(--dim)'}">${signed(g.market.spreadMove)}</span>
                  <span class="game-edge-label">Since open</span>
                </span>
              </a>`).join('')}</div>
          </div>` : ''}
        </div>

        <div>
          <div class="section">
            <div class="section-head"><p class="eyebrow">The record</p><a href="#record">Details →</a></div>
            ${recordSummary(true)}
          </div>
        </div>
      </div>`;
  }

  function gameRow(g) {
    const edge = g.totalEdge;
    const tone = edge == null ? 'var(--dim)'
      : Math.abs(edge) >= 4 ? 'var(--mint)' : Math.abs(edge) >= 3 ? '#a8e6c4' : 'var(--dim)';
    return `
      <a class="game-row" href="#game/${esc(g.id)}">
        <span class="game-teams">${teamRow(g.away, g.away.score)}${teamRow(g.home, g.home.score)}</span>
        <span class="game-mid">
          ${g.model ? `<b>${esc(g.model.away)}–${esc(g.model.home)}</b>` : 'no model'}${g.model && g.model.total != null && g.market && g.market.total != null
            ? ` &nbsp;our <b>${esc(g.model.total)}</b> / book <b>${esc(g.market.total)}</b>` : ''}<br>
          ${esc(whenShort(g.kickoff))}${g.market && g.market.spread != null ? ` · ${esc(g.market.spread)}` : ''}
        </span>
        <span class="game-edge">
          <span class="game-edge-num num" style="color:${tone}">${edge == null ? '—' : signed(edge)}</span>
          <span class="game-edge-label">${edge == null ? '' : edge > 0 ? 'Over lean' : 'Under lean'}</span>
        </span>
      </a>`;
  }

  function viewBoard() {
    const all = lines();
    const counts = {
      open: all.filter(l => l.state === 'open').length,
      ours: livePicks().length,
      closed: all.filter(l => l.state === 'closed').length,
    };
    const query = state.query.trim().toLowerCase();
    let shown = all.filter(l => {
      if (state.scope === 'open') return l.state === 'open' || l.state === 'reference';
      if (state.scope === 'settled') return l.state === 'closed';
      return true;
    });
    if (query) {
      shown = shown.filter(l => `${l.player || ''} ${l.title || ''} ${l.market || ''}`
        .toLowerCase().includes(query));
    }
    shown.sort((a, b) => (STATE_RANK[a.state] - STATE_RANK[b.state])
      || (new Date(a.kickoff) - new Date(b.kickoff))
      || String(a.player || a.title).localeCompare(String(b.player || b.title)));

    return `
      <div class="page-head">
        <h1>The board</h1>
        <p>${counts.open} open · ${counts.ours} of ours · ${counts.closed} settled</p>
      </div>
      <div class="filters">
        <button class="chip" data-scope="open" aria-pressed="${state.scope === 'open'}">Open · ${counts.open}</button>
        <button class="chip" data-scope="all" aria-pressed="${state.scope === 'all'}">Everything</button>
        <button class="chip" data-scope="settled" aria-pressed="${state.scope === 'settled'}">Settled · ${counts.closed}</button>
      </div>
      <input class="search" type="search" placeholder="Player, team or market"
        value="${esc(state.query)}" aria-label="Search lines">
      ${shown.length ? `<div class="card"><div class="rows">${shown.slice(0, 260).map(lineRow).join('')}</div></div>`
        : `<div class="empty">
             <h3>${query ? 'Nothing matches that' : 'Nothing open right now'}</h3>
             <p>${query ? 'Try a different player or market.'
               : `${counts.closed} lines have already kicked off. They stay in the record, out of the way.`}</p>
             ${query ? '' : '<button class="btn" data-scope="settled">Show settled</button>'}
           </div>`}
      ${shown.length > 260 ? `<p class="row-meta" style="margin-top:10px">Showing the first 260 of ${shown.length}. Search to narrow.</p>` : ''}`;
  }

  function viewGames() {
    const list = games().sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    const groups = new Map();
    for (const g of list) {
      const day = new Date(g.kickoff).toLocaleDateString('en-US',
        { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(g);
    }
    return `
      <div class="page-head"><h1>Games</h1><p>${list.length} games, newest model call against the book's number.</p></div>
      ${[...groups].map(([day, rows]) => `
        <div class="section">
          <div class="section-head"><p class="eyebrow">${esc(day)}</p></div>
          <div class="card">${rows.map(gameRow).join('')}</div>
        </div>`).join('')}`;
  }

  function viewGame(id) {
    const g = gameById(id);
    if (!g) return `<div class="page-head"><h1>Game not found</h1><p>It may have dropped off the board.</p></div>`;
    const mine = (state.data.lines || []).filter(l => l.gameId === id);
    const open = mine.filter(l => l.state === 'open' || l.state === 'reference');
    const rest = mine.filter(l => l.state !== 'open' && l.state !== 'reference');
    const m = g.market || {};
    return `
      <div class="page-head">
        <a href="#games" style="font-size:12px;font-weight:600;color:var(--faint)">← Games</a>
        <h1 style="margin-top:8px">${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</h1>
        <p>${esc(when(g.kickoff))}${g.completed ? ' · Final' : ''}</p>
      </div>
      <div class="stats">
        <div class="stat"><div class="stat-label">Our score</div>
          <div class="stat-value num">${g.model ? esc(g.model.away) + '–' + esc(g.model.home) : '—'}</div>
          <div class="stat-note">${g.model ? esc(g.model.version || 'model') : 'no forecast'}</div></div>
        <div class="stat"><div class="stat-label">Our total</div>
          <div class="stat-value num">${g.model && g.model.total != null ? esc(g.model.total) : '—'}</div>
          <div class="stat-note">${g.totalEdge != null ? signed(g.totalEdge) + ' vs book' : ''}</div></div>
        <div class="stat"><div class="stat-label">Book total</div>
          <div class="stat-value num">${m.total != null ? esc(m.total) : '—'}</div>
          <div class="stat-note">${esc(m.book || '')}</div></div>
        <div class="stat"><div class="stat-label">Spread</div>
          <div class="stat-value num">${esc(m.spread ?? '—')}</div>
          <div class="stat-note">${m.spreadMove != null && m.spreadMove !== 0
            ? `from ${esc(m.spreadOpen)} (${signed(m.spreadMove)})` : 'no move since open'}</div></div>
      </div>
      ${g.model && g.model.sparse ? `<div class="notice" style="margin-top:12px">
        <strong>Thin history.</strong> One of these teams has fewer than six completed games in the model, so this forecast is weaker than the number suggests.</div>` : ''}
      <div class="section">
        <div class="section-head"><p class="eyebrow">Lines in this game</p>
          <span class="row-meta">${open.length} open</span></div>
        ${open.length ? `<div class="card"><div class="rows">${open.map(lineRow).join('')}</div></div>`
          : '<div class="empty"><h3>No open lines</h3><p>Nothing priced and current for this game yet.</p></div>'}
        ${rest.length ? `<details style="margin-top:10px"><summary style="font-size:12px;color:var(--dim);cursor:pointer">${rest.length} settled or expired</summary>
          <div class="card" style="margin-top:8px"><div class="rows">${rest.map(lineRow).join('')}</div></div></details>` : ''}
      </div>`;
  }

  function recordSummary(compact) {
    const r = state.data.record || {};
    const shown = picks().filter(p => p.result);
    const wins = shown.filter(p => p.result === 'win').length;
    const losses = shown.filter(p => p.result === 'loss').length;
    const pushes = shown.filter(p => p.result === 'push').length;
    const graded = wins + losses;
    const priced = shown.filter(p => p.odds && ['win', 'loss', 'push'].includes(p.result));
    let units = 0;
    for (const p of priced) {
      if (p.result === 'win') units += p.odds > 0 ? p.odds / 100 : 100 / Math.abs(p.odds);
      else if (p.result === 'loss') units -= 1;
    }
    const min = r.roiMinimum || 10;
    const enough = priced.length >= min;
    const bar = shown.slice(0, 24).map(p =>
      `<span class="${p.result === 'win' ? 'w' : p.result === 'loss' ? 'l' : 'p'}"></span>`).join('');

    return `
      <div class="card" style="padding:16px">
        <div style="text-align:center">
          <div class="num" style="font-size:${compact ? 40 : 56}px;line-height:1">${wins}<span style="color:var(--faint)">–</span>${losses}<span style="color:var(--faint)">–</span>${pushes}</div>
          <div style="margin-top:7px;font-size:13px;color:var(--dim)">${shown.length} settled · ${graded ? (100 * wins / graded).toFixed(1) : '—'}% hit rate</div>
        </div>
        ${bar ? `<div class="bar">${bar}</div>` : ''}
        <div class="stats" style="margin-top:12px">
          <div class="stat"><div class="stat-label">Units</div>
            <div class="stat-value num" style="color:${units > 0 ? 'var(--green)' : units < 0 ? 'var(--rose)' : 'var(--text)'}">${priced.length ? signed(units.toFixed(2)) + 'u' : '—'}</div>
            <div class="stat-note">on ${priced.length} priced</div></div>
          <div class="stat"><div class="stat-label">ROI</div>
            <div class="stat-value num">${enough ? (100 * units / priced.length).toFixed(1) + '%' : '—'}</div>
            <div class="stat-note">${enough ? 'priced picks only' : `needs ${min}`}</div></div>
        </div>
        ${!enough && priced.length ? `<div class="notice" style="margin-top:12px">
          A return over ${priced.length} priced pick${priced.length === 1 ? '' : 's'} is noise, not a track record, so no ROI is shown.
          ${r.unpricedSettled ? `${r.unpricedSettled} settled picks have no recorded price and are excluded from returns entirely.` : ''}
          <div class="meter"><div class="meter-track"><div class="meter-fill" style="width:${Math.min(100, 100 * priced.length / min)}%"></div></div>
            <div class="meter-text">${priced.length} / ${min}</div></div>
        </div>` : ''}
      </div>`;
  }

  function viewRecord() {
    const settled = picks().filter(p => p.result)
      .sort((a, b) => String(b.settledAt || b.publishedAt).localeCompare(String(a.settledAt || a.publishedAt)));
    return `
      <div class="page-head"><h1>The record</h1><p>Every published pick at one unit, win or lose.</p></div>
      ${recordSummary(false)}
      <div class="section">
        <div class="section-head"><p class="eyebrow">Every settled pick</p></div>
        <div class="card"><div class="rows">${settled.map(p => `
          <button class="row" type="button" data-pick="${esc(p.id)}">
            <span class="row-rail" style="background:${p.result === 'win' ? 'var(--green)' : p.result === 'loss' ? 'var(--rose)' : 'var(--faint)'}"></span>
            <span class="row-main">
              <span class="row-top">
                <span class="row-name">${esc(p.title || p.player)}</span>
                ${!p.odds ? '<span class="pill pill-unpriced">No price</span>' : ''}
                ${p.historicalImport ? '<span class="pill pill-reference">Import</span>' : ''}
              </span>
              <span class="row-market">${esc(p.actual || 'settled')}</span>
              <span class="row-meta">${p.odds ? esc(p.book || 'book unavailable') + ' ' + odds(p.odds) + ' · ' : ''}1u risk</span>
            </span>
            <span class="row-price">
              <span class="row-odds num" style="font-size:13px;color:${p.result === 'win' ? 'var(--green)' : p.result === 'loss' ? 'var(--rose)' : 'var(--dim)'}">${esc(String(p.result).toUpperCase())}</span>
              <span class="row-book">${p.odds ? (p.result === 'win' ? '+' + (p.odds > 0 ? p.odds / 100 : 100 / Math.abs(p.odds)).toFixed(2)
                : p.result === 'loss' ? '-1.00' : '0.00') + 'u' : 'n/a'}</span>
            </span>
          </button>`).join('')}</div></div>
      </div>`;
  }

  /* ---------- detail dialog ---------- */

  function openDetail(html) {
    const dialog = $('#detail');
    dialog.innerHTML = `<div class="detail-inner">${html}</div>`;
    dialog.showModal();
  }

  function detailForPick(p) {
    return `
      <div class="detail-head">
        <div>
          <div class="row-top"><span class="pill pill-ours">Our pick</span>
            ${p.result ? `<span class="pill pill-${p.result === 'win' ? 'open' : 'stale'}">${esc(p.result)}</span>` : ''}</div>
          <h3 style="margin:7px 0 0;font-size:17px">${esc(p.title || p.player)}</h3>
          <p style="margin:4px 0 0;font-size:12px;color:var(--faint)">${esc(when(p.kickoff))}</p>
        </div>
        <button class="close" type="button" data-close aria-label="Close">×</button>
      </div>
      <div class="detail-body">
        <div class="kv">
          <div><span>Price</span><strong>${esc(p.book || 'No book')} ${odds(p.odds)}</strong></div>
          <div><span>Our number</span><strong>${p.projection ?? '—'}</strong></div>
          <div><span>Confidence</span><strong>${p.confidence != null ? p.confidence + '/10' : '—'}</strong></div>
          <div><span>Quoted</span><strong style="font-size:12px">${esc(ago(p.quotedAt))}</strong></div>
        </div>
        ${p.cutoff ? `<h4>Worst number we would take</h4><p>${esc(p.cutoff)}</p>` : ''}
        ${p.why ? `<h4>Why</h4><p>${esc(p.why)}</p>` : ''}
        ${p.risk ? `<h4>What could go wrong</h4><p>${esc(p.risk)}</p>` : ''}
        ${p.edge ? `<h4>Edge estimate</h4><p>${esc(p.edge)}</p>` : ''}
        ${p.actual ? `<h4>Result</h4><p>${esc(p.actual)}</p>` : ''}
        ${p.settlementReason ? `<p>${esc(p.settlementReason)}</p>` : ''}
        ${(p.sources || []).length ? `<h4>Sources</h4><div class="sources">${p.sources
          .filter(s => /^https:/.test(s))
          .map((s, i) => `<a href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(sourceName(s, i))} ↗</a>`)
          .join('')}</div>` : ''}
        <p style="margin-top:14px;font-size:11px;color:var(--faint)">Recorded at one unit. The original price is kept for grading even after it moves.</p>
      </div>`;
  }

  /* Name a source by its host, because "Source 1 … Source 16" tells you nothing. */
  function sourceName(url, index) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return host.split('.')[0].replace(/^\w/, c => c.toUpperCase());
    } catch (err) { return 'Source ' + (index + 1); }
  }

  function detailForLine(row) {
    return `
      <div class="detail-head">
        <div>
          <div class="row-top">${statePill(row)}</div>
          <h3 style="margin:7px 0 0;font-size:17px">${esc(row.player || row.title)}</h3>
          <p style="margin:4px 0 0;font-size:12px;color:var(--faint)">${esc(when(row.kickoff))}</p>
        </div>
        <button class="close" type="button" data-close aria-label="Close">×</button>
      </div>
      <div class="detail-body">
        <div class="kv">
          <div><span>Price</span><strong>${odds(row.odds)}</strong></div>
          <div><span>Book</span><strong style="font-size:13px">${esc(row.book || 'Unavailable')}</strong></div>
          <div><span>Market</span><strong style="font-size:13px">${esc(row.market || '—')}</strong></div>
          <div><span>Seen</span><strong style="font-size:12px">${esc(ago(row.observedAt))}</strong></div>
        </div>
        <h4>What this is</h4>
        <p>${row.state === 'open'
          ? 'A current quote we observed. Check the live price in your book before you act on it.'
          : row.state === 'closed' ? 'This game has started or finished. Kept for the record only.'
          : row.state === 'stale' ? 'The quote passed its recheck window. The number may have moved.'
          : row.state === 'unpriced' ? 'We have the number but no recorded price, so no return can be calculated from it.'
          : 'A reference observation, not a verified current sportsbook offer.'}</p>
        ${row.source && /^https:/.test(row.source)
          ? `<h4>Source</h4><div class="sources"><a href="${esc(row.source)}" target="_blank" rel="noopener noreferrer">${esc(sourceName(row.source, 0))} ↗</a></div>` : ''}
        <p style="margin-top:14px;font-size:11px;color:var(--faint)">Lines on this board are observations, not recommendations. Only rows marked “Our pick” are selections.</p>
      </div>`;
  }

  /* ---------- shell ---------- */

  function chrome(route) {
    const tab = (id, label) => `
      <a href="#${id}" ${route.startsWith(id) ? 'aria-current="page"' : ''}>
        ${icon(ICONS[id])}<span>${label}</span></a>`;
    return `
      <a class="skip" href="#main">Skip to content</a>
      <div class="top">
        <span class="mark" aria-hidden="true">KR</span>
        <span class="wordmark">KEENROUDY</span>
        <span class="top-right">
          <span class="leagues" role="group" aria-label="League">
            ${['NFL', 'CFB', 'ALL'].map(l =>
              `<button type="button" data-league="${l}" aria-pressed="${state.league === l}">${l === 'CFB' ? 'College' : l}</button>`).join('')}
          </span>
        </span>
      </div>
      <nav class="tabbar" aria-label="Sections">
        ${tab('today', 'Today')}${tab('board', 'Board')}${tab('games', 'Games')}${tab('record', 'Record')}
      </nav>`;
  }

  function render() {
    const hash = (location.hash || '#today').slice(1);
    const [route, param] = hash.split('/');
    if (state.error) {
      $('#app').innerHTML = `<main><div class="empty" style="margin-top:40px">
        <h3>Could not load the board</h3><p>${esc(state.error)}</p></div></main>`;
      return;
    }
    if (!state.data) return;

    const body =
      route === 'board' ? viewBoard() :
      route === 'games' ? viewGames() :
      route === 'game' ? viewGame(param) :
      route === 'record' ? viewRecord() :
      viewToday();

    const d = state.data;
    $('#app').innerHTML = `
      ${chrome(route === 'game' ? 'games' : route)}
      <main id="main">
        ${body}
        <footer>
          <strong>For entertainment only.</strong> Picks are opinions, not guarantees. You are responsible for your own bets and losses.<br>
          Every published play is tracked at one unit risked. Missing original prices mean no profit or ROI is claimed.<br>
          Scoreboard checked ${esc(ago(d.updatedAt))} · board built ${esc(ago(d.generatedAt))} · all times ET.
        </footer>
      </main>
      <dialog class="detail" id="detail"></dialog>`;
  }

  /* ---------- events ---------- */

  document.addEventListener('click', event => {
    const league = event.target.closest('[data-league]');
    if (league) { state.league = league.dataset.league; render(); return; }

    const scope = event.target.closest('[data-scope]');
    if (scope) { state.scope = scope.dataset.scope; render(); return; }

    if (event.target.closest('[data-close]')) { $('#detail').close(); return; }

    const lineButton = event.target.closest('[data-line]');
    if (lineButton) {
      const id = lineButton.dataset.line;
      if (id.startsWith('pick-')) {
        const pick = (state.data.picks || []).find(p => 'pick-' + p.id === id);
        if (pick) openDetail(detailForPick(pick));
      } else {
        const row = (state.data.lines || []).find(l => l.id === id);
        if (row) openDetail(detailForLine(row));
      }
      return;
    }

    const pickButton = event.target.closest('[data-pick]');
    if (pickButton) {
      const pick = (state.data.picks || []).find(p => p.id === pickButton.dataset.pick);
      if (pick) openDetail(detailForPick(pick));
    }
  });

  document.addEventListener('input', event => {
    if (event.target.matches('.search')) {
      state.query = event.target.value;
      const caret = event.target.selectionStart;
      render();
      const field = $('.search');
      if (field) { field.focus(); field.setSelectionRange(caret, caret); }
    }
  });

  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

  fetch('../data/next/board.json')
    .then(response => response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status)))
    .then(data => { state.data = data; render(); })
    .catch(error => { state.error = error.message; render(); });
})();

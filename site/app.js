'use strict';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (date, options={}) => new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',...options}).format(new Date(date));
const day = date => fmt(date,{year:'numeric',month:'2-digit',day:'2-digit'}).split('/').map((x,i,a)=>a[[2,0,1][i]]).join('-');
// Football slate weeks run Tuesday through Monday so Monday Night Football stays
// with the preceding Thursday/Sunday slate instead of starting a new week.
const weekOf = date => {const d = new Date(day(date)+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+5)%7));return d.toISOString().slice(0,10)};
const pretty = date => fmt(date,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const links = urls => `<div class="sources">${(urls||[]).filter(u=>/^https:\/\//.test(u)).map((u,i)=>`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">Source ${i+1} ↗</a>`).join('')}</div>`;
let state={league:localStorage.getItem('football-league')||'NFL',view:'home',week:weekOf(new Date()),query:'',filter:'all',propGame:'all',propPosition:'all',recordScope:'favorites',recordLeague:'All',recordWeek:'total',slate:null,forecasts:[],reports:[],history:null,parlaySelected:new Set(),parlayTarget:200};
if(!['NFL','CFB'].includes(state.league)) state.league='NFL';
const gameMap = () => new Map(state.slate.games.map(g=>[g.id,g]));
const games = () => state.slate.games.filter(g=>g.league===state.league && weekOf(g.kickoff)===state.week);
const original = g => state.forecasts.find(p=>p.gameId===g.id);
const marketPosition = p => p.position || p.playerPosition || 'Other';
const footballWeek = g => g.league==='CFB'&&g.week===1&&new Date(g.kickoff)<new Date(`${g.season}-09-01T00:00:00Z`)?0:g.week;
function weekLabel(w){
  const matching=state.slate.games.filter(g=>g.league===state.league&&weekOf(g.kickoff)===w), counts=new Map();
  matching.forEach(g=>counts.set(footballWeek(g),(counts.get(footballWeek(g))||0)+1));
  const number=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]??'—', end=new Date(w+'T12:00:00Z'); end.setUTCDate(end.getUTCDate()+6);
  const startText=fmt(w+'T12:00:00Z',{month:'short',day:'numeric'}), endText=fmt(end,{month:'short',day:'numeric'});
  return `Week ${number} (${startText}–${endText})`;
}
function forecast(g){return FootballAnalytics.score(g,state.forecasts,state.reports)}
function setupWeeks(){
  const options=[...new Set(state.slate.games.filter(g=>g.league===state.league).map(g=>weekOf(g.kickoff)))].sort().reverse();
  if(!options.includes(state.week)) state.week=options.find(w=>w<=weekOf(new Date()))||options[0];
  $('#week').innerHTML=options.map(w=>`<option value="${w}" ${w===state.week?'selected':''}>${esc(weekLabel(w))}</option>`).join('');
}
function card(g){
  const p=forecast(g),final=g.completed, underway=g.state!=='pre'||new Date(g.kickoff)<=new Date();
  const scores=final?g:p;
  const label=final?'Final':underway?'Started · forecast locked':p?.type==='historical'?'Historical call':p?.type==='analyst'?'Analyst forecast':'Baseline forecast';
  const side=s=>`<div class="team"><span class="abbr">${esc(g[s].abbreviation)}</span><span class="team-name">${esc(g[s].short)}</span><span class="score">${final?esc(g[s].score):esc(scores?.[s]??'—')}</span></div>`;
  let detail=p?`<p>${esc(p.why)}</p><p>${p.type==='analyst'?`Reviewed score forecast · Confidence ${esc(p.confidence)}/10`:p.type==='historical'?'Historical import':'Early score forecast · research pending'}</p><p>${p.type==='historical'?'Imported':'Recorded'} ${pretty(p.publishedAt)} ET</p>${p.type==='historical'?'<p>Original screenshot supplied after the week; exact original posting time is not verified and this call is excluded from model grading.</p>':''}${links(p.sources)}`:'<p>No forecast was recorded before kickoff. This game is excluded from the prediction record.</p>';
  if(p&&final) detail=`<p>Pregame call: ${esc(g.away.abbreviation)} ${p.away} · ${esc(g.home.abbreviation)} ${p.home}</p>`+detail;
  if(p?.type==='analyst'&&original(g))detail+=`<p>Original baseline: ${original(g).away}–${original(g).home}. Revisions remain in the public archive.</p>`;
  const m=g.market;
  const validMarket=m?.total!=null && m.spread!=null && Number.isFinite(Number(m.spread));
  const market=validMarket?`<div class="market"><div class="market-head"><strong>${esc(m.provider||'Market')} via ESPN</strong><span>${underway?'Post-start feed':'Game lines'}</span></div><dl><dt>Home spread</dt><dd>${esc(g.home.abbreviation)} ${esc(m.spread)} <span>(${esc(m.spreadOdds??'—')})</span></dd><dt>Total points</dt><dd>${esc(m.total)}</dd><dt>Over / under prices</dt><dd>${esc(m.overOdds??'—')} / ${esc(m.underOdds??'—')}</dd></dl>${!underway&&p?`<div class="comparison"><dl><dt>Market-implied score</dt><dd>${esc(g.away.abbreviation)} ${((Number(m.total)+Number(m.spread))/2).toFixed(1)}<br>${esc(g.home.abbreviation)} ${((Number(m.total)-Number(m.spread))/2).toFixed(1)}</dd><dt>Our total vs. market</dt><dd>${p.home+p.away-Number(m.total)>0?'+':''}${(p.home+p.away-Number(m.total)).toFixed(1)} pts</dd></dl><small>Model difference, not a proven betting edge.</small></div>`:''}${m.spreadOpen||m.totalOpen?`<small>Opening spread: ${esc(m.spreadOpen??'—')} · total: ${esc(String(m.totalOpen??'—').replace(/^[ou]/,''))}</small>`:''}<small>Retrieved ${pretty(state.slate.updatedAt)} ET. ${underway?'Not a verified closing line.':'Source quote time unavailable.'}</small>${!underway&&/^https:\/\//.test(m.link||'')?`<a href="${esc(m.link)}" target="_blank" rel="noopener noreferrer">View game at ${esc(m.provider)} ↗</a>`:''}</div>`:'';
  const related=FootballRecords.latest(state.reports).filter(x=>(x.gameIds||[]).includes(g.id));
  const insight=related.length?Object.entries(related.reduce((o,x)=>{(o[marketPosition(x)]??=[]).push(x);return o},{})).map(([pos,items])=>`<li><strong>${esc(pos)}</strong><ul>${items.map(x=>`<li><strong>${esc(x.title)}</strong> · ${FootballRecords.favorite(x)?'Daily favorite · ':''}${x.kind==='riskyProps'?'Risky line · ':''}${esc(x.result||pickStatus(x))}${x.why?`<br>${esc(x.why)}`:''}${x.risk?`<br>Risk: ${esc(x.risk)}`:''}</li>`).join('')}</ul></li>`).join(''):'<li>No reviewed player prop for this game yet.</li>';
  const takeaways=(p?.takeaways||p?.takeaway||p?.marketTakeaways||[]); const takeawayList=(Array.isArray(takeaways)?takeaways:[takeaways]).filter(Boolean).map(x=>`<li>${esc(x)}</li>`).join('');
  const snapshots=(g.marketHistory||[]).filter(x=>x.phase==='pregame'&&x.provider===m?.provider);
  const movement=snapshots.length>1?`<p class="movement">Observed ${esc(m.provider)} movement: home spread ${esc(snapshots[0].spread)} → ${esc(snapshots.at(-1).spread)}, total ${esc(snapshots[0].total)} → ${esc(snapshots.at(-1).total)}. Snapshots retrieved ${pretty(snapshots[0].retrievedAt)} and ${pretty(snapshots.at(-1).retrievedAt)} ET; source quote times unavailable.</p>`:'';
  return `<article class="game" id="${esc(g.id)}"><div class="game-top"><span>${g.timeValid?fmt(g.kickoff,{hour:'numeric',minute:'2-digit'})+' ET':'Time TBD'}</span><span class="tag ${final?'final':''}">${label}</span></div>${side('away')}${side('home')}<div class="game-bottom"><span>${final?'Provider-reported final':p?`Projected total ${p.home+p.away}`:'Forecast pending'}</span><span>${g.neutral?'Neutral site':'@ '+esc(g.home.abbreviation)}</span></div><a class="game-open" href="#game/${encodeURIComponent(g.id)}">Open game breakdown →</a></article>`;
}
function workloadPanel(form){
  const rows=(form?.games||[]).filter(g=>g.workload&&Object.keys(g.workload).length);
  if(!rows.length)return '<p class="record-note">Player workload verification pending.</p>';
  const labels={touches:'Touches',rushingAttempts:'Carries',receptions:'Catches',receivingTargets:'Targets',rushingYards:'Rush yds',receivingYards:'Rec yds',passingAttempts:'Pass att',completions:'Completions',passingYards:'Pass yds'};
  const keys=Object.keys(labels).filter(k=>rows.some(g=>g.workload[k]!=null));
  const avg=(k,n)=>{const v=rows.slice(-n).map(g=>g.workload[k]);return v.length===n&&v.every(x=>Number.isFinite(x))?(v.reduce((a,b)=>a+b,0)/n).toFixed(1):'—'};
  return `<details class="stat-log"><summary>Player workload · last game / 5 / 10</summary><div class="record-table"><table><thead><tr><th>Stat</th><th>Last game</th><th>5-game avg</th><th>10-game avg</th></tr></thead><tbody>${keys.map(k=>`<tr><th>${labels[k]}</th><td>${esc(rows.at(-1).workload[k]??'—')}</td><td>${avg(k,5)}</td><td>${avg(k,10)}</td></tr>`).join('')}</tbody></table></div><small>Latest: ${esc(rows.at(-1).label)}. Touches = carries + receptions. Missing statistics stay blank; games and roles may differ.</small><p>Snap share, routes, red-zone and goal-line usage require separate verification; these box scores do not establish them.</p>${links([form.source])}</details>`;
}
function playerMovement(p){
  const g=(state.slate?.games||[]).find(g=>g.id===(p.gameId||(p.gameIds||[])[0]));
  const revisions=state.reports.flatMap(r=>[...(r.gameWatch||[]),...(r.props||[]),...(r.riskyProps||[])]).filter(x=>x.id===p.id);
  const observed=[...new Map([...revisions,p].flatMap(x=>x.marketSnapshots||[]).map(x=>[JSON.stringify(x),x])).values()];
  const snapshots=observed.filter(x=>g&&Number.isFinite(Date.parse(x.observedAt))&&Date.parse(x.observedAt)<Date.parse(g.kickoff)&&x.book&&x.market&&x.window&&x.direction&&Number.isFinite(x.line)&&/^https:\/\//.test(x.source||'')).sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt));
  if(!snapshots.length)return '<p class="record-note">Player-line movement: awaiting comparable pregame quotes.</p>';
  const groups=new Map();snapshots.forEach(x=>{const k=JSON.stringify([x.book,x.market,x.window,x.direction,x.quoteType||'sportsbook']);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x)});
  return `<details class="stat-log"><summary>Pregame player-line observations · ${snapshots.length}</summary>${[...groups.values()].map(xs=>`<h5>${esc(xs[0].book)} · ${esc(xs[0].market)} · ${esc(xs[0].window)} · ${esc(xs[0].direction)}</h5><p>${xs.length<2?'One observation; no verified movement yet.':'Observed sequence; first observed is not necessarily the opening line.'}</p><ul>${xs.map(x=>`<li>${esc(x.line)} · ${x.odds==null?'price unavailable':esc(x.odds>0?'+'+x.odds:x.odds)} · observed ${pretty(x.observedAt)} ET<br><small>${esc(x.quoteType||'sportsbook')} · ${esc(x.sourceTimeNote||'Source quote time unavailable')}</small>${links([x.source])}</li>`).join('')}</ul>`).join('')}<p><strong>Why it moved:</strong> ${p.movementExplanation?`${esc(p.movementExplanation.type)}: ${esc(p.movementExplanation.text)}`:'Unknown. No sourced cause established.'}</p>${links(p.movementExplanation?.sources)}<small>Observed pregame quotes only; no post-start quote is treated as a closing line. Different books and markets are kept separate.</small></details>`;
}
function earlyWatchCard(w){
  const g=gameMap().get(w.gameId), started=!g||g.completed||g.state!=='pre'||new Date(g.kickoff)<=new Date();
  const due=w.nextReviewAt&&new Date(w.nextReviewAt)<=new Date();
  const saved=state.history?.watches?.[w.id];
  const form=saved?.gameId===w.gameId&&saved?.marketTitle===w.marketTitle?saved.recentForm:null;
  return `<article class="early-watch"><span class="tag">${started?'Archived early look':due?'Early look · review due':'Early look · not an official bet'}</span><h4><a href="#game/${esc(w.gameId)}">${esc(w.title)} →</a></h4><p class="early-number">${esc(w.lineLabel||'Waiting for a player line')}</p><small>${esc(w.quoteNote||'No verified live price')}</small><p><strong>Why it interests us:</strong> ${esc(w.why)}</p>${w.player?workloadPanel(form):''}${form?`<details><summary>Recent results at reference line ${esc(form.line)}</summary>${formChart(form)}<p>Historical results at today’s reference threshold; not a win probability. ${form.last5?`Last 5: ${form.last5.hits}/${form.last5.sample}.`:'Last 5 unavailable.'} ${form.last10?`Last 10: ${form.last10.hits}/${form.last10.sample}.`:'Last 10 unavailable.'}</p></details>`:''}${w.player?playerMovement(w):''}<details><summary>Matchup, offensive line & decision checks</summary>${[['Defense matchup',w.defense],['Offensive-line health',w.lineHealth],['Blocking performance',w.lineSkill],['What could change our view',w.risk],['Before an official pick',w.needs]].filter(x=>x[1]).map(([label,value])=>`<p><strong>${label}:</strong> ${esc(value)}</p>`).join('')}${links(w.sources)}</details><small>Research ${pretty(w.publishedAt)} ET${w.nextReviewAt&&!started?` · Next review ${pretty(w.nextReviewAt)} ET`:''}. ${started?'Pregame research archived; not actionable.':'Article numbers are reference quotes; verify current line and price.'}</small></article>`;
}
function gameWatch(g){
  const reports=state.reports.filter(r=>r.league===g.league).sort((a,b)=>a.publishedAt.localeCompare(b.publishedAt));
  const entries=new Map();
  reports.forEach(r=>(r.gameWatch||[]).filter(w=>w.gameId===g.id).forEach(w=>entries.set(w.id,{...w,publishedAt:r.publishedAt})));
  return '<section class="game-watch"><h4>Lines we’re watching</h4>'+ (entries.size?[...entries.values()].map(w=>`<article><span class="tag">Research watch · not an official pick</span><h4>${esc(w.title)}</h4><p>${esc(w.why)}</p><p><strong>Before a pick:</strong> ${esc(w.needs)}</p><p>Recorded ${pretty(w.publishedAt)} ET · historical context; recheck current prices</p>${links(w.sources)}</article>`).join(''):'<p>No game-specific candidate has been researched yet. Available game lines above are market context, not recommended bets.</p>')+'</section>';
}
function gamePage(g){
  const p=forecast(g), m=g.market, started=g.completed||g.state!=='pre'||new Date(g.kickoff)<=new Date();
  const score=p?`${g.away.abbreviation} ${p.away} · ${g.home.abbreviation} ${p.home}`:'Forecast pending';
  const total=p?p.away+p.home:null, margin=p?p.home-p.away:null;
  const marketReady=m?.total!=null&&Number.isFinite(Number(m.spread));
  const totalGap=marketReady&&total!=null?total-Number(m.total):null;
  const totalDirection=totalGap==null?'—':totalGap>0?'Forecast above market total':totalGap<0?'Forecast below market total':'Forecast equals market total';
  const spreadGap=marketReady&&margin!=null?margin+Number(m.spread):null;
  const reports=state.reports.filter(r=>r.league===g.league).sort((a,b)=>a.publishedAt.localeCompare(b.publishedAt));
  const candidates=new Map(); reports.forEach(r=>(r.gameWatch||[]).filter(w=>w.gameId===g.id).forEach(w=>candidates.set(w.id,{...w,publishedAt:r.publishedAt})));
  const picks=FootballRecords.latest(state.reports).filter(x=>(x.gameIds||[]).includes(g.id)&&x.kind!=='parlays');
  const grouped=Object.entries(picks.reduce((a,x)=>{(a[marketPosition(x)]??=[]).push(x);return a},{}));
  const gameBets=FootballRecords.latest(state.reports).filter(p=>p.kind==='gamePicks'&&(p.gameIds||[]).includes(g.id));
  const pickBlocks=grouped.length?grouped.map(([pos,items])=>`<section class="position-group"><h3>${esc(pos)}</h3><div class="cards">${items.map(pickCard).join('')}</div></section>`).join(''):'<p>No verified official player props have been published for this game.</p>';
  const lastVs=picks.filter(x=>x.recentForm?.lastVsOpponent).map(x=>`<li><strong>${esc(x.title)}</strong> · ${esc(x.recentForm.lastVsOpponent.value)} ${esc(x.recentForm.stat||'')} · ${esc(x.recentForm.lastVsOpponent.date)}${links([x.recentForm.lastVsOpponent.source])}</li>`).join('');
  const meetings=state.slate.games.filter(x=>x.id!==g.id&&x.completed&&x.league===g.league&&new Date(x.kickoff)<new Date(g.kickoff)&&[x.home.id,x.away.id].includes(g.home.id)&&[x.home.id,x.away.id].includes(g.away.id)).sort((a,b)=>b.kickoff.localeCompare(a.kickoff)).slice(0,3);
  const meetingsBlock=meetings.length?meetings.map(x=>`<li>${fmt(x.kickoff,{month:'short',day:'numeric',year:'numeric'})}: ${esc(x.away.abbreviation)} ${esc(x.away.score)} · ${esc(x.home.abbreviation)} ${esc(x.home.score)}${links([x.source])}</li>`).join(''):'<li>No earlier meeting is available in the current public game feed.</li>';
  const contexts=state.history?.defenses?.[g.id]||{};
  const defensePanel=Object.keys(contexts).length?`<section class="game-panel"><h3>Last game against each defense · by position</h3><p>Actual positional box-score totals in the defense’s most recent game. These are single-game context, not a hit rate or a forecast; the opposing players and game script may differ.</p><div class="game-page-grid">${['away','home'].filter(side=>contexts[side]).map(side=>{const x=contexts[side],labels={passingYards:'passing yards',passingAttempts:'pass attempts',completions:'completions',rushingAttempts:'carries',rushingYards:'rushing yards',receptions:'receptions',receivingYards:'receiving yards'};return `<div><h4>${esc(g[side].name)} defense · ${esc(x.date)}</h4><p>Against ${esc(x.opponent)}</p><ul>${Object.entries(x.positions).map(([pos,stats])=>`<li><strong>${esc(pos)}</strong>: ${Object.entries(stats).map(([key,value])=>`${esc(value)} ${esc(labels[key]||key)}`).join(' · ')}</li>`).join('')}</ul>${links([x.source])}</div>`}).join('')}</div><small>Data checked ${pretty(state.history.updatedAt)} ET · ESPN box scores</small></section>`:'<section class="game-panel"><h3>Last game against each defense · by position</h3><p>Position-level box-score verification is pending for this matchup.</p></section>';
  const snapshots=(g.marketHistory||[]).filter(x=>x.phase==='pregame');
  const movement=snapshots.length>1?`<p>Observed pregame snapshots: spread ${esc(snapshots[0].spread)} → ${esc(snapshots.at(-1).spread)}; total ${esc(snapshots[0].total)} → ${esc(snapshots.at(-1).total)}. Retrieved ${pretty(snapshots[0].retrievedAt)} and ${pretty(snapshots.at(-1).retrievedAt)} ET. Source quote times unavailable.</p>`:'<p>Comparable pregame movement snapshots are unavailable.</p>';
  return `<div class="game-page"><a class="back-board" href="#scores">← Back to ${esc(g.league)} Week ${footballWeek(g)} board</a><div class="game-hero"><p class="eyebrow">${esc(g.league)} · WEEK ${footballWeek(g)} · ${g.timeValid?fmt(g.kickoff,{weekday:'long',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' ET':'TIME TBD'}</p><h2>${esc(g.away.name)} at ${esc(g.home.name)}</h2><div class="game-scoreline"><div><small>${g.completed?'FINAL SCORE':'PREDICTED SCORE'}</small><strong>${g.completed?`${g.away.abbreviation} ${g.away.score} · ${g.home.abbreviation} ${g.home.score}`:score}</strong></div><div><small>PREDICTED TOTAL</small><strong>${total??'—'}</strong></div><div><small>FORECAST STATUS</small><strong class="forecast-stage">${p?.type==='analyst'?'Reviewed':p?.type==='historical'?'Historical import':p?'Early · research pending':'Pending'}</strong></div></div><p>${p?esc(p.why):'No forecast was recorded before kickoff.'}</p><p>Forecast recorded ${p?pretty(p.publishedAt)+' ET':'—'} · Source data checked ${pretty(state.slate.updatedAt)} ET</p></div><div class="subnav" aria-label="Game sections"><button data-game-section="game-lines">Score & lines</button><button data-game-section="game-props">Player props</button><button data-game-section="game-injuries">Injuries</button><button data-game-section="game-history">Matchup history</button></div><div class="game-page-grid"><section id="game-lines" class="game-panel"><h3>Score, spread & total</h3><dl><dt>Projected score</dt><dd>${esc(score)}</dd><dt>Projected margin</dt><dd>${margin==null?'—':`${esc(g.home.abbreviation)} ${margin>0?'+':''}${margin}`}</dd><dt>Projected total</dt><dd>${total??'—'}</dd><dt>Sportsbook home spread</dt><dd>${marketReady?`${esc(g.home.abbreviation)} ${esc(m.spread)} (${esc(m.spreadOdds||'—')})`:'Unavailable'}</dd><dt>Sportsbook O/U total</dt><dd>${m?.total!=null?`${esc(m.total)} · O ${esc(m.overOdds||'—')} / U ${esc(m.underOdds||'—')}`:'Unavailable'}</dd><dt>Projected O/U direction</dt><dd>${totalDirection}</dd><dt>Forecast vs market total</dt><dd>${totalGap==null?'—':`${totalGap>0?'+':''}${totalGap.toFixed(1)} pts`}</dd><dt>Forecast vs market spread</dt><dd>${spreadGap==null?'—':`${spreadGap>0?'+':''}${spreadGap.toFixed(1)} pts`}</dd></dl><p class="record-note">Forecast differences are context, not official spread or total picks. ${started?'Current game feed is post-start; it is not a verified closing quote.':'Check the book and timestamp before acting.'}</p></section><section class="game-panel"><h3>Market movement & matchup</h3>${movement}<p>Specific injuries, starters, weather, usage and defensive matchup findings appear here only after sourced analyst review.</p>${links([g.source,p?.sources?.[0]])}</section></div><section class="game-panel"><h3>Lines we’re watching</h3>${candidates.size?[...candidates.values()].map(earlyWatchCard).join(''):'<p>No game-specific player market has cleared the early research screen.</p>'}</section><section class="game-panel"><h3>Official spread & total picks</h3>${gameBets.length?gameBets.map(pickCard).join(''):'<p>No official spread or total selection published. Score differences are research context.</p>'}</section><section id="game-props" class="game-panel"><h3>Player props by position</h3>${pickBlocks}</section><div id="game-injuries">${injuriesFor(g)}</div><div id="game-history">${teamHistoryPanel(g)}</div>${defensePanel}<div class="game-page-grid"><section class="game-panel"><h3>Last 5–10 games</h3><p>Exact-market game history and charts appear on each researched prop above when verified. No player averages or hit rates are inferred from the score forecast.</p></section><section class="game-panel"><h3>Last game against this opponent</h3>${lastVs?`<ul>${lastVs}</ul>`:'<p>No verified player-specific prior meeting is attached to the published props.</p>'}<h4>Recent team meetings</h4><ul>${meetingsBlock}</ul></section></div></div>`;
}
function gameList(){
  const list=games().filter(g=>`${g.home.name} ${g.away.name} ${g.home.abbreviation} ${g.away.abbreviation}`.toLowerCase().includes(state.query.toLowerCase())).filter(g=>state.filter==='all'||(state.filter==='final'?g.completed:state.filter==='today'?day(g.kickoff)===day(new Date()):g.state==='pre'&&new Date(g.kickoff)>new Date()));
  const groups=Object.groupBy?Object.groupBy(list,g=>day(g.kickoff)):list.reduce((o,g)=>((o[day(g.kickoff)]??=[]).push(g),o),{});
  return `<div class="section-head"><div><h2>${state.league==='NFL'?'NFL game board':'College game board'}</h2><p>Predicted scores, final scores, and available game lines.</p></div><span class="count">${list.length} GAMES</span></div>`+
    (list.length?Object.entries(groups).map(([d,items])=>`<h3 class="day">${fmt(d+'T12:00Z',{weekday:'long',month:'long',day:'numeric'})}</h3><div class="games">${items.map(card).join('')}</div>`).join(''):empty('No matching games.','Try another team, status, or week.'));
}
function scoreboard(){return `<div class="board-filters"><label>Find a team<input id="team-search" type="search" placeholder="Team name or abbreviation" value="${esc(state.query)}"></label><label>Show<select id="game-filter">${[['all','All games'],['today','Today'],['upcoming','Upcoming'],['final','Final scores']].map(([v,l])=>`<option value="${v}" ${state.filter===v?'selected':''}>${l}</option>`).join('')}</select></label></div>${state.league==='NFL'?'<div class="archive-shortcut"><a href="#record">See Week 1 results →</a> <span>Player lines and score calls</span></div>':''}<div id="game-list">${gameList()}</div>`}
function empty(title,text){return `<div class="empty"><p class="eyebrow">${state.league} RESEARCH DESK</p><h3>${title}</h3><p>${text}</p></div>`}
function latestPicks(kind){
  const picks=new Map();
  const collections=kind==='props'?['props','riskyProps']:[kind];
  state.reports.filter(r=>r.league===state.league).sort((a,b)=>a.publishedAt.localeCompare(b.publishedAt)).forEach(r=>collections.forEach(collection=>(r[collection]||[]).forEach(p=>picks.set(p.id,{...p,publishedAt:r.publishedAt,kind:collection}))));
  const map=gameMap();
  return [...picks.values()].filter(p=>(p.gameIds||[]).some(id=>map.has(id)&&weekOf(map.get(id).kickoff)===state.week));
}
function pickStatus(p){
  if(p.status!=='active')return p.status;
  if(!Number.isFinite(Date.parse(p.expiresAt))||new Date(p.expiresAt)<=new Date())return 'expired';
  if((p.gameIds||[]).some(id=>{const g=gameMap().get(id);return !g||g.state!=='pre'||new Date(g.kickoff)<=new Date()}))return 'locked at kickoff';
  return 'active';
}
function formChart(form){
  const games=Array.isArray(form?.games)?form.games.filter(g=>Number.isFinite(Number(g?.value))&&typeof g?.hit==='boolean').slice(-10):[];
  if(!games.length)return '';
  const values=games.map(g=>Number(g.value)), max=Math.max(...values,Number(form.line)||0,1);
  const title=esc(form.stat||'Verified recent results');
  const bars=games.map((g,i)=>{
    const value=Number(g.value), height=Math.max(12,Math.round(value/max*100));
    const label=esc(g.label||g.date||`Game ${i+1}`);
    const opponent=esc((g.label||'').split('·').pop().trim()||`${i+1}`);
    return `<li class="form-game ${g.hit?'hit':'miss'}" title="${label}: ${value}${g.hit?' — hit':' — miss'}"><span class="form-outcome">${g.hit?'HIT':'MISS'}</span><span class="form-bar" style="height:${height}%"><span>${esc(value)}</span></span><small>${opponent}</small></li>`;
  }).join('');
  const line=Number.isFinite(Number(form.line))?`<p class="form-chart-line">Line: ${esc(form.line)} · newest game at right</p>`:'';
  return `<figure class="form-chart"><figcaption><strong>Recent game results</strong><span>${title}</span></figcaption><ol>${bars}</ol>${line}</figure>`;
}
function parlayLegHistory(p){
  const legs=Array.isArray(p.legs)?p.legs.filter(leg=>typeof leg==='string'&&leg.trim()):[];
  if(!legs.length)return '<p class="record-note">See individual leg history.</p>';
  const normalize=value=>String(value||'').trim().toLowerCase().replace(/\s+/g,' ');
  const research=Array.isArray(p.legResearch)?p.legResearch:[];
  const items=legs.map(leg=>{
    const matches=research.filter(r=>r&&typeof r.player==='string'&&typeof r.line==='number'&&Number.isFinite(r.line)&&r.comparison==='at least'&&r.window&&normalize(`${r.player} ${r.line}+ ${r.market} · ${r.window}`)===normalize(leg));
    const r=matches.length===1?matches[0]:null;
    const valid=r&&/^https:\/\//.test(r.source||'')&&Array.isArray(r.valuesNewestFirst)&&r.valuesNewestFirst.every(value=>typeof value==='number'&&Number.isFinite(value));
    const rate=n=>{
      const supplied=r?.[`last${n}`];
      if(!valid||r.valuesNewestFirst.length<n||supplied?.sample!==n)return null;
      const hits=r.valuesNewestFirst.slice(0,n).filter(value=>value>=r.line).length;
      return supplied.hits===hits?`Last ${n}: ${hits}/${n} · ${(100*hits/n).toFixed(0)}%`:null;
    };
    const rates=[rate(5),rate(10)].filter(Boolean);
    const window=/\s·\s/.test(leg)?'':` · ${p.marketWindow||'Window not verified'}`;
    return `<li><strong>${esc(leg+window)}</strong><br><small>${rates.length?`${rates.join(' · ')} · <a href="${esc(r.source)}" target="_blank" rel="noopener noreferrer">Game log ↗</a>`:'See individual leg history'}</small></li>`;
  });
  return `<section class="parlay-leg-research"><strong>Ticket legs · ${legs.length}</strong><ol>${items.join('')}</ol><p class="record-note">Individual past results at each exact line and market window. These rates are descriptive, not this ticket’s win probability.</p></section>`;
}
function pickCard(p,i=0,options){
  const status=pickStatus(p);
  const tier=p.kind==='parlays'?parlayTier(p):null;
  const result=p.result==='unverified'?(p.settlementState==='checking_rules'?'Checking original book rules':'Awaiting verified settlement'):p.result||status;
  const calc=FootballRecords.validOdds(p.odds)?`<div class="calculator" data-odds="${esc(p.odds)}"><strong>Payout preview · quoted ${p.quotedAt?pretty(p.quotedAt)+' ET':'time unknown'}</strong><label>Amount <input class="calc-amount" type="number" min="0.01" step="0.01" value="1"></label><label>Risk as <select class="calc-mode"><option value="units">Units</option><option value="money">Dollars</option></select></label><label>Dollar value of 1 unit <input class="calc-unit" type="number" min="0.01" step="0.01" value="10"></label><p class="calc-output" aria-live="polite"></p></div>`:'';
  const rate=x=>x&&Number.isInteger(x.hits)&&Number.isInteger(x.sample)&&x.sample>0&&x.hits>=0&&x.hits<=x.sample?`${x.hits}/${x.sample} · ${(100*x.hits/x.sample).toFixed(0)}%`:null;
  const form5=rate(p.recentForm?.last5),form10=rate(p.recentForm?.last10);
  const chart=formChart(p.recentForm);
  const form=p.kind==='parlays'?parlayLegHistory(p):form5||form10||chart?`<div class="recent-form"><strong>Recent hit rate</strong><span>${form5?`Last 5: ${form5}`:''}${form5&&form10?' · ':''}${form10?`Last 10: ${form10}`:''}</span>${p.recentForm?.stat?`<small>${esc(p.recentForm.stat)}</small>`:''}${chart}${p.recentForm?.source?`<a href="${esc(p.recentForm.source)}" target="_blank" rel="noopener noreferrer">Game log ↗</a>`:''}</div>`:status==='active'?`<div class="recent-form pending"><strong>Recent hit rate</strong><span>Game-log verification pending</span></div>`:'';
  const books=Array.isArray(p.books)?p.books.filter(x=>x&&x.book&&FootballRecords.validOdds(x.odds)).sort((a,b)=>Number(b.odds)-Number(a.odds)):[];
  const priceNote=books.length?`<p class="price-board"><strong>Best verified price:</strong> ${esc(books[0].book)} ${books[0].odds>0?'+':''}${esc(books[0].odds)}${books.length>1?` · ${books.length} books checked`:''}</p>`:'';
  const closeNote=p.closingLine||p.closingOdds!=null?`<p class="closing-note"><strong>Closing-line check:</strong> ${esc(p.closingLine||`${p.closingOdds>0?'+':''}${p.closingOdds}`)}${p.closingValue?` · ${esc(p.closingValue)}`:''}</p>`:'';
  const moveNote=p.movementReason?`<p class="movement-note"><strong>Why the line moved:</strong> ${esc(p.movementReason)}</p>`:'';
  const prior=p.recentForm?.lastVsOpponent;
  const priorNote=prior?`<p class="prior-opponent"><strong>Last game vs this opponent:</strong> ${esc(prior.value)} ${esc(p.recentForm.stat)} · ${esc(prior.date)} <a href="${esc(prior.source)}" target="_blank" rel="noopener noreferrer">Box score ↗</a><br><small>One prior meeting; personnel and role may have changed.</small></p>`:'';
  const usage=p.recentForm?.usage||[];
  const usageNote=usage.length?`<div class="usage-strip"><strong>Recent logged workload</strong><ul>${usage.map(x=>`<li>${esc(x.stat)}: ${x.last5?`last 5 avg ${esc(x.last5.average)} (${esc(x.last5.low)}–${esc(x.last5.high)})`:''}${x.last5&&x.last10?' · ':''}${x.last10?`last 10 avg ${esc(x.last10.average)} (${esc(x.last10.low)}–${esc(x.last10.high)})`:''}</li>`).join('')}</ul><small>Played games only; descriptive volume, not a projected role or bet edge.</small></div>`:'';
  const played=p.recentForm?.games||[];
  const formDetail=played.length?`<details class="stat-log"><summary>See ${played.length} individual game results</summary><div class="record-table"><table><thead><tr><th>Game</th><th>${esc(p.recentForm.stat)}</th><th>At line ${esc(p.recentForm.line)}</th></tr></thead><tbody>${played.slice().reverse().map(g=>`<tr><td>${/^https:\/\//.test(g.source||'')?`<a href="${esc(g.source)}" target="_blank" rel="noopener noreferrer">${esc(g.label)} ↗</a>`:esc(g.label)}</td><td>${esc(g.value)}</td><td>${g.hit?'Hit':'Miss'}</td></tr>`).join('')}</tbody></table></div><p>Played games before this matchup. Exact published line and direction; ${played.length<5?'fewer than five verified games, so no five-game rate.':'newest first.'}</p></details>`:'';
  const gameLink=p.gameIds?.[0]?`<p><a href="#game/${esc(p.gameIds[0])}">Matchup and defensive position history →</a></p>`:'';
  const window=p.marketWindow?`<span class="tag market-window">${esc(p.marketWindow)}</span>`:'';
  const selectButton=builderEligible(p)?`<button class="parlay-select ${state.parlaySelected.has(p.id)?'selected':''}" type="button" data-parlay-pick="${esc(p.id)}">${state.parlaySelected.has(p.id)?'Remove from ticket':'Add to ticket'}</button>${state.parlaySelected.has(p.id)?'<a class="ticket-link" href="#parlays">View ticket →</a>':''}`:'';
  const urgency=p.hot===true?`<div class="hot-clock"><strong>Early value</strong><span>${status==='active'&&p.expiresAt?`Recheck by ${pretty(p.expiresAt)} ET`:'The original number is no longer marked current'}</span></div>`:'';
  if(options?.compact===true){
    const map=gameMap(),game=p.gameIds?.[0]?map.get(p.gameIds[0]):null;
    const started=(p.gameIds||[]).some(id=>{const g=map.get(id);return g&&(g.state!=='pre'||Date.parse(g.kickoff)<=Date.now())});
    const paused=/paus/i.test(p.entryNote||'');
    const current=builderEligible(p)&&!started&&!paused;
    const availability=status==='historical'?'Historical pick':status==='withdrawn'?'Withdrawn':started?'Locked at kickoff':status==='expired'?'Quote expired':current?'Current quote':paused?'Entries paused':status==='locked at kickoff'?'Locked at kickoff':'Quote needs checking';
    const availabilityClass=current?'current':started||status==='historical'||status==='withdrawn'||status==='locked at kickoff'?'closed':'expired';
    const titleParts=String(p.title||'').match(/^(.+?)\s+(?:[—–-]\s*)?((?:OVER|UNDER)\b.*)$/i);
    const compactTitle=titleParts?`<span class="pick-player">${esc(titleParts[1].trim())}</span><span class="pick-line">${esc(titleParts[2])}</span>`:esc(p.title);
    const designation=FootballRecords.favorite(p)?'<span class="tag favorite-label">Daily favorite</span>':p.kind==='riskyProps'?`<span class="risk-badge">${p.fun===true?'Fun pick':'Risky pick'}</span>`:'<span class="tag">Official pick</span>';
    const matchup=game?`<p class="pick-matchup"><a href="#game/${esc(game.id)}">${esc(game.away.abbreviation)} @ ${esc(game.home.abbreviation)}</a>${Number.isFinite(Date.parse(game.kickoff))?` · ${pretty(game.kickoff)} ET`:''}</p>`:'';
    const shortReason=String(p.quickWhy||p.why||'').trim();
    const reason=shortReason.length>180?shortReason.slice(0,177).replace(/\s+\S*$/,'')+'…':shortReason;
    const playerPages=typeof globalThis.window!=='undefined'?globalThis.window.KeenPlayers:null;
    const profileHref=playerPages?.hrefFor(p,state)||'#players';
    const athleteId=p.athleteId||state.history?.picks?.[p.id]?.athleteId;
    const identity=state.identities?.players?.[`${game?.league||p.league||state.league}/${athleteId}`];
    const team=identity?.status==='ok'&&game&&[game.home.id,game.away.id].some(id=>String(id)===String(identity.team?.id))?identity.team:null;
    const color=typeof team?.color==='string'?team.color.replace(/^#/,''):'';
    const accent=/^[0-9a-f]{6}$/i.test(color)?` style="--pick-team-color:#${color}"`:'';
    return `<article class="pick pick-compact ${p.kind==='riskyProps'?'risky-pick':''}"${accent}>
      <div class="pick-card-top">${designation}<span class="pick-availability ${availabilityClass}">${availability}</span></div>
      <h3 aria-label="${esc(p.title)}">${compactTitle}</h3>${matchup}
      <div class="pick-facts"><span>${current?'Quoted price':'Original price'}<strong>${esc(p.book||'Book not verified')} ${p.odds>0?'+':''}${esc(p.odds||'')}</strong></span>${p.projection!=null?`<span>Projection<strong>${esc(p.projection)}</strong></span>`:''}<span>Confidence<strong>${esc(p.confidence??'—')}/10</strong></span></div>
      <p class="pick-quote">Quoted ${p.quotedAt?pretty(p.quotedAt)+' ET':'time unavailable'}${current&&p.expiresAt?` · Recheck by ${pretty(p.expiresAt)} ET`:''} · 1u risk</p>
      ${paused?'<p class="pick-paused">Entries paused</p>':''}${reason?`<p class="pick-quick-why">${esc(reason)}</p>`:''}
      <p class="pick-cutoff"><strong>${current?'Take it through:':'Original limit:'}</strong> ${esc(p.cutoff||'Recheck the exact price')}</p>
      <div class="pick-actions"><a class="pick-research-link" href="${esc(profileHref)}">Player stats & research →</a>${current?selectButton:''}</div>
    </article>`;
  }
  return `<article class="pick ${p.kind==='riskyProps'?'risky-pick':''} ${p.hot===true?'hot-pick':''}"><span class="number">${String(i+1).padStart(2,'0')}</span> <span class="tag">${esc(result)}</span>${p.hot===true&&status==='active'?'<span class="hot-badge">HOT PICK</span>':''}${FootballRecords.favorite(p)?'<span class="tag favorite-label">DAILY FAVORITE</span>':''}${p.fun===true?'<span class="fun-badge">FUN MARKET</span>':''}${p.kind==='riskyProps'?'<span class="risk-badge">RISKY LINE</span>':''}${window}${tier?`<span class="tag">${tier.label}</span>`:''}<h3>${esc(p.title)}</h3>${urgency}<p><strong>${esc(p.book||'Book not verified')} ${p.odds>0?'+':''}${esc(p.odds||'')}</strong> · Confidence ${esc(p.confidence??'—')}/10</p>${p.entryNote?`<p class="entry-note"><strong>Entry update:</strong> ${esc(p.entryNote)}</p>`:''}${p.quickWhy?`<p class="pick-quick-why">${esc(p.quickWhy)}</p>`:''}<p class="pick-cutoff"><strong>Take it through:</strong> ${esc(p.cutoff||'Recheck the exact price')}</p>${priceNote}${p.projection!=null?`<p>Projected: <strong>${esc(p.projection)}</strong></p>`:''}${form}${gameLink}${selectButton}<details class="pick-details"><summary>Reasoning, workload & price details</summary>${workloadPanel(p.recentForm)}${playerMovement(p)}${usageNote}${formDetail}${priorNote}${closeNote}${moveNote}<p><strong>Why:</strong> ${esc(p.why)}</p><p><strong>Risk:</strong> ${esc(p.risk)}</p>${p.edge?`<p><strong>Estimated edge:</strong> ${esc(p.edge)}</p>`:''}${p.legs&&p.kind!=='parlays'?`<p><strong>Legs:</strong> ${p.legs.map(esc).join(' + ')}</p>`:''}${p.correlation?`<p><strong>Correlation:</strong> ${esc(p.correlation)}</p>`:''}<p><strong>Price limit:</strong> ${esc(p.cutoff||'Not actionable')}</p><p>Quote: ${p.quotedAt?pretty(p.quotedAt)+' ET':'Not verified'} · Recorded ${pretty(p.publishedAt)} ET</p>${p.bookLink&&status==='active'?`<p><a href="${esc(p.bookLink)}" target="_blank" rel="noopener noreferrer"><strong>Open verified bet slip at ${esc(p.book)} ↗</strong></a></p>`:''}${p.result?`<p><strong>Result: ${esc(result)}</strong> · Actual ${esc(p.actual)}</p>${p.lastCheckedAt?`<p>Checked ${pretty(p.lastCheckedAt)} ET${p.nextReviewAt?` · Next review ${pretty(p.nextReviewAt)} ET`:''}</p>`:''}${links([p.resultSource])}`:''}${calc}${links(p.sources)}</details></article>`;
}
function research(kind){
  const allUnfiltered=latestPicks(kind);
  if(kind==='parlays')allUnfiltered.sort((a,b)=>parlayTier(a).rank-parlayTier(b).rank);
  const gameOptions=games().slice().sort((a,b)=>a.kickoff.localeCompare(b.kickoff));
  const watchPositions=state.reports.filter(r=>r.league===state.league).flatMap(r=>r.gameWatch||[]).filter(w=>gameOptions.some(g=>g.id===w.gameId)&&w.position).map(w=>w.position);
  const positionOptions=[...new Set([...allUnfiltered.map(marketPosition),...watchPositions])].sort();
  if(state.propGame!=='all'&&!gameOptions.some(g=>g.id===state.propGame))state.propGame='all';
  if(state.propPosition!=='all'&&!positionOptions.includes(state.propPosition))state.propPosition='all';
  const all=kind==='props'?allUnfiltered.filter(p=>(state.propGame==='all'||(p.gameIds||[]).includes(state.propGame))&&(state.propPosition==='all'||marketPosition(p)===state.propPosition)):allUnfiltered;
  const active=all.filter(p=>pickStatus(p)==='active');
  const title=kind==='props'?'Player props':'Parlays & ticket builder';
  const text=kind==='props'?'Favorites first. Filter the full published card by game or position.':'Published tickets ordered by relative risk, then your personal builder. Lower risk still carries a chance of losing; tiers are qualitative.';
  const no=kind==='props'?(all.length?'Published picks · quotes need rechecking':'No active prop card.'):'No qualifying parlay published.';
  const reason=kind==='props'?(all.length?'The original selections remain below and in the record. A closed or expired quote is not a current entry price.':'Game research is available below. An official pick needs a verified price and completed review.'):'The research desk has not verified a combined sportsbook price and defensible joint assumptions. Adding legs to fill a ticket would not make it a smart parlay.';
  const selectedOfficialWeek=[...new Set(games().map(footballWeek))][0];
  const selectedReports=state.reports.filter(r=>r.league===state.league&&(Number.isInteger(r.targetWeek)?r.targetWeek===selectedOfficialWeek:weekOf(r.publishedAt)===state.week));
  const watch=selectedReports.flatMap(r=>r.watch||[]);
  const history=all.filter(p=>p.status==='historical'),core=all.filter(p=>p.kind!=='riskyProps'),risky=all.filter(p=>p.kind==='riskyProps');
  const favorites=core.filter(FootballRecords.favorite).sort((a,b)=>Number(pickStatus(b)==='active')-Number(pickStatus(a)==='active')),hot=core.filter(p=>p.hot===true&&pickStatus(p)==='active'&&!FootballRecords.favorite(p)),otherCore=core.filter(p=>!FootballRecords.favorite(p)&&!hot.includes(p));
  const fun=risky.filter(p=>p.fun===true),otherRisky=risky.filter(p=>p.fun!==true);
  const watchItems=new Map();selectedReports.forEach(r=>(r.gameWatch||[]).filter(w=>(state.propGame==='all'||w.gameId===state.propGame)&&(state.propPosition==='all'||w.position===state.propPosition)).forEach(w=>watchItems.set(w.id,{...w,publishedAt:r.publishedAt})));
  const coreActive=core.filter(p=>pickStatus(p)==='active'),riskyActive=risky.filter(p=>pickStatus(p)==='active');
  const takeaways=selectedReports.at(-1)?.takeaways||[];
  const takeawayBlock=takeaways.length?`<details class="takeaway-panel"><summary>Research takeaways</summary><ul>${takeaways.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>`:'';
  const stage=coreActive.length?'official':watch.length?'watch':'waiting';
  const lifecycle=`<section class="research-lifecycle" aria-label="Research status"><div class="lifecycle-step ${stage==='watch'||stage==='official'?'done':''}"><span>1</span><strong>Market watch</strong><small>Game lines and slate context</small></div><div class="lifecycle-step ${stage==='official'?'done':''}"><span>2</span><strong>Player screen</strong><small>Role, injury, usage and matchup</small></div><div class="lifecycle-step ${stage==='official'?'done':''}"><span>3</span><strong>Official card</strong><small>Exact line, price and cutoff</small></div><div class="lifecycle-step"><span>4</span><strong>Settlement</strong><small>Stats, closing line and review</small></div></section>`;
  const compactCards=items=>items.map((p,i)=>pickCard(p,i,{compact:true})).join('');
  const positionCards=Object.entries(otherCore.reduce((o,p)=>{(o[marketPosition(p)]??=[]).push(p);return o},{})).map(([pos,items])=>`<section class="position-group"><h4>${esc(pos)}</h4><div class="cards">${compactCards(items)}</div></section>`).join('');
  const hotCards=hot.length?`<section class="hot-lines"><div class="section-head"><h3>More early picks</h3><span class="count">${hot.length} LINES</span></div><div class="cards">${compactCards(hot)}</div></section>`:'';
  const favoriteCards=favorites.length?`<section class="favorite-lines"><div class="section-head"><h3>Daily favorites</h3><span class="count">${favorites.length} PICKS</span></div><div class="cards">${compactCards(favorites)}</div></section>`:'';
  const funCards=fun.length?`<section class="fun-lines"><div class="section-head"><div><h3>Fun markets</h3><p>1Q, 1H, TDs and alternates · higher variance, tracked separately.</p></div><span class="count">${fun.length} PICKS</span></div><div class="cards">${compactCards(fun)}</div></section>`:'';
  const cards=kind==='props'?`${favoriteCards}${hotCards}${otherCore.length?`<section class="all-lines"><div class="section-head"><h3>Other official player lines</h3><span class="count">${otherCore.length} PICKS</span></div>${positionCards}</section>`:''}${funCards}${otherRisky.length?`<section class="risky-lines"><div class="section-head"><div><h3>Risky lines</h3><p>Higher variance · tracked separately from favorites.</p></div><span class="count">${otherRisky.length} PICKS</span></div><div class="cards">${compactCards(otherRisky)}</div></section>`:''}`:parlayBoard(all);
  const watchCards=kind==='props'&&watchItems.size?`<details class="picks-watch"><summary><strong>Early research · ${watchItems.size} candidates</strong><span>Not official picks</span></summary><div class="watch-list"><p>Matchups and reference lines under review.</p><div class="early-grid">${[...watchItems.values()].sort((a,b)=>Number(Boolean(b.position))-Number(Boolean(a.position))).map(earlyWatchCard).join('')}</div></div></details>`:'';
  const propFilters=kind==='props'?`<div class="prop-filters" aria-label="Player prop filters"><label>Game<select id="prop-game"><option value="all">All games</option>${gameOptions.map(g=>`<option value="${esc(g.id)}" ${state.propGame===g.id?'selected':''}>${esc(g.away.abbreviation)} @ ${esc(g.home.abbreviation)} · ${fmt(g.kickoff,{month:'short',day:'numeric'})}</option>`).join('')}</select></label><label>Position<select id="prop-position"><option value="all">All positions</option>${positionOptions.map(pos=>`<option value="${esc(pos)}" ${state.propPosition===pos?'selected':''}>${esc(pos)}</option>`).join('')}</select></label><button id="clear-prop-filters" type="button" ${state.propGame==='all'&&state.propPosition==='all'?'disabled':''}>Clear filters</button></div>`:'';
  const filterSummary=kind==='props'&&all.length!==allUnfiltered.length?`Showing ${all.length} of ${allUnfiltered.length} official player lines for this week`:`${all.length} official player line${all.length===1?'':'s'} for this week`;
  const supportingNotes=takeawayBlock+(history.length?`<details class="takeaway-panel"><summary>About the Week 1 imports</summary><p>These are screenshot-derived historical lines. Original prices and exact posting times were not supplied. Missing original prices mean unavailable profit and ROI.</p></details>`:'')+(watch.length?`<details class="watch-summary"><summary>Additional market notes · ${watch.length}</summary><div><p>Research notes, not available wagers.</p></div><div class="watch-summary-grid">${watch.map(w=>{const parts=String(w).split(' — ');return `<article><span class="tag">WATCH</span><h4>${esc(parts.shift()||'Market note')}</h4><p>${esc(parts.join(' — '))}</p></article>`}).join('')}</div></details>`:'');
  if(kind==='props'){
    const filtered=state.propGame!=='all'||state.propPosition!=='all';
    const currentCount=all.filter(builderEligible).length;
    const availability=!all.length?(allUnfiltered.length?'No picks match these filters. Try another game or position.':'No official picks published yet. Early research is below.') : currentCount?`${currentCount} current quote${currentCount===1?'':'s'} · check each price and limit before entry.`:'Published picks below; no current entry quotes. Original lines stay in the record.';
    return `<div class="picks-page"><div class="picks-heading"><div><h2>Official picks</h2><p class="picks-count">${filterSummary} · ${favorites.length} daily favorite${favorites.length===1?'':'s'}</p></div><div class="picks-tools"><a href="#players">Player research →</a><a href="#parlays">Parlays →</a></div></div><p class="picks-availability">${availability}</p><details class="pick-filters" ${filtered?'open':''}><summary>Filter by game or position${filtered?' · filters applied':''}</summary>${propFilters}</details>${cards}${watchCards}${supportingNotes}</div>`;
  }
  return `<div class="subnav"><a href="#props">Player props</a><a href="#parlays">Parlays & ticket builder →</a></div><div class="section-head"><div><h2>${title}</h2><p>${text}</p>${kind==='props'?`<p>${filterSummary} · ${favorites.length} daily favorite${favorites.length===1?'':'s'} shown · ${coreActive.length+riskyActive.length} currently active. Position groups and exact-market logs appear below when verified.</p>`:''}</div><span class="count">${kind==='props'?coreActive.length:active.length} ACTIVE</span></div>`+propFilters+(kind==='props'&&!all.length?empty(allUnfiltered.length?'No props match these filters.':'No official picks published yet.',allUnfiltered.length?'Try another game or position.':'Game research is available below. Qualified picks will appear here when verified.'):kind==='props'&&!coreActive.length?empty(no,reason):kind!=='props'&&!active.length?empty(no,reason):'')+cards+watchCards+(kind==='parlays'?parlayBuilder(): '')+takeawayBlock+(history.length?`<div class="method"><h3>Week 1 imported card</h3><p>These are screenshot-derived historical lines. Original prices and exact posting times were not supplied. Missing original prices mean unavailable profit and ROI.</p></div>`:'')+(watch.length?`<details class="watch-summary"><summary>Additional market notes · ${watch.length}</summary><div><p class="eyebrow">MARKET WATCH</p><h3>Lines to watch</h3><p>Research notes, not available wagers.</p></div><div class="watch-summary-grid">${watch.map(w=>{const parts=String(w).split(' — ');return `<article><span class="tag">WATCH</span><h4>${esc(parts.shift()||'Market note')}</h4><p>${esc(parts.join(' — '))}</p></article>`}).join('')}</div></details>`:'');
}
function render(){
  if(window.KeenSports?.matches(location.hash)){window.KeenSports.render({state});return;}
  window.KeenSports?.syncNavigation(state.league,state.recordLeague);
  if(window.KeenPlayers?.matches(location.hash)){
    document.querySelectorAll('[data-view]').forEach(b=>{if(b.dataset.view==='players')b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
    $('#freshness').textContent=state.history?.updatedAt?`History refresh ${pretty(state.history.updatedAt)} ET`:'Player history unavailable';
    $('#notice').textContent=state.history?.updatedAt?'Each player shows its last successful history check. Market windows, quote times and incomplete coverage are labeled below.':'Player history is unavailable. Research coverage is labeled below.';
    $('#notice').classList.toggle('warn',!state.history?.updatedAt);
    window.KeenPlayers.render({state,helpers:{pickCard,formChart,workloadPanel,playerMovement,matchupPanel:window.KeenMatchups?.panel}});
    return;
  }
  if(state.footballError){
    $('#notice').textContent='Football data could not load. Other sports may still be available.';
    $('#notice').classList.add('warn');
    $('#freshness').textContent='Football source unavailable';
    $('#content').innerHTML=empty('Football board temporarily unavailable.','Refresh to try again, or open another sport. No football records or recommendations are displayed from incomplete files.');
    return;
  }
  if(window.KeenBoard&&['props','parlays'].includes(state.view)){
    document.querySelectorAll('[data-view]').forEach(b=>{if(b.dataset.view===state.view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
    $('.week-label').hidden=false;
    const source=(state.slate.sources||[]).find(s=>s.league===state.league);
    const failed=source?.fetchStatus==='failed';
    $('#freshness').textContent=failed?'Schedule refresh delayed':state.marketLines?.updatedAt?`Line board compiled ${pretty(state.marketLines.updatedAt)} ET`:'Saved line observations';
    $('#notice').textContent=failed?'Schedule update delayed. Saved game times and line observations need rechecking.':'Tap any line for the research. Favorites are our picks; other lines are for your own comparison. Each price has its own check time.';
    $('#notice').classList.toggle('warn',failed);
    window.KeenBoard.render({state,helpers:{parlayBoard,pickCard,formChart,workloadPanel,playerMovement}});
    return;
  }
  const routeKey=[state.view,state.week,state.league,state.propGame,state.propPosition].join('|');
  const sameRoute=state.renderedRoute===routeKey;state.renderedRoute=routeKey;
  $('.week-label').hidden=state.view==='record';
  const opened=[...document.querySelectorAll('#content details')].map((d,i)=>d.open?i:-1).filter(i=>i>=0);
  document.querySelectorAll('[data-league]').forEach(b=>{const selected=b.dataset.league===(state.view==='record'?state.recordLeague:state.league);b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',selected)});
  document.querySelectorAll('[data-view]').forEach(b=>{if(b.dataset.view===(state.view==='game'?'scores':state.view==='parlays'?'props':state.view))b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
  const source=(state.slate.sources||[]).find(s=>s.league===state.league);
  const checkedAt=source?.retrievedAt||state.slate.updatedAt;
  const age=(Date.now()-new Date(checkedAt))/3600000;
  const failed=source?.fetchStatus==='failed';
  const recovered=source?.fetchMethod==='verified season-week union';
  $('#freshness').textContent=failed?`${state.league} source unavailable · last successful ${pretty(checkedAt)} ET`:`Feed checked ${pretty(checkedAt)} ET`;
  $('#notice').classList.toggle('warn',failed||age>12);
  $('#notice').textContent=failed?`ESPN schedule update failed at ${pretty(source.lastAttemptAt)} ET. Showing the last verified slate; current game status and quotes may be stale.`:age>12?'Source data is more than 12 hours old. Check source links before relying on game times or results.':recovered?`Game feed checked ${pretty(checkedAt)} ET. Each player quote has its own timestamp.`:state.view==='scores'?'Baseline forecasts are live. Game-market comparison is DraftKings when carried by the source; check the timestamp and book before acting.':'Only verified research can become an active recommendation. Expired quotes and games at kickoff are locked automatically.';
  $('#content').innerHTML=state.view==='game'?(gameMap().get(decodeURIComponent(location.hash.slice(6)))?gamePage(gameMap().get(decodeURIComponent(location.hash.slice(6)))):empty('Game unavailable.','The saved game link no longer matches the current feed.')):state.view==='scores'?scoreboard():state.view==='record'?resultsPage():state.view==='research'?researchHub():state.view==='home'?weekOverview():research(state.view);
  document.querySelectorAll('#content details').forEach((d,i)=>{if(sameRoute&&opened.includes(i))d.open=true});
  document.querySelectorAll('.calculator').forEach(updateCalculator);
}

function americanToDecimal(odds){const n=Number(odds);return n>0?1+n/100:1+100/Math.abs(n)}
function decimalToAmerican(decimal){return decimal>=2?Math.round((decimal-1)*100):Math.round(-100/(decimal-1))}

function parlayTier(p){
  if(p.riskTier==='high'||p.parlayType==='longshot'||p.longshot===true||/longshot/i.test(p.title)||Number(p.odds)>=1000)return {rank:2,label:'Tier 3 · Longshot / high risk'};
  if(p.riskTier==='lower')return {rank:0,label:'Tier 1 · Lower relative risk'};
  if(p.riskTier==='medium')return {rank:1,label:'Tier 2 · Medium relative risk'};
  return {rank:1,label:'Risk tier awaiting review'};
}
function parlayBoard(picks){
  const tiers=[['Tier 1 · Lower relative risk','Shorter tickets, usually two supported legs. Lower payout; still capable of losing.'],['Tier 2 · Medium relative risk','More ambitious combinations. Each ticket explains its added uncertainty.'],['Tier 3 · Longshots & fun','High payout and low hit probability. First-quarter tickets belong here unless a different tier is justified.']];
  return `<section class="parlay-tiers"><h3>Three ways to play</h3><p>Actual sportsbook odds appear on each published ticket. Risk reflects the legs, market window and correlation, not payout alone. Every official ticket is tracked at 1 unit; personal drafts stay separate.</p>${tiers.map(([name,note],i)=>{const items=picks.filter(p=>parlayTier(p).rank===i);return `<section class="position-group"><h3>${name}</h3><p>${note}</p>${items.length?`<div class="kr-published-list">${items.map((p,index)=>`<details class="kr-published-item"><summary><strong>${esc(p.title)}</strong><span>${esc(p.book||'Book unavailable')} ${FootballRecords.validOdds(p.odds)?(Number(p.odds)>0?'+':'')+p.odds:'Price unavailable'}</span></summary>${pickCard(p,index)}</details>`).join('')}</div>`:'<p class="record-note">No verified ticket published in this tier yet.</p>'}</section>`}).join('')}</section>`;
}
function builderEligible(p){
  return pickStatus(p)==='active' && !/paus/i.test(p.entryNote||'') && ['props','riskyProps'].includes(p.kind) &&
    FootballRecords.validOdds(p.odds) && typeof p.book==='string' && Boolean(p.book.trim()) && p.gameIds?.length===1 &&
    Number.isFinite(Date.parse(p.quotedAt)) && Date.parse(p.quotedAt)<=Date.now();
}
function parlayCandidates(){return latestPicks('props').filter(builderEligible)}
function compatibleTicket(items){
  return items.length>=2 && items.every(builderEligible) &&
    new Set(items.map(p=>p.book.trim().toLowerCase())).size===1 &&
    new Set(items.map(p=>p.gameIds[0])).size===items.length;
}
function ticketText(items){
  return ['KeenRoudy Sports - draft ticket',...items.map(p=>{
    const g=gameMap().get(p.gameIds[0]);
    return `${p.title} | ${p.marketWindow||'Full game'} | ${g?g.away.abbreviation+' @ '+g.home.abbreviation+' '+pretty(g.kickoff)+' ET':''} | ${p.book} ${p.odds>0?'+':''}${p.odds} | quoted ${p.quotedAt} | limit: ${p.cutoff||'Recheck price'}`;
  }),'Please verify exact markets and current odds before preparing the slip.'].join('\n');
}
function parlayBuilder(){
  const candidates=parlayCandidates(), chosen=candidates.filter(p=>state.parlaySelected.has(p.id));
  const compatible=compatibleTicket(chosen);
  const combined=compatible?decimalToAmerican(chosen.reduce((n,p)=>n*americanToDecimal(p.odds),1)):null;
  const target=Number(state.parlayTarget), combos=[];
  for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++){
    const items=[candidates[i],candidates[j]];
    if(!compatibleTicket(items))continue;
    const price=decimalToAmerican(items.reduce((n,p)=>n*americanToDecimal(p.odds),1));
    combos.push({items,price,gap:Math.abs(price-target)});
  }
  combos.sort((a,b)=>a.gap-b.gap);
  const validTarget=Number.isFinite(target)&&target>=100&&target<=10000;
  const suggestions=validTarget?combos.filter(c=>c.gap<=Math.max(50,target*.2)).slice(0,3):[];
  return `<section class="parlay-builder"><p class="eyebrow">PERSONAL DRAFT · NOT AN OFFICIAL PICK</p><h3>Build your ticket</h3><p><a href="#props">Choose player props →</a> · Add legs on each active prop card.</p><div class="parlay-grid"><section><h4>Your draft · ${chosen.length} legs</h4>${chosen.length?`<ul>${chosen.map(p=>`<li><strong>${esc(p.title)}</strong><br>${esc(p.book)} · ${p.odds>0?'+':''}${p.odds}<button type="button" class="parlay-remove" data-parlay-pick="${esc(p.id)}">Remove</button></li>`).join('')}</ul>`:'<p>No active legs selected.</p>'}<p><strong>Estimated odds:</strong> ${combined==null?'Unavailable':(combined>0?'+':'')+combined}</p><small>${chosen.length>=2&&!compatible?'Different books or same-game legs require a sportsbook quote.':'Single-leg price multiplication only. Actual price and acceptance must be checked at the book.'} Drafts do not enter the official record.</small>${chosen.length?`<details class="gambly-handoff"><summary>Send to Gambly</summary><p>Copy this ticket, open Gambly, and paste it into its chat. Review its matched markets before opening your sportsbook.</p><textarea id="gambly-ticket" readonly aria-label="Ticket text for Gambly">${esc(ticketText(chosen))}</textarea><button type="button" id="copy-ticket">Copy ticket</button> <a href="https://gambly.com/gambly-bot" target="_blank" rel="noopener noreferrer">Open Gambly ↗</a><p id="copy-status" role="status"></p></details>`:''}</section><section><label>Target American odds (+100 to +10000)<input id="parlay-target" type="number" min="100" max="10000" step="25" value="${esc(state.parlayTarget)}"></label><h4>Two-leg drafts near your target</h4><p>Same book, different games. Matching payout does not establish value or a win probability.</p>${suggestions.length?`<ul>${suggestions.map(c=>`<li>Approx. +${c.price} · ${esc(c.items[0].book)}<br>${c.items.map(p=>esc(p.title)).join('<br>')}<button type="button" class="parlay-load" data-parlay-ids="${esc(c.items.map(p=>p.id).join(','))}">Use these legs</button></li>`).join('')}</ul>`:'<p>No eligible two-leg match near this target. Try a different target or select your own legs.</p>'}</section></div></section>`;
}

function updateCalculator(box){
  const amount=Number(box.querySelector('.calc-amount').value), unit=Number(box.querySelector('.calc-unit').value), mode=box.querySelector('.calc-mode').value;
  const output=box.querySelector('.calc-output');
  if(!(amount>0&&unit>0)){output.textContent='Enter a positive amount and unit value.';return}
  const stake=mode==='units'?amount*unit:amount, gain=FootballRecords.profit(box.dataset.odds,stake);
  output.textContent=`Risk $${stake.toFixed(2)} · Profit if it wins $${gain.toFixed(2)} · Total return $${(stake+gain).toFixed(2)}. Example only; check the current book price.`;
}
function navigate(){const changed=state.navigationHash!==location.hash;state.navigationHash=location.hash;const view=location.hash.slice(1);state.view=view.startsWith('game/')?'game':view.startsWith('player/')?'player':['home','scores','props','parlays','record','research','players'].includes(view)?view:'home';if(state.view==='game'){const g=gameMap().get(decodeURIComponent(view.slice(5)));if(g){state.league=g.league;state.week=weekOf(g.kickoff);setupWeeks()}}else if($('#week')?.value&&state.week!==$('#week').value){state.week=$('#week').value}if(state.slate)render();if(changed)window.scrollTo({top:0,behavior:'instant'})}
async function init(){
  $('#today').textContent=fmt(new Date(),{weekday:'short',month:'short',day:'numeric',year:'numeric'}).toUpperCase();
  const sportsReady=window.KeenSports?.load();
  try{
    try{
      const values=await Promise.all(['slate','forecasts','research'].map(async f=>{const r=await fetch(`data/${f}.json?refresh=${Date.now()}`,{cache:'no-store'});if(!r.ok)throw new Error('Data unavailable');return r.json()}));
      [state.slate,state.forecasts,state.reports]=values;
      state.footballError=false;
    }catch(error){
      state.footballError=true;
      state.slate={games:[],sources:[]};state.forecasts=[];state.reports=[];
    }
    // Optional enrichment never blocks the official ledger or scoreboard.
    try{
      const response=await fetch(`data/player-history.json?refresh=${Date.now()}`,{cache:'no-store'});
      if(response.ok){state.history=await response.json();
        state.reports.forEach(report=>['props','riskyProps'].forEach(kind=>(report[kind]||[]).forEach(p=>{
          const item=state.history.picks?.[p.id];
          if(item&&!p.recentForm&&Number(p.title.match(/ (?:OVER|UNDER) (\d+(?:\.\d+)?)/)?.[1])===Number(item.recentForm.line)){
            p.recentForm=item.recentForm;p.position=p.position||item.position;
            p.gameIds=p.gameIds?.length?p.gameIds:[item.gameId];
          }
        })));
      }
    }catch(e){state.history=null}
    try{const c=await fetch('data/research-context.json?refresh='+Date.now(),{cache:'no-store'});if(c.ok)state.context=await c.json()}catch(e){state.context=null}
    try{const r=await fetch('data/player-identity.json?refresh='+Date.now(),{cache:'no-store'});if(r.ok)state.identities=await r.json()}catch(e){state.identities=null}
    try{const r=await fetch('data/opponent-history.json?refresh='+Date.now(),{cache:'no-store'});if(r.ok)state.opponents=await r.json()}catch(e){state.opponents=null}
    try{const r=await fetch('data/market-lines.json?refresh='+Date.now(),{cache:'no-store'});if(r.ok)state.marketLines=await r.json()}catch(e){state.marketLines=null}
    await sportsReady;
    if(!location.hash)history.replaceState(null,'','#sports');
    setupWeeks();navigate();
    document.querySelectorAll('[data-league]').forEach(b=>b.addEventListener('click',()=>{state.league=b.dataset.league;if(state.view==='record'){state.recordLeague=state.league;state.recordWeek='total'}else if(window.KeenSports?.matches(location.hash)){state.view='home';location.hash='home'}else if(state.view==='players'||state.view==='player'){state.playerLeague=state.league;state.view='players';location.hash='players'}else if(state.view==='game'){state.view='scores';location.hash='scores'}state.query='';state.filter='all';state.propGame='all';state.propPosition='all';localStorage.setItem('football-league',state.league);setupWeeks();render()}));
    document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{location.hash=b.dataset.view;navigate()}));
    window.addEventListener('hashchange',navigate);
    document.addEventListener('click',async e=>{const jump=e.target.closest('[data-game-section]');if(jump){document.getElementById(jump.dataset.gameSection)?.scrollIntoView({behavior:'smooth',block:'start'});return}const resultTab=e.target.closest('[data-result-tab]');if(resultTab){state.resultTab=resultTab.dataset.resultTab;render();return}if(e.target.id==='copy-ticket'){try{await navigator.clipboard.writeText($('#gambly-ticket').value);$('#copy-status').textContent='Copied. Open Gambly and paste your ticket.'}catch(error){$('#gambly-ticket').select();$('#copy-status').textContent='Select and copy the ticket text above.'}return}const parlay=e.target.closest('[data-parlay-pick]');if(parlay){const id=parlay.dataset.parlayPick;state.parlaySelected.has(id)?state.parlaySelected.delete(id):state.parlaySelected.add(id);render();return}const load=e.target.closest('[data-parlay-ids]');if(load){state.parlaySelected=new Set(load.dataset.parlayIds.split(',').filter(Boolean));render();return}if(e.target.id==='clear-prop-filters'){state.propGame='all';state.propPosition='all';render();return}const a=e.target.closest('a[href^="#"]');if(!a)return;const route=a.getAttribute('href').slice(1);if(route.startsWith('game/')||route.startsWith('player/')||['home','scores','props','parlays','record','research','players'].includes(route)){e.preventDefault();location.hash=route;navigate()}});
    $('#content').addEventListener('input',e=>{if(e.target.id==='team-search'){state.query=e.target.value;$('#game-list').innerHTML=gameList()}else if(e.target.closest('.calculator'))updateCalculator(e.target.closest('.calculator'))});
    $('#content').addEventListener('change',e=>{if(e.target.id==='score-mode'){state.scoreMode=e.target.value;render();return}if(e.target.id==='parlay-target'){state.parlayTarget=Number(e.target.value)||200;render();return}if(e.target.id==='game-filter'){state.filter=e.target.value;$('#game-list').innerHTML=gameList()}else if(e.target.id==='prop-game'){state.propGame=e.target.value;render()}else if(e.target.id==='prop-position'){state.propPosition=e.target.value;render()}else if(['record-scope','record-league','record-week','record-evidence'].includes(e.target.id)){state[{"record-scope":"recordScope","record-league":"recordLeague","record-week":"recordWeek","record-evidence":"recordEvidence"}[e.target.id]]=e.target.value;if(e.target.id==='record-league')state.recordWeek='total';render()}else if(e.target.closest('.calculator'))updateCalculator(e.target.closest('.calculator'))});
    const setWeek=e=>{state.week=e.target.value;if(state.view==='game'){state.view='scores';location.hash='scores'}state.propGame='all';state.propPosition='all';render()};
    $('#week').addEventListener('change',setWeek);
    $('#week').addEventListener('input',setWeek);
    setInterval(()=>{if(!['INPUT','SELECT'].includes(document.activeElement?.tagName))render()},60000);
  }catch(e){$('#notice').textContent='The latest board could not load. Please refresh and try again.';$('#notice').classList.add('warn');$('#content').innerHTML=empty('Data temporarily unavailable.','No recommendations are displayed while the source files are unavailable.');}
}
init();

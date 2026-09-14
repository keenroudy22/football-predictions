'use strict';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (date, options={}) => new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',...options}).format(new Date(date));
const day = date => fmt(date,{year:'numeric',month:'2-digit',day:'2-digit'}).split('/').map((x,i,a)=>a[[2,0,1][i]]).join('-');
const weekOf = date => {const d = new Date(day(date)+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10)};
const pretty = date => fmt(date,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const links = urls => `<div class="sources">${(urls||[]).filter(u=>/^https:\/\//.test(u)).map((u,i)=>`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">Source ${i+1} ↗</a>`).join('')}</div>`;
let state={league:localStorage.getItem('football-league')||'NFL',view:'scores',week:weekOf(new Date()),query:'',filter:'all',slate:null,forecasts:[],reports:[]};
if(!['NFL','CFB'].includes(state.league)) state.league='NFL';
const gameMap = () => new Map(state.slate.games.map(g=>[g.id,g]));
const games = () => state.slate.games.filter(g=>g.league===state.league && weekOf(g.kickoff)===state.week);
const original = g => state.forecasts.find(p=>p.gameId===g.id);
function forecast(g){
  const revisions=state.reports.filter(r=>r.league===g.league && (r.historicalImport || new Date(r.publishedAt)<new Date(g.kickoff))).flatMap(r=>(r.scores||[]).filter(p=>p.gameId===g.id).map(p=>({...p,publishedAt:r.publishedAt,type:r.historicalImport?'historical':'analyst',historicalImport:r.historicalImport})));
  return revisions.sort((a,b)=>a.publishedAt.localeCompare(b.publishedAt)).at(-1)||original(g);
}
function setupWeeks(){
  const options=[...new Set(state.slate.games.filter(g=>g.league===state.league).map(g=>weekOf(g.kickoff)))].sort().reverse();
  if(!options.includes(state.week)) state.week=options.find(w=>w<=weekOf(new Date()))||options[0];
  $('#week').innerHTML=options.map(w=>`<option value="${w}" ${w===state.week?'selected':''}>${fmt(w+'T12:00Z',{month:'short',day:'numeric',year:'numeric'})}</option>`).join('');
}
function card(g){
  const p=forecast(g),final=g.completed, underway=g.state!=='pre'||new Date(g.kickoff)<=new Date();
  const scores=final?g:p;
  const label=final?'Final':underway?'Started · forecast locked':p?.type==='historical'?'Historical call':p?.type==='analyst'?'Analyst forecast':'Baseline forecast';
  const side=s=>`<div class="team"><span class="abbr">${esc(g[s].abbreviation)}</span><span class="team-name">${esc(g[s].short)}</span><span class="score">${final?esc(g[s].score):esc(scores?.[s]??'—')}</span></div>`;
  let detail=p?`<p>${esc(p.why)}</p><p>Confidence ${esc(p.confidence)}/10 · ${p.type==='analyst'?'Analyst':p.type==='historical'?'Historical import':'Uncalibrated baseline'}</p><p>${p.type==='historical'?'Imported':'Recorded'} ${pretty(p.publishedAt)} ET</p>${p.type==='historical'?'<p>Original screenshot supplied after the week; exact original posting time is not verified and this call is excluded from model grading.</p>':''}${links(p.sources)}`:'<p>No forecast was recorded before kickoff. This game is excluded from the prediction record.</p>';
  if(p&&final) detail=`<p>Pregame call: ${esc(g.away.abbreviation)} ${p.away} · ${esc(g.home.abbreviation)} ${p.home}</p>`+detail;
  if(p?.type==='analyst'&&original(g))detail+=`<p>Original baseline: ${original(g).away}–${original(g).home}. Revisions remain in the public archive.</p>`;
  const m=g.market;
  const validMarket=m?.total!=null && m.spread!=null && Number.isFinite(Number(m.spread));
  const market=validMarket?`<div class="market"><div class="market-head"><strong>${esc(m.provider||'Market')} via ESPN</strong><span>${underway?'Post-start feed':'Game lines'}</span></div><dl><dt>Home spread</dt><dd>${esc(g.home.abbreviation)} ${esc(m.spread)} <span>(${esc(m.spreadOdds??'—')})</span></dd><dt>Total points</dt><dd>${esc(m.total)}</dd><dt>Over / under prices</dt><dd>${esc(m.overOdds??'—')} / ${esc(m.underOdds??'—')}</dd></dl>${!underway&&p?`<div class="comparison"><dl><dt>Market-implied score</dt><dd>${esc(g.away.abbreviation)} ${((Number(m.total)+Number(m.spread))/2).toFixed(1)}<br>${esc(g.home.abbreviation)} ${((Number(m.total)-Number(m.spread))/2).toFixed(1)}</dd><dt>Our total vs. market</dt><dd>${p.home+p.away-Number(m.total)>0?'+':''}${(p.home+p.away-Number(m.total)).toFixed(1)} pts</dd></dl><small>Model difference, not a proven betting edge.</small></div>`:''}${m.spreadOpen||m.totalOpen?`<small>Opening spread: ${esc(m.spreadOpen??'—')} · total: ${esc(String(m.totalOpen??'—').replace(/^[ou]/,''))}</small>`:''}<small>Retrieved ${pretty(state.slate.updatedAt)} ET. ${underway?'Not a verified closing line.':'Source quote time unavailable.'}</small>${!underway&&/^https:\/\//.test(m.link||'')?`<a href="${esc(m.link)}" target="_blank" rel="noopener noreferrer">View game at ${esc(m.provider)} ↗</a>`:''}</div>`:'';
  return `<article class="game"><div class="game-top"><span>${g.timeValid?fmt(g.kickoff,{hour:'numeric',minute:'2-digit'})+' ET':'Time TBD'}</span><span class="tag ${final?'final':''}">${label}</span></div>${side('away')}${side('home')}<div class="game-bottom"><span>${final?'Provider-reported final':p?`Projected total ${p.home+p.away}`:'Forecast pending'}</span><span>${g.neutral?'Neutral site':'@ '+esc(g.home.abbreviation)}</span></div>${market}<details><summary>${final?'Original call & sources':'Why this score'}</summary>${detail}${links([g.source])}</details></article>`;
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
  state.reports.filter(r=>r.league===state.league).sort((a,b)=>a.publishedAt.localeCompare(b.publishedAt)).forEach(r=>(r[kind]||[]).forEach(p=>picks.set(p.id,{...p,publishedAt:r.publishedAt})));
  const map=gameMap();
  return [...picks.values()].filter(p=>(p.gameIds||[]).some(id=>map.has(id)&&weekOf(map.get(id).kickoff)===state.week));
}
function wagerRecord(){
  const rows=[];
  for(const kind of ['props','parlays']){
    const latest=new Map();
    state.reports.filter(r=>r.league===state.league).sort((a,b)=>a.publishedAt.localeCompare(b.publishedAt)).forEach(r=>(r[kind]||[]).forEach(p=>latest.set(p.id,p)));
    const settled=[...latest.values()].filter(p=>p.status==='settled'&&['win','loss','push','void'].includes(p.result));
    const graded=settled.filter(p=>p.result!=='void');
    const units=settled.reduce((sum,p)=>sum+(p.result==='loss'?-1:p.result==='win'?(p.odds>0?p.odds/100:100/Math.abs(p.odds)):0),0);
    rows.push(`<tr><td>${kind==='props'?'Player props':'Parlays'}</td><td>${graded.length}</td><td>${settled.filter(p=>p.result==='win').length}–${settled.filter(p=>p.result==='loss').length}–${settled.filter(p=>p.result==='push').length}</td><td>${graded.length?(units>=0?'+':'')+units.toFixed(2)+'u':'—'}</td><td>${graded.length?(100*units/graded.length).toFixed(1)+'%':'—'}</td></tr>`);
  }
  return `<h3>Hypothetical betting record</h3><p>One unit per published recommendation at its recorded price. W–L–P; voids excluded from stakes. Unverified outcomes remain unsettled. Singles and parlays are tracked separately.</p><div class="record-table"><table><thead><tr><th>Market</th><th>Graded</th><th>W–L–P</th><th>Profit</th><th>ROI</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
function pickStatus(p){
  if(p.status!=='active')return p.status;
  if(new Date(p.expiresAt)<=new Date())return 'expired';
  if((p.gameIds||[]).some(id=>{const g=gameMap().get(id);return !g||g.state!=='pre'||new Date(g.kickoff)<=new Date()}))return 'locked at kickoff';
  return 'active';
}
function pickCard(p,i){
  const status=pickStatus(p);
  return `<article class="pick"><span class="number">${String(i+1).padStart(2,'0')}</span> <span class="tag">${esc(status)}</span><h3>${esc(p.title)}</h3><p><strong>${esc(p.book||'Book not verified')} ${p.odds>0?'+':''}${esc(p.odds||'')}</strong> · Confidence ${esc(p.confidence??'—')}/10</p>${p.projection!=null?`<p>Projected: <strong>${esc(p.projection)}</strong></p>`:''}<p><strong>Why:</strong> ${esc(p.why)}</p><p><strong>Risk:</strong> ${esc(p.risk)}</p>${p.edge?`<p><strong>Estimated edge:</strong> ${esc(p.edge)}</p>`:''}${p.legs?`<p><strong>Legs:</strong> ${p.legs.map(esc).join(' + ')}</p>`:''}${p.correlation?`<p><strong>Correlation:</strong> ${esc(p.correlation)}</p>`:''}<p><strong>Price limit:</strong> ${esc(p.cutoff||'Not actionable')}</p><p>Quote: ${p.quotedAt?pretty(p.quotedAt)+' ET':'Not verified'} · Recorded ${pretty(p.publishedAt)} ET</p>${p.bookLink&&status==='active'?`<p><a href="${esc(p.bookLink)}" target="_blank" rel="noopener noreferrer"><strong>Open verified bet slip at ${esc(p.book)} ↗</strong></a></p>`:''}${p.result?`<p><strong>Result: ${esc(p.result)}</strong> · Actual ${esc(p.actual)}</p>${links([p.resultSource])}`:''}${links(p.sources)}</article>`;
}
function historicalRecord(){
  if(state.league!=='NFL')return '';
  const report=state.reports.find(r=>r.historicalImport&&r.league==='NFL');
  if(!report)return '';
  const picks=report.props||[], scored=picks.filter(p=>p.result==='win'||p.result==='loss'), wins=scored.filter(p=>p.result==='win').length;
  const map=gameMap(), calls=(report.scores||[]).filter(p=>map.get(p.gameId)?.completed);
  const correct=calls.filter(p=>{const g=map.get(p.gameId);return Math.sign(p.home-p.away)===Math.sign(g.home.score-g.away.score)}).length;
  return `<div class="method"><h3>Week 1 screenshot import</h3><p>Imported ${picks.length} player lines and ${calls.length} score calls from the screenshots you supplied. Source pages verify the listed outcomes; original sportsbook, odds, and exact time were not available, so this is a result record only.</p><div class="metrics"><div class="metric"><span>PLAYER RESULTS</span><strong>${scored.length?`${wins}-${scored.length-wins}`:'—'}</strong><span>${picks.filter(p=>p.result==='unverified').length} unverified; no profit calculation</span></div><div class="metric"><span>SCORE WINNERS</span><strong>${correct}/${calls.length}</strong><span>Historical screenshot calls</span></div><div class="metric"><span>ORIGINAL PRICES</span><strong>—</strong><span>Not supplied; no closing-line claim</span></div></div><div class="record-table"><table><thead><tr><th>Player line</th><th>Outcome</th><th>Actual</th></tr></thead><tbody>${picks.map(p=>`<tr><td>${esc(p.title)}</td><td><span class="outcome ${esc(p.result)}">${esc(p.result)}</span></td><td>${esc(p.actual)}</td></tr>`).join('')}</tbody></table></div></div>`;
}
function research(kind){
  const all=latestPicks(kind),active=all.filter(p=>pickStatus(p)==='active');
  const title=kind==='props'?'The number comes first.':'Make every leg earn its place.';
  const text=kind==='props'?'Up to five qualifying props. Fewer when the evidence says pass.':'A best-supported parlay and one speculative longshot, only when priced and researched.';
  const no=kind==='props'?'No active prop card.':'No qualifying parlay published.';
  const reason=kind==='props'?'Live sportsbook quotes and full player research have not been verified for this slate. Baseline score forecasts do not establish a player-prop edge.':'The research desk has not verified a combined sportsbook price and defensible joint assumptions. Adding legs to fill a ticket would not make it a smart parlay.';
  const watch=state.reports.filter(r=>r.league===state.league&&weekOf(r.publishedAt)===state.week).flatMap(r=>r.watch||[]);
  const history=all.filter(p=>p.status==='historical');
  return `<div class="section-head"><div><h2>${title}</h2><p>${text}</p></div><span class="count">${active.length} ACTIVE</span></div>`+(active.length?'':empty(no,reason))+(all.length?`<div class="cards">${all.map(pickCard).join('')}</div>`:'')+(history.length?`<div class="method"><h3>Week 1 imported card</h3><p>These are screenshot-derived historical lines. Prices and exact original timestamps were not supplied, so they are tracked as results only and excluded from hypothetical profit/ROI.</p></div>`:'')+(watch.length?`<div class="method"><h3>Lines to watch</h3><p>Conditional thresholds, not verified available bets.</p><ul>${watch.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></div>`:'');
}
function record(){
  const settled=state.slate.games.filter(g=>g.league===state.league&&g.completed&&original(g)&&new Date(original(g).publishedAt)<new Date(g.kickoff));
  const n=settled.length;
  const margin=n?settled.reduce((s,g)=>{const p=original(g);return s+Math.abs((p.home-p.away)-(g.home.score-g.away.score))},0)/n:null;
  const total=n?settled.reduce((s,g)=>{const p=original(g);return s+Math.abs((p.home+p.away)-(g.home.score+g.away.score))},0)/n:null;
  const wins=settled.filter(g=>Math.sign(original(g).home-original(g).away)===Math.sign(g.home.score-g.away.score)).length;
  return `<div class="section-head"><div><h2>Results & track record</h2><p>${state.league} · historical imports and recorded forecasts shown separately</p></div></div>${historicalRecord()}<div class="section-head"><div><h2>Baseline model record</h2><p>Original forecasts published before kickoff · all ${state.league} weeks</p></div></div><div class="metrics"><div class="metric"><span>GRADED GAMES</span><strong>${n}</strong><span>${n?`${wins}/${n} winner calls correct`:'No settled forecasts yet'}</span></div><div class="metric"><span>MARGIN ERROR</span><strong>${margin?.toFixed(1)??'—'}</strong><span>Mean absolute points</span></div><div class="metric"><span>TOTAL ERROR</span><strong>${total?.toFixed(1)??'—'}</strong><span>Mean absolute points</span></div></div>`+
    (n?`<div class="record-table"><table><thead><tr><th>Game</th><th>Original forecast</th><th>Final</th><th>Recorded ET</th></tr></thead><tbody>${settled.slice().reverse().map(g=>`<tr><td>${esc(g.away.abbreviation)} @ ${esc(g.home.abbreviation)}</td><td>${original(g).away}–${original(g).home}</td><td>${g.away.score}–${g.home.score}</td><td>${pretty(original(g).publishedAt)}</td></tr>`).join('')}</tbody></table></div>`:empty('The record starts before kickoff.','Earlier completed games appear on the scoreboard, but do not count as predictions. No backfilled wins. The first published forecasts will be graded after games finish.'))+
    `<div class="method">${wagerRecord()}<h3>How the baseline works</h3><p>Historical scoring margins update opponent-adjusted team ratings after each completed game. Prior-season ratings regress 35% toward average. Smoothed team game totals set the scoring environment; a small home-field adjustment sets the margin. Scores are rounded, with no claim of exact-score precision.</p><p>This first model is uncalibrated. It does not incorporate current injuries, transfers, starting lineups, weather, or sportsbook prices. Confidence is deliberately low: 3/10 with established history, 2/10 with sparse history. These scores are a starting point for analyst research, not evidence of a betting edge.</p><h3>Research has a higher bar</h3><p>Props need current teams and roles, usage, matchup evidence, independent projections, current sportsbook line and price, and a cutoff. A projected mean above a line is not itself a probability edge. College prop availability must be verified for the relevant jurisdiction.</p><h3>Updates & honest history</h3><p>Schedules and finals refresh three times daily at 10:37, 16:37 and 22:37 UTC. Weekday games are included. Runs can be delayed; this is not a live score service. Analyst research is a separate scheduled task and depends on its host being available. Near-kickoff checks are not guaranteed by the schedule collector.</p><p>Original forecasts remain fixed. Analyst revisions are timestamped separately. Score metrics above grade original baselines only. Props remain unsettled until player statistics are verified; hypothetical one-unit results are separate from real wagers. No paid odds feed is connected.</p><div class="sources"><a href="data/forecasts.json">Download original forecasts ↗</a><a href="data/research.json">Download research archive ↗</a><a href="data/slate.json">Download schedule and finals ↗</a></div></div>`;
}
function render(){
  const opened=[...document.querySelectorAll('#content details')].map((d,i)=>d.open?i:-1).filter(i=>i>=0);
  document.querySelectorAll('[data-league]').forEach(b=>{const selected=b.dataset.league===state.league;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',selected)});
  document.querySelectorAll('[data-view]').forEach(b=>{if(b.dataset.view===state.view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
  const age=(Date.now()-new Date(state.slate.updatedAt))/3600000;
  $('#freshness').textContent=`Feed checked ${pretty(state.slate.updatedAt)} ET`;
  $('#notice').classList.toggle('warn',age>12);
  $('#notice').textContent=age>12?'Source data is more than 12 hours old. Check source links before relying on game times or results.':state.view==='scores'?'Baseline forecasts are live. Game-market comparison is DraftKings when carried by the source; check the timestamp and book before acting.':'Only verified research can become an active recommendation. Expired quotes and games at kickoff are locked automatically.';
  $('#content').innerHTML=state.view==='scores'?scoreboard():state.view==='record'?record():research(state.view);
  document.querySelectorAll('#content details').forEach((d,i)=>{if(opened.includes(i))d.open=true});
}
function navigate(){const view=location.hash.slice(1);state.view=['scores','props','parlays','record'].includes(view)?view:'scores';if(state.slate)render()}
async function init(){
  $('#today').textContent=fmt(new Date(),{weekday:'short',month:'short',day:'numeric',year:'numeric'}).toUpperCase();
  try{
    const values=await Promise.all(['slate','forecasts','research'].map(async f=>{const r=await fetch(`data/${f}.json?refresh=${Date.now()}`,{cache:'no-store'});if(!r.ok)throw new Error('Data unavailable');return r.json()}));
    [state.slate,state.forecasts,state.reports]=values;setupWeeks();navigate();
    document.querySelectorAll('[data-league]').forEach(b=>b.addEventListener('click',()=>{state.league=b.dataset.league;state.query='';state.filter='all';localStorage.setItem('football-league',state.league);setupWeeks();render()}));
    document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{location.hash=b.dataset.view}));
    window.addEventListener('hashchange',navigate);
    $('#content').addEventListener('input',e=>{if(e.target.id==='team-search'){state.query=e.target.value;$('#game-list').innerHTML=gameList()}});
    $('#content').addEventListener('change',e=>{if(e.target.id==='game-filter'){state.filter=e.target.value;$('#game-list').innerHTML=gameList()}});
    $('#week').addEventListener('change',e=>{state.week=e.target.value;render()});
    setInterval(()=>{if(!['INPUT','SELECT'].includes(document.activeElement?.tagName))render()},60000);
  }catch(e){$('#notice').textContent='The latest board could not load. Please refresh or check the public repository.';$('#notice').classList.add('warn');$('#content').innerHTML=empty('Data temporarily unavailable.','No recommendations are displayed while the source files are unavailable.');}
}
init();

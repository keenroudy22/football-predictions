'use strict';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (date, options={}) => new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',...options}).format(new Date(date));
const day = date => fmt(date,{year:'numeric',month:'2-digit',day:'2-digit'}).split('/').map((x,i,a)=>a[[2,0,1][i]]).join('-');
const weekOf = date => {const d = new Date(day(date)+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10)};
const pretty = date => fmt(date,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const links = urls => `<div class="sources">${(urls||[]).filter(u=>/^https:\/\//.test(u)).map((u,i)=>`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">Source ${i+1} ↗</a>`).join('')}</div>`;
let state={league:localStorage.getItem('football-league')||'NFL',view:'scores',week:weekOf(new Date()),query:'',filter:'all',recordScope:'favorites',recordLeague:'NFL',recordWeek:'total',slate:null,forecasts:[],reports:[]};
if(!['NFL','CFB'].includes(state.league)) state.league='NFL';
state.recordLeague=state.league;
const gameMap = () => new Map(state.slate.games.map(g=>[g.id,g]));
const games = () => state.slate.games.filter(g=>g.league===state.league && weekOf(g.kickoff)===state.week);
const original = g => state.forecasts.find(p=>p.gameId===g.id);
const marketPosition = p => p.position || p.playerPosition || 'Other';
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
  let detail=p?`<p>${esc(p.why)}</p><p>${p.confidence!=null?`Confidence ${esc(p.confidence)}/10 · `:''}${p.type==='analyst'?'Analyst':p.type==='historical'?'Historical import':'Uncalibrated baseline'}</p><p>${p.type==='historical'?'Imported':'Recorded'} ${pretty(p.publishedAt)} ET</p>${p.type==='historical'?'<p>Original screenshot supplied after the week; exact original posting time is not verified and this call is excluded from model grading.</p>':''}${links(p.sources)}`:'<p>No forecast was recorded before kickoff. This game is excluded from the prediction record.</p>';
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
  return `<article class="game"><div class="game-top"><span>${g.timeValid?fmt(g.kickoff,{hour:'numeric',minute:'2-digit'})+' ET':'Time TBD'}</span><span class="tag ${final?'final':''}">${label}</span></div>${side('away')}${side('home')}<div class="game-bottom"><span>${final?'Provider-reported final':p?`Projected total ${p.home+p.away}`:'Forecast pending'}</span><span>${g.neutral?'Neutral site':'@ '+esc(g.home.abbreviation)}</span></div>${market}${movement}<details><summary>Open full game breakdown</summary><h4>Score and total outlook</h4>${detail}${takeawayList?`<h4>Research takeaways</h4><ul class="takeaways">${takeawayList}</ul>`:''}<h4>Player props by position</h4><ul>${insight}</ul><p>Injury, usage, matchup and player-form notes appear only when verified in the published research.</p>${links([g.source])}</details></article>`;
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
function wagerRecord(){
  const map=gameMap(), all=FootballRecords.latest(state.reports).filter(p=>{
    const w=FootballRecords.week(p,map);
    return w&&(state.recordLeague==='All'||p.league===state.recordLeague)&&(state.recordWeek==='total'||`${w.season}-${w.week}`===state.recordWeek)&&(state.recordScope==='all'||FootballRecords.favorite(p));
  });
  const options=[...new Set(FootballRecords.latest(state.reports).map(p=>FootballRecords.week(p,map)).filter(Boolean).filter(w=>state.recordLeague==='All'||w.league===state.recordLeague).map(w=>`${w.season}-${w.week}`))].sort((a,b)=>b.localeCompare(a,{numeric:true}));
  const select=(id,label,values,current)=>`<label>${label}<select id="${id}">${values.map(([v,t])=>`<option value="${esc(v)}" ${v===current?'selected':''}>${esc(t)}</option>`).join('')}</select></label>`;
  const filters=`<div class="record-filters">${select('record-scope','Record',[['favorites','Daily favorites'],['all','All official picks']],state.recordScope)}${select('record-league','League',[['NFL','NFL'],['CFB','CFB'],['All','Combined']],state.recordLeague)}${select('record-week','Period',[['total','Season total'],...options.map(x=>[x,`${x.split('-')[0]} · Week ${x.split('-')[1]}`])],state.recordWeek)}</div>`;
  const line=(name,picks)=>{const s=FootballRecords.summarize(picks),i=FootballRecords.illustrative(picks),mark=i.assumedWins?'≈':'';return `<tr><th scope="row">${name}</th><td>${s.wins}–${s.losses}–${s.pushes}</td><td>${s.hitRate==null?'—':s.hitRate.toFixed(1)+'%'}</td><td>${s.pending}</td><td>${i.units==null?'—':`${mark}${i.units>=0?'+':''}${i.units.toFixed(2)}u`}</td><td>${i.roi==null?'—':`${mark}${i.roi.toFixed(1)}%`}</td><td>${s.graded}</td></tr>`};
  const groups=['Straights','Risky lines','Parlays','Longshots'];
  const rows=[line(state.recordScope==='favorites'?'Daily favorites':'All official selections',all),...groups.map(group=>line(group,all.filter(p=>FootballRecords.category(p)===group)))].join('');
  const pending=all.filter(p=>!['win','loss','push','void'].includes(p.result));
  const unpriced=all.filter(p=>['win','loss'].includes(p.result)&&!FootballRecords.validOdds(p.originalOdds)).length;
  const label=p=>{const g=(p.gameIds||[]).map(id=>map.get(id)).find(Boolean);return p.settlementState==='checking_rules'?'Checking original book rules':g?.completed?'Awaiting final stats':g?.state==='in'?'In progress':'Awaiting kickoff'};
  const pickRows=all.map(p=>{const priced=FootballRecords.validOdds(p.originalOdds),estimated=p.result==='win'&&!priced,u=p.result==='win'?FootballRecords.profit(priced?p.originalOdds:-110):p.result==='loss'?-1:['push','void'].includes(p.result)?0:null;return `<tr><td>${esc(p.title)}${FootballRecords.favorite(p)?' <span class="tag">Favorite</span>':''}</td><td>${esc(FootballRecords.category(p))}</td><td>${esc(p.result==='unverified'?label(p):p.result||label(p))}</td><td>${priced?`${p.originalOdds>0?'+':''}${esc(p.originalOdds)} ${esc(p.originalBook||'')}`:'—'}</td><td>${u==null?'—':`${estimated?'≈':''}${u>=0?'+':''}${u.toFixed(2)}u`}</td><td>${links([p.resultSource])}</td></tr>`}).join('');
  return `<h3>Official pick record</h3><p>Every published play is tracked at 1 unit risked. Hit rate excludes pushes, voids and pending picks. A favorite appears in the overall record once.</p>${filters}<div class="record-table"><table><thead><tr><th>Type</th><th>W–L–P</th><th>Hit</th><th>Pending</th><th>1u net</th><th>1u ROI</th><th>Graded</th></tr></thead><tbody>${rows}</tbody></table></div><p class="record-note">≈ marks an illustrative return: missing original winning prices use −110; recorded prices are used where available. ${unpriced} graded result${unpriced===1?'':'s'} lack original odds. Losses are −1u regardless of price. These are estimates, not verified historical profit or actual wagers.</p>${all.length?`<h4>Selections in this view</h4><div class="record-table"><table><thead><tr><th>Pick</th><th>Type</th><th>Result</th><th>Original price</th><th>1u net</th><th>Source</th></tr></thead><tbody>${pickRows}</tbody></table></div>`:''}${pending.length?`<h4>Settlement queue</h4><ul class="settlement-list">${pending.map(p=>`<li><strong>${esc(p.title)}</strong> · ${esc(label(p))}${p.lastCheckedAt?` · Checked ${pretty(p.lastCheckedAt)} ET`:''}${p.nextReviewAt?` · Next review ${pretty(p.nextReviewAt)} ET`:''}<br>${esc(p.actual||'Final player statistics pending')}${links([p.resultSource])}</li>`).join('')}</ul>`:''}`;
}
function pickStatus(p){
  if(p.status!=='active')return p.status;
  if(new Date(p.expiresAt)<=new Date())return 'expired';
  if((p.gameIds||[]).some(id=>{const g=gameMap().get(id);return !g||g.state!=='pre'||new Date(g.kickoff)<=new Date()}))return 'locked at kickoff';
  return 'active';
}
function pickCard(p,i){
  const status=pickStatus(p);
  const result=p.result==='unverified'?(p.settlementState==='checking_rules'?'Checking original book rules':'Awaiting verified settlement'):p.result||status;
  const calc=FootballRecords.validOdds(p.odds)?`<div class="calculator" data-odds="${esc(p.odds)}"><strong>Payout preview · quoted ${p.quotedAt?pretty(p.quotedAt)+' ET':'time unknown'}</strong><label>Amount <input class="calc-amount" type="number" min="0.01" step="0.01" value="1"></label><label>Risk as <select class="calc-mode"><option value="units">Units</option><option value="money">Dollars</option></select></label><label>Dollar value of 1 unit <input class="calc-unit" type="number" min="0.01" step="0.01" value="10"></label><p class="calc-output" aria-live="polite"></p></div>`:'';
  const rate=x=>x&&Number.isInteger(x.hits)&&Number.isInteger(x.sample)&&x.sample>0&&x.hits>=0&&x.hits<=x.sample?`${x.hits}/${x.sample} · ${(100*x.hits/x.sample).toFixed(0)}%`:null;
  const form5=rate(p.recentForm?.last5),form10=rate(p.recentForm?.last10);
  const form=form5||form10?`<div class="recent-form"><strong>Recent hit rate</strong><span>${form5?`Last 5: ${form5}`:''}${form5&&form10?' · ':''}${form10?`Last 10: ${form10}`:''}</span>${p.recentForm?.stat?`<small>${esc(p.recentForm.stat)}</small>`:''}${p.recentForm?.source?`<a href="${esc(p.recentForm.source)}" target="_blank" rel="noopener noreferrer">Game log ↗</a>`:''}</div>`:status==='active'?`<div class="recent-form pending"><strong>Recent hit rate</strong><span>Game-log verification pending</span></div>`:'';
  const books=Array.isArray(p.books)?p.books.filter(x=>x&&x.book&&FootballRecords.validOdds(x.odds)).sort((a,b)=>Number(b.odds)-Number(a.odds)):[];
  const priceNote=books.length?`<p class="price-board"><strong>Best verified price:</strong> ${esc(books[0].book)} ${books[0].odds>0?'+':''}${esc(books[0].odds)}${books.length>1?` · ${books.length} books checked`:''}</p>`:'';
  const closeNote=p.closingLine||p.closingOdds!=null?`<p class="closing-note"><strong>Closing-line check:</strong> ${esc(p.closingLine||`${p.closingOdds>0?'+':''}${p.closingOdds}`)}${p.closingValue?` · ${esc(p.closingValue)}`:''}</p>`:'';
  return `<article class="pick ${p.kind==='riskyProps'?'risky-pick':''}"><span class="number">${String(i+1).padStart(2,'0')}</span> <span class="tag">${esc(result)}</span>${p.kind==='riskyProps'?'<span class="risk-badge">RISKY LINE</span>':''}<h3>${esc(p.title)}</h3><p><strong>${esc(p.book||'Book not verified')} ${p.odds>0?'+':''}${esc(p.odds||'')}</strong> · Confidence ${esc(p.confidence??'—')}/10</p>${priceNote}${p.projection!=null?`<p>Projected: <strong>${esc(p.projection)}</strong></p>`:''}${form}${closeNote}<p><strong>Why:</strong> ${esc(p.why)}</p><p><strong>Risk:</strong> ${esc(p.risk)}</p>${p.edge?`<p><strong>Estimated edge:</strong> ${esc(p.edge)}</p>`:''}${p.legs?`<p><strong>Legs:</strong> ${p.legs.map(esc).join(' + ')}</p>`:''}${p.correlation?`<p><strong>Correlation:</strong> ${esc(p.correlation)}</p>`:''}<p><strong>Price limit:</strong> ${esc(p.cutoff||'Not actionable')}</p><p>Quote: ${p.quotedAt?pretty(p.quotedAt)+' ET':'Not verified'} · Recorded ${pretty(p.publishedAt)} ET</p>${p.bookLink&&status==='active'?`<p><a href="${esc(p.bookLink)}" target="_blank" rel="noopener noreferrer"><strong>Open verified bet slip at ${esc(p.book)} ↗</strong></a></p>`:''}${p.result?`<p><strong>Result: ${esc(result)}</strong> · Actual ${esc(p.actual)}</p>${p.lastCheckedAt?`<p>Checked ${pretty(p.lastCheckedAt)} ET · Next review ${pretty(p.nextReviewAt)} ET</p>`:''}${links([p.resultSource])}`:''}${calc}${links(p.sources)}</article>`;
}
function historicalRecord(){
  if(state.league!=='NFL')return '';
  const report=state.reports.find(r=>r.historicalImport&&r.league==='NFL');
  if(!report)return '';
  const picks=(report.props||[]).filter(p=>FootballRecords.favorite(p)), scored=picks.filter(p=>p.result==='win'||p.result==='loss'), wins=scored.filter(p=>p.result==='win').length;
  const map=gameMap(), calls=(report.scores||[]).filter(p=>map.get(p.gameId)?.completed);
  const correct=calls.filter(p=>{const g=map.get(p.gameId);return Math.sign(p.home-p.away)===Math.sign(g.home.score-g.away.score)}).length;
  const estimate=FootballRecords.illustrative(picks);
  return `<div class="method"><h3>Week 1 original favorites</h3><p>The explicit “My final five” screenshot defines this card. Other shared lines remain in All official picks. Original odds and exact posting times were not supplied.</p><div class="metrics"><div class="metric"><span>FAVORITE LINES</span><strong>${wins}–${scored.length-wins}</strong><span>${scored.length?`${(100*wins/scored.length).toFixed(1)}% hit rate`:''}</span></div><div class="metric"><span>SCORE WINNERS</span><strong>${correct}/${calls.length}</strong><span>Historical screenshot calls</span></div><div class="metric"><span>1U NET ESTIMATE</span><strong>${estimate.units==null?'—':`≈${estimate.units>=0?'+':''}${estimate.units.toFixed(2)}u`}</strong><span>${estimate.roi==null?'':`≈${estimate.roi.toFixed(1)}% ROI at assumed −110`}</span></div></div><div class="record-table"><table><thead><tr><th>Player line</th><th>Outcome</th><th>Actual</th></tr></thead><tbody>${picks.map(p=>`<tr><td>${esc(p.title)}</td><td><span class="outcome ${esc(p.result)}">${esc(p.result)}</span></td><td>${esc(p.actual)}</td></tr>`).join('')}</tbody></table></div></div>`;
}
function research(kind){
  const all=latestPicks(kind),active=all.filter(p=>pickStatus(p)==='active');
  const title=kind==='props'?'The number comes first.':'Make every leg earn its place.';
  const text=kind==='props'?'Up to five qualifying props. Fewer when the evidence says pass.':'A best-supported parlay and one speculative longshot, only when priced and researched.';
  const no=kind==='props'?'No active prop card.':'No qualifying parlay published.';
  const reason=kind==='props'?'Live sportsbook quotes and full player research have not been verified for this slate. Baseline score forecasts do not establish a player-prop edge.':'The research desk has not verified a combined sportsbook price and defensible joint assumptions. Adding legs to fill a ticket would not make it a smart parlay.';
  const watch=state.reports.filter(r=>r.league===state.league&&weekOf(r.publishedAt)===state.week).flatMap(r=>r.watch||[]);
  const history=all.filter(p=>p.status==='historical'),core=all.filter(p=>p.kind!=='riskyProps'),risky=all.filter(p=>p.kind==='riskyProps');
  const coreActive=core.filter(p=>pickStatus(p)==='active'),riskyActive=risky.filter(p=>pickStatus(p)==='active');
  const takeaways=state.reports.filter(r=>r.league===state.league&&weekOf(r.publishedAt)===state.week).at(-1)?.takeaways||[];
  const takeawayBlock=takeaways.length?`<section class="takeaway-panel"><h3>Research takeaways</h3><ul>${takeaways.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></section>`:'';
  const positionCards=Object.entries(core.reduce((o,p)=>{(o[marketPosition(p)]??=[]).push(p);return o},{})).map(([pos,items])=>`<section class="position-group"><h3>${esc(pos)}</h3><div class="cards">${items.map(pickCard).join('')}</div></section>`).join('');
  const cards=kind==='props'?`${positionCards}${risky.length?`<section class="risky-lines"><div class="section-head"><div><h3>Risky lines</h3><p>Higher-variance props and longshot-style player outcomes. They are tracked separately from the main card.</p></div><span class="count">${riskyActive.length} ACTIVE</span></div><div class="cards">${risky.map(pickCard).join('')}</div></section>`:''}`:all.length?`<div class="cards">${all.map(pickCard).join('')}</div>`:'';
  return `<div class="section-head"><div><h2>${title}</h2><p>${text}</p></div><span class="count">${kind==='props'?coreActive.length:active.length} ACTIVE</span></div>`+takeawayBlock+(kind==='props'&&!coreActive.length?empty(no,reason):kind!=='props'&&!active.length?empty(no,reason):'')+cards+(history.length?`<div class="method"><h3>Week 1 imported card</h3><p>These are screenshot-derived historical lines. Original prices and exact posting times were not supplied. The results page shows illustrative 1-unit returns at assumed −110 for missing winning prices.</p></div>`:'')+(watch.length?`<div class="method"><h3>Lines to watch</h3><p>Conditional thresholds, not verified available bets.</p><ul>${watch.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></div>`:'');
}
function record(){
  const settled=state.slate.games.filter(g=>(state.recordLeague==='All'||g.league===state.recordLeague)&&(state.recordWeek==='total'||`${g.season}-${g.league==='CFB'&&g.week===1&&new Date(g.kickoff)<new Date(`${g.season}-09-01T00:00:00Z`)?0:g.week}`===state.recordWeek)&&g.completed&&original(g)&&new Date(original(g).publishedAt)<new Date(g.kickoff));
  const n=settled.length;
  const margin=n?settled.reduce((s,g)=>{const p=original(g);return s+Math.abs((p.home-p.away)-(g.home.score-g.away.score))},0)/n:null;
  const total=n?settled.reduce((s,g)=>{const p=original(g);return s+Math.abs((p.home+p.away)-(g.home.score+g.away.score))},0)/n:null;
  const wins=settled.filter(g=>Math.sign(original(g).home-original(g).away)===Math.sign(g.home.score-g.away.score)).length;
  return `<div class="section-head"><div><h2>Results & track record</h2><p>Favorite picks, all official selections, and score forecasts</p></div></div>${wagerRecord()}${state.recordLeague==='NFL'&&state.recordScope==='favorites'&&(state.recordWeek==='total'||state.recordWeek==='2026-1')?historicalRecord():''}<div class="section-head"><div><h2>Baseline model record</h2><p>Original forecasts published before kickoff · ${state.recordLeague==='All'?'NFL + CFB':state.recordLeague} · ${state.recordWeek==='total'?'season total':state.recordWeek}</p></div></div><div class="metrics"><div class="metric"><span>GRADED GAMES</span><strong>${n}</strong><span>${n?`${wins}/${n} winner calls correct · ${(100*wins/n).toFixed(1)}%`:'No settled forecasts yet'}</span></div><div class="metric"><span>MARGIN ERROR</span><strong>${margin?.toFixed(1)??'—'}</strong><span>Mean absolute points</span></div><div class="metric"><span>TOTAL ERROR</span><strong>${total?.toFixed(1)??'—'}</strong><span>Mean absolute points</span></div></div>`+
    (n?`<div class="record-table"><table><thead><tr><th>Game</th><th>Original forecast</th><th>Final</th><th>Recorded ET</th></tr></thead><tbody>${settled.slice().reverse().map(g=>`<tr><td>${esc(g.away.abbreviation)} @ ${esc(g.home.abbreviation)}</td><td>${original(g).away}–${original(g).home}</td><td>${g.away.score}–${g.home.score}</td><td>${pretty(original(g).publishedAt)}</td></tr>`).join('')}</tbody></table></div>`:empty('The record starts before kickoff.','Earlier completed games appear on the scoreboard, but do not count as predictions. No backfilled wins. The first published forecasts will be graded after games finish.'))+
    `<div class="method"><h3>How the baseline works</h3><p>Historical scoring margins update opponent-adjusted team ratings after each completed game. Prior-season ratings regress 35% toward average. Smoothed team game totals set the scoring environment; a small home-field adjustment sets the margin. Scores are rounded, with no claim of exact-score precision.</p><p>This first model is uncalibrated. It does not incorporate current injuries, transfers, starting lineups, weather, or sportsbook prices. Confidence is deliberately low: 3/10 with established history, 2/10 with sparse history. These scores are a starting point for analyst research, not evidence of a betting edge.</p><h3>Research has a higher bar</h3><p>Props need current teams and roles, usage, matchup evidence, independent projections, current sportsbook line and price, and a cutoff. A projected mean above a line is not itself a probability edge. College prop availability must be verified for the relevant jurisdiction.</p><h3>Updates & honest history</h3><p>Schedules and finals refresh three times daily, plus postgame windows. Weekday games are included. Runs can be delayed; this is not a live score service. Research checks depend on the local host being available. Near-kickoff checks are not guaranteed.</p><p>Original forecasts remain fixed. Analyst revisions are timestamped separately. Score metrics above grade original baselines only. Player statistics and sportsbook settlement are verified separately. Returns represent hypothetical one-unit stakes, never actual wagers. Missing historical winning prices use an illustrative −110 assumption, marked ≈.</p></div>`;
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
  document.querySelectorAll('.calculator').forEach(updateCalculator);
}
function updateCalculator(box){
  const amount=Number(box.querySelector('.calc-amount').value), unit=Number(box.querySelector('.calc-unit').value), mode=box.querySelector('.calc-mode').value;
  const output=box.querySelector('.calc-output');
  if(!(amount>0&&unit>0)){output.textContent='Enter a positive amount and unit value.';return}
  const stake=mode==='units'?amount*unit:amount, gain=FootballRecords.profit(box.dataset.odds,stake);
  output.textContent=`Risk $${stake.toFixed(2)} · Profit if it wins $${gain.toFixed(2)} · Total return $${(stake+gain).toFixed(2)}. Example only; check the current book price.`;
}
function navigate(){const view=location.hash.slice(1);state.view=['scores','props','parlays','record'].includes(view)?view:'scores';if(state.slate)render()}
async function init(){
  $('#today').textContent=fmt(new Date(),{weekday:'short',month:'short',day:'numeric',year:'numeric'}).toUpperCase();
  try{
    const values=await Promise.all(['slate','forecasts','research'].map(async f=>{const r=await fetch(`data/${f}.json?refresh=${Date.now()}`,{cache:'no-store'});if(!r.ok)throw new Error('Data unavailable');return r.json()}));
    [state.slate,state.forecasts,state.reports]=values;setupWeeks();navigate();
    document.querySelectorAll('[data-league]').forEach(b=>b.addEventListener('click',()=>{state.league=b.dataset.league;state.recordLeague=state.league;state.query='';state.filter='all';localStorage.setItem('football-league',state.league);setupWeeks();render()}));
    document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{location.hash=b.dataset.view}));
    window.addEventListener('hashchange',navigate);
    $('#content').addEventListener('input',e=>{if(e.target.id==='team-search'){state.query=e.target.value;$('#game-list').innerHTML=gameList()}else if(e.target.closest('.calculator'))updateCalculator(e.target.closest('.calculator'))});
    $('#content').addEventListener('change',e=>{if(e.target.id==='game-filter'){state.filter=e.target.value;$('#game-list').innerHTML=gameList()}else if(['record-scope','record-league','record-week'].includes(e.target.id)){state[{"record-scope":"recordScope","record-league":"recordLeague","record-week":"recordWeek"}[e.target.id]]=e.target.value;render()}else if(e.target.closest('.calculator'))updateCalculator(e.target.closest('.calculator'))});
    $('#week').addEventListener('change',e=>{state.week=e.target.value;render()});
    setInterval(()=>{if(!['INPUT','SELECT'].includes(document.activeElement?.tagName))render()},60000);
  }catch(e){$('#notice').textContent='The latest board could not load. Please refresh or check the public repository.';$('#notice').classList.add('warn');$('#content').innerHTML=empty('Data temporarily unavailable.','No recommendations are displayed while the source files are unavailable.');}
}
init();

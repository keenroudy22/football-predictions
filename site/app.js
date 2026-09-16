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
let state={league:localStorage.getItem('football-league')||'NFL',view:'scores',week:weekOf(new Date()),query:'',filter:'all',propGame:'all',propPosition:'all',recordScope:'favorites',recordLeague:'NFL',recordWeek:'total',slate:null,forecasts:[],reports:[],history:null};
if(!['NFL','CFB'].includes(state.league)) state.league='NFL';
state.recordLeague=state.league;
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
function forecast(g){
  const revisions=state.reports.filter(r=>r.league===g.league && (r.historicalImport || new Date(r.publishedAt)<new Date(g.kickoff))).flatMap(r=>(r.scores||[]).filter(p=>p.gameId===g.id).map(p=>({...p,publishedAt:r.publishedAt,type:r.historicalImport?'historical':'analyst',historicalImport:r.historicalImport})));
  return revisions.sort((a,b)=>a.publishedAt.localeCompare(b.publishedAt)).at(-1)||original(g);
}
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
  const pickBlocks=grouped.length?grouped.map(([pos,items])=>`<section class="position-group"><h3>${esc(pos)}</h3><div class="cards">${items.map(pickCard).join('')}</div></section>`).join(''):'<p>No verified official player props have been published for this game.</p>';
  const lastVs=picks.filter(x=>x.recentForm?.lastVsOpponent).map(x=>`<li><strong>${esc(x.title)}</strong> · ${esc(x.recentForm.lastVsOpponent.value)} ${esc(x.recentForm.stat||'')} · ${esc(x.recentForm.lastVsOpponent.date)}${links([x.recentForm.lastVsOpponent.source])}</li>`).join('');
  const meetings=state.slate.games.filter(x=>x.id!==g.id&&x.completed&&x.league===g.league&&new Date(x.kickoff)<new Date(g.kickoff)&&[x.home.id,x.away.id].includes(g.home.id)&&[x.home.id,x.away.id].includes(g.away.id)).sort((a,b)=>b.kickoff.localeCompare(a.kickoff)).slice(0,3);
  const meetingsBlock=meetings.length?meetings.map(x=>`<li>${fmt(x.kickoff,{month:'short',day:'numeric',year:'numeric'})}: ${esc(x.away.abbreviation)} ${esc(x.away.score)} · ${esc(x.home.abbreviation)} ${esc(x.home.score)}${links([x.source])}</li>`).join(''):'<li>No earlier meeting is available in the current public game feed.</li>';
  const contexts=state.history?.defenses?.[g.id]||{};
  const defensePanel=Object.keys(contexts).length?`<section class="game-panel"><h3>Last game against each defense · by position</h3><p>Actual positional box-score totals in the defense’s most recent game. These are single-game context, not a hit rate or a forecast; the opposing players and game script may differ.</p><div class="game-page-grid">${['away','home'].filter(side=>contexts[side]).map(side=>{const x=contexts[side],labels={passingYards:'passing yards',passingAttempts:'pass attempts',completions:'completions',rushingAttempts:'carries',rushingYards:'rushing yards',receptions:'receptions',receivingYards:'receiving yards'};return `<div><h4>${esc(g[side].name)} defense · ${esc(x.date)}</h4><p>Against ${esc(x.opponent)}</p><ul>${Object.entries(x.positions).map(([pos,stats])=>`<li><strong>${esc(pos)}</strong>: ${Object.entries(stats).map(([key,value])=>`${esc(value)} ${esc(labels[key]||key)}`).join(' · ')}</li>`).join('')}</ul>${links([x.source])}</div>`}).join('')}</div><small>Data checked ${pretty(state.history.updatedAt)} ET · ESPN box scores</small></section>`:'<section class="game-panel"><h3>Last game against each defense · by position</h3><p>Position-level box-score verification is pending for this matchup.</p></section>';
  const snapshots=(g.marketHistory||[]).filter(x=>x.phase==='pregame');
  const movement=snapshots.length>1?`<p>Observed pregame snapshots: spread ${esc(snapshots[0].spread)} → ${esc(snapshots.at(-1).spread)}; total ${esc(snapshots[0].total)} → ${esc(snapshots.at(-1).total)}. Retrieved ${pretty(snapshots[0].retrievedAt)} and ${pretty(snapshots.at(-1).retrievedAt)} ET. Source quote times unavailable.</p>`:'<p>Comparable pregame movement snapshots are unavailable.</p>';
  return `<div class="game-page"><a class="back-board" href="#scores">← Back to ${esc(g.league)} Week ${footballWeek(g)} board</a><div class="game-hero"><p class="eyebrow">${esc(g.league)} · WEEK ${footballWeek(g)} · ${g.timeValid?fmt(g.kickoff,{weekday:'long',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' ET':'TIME TBD'}</p><h2>${esc(g.away.name)} at ${esc(g.home.name)}</h2><div class="game-scoreline"><div><small>${g.completed?'FINAL SCORE':'PREDICTED SCORE'}</small><strong>${g.completed?`${g.away.abbreviation} ${g.away.score} · ${g.home.abbreviation} ${g.home.score}`:score}</strong></div><div><small>PREDICTED TOTAL</small><strong>${total??'—'}</strong></div><div><small>FORECAST STATUS</small><strong class="forecast-stage">${p?.type==='analyst'?'Reviewed':p?.type==='historical'?'Historical import':p?'Early · research pending':'Pending'}</strong></div></div><p>${p?esc(p.why):'No forecast was recorded before kickoff.'}</p><p>Forecast recorded ${p?pretty(p.publishedAt)+' ET':'—'} · Source data checked ${pretty(state.slate.updatedAt)} ET</p></div><div class="game-page-grid"><section class="game-panel"><h3>Score, spread & total</h3><dl><dt>Projected score</dt><dd>${esc(score)}</dd><dt>Projected margin</dt><dd>${margin==null?'—':`${esc(g.home.abbreviation)} ${margin>0?'+':''}${margin}`}</dd><dt>Projected total</dt><dd>${total??'—'}</dd><dt>Sportsbook home spread</dt><dd>${marketReady?`${esc(g.home.abbreviation)} ${esc(m.spread)} (${esc(m.spreadOdds||'—')})`:'Unavailable'}</dd><dt>Sportsbook O/U total</dt><dd>${m?.total!=null?`${esc(m.total)} · O ${esc(m.overOdds||'—')} / U ${esc(m.underOdds||'—')}`:'Unavailable'}</dd><dt>Projected O/U direction</dt><dd>${totalDirection}</dd><dt>Forecast vs market total</dt><dd>${totalGap==null?'—':`${totalGap>0?'+':''}${totalGap.toFixed(1)} pts`}</dd><dt>Forecast vs market spread</dt><dd>${spreadGap==null?'—':`${spreadGap>0?'+':''}${spreadGap.toFixed(1)} pts`}</dd></dl><p class="record-note">Forecast differences are context, not official spread or total picks. ${started?'Current game feed is post-start; it is not a verified closing quote.':'Check the book and timestamp before acting.'}</p></section><section class="game-panel"><h3>Market movement & matchup</h3>${movement}<p>Specific injuries, starters, weather, usage and defensive matchup findings appear here only after sourced analyst review.</p>${links([g.source,p?.sources?.[0]])}</section></div><section class="game-panel"><h3>Lines we’re watching</h3>${candidates.size?[...candidates.values()].map(w=>`<article class="watch-entry"><span class="tag">Research watch · not an official pick</span><h4>${esc(w.title)}</h4><p>${esc(w.why)}</p><p><strong>Before a pick:</strong> ${esc(w.needs)}</p><small>Recorded ${pretty(w.publishedAt)} ET · recheck current prices</small>${links(w.sources)}</article>`).join(''):'<p>No game-specific player market has cleared the early research screen.</p>'}</section><section class="game-panel"><h3>Player props by position</h3>${pickBlocks}</section>${defensePanel}<div class="game-page-grid"><section class="game-panel"><h3>Last 5–10 games</h3><p>Exact-market game history and charts appear on each researched prop above when verified. No player averages or hit rates are inferred from the score forecast.</p></section><section class="game-panel"><h3>Last game against this opponent</h3>${lastVs?`<ul>${lastVs}</ul>`:'<p>No verified player-specific prior meeting is attached to the published props.</p>'}<h4>Recent team meetings</h4><ul>${meetingsBlock}</ul></section></div></div>`;
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
  const calibrated=all.filter(p=>['win','loss'].includes(p.result)&&Number.isFinite(Number(p.confidence)));
  const bands=[['7–10',p=>p.confidence>=7],['5–6',p=>p.confidence>=5&&p.confidence<7],['1–4',p=>p.confidence<5]];
  const calibration=calibrated.length?`<h4>Confidence calibration</h4><div class="record-table"><table><thead><tr><th>Confidence</th><th>W–L</th><th>Hit rate</th><th>Sample</th></tr></thead><tbody>${bands.map(([name,test])=>{const picks=calibrated.filter(test),wins=picks.filter(p=>p.result==='win').length;return `<tr><th scope="row">${name}/10</th><td>${wins}–${picks.length-wins}</td><td>${picks.length?(100*wins/picks.length).toFixed(1)+'%':'—'}</td><td>${picks.length}</td></tr>`}).join('')}</tbody></table></div><p class="record-note">Confidence becomes informative only after a meaningful out-of-sample history; small groups are descriptive, not proof of an edge.</p>`:'';
  return `<h3>Official pick record</h3><p>Every published play is tracked at 1 unit risked. Hit rate excludes pushes, voids and pending picks. A favorite appears in the overall record once.</p>${filters}<div class="record-table"><table><thead><tr><th>Type</th><th>W–L–P</th><th>Hit</th><th>Pending</th><th>1u net</th><th>1u ROI</th><th>Graded</th></tr></thead><tbody>${rows}</tbody></table></div><p class="record-note">≈ marks an illustrative return: missing original winning prices use −110; recorded prices are used where available. ${unpriced} graded result${unpriced===1?'':'s'} lack original odds. Losses are −1u regardless of price. These are estimates, not verified historical profit or actual wagers.</p>${all.length?`<h4>Selections in this view</h4><div class="record-table"><table><thead><tr><th>Pick</th><th>Type</th><th>Result</th><th>Original price</th><th>1u net</th><th>Source</th></tr></thead><tbody>${pickRows}</tbody></table></div>`:''}${calibration}${pending.length?`<h4>Settlement queue</h4><ul class="settlement-list">${pending.map(p=>`<li><strong>${esc(p.title)}</strong> · ${esc(label(p))}${p.lastCheckedAt?` · Checked ${pretty(p.lastCheckedAt)} ET`:''}${p.nextReviewAt?` · Next review ${pretty(p.nextReviewAt)} ET`:''}<br>${esc(p.actual||'Final player statistics pending')}${links([p.resultSource])}</li>`).join('')}</ul>`:''}`;
}
function pickStatus(p){
  if(p.status!=='active')return p.status;
  if(new Date(p.expiresAt)<=new Date())return 'expired';
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
function pickCard(p,i){
  const status=pickStatus(p);
  const result=p.result==='unverified'?(p.settlementState==='checking_rules'?'Checking original book rules':'Awaiting verified settlement'):p.result||status;
  const calc=FootballRecords.validOdds(p.odds)?`<div class="calculator" data-odds="${esc(p.odds)}"><strong>Payout preview · quoted ${p.quotedAt?pretty(p.quotedAt)+' ET':'time unknown'}</strong><label>Amount <input class="calc-amount" type="number" min="0.01" step="0.01" value="1"></label><label>Risk as <select class="calc-mode"><option value="units">Units</option><option value="money">Dollars</option></select></label><label>Dollar value of 1 unit <input class="calc-unit" type="number" min="0.01" step="0.01" value="10"></label><p class="calc-output" aria-live="polite"></p></div>`:'';
  const rate=x=>x&&Number.isInteger(x.hits)&&Number.isInteger(x.sample)&&x.sample>0&&x.hits>=0&&x.hits<=x.sample?`${x.hits}/${x.sample} · ${(100*x.hits/x.sample).toFixed(0)}%`:null;
  const form5=rate(p.recentForm?.last5),form10=rate(p.recentForm?.last10);
  const chart=formChart(p.recentForm);
  const form=form5||form10||chart?`<div class="recent-form"><strong>Recent hit rate</strong><span>${form5?`Last 5: ${form5}`:''}${form5&&form10?' · ':''}${form10?`Last 10: ${form10}`:''}</span>${p.recentForm?.stat?`<small>${esc(p.recentForm.stat)}</small>`:''}${chart}${p.recentForm?.source?`<a href="${esc(p.recentForm.source)}" target="_blank" rel="noopener noreferrer">Game log ↗</a>`:''}</div>`:status==='active'?`<div class="recent-form pending"><strong>Recent hit rate</strong><span>Game-log verification pending</span></div>`:'';
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
  const urgency=p.hot===true?`<div class="hot-clock"><strong>Early value</strong><span>${status==='active'&&p.expiresAt?`Recheck by ${pretty(p.expiresAt)} ET`:'The original number is no longer marked current'}</span></div>`:'';
  return `<article class="pick ${p.kind==='riskyProps'?'risky-pick':''} ${p.hot===true?'hot-pick':''}"><span class="number">${String(i+1).padStart(2,'0')}</span> <span class="tag">${esc(result)}</span>${p.hot===true?'<span class="hot-badge">HOT PICK</span>':''}${FootballRecords.favorite(p)?'<span class="tag favorite-label">DAILY FAVORITE</span>':''}${p.fun===true?'<span class="fun-badge">FUN MARKET</span>':''}${p.kind==='riskyProps'?'<span class="risk-badge">RISKY LINE</span>':''}${window}<h3>${esc(p.title)}</h3>${urgency}<p><strong>${esc(p.book||'Book not verified')} ${p.odds>0?'+':''}${esc(p.odds||'')}</strong> · Confidence ${esc(p.confidence??'—')}/10</p>${priceNote}${p.projection!=null?`<p>Projected: <strong>${esc(p.projection)}</strong></p>`:''}${form}${usageNote}${formDetail}${priorNote}${gameLink}${closeNote}${moveNote}<p><strong>Why:</strong> ${esc(p.why)}</p><p><strong>Risk:</strong> ${esc(p.risk)}</p>${p.edge?`<p><strong>Estimated edge:</strong> ${esc(p.edge)}</p>`:''}${p.legs?`<p><strong>Legs:</strong> ${p.legs.map(esc).join(' + ')}</p>`:''}${p.correlation?`<p><strong>Correlation:</strong> ${esc(p.correlation)}</p>`:''}<p><strong>Price limit:</strong> ${esc(p.cutoff||'Not actionable')}</p><p>Quote: ${p.quotedAt?pretty(p.quotedAt)+' ET':'Not verified'} · Recorded ${pretty(p.publishedAt)} ET</p>${p.bookLink&&status==='active'?`<p><a href="${esc(p.bookLink)}" target="_blank" rel="noopener noreferrer"><strong>Open verified bet slip at ${esc(p.book)} ↗</strong></a></p>`:''}${p.result?`<p><strong>Result: ${esc(result)}</strong> · Actual ${esc(p.actual)}</p>${p.lastCheckedAt?`<p>Checked ${pretty(p.lastCheckedAt)} ET${p.nextReviewAt?` · Next review ${pretty(p.nextReviewAt)} ET`:''}</p>`:''}${links([p.resultSource])}`:''}${calc}${links(p.sources)}</article>`;
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
  const allUnfiltered=latestPicks(kind);
  const gameOptions=games().slice().sort((a,b)=>a.kickoff.localeCompare(b.kickoff));
  const positionOptions=[...new Set(allUnfiltered.map(marketPosition))].sort();
  if(state.propGame!=='all'&&!gameOptions.some(g=>g.id===state.propGame))state.propGame='all';
  if(state.propPosition!=='all'&&!positionOptions.includes(state.propPosition))state.propPosition='all';
  const all=kind==='props'?allUnfiltered.filter(p=>(state.propGame==='all'||(p.gameIds||[]).includes(state.propGame))&&(state.propPosition==='all'||marketPosition(p)===state.propPosition)):allUnfiltered;
  const active=all.filter(p=>pickStatus(p)==='active');
  const title=kind==='props'?'The number comes first.':'Make every leg earn its place.';
  const text=kind==='props'?'Up to five qualifying props. Fewer when the evidence says pass.':'A best-supported parlay and one speculative longshot, only when priced and researched.';
  const no=kind==='props'?'No active prop card.':'No qualifying parlay published.';
  const reason=kind==='props'?'Live sportsbook quotes and full player research have not been verified for this slate. Baseline score forecasts do not establish a player-prop edge.':'The research desk has not verified a combined sportsbook price and defensible joint assumptions. Adding legs to fill a ticket would not make it a smart parlay.';
  const selectedOfficialWeek=[...new Set(games().map(footballWeek))][0];
  const selectedReports=state.reports.filter(r=>r.league===state.league&&(Number.isInteger(r.targetWeek)?r.targetWeek===selectedOfficialWeek:weekOf(r.publishedAt)===state.week));
  const watch=selectedReports.flatMap(r=>r.watch||[]);
  const history=all.filter(p=>p.status==='historical'),core=all.filter(p=>p.kind!=='riskyProps'),risky=all.filter(p=>p.kind==='riskyProps');
  const hot=core.filter(p=>p.hot===true),favorites=core.filter(p=>FootballRecords.favorite(p)&&p.hot!==true),otherCore=core.filter(p=>!FootballRecords.favorite(p)&&p.hot!==true);
  const fun=risky.filter(p=>p.fun===true),otherRisky=risky.filter(p=>p.fun!==true);
  const watchItems=new Map();selectedReports.forEach(r=>(r.gameWatch||[]).filter(w=>state.propGame==='all'||w.gameId===state.propGame).forEach(w=>watchItems.set(w.id,{...w,publishedAt:r.publishedAt})));
  const coreActive=core.filter(p=>pickStatus(p)==='active'),riskyActive=risky.filter(p=>pickStatus(p)==='active');
  const takeaways=selectedReports.at(-1)?.takeaways||[];
  const takeawayBlock=takeaways.length?`<section class="takeaway-panel"><h3>Research takeaways</h3><ul>${takeaways.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></section>`:'';
  const stage=coreActive.length?'official':watch.length?'watch':'waiting';
  const lifecycle=`<section class="research-lifecycle" aria-label="Research status"><div class="lifecycle-step ${stage==='watch'||stage==='official'?'done':''}"><span>1</span><strong>Market watch</strong><small>Game lines and slate context</small></div><div class="lifecycle-step ${stage==='official'?'done':''}"><span>2</span><strong>Player screen</strong><small>Role, injury, usage and matchup</small></div><div class="lifecycle-step ${stage==='official'?'done':''}"><span>3</span><strong>Official card</strong><small>Exact line, price and cutoff</small></div><div class="lifecycle-step"><span>4</span><strong>Settlement</strong><small>Stats, closing line and review</small></div></section>`;
  const positionCards=Object.entries(otherCore.reduce((o,p)=>{(o[marketPosition(p)]??=[]).push(p);return o},{})).map(([pos,items])=>`<section class="position-group"><h4>${esc(pos)}</h4><div class="cards">${items.map(pickCard).join('')}</div></section>`).join('');
  const hotCards=hot.length?`<section class="hot-lines"><div class="section-head"><div><p class="eyebrow">EARLY NUMBER RADAR</p><h3>Hot picks</h3><p>Qualified early value posted immediately. Check the quote time, expiration and playable limit before acting.</p></div><span class="count">${hot.filter(p=>pickStatus(p)==='active').length} ACTIVE</span></div><div class="cards">${hot.map(pickCard).join('')}</div></section>`:'';
  const favoriteCards=favorites.length?`<section class="favorite-lines"><div class="section-head"><div><h3>Daily favorites</h3><p>Selected when published. Hot picks that also qualify as favorites appear above and count once.</p></div><span class="count">${core.filter(FootballRecords.favorite).length} LINES</span></div><div class="cards">${favorites.map(pickCard).join('')}</div></section>`:'';
  const funCards=fun.length?`<section class="fun-lines"><div class="section-head"><div><h3>Fun markets · 1Q, 1H, TDs and alternates</h3><p>Higher-variance plays with a verified price and a specific reason. Tracked separately at 1 unit.</p></div><span class="count">${fun.filter(p=>pickStatus(p)==='active').length} ACTIVE</span></div><div class="cards">${fun.map(pickCard).join('')}</div></section>`:'';
  const cards=kind==='props'?`${hotCards}${favoriteCards}${otherCore.length?`<section class="all-lines"><div class="section-head"><div><h3>Other official player lines · by position</h3><p>All remaining published selections for this week, including historical imports. Picks shown above count once in the ${all.length}-line official total.</p></div><span class="count">${otherCore.length} LINES</span></div>${positionCards}</section>`:''}${funCards}${otherRisky.length?`<section class="risky-lines"><div class="section-head"><div><h3>Risky lines</h3><p>Higher-variance props and longshot-style player outcomes. They are tracked separately from the main card.</p></div><span class="count">${otherRisky.filter(p=>pickStatus(p)==='active').length} ACTIVE</span></div><div class="cards">${otherRisky.map(pickCard).join('')}</div></section>`:''}`:all.length?`<div class="cards">${all.map(pickCard).join('')}</div>`:'';
  const watchCards=kind==='props'&&watchItems.size?`<section class="watch-list"><h3>Game markets under review</h3><p>These are research candidates, not official player bets. Open a game to see the score, O/U and defensive position breakdown.</p><ul>${[...watchItems.values()].map(w=>`<li><strong><a href="#game/${esc(w.gameId)}">${esc(w.title)} →</a></strong><br>${esc(w.why)}<br><small>Still needed: ${esc(w.needs)} · recorded ${pretty(w.publishedAt)} ET</small>${links(w.sources)}</li>`).join('')}</ul></section>`:'';
  const propFilters=kind==='props'?`<div class="prop-filters" aria-label="Player prop filters"><label>Game<select id="prop-game"><option value="all">All games</option>${gameOptions.map(g=>`<option value="${esc(g.id)}" ${state.propGame===g.id?'selected':''}>${esc(g.away.abbreviation)} @ ${esc(g.home.abbreviation)} · ${fmt(g.kickoff,{month:'short',day:'numeric'})}</option>`).join('')}</select></label><label>Position<select id="prop-position"><option value="all">All positions</option>${positionOptions.map(pos=>`<option value="${esc(pos)}" ${state.propPosition===pos?'selected':''}>${esc(pos)}</option>`).join('')}</select></label><button id="clear-prop-filters" type="button" ${state.propGame==='all'&&state.propPosition==='all'?'disabled':''}>Clear filters</button></div>`:'';
  const filterSummary=kind==='props'&&all.length!==allUnfiltered.length?`Showing ${all.length} of ${allUnfiltered.length} official player lines for this week`:`${all.length} official player line${all.length===1?'':'s'} for this week`;
  return `<div class="section-head"><div><h2>${title}</h2><p>${text}</p>${kind==='props'?`<p>${filterSummary} · ${favorites.length} daily favorite${favorites.length===1?'':'s'} shown · ${coreActive.length+riskyActive.length} currently active. Position groups and exact-market logs appear below when verified.</p>`:''}</div><span class="count">${kind==='props'?coreActive.length:active.length} ACTIVE</span></div>`+propFilters+(kind==='props'?lifecycle:'')+takeawayBlock+(kind==='props'&&!all.length?empty('No props match these filters.','Choose another game or position, or clear the filters to see the complete weekly board.'):kind==='props'&&!coreActive.length?empty(no,reason):kind!=='props'&&!active.length?empty(no,reason):'')+cards+watchCards+(history.length?`<div class="method"><h3>Week 1 imported card</h3><p>These are screenshot-derived historical lines. Original prices and exact posting times were not supplied. The results page shows illustrative 1-unit returns at assumed −110 for missing winning prices.</p></div>`:'')+(watch.length?`<div class="method"><h3>Lines to watch</h3><p>Conditional thresholds, not verified available bets.</p><ul>${watch.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></div>`:'');
}
function record(){
  const settled=state.slate.games.filter(g=>(state.recordLeague==='All'||g.league===state.recordLeague)&&(state.recordWeek==='total'||`${g.season}-${g.league==='CFB'&&g.week===1&&new Date(g.kickoff)<new Date(`${g.season}-09-01T00:00:00Z`)?0:g.week}`===state.recordWeek)&&g.completed&&original(g)&&new Date(original(g).publishedAt)<new Date(g.kickoff));
  const n=settled.length;
  const margin=n?settled.reduce((s,g)=>{const p=original(g);return s+Math.abs((p.home-p.away)-(g.home.score-g.away.score))},0)/n:null;
  const total=n?settled.reduce((s,g)=>{const p=original(g);return s+Math.abs((p.home+p.away)-(g.home.score+g.away.score))},0)/n:null;
  const wins=settled.filter(g=>Math.sign(original(g).home-original(g).away)===Math.sign(g.home.score-g.away.score)).length;
  const reviews=state.reports.filter(r=>(state.recordLeague==='All'||r.league===state.recordLeague)&&r.weeklyReview).slice(-4).reverse();
  const reviewBlock=reviews.length?`<section class="takeaway-panel"><h3>Weekly takeaways</h3>${reviews.map(r=>{const items=Array.isArray(r.weeklyReview)?r.weeklyReview:r.weeklyReview?.takeaways||[r.weeklyReview];return `<h4>${esc(r.league)} · ${pretty(r.publishedAt)} ET</h4><ul>${items.filter(Boolean).map(x=>`<li>${esc(typeof x==='string'?x:x.text||JSON.stringify(x))}</li>`).join('')}</ul>`}).join('')}</section>`:'';
  return `<div class="section-head"><div><h2>Results & track record</h2><p>Favorite picks, all official selections, and score forecasts</p></div></div>${wagerRecord()}${reviewBlock}${state.recordLeague==='NFL'&&state.recordScope==='favorites'&&(state.recordWeek==='total'||state.recordWeek==='2026-1')?historicalRecord():''}<div class="section-head"><div><h2>Baseline model record</h2><p>Original forecasts published before kickoff · ${state.recordLeague==='All'?'NFL + CFB':state.recordLeague} · ${state.recordWeek==='total'?'season total':state.recordWeek}</p></div></div><div class="metrics"><div class="metric"><span>GRADED GAMES</span><strong>${n}</strong><span>${n?`${wins}/${n} winner calls correct · ${(100*wins/n).toFixed(1)}%`:'No settled forecasts yet'}</span></div><div class="metric"><span>MARGIN ERROR</span><strong>${margin?.toFixed(1)??'—'}</strong><span>Mean absolute points</span></div><div class="metric"><span>TOTAL ERROR</span><strong>${total?.toFixed(1)??'—'}</strong><span>Mean absolute points</span></div></div>`+
    (n?`<div class="record-table"><table><thead><tr><th>Game</th><th>Original forecast</th><th>Final</th><th>Recorded ET</th></tr></thead><tbody>${settled.slice().reverse().map(g=>`<tr><td>${esc(g.away.abbreviation)} @ ${esc(g.home.abbreviation)}</td><td>${original(g).away}–${original(g).home}</td><td>${g.away.score}–${g.home.score}</td><td>${pretty(original(g).publishedAt)}</td></tr>`).join('')}</tbody></table></div>`:empty('The record starts before kickoff.','Earlier completed games appear on the scoreboard, but do not count as predictions. No backfilled wins. The first published forecasts will be graded after games finish.'))+
    `<div class="method"><h3>How the baseline works</h3><p>Historical scoring margins update opponent-adjusted team ratings after each completed game. Prior-season ratings regress 35% toward average. Smoothed team game totals set the scoring environment; a small home-field adjustment sets the margin. Scores are rounded, with no claim of exact-score precision.</p><p>This first model is uncalibrated. It does not incorporate current injuries, transfers, starting lineups, weather, or sportsbook prices. Confidence is deliberately low: 3/10 with established history, 2/10 with sparse history. These scores are a starting point for analyst research, not evidence of a betting edge.</p><h3>Research has a higher bar</h3><p>Props need current teams and roles, usage, matchup evidence, independent projections, current sportsbook line and price, and a cutoff. A projected mean above a line is not itself a probability edge. College prop availability must be verified for the relevant jurisdiction.</p><h3>Updates & honest history</h3><p>Schedules and finals refresh three times daily, plus postgame windows. Weekday games are included. Runs can be delayed; this is not a live score service. Research checks depend on the local host being available. Near-kickoff checks are not guaranteed.</p><p>Original forecasts remain fixed. Analyst revisions are timestamped separately. Score metrics above grade original baselines only. Player statistics and sportsbook settlement are verified separately. Returns represent hypothetical one-unit stakes, never actual wagers. Missing historical winning prices use an illustrative −110 assumption, marked ≈.</p></div>`;
}
function render(){
  const opened=[...document.querySelectorAll('#content details')].map((d,i)=>d.open?i:-1).filter(i=>i>=0);
  document.querySelectorAll('[data-league]').forEach(b=>{const selected=b.dataset.league===state.league;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',selected)});
  document.querySelectorAll('[data-view]').forEach(b=>{if(b.dataset.view===state.view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
  const source=(state.slate.sources||[]).find(s=>s.league===state.league);
  const checkedAt=source?.retrievedAt||state.slate.updatedAt;
  const age=(Date.now()-new Date(checkedAt))/3600000;
  const failed=source?.fetchStatus==='failed';
  const recovered=source?.fetchMethod==='verified season-week union';
  $('#freshness').textContent=failed?`${state.league} source unavailable · last successful ${pretty(checkedAt)} ET`:`Feed checked ${pretty(checkedAt)} ET`;
  $('#notice').classList.toggle('warn',failed||age>12);
  $('#notice').textContent=failed?`ESPN schedule update failed at ${pretty(source.lastAttemptAt)} ET. Showing the last verified slate; current game status and quotes may be stale.`:age>12?'Source data is more than 12 hours old. Check source links before relying on game times or results.':recovered?`${state.league==='CFB'?'College games were combined across FBS conferences':'NFL games were checked by week'} and compared with the saved slate. ESPN season/week feed checked ${pretty(checkedAt)} ET; sportsbook quotes need their own timestamps.`:state.view==='scores'?'Baseline forecasts are live. Game-market comparison is DraftKings when carried by the source; check the timestamp and book before acting.':'Only verified research can become an active recommendation. Expired quotes and games at kickoff are locked automatically.';
  $('#content').innerHTML=state.view==='game'?(gameMap().get(decodeURIComponent(location.hash.slice(6)))?gamePage(gameMap().get(decodeURIComponent(location.hash.slice(6)))):empty('Game unavailable.','The saved game link no longer matches the current feed.')):state.view==='scores'?scoreboard():state.view==='record'?record():research(state.view);
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
function navigate(){const view=location.hash.slice(1);state.view=view.startsWith('game/')?'game':['scores','props','parlays','record'].includes(view)?view:'scores';if(state.view==='game'){const g=gameMap().get(decodeURIComponent(view.slice(5)));if(g){state.league=g.league;state.week=weekOf(g.kickoff);setupWeeks()}}else if($('#week')?.value&&state.week!==$('#week').value){state.week=$('#week').value}if(state.slate)render()}
async function init(){
  $('#today').textContent=fmt(new Date(),{weekday:'short',month:'short',day:'numeric',year:'numeric'}).toUpperCase();
  try{
    const values=await Promise.all(['slate','forecasts','research'].map(async f=>{const r=await fetch(`data/${f}.json?refresh=${Date.now()}`,{cache:'no-store'});if(!r.ok)throw new Error('Data unavailable');return r.json()}));
    [state.slate,state.forecasts,state.reports]=values;
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
    setupWeeks();navigate();
    document.querySelectorAll('[data-league]').forEach(b=>b.addEventListener('click',()=>{state.league=b.dataset.league;state.recordLeague=state.league;state.query='';state.filter='all';state.propGame='all';state.propPosition='all';localStorage.setItem('football-league',state.league);setupWeeks();render()}));
    document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{location.hash=b.dataset.view;navigate()}));
    window.addEventListener('hashchange',navigate);
    document.addEventListener('click',e=>{if(e.target.id==='clear-prop-filters'){state.propGame='all';state.propPosition='all';render();return}const a=e.target.closest('a[href^="#"]');if(!a)return;const route=a.getAttribute('href').slice(1);if(route.startsWith('game/')||['scores','props','parlays','record'].includes(route)){e.preventDefault();location.hash=route;navigate()}});
    $('#content').addEventListener('input',e=>{if(e.target.id==='team-search'){state.query=e.target.value;$('#game-list').innerHTML=gameList()}else if(e.target.closest('.calculator'))updateCalculator(e.target.closest('.calculator'))});
    $('#content').addEventListener('change',e=>{if(e.target.id==='game-filter'){state.filter=e.target.value;$('#game-list').innerHTML=gameList()}else if(e.target.id==='prop-game'){state.propGame=e.target.value;render()}else if(e.target.id==='prop-position'){state.propPosition=e.target.value;render()}else if(['record-scope','record-league','record-week'].includes(e.target.id)){state[{"record-scope":"recordScope","record-league":"recordLeague","record-week":"recordWeek"}[e.target.id]]=e.target.value;render()}else if(e.target.closest('.calculator'))updateCalculator(e.target.closest('.calculator'))});
    const setWeek=e=>{state.week=e.target.value;state.propGame='all';state.propPosition='all';render()};
    $('#week').addEventListener('change',setWeek);
    $('#week').addEventListener('input',setWeek);
    setInterval(()=>{if(!['INPUT','SELECT'].includes(document.activeElement?.tagName))render()},60000);
  }catch(e){$('#notice').textContent='The latest board could not load. Please refresh or check the public repository.';$('#notice').classList.add('warn');$('#content').innerHTML=empty('Data temporarily unavailable.','No recommendations are displayed while the source files are unavailable.');}
}
init();


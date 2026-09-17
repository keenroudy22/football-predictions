'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const script=fs.readFileSync(path.join(root,'site','app.js'),'utf8').replace(/\binit\(\);\s*$/,'');
const context={FootballRecords:require(path.join(root,'site','records.js')),localStorage:{getItem:()=>null},Intl,Date};
vm.createContext(context);
vm.runInContext(script+'\n globalThis.testAPI={pickCard,parlayBoard,research,state,playerMovement,workloadPanel,builderEligible,compatibleTicket,ticketText,americanToDecimal,decimalToAmerican,weekOf};',context);

// Keep assertions about initially visible content independent of nested research disclosures.
function disclosure(html,className){
  const opening=new RegExp('<details\\b[^>]*class="[^"]*\\b'+className+'\\b[^"]*"[^>]*>').exec(html);
  assert.ok(opening,`Expected ${className} disclosure`);
  const tags=/<\/?details\b[^>]*>/g;
  tags.lastIndex=opening.index+opening[0].length;
  let depth=1,closing;
  for(let tag;(tag=tags.exec(html));){
    depth+=tag[0].startsWith('</')?-1:1;
    if(depth===0){closing=tag;break;}
  }
  assert.ok(closing,'Expected balanced nested disclosures');
  return {opening:opening[0],inside:html.slice(opening.index+opening[0].length,closing.index),outside:html.slice(0,opening.index)+html.slice(closing.index+closing[0].length)};
}

function compactFixture(extra={}){
  const api=context.testAPI;
  const game={id:'compact-game',league:'NFL',season:2099,week:2,state:'pre',completed:false,kickoff:'2099-09-17T23:00:00Z',away:{abbreviation:'DET',name:'Detroit'},home:{abbreviation:'BUF',name:'Buffalo'}};
  Object.assign(api.state,{slate:{games:[game]},reports:[],history:null,league:'NFL',week:api.weekOf(game.kickoff),propGame:'all',propPosition:'all',parlaySelected:new Set()});
  return {id:'compact-official',title:'Example Receiver OVER 4.5 receptions',kind:'props',position:'WR',status:'active',favorite:true,result:'pending',book:'DraftKings',odds:116,projection:5.8,confidence:7,quotedAt:new Date(Date.now()-60000).toISOString(),publishedAt:new Date(Date.now()-60000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),cutoff:'Over 4.5 through -115; pass at 5.5',quickWhy:'Stable route role supports the projection.',why:'Detailed source-backed receiving research.',risk:'A lower pass volume could reduce targets.',gameIds:[game.id],sources:['https://example.com/research'],...extra};
}

test('hot and fun market metadata is visible with an expiry check',()=>{
  const html=context.testAPI.pickCard({id:'early',title:'Player OVER 3.5 first-quarter carries',kind:'riskyProps',status:'active',hot:true,fun:true,marketWindow:'1Q',odds:-110,book:'Example',quotedAt:'2099-09-16T12:00:00Z',expiresAt:'2099-09-16T13:00:00Z',publishedAt:'2099-09-16T12:00:00Z',confidence:6,projection:4.4,cutoff:'Over 3.5 through -120',why:'Verified early role.',risk:'Small window.',sources:[],gameIds:[]});
  assert.match(html,/HOT PICK/);
  assert.match(html,/FUN MARKET/);
  assert.match(html,/>1Q</);
  assert.match(html,/Recheck by/);
});

test('historical void with no next review renders without an invalid date',()=>{
  const p={id:'scratch',title:'Brock Bowers OVER 60 receiving yards',kind:'props',status:'historical',
    result:'void',actual:'Out',lastCheckedAt:'2026-09-14T18:36:00Z',nextReviewAt:null,
    publishedAt:'2026-09-14T12:00:00Z',why:'Imported',risk:'Scratch',sources:[],
    resultSource:'https://www.espn.com/nfl/game/_/gameId/401872928'};
  const html=context.testAPI.pickCard(p);
  assert.match(html,/Checked Sep 14/);
  assert.doesNotMatch(html,/Next review/);
});

test('the entire Week 1 official prop archive shows favorites first',()=>{
  const slate=JSON.parse(fs.readFileSync(path.join(root,'site','data','slate.json')));
  const reports=JSON.parse(fs.readFileSync(path.join(root,'site','data','research.json')));
  const history=JSON.parse(fs.readFileSync(path.join(root,'site','data','player-history.json')));
  for(const r of reports)for(const p of r.props||[]){
    const h=history.picks[p.id];if(h){p.gameIds=p.gameIds?.length?p.gameIds:[h.gameId];p.position=h.position;p.recentForm=h.recentForm}
  }
  const state=context.testAPI.state;
  state.slate=slate;state.reports=reports;state.history=history;state.league='NFL';state.week='2026-09-08';
  const html=context.testAPI.research('props');
  assert.match(html,/27 official player lines for this week · 5 daily favorites/);
  assert.ok(html.indexOf('Daily favorites')<html.indexOf('Other official player lines'));
  assert.ok(html.indexOf('Colston Loveland OVER 50.5')<html.indexOf('Jalen Coker OVER 38.5'));
  assert.match(html,/Brock Bowers OVER 60 receiving yards/);
});

test('player props can be filtered by game and position',()=>{
  const slate=JSON.parse(fs.readFileSync(path.join(root,'site','data','slate.json')));
  const reports=JSON.parse(fs.readFileSync(path.join(root,'site','data','research.json')));
  const history=JSON.parse(fs.readFileSync(path.join(root,'site','data','player-history.json')));
  for(const r of reports)for(const p of r.props||[]){const h=history.picks[p.id];if(h){p.gameIds=p.gameIds?.length?p.gameIds:[h.gameId];p.position=h.position}}
  const state=context.testAPI.state;state.slate=slate;state.reports=reports;state.history=history;state.league='NFL';state.week='2026-09-08';state.propGame='all';state.propPosition='QB';
  const byPosition=context.testAPI.research('props');
  assert.match(byPosition,/id="prop-game"/);assert.match(byPosition,/id="prop-position"/);assert.match(byPosition,/Showing \d+ of 27 official player lines/);assert.doesNotMatch(byPosition,/Colston Loveland OVER 50.5/);
  state.propPosition='all';state.propGame='NFL-401872929';
  const byGame=context.testAPI.research('props');
  assert.match(byGame,/Showing \d+ of 27 official player lines/);assert.match(byGame,/Jayden Daniels UNDER 200/);assert.doesNotMatch(byGame,/Lamar Jackson OVER 35/);
});

const leg=(extra={})=>({id:'a',title:'Player OVER 3.5 receptions',kind:'props',status:'active',book:'DraftKings',odds:-110,gameIds:['future-a'],quotedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),cutoff:'Through 4.5',...extra});
test('ticket estimates require same book and distinct games',()=>{
 const api=context.testAPI;api.state.slate.games.push(...['future-a','future-b'].map(id=>({id,state:'pre',kickoff:'2099-01-01',away:{abbreviation:'AWY'},home:{abbreviation:'HME'}}))); 
 assert.equal(api.compatibleTicket([leg(),leg({id:'b',gameIds:['future-b']})]),true);
 assert.equal(api.compatibleTicket([leg(),leg({id:'b'})]),false);
 assert.equal(api.compatibleTicket([leg(),leg({id:'b',book:'FanDuel',gameIds:['future-b']})]),false);
 assert.equal(api.compatibleTicket([leg()]),false);
});
test('stale, unpriced and invalid quotes cannot enter tickets',()=>{
 for(const extra of [{expiresAt:null},{expiresAt:'2000-01-01'},{odds:null},{book:' '},{quotedAt:'2099-01-01'},{status:'historical'}]) assert.equal(context.testAPI.builderEligible(leg(extra)),false);
});
test('ticket text preserves price and cutoff and uses actual line breaks',()=>{
 const text=context.testAPI.ticketText([leg()]);
 assert.match(text,/DraftKings -110/);assert.match(text,/limit: Through 4.5/);assert.equal(text.split('\n').length,3);
 assert.equal(context.testAPI.decimalToAmerican(2*2),300);
 assert.equal(context.testAPI.americanToDecimal(-200),1.5);
});


test('expired early picks never retain an actionable Hot Pick badge',()=>{
 const html=context.testAPI.pickCard({id:'old',title:'Old early line',kind:'props',hot:true,status:'active',expiresAt:'2000-01-01',publishedAt:'2000-01-01',gameIds:[],sources:[]},0);
 assert.doesNotMatch(html,/class="hot-badge"/);
});

test('early looks respect position and game filters without entering official counts',()=>{
  const state=context.testAPI.state;
  state.slate=JSON.parse(fs.readFileSync(path.join(root,'site/data/slate.json')));
  state.reports=[JSON.parse(fs.readFileSync(path.join(root,'research/2026-09-17-NFL-week-2-early-player-look.json')))];
  state.league='NFL';state.week='2026-09-15';state.propGame='NFL-401872932';state.propPosition='RB';
  const html=context.testAPI.research('props');
  assert.match(html,/0 official player lines/);
  assert.match(html,/Reference line: 3.5 receptions/);
  assert.match(html,/Offensive-line health/);
  assert.match(html,/Blocking performance/);
  assert.match(html,/Not a live sportsbook quote/);
  assert.equal(context.FootballRecords.latest(state.reports).length,0);
  state.propGame=state.slate.games.find(g=>g.league==='NFL'&&g.week===2&&g.id!=='NFL-401872932').id;
  assert.doesNotMatch(context.testAPI.research('props'),/Reference line: 3.5 receptions/);
});

test('player snapshots preserve revisions and reject post-start observations',()=>{
 const state=context.testAPI.state;
 const g={id:'test-game',kickoff:'2026-09-17T20:00:00Z'};state.slate={games:[g]};
 const quote={book:'Book A',market:'receptions',window:'Full game',direction:'OVER',line:3.5,odds:-110,observedAt:'2026-09-16T12:00:00Z',source:'https://example.com/quote'};
 state.reports=[{gameWatch:[{id:'watch',marketSnapshots:[quote]}]}];
 const html=context.testAPI.playerMovement({id:'watch',gameId:g.id,marketSnapshots:[quote,{...quote,line:4.5,observedAt:'2026-09-17T12:00:00Z'},{...quote,line:99,observedAt:'2026-09-17T21:00:00Z'}]});
 assert.match(html,/observations · 2/);assert.match(html,/3.5/);assert.match(html,/4.5/);assert.doesNotMatch(html,/>99/);assert.match(html,/Unknown. No sourced cause/);
});
test('workload does not invent averages when fewer games are available',()=>{
 const html=context.testAPI.workloadPanel({games:[{label:'Week 1',workload:{touches:34,rushingAttempts:29,receptions:5}}]});
 assert.match(html,/34/);assert.match(html,/Touches/);assert.match(html,/5-game avg/);assert.match(html,/<td>—<\/td>/);
});

test('compact official cards keep the recommendation and original quote visible',()=>{
  const p=compactFixture();
  const html=context.testAPI.pickCard(p,0,{compact:true});
  assert.doesNotMatch(html,/<details\b/);
  assert.match(html,/aria-label="Example Receiver OVER 4\.5 receptions"/);
  for(const value of ['DraftKings','+116','5.8','7/10','Over 4.5 through -115; pass at 5.5',p.quickWhy])assert.ok(html.includes(value),`${value} must be visible on the card`);
  const quoteTime=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(p.quotedAt));
  assert.ok(html.includes(quoteTime),'The original quote timestamp stays visible');
  assert.match(html,/data-parlay-pick="compact-official"/);
  assert.match(html,/href="#players"/,'Without a verified profile the card links to the directory');
});

test('compact picks link to player research instead of embedding charts and long details',()=>{
  const p=compactFixture({athleteId:'111',recentForm:{stat:'receptions',line:4.5,last5:{hits:3,sample:5},last10:{hits:6,sample:10},source:'https://example.com/log',games:Array.from({length:10},(_,i)=>({label:`Verified game ${i+1}`,value:i%2?6:3,hit:i%2===1,source:'https://example.com/box',workload:{receptions:i%2?6:3,receivingTargets:8}}))}});
  let requested;
  context.window={KeenPlayers:{hrefFor:(pick,state)=>{requested={pick,state};return '#player/NFL/111';}}};
  const html=context.testAPI.pickCard(p,0,{compact:true});
  delete context.window;
  assert.equal(requested.pick,p);assert.equal(requested.state,context.testAPI.state);
  assert.match(html,/href="#player\/NFL\/111"/);
  assert.doesNotMatch(html,/<figure\b|<details\b|Detailed source-backed receiving research|lower pass volume|Player workload|class="calculator"/);
  assert.ok(p.recentForm.games.length===10,'The compact view preserves the underlying research data');
});

test('expired and locked quote availability stays distinct from pending settlement',()=>{
  const expired=compactFixture({expiresAt:'2000-01-01T00:00:00Z'});
  const expiredHTML=context.testAPI.pickCard(expired,0,{compact:true});
  assert.match(expiredHTML,/Quote expired/);
  assert.doesNotMatch(expiredHTML,/pending/i);
  assert.equal(expired.result,'pending');
  assert.doesNotMatch(expiredHTML,/data-parlay-pick=/);
  assert.equal(context.testAPI.builderEligible(expired),false);
  const started=compactFixture({expiresAt:'2000-01-01T00:00:00Z'});
  context.testAPI.state.slate.games[0].state='in';
  const lockedHTML=context.testAPI.pickCard(started,0,{compact:true});
  assert.match(lockedHTML,/Locked at kickoff/);
  assert.doesNotMatch(lockedHTML,/pending/i);
  assert.equal(started.result,'pending');
  assert.doesNotMatch(lockedHTML,/data-parlay-pick=/);
  assert.equal(context.testAPI.builderEligible(started),false);
});

test('an entry pause prevents adding a quoted pick to a ticket without erasing it',()=>{
  const p=compactFixture({entryNote:'Entries paused pending an injury update.'});
  const html=context.testAPI.pickCard(p,0,{compact:true});
  assert.match(html,/Entries paused/);
  assert.match(html,/aria-label="Example Receiver OVER 4\.5 receptions"/);
  assert.doesNotMatch(html,/data-parlay-pick=/);
  assert.equal(context.testAPI.builderEligible(p),false,'A direct builder call must honor the same entry pause as the card');
});

test('watch research starts closed and does not hide or inflate official favorites',()=>{
  const p=compactFixture({expiresAt:'2000-01-01T00:00:00Z'});
  const state=context.testAPI.state;
  state.reports=[{league:'NFL',targetWeek:2,publishedAt:p.publishedAt,props:[p],gameWatch:[{id:'only-watch',gameId:'compact-game',position:'WR',title:'Research-only receiver',lineLabel:'Waiting for a line',why:'Candidate research only',sources:[]}]}];
  const html=context.testAPI.research('props');
  const watch=disclosure(html,'picks-watch');
  assert.doesNotMatch(watch.opening,/\sopen(?:\s|=|>)/);
  assert.match(watch.inside,/Research-only receiver/);
  assert.doesNotMatch(watch.outside,/Research-only receiver/);
  assert.match(watch.outside,/1 official player line for this week · 1 daily favorite/);
  assert.match(watch.outside,/aria-label="Example Receiver OVER 4\.5 receptions"/);
  assert.match(watch.outside,/Quote expired/);
  assert.match(watch.outside,/Daily favorites/);
  assert.equal(context.FootballRecords.latest(state.reports).length,1);
});

test('map callbacks retain the full card outside the compact Picks page',()=>{
  const p=compactFixture();
  const [html]=[p].map(context.testAPI.pickCard);
  assert.match(html,/Example Receiver OVER 4\.5 receptions/);
  assert.doesNotMatch(html,/class="[^"]*\bpick-compact\b/);
});

test('compact team colors require a matching game team and a safe verified color',()=>{
  const p=compactFixture({athleteId:'111'}),state=context.testAPI.state;
  Object.assign(state.slate.games[0].away,{id:'away-team'});
  Object.assign(state.slate.games[0].home,{id:'home-team'});
  const identity={athleteId:'111',league:'NFL',status:'ok',team:{id:'home-team',color:'#005A9C'}};
  state.identities={players:{'NFL/111':identity}};
  assert.match(context.testAPI.pickCard(p,0,{compact:true}),/--pick-team-color:#005A9C/);
  identity.team.id='different-team';
  assert.doesNotMatch(context.testAPI.pickCard(p,0,{compact:true}),/--pick-team-color/);
  identity.team.id='home-team';
  for(const color of ['#fff','005A9C;display:none','" onmouseover="alert(1)',null]){
    identity.team.color=color;
    assert.doesNotMatch(context.testAPI.pickCard(p,0,{compact:true}),/--pick-team-color/);
  }
  identity.team.color='#005A9C';identity.status='stale';
  assert.doesNotMatch(context.testAPI.pickCard(p,0,{compact:true}),/--pick-team-color/);
  delete state.identities;
});

test('published parlay expands to a numbered card with all four exact legs and individual form',()=>{
  const report=JSON.parse(fs.readFileSync(path.join(root,'research','2026-09-17-NFL-1730-review.json')));
  const actual=context.FootballRecords.latest([report]).find(p=>p.id==='NFL-2026-W2-det-buf-volume-fun-sgp-dk');
  assert.ok(actual,'Expected the published four-leg ticket');
  const p=compactFixture({...actual,kind:'parlays',favorite:false,status:'active',recentForm:{last5:{hits:5,sample:5},last10:{hits:10,sample:10}}});
  const html=context.testAPI.parlayBoard([p]),card=disclosure(html,'kr-published-item');
  assert.match(card.inside,/<span class="number">01<\/span>/);
  assert.doesNotMatch(html,/NaN|Game-log verification pending|Recent hit rate/);
  const visible=disclosure(card.inside,'pick-details').outside;
  assert.match(visible,/Ticket legs · 4/);
  for(const leg of actual.legs)assert.ok(visible.includes(leg),leg);
  assert.match(visible,/Last 5: 3\/5 · 60% · Last 10: 6\/10 · 60%/);
  assert.match(visible,/Last 5: 3\/5 · 60% · Last 10: 7\/10 · 70%/);
  assert.match(visible,/Last 5: 2\/5 · 40% · Last 10: 4\/10 · 40%/);
  assert.match(visible,/Last 5: 4\/5 · 80% · Last 10: 7\/10 · 70%/);
  assert.match(visible,/not this ticket’s win probability/);
  assert.doesNotMatch(visible,/Last 5: 5\/5|Last 10: 10\/10/);
  for(const leg of actual.legResearch)assert.ok(visible.includes(leg.source));
  assert.doesNotMatch(context.testAPI.pickCard(p),/NaN/,'direct callers without an index are also safe');
});

test('parlay leg rates reject different thresholds, windows, unsupported comparisons and invalid observations',()=>{
  const research={player:'Example Player',line:4,market:'receptions',comparison:'at least',window:'Full game',last5:{hits:3,sample:5},last10:{hits:6,sample:10},valuesNewestFirst:[4,5,2,3,6,4,5,2,3,6],source:'https://example.com/log'};
  const p=compactFixture({kind:'parlays',marketWindow:'Full game',legs:['Example Player 4+ receptions · Full game'],legResearch:[research],recentForm:null});
  const good=disclosure(context.testAPI.pickCard(p),'pick-details').outside;
  assert.match(good,/Last 5: 3\/5 · 60% · Last 10: 6\/10 · 60%/,'a value equal to an at-least line is a hit');
  for(const extra of [{line:5},{window:'1Q'},{comparison:'OVER'},{source:'javascript:bad'},{valuesNewestFirst:[null,5,2,3,6,4,5,2,3,6]},{valuesNewestFirst:[NaN,5,2,3,6,4,5,2,3,6]},{last5:{hits:5,sample:5},last10:{hits:10,sample:10}}]){
    const html=disclosure(context.testAPI.pickCard({...p,legResearch:[{...research,...extra}]}),'pick-details').outside;
    assert.match(html,/See individual leg history/,JSON.stringify(extra));
    assert.doesNotMatch(html,/Last 5:|Last 10:|Game-log verification pending|NaN/,JSON.stringify(extra));
  }
  const duplicate=disclosure(context.testAPI.pickCard({...p,legResearch:[research,research]}),'pick-details').outside;
  assert.match(duplicate,/See individual leg history/);
  const absent=context.testAPI.pickCard({...p,legResearch:[]});assert.match(absent,/Example Player 4\+ receptions · Full game/);assert.doesNotMatch(absent,/Game-log verification pending/);
});

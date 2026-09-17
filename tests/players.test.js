'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Players=require('../site/players.js');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const helpers={
  esc,
  pretty:value=>String(value),
  links:urls=>(urls||[]).filter(url=>/^https:\/\//.test(url)).map(url=>`<a href="${esc(url)}">Source</a>`).join(''),
  formChart:form=>`<figure data-tested-line="${esc(form?.line)}">Verified chart</figure>`,
  workloadPanel:form=>`<div>Workload ${esc(form?.stat)}</div>`,
  playerMovement:pick=>`<div>Movement ${esc(pick.id)}</div>`,
  pickCard:pick=>`<article data-tested-pick="${esc(pick.id)}">${esc(pick.title)}</article>`
};
const quotedAt='2026-09-16T12:00:00Z';
const game=(league,id)=>({id,league,season:2026,week:2,state:'pre',completed:false,kickoff:'2099-09-17T23:00:00Z',away:{abbreviation:'AWY',name:'Away team'},home:{abbreviation:'HME',name:'Home team'}});
const pick=(id,athleteId,extra={})=>({id,athleteId,player:'Alex Sample',title:'Alex Sample OVER 4.5 receptions',position:'WR',status:'active',gameIds:['nfl-game'],book:'DraftKings',odds:-110,quotedAt,expiresAt:'2099-09-17T20:00:00Z',confidence:7,projection:5.8,cutoff:'Through 4.5 at -115',why:'Verified receiving role.',risk:'Volume may change.',sources:['https://example.com/research'],...extra});
const form=(line=4.5)=>({stat:'receptions',line,source:'https://www.espn.com/nfl/player/gamelog/_/id/111',last5:{hits:3,sample:5},last10:{hits:6,sample:10},games:Array.from({length:10},(_,i)=>{const hit=[0,2,4,5,7,9].includes(i),value=hit?6:3;return {label:`2026-09-${String(i+1).padStart(2,'0')} · OPP`,value,hit,source:`https://www.espn.com/nfl/boxscore/_/gameId/${123+i}`,workload:{receptions:value,receivingTargets:8}};})});
function fixture(){
  return {league:'NFL',playerLeague:'All',playerPosition:'all',playerQuery:'',slate:{games:[game('NFL','nfl-game'),game('CFB','cfb-game')]},reports:[{league:'NFL',publishedAt:quotedAt,targetWeek:2,props:[pick('nfl-receptions','111'),pick('nfl-yards','111',{title:'Alex Sample OVER 50.5 receiving yards'})],gameWatch:[]}],history:{updatedAt:quotedAt,picks:{},watches:{}},forecasts:[]};
}

test('one verified athlete has one profile with separate latest market records',()=>{
  const state=fixture();
  state.reports.push({league:'NFL',publishedAt:'2026-09-17T12:00:00Z',props:[pick('nfl-receptions','111',{odds:125})]});
  const players=Players.index(state);
  assert.equal(players.length,1);assert.equal(players[0].key,'NFL:111');
  assert.equal(players[0].records.length,2);
  const record=players[0].records.find(record=>record.id==='nfl-receptions');
  assert.equal(record.odds,-110);assert.equal(record.originalOdds,-110);
  assert.equal(record.publishedAt,'2026-09-17T12:00:00Z');
  assert.equal(Players.hrefFor(state.reports[0].props[0],state),'#player/NFL/111');
});

test('official revisions preserve the original recommendation and expiry while status updates',()=>{
  const state=fixture();
  const first=state.reports[0].props[0];
  Object.assign(first,{favorite:true,line:4.5,direction:'OVER',expiresAt:'2026-09-16T13:00:00Z'});
  state.reports.push({league:'NFL',publishedAt:'2026-09-17T12:00:00Z',props:[pick(first.id,'111',{title:'Alex Sample UNDER 6.5 receptions',book:'FanDuel',odds:125,projection:3.1,confidence:6,favorite:false,line:6.5,direction:'UNDER',quotedAt:'2026-09-17T11:00:00Z',expiresAt:'2099-09-17T23:00:00Z',cutoff:'Through 6.5',gameIds:['replacement-game'],status:'withdrawn'})]});
  const record=Players.index(state)[0].records.find(p=>p.id===first.id);
  for(const field of ['title','book','odds','projection','confidence','favorite','line','direction','quotedAt','expiresAt','cutoff','gameIds']){
    assert.deepEqual(record[field],first[field],`${field} must stay at the original recommendation`);
    assert.deepEqual(record['original'+field[0].toUpperCase()+field.slice(1)],first[field]);
  }
  assert.equal(record.originalPublishedAt,quotedAt);
  assert.equal(record.publishedAt,'2026-09-17T12:00:00Z');assert.equal(record.status,'withdrawn');
  const html=Players.pageHTML(state,'#player/NFL/111',helpers,{market:'props:'+first.id});
  assert.match(html,/DraftKings -110/);assert.match(html,/Withdrawn \/ replaced/);
  assert.doesNotMatch(html,/Original quote:<\/strong> FanDuel/);
});

test('missing or coerced observation values never become numeric player history',()=>{
  for(const value of [null,'',false,true,'6',NaN,Infinity]){
    const state=fixture();state.reports[0].props=state.reports[0].props.slice(0,1);
    const history=form();history.games[0]={...history.games[0],value,hit:Number(value)>history.line};
    state.history.picks['nfl-receptions']={gameId:'nfl-game',athleteId:'111',recentForm:history};
    assert.equal(Players.index(state)[0].records[0].recentForm,null,`${String(value)} must not become a verified observation`);
    assert.doesNotMatch(Players.pageHTML(state,'#player/NFL/111',helpers),/data-tested-line=/);
  }
  const state=fixture();state.reports[0].props=state.reports[0].props.slice(0,1);
  state.history.picks['nfl-receptions']={gameId:'nfl-game',athleteId:'111',recentForm:{...form(),line:'4.5'}};
  assert.equal(Players.index(state)[0].records[0].recentForm,null,'A numeric-looking string threshold must not be coerced');
});

test('old or failed identity snapshots are labeled and keep their source visible',()=>{
  const state=fixture();
  const meta={athleteId:'111',league:'NFL',name:'Alex Sample',position:'WR',status:'ok',checkedAt:new Date().toISOString(),source:'https://www.espn.com/nfl/player/_/id/111',team:{id:'1',name:'Verified team'}};
  state.identities={players:{'NFL/111':meta}};
  assert.doesNotMatch(Players.pageHTML(state,'#player/NFL/111',helpers),/Older roster snapshot/);
  for(const update of [{checkedAt:'2000-01-01T00:00:00Z',status:'ok'},{checkedAt:new Date().toISOString(),status:'failed'}]){
    Object.assign(meta,update);
    const profile=Players.pageHTML(state,'#player/NFL/111',helpers);
    assert.match(profile,/Older roster snapshot/);assert.match(profile,/refresh due/);
    assert.match(profile,/href="https:\/\/www\.espn\.com\/nfl\/player\/_\/id\/111"/);
    assert.match(Players.pageHTML(state,'#players',helpers),/older roster snapshot/);
  }
});

test('identity is league plus athlete ID, never a same-name join',()=>{
  const state=fixture();
  state.reports[0].props.push(pick('same-name-different-athlete','222'));
  state.reports.push({league:'CFB',publishedAt:quotedAt,props:[pick('college-player','111',{gameIds:['cfb-game']})]});
  const players=Players.index(state);
  assert.deepEqual(new Set(players.map(player=>player.key)),new Set(['NFL:111','NFL:222','CFB:111']));
  assert.equal(players.filter(player=>player.name==='Alex Sample').length,3);
  assert.equal(Players.hrefFor(state.reports[1].props[0],state),'#player/CFB/111');
});

test('saved verified IDs resolve historical picks while unverified names use the directory',()=>{
  const state=fixture();
  const historic=pick('saved-history',undefined,{status:'historical'});
  const unknown=pick('unknown-identity',undefined);
  state.reports[0].props.push(historic,unknown);
  state.history.picks[historic.id]={gameId:'nfl-game',athleteId:'333',position:'WR',recentForm:{...form(),source:'https://www.espn.com/nfl/player/gamelog/_/id/333'}};
  assert.equal(Players.hrefFor(historic,state),'#player/NFL/333');
  assert.equal(Players.hrefFor(unknown,state),'#players');
  assert.equal(Players.index(state).length,2);
});

test('a revised watch threshold cannot inherit a previous threshold hit rate',()=>{
  const state=fixture();state.reports[0].props=[];
  const watch={id:'watch-receptions',athleteId:'111',player:'Alex Sample',position:'WR',gameId:'nfl-game',title:'Alex Sample receptions candidate',marketTitle:'Alex Sample OVER 4.5 receptions',lineLabel:'Reference line: 4.5 receptions',why:'Research only.',sources:['https://example.com/watch']};
  state.reports[0].gameWatch=[watch];
  state.history.watches[watch.id]={gameId:watch.gameId,marketTitle:watch.marketTitle,recentForm:form()};
  assert.equal(Players.index(state)[0].records[0].recentForm.line,4.5);
  state.reports.push({league:'NFL',publishedAt:'2026-09-17T12:00:00Z',gameWatch:[{...watch,marketTitle:'Alex Sample OVER 5.5 receptions',lineLabel:'Reference line: 5.5 receptions'}]});
  const records=Players.index(state)[0].records;
  assert.equal(records.length,1);assert.equal(records[0].recentForm??null,null);
  assert.ok(records[0].historyReason,'The missing exact-market history has an explanation');
  const html=Players.pageHTML(state,'#player/NFL/111',helpers);
  assert.doesNotMatch(html,/data-tested-line="4\.5"/);
  assert.match(html,/5\.5/);
});

test('official exact-market history rejects different thresholds or reversed hit direction',()=>{
  const state=fixture();state.reports[0].props=state.reports[0].props.slice(0,1);
  state.history.picks['nfl-receptions']={gameId:'nfl-game',athleteId:'111',position:'WR',recentForm:form()};
  assert.equal(Players.index(state)[0].records[0].recentForm.line,4.5);
  state.reports[0].props[0].title='Alex Sample OVER 5.5 receptions';
  assert.equal(Players.index(state)[0].records[0].recentForm??null,null);
  state.reports[0].props[0].title='Alex Sample UNDER 4.5 receptions';
  assert.equal(Players.index(state)[0].records[0].recentForm??null,null);
});

test('directory search and league/position filters do not invent other sports players',()=>{
  const state=fixture();
  state.reports[0].props.push(pick('quarterback','444',{player:'Blake Quarterback',title:'Blake Quarterback OVER 249.5 passing yards',position:'QB'}));
  const all=Players.pageHTML(state,'#players',helpers);
  for(const id of ['player-search','player-league','player-position'])assert.match(all,new RegExp('id="'+id+'"'));
  assert.match(all,/href="#player\/NFL\/111"/);
  assert.match(Players.pageHTML(state,'#players',helpers,{query:'aLeX',league:'NFL',position:'WR'}),/href="#player\/NFL\/111"/);
  const quarterbacks=Players.pageHTML(state,'#players',helpers,{position:'QB'});
  assert.doesNotMatch(quarterbacks,/href="#player\/NFL\/111"/);
  assert.match(quarterbacks,/href="#player\/NFL\/444"/);
  for(const filters of [{query:'does-not-exist'},{league:'NBA'},{league:'MLB'}]){
    const html=Players.pageHTML(state,'#players',helpers,filters);
    assert.doesNotMatch(html,/href="#player\/NFL\/111"/);
    assert.match(html,/No players|not available|not yet|not loaded|No matching|No verified|No tracked/i);
  }
  for(const league of ['NBA','MLB'])assert.match(all,new RegExp('<option value="'+league+'"'));
});

test('profiles show each selected market and link the verified statistics source',()=>{
  const state=fixture();
  state.history.picks['nfl-receptions']={gameId:'nfl-game',athleteId:'111',position:'WR',recentForm:form()};
  const html=Players.pageHTML(state,'#player/NFL/111',helpers,{market:'props:nfl-receptions'});
  assert.match(html,/id="player-market"/);
  assert.match(html,/data-tested-line="4\.5"/);
  assert.match(html,/href="https:\/\/www\.espn\.com\/nfl\/player\/gamelog\/_\/id\/111"/);
  const yards=Players.pageHTML(state,'#player/NFL/111',helpers,{market:'props:nfl-yards'});
  assert.doesNotMatch(yards,/data-tested-line="4\.5"/);
  assert.match(yards,/50\.5/);
});

test('unknown or malformed player routes stay honest instead of showing another athlete',()=>{
  const state=fixture();
  assert.equal(Players.matches('#players'),true);assert.equal(Players.matches('#player/NFL/111'),true);
  assert.equal(Players.matches('#props'),false);
  for(const route of ['#player/NFL/999999','#player/NBA/111','#player/NFL/%3Cscript%3E']){
    const html=Players.pageHTML(state,route,helpers);
    assert.match(html,/not found|not available|unavailable|not verified|No verified/i);
    assert.doesNotMatch(html,/data-tested-line=|data-tested-pick=/);
  }
});

test('player text and filter values are escaped and unsafe sources are not links',()=>{
  const state=fixture();
  state.reports[0].props[0].player='<script>alert(1)</script>';
  state.reports[0].props[0].title='<script>alert(1)</script> OVER 4.5 receptions';
  state.reports[0].props[0].sources=['javascript:alert(1)'];
  state.reports[0].props=state.reports[0].props.slice(0,1);
  const profile=Players.pageHTML(state,'#player/NFL/111',helpers);
  assert.doesNotMatch(profile,/<script>|href="javascript:/);
  assert.match(profile,/&lt;script&gt;/);
  const directory=Players.pageHTML(state,'#players',helpers,{query:'"><script>alert(2)</script>'});
  assert.doesNotMatch(directory,/<script>/);
  assert.match(directory,/&quot;&gt;&lt;script&gt;/);
});

function historyFixture(){
  const state=fixture();
  const target={...game('NFL','NFL-9999'),kickoff:'2026-09-17T23:00:00Z',home:{id:'2',abbreviation:'BUF',name:'Buffalo'},away:{id:'8',abbreviation:'DET',name:'Detroit'}};
  state.slate.games=[target];
  const row=(eventId,date,value,extra={})=>({eventId:String(eventId),date,season:2026,seasonType:'regular',isHome:false,opponent:{id:'2',abbreviation:'BUF',name:'Buffalo'},label:date.slice(0,10)+' · BUF',value,hit:value>5,source:`https://www.espn.com/nfl/boxscore/_/gameId/${eventId}`,...extra});
  const rows=[
    row('101','2026-01-04T18:00:00Z',8,{season:2025,isHome:true}),
    row('102','2026-09-01T18:00:00Z',2,{isHome:true}),
    row('103','2026-09-08T18:00:00Z',5),
    row('104','2026-09-10T18:00:00Z',8,{opponent:{id:'99',abbreviation:'BUF',name:'Buffalo'},isHome:true}),
    row('105','2026-09-12T18:00:00Z',9,{opponent:{id:'2',abbreviation:'RENAMED',name:'Same structured defense'}})
  ];
  const record={...pick('history-market','111',{title:'Alex Sample OVER 5 receptions',gameIds:[target.id],line:5,direction:'OVER',cutoff:'Through 5 at -115'}),league:'NFL',official:true,kind:'props',publishedAt:quotedAt,originalPublishedAt:quotedAt,recentForm:{...form(5),direction:'OVER',games:rows,historyGames:rows,cutoffAt:target.kickoff,vsOpponent:{opponentId:'2',opponentLabel:'Buffalo',games:rows.filter(row=>row.opponent.id==='2')}}};
  return {state,record,row,rows};
}

test('history opponent filters use structured IDs rather than matching labels or team names',()=>{
  const {state,record}=historyFixture();
  const history=Players.historyView(record,state,{historyWindow:'20',historyOpponent:'opponent'});
  assert.deepEqual(history.rows.map(row=>row.eventId),['101','102','103','105']);
  assert.equal(history.opponentId,'2');
  assert.equal(history.sample,4);
});

test('history cutoff excludes the recommendation event and all observations after publication',()=>{
  const {state,record,row}=historyFixture();
  record.recentForm.historyGames.push(
    row('9999','2026-09-01T00:00:00Z',99),
    row('106',quotedAt,66),
    row('107','2026-09-16T15:00:00Z',77),
    row('108','2026-09-18T18:00:00Z',88)
  );
  const history=Players.historyView(record,state,{historyWindow:'20'});
  assert.deepEqual(history.rows.map(row=>row.eventId),['101','102','103','104','105']);
  assert.equal(Date.parse(history.cutoffAt),Date.parse(quotedAt));
  assert.ok(history.excluded>=4,'Excluded recommendation and later rows must not silently count as history');
});

test('history season and venue filters select comparable regular-season games',()=>{
  const {state,record,row}=historyFixture();
  record.recentForm.historyGames.push(row('106','2026-08-25T18:00:00Z',66,{seasonType:'preseason'}));
  const season=Players.historyView(record,state,{historyWindow:'season'});
  assert.deepEqual(season.rows.map(row=>row.eventId),['102','103','104','105']);
  assert.equal(season.targetSeason,2026);
  const home=Players.historyView(record,state,{historyWindow:'season',historyVenue:'home'});
  assert.deepEqual(home.rows.map(row=>row.eventId),['102','104']);
  const away=Players.historyView(record,state,{historyWindow:'season',historyVenue:'away'});
  assert.deepEqual(away.rows.map(row=>row.eventId),['103','105']);
  const homeAgainstTarget=Players.historyView(record,state,{historyWindow:'season',historyVenue:'home',historyOpponent:'opponent'});
  assert.deepEqual(homeAgainstTarget.rows.map(row=>row.eventId),['102']);
});

test('Last 5 applies after opponent selection and keeps the newest matching games',()=>{
  const {state,record,row}=historyFixture();
  record.recentForm.historyGames=Array.from({length:12},(_,i)=>row(String(200+i),`2026-09-${String(i+1).padStart(2,'0')}T18:00:00Z`,i+1,{opponent:{id:i%2?'99':'2',abbreviation:i%2?'OTHER':'BUF'}}));
  const history=Players.historyView(record,state,{historyWindow:'5',historyOpponent:'opponent'});
  assert.deepEqual(history.rows.map(row=>row.eventId),['202','204','206','208','210']);
  assert.equal(history.sample,5);assert.equal(history.requested,5);assert.equal(history.complete,true);
});

test('history separates pushes from misses and the descriptive hit-rate denominator',()=>{
  const {state,record}=historyFixture();
  const history=Players.historyView(record,state,{historyWindow:'season'});
  assert.equal(history.sample,4);assert.equal(history.hits,2);assert.equal(history.misses,1);assert.equal(history.pushes,1);
  assert.equal(history.decisions,3);assert.ok(Math.abs(history.hitRate-200/3)<0.01);
  assert.equal(history.average,6);assert.equal(history.median,6.5);
  record.recentForm.historyGames=record.recentForm.historyGames.filter(row=>row.value===5);
  const pushes=Players.historyView(record,state,{historyWindow:'20'});
  assert.equal(pushes.pushes,1);assert.equal(pushes.decisions,0);assert.equal(pushes.hitRate,null);
});

test('incomplete Last 20 history is labeled without altering the original selection',()=>{
  const {state,record}=historyFixture();
  state.reports[0].props=[record];state.history.picks={};
  const before=JSON.stringify({title:record.title,line:record.line,odds:record.odds,book:record.book,quotedAt:record.quotedAt,cutoff:record.cutoff});
  const history=Players.historyView(record,state,{historyWindow:'20'});
  assert.equal(history.requested,20);assert.equal(history.sample,5);assert.equal(history.complete,false);
  const html=Players.pageHTML(state,'#player/NFL/111',helpers,{historyWindow:'20'});
  assert.match(html,/id="player-history-window"/);assert.match(html,/id="player-history-opponent"/);assert.match(html,/id="player-history-venue"/);
  assert.match(html,/5 (?:of|\/) ?20|5\/20|only 5|5 available|5 verified|incomplete/i);
  assert.match(html,/descriptive|not a forecast|not a win probability|not.*predict/i);
  assert.match(html,/DraftKings -110/);assert.match(html,/Alex Sample OVER 5 receptions/);
  assert.equal(JSON.stringify({title:record.title,line:record.line,odds:record.odds,book:record.book,quotedAt:record.quotedAt,cutoff:record.cutoff}),before);
});

test('profile matchup helper receives the selected player and recorded market',()=>{
  const {state,record}=historyFixture();
  state.reports[0].props=[record];state.history.picks={};
  let received;
  const html=Players.pageHTML(state,'#player/NFL/111',{...helpers,matchupPanel:(...args)=>{received=args;return '<section data-tested-matchup>Comparable defensive context</section>';}});
  assert.match(html,/data-tested-matchup/);
  assert.ok(received?.some(value=>value?.id==='history-market'||value?.records?.some(record=>record.id==='history-market')),'The matchup helper receives the relevant player or record context');
});

test('signed history bars extend below or above zero and a 20-game chart explains scrolling',()=>{
  const {state,record,row}=historyFixture();
  record.title='Alex Sample OVER 5 rushing yards';record.recentForm.stat='rushing yards';
  const rows=[-3,0,6].map((value,i)=>row(String(301+i),`2026-09-0${i+1}T18:00:00Z`,value));
  record.recentForm.games=rows;record.recentForm.historyGames=rows;state.reports[0].props=[record];
  const html=Players.pageHTML(state,'#player/NFL/111',helpers,{historyWindow:'20'});
  const zero=Number(html.match(/class="history-zero-line"[^>]*style="[^"]*bottom:([\d.]+)%/)?.[1]);
  assert.ok(Number.isFinite(zero)&&zero>0&&zero<100,'A mixed-sign chart needs a visible zero baseline');
  const geometry=value=>{
    const match=html.match(new RegExp('data-value="'+value+'"[\\s\\S]*?class="form-bar" style="[^"]*bottom:([\\d.]+)%;height:([\\d.]+)%'));
    assert.ok(match,'Expected bar for '+value);
    return {bottom:Number(match[1]),height:Number(match[2])};
  };
  const negative=geometry(-3),atZero=geometry(0),positive=geometry(6);
  assert.ok(negative.bottom<zero&&negative.height>0);
  assert.ok(Math.abs(negative.bottom+negative.height-zero)<0.01,'Negative bar ends at zero from below');
  assert.equal(atZero.height,0);assert.equal(atZero.bottom,zero);
  assert.equal(positive.bottom,zero);assert.ok(positive.height>0,'Positive bar grows above zero');
  assert.doesNotMatch(html,/player-chart-scroll-hint/);
  const twenty=Array.from({length:20},(_,i)=>row(String(400+i),`2026-08-${String(i+1).padStart(2,'0')}T18:00:00Z`,i-3));
  record.recentForm.games=twenty;record.recentForm.historyGames=twenty;
  const wide=Players.pageHTML(state,'#player/NFL/111',helpers,{historyWindow:'20'});
  assert.equal((wide.match(/data-value="/g)||[]).length,20);
  assert.match(wide,/Swipe or scroll the chart sideways/);
});

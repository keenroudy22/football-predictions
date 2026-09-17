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

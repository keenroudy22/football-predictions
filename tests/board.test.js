'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Board=require('../site/board.js');
const now=Date.parse('2026-09-17T16:00:00Z');
const game=(id,extra={})=>({id,league:'NFL',season:2026,week:2,kickoff:'2026-09-20T17:00:00Z',state:'pre',away:{id:'1',abbreviation:'AWY',name:'Away'},home:{id:'2',abbreviation:'HME',name:'Home'},...extra});
const pick=(id,extra={})=>({id,title:'Sample Player OVER 4.5 receptions',athleteId:'111',position:'WR',gameIds:['NFL-1'],status:'active',favorite:true,line:4.5,direction:'over',book:'DraftKings',odds:-110,quotedAt:'2026-09-17T15:30:00Z',expiresAt:'2026-09-17T17:00:00Z',projection:5.8,confidence:7,cutoff:'4.5 at -115 or better',sources:['https://example.com/quote'],...extra});
const fixture=()=>({league:'NFL',week:'2026-09-15',slate:{updatedAt:'2026-09-17T16:00:00Z',games:[game('NFL-1'),game('NFL-2')]},reports:[{league:'NFL',publishedAt:'2026-09-17T15:31:00Z',props:[pick('one')]}],history:{picks:{},watches:{}},marketLines:{lines:[]}});
const currentRow=(extra={})=>({key:'a',id:'a',title:'Player OVER 4.5 receptions',subject:'Player',market:'receptions',marketWindow:'Full game',line:4.5,direction:'OVER',book:'DraftKings',odds:-110,quotedAt:'2026-09-17T15:30:00Z',expiresAt:'2026-09-17T17:00:00Z',gameId:'NFL-1',gameState:'pre',gameCompleted:false,kickoff:'2026-09-20T17:00:00Z',league:'NFL',quoteType:'sportsbook',sourceType:'market',status:'current',source:'https://example.com/quote',...extra});

test('official rows freeze original recommendation fields and do not duplicate revisions',()=>{
 const s=fixture();s.reports.push({league:'NFL',publishedAt:'2026-09-17T15:50:00Z',props:[pick('one',{title:'Sample Player OVER 5.5 receptions',line:5.5,odds:125,favorite:false,status:'expired',projection:6.5})]});
 const rows=Board.rows(s);assert.equal(rows.length,1);assert.equal(rows[0].title,'Sample Player OVER 4.5 receptions');assert.equal(rows[0].odds,-110);assert.equal(rows[0].line,4.5);assert.equal(rows[0].projection,5.8);assert.equal(rows[0].favorite,true);assert.equal(rows[0].status,'expired');
});
test('identical catalog quotes deduplicate against official picks while different prices remain',()=>{
 const s=fixture();s.marketLines.lines=[{...pick('copy'),gameId:'NFL-1',league:'NFL',player:'Sample Player',market:'receptions',direction:'OVER',observedAt:'2026-09-17T15:30:00Z',quoteType:'sportsbook',quoteStatus:'current',source:'https://example.com/quote'},{...pick('changed',{odds:-120}),gameId:'NFL-1',league:'NFL',market:'receptions',observedAt:'2026-09-17T15:30:00Z',source:'https://example.com/quote'}];
 const rows=Board.rows(s);assert.equal(rows.length,2);assert.equal(rows.filter(r=>r.official).length,1);assert.equal(rows.filter(r=>r.odds===-120).length,1);
});
test('game comparison rows expose only sourced sides and never become current sportsbook quotes',()=>{
 const s=fixture();s.reports=[];s.slate.games[0].market={provider:'DraftKings',spread:-5.5,spreadOdds:-110,total:45.5,overOdds:-115};
 const rows=Board.rows(s);assert.equal(rows.length,2);assert.ok(rows.some(r=>r.direction==='HOME'));assert.ok(rows.some(r=>r.direction==='OVER'));assert.ok(rows.every(r=>!Board.eligible(r,now)));assert.ok(!rows.some(r=>r.direction==='UNDER'));
});
test('current availability requires direct fresh priced pregame quotes and college verification',()=>{
 assert.equal(Board.eligible(currentRow(),now),true);
 for(const extra of [{quoteType:'comparison feed'},{status:'reference'},{expiresAt:null},{expiresAt:'2026-09-17T15:00:00Z'},{quotedAt:'2026-09-17T18:00:00Z'},{odds:null},{book:''},{gameState:'in'},{entryNote:'New entries paused.'},{source:'javascript:bad'},{league:'CFB'}])assert.equal(Board.eligible(currentRow(extra),now),false,JSON.stringify(extra));
 assert.equal(Board.eligible(currentRow({league:'CFB',jurisdiction:{state:'IN',status:'verified',allowed:true,source:'https://example.com/rules'}}),now),true);
});
test('TD and missing-price lines can be saved as references without a combined price',()=>{
 const td=currentRow({title:'Player anytime touchdown',line:null,direction:'YES',market:'anytime touchdown',odds:205,status:'reference'}),waiting=currentRow({title:'Player receptions candidate',line:null,odds:null,status:'reference'});
 assert.equal(Board.saveable(td),true);assert.equal(Board.saveable(waiting),true);assert.equal(Board.summarizeTicket([td,waiting],1,'units',1,now).available,false);
});
test('illustrative payout handles positive and negative odds without same-game multiplication',()=>{
 const a=currentRow({odds:-200}),b=currentRow({key:'b',gameId:'NFL-2',odds:150});const t=Board.summarizeTicket([a,b],2,'units',10,now);
 assert.equal(t.available,true);assert.equal(t.decimal,3.75);assert.equal(t.odds,275);assert.equal(t.profit,5.5);assert.equal(t.total,7.5);assert.equal(t.dollars.profit,55);
 assert.equal(Board.summarizeTicket([a,{...b,gameId:a.gameId}],1,'money',1,now).available,false);
 assert.equal(Board.summarizeTicket([a,{...b,book:'FanDuel'}],1,'money',1,now).available,false);
});
test('saved drafts survive missing rows and preserve unaccepted old lines when quotes change',()=>{
 const old=currentRow(),saved=Board.saveRow(old),changed={...old,line:5.5,odds:125,title:'Player OVER 5.5 receptions'};const r=Board.reconcileSaved([saved],[changed])[0];
 assert.equal(r.changed,true);assert.equal(r.line,4.5);assert.equal(r.odds,-110);assert.equal(r.current.line,5.5);assert.equal(Board.summarizeTicket([r,currentRow({key:'b',gameId:'NFL-2'})],1,'money',1,now).available,false);
 assert.equal(Board.reconcileSaved([saved],[])[0].missing,true);assert.match(Board.ticketText([r]),/OVER 4.5/);assert.match(Board.ticketText([r]),/QUOTE CHANGED/);
});
test('storage is versioned, safe on failures and defaults to generic one-dollar units',()=>{
 const store=new Map(),storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},view={saved:[Board.saveRow(currentRow())],stake:2,stakeMode:'units',unitValue:1};
 assert.equal(Board.persist(storage,view),true);assert.equal(Board.readSaved(storage).saved.length,1);assert.equal(Board.readSaved(storage).unitValue,1);
 assert.deepEqual(Board.readSaved({getItem:()=>'{bad'}),{});assert.deepEqual(Board.readSaved({getItem:()=>JSON.stringify({version:2,saved:[]})}),{});assert.equal(Board.persist({setItem(){throw Error('blocked')}},view),false);
});
test('target suggestions use current quotes from one book and distinct games only',()=>{
 const rows=[currentRow(),currentRow({key:'b',gameId:'NFL-2'}),currentRow({key:'stale',gameId:'NFL-3',status:'reference'})],items=Board.suggestions(rows,200,now);
 assert.equal(items.length,1);assert.ok(items[0].rows.every(r=>r.key!=='stale'));assert.deepEqual(Board.suggestions(rows,50000,now),[]);
});
test('board filters preserve favorites and Monday football week semantics',()=>{
 const s=fixture();s.slate.games[1].kickoff='2026-09-22T00:15:00Z';s.reports[0].props.push(pick('two',{athleteId:'222',title:'Second Player UNDER 225.5 passing yards',position:'QB',favorite:false,gameIds:['NFL-2']}));
 assert.equal(Board.dateWeek(s.slate.games[1].kickoff),'2026-09-15');const html=Board.pageHTML(s,{query:'Second',scope:'all',game:'all',position:'QB',market:'all',book:'all'});assert.match(html,/Second Player/);assert.doesNotMatch(html,/Sample Player/);assert.match(html,/kr-detail/);assert.doesNotMatch(html,/<main/);
});
test('market windows stay exact and unknown catalog identities do not produce broken profiles',()=>{
 const s=fixture();s.reports[0].props[0].marketWindow='1Q';s.marketLines.lines=[{id:'new',league:'NFL',athleteId:'999',gameId:'NFL-1',player:'Unknown Player',title:'Unknown Player OVER 20.5 receiving yards',line:20.5,market:'receiving yards',source:'https://example.com/quote',status:'reference'}];
 const rows=Board.rows(s);assert.equal(rows.find(r=>r.official).marketWindow,'1Q');assert.equal(rows.find(r=>r.id==='new').profile,null);
});
test('reference history recalculates at the observed threshold and does not extrapolate full-game data to quarters',()=>{
 const s=fixture(),raw=[3,5,7,9,11].map((value,i)=>({eventId:String(100+i),date:`2026-09-0${i+1}T17:00:00Z`,season:2026,seasonType:'regular',isHome:true,opponent:{id:'2',abbreviation:'HME'},value,source:`https://www.espn.com/nfl/boxscore/_/gameId/${100+i}`}));
 s.history.picks['one']={athleteId:'111',gameId:'NFL-1',recentForm:{stat:'receptions',line:4.5,source:'https://www.espn.com/nfl/player/gamelog/_/id/111',direction:'OVER',checkedAt:'2026-09-17T15:00:00Z',cutoffAt:'2026-09-17T15:00:00Z',games:raw.map(r=>({...r,hit:r.value>4.5})),historyGames:raw}};
 const row=currentRow({athleteId:'111',subject:'Sample Player',line:7,direction:'UNDER',observedAt:'2026-09-17T15:00:00Z'}),history=Board.rowHistory(row,s,'5');
 assert.equal(history.sample,5);assert.equal(history.hits,2);assert.equal(history.pushes,1);assert.equal(history.hitRate,50);assert.equal(Board.rowHistory({...row,marketWindow:'1Q'},s),null);
});
test('article retrievals remain observations and game markets use their own retrieval timestamp',()=>{
 const s=fixture();s.marketLines.lines=[{id:'article',league:'NFL',gameId:'NFL-1',player:'Sample Player',athleteId:'111',title:'Sample Player OVER 5.5 receptions',market:'receptions',line:5.5,direction:'OVER',book:'FanDuel',odds:110,quoteType:'comparison feed',quoteStatus:'reference',observedAt:'2026-09-17T15:00:00Z',source:'https://example.com/article'}];
 s.slate.games[0].market={provider:'DraftKings',total:45.5,overOdds:-110};s.slate.games[0].marketRetrievedAt='2026-09-16T20:00:00Z';
 const rows=Board.rows(s),article=rows.find(r=>r.id==='article'),gameLine=rows.find(r=>r.sourceType==='game-market');
 assert.equal(article.quotedAt,null);assert.equal(article.observedAt,'2026-09-17T15:00:00Z');assert.equal(gameLine.observedAt,'2026-09-16T20:00:00Z');
 assert.match(Board.quoteState({...article,status:'stale'},now).label,/expired/);assert.match(Board.quoteState({...article,status:'missing-price',odds:null},now).label,/unavailable/);
});
test('deduplication cannot hide a current direct quote behind a research copy',()=>{
 const s=fixture();s.reports[0].props=[];s.reports[0].gameWatch=[{id:'watch',athleteId:'111',player:'Sample Player',gameId:'NFL-1',title:'Sample Player OVER 4.5 receptions',marketTitle:'Sample Player OVER 4.5 receptions',marketSnapshots:[{book:'DraftKings',market:'receptions',window:'Full game',direction:'OVER',line:4.5,odds:-110,observedAt:'2026-09-17T15:30:00Z',source:'https://example.com/quote',quoteType:'sportsbook'}]}];
 s.marketLines.lines=[{...currentRow(),id:'direct',player:'Sample Player',athleteId:'111',title:'Sample Player OVER 4.5 receptions',observedAt:'2026-09-17T15:30:00Z',quoteStatus:'current'}];
 const rows=Board.rows(s);assert.equal(rows.length,1);assert.equal(rows[0].sourceType,'market');assert.equal(Board.eligible(rows[0],now),true);assert.equal(rows[0].official,false);
});
test('changed draft displays old and new line, book and odds safely before approval',()=>{
 const s=fixture();const before=Board.rows(s)[0],saved=Board.saveRow(before);s.reports=[];s.marketLines.lines=[{...currentRow({key:before.key}),id:'reprice',player:'Sample Player',athleteId:'111',title:'Sample Player OVER 5.5 receptions',line:5.5,odds:125,book:'FanDuel',quoteStatus:'current'}];
 const after=Board.rows(s)[0];saved.key=after.key;saved.snapshot.key=after.key;const html=Board.pageHTML(s,{saved:[saved]});
 assert.match(html,/saved Sample Player OVER 4.5 receptions/);assert.match(html,/latest Sample Player OVER 5.5 receptions/);assert.match(html,/DraftKings -110/);assert.match(html,/FanDuel \+125/);
});
test('sportsbook aliases share one filter name and spreads show their actual signed line',()=>{
 const s=fixture();s.reports[0].props[0].book='Draft Kings';s.slate.games[0].market={provider:'DraftKings',spread:2.5,spreadOdds:-110};
 const rows=Board.rows(s);assert.deepEqual([...new Set(rows.map(r=>r.book))],['DraftKings']);
 const html=Board.pageHTML(s);assert.match(html,/>\+2.5 spread</);assert.doesNotMatch(html,/HOME 2.5 Spread|Draft Kings/);
 assert.equal(Board.summarizeTicket([currentRow({book:'Draft Kings'}),currentRow({key:'b',gameId:'NFL-2',book:'DraftKings'})],1,'money',1,now).available,true);
});
test('exact source quote identity can merge missing-ID research while preserving reasoning and stale quote status',()=>{
 const s=fixture();s.reports[0].props=[];
 s.reports[0].gameWatch=[{id:'watch',player:'Sample Player',gameId:'NFL-1',title:'Sample Player OVER 4.5 receptions',marketTitle:'Sample Player OVER 4.5 receptions',why:'Verified role research.',risk:'Specific volume risk.',marketSnapshots:[{book:'Draft Kings',market:'receptions',window:'Full game',direction:'OVER',line:4.5,odds:-110,observedAt:'2026-09-17T15:30:00Z',source:'https://example.com/quote',quoteType:'sportsbook'}]}];
 s.marketLines.lines=[{...currentRow(),id:'direct',player:'Sample Player',athleteId:'111',title:'Sample Player OVER 4.5 receptions',observedAt:'2026-09-17T15:30:00Z',quoteStatus:'stale'}];
 let rows=Board.rows(s);assert.equal(rows.length,1);assert.equal(rows[0].athleteId,'111');assert.equal(rows[0].status,'stale');assert.equal(rows[0].sourceType,'market');assert.equal(rows[0].why,'Verified role research.');assert.equal(rows[0].risk,'Specific volume risk.');assert.equal(rows[0].hasResearch,true);
 s.marketLines.lines.push({...s.marketLines.lines[0],id:'different-known-person',athleteId:'222'});rows=Board.rows(s);assert.equal(rows.length,3,'ambiguous same-name identities stay separate');
});
test('drawer save action reflects selection and player history appears before long analysis',()=>{
 const s=fixture(),row=Board.rows(s)[0];s.reports[0].props[0].why='Long underlying analysis.';const initial=Board.pageHTML(s,{detail:row.key});
 assert.match(initial,/aria-pressed="false">Save to draft/);assert.ok(initial.indexOf('kr-detail-history')<initial.indexOf('Long underlying analysis.'));
 const saved=Board.pageHTML(s,{detail:row.key,saved:[Board.saveRow(row)]});assert.match(saved,/aria-pressed="true">✓ Saved · remove/);
});
test('team accents require verified metadata, a team in this game and a safe hex color',()=>{
 const s=fixture();s.identities={players:{'NFL/111':{status:'ok',team:{id:'1',color:'0076B6'}}}};
 assert.equal(Board.rows(s)[0].teamColor,'#0076B6');assert.match(Board.pageHTML(s),/style="--pick-team-color:#0076B6"/);
 s.identities.players['NFL/111'].team.id='unrelated-team';assert.equal(Board.rows(s)[0].teamColor,null);assert.doesNotMatch(Board.pageHTML(s),/--pick-team-color:/);
 s.identities.players['NFL/111'].team={id:'1',color:'red;display:none'};assert.equal(Board.rows(s)[0].teamColor,null);
 s.identities.players['NFL/111'].team.color='#0076B6';s.identities.players['NFL/111'].status='stale';assert.equal(Board.rows(s)[0].teamColor,null);
});


test('parlay builder opens as a dedicated workspace without hiding draft controls in a mobile rail',()=>{
 const html=Board.pageHTML(fixture(),{route:'parlays'});
 assert.match(html,/kr-board kr-ticket-page/);
 assert.match(html,/data-kr-action="shuffle"/);
 assert.match(html,/data-kr-field="shuffleCount"/);
 assert.match(html,/data-kr-field="shuffleBook"/);
 assert.match(html,/data-kr-field="shuffleGame"/);
 assert.doesNotMatch(html,/class="kr-slip-dock"|id="kr-slip-dialog"/);
 assert.match(html,/<details class="kr-ticket-pool"><summary>Add your own lines/);
 assert.doesNotMatch(html,/data-kr-field="stake"/,'empty drafts choose legs before asking for stake');
});

test('published tickets and shuffled drafts are separate page states',()=>{
 const html=Board.pageHTML(fixture(),{route:'parlays',ticketTab:'published'});
 assert.match(html,/Our published tickets/);assert.match(html,/No verified parlay published/);
 assert.doesNotMatch(html,/data-kr-action="shuffle"|Add your own lines/);
});

test('draft locks persist only for existing saved rows and locked controls are accessible',()=>{
 const s=fixture(),row=Board.rows(s)[0],view={saved:[Board.saveRow(row)],locked:[row.key],route:'parlays',stake:1,unitValue:1};
 const memory=new Map(),storage={getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v)};
 Board.persist(storage,{...view,locked:[row.key,'nonexistent']});assert.deepEqual(Board.readSaved(storage).locked,[row.key]);
 const html=Board.pageHTML(s,view);assert.match(html,/data-kr-action="lock"[^>]*aria-pressed="true"/);
 assert.match(html,/Research for Sample Player/);assert.match(html,/Personal picks · separate from our record/);
});

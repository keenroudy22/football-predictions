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
vm.runInContext(script+'\n globalThis.testAPI={pickCard,research,state,builderEligible,compatibleTicket,ticketText,americanToDecimal,decimalToAmerican};',context);

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

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
vm.runInContext(script+'\n globalThis.testAPI={pickCard,research,state};',context);

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

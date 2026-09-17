const test=require('node:test'),assert=require('node:assert/strict');
const A=require('../site/analytics.js'),R=require('../site/records.js');
const g={id:'g',league:'NFL',season:2026,week:1,kickoff:'2026-09-14T20:00:00Z',completed:true,home:{score:21},away:{score:17}};
const base={gameId:'g',home:24,away:17,publishedAt:'2026-09-13T10:00:00Z',model:'v1'};
const reports=[{league:'NFL',publishedAt:'2026-09-14T18:00:00Z',scores:[{gameId:'g',home:20,away:17}]},{league:'NFL',publishedAt:'2026-09-14T21:00:00Z',scores:[{gameId:'g',home:21,away:17}]}];
test('display and results freeze the same last pregame forecast, ignoring late revisions',()=>{
 assert.equal(A.score(g,[base],reports).home,20);
 const rows=A.scores([g],[base],reports);assert.equal(rows[0].p.home,20);assert.equal(rows[0].totalError,-1);
 assert.equal(A.score(g,[base],reports,'baseline').home,24);
});
test('imports stay separate and missing or postgame forecasts never create wins',()=>{
 const imported=[{league:'NFL',historicalImport:true,publishedAt:'2026-09-15',scores:[{gameId:'g',home:21,away:17}]}];
 assert.equal(A.scores([g],[],imported).length,0);assert.equal(A.scores([g],[],imported,'historical').length,1);
 assert.equal(A.scores([g],[{...base,publishedAt:g.kickoff}],[]).length,0);
 assert.equal(A.scores([{...g,home:{score:null}}],[base],[]).length,0);
});
test('aggregate profit unavailable if any settled original price is missing',()=>{
 const s=A.recordSummary([{result:'win',originalOdds:null},{result:'loss',originalOdds:-110}]);assert.equal(s.units,null);assert.equal(s.roi,null);assert.equal(s.wins,1);
 const priced=A.recordSummary([{result:'win',originalOdds:150},{result:'push',originalOdds:-110},{result:'void',originalOdds:-110}]);assert.equal(priced.units,1.5);assert.equal(priced.roi,75);
});
test('revisions preserve original title, projection, favorite and market',()=>{
 const old={id:'x',title:'Over 50.5',projection:60,odds:-110,gameIds:['g'],favorite:false,line:50.5};
 const p=R.latest([{league:'NFL',publishedAt:'2026-09-13',props:[old]},{league:'NFL',publishedAt:'2026-09-15',props:[{...old,title:'Over 40.5',projection:65,favorite:true,result:'win',line:40.5}]}])[0];
 assert.equal(p.originalTitle,'Over 50.5');assert.equal(p.originalProjection,60);assert.equal(p.originalLine,50.5);assert.equal(R.favorite(p),false);
 assert.equal(A.historical(p,new Map([['g',g]])),false);
});
test('score errors distinguish total and margin; Monday remains provider Week 1',()=>{
 const rows=A.scores([g],[base],[]),s=A.scoreSummary(rows);assert.equal(s.totalMAE,3);assert.equal(s.marginMAE,3);assert.equal(s.totalBias,3);assert.equal(s.wins,1);assert.equal(A.week(g),1);
 assert.equal(A.week({...g,league:'CFB',kickoff:'2026-08-29T12:00Z'}),0);
});

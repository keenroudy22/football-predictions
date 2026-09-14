const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const R=require('../site/records.js');

test('payouts use risk amount for positive and negative American odds',()=>{
  assert.equal(R.profit(150,10),15);
  assert.equal(R.profit(-200,10),5);
  assert.equal(R.profit(null,10),null);
});

test('revisions do not rewrite original odds or double count',()=>{
  const reports=[{league:'NFL',publishedAt:'2026-09-01T12:00:00Z',props:[{id:'a',odds:-110,result:'loss'}]},
    {league:'NFL',publishedAt:'2026-09-02T12:00:00Z',props:[{id:'a',odds:+120,result:'win'}]}];
  const picks=R.latest(reports);
  assert.equal(picks.length,1);
  assert.equal(picks[0].originalOdds,-110);
  assert.equal(R.summarize(picks).units,100/110);
});

test('missing prices, pushes, voids and pending never fabricate ROI',()=>{
  const s=R.summarize([{result:'win',originalOdds:null},{result:'loss',originalOdds:-110},{result:'push',originalOdds:120},{result:'void',originalOdds:120},{result:'unverified',originalOdds:120}]);
  assert.equal(s.hitRate,50);
  assert.equal(s.pending,1);
  assert.equal(s.priced,2);
  assert.equal(s.units,-1);
  assert.equal(s.roi,-50);
});

test('Week 1 favorites follow the explicit final five, while the archive retains every line',()=>{
  const report=JSON.parse(fs.readFileSync('research/2026-09-14-NFL-week-1-import.json','utf8'));
  const picks=R.latest([report]);
  const favorites=picks.filter(R.favorite);
  assert.equal(favorites.length,5);
  assert.equal(R.summarize(favorites).wins,1);
  assert.equal(R.summarize(favorites).losses,4);
  assert.equal(picks.length,26);
  assert.equal(R.illustrative(favorites).units.toFixed(2),'-3.09');
  assert.equal(R.illustrative(picks).units.toFixed(2),'1.73');
});

test('illustrative one-unit return uses known odds, excludes voids and pending, and marks assumed wins',()=>{
  const s=R.illustrative([{result:'win',originalOdds:150},{result:'win',originalOdds:null},{result:'loss',originalOdds:null},{result:'push',originalOdds:null},{result:'void',originalOdds:null},{result:'unverified',originalOdds:null}]);
  assert.equal(s.stakes,4);
  assert.equal(s.assumedWins,1);
  assert.equal(s.units.toFixed(2),'1.41');
  assert.equal(s.roi.toFixed(1),'35.2');
});

test('college opening weekend is labeled Week 0',()=>{
  const games=new Map([['a',{league:'CFB',season:2026,week:1,kickoff:'2026-08-29T16:00:00Z'}],['b',{league:'NFL',season:2026,week:1,kickoff:'2026-09-10T00:20:00Z'}]]);
  assert.equal(R.week({gameIds:['a']},games).week,0);
  assert.equal(R.week({gameIds:['b']},games).week,1);
});

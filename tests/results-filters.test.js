'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,'site/data',name+'.json'),'utf8'));
const source=fs.readFileSync(path.join(root,'site/dashboard.js'),'utf8')+'\n'+fs.readFileSync(path.join(root,'site/app.js'),'utf8').replace(/\binit\(\);\s*$/,'')+'\nglobalThis.api={state,resultsPage,resultGames,recordFilters};';
function setup(){
  const ctx={FootballRecords:require('../site/records.js'),FootballAnalytics:require('../site/analytics.js'),localStorage:{getItem:()=>null},Intl,Date};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  const api=ctx.api;
  Object.assign(api.state,{slate:read('slate'),forecasts:read('forecasts'),reports:read('research'),context:read('research-context'),history:read('player-history'),week:'2026-09-15',league:'NFL',recordWeek:'total',recordScope:'all',recordEvidence:'all',resultTab:'picks'});
  return api;
}
const ledgerCount=html=>(html.match(/class="ledger-card"/g)||[]).length;
const metricValues=(html,label)=>[...html.matchAll(new RegExp('<span>'+label+'</span><strong>([^<]+)</strong>','g'))].map(match=>match[1]);

test('Results defaults to All sports and offers every supported league',()=>{
  const api=setup();assert.equal(api.state.recordLeague,'All');
  const html=api.resultsPage(),select=html.match(/<select id="record-league">([\s\S]*?)<\/select>/)?.[1];
  assert.ok(select,'Results includes a league selector');
  for(const [value,label] of [['All','All sports'],['NFL','NFL'],['CFB','College football'],['NBA','NBA'],['MLB','MLB']])assert.match(select,new RegExp('<option value="'+value+'"[^>]*>'+label+'<\\/option>'));
  assert.match(select,/<option value="All" selected>All sports<\/option>/);
});

test('All sports counts existing selections once and states incomplete sports coverage',()=>{
  const api=setup();api.state.recordLeague='NFL';const nfl=ledgerCount(api.resultsPage());
  api.state.recordLeague='CFB';const college=ledgerCount(api.resultsPage());
  api.state.recordLeague='All';const all=api.resultsPage();
  assert.ok(nfl>0,'The saved NFL ledger has selections');
  assert.equal(ledgerCount(all),nfl+college,'Changing scope does not duplicate a saved selection');
  assert.match(all,/NBA/);assert.match(all,/MLB/);
  assert.match(all,/schedules and scores only|no tracked|not yet tracked/i);
  assert.equal((all.match(/<h4>Colston Loveland[^<]*<\/h4>/g)||[]).length,1);
});

for(const league of ['NBA','MLB'])test(`${league} has honest empty states across every Results tab`,()=>{
  const api=setup();api.state.recordLeague=league;
  for(const tab of ['picks','scores','markets','learning','archive']){
    api.state.resultTab=tab;const html=api.resultsPage();
    assert.match(html,new RegExp('No tracked '+league+' .+ yet\\.'));
    assert.match(html,new RegExp(league+' currently has schedules and scores only'));
    assert.match(html,new RegExp('href="#sport/'+league+'"'));
    assert.doesNotMatch(html,/Colston Loveland|Baker Mayfield|Brock Bowers|class="ledger-card"|class="metric"|0[–-]0[–-]0|\bWeek\s*\d|NaN|Invalid Date|undefined/);
  }
});

test('Nonfootball and All sports scopes clear a previously selected football week',()=>{
  const api=setup();
  for(const league of ['NBA','MLB','All']){
    api.state.recordLeague=league;api.state.recordWeek='2026-1';
    const html=api.resultsPage();assert.equal(api.state.recordWeek,'total');
    const period=html.match(/<select id="record-week">([\s\S]*?)<\/select>/)?.[1];
    assert.ok(period);assert.equal((period.match(/<option/g)||[]).length,1);
    assert.doesNotMatch(period,/Week/);
  }
});

test('NFL Week 1 favorites preserve the original five and unavailable historical profit',()=>{
  const api=setup();Object.assign(api.state,{recordLeague:'NFL',recordWeek:'2026-1',recordScope:'favorites'});
  const html=api.resultsPage();assert.equal(ledgerCount(html),5);
  for(const player of ['Colston Loveland','Baker Mayfield','Cade Otton','Tony Pollard','Rashod Bateman'])assert.match(html,new RegExp(player));
  assert.match(html,/1–4–0/);assert.match(html,/5 picks/);assert.match(html,/20\.0%/);
  assert.deepEqual(metricValues(html,'NET UNITS'),['—']);assert.deepEqual(metricValues(html,'ROI'),['—']);
  assert.match(html,/5 outcomes lack original prices/);assert.match(html,/original pregame time unverified/);
});

function syntheticScores(api){
  const game=(league,away,home)=>({id:league+'-test',league,season:2026,week:1,kickoff:'2026-09-10T00:00:00Z',completed:true,state:'post',away:{id:league+'-away',abbreviation:league+'A',score:away},home:{id:league+'-home',abbreviation:league+'H',score:home}});
  api.state.slate={games:[game('NFL',20,22),game('CFB',30,40)]};
  api.state.forecasts=[{gameId:'NFL-test',away:20,home:20,publishedAt:'2026-09-09T00:00:00Z',model:'shared-test-version'},{gameId:'CFB-test',away:30,home:30,publishedAt:'2026-09-09T00:00:00Z',model:'shared-test-version'}];
  api.state.reports=[];api.state.recordLeague='All';api.state.recordWeek='total';
}

test('All sports score accuracy shows league-specific error metrics instead of a pooled number',()=>{
  const api=setup();syntheticScores(api);api.state.resultTab='scores';const html=api.resultsPage();
  assert.match(html,/>NFL<\/h[23]>/);assert.match(html,/>College football<\/h[23]>/);
  assert.deepEqual(metricValues(html,'TOTAL POINTS ERROR'),['2.0','10.0']);
  assert.equal((html.match(/class="score-result"/g)||[]).length,2);
  assert.doesNotMatch(html,/<span>TOTAL POINTS ERROR<\/span><strong>6\.0<\/strong>/);
});

test('All sports learning keeps each league separate even when model version names match',()=>{
  const api=setup();syntheticScores(api);api.state.resultTab='learning';const html=api.resultsPage();
  assert.match(html,/>NFL<\/h[23]>/);assert.match(html,/>College football<\/h[23]>/);
  assert.deepEqual(metricValues(html,'TOTAL BIAS'),['-2.0 pts','-10.0 pts']);
  assert.doesNotMatch(html,/Across 2 games|<strong>-6\.0 pts<\/strong>/);
  assert.match(html,/NFL 2026 · Week 1/);assert.match(html,/CFB 2026 · Week 1/);
});

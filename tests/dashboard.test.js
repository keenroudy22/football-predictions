const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=name=>name==='research-context'&&!fs.existsSync(path.join(root,'site/data',name+'.json'))?{leagues:{}}:JSON.parse(fs.readFileSync(path.join(root,'site/data',name+'.json'),'utf8'));
const ctx={FootballRecords:require('../site/records.js'),FootballAnalytics:require('../site/analytics.js'),localStorage:{getItem:()=>null},Intl,Date};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root,'site/dashboard.js'),'utf8')+'\n'+fs.readFileSync(path.join(root,'site/app.js'),'utf8').replace(/\binit\(\);\s*$/,'')+'\nglobalThis.api={state,resultsPage,researchHub,weekOverview,gamePage};',ctx);
const api=ctx.api;Object.assign(api.state,{slate:read('slate'),forecasts:read('forecasts'),reports:read('research'),context:read('research-context'),history:read('player-history'),week:'2026-09-15',league:'NFL',recordLeague:'NFL',recordWeek:'total',recordScope:'all'});
test('all redesigned pages render using actual saved data',()=>{
 for(const tab of ['picks','scores','markets','learning','archive']){api.state.resultTab=tab;const html=api.resultsPage();assert.ok(html.length>500);assert.doesNotMatch(html,/NaN|Invalid Date|undefined/);}
 assert.match(api.weekOverview(),/Your week at a glance/);
 assert.match(api.researchHub(),/Injury feed/);
 const game=api.state.slate.games.find(g=>g.id==='NFL-401872932');
 assert.match(api.gamePage(game),/Injuries &amp; availability/);assert.match(api.gamePage(game),/Recent opponents/);
});
test('historical archive keeps final five while verified record excludes imports',()=>{
 api.state.recordScope='favorites';api.state.resultTab='archive';const archive=api.resultsPage();assert.match(archive,/Colston Loveland/);assert.match(archive,/Unavailable/);assert.doesNotMatch(archive,/≈|at assumed/);
 api.state.resultTab='picks';assert.doesNotMatch(api.resultsPage(),/Colston Loveland/);
});
test('research hub labels incomplete college coverage',()=>{
 api.state.league='CFB';assert.match(api.researchHub(),/College coverage is incomplete/);api.state.league='NFL';
});

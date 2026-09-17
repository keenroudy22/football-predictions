// A reproducible evidence packet for the next research run. No model tuning.
const fs=require('node:fs'),path=require('node:path');
const A=require('../site/analytics.js'),R=require('../site/records.js');
const root=path.resolve(__dirname,'../site/data');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name+'.json'),'utf8'));
const slate=read('slate'),forecasts=read('forecasts'),reports=read('research');
const map=new Map(slate.games.map(g=>[g.id,g]));
const picks=R.latest(reports).filter(p=>!A.historical(p,map));
const rows=A.scores(slate.games,forecasts,reports);
const groups=new Map();
for(const row of rows){
 const key=[row.g.league,row.g.season,A.week(row.g),row.p.model||row.p.modelVersion||'unversioned'].join('/');
 if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
}
const output={generatedAt:new Date().toISOString(),method:'pregame-evaluation-v1',
 scoreGroups:[...groups].map(([key,sample])=>({key,...A.scoreSummary(sample)})),
 selections:A.recordSummary(picks),
 workload:picks.filter(p=>Number.isFinite(p.originalProjection)&&Number.isFinite(p.actualValue)&&['win','loss','push'].includes(p.result)).map(p=>({id:p.id,title:p.originalTitle,projected:p.originalProjection,actual:p.actualValue,error:p.originalProjection-p.actualValue,source:p.resultSource})),
 pending:picks.filter(p=>!['win','loss','push','void'].includes(p.result)).map(p=>({id:p.id,title:p.originalTitle,lastCheckedAt:p.lastCheckedAt||null,nextReviewAt:p.nextReviewAt||null})),
 interpretation:'Descriptive evidence, not a trained update. Compare workload, personnel and opponent strength; register changes before evaluating later games. Never retune to a single result.'};
fs.writeFileSync(path.join(root,'review.json'),JSON.stringify(output,null,2)+'\n');
console.log(`Review packet: ${rows.length} graded games, ${picks.length} verified selections, ${output.workload.length} numeric workload outcomes.`);

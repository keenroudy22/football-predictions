'use strict';
const FootballAnalytics=(()=>{
  const Records=typeof module!=='undefined'?require('./records.js'):FootballRecords;
  const valid=n=>typeof n==='number'&&Number.isFinite(n);
  const before=(a,b)=>Number.isFinite(Date.parse(a))&&Date.parse(a)<Date.parse(b);
  const week=g=>g.league==='CFB'&&g.week===1&&new Date(g.kickoff)<new Date(`${g.season}-09-01T00:00:00Z`)?0:g.week;
  function score(g,forecasts,reports,mode='displayed'){
    const baseline=forecasts.filter(p=>p.gameId===g.id&&valid(p.home)&&valid(p.away)&&before(p.publishedAt,g.kickoff)).sort((a,b)=>Date.parse(a.publishedAt)-Date.parse(b.publishedAt))[0];
    const revisions=reports.filter(r=>r.league===g.league).flatMap(r=>(r.scores||[]).filter(p=>p.gameId===g.id&&valid(p.home)&&valid(p.away)).map(p=>({...p,publishedAt:r.publishedAt,type:r.historicalImport?'historical':'analyst',historicalImport:!!r.historicalImport})));
    if(mode==='historical')return revisions.filter(p=>p.historicalImport).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0];
    if(mode==='baseline')return baseline;
    const reviewed=revisions.filter(p=>!p.historicalImport&&before(p.publishedAt,g.kickoff)).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0];
    if(mode==='reviewed')return reviewed;
    return reviewed||baseline;
  }
  function scores(games,forecasts,reports,mode='displayed'){
    return games.flatMap(g=>{
      const p=score(g,forecasts,reports,mode);if(!p||!g.completed||!valid(g.home.score)||!valid(g.away.score))return [];
      const predictedTotal=p.home+p.away,actualTotal=g.home.score+g.away.score;
      const predictedMargin=p.home-p.away,actualMargin=g.home.score-g.away.score;
      return [{g,p,predictedTotal,actualTotal,totalError:predictedTotal-actualTotal,marginError:predictedMargin-actualMargin,winnerCorrect:Math.sign(predictedMargin)===Math.sign(actualMargin),exact:p.home===g.home.score&&p.away===g.away.score}];
    });
  }
  function scoreSummary(rows){
    const n=rows.length,mean=fn=>n?rows.reduce((s,r)=>s+fn(r),0)/n:null;
    return {n,wins:rows.filter(r=>r.winnerCorrect).length,totalMAE:mean(r=>Math.abs(r.totalError)),marginMAE:mean(r=>Math.abs(r.marginError)),totalBias:mean(r=>r.totalError),marginBias:mean(r=>r.marginError),exact:rows.filter(r=>r.exact).length};
  }
  function recordSummary(picks){
    const s=Records.summarize(picks);
    const settled=picks.filter(p=>['win','loss','push'].includes(p.result));
    const missing=settled.filter(p=>!Records.validOdds(p.originalOdds)).length;
    return {...s,missing,units:missing||!settled.length?null:s.units,roi:missing||!settled.length?null:s.roi};
  }
  function historical(p,games){
    return p.historicalImport||p.status==='historical'||!(p.originalGameIds||p.gameIds||[]).length||(p.originalGameIds||p.gameIds).some(id=>!games.has(id)||!before(p.originalPublishedAt||p.publishedAt,games.get(id).kickoff));
  }
  return {score,scores,scoreSummary,recordSummary,historical,week};
})();
if(typeof module!=='undefined')module.exports=FootballAnalytics;

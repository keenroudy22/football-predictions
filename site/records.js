'use strict';
const FootballRecords = (() => {
  const FAVORITES = new Set(['w1-loveland-rec','w1-mayfield-pass','w1-otton-rec','w1-pollard-carries','w1-bateman-rec']);
  const validOdds = odds => Number.isFinite(Number(odds)) && Math.abs(Number(odds)) >= 100;
  const profit = (odds, stake=1) => !validOdds(odds) ? null : stake * (Number(odds)>0 ? Number(odds)/100 : 100/Math.abs(Number(odds)));
  function latest(reports) {
    const result = new Map();
    reports.slice().sort((a,b)=>a.publishedAt.localeCompare(b.publishedAt)).forEach(report=>{
      for(const kind of ['props','riskyProps','parlays','gamePicks']) for(const pick of report[kind]||[]){
        const previous=result.get(pick.id);
        result.set(pick.id,{...previous,...pick,league:report.league,publishedAt:report.publishedAt,historicalImport:previous?previous.historicalImport:!!report.historicalImport,kind,originalPublishedAt:previous?previous.originalPublishedAt:report.publishedAt,originalTitle:previous?previous.originalTitle:pick.title,originalGameIds:previous?previous.originalGameIds:pick.gameIds,originalProjection:previous?previous.originalProjection:pick.projection,originalConfidence:previous?previous.originalConfidence:pick.confidence,originalFavorite:previous?previous.originalFavorite:pick.favorite===true,originalLine:previous?previous.originalLine:pick.line,originalDirection:previous?previous.originalDirection:pick.direction,originalOdds:previous?previous.originalOdds:(validOdds(pick.odds)?pick.odds:null),originalBook:previous?previous.originalBook:(pick.book??null)});
      }
    });
    return [...result.values()];
  }
  function summarize(picks){
    const s={total:picks.length,wins:0,losses:0,pushes:0,voids:0,pending:0,priced:0,units:0};
    for(const p of picks){
      if(p.result==='win')s.wins++;
      else if(p.result==='loss')s.losses++;
      else if(p.result==='push')s.pushes++;
      else if(p.result==='void')s.voids++;
      else s.pending++;
      if(['win','loss','push'].includes(p.result)&&validOdds(p.originalOdds)){
        s.priced++;
        s.units += p.result==='loss' ? -1 : p.result==='win' ? profit(p.originalOdds) : 0;
      }
    }
    s.graded=s.wins+s.losses;
    s.hitRate=s.graded?100*s.wins/s.graded:null;
    s.roi=s.priced?100*s.units/s.priced:null;
    return s;
  }
  function illustrative(picks, assumedOdds=-110){
    let units=0, stakes=0, assumedWins=0;
    for(const p of picks){
      if(!['win','loss','push'].includes(p.result))continue;
      stakes++;
      if(p.result==='loss')units-=1;
      if(p.result==='win'){
        const hasPrice=validOdds(p.originalOdds);
        units+=profit(hasPrice?p.originalOdds:assumedOdds);
        if(!hasPrice)assumedWins++;
      }
    }
    return {units:stakes?units:null,roi:stakes?100*units/stakes:null,stakes,assumedWins};
  }
  const favorite = p => (p.originalFavorite??p.favorite)===true || FAVORITES.has(p.id);
  const category = p => p.kind==='gamePicks'?(p.marketType==='total'?'Totals':'Spreads'):p.kind==='props'?'Straights':p.kind==='riskyProps'?'Risky lines':p.parlayType==='longshot'?'Longshots':'Parlays';
  const week = (p,games) => {
    const g=(p.gameIds||[]).map(id=>games.get(id)).find(Boolean);
    if(!g)return null;
    return {season:g.season,week:g.league==='CFB'&&g.week===1&&new Date(g.kickoff)<new Date(`${g.season}-09-01T00:00:00Z`)?0:g.week,league:g.league};
  };
  return {FAVORITES,validOdds,profit,latest,summarize,illustrative,favorite,category,week};
})();
if(typeof module!=='undefined')module.exports=FootballRecords;

(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.KeenMatchups=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numeric=v=>typeof v==='number'&&Number.isFinite(v);
  const https=v=>typeof v==='string'&&/^https:\/\//.test(v);
  const validTime=v=>Boolean(v)&&Number.isFinite(Date.parse(v));
  const keys={'receiving yards':'receivingYards','receptions':'receptions','passing yards':'passingYards','passing attempts':'passingAttempts','completions':'completions','rushing yards':'rushingYards','rushing attempts':'rushingAttempts','carries':'rushingAttempts'};
  const positions={QB:'quarterbacks',RB:'running backs',WR:'wide receivers',TE:'tight ends'};
  const date=v=>validTime(v)?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric'}).format(new Date(v)):'Date unavailable';

  function view(record,player,state){
    const game=(state.slate?.games||[]).find(g=>g.id===record.gameIds?.[0]);
    const form=record.recentForm;
    const match=String(record.marketTitle||record.title||'').match(/\b(OVER|UNDER)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);
    if(!game||!validTime(game.kickoff)||game.league!=='NFL'||!positions[player.position]||!match||!keys[match[3].toLowerCase()])return null;
    // Resolve the recorded opponent, never today's roster for an older game.
    const defenseId=form?.opponentId||form?.vsOpponent?.opponentId;
    const side=['home','away'].find(side=>defenseId!=null&&String(game[side]?.id)===String(defenseId));
    if(!side)return null;
    const bucket=state.opponents?.games?.[game.id]?.[side];
    const fallback=state.history?.defenses?.[game.id]?.[side];
    const candidate=bucket?.games?.length?bucket.games:fallback?[fallback]:[];
    const key=keys[match[3].toLowerCase()],seen=new Set();
    const cutoff=Math.min(...[game.kickoff,record.originalPublishedAt||record.publishedAt,form?.cutoffAt].filter(validTime).map(Date.parse));
    const games=candidate.filter(row=>{
      const eventId=String(row.eventId||'').replace(/^NFL-/,''),sourceId=https(row.source)?row.source.match(/\/gameId\/(\d+)(?:[/?#]|$)/)?.[1]:null;
      if(String(row.defenseId)!==String(defenseId)||!eventId||sourceId!==eventId||eventId===game.id.split('-').pop()||seen.has(eventId)||!validTime(row.kickoff)||Date.parse(row.kickoff)>=cutoff||(row.seasonType!=null&&!['regular',2,'2'].includes(row.seasonType)))return false;
      seen.add(eventId);return true;
    }).sort((a,b)=>Date.parse(b.kickoff)-Date.parse(a.kickoff)).slice(0,5).map(row=>({
      ...row,total:numeric(row.positions?.[player.position]?.[key])?row.positions[player.position][key]:null,
      players:(row.players||[]).filter(p=>p.position===player.position&&numeric(p.stats?.[key])).map(p=>({name:p.name,athleteId:p.athleteId,value:p.stats[key]}))
    }));
    const totals=games.filter(g=>g.total!==null);
    return {game,defense:game[side],position:player.position,stat:match[3].toLowerCase(),line:Number(match[2]),direction:match[1].toUpperCase(),games,
      average:totals.length?totals.reduce((sum,g)=>sum+g.total,0)/totals.length:null,totalSample:totals.length,
      status:bucket?.status||fallback?.status||'unavailable',checkedAt:bucket?.checkedAt||fallback?.checkedAt};
  }
  function panel(record,player,state){
    const d=view(record,player,state);
    const empty='<section class="player-panel opponent-panel"><h3>Against the upcoming defense</h3><p>Comparable position history has not been verified for this recorded player, market and opponent yet.</p></section>';
    if(!d||!d.games.length)return empty;
    const samples=d.games.reduce((sum,g)=>sum+g.players.length,0);
    return `<section class="player-panel opponent-panel"><div class="opponent-heading"><div><p class="eyebrow">THE MATCHUP</p><h3>How other ${positions[d.position]} did against ${esc(d.defense.name)}</h3><p>${esc(d.stat)} · Before ${date(d.game.kickoff)} · ${d.games.length} regular-season game${d.games.length===1?'':'s'}</p></div><a href="#game/${esc(d.game.id)}">Full game research →</a></div>
      <div class="player-rates"><div><span>${esc(d.position)} group average / game</span><strong>${d.average===null?'Unavailable':d.average.toFixed(1)}</strong><small>${d.totalSample} sourced game${d.totalSample===1?'':'s'}</small></div><div><span>Recorded player results</span><strong>${samples}</strong><small>Listed ${esc(d.position)} appearances</small></div><div><span>Research threshold</span><strong>${esc(d.line)}</strong><small>${esc(d.direction)} · ${esc(d.stat)}</small></div></div>
      <p class="player-notice">Group totals combine every ${esc(d.position)} in that game; they are not one player's projection. The comparisons below apply this selected threshold to historical stats, not each player's original sportsbook line. Roles, teammates and defensive personnel may differ; older-season games are labeled.</p>
      ${d.games.map((g,i)=>`<details class="opponent-game"${i===0?' open':''}><summary><span>${date(g.kickoff)} · ${esc(g.opponent)}${g.season!==d.game.season?' · prior season':''}</span><strong>${g.total===null?'Group total unavailable':`${esc(d.position)} group: ${g.total} ${esc(d.stat)}`}</strong></summary><div class="opponent-table-wrap"><table><caption>${esc(d.position)} player results vs ${esc(d.defense.abbreviation)}</caption><thead><tr><th scope="col">Player</th><th scope="col">${esc(d.stat)}</th><th scope="col">At ${esc(d.line)}</th></tr></thead><tbody>${g.players.map(p=>`<tr><th scope="row">${esc(p.name)}</th><td>${p.value}</td><td>${p.value===d.line?'Equal to line':(p.value>d.line?'Above line':'Below line')}</td></tr>`).join('')||'<tr><td colspan="3">Individual results unavailable; no zeroes assumed.</td></tr>'}</tbody></table></div><a class="opponent-source" href="${esc(g.source)}" target="_blank" rel="noopener noreferrer">View source box score ↗</a></details>`).join('')}
      <p class="player-notice">${d.status!=='ok'?'Retained snapshot · latest refresh incomplete. ':''}Last successful check: ${date(d.checkedAt)}. This is a small descriptive sample, not a league ranking or a win probability.</p></section>`;
  }
  return {view,panel};
});

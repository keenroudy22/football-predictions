'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Matchups=require('../site/matchups.js');

const row=(eventId='701',extra={})=>({eventId,defenseId:'2',opponent:'Opponent offense',kickoff:'2026-09-14T18:00:00Z',season:2026,seasonType:'regular',source:`https://www.espn.com/nfl/boxscore/_/gameId/${eventId}`,positions:{RB:{receptions:3,receivingYards:40}},players:[{athleteId:'11',name:'Zero catches',position:'RB',stats:{receptions:0}},{athleteId:'12',name:'Three catches',position:'RB',stats:{receptions:3}},{athleteId:'13',name:'Other position',position:'WR',stats:{receptions:9}},{athleteId:'14',name:'Other stat',position:'RB',stats:{receivingYards:12}}],...extra});
function fixture(){
  const game={id:'NFL-900',league:'NFL',season:2026,kickoff:'2026-09-17T23:00:00Z',home:{id:'2',name:'Buffalo',abbreviation:'BUF'},away:{id:'8',name:'Detroit',abbreviation:'DET'}};
  const record={id:'pick',title:'Sample Back OVER 5 receptions',gameIds:[game.id],originalPublishedAt:'2026-09-15T18:00:00Z',publishedAt:'2026-09-17T18:00:00Z',recentForm:{opponentId:'2',cutoffAt:game.kickoff}};
  const bucket={games:[row()],status:'ok',checkedAt:'2026-09-15T17:00:00Z'};
  return {record,player:{position:'RB'},bucket,state:{slate:{games:[game]},opponents:{games:{[game.id]:{home:bucket}}},history:{defenses:{}}}};
}

test('matchup results select the same position and market without replacing missing values with zero',()=>{
  const {record,player,state,bucket}=fixture();
  bucket.games.push(row('702',{kickoff:'2026-09-13T18:00:00Z',positions:{RB:{receptions:0}},players:[{athleteId:'20',name:'Verified zero',position:'RB',stats:{receptions:0}},{athleteId:'21',name:'Null',position:'RB',stats:{receptions:null}},{athleteId:'22',name:'String',position:'RB',stats:{receptions:'3'}},{athleteId:'23',name:'Boolean',position:'RB',stats:{receptions:false}}]}));
  bucket.games.push(row('703',{kickoff:'2026-09-12T18:00:00Z',positions:{RB:{receptions:null}},players:[]}));
  const result=Matchups.view(record,player,state);
  assert.deepEqual(result.games[0].players.map(p=>p.name),['Zero catches','Three catches']);
  assert.deepEqual(result.games[1].players.map(p=>p.value),[0]);
  assert.equal(result.games[1].total,0);assert.equal(result.games[2].total,null);
  assert.equal(result.totalSample,2);assert.equal(result.average,1.5);
});

test('defense identity, target event, duplicates and the original publication bound constrain comparisons',()=>{
  const {record,player,state,bucket}=fixture();
  bucket.games.push(row('701'),row('702',{defenseId:'99',opponent:'Buffalo'}),row('900',{kickoff:'2026-09-01T00:00:00Z'}),row('NFL-900',{kickoff:'2026-09-01T00:00:00Z'}),row('703',{kickoff:record.originalPublishedAt}),row('704',{kickoff:'2026-09-16T18:00:00Z'}),row('705',{kickoff:'2026-09-18T18:00:00Z'}));
  const result=Matchups.view(record,player,state);
  assert.deepEqual(result.games.map(g=>g.eventId),['701']);
  record.recentForm.opponentId='99';
  assert.equal(Matchups.view(record,player,state),null,'A matching team name cannot identify the target defense');
});

test('event source identity and explicit nonregular rows cannot be labeled regular-season evidence',()=>{
  const {record,player,state,bucket}=fixture();
  bucket.games.push(row('702',{source:'https://www.espn.com/nfl/boxscore/_/gameId/999'}),row('703',{seasonType:'preseason'}),row('704',{seasonType:'postseason'}));
  assert.deepEqual(Matchups.view(record,player,state).games.map(g=>g.eventId),['701']);
});

test('the most recent five qualifying games are selected after source and cutoff checks',()=>{
  const {record,player,state,bucket}=fixture();
  bucket.games=Array.from({length:8},(_,i)=>row(String(700+i),{kickoff:`2026-09-${String(i+1).padStart(2,'0')}T18:00:00Z`}));
  assert.deepEqual(Matchups.view(record,player,state).games.map(g=>g.eventId),['707','706','705','704','703']);
});

test('unsupported leagues, positions and markets do not produce fabricated matchup statistics',()=>{
  const {record,player,state}=fixture();
  assert.equal(Matchups.view(record,{position:'K'},state),null);
  assert.equal(Matchups.view({...record,title:'Sample Back Anytime touchdown'},player,state),null);
  state.slate.games[0].league='CFB';
  assert.equal(Matchups.view(record,player,state),null);
  const html=Matchups.panel(record,player,state);
  assert.match(html,/not been verified/);assert.doesNotMatch(html,/group average|0\.0|win probability/);
});

test('position totals are clearly separated from individual results and betting probabilities',()=>{
  const {record,player,state,bucket}=fixture();
  bucket.games[0].players.push({athleteId:'30',name:'Equal threshold',position:'RB',stats:{receptions:5}});
  const html=Matchups.panel(record,player,state);
  assert.match(html,/RB group average \/ game/);
  assert.match(html,/Group totals combine every RB/);
  assert.match(html,/not one player's projection/);
  assert.match(html,/not each player's original sportsbook line/);
  assert.match(html,/not a league ranking or a win probability/);
  assert.match(html,/Equal to line/);assert.match(html,/href="https:\/\/www\.espn\.com\/nfl\/boxscore\/_\/gameId\/701"/);
});

test('stale matchup snapshots remain visibly stale with their last successful check',()=>{
  const {record,player,state,bucket}=fixture();
  bucket.status='stale';bucket.checkedAt='2026-09-01T17:00:00Z';bucket.lastAttemptAt='2026-09-17T18:00:00Z';
  const html=Matchups.panel(record,player,state);
  assert.match(html,/Retained snapshot · latest refresh incomplete/);
  assert.match(html,/Last successful check: Sep 1, 2026/);
  assert.doesNotMatch(html,/Last successful check: Sep 17/);
});

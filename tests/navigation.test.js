const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const script=fs.readFileSync(require('node:path').join(__dirname,'../site/app.js'),'utf8').replace(/\binit\(\);\s*$/,'');

test('healthy sports navigation survives a required football feed failure',async()=>{
  const nodes=new Map(), events=[];
  const node=s=>{if(!nodes.has(s))nodes.set(s,{textContent:'',innerHTML:'',value:'',classList:{add(){},toggle(){}},addEventListener(){}});return nodes.get(s)};
  let sportsRendered=0;
  const sports={load:async()=>({leagues:{MLB:{status:'ok'}}}),matches:h=>h==='#sport/MLB',render:()=>sportsRendered++,syncNavigation(){}};
  const context={Intl,Date,Set,Map,URL,console,localStorage:{getItem:()=>null},
    document:{querySelector:node,querySelectorAll:()=>[],activeElement:null},
    location:{hash:'#sport/MLB'},window:{KeenSports:sports,addEventListener:(e,f)=>events.push(e),scrollTo(){}},
    fetch:async()=>({ok:false}),setInterval:()=>0};
  vm.createContext(context);
  vm.runInContext(script+'\nglobalThis.api={init,render,state};',context);
  await context.api.init();
  assert.equal(context.api.state.footballError,true);
  assert.equal(sportsRendered,1);
  assert.ok(events.includes('hashchange'));
  context.location.hash='#record';context.api.render();
  assert.match(node('#content').innerHTML,/Football board temporarily unavailable/);
  assert.doesNotMatch(node('#content').innerHTML,/0 wins|No games/);
});

test('compact line board receives the original research state and stops on a required feed failure',()=>{
  const nodes=new Map();
  const node=s=>{if(!nodes.has(s))nodes.set(s,{textContent:'',innerHTML:'',hidden:false,classList:{add(){},toggle(){}}});return nodes.get(s)};
  const delivered=[];
  const context={Intl,Date,Set,Map,URL,localStorage:{getItem:()=>null},
    document:{querySelector:node,querySelectorAll:()=>[]},location:{hash:'#props'},
    window:{KeenSports:{matches:()=>false,syncNavigation(){}},KeenBoard:{render:({state})=>delivered.push(state)}}};
  vm.createContext(context);
  vm.runInContext(script+'\nglobalThis.api={render,state};',context);
  const state=context.api.state;
  Object.assign(state,{view:'props',slate:{games:[],sources:[]},reports:[{league:'NFL',publishedAt:'2026-09-17',props:[{id:'original',odds:-115}]}],marketLines:{updatedAt:'2026-09-17T16:00:00Z',lines:[]}});
  const before=JSON.stringify(state.reports);
  context.api.render();
  assert.equal(delivered.length,1);assert.equal(delivered[0],state);
  assert.equal(JSON.stringify(state.reports),before);
  assert.match(node('#freshness').textContent,/Line board compiled/);
  state.footballError=true;context.api.render();
  assert.equal(delivered.length,1);assert.match(node('#content').innerHTML,/Football board temporarily unavailable/);
});

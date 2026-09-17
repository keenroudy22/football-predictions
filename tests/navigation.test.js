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

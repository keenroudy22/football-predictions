const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../deployment/legacy-redirect/redirect.js'),'utf8');
for(const hash of ['','#record','#game/NFL-401872932','#sport/MLB']){
  test('legacy URL preserves its destination '+(hash||'home'),()=>{
    let destination;const link={};
    vm.runInNewContext(source,{location:{search:'?from=bookmark',hash,replace:url=>destination=url},document:{getElementById:()=>link}});
    assert.equal(destination,'/sports/?from=bookmark'+hash);
    assert.equal(link.href,destination);
  });
}

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createCountryResolver}=require('../gravity-people.cjs');
function setup(options={}){let clock=1900000000000;const calls=[];
 const read=async(kind,extra,request,authority)=>{calls.push({kind,ids:extra.target_user_ids.split(','),authority});
  if(options.fail)return options.fail===true?{errno:-1}:Promise.reject(Error('timeout'));
  return {errno:0,data:{list:extra.target_user_ids.split(',').filter(id=>!(options.omit||[]).includes(id)).map(id=>({user_id:Number(id),user_country:(options.countries||{})[id]??'jp'}))}};};
 return {resolver:createCountryResolver({read,now:()=>clock,chunk:3,maxChunks:2}),calls,advance:ms=>{clock+=ms;}};}
test('unknown people are looked up in comma-joined batches and remembered',async()=>{
 const f=setup({countries:{20:'tw',21:'organic'}});
 const country=await f.resolver.lookup(['10','20','21','10','abc','0'],f.calls,{expectedIdentity:'id'});
 assert.deepEqual(['10','20','21','abc'].map(country),['JP','TW','','']);
 assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].ids,['10','20','21']);assert.equal(f.calls[0].kind,'userList');assert.deepEqual(f.calls[0].authority,{expectedIdentity:'id'});
 await f.resolver.lookup(['10','20','21'],f.calls);assert.equal(f.calls.length,1,'cached');
});
test('large rosters use bounded batches; the rest waits for the next refresh',async()=>{
 const f=setup(),ids=Array.from({length:10},(_,i)=>String(100+i));
 await f.resolver.lookup(ids,f.calls);assert.equal(f.calls.length,2);
 await f.resolver.lookup(ids,f.calls);assert.equal(f.calls.length,4);
});
test('people the server leaves out are asked again only after a minute; real answers last hours',async()=>{
 const f=setup({omit:['11']});const first=await f.resolver.lookup(['10','11'],f.calls);assert.equal(first('11'),'');
 await f.resolver.lookup(['10','11'],f.calls);assert.equal(f.calls.length,1);
 f.advance(61000);await f.resolver.lookup(['10','11'],f.calls);assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1].ids,['11']);
 f.advance(6*3600_000+1);await f.resolver.lookup(['10'],f.calls);assert.equal(f.calls.length,3);
});
test('failures never throw, never block the board, and cool down before retrying',async()=>{
 for(const fail of [true,'reject']){const f=setup({fail});const country=await f.resolver.lookup(['10'],f.calls);assert.equal(country('10'),'');
  await f.resolver.lookup(['10'],f.calls);assert.equal(f.calls.length,1,'cooling down');f.advance(31000);await f.resolver.lookup(['10'],f.calls);assert.equal(f.calls.length,2);}
});

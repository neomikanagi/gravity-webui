'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {makeHandler}=require('../serve.cjs');
const {createProfileService}=require('../gravity-profile.cjs');
async function start(t){const calls=[],profile=createProfileService({identity:()=>({user:'7',identity:'one'}),read:async(kind,extra)=>{
 calls.push([kind,extra]);return {errno:0,data:kind==='roomInfo'?{room_info:{channel_id:'123',user_id:'9'}}:{user_id:'9',name:'User',list:[],last_id:''}};},readRelation:async(kind,extra)=>{
 calls.push([kind,extra]);return {errno:0,data:{list:[],last_id:''}};},readGifts:async extra=>{
 calls.push(['gifts',extra]);return {errno:0,data:{list:[],statistic:null}};},readFoot:async extra=>{
 calls.push(['footprints',extra]);return {errno:0,data:{list:[],last_id:''}};},write:async extra=>{calls.push(['block',extra]);return {errno:0};}});
 const s=http.createServer(makeHandler({profile}));await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));return {url:'http://127.0.0.1:'+s.address().port,calls};}
test('person/posts GETs do not mutate; GET and unknown block endpoints are refused',async t=>{
 const f=await start(t);assert.equal((await fetch(f.url+'/api/profile/person?user_id=9')).status,200);assert.equal((await fetch(f.url+'/api/profile/posts?user_id=9')).status,200);
 assert.equal((await fetch(f.url+'/api/profile/block-host?channel_id=123')).status,405);assert.ok(!f.calls.some(c=>c[0]==='block'));
 assert.equal((await fetch(f.url+'/api/profile/person?user_id=9',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
});
test('block is same-origin JSON with dedicated action and explicit confirmation; recipient is not client-selected',async t=>{
 const f=await start(t),headers={Origin:f.url,'Content-Type':'application/json','X-Gravity-Action':'profile-control','Sec-Fetch-Site':'same-origin'},body={channel_id:'123',expected_anchor_id:'9',request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',confirmed:true};
 for(const patch of [{Origin:'https://evil.invalid'},{Origin:''},{'Content-Type':'text/plain'},{'X-Gravity-Action':'member-control'},{'Sec-Fetch-Site':'same-site'}])assert.equal((await fetch(f.url+'/api/profile/block-host',{method:'POST',headers:{...headers,...patch},body:JSON.stringify(body)})).status,403);
 for(const raw of ['null','[]','bad',JSON.stringify({...body,confirmed:false}),JSON.stringify({...body,target_user_id:'10'})])assert.equal((await fetch(f.url+'/api/profile/block-host',{method:'POST',headers,body:raw})).status,400);
 assert.equal(f.calls.length,0);assert.equal((await fetch(f.url+'/api/profile/block-host',{method:'POST',headers,body:JSON.stringify(body)})).status,200);assert.equal(f.calls.at(-1)[0],'block');
});
test('following/fans/gifts GETs are read-only and validate their targets',async t=>{
 const f=await start(t);
 for(const path of ['/api/profile/following?user_id=9','/api/profile/fans?user_id=9','/api/profile/gifts?user_id=9&list_type=receive','/api/profile/gifts?user_id=9&list_type=send'])assert.equal((await fetch(f.url+path)).status,200);
 assert.equal((await fetch(f.url+'/api/profile/following?user_id=bad')).status,400);
 assert.equal((await fetch(f.url+'/api/profile/gifts?user_id=9&list_type=all')).status,400);
 assert.equal((await fetch(f.url+'/api/profile/gifts?user_id=9')).status,200);
 assert.equal((await fetch(f.url+'/api/profile/fans?user_id=9',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
});
test('footprints GET validates tab and cursor',async t=>{
 const f=await start(t);
 assert.equal((await fetch(f.url+'/api/profile/footprints?tab=0')).status,200);
 assert.equal((await fetch(f.url+'/api/profile/footprints?tab=1')).status,200);
 assert.equal((await fetch(f.url+'/api/profile/footprints?tab=5')).status,400);
 assert.equal((await fetch(f.url+'/api/profile/footprints?tab=0&cursor=?x')).status,400);
});

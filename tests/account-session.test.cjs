'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {createVoiceApi,sessionIdentity}=require('../gravity-api.cjs');
const {makeHandler}=require('../serve.cjs');
const DEVICE={idfa:'synthetic-idfa',uwd:'synthetic-uwd',zone:'9'};
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gravity-account-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const stateFile=path.join(dir,'state/account-state.json');
  let token='synthetic-stored%2Btoken';let device=DEVICE;
  const loaders={stateFile,tokenLoader:()=>token,deviceLoader:()=>device};
  return {api:createVoiceApi(loaders),stateFile,loaders,setToken:value=>{token=value;},setDevice:value=>{device=value;}};
}
function response(errno,data={list:[]}){return {status:200,body:Buffer.from(JSON.stringify({errno,data,errmsg:'PRIVATE-ERROR'}))};}
async function start(t,injections){
 const instance=http.createServer(makeHandler(injections));await new Promise(r=>instance.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{instance.closeAllConnections();instance.close(r);}));return 'http://127.0.0.1:'+instance.address().port;
}
test('local account status distinguishes missing token/device, unverified and successful official read',async t=>{
 const f=fixture(t);assert.equal(f.api.accountStatus().state,'ready_unverified');
 f.setToken(null);assert.equal(f.api.accountStatus().state,'missing_session');
 f.setToken('synthetic-stored%2Btoken');f.setDevice(null);assert.equal(f.api.accountStatus().state,'device_missing');
 f.setDevice(DEVICE);await f.api.trySignedLabels(async()=>response(0));assert.equal(f.api.accountStatus().state,'verified');
 assert.ok(!JSON.stringify(f.api.accountStatus()).includes('synthetic'));
});
test('40026 blocks queued and future official reads, persists only a fingerprint, survives restart',async t=>{
 const f=fixture(t);let calls=0;
 const request=async()=>{calls++;return response(40026);};
 const results=await Promise.all([f.api.trySignedRooms({},request),f.api.trySignedLabels(request),f.api.trySignedRecommendations(request),f.api.trySignedSearch({keyword:'hello'},request)]);
 assert.ok(results.every(r=>r.errno===40026));assert.equal(calls,1);
 const state=f.api.accountStatus();assert.equal(state.state,'rejected_session');assert.equal(state.requires_app_login,true);assert.equal(state.rejection_persisted,true);
 const raw=fs.readFileSync(f.stateFile,'utf8');assert.ok(!raw.includes('synthetic'));assert.ok(!raw.includes('PRIVATE'));
 assert.equal(fs.statSync(f.stateFile).mode&0o777,0o600);
 const restarted=createVoiceApi(f.loaders);assert.equal(restarted.accountStatus().state,'rejected_session');
 assert.equal((await restarted.trySignedSearch({keyword:'hello'},request)).errno,40026);assert.equal(calls,1);
});
test('40025 is also revoked; changing device metadata cannot reactivate the same token',async t=>{
 const f=fixture(t);let calls=0;const request=async()=>{calls++;return response(40025);};
 await f.api.trySignedLabels(request);f.setDevice({...DEVICE,idfa:'different-idfa'});
 await f.api.trySignedSearch({keyword:'x'},request);assert.equal(calls,1);assert.equal(f.api.accountStatus().errno,40025);
});
test('a genuinely new App token is picked up without restarting or logging in',async t=>{
 const f=fixture(t);await f.api.trySignedLabels(async()=>response(40026));f.setToken('synthetic-new-token%2B');
 assert.equal(f.api.accountStatus().state,'ready_unverified');let calls=0;
 const result=await f.api.trySignedRooms({},async request=>{calls++;assert.equal(new URL('https://api.gravity.place'+request.path).searchParams.get('token'),'synthetic-new-token%2B');return response(0);});
 assert.equal(result.errno,0);assert.equal(calls,1);assert.equal(f.api.accountStatus().state,'verified');
});
test('late revocation applies to the requested token, not a token synchronized while it was in flight',async t=>{
 const f=fixture(t);let release;const gate=new Promise(r=>{release=r;});
 const pending=f.api.trySignedLabels(async()=>{await gate;return response(40026);});
 await new Promise(r=>setImmediate(r));f.setToken('new-synthetic-token');release();await pending;
 assert.equal(f.api.accountStatus().state,'ready_unverified');
 assert.equal((await f.api.trySignedLabels(async()=>response(0))).errno,0);
});
test('a queued room heartbeat cannot be signed or written with a newly synchronized account',async t=>{
 const f=fixture(t),expectedIdentity=sessionIdentity(f.loaders.tokenLoader());let release;const gate=new Promise(r=>{release=r;}),calls=[];
 const request=async options=>{calls.push(options);if(options.method!=='POST')await gate;return response(0,{interval:60});};
 const read=f.api.trySignedLabels(request),heartbeat=f.api.writeMemberVoice('memberPresence',{pkg_type:'AudioLive_HeartBeat',version:'1',pkg_data:'{}'},request,{expectedIdentity});
 await new Promise(r=>setImmediate(r));f.setToken('new-synthetic-token');release();await read;
 assert.equal((await heartbeat).errno,-5);assert.equal(calls.length,1);assert.ok(calls.every(c=>c.method!=='POST'));
});
test('temporary network or signing errors do not classify the App login as revoked',async t=>{
 const f=fixture(t);await assert.rejects(f.api.trySignedLabels(async()=>{throw Error('SECRET');}));
 assert.equal((await f.api.trySignedLabels(async()=>response(-4))).errno,-4);
 assert.equal(f.api.accountStatus().state,'ready_unverified');assert.equal(fs.existsSync(f.stateFile),false);
 assert.equal((await f.api.trySignedLabels(async()=>response(0))).errno,0);
});
test('bounded signed queue refuses overflow and never retries a revoked session',async t=>{
 const f=fixture(t);let release;const gate=new Promise(r=>{release=r;});let calls=0;
 const requests=Array.from({length:32},()=>f.api.trySignedLabels(async()=>{calls++;await gate;return response(40026);}));
 assert.equal((await f.api.trySignedLabels(async()=>response(0))).errmsg,'account_request_busy');
 release();await Promise.all(requests);assert.equal(calls,1);
});
test('if rejection persistence fails, in-process requests remain blocked without leaking exceptions',async t=>{
 const f=fixture(t);fs.mkdirSync(path.dirname(f.stateFile),{recursive:true});fs.mkdirSync(f.stateFile);
 let calls=0;const request=async()=>{calls++;return response(40026);};
 await f.api.trySignedLabels(request);await f.api.trySignedLabels(request);
 assert.equal(calls,1);assert.equal(f.api.accountStatus().rejection_persisted,false);
 assert.deepEqual(fs.readdirSync(path.dirname(f.stateFile)),['account-state.json']);
});
test('revoked server session is distinct from historical browser login, and falls back without official calls',async t=>{
 const f=fixture(t);f.api.recordSessionRejection(40026);let officialCalls=0;
 const hot={channel_id:'123',voice_name:'Hello',anchor_info:{user_id:7,name:'Host'}};
 const request=async req=>{if(req.path!=='/gravity/voice/getHotRoomOrPlan?ddd=3'){officialCalls++;throw Error('no official request');}return response(0,{room_list:[hot]});};
 const base=await start(t,{request,account:f.api.accountStatus,signedRooms:f.api.trySignedRooms,signedSearch:f.api.trySignedSearch,signedLabels:f.api.trySignedLabels,signedRecommendations:f.api.trySignedRecommendations});
 const rooms=await(await fetch(base+'/api/rooms')).json();assert.equal(rooms.data.mode,'hot');assert.match(rooms.data.notice,/会话已失效/);
 assert.match(rooms.data.notice,/先同步已有的新 App 会话/);assert.match(rooms.data.notice,/没有有效会话时再在官方 App 登录/);assert.match(rooms.data.notice,/不必重新抓包/);
 const search=await(await fetch(base+'/api/search?keyword=hello')).json();assert.equal(search.data.mode,'hot_filter');assert.equal(search.data.rooms.length,1);assert.match(search.data.notice,/非全站搜索/);
 const state=await(await fetch(base+'/api/account/status')).json();assert.equal(state.data.state,'rejected_session');
 await fetch(base+'/api/labels');await fetch(base+'/api/search/recommendations');assert.equal(officialCalls,0);
 assert.ok(!JSON.stringify([rooms,search,state]).includes('synthetic'));
});
test('missing account session still offers public hot filtering instead of an unnecessary login wall',async t=>{
 const base=await start(t,{signedSearch:async()=>({errno:-3}),searchFallback:async()=>({errno:0,data:{mode:'hot_filter',rooms:[]}})});
 const res=await fetch(base+'/api/search?keyword=hello');assert.equal(res.status,200);assert.match((await res.json()).data.notice,/非全站搜索/);
});

'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const http=require('node:http');
const {APP_ID}=require('../static/controller.js');
const {canonicalSeats,verifySeats,rtcUid,crc32,validPublisherToken,createOwnerService}=require('../gravity-owner.cjs');
const {createVoiceApi}=require('../gravity-api.cjs');
const {makeHandler,httpsRequest}=require('../serve.cjs');
const {publicKey,privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:1024});
const channel='1000000000000000001',ownerId='123456',uid=rtcUid(ownerId);
class Timers {
 constructor(){this.tasks=new Map();this.serial=0;}
 setTimeout(fn,delay){const id=++this.serial;this.tasks.set(id,{fn,delay});return id;}
 clearTimeout(id){this.tasks.delete(id);}
 fire(){const item=this.tasks.entries().next().value;if(!item)return;this.tasks.delete(item[0]);item[1].fn();}
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function settle(condition=()=>true){for(let i=0;i<40;i++){await new Promise(r=>setImmediate(r));if(condition())return;}throw new Error('test did not settle');}
function seats(rows=[{seat_id:0,mute_type:1,user:{user_id:Number(ownerId)}}], reported) {
 const digest=reported || crypto.createHash('md5').update(canonicalSeats(rows)).digest('hex');
 return {anchor_user_list:rows,anchor_list_sign:digest,verify_sign:crypto.sign('RSA-SHA256',Buffer.from(digest),privateKey).toString('base64')};
}
function token({c=channel,u=uid,expiry=2000000000,app=APP_ID}={}) {
 const message=Buffer.alloc(22);message.writeUInt16LE(2,8);
 [1,2].forEach((p,i)=>{message.writeUInt16LE(p,10+6*i);message.writeUInt32LE(expiry,12+6*i);});
 const body=Buffer.alloc(44+message.length);body.writeUInt16LE(32);body.writeUInt32LE(crc32(c),34);body.writeUInt32LE(crc32(u),38);body.writeUInt16LE(message.length,42);message.copy(body,44);
 return '006'+app+body.toString('base64');
}
function fixture(options={}) {
 let scope={channel,owner:ownerId,identity:'synthetic-account'},muted=1;
 const calls=[],writes=[];
 const timers=new Timers();
 const service=createOwnerService({scope:()=>scope,key:publicKey,now:()=>options.now || 1900000000000,timers,
  read:async(kind,extra)=>{
   calls.push({kind,extra});
   if(kind==='seats' && options.inspectGate)await options.inspectGate.promise;
   if(kind==='roomInfo')return {errno:0,data:{room_info:{channel_id:channel,user_id:Number(ownerId)}}};
   if(kind==='seats')return {errno:0,data:options.seats || seats([{seat_id:options.seatId ?? 0,mute_type:muted,user:{user_id:Number(ownerId)}}])};
   if(kind==='ownerToken')return {errno:0,data:{uid:options.uid ?? uid,rtc_token:options.token || token(),rtm_token:'PRIVATE-RTM'}};
   throw Error('unexpected endpoint');
  },write:async extra=>{writes.push(extra);if(options.failWrite)return {errno:-4,errmsg:'PRIVATE-ERR'};muted=Number(extra.mute_type);return {errno:0};}});
 return {service,calls,writes,options,timers,setScope:value=>{scope=value;},request:()=>{throw Error('no network');}};
}
async function app(t,owner) {
 const instance=http.createServer(makeHandler({owner,request:()=>{throw Error('no upstream');}}));
 await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{instance.closeAllConnections();instance.close(resolve);}));
 const base='http://127.0.0.1:'+instance.address().port;
 const post=(action,body,headers={})=>fetch(base+'/api/owner/'+action,{method:'POST',headers:{Origin:base,'Sec-Fetch-Site':'same-origin','X-Gravity-Action':'owner-control','Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 return {base,post};
}
test('seat canonicalization preserves large integer IDs without numeric rounding',()=>{
 assert.equal(canonicalSeats([{seat_id:0,mute_type:1,user:{user_id:'9007199254740993'}}]),'{"list":[{"user_id":9007199254740993,"seat_id":0,"mute_type":1}]}');
 assert.throws(()=>canonicalSeats([{seat_id:0,mute_type:1,user:{user_id:9007199254740993}}]));
});
test('RSA verifies reported digest; never mislabels iOS payload binding as verified',()=>{
 assert.deepEqual(verifySeats(seats(),publicKey),{reportedDigestVerified:true,payloadMatches:true});
 assert.deepEqual(verifySeats(seats(undefined,'a'.repeat(32)),publicKey),{reportedDigestVerified:true,payloadMatches:false});
 const data=seats();data.verify_sign='x'.repeat(172);assert.equal(verifySeats(data,publicKey).reportedDigestVerified,false);
});
test('native UID mapping and CRC32 match independent known vectors',()=>{
 assert.equal(rtcUid('16909060'),0x01040302);assert.equal(crc32('123456789'),0xcbf43926);
});
test('owner token is bound to exact channel, UID, App and live audio privilege expiry',()=>{
 assert.equal(validPublisherToken(token(),channel,uid,1900000000000),true);
 for(const input of [token({c:'999'}),token({u:1}),token({app:'0'.repeat(32)}),token({expiry:1900000010}),'007unknown'])assert.equal(validPublisherToken(input,channel,uid,1900000000000),false);
});
test('unselected rooms and mismatched account cannot trigger official reads or writes',async()=>{
 const f=fixture();await assert.rejects(f.service.connect('999',f.request),/自建房/);assert.equal(f.calls.length,0);
 f.setScope(null);await assert.rejects(f.service.status(channel,f.request),/自建房/);assert.equal(f.calls.length,0);
});
test('owner status never requests a publisher token or mutates a seat',async()=>{
 const f=fixture();const status=await f.service.status(channel,f.request);
 assert.equal(status.eligible,true);assert.equal(status.muted,true);assert.equal(status.standalone_room_verified,false);
 assert.deepEqual(f.calls.map(c=>c.kind),['roomInfo','seats']);assert.equal(f.writes.length,0);assert.ok(!JSON.stringify(status).includes(ownerId));
});
test('connect validates official seat/UID/token, returns no RTM and never unmutes',async()=>{
 const f=fixture();const data=await f.service.connect(channel,f.request);assert.equal(data.mode,'owner-test');assert.equal(data.muted,true);
 assert.equal(f.writes.length,0);assert.ok(!JSON.stringify(data).includes('PRIVATE-RTM'));
 assert.equal(f.calls.at(-1).extra.role_type,'1');await f.service.release(channel,f.request,data.owner_permit);
});
test('invalid seat signature, lost seat, wrong UID and wrong channel token fail closed',async()=>{
 const bad=seats();bad.verify_sign='x'.repeat(172);
 for(const options of [{seats:bad},{seatId:1},{uid:1},{token:token({c:'999'})}]){
  const f=fixture(options);await assert.rejects(f.service.connect(channel,f.request));assert.equal(f.writes.length,0);
 }
});
test('one page permit at a time; stale, expired or different-account permits cannot unmute',async()=>{
 const f=fixture();const grant=await f.service.connect(channel,f.request);
 await assert.rejects(f.service.connect(channel,f.request),/另一个网页/);
 await assert.rejects(f.service.mute(channel,false,f.request,'wrong'),/授权已失效/);
 f.options.now=1900000100000;await assert.rejects(f.service.mute(channel,false,f.request,grant.owner_permit),/授权已失效/);
 await f.service.release(channel,f.request,grant.owner_permit);assert.equal(f.writes.length,0);
});
test('explicit sending and stopping mutate only the selected owners own seat',async()=>{
 const f=fixture();const grant=await f.service.connect(channel,f.request);
 assert.equal((await f.service.mute(channel,false,f.request,grant.owner_permit)).muted,false);
 assert.equal((await f.service.mute(channel,true,f.request,grant.owner_permit)).muted,true);
 await f.service.release(channel,f.request,grant.owner_permit);
 assert.deepEqual(f.writes,[{channel_id:channel,seat_id:'0',mute_type:'0'},{channel_id:channel,seat_id:'0',mute_type:'1'}]);
});
test('release restores an unmuted seat even after permit expiry, without renewing publication',async()=>{
 const f=fixture();const grant=await f.service.connect(channel,f.request);await f.service.mute(channel,false,f.request,grant.owner_permit);
 f.options.now=1900000100000;await f.service.release(channel,f.request,grant.owner_permit);assert.equal(f.writes.at(-1).mute_type,'1');
});
test('failed upstream update is bounded and never echoes credential-bearing errors',async()=>{
 const f=fixture();const grant=await f.service.connect(channel,f.request);f.options.failWrite=true;
 await assert.rejects(f.service.mute(channel,false,f.request,grant.owner_permit),error=>!error.message.includes('PRIVATE'));
 f.options.failWrite=false;await f.service.release(channel,f.request,grant.owner_permit);
});
test('POST protocol transport signs only fixed owner fields; other write endpoints are impossible',async()=>{
 const api=createVoiceApi({tokenLoader:()=> 'synthetic-account-token',deviceLoader:()=>({idfa:'synthetic-idfa',uwd:'synthetic-uwd'}),stateFile:'/nonexistent/test-owner-state'});
 await api.writeOwnerMute({channel_id:channel,seat_id:'0',mute_type:'1'},async req=>{
  assert.equal(req.method,'POST');assert.equal(req.path,'/gravity/voice/updateAnchorStatus');
  const params=new URLSearchParams(req.body);assert.equal(params.get('mute_type'),'1');assert.match(params.get('sign'),/^[a-f0-9]{32}$/);
  return {status:200,body:Buffer.from('{"errno":0,"data":{}}')};
 });
 await assert.rejects(httpsRequest({hostname:'api.gravity.place',path:'/gravity/voice/destroyReserveRoomEncrypt',method:'POST',body:'x'}));
});
test('owner endpoints require same-origin JSON, action header and explicit confirmation',async t=>{
 let calls=0;const owner={connect:async()=>{calls++;return {mode:'owner-test'};},status:async()=>({eligible:true})};
 const {base,post}=await app(t,owner);
 for(const headers of [{Origin:'https://evil.invalid'},{'X-Gravity-Action':''},{'Content-Type':'text/plain'},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await post('connect',{channel_id:channel,confirmed:true},headers)).status,403);
 assert.equal((await post('connect',{channel_id:channel,confirmed:false})).status,400);
 assert.equal((await post('connect',{channel_id:channel,confirmed:true,role_type:1})).status,400);
 for(const method of ['GET','HEAD'])assert.equal((await fetch(base+'/api/owner/connect?channel_id='+channel,{method})).status,405);
 assert.equal(calls,0);assert.equal((await post('connect',{channel_id:channel,confirmed:true})).status,200);assert.equal(calls,1);
});
test('send consent is separate from connection consent and cannot be omitted',async t=>{
 let writes=0;const {post}=await app(t,{mute:async()=>{writes++;return {};}});
 assert.equal((await post('mute',{channel_id:channel,muted:false,owner_permit:'synthetic'})).status,400);
 assert.equal(writes,0);assert.equal((await post('mute',{channel_id:channel,muted:true,owner_permit:'synthetic'})).status,200);
});
test('watchdog remutes an expired unmuted permit and then allows a new connect',async()=>{
 const f=fixture();const grant=await f.service.connect(channel,f.request);
 await f.service.mute(channel,false,f.request,grant.owner_permit);
 f.options.now=1900000100000;f.timers.fire();await settle(()=>f.writes.at(-1)?.mute_type==='1'&&f.timers.tasks.size===0);
 assert.equal(f.writes.at(-1).mute_type,'1');
 const again=await f.service.connect(channel,f.request);
 assert.notEqual(again.owner_permit,grant.owner_permit);await f.service.release(channel,f.request,again.owner_permit);
});
test('watchdog without unmute only clears the permit and never writes',async()=>{
 const f=fixture();const grant=await f.service.connect(channel,f.request);
 f.options.now=1900000100000;f.timers.fire();await settle(()=>f.timers.tasks.size===0);
 assert.equal(f.writes.length,0);
 const again=await f.service.connect(channel,f.request);
 assert.notEqual(again.owner_permit,grant.owner_permit);await f.service.release(channel,f.request,again.owner_permit);
});
test('stale watchdog after a renewed status inspect does not drop the live permit',async()=>{
 const gate=deferred(),f=fixture();const grant=await f.service.connect(channel,f.request);
 f.options.inspectGate=gate;const status=f.service.status(channel,f.request,grant.owner_permit);
 await settle(()=>f.calls.filter(c=>c.kind==='seats').length===2);
 f.options.now=1900000100000;f.timers.fire();
 gate.resolve();await status;assert.equal(f.writes.length,0);
 assert.equal((await f.service.mute(channel,false,f.request,grant.owner_permit)).muted,false);
 await f.service.release(channel,f.request,grant.owner_permit);assert.equal(f.writes.at(-1).mute_type,'1');
});
test('connect after expiry remutes a leftover unmuted seat before issuing a new permit',async()=>{
 const f=fixture();const grant=await f.service.connect(channel,f.request);
 await f.service.mute(channel,false,f.request,grant.owner_permit);
 f.options.now=1900000100000;
 const again=await f.service.connect(channel,f.request);
 assert.equal(f.writes.at(-1).mute_type,'1');assert.notEqual(again.owner_permit,grant.owner_permit);
 await f.service.release(channel,f.request,again.owner_permit);
});
test('failed release preserves remute work, revokes sending and retries without the page',async()=>{
 const f=fixture();const grant=await f.service.connect(channel,f.request);
 await f.service.mute(channel,false,f.request,grant.owner_permit);f.options.failWrite=true;
 await assert.rejects(f.service.release(channel,f.request,grant.owner_permit),/官方席位状态更新失败/);
 assert.equal(f.timers.tasks.size,1);
 await assert.rejects(f.service.mute(channel,false,f.request,grant.owner_permit),/授权已失效/);
 await assert.rejects(f.service.status(channel,f.request,grant.owner_permit),/授权已失效/);
 await assert.rejects(f.service.release(channel,f.request,'stale-proof'),/授权已失效/);
 assert.equal(f.timers.tasks.size,1);
 await assert.rejects(f.service.connect(channel,f.request),/官方席位状态更新失败/);
 f.options.failWrite=false;f.timers.fire();await settle(()=>f.writes.at(-1)?.mute_type==='1'&&f.timers.tasks.size===0);
 const again=await f.service.connect(channel,f.request);
 assert.notEqual(again.owner_permit,grant.owner_permit);await f.service.release(channel,f.request,again.owner_permit);
});
test('failed timeout remute retries instead of leaving a dead permit that blocks connect',async()=>{
 const f=fixture();const grant=await f.service.connect(channel,f.request);
 await f.service.mute(channel,false,f.request,grant.owner_permit);
 f.options.failWrite=true;f.options.now=1900000100000;f.timers.fire();
 await settle(()=>f.timers.tasks.size===1);
 await assert.rejects(f.service.connect(channel,f.request),/官方席位状态更新失败/);
 f.options.failWrite=false;f.timers.fire();await settle(()=>f.writes.at(-1)?.mute_type==='1'&&f.timers.tasks.size===0);
 const again=await f.service.connect(channel,f.request);
 assert.notEqual(again.owner_permit,grant.owner_permit);await f.service.release(channel,f.request,again.owner_permit);
});
test('drain at shutdown remutes a seat this page unmuted, then forgets the permit',async()=>{
 const f=fixture();const grant=await f.service.connect(channel,f.request);
 await f.service.mute(channel,false,f.request,grant.owner_permit);
 await f.service.drain(f.request);assert.equal(f.writes.at(-1).mute_type,'1');assert.equal(f.service.busy(),false);
 const writes=f.writes.length;await f.service.drain(f.request);assert.equal(f.writes.length,writes);
});
test('a failed shutdown drain keeps the permit so the remute obligation is not lost',async()=>{
 const f=fixture();const grant=await f.service.connect(channel,f.request);
 await f.service.mute(channel,false,f.request,grant.owner_permit);
 f.options.failWrite=true;await assert.rejects(f.service.drain(f.request));assert.equal(f.service.busy(),true);
 f.options.failWrite=false;await f.service.drain(f.request);assert.equal(f.service.busy(),false);assert.equal(f.writes.at(-1).mute_type,'1');
});

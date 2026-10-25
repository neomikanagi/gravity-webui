'use strict';
// Real controller -> HTTP routes -> real member/profile services. Only the
// official upstream and Agora transport are fake. Watchdog time and the
// refusal of retired entry modes must survive the real HTTP boundary.
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {EventEmitter}=require('node:events');
const {Controller}=require('../static/member-controller.js');
const {APP_ID}=require('../static/controller.js');
const {createMemberService}=require('../gravity-member.cjs');
const {createProfileService}=require('../gravity-profile.cjs');
const {makeHandler}=require('../serve.cjs');
const {rtcUid,crc32}=require('../gravity-owner.cjs');
const user='123456',uid=rtcUid(user),channel='123';
function token(ids,expires){const m=Buffer.alloc(10+ids.length*6),b=Buffer.alloc(44+m.length);m.writeUInt16LE(ids.length,8);
 ids.forEach((id,i)=>{m.writeUInt16LE(id,10+6*i);m.writeUInt32LE(expires,12+6*i);});
 b.writeUInt16LE(32);b.writeUInt32LE(crc32(channel),34);b.writeUInt32LE(crc32(uid),38);b.writeUInt16LE(m.length,42);m.copy(b,44);return '006'+APP_ID+b.toString('base64');}
class Timers{constructor(){this.n=0;this.tasks=new Map();}setTimeout(fn,ms){const id=++this.n;this.tasks.set(id,{fn,ms});return id;}clearTimeout(id){this.tasks.delete(id);}}
async function fixture(t){let now=1900000000000,identity={user,identity:'one'};const writes=[],reads=[],timers=new Timers();
 const upstream=async(kind,extra)=>{reads.push({kind,extra});
  if(kind==='roomInfo')return {errno:0,data:{room_info:{channel_id:channel,user_id:'999',auto_pass:1}}};
  if(kind==='seats')return {errno:0,data:{anchor_user_list:[]}};
  if(kind==='managers'||kind==='members')return {errno:0,data:{list:[]}};
  if(kind==='memberCount')return {errno:0,data:{members:1}};
  if(kind==='userDetail')return {errno:0,data:{user_id:extra.target_id,name:extra.target_id===user?'Self':'Wrong ID',portrait:''}};
  if(kind==='memberToken')return {errno:0,data:{uid,rtc_token:token([1],now/1000+300),rtm_token:token([1000],now/1000+300)}};
  throw Error('unexpected read '+kind);
 };
 const member=createMemberService({identity:()=>identity,read:upstream,write:async(kind,extra)=>{writes.push({kind,extra});return {errno:0,data:{interval:60}};},
  verify:()=>({reportedDigestVerified:true,payloadMatches:false}),device:()=>({app_version:'14.2'}),now:()=>now,timers});
 const profile=createProfileService({identity:()=>identity,read:upstream,now:()=>now});
 const server=http.createServer(makeHandler({member,profile}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const rtcs=[],rtms=[];
 const sdk={setLogLevel(){},createClient(){const c=new EventEmitter();c.joins=0;c.renewals=0;c.leaves=0;
  c.setClientRole=async()=>{};c.join=async()=>{c.joins++;};c.leave=async()=>{c.leaves++;};c.renewToken=async()=>{c.renewals++;};c.removeAllListeners=c.removeAllListeners.bind(c);rtcs.push(c);return c;},
  async createMicrophoneAudioTrack(){throw Error('real capture forbidden');}};
 const rtmSdk={createInstance(){const c=new EventEmitter();c.logins=0;c.renewals=0;c.login=async()=>{c.logins++;};c.logout=async()=>{};c.renewToken=async()=>{c.renewals++;};
  c.createChannel=()=>{const ch=new EventEmitter();ch.join=async()=>{};ch.leave=async()=>{};ch.sendMessage=async()=>{throw Error('no messages in soak');};return ch;};rtms.push(c);return c;}};
 const controller=new Controller({getSdk:async()=>sdk,getRtmSdk:async()=>rtmSdk,timers,now:()=>now,fetch:(url,options)=>fetch(base+url,{...options,headers:{Origin:base,...options?.headers}})});
 t.after(async()=>{await controller.stop();await new Promise(r=>server.close(r));});
 return {controller,member,reads,writes,rtcs,rtms,timers,post:(endpoint,body)=>fetch(base+endpoint,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Gravity-Action':'member-control'},body:JSON.stringify(body)}),advance:ms=>{now+=ms;},account:value=>{identity=value;}};
}
test('ordinary HTTP lifecycle survives fifteen virtual minutes with real permit renewal',async t=>{
 const f=await fixture(t),c=f.controller;
 assert.notEqual(String(uid),user);
 assert.equal(await c.start({channel_id:channel,anchor_id:'999',accountMode:'member',memberConfirmed:true}),true,c.message);
 for(let elapsed=5000;elapsed<=900000;elapsed+=5000){f.advance(5000);await c.checkMember(c.session);
  if(elapsed%240000===0)assert.equal(await c.renewMemberTokens(c.session),true);
  assert.equal(c.state,'listening');
 }
 assert.equal(f.rtcs[0].renewals,3);assert.equal(f.rtms[0].renewals,3);
 assert.equal(f.rtcs[0].joins,1);assert.equal(f.rtms[0].logins,1);
 assert.equal(f.writes.filter(w=>w.extra.pkg_type==='AudioLive_Enter').length,1);
 assert.equal(f.writes.filter(w=>w.extra.pkg_type==='AudioLive_HeartBeat').length,15);
 await c.stop();assert.equal(f.writes.filter(w=>w.extra.pkg_type==='AudioLive_Quit').length,1);
 assert.equal(f.timers.tasks.size,0);
});
test('retired invisible mode is rejected through HTTP before any upstream call or permit',async t=>{
 const f=await fixture(t),response=await f.post('/api/member/connect',{channel_id:channel,confirmed:true,stealth:true});
 assert.equal(response.status,400);assert.match((await response.json()).errmsg,/隐身入口已取消/);
 assert.equal(f.reads.length,0);assert.equal(f.writes.length,0);
 for(const value of [true,'true','false',1,0])await assert.rejects(f.member.connect(channel,null,{stealth:value}),e=>e.status===400);
 assert.equal(f.reads.length,0);assert.equal(f.writes.length,0);
});
test('ordinary unentered and expired permits cannot renew; old normal false remains compatible',async t=>{
 const f=await fixture(t);let g=await f.member.connect(channel,null,{stealth:false});
 assert.equal('stealth' in g,false);assert.equal('account_user_id' in g,false);
 await assert.rejects(f.member.renew(channel,null,g.member_permit),e=>e.status===403);await f.member.release(channel,null,g.member_permit);
 g=await f.member.connect(channel,null);await f.member.enter(channel,null,g.member_permit);f.advance(90001);
 await assert.rejects(f.member.renew(channel,null,g.member_permit),e=>e.status===403);await f.member.release(channel,null,g.member_permit);
});
test('a retired request cannot turn into visible entry or disturb a current ordinary connection',async t=>{
 const f=await fixture(t),c=f.controller;await c.start({channel_id:channel,anchor_id:'999',accountMode:'member',memberConfirmed:true});
 const active=c.session;await c.refreshBoard(active);
 const reads=f.reads.length,writes=f.writes.length;
 await assert.rejects(c.start({channel_id:channel,anchor_id:'999',accountMode:'member',memberConfirmed:true,stealth:true}),/非表示入室は廃止/);
 const response=await f.post('/api/member/connect',{channel_id:channel,confirmed:true,stealth:true});assert.equal(response.status,400);
 assert.equal(c.session,active);assert.equal(c.state,'listening');assert.equal(f.reads.length,reads);assert.equal(f.writes.length,writes);
 assert.equal(await c.renewMemberTokens(active),true);assert.equal(f.writes.filter(w=>w.extra.pkg_type==='AudioLive_Enter').length,1);
});
test('terminal RTC disconnect recovers the same identity without another Enter, RTM login or microphone',async t=>{
 const f=await fixture(t),c=f.controller;await c.start({channel_id:channel,anchor_id:'999',accountMode:'member',memberConfirmed:true});
 await c.recoverMemberRtc(c.session);
 assert.equal(c.state,'listening');assert.equal(f.rtcs[0].joins,2);assert.equal(f.rtms[0].logins,1);
 assert.equal(f.writes.filter(w=>w.extra.pkg_type==='AudioLive_Enter').length,1);
 assert.equal(c.micState,'off');
});

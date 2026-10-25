'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {Controller,command,approved,invited,commandSender,chatText,chatImage,textMessage}=require('../static/member-controller.js');
const imageMessage=(uid,profile,image,ts)=>textMessage(uid,profile,JSON.stringify(image),ts,14); // inbound wire only: this page never sends images
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const {APP_ID}=require('../static/controller.js');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};}
async function settle(fn=()=>true){for(let i=0;i<50;i++){await new Promise(r=>setImmediate(r));if(fn())return;}throw Error('not settled');}
function token(ids=[1],expiry=2000000000){const m=Buffer.alloc(10+ids.length*6);m.writeUInt16LE(ids.length,8);ids.forEach((n,i)=>{m.writeUInt16LE(n,10+i*6);m.writeUInt32LE(expiry,12+i*6);});const b=Buffer.alloc(44+m.length);b.writeUInt16LE(32);b.writeUInt16LE(m.length,42);m.copy(b,44);return '006'+APP_ID+b.toString('base64');}
class Timers{constructor(){this.tasks=new Map();this.n=0;}setTimeout(fn,ms){const n=++this.n;this.tasks.set(n,fn);fn.delay=ms;return n;}clearTimeout(n){this.tasks.delete(n);}fire(){const item=this.tasks.entries().next().value;if(item){this.tasks.delete(item[0]);item[1]();}}}
class Rtc extends EventEmitter{constructor(){super();this.roles=[];this.publishes=0;this.unpublishes=0;this.leaves=0;}async setClientRole(role){this.roles.push(role);}async join(...args){this.joinArgs=args;this.joins=(this.joins||0)+1;}async leave(){this.leaves++;}async subscribe(){}async renewToken(){this.renewed=true;this.renewals=(this.renewals||0)+1;}async publish(){this.publishes++;}async unpublish(){this.unpublishes++;}}
function fixture(options={}){const requests=[],logs=[],tracks=[],rtc=[],rtmClients=[],timers=new Timers();let seated=options.seated||false,muted=true;
 const state=()=>({mode:'account-member',eligible:true,seated,seat_id:seated?3:null,muted:seated?muted:null,is_owner:!!options.owner,auto_pass:!!options.autoPass,room_type:options.roomType??0,
  anchor_rtc_uid:9,seat_provenance:'official-tls',reported_digest_rsa_verified:true});
 const fetch=async(url,config={})=>{let body=null;
  if(typeof config.body==='string'){try{body=JSON.parse(config.body);}catch{body=null;}}
  else if(typeof FormData!=='undefined'&&config.body instanceof FormData)body={form:true,confirmed:String(config.body.get('confirmed')||'')};
  requests.push({url,body});
  if(url.startsWith('/api/resolve'))return {ok:true,json:async()=>({errno:0,data:{channel_id:url.includes('second')?'456':'123',anchor_id:'9'}})};
  if(url.startsWith('/api/member/status')&&options.statusGate)await options.statusGate.promise;
  if(url==='/api/member/connect'&&options.connectHttp)return {ok:false,status:options.connectHttp,json:async()=>({errno:-1,errmsg:'entry_failed'})};
  if(url==='/api/member/enter')return {ok:true,json:async()=>({errno:0,data:{entered:true}})};
  if(url.startsWith('/api/token?'))return {ok:true,json:async()=>({errno:0,data:{user_id:7,rtc_token:token()}})};
  if(url==='/api/member/release'){if(options.releaseGate)await options.releaseGate.promise;return {ok:!options.releaseFailure,json:async()=>options.releaseFailure?{errno:-1,errmsg:'release_failed'}:{errno:0,data:{released:true}}};}
  if(url==='/api/profile/block-host')return {ok:!options.blockFailure,json:async()=>options.blockFailure?{errno:-1,errmsg:'block_unknown'}:{errno:0,data:{blocked:true,user_id:'9'}}};
  if(url==='/api/member/destroy')return {ok:!options.destroyFailure,json:async()=>options.destroyFailure?{errno:-1,errmsg:'destroy_failed'}:{errno:0,data:{destroyed:true}}};
  if(url==='/api/member/lucky-box')return {ok:true,json:async()=>({errno:0,data:{claimed:true,lucky_box_id:body.lucky_box_id}})};
  if(url==='/api/member/kick')return {ok:true,json:async()=>({errno:0,data:{...state(),kicked:true,target_user_id:String(body.target_user_id)}})};
  if(url==='/api/member/update-room')return {ok:true,json:async()=>({errno:0,data:{...state(),notice:body.notice??'',tags:body.tags??'',auto_pass:body.auto_pass===true}})};
  if(url.startsWith('/api/member/status')&&options.statusFailure)return {ok:false,status:options.statusHttp||0,json:async()=>({errno:-1,errmsg:options.statusMessage||'status_failed'})};
  if(url==='/api/member/apply'){if(options.applyFails>0){options.applyFails--;return {ok:false,json:async()=>({errno:-1,errmsg:'apply_failed'})};}seated=true;}
  if(url==='/api/member/leave')seated=false;
  if(url==='/api/member/mute'){if(!body.muted&&options.unmuteGate)await options.unmuteGate.promise;muted=body.muted;}
  if(url.startsWith('/api/member/board')){if(options.boardGate)await options.boardGate.promise;const self={user_id:'7',rtc_uid:7,name:'You',portrait:'',is_self:true,country:options.country===undefined?'JP':options.country};
   return {ok:true,json:async()=>({errno:0,data:{members:[...(options.omitSelf?[]:[self]),{user_id:'9',rtc_uid:9,name:'Host'}],seats:[],self_profile:options.noProfile?null:self,next_cursor:''}})};}
  let data=state();
  if(url.startsWith('/api/member/status')&&options.degradedPresence)data={...data,presence:'degraded',presence_error:'心跳忙'};
  if(url.startsWith('/api/member/status')&&options.moderators)data={...data,moderator_rtc_uids:options.moderators};
  if(url.startsWith('/api/member/status')&&options.blockedFromServer)data={...data,blocked_rtc_uids:options.blockedFromServer};
  if(url.startsWith('/api/profile/person'))return {ok:true,json:async()=>({errno:0,data:{person:{user_id:'458752',name:'You',portrait:''}}})};
  if(url==='/api/member/connect')data={...data,user_id:7,rtc_token:token([1],options.expiry??2000000000),rtm_token:token([1000],options.rtmExpiry??options.expiry??2000000000),member_permit:'PRIVATE-PERMIT',moderator_rtc_uids:options.adminSelf?[9,8,7]:[9,8],...(options.blockedFromServer?{blocked_rtc_uids:options.blockedFromServer}:{})};
  if(url==='/api/member/publisher')data={...data,user_id:7,rtc_token:token([1,2])};
  if(url==='/api/member/renew'){
   if(options.renewGate)await options.renewGate.promise;
   if(options.renewFailure)return {ok:false,status:options.renewHttp??409,json:async()=>({errno:-1,errmsg:'renew_failed'})};
   data={...state(),user_id:options.renewUid??7,rtc_token:token(seated&&!muted?[1,2]:[1],options.expiry??2000000000),
    rtm_token:token([1000],options.expiry??2000000000),...options.renewData};
  }
  return {ok:true,json:async()=>({errno:0,data})};
 };
 const sdk={micCalls:0,setLogLevel(){},createClient(){const client=new Rtc();if(options.rtcRenewError)client.renewToken=async()=>{throw Object.assign(Error('sdk renewal failed'),{status:503});};rtc.push(client);return client;},async createMicrophoneAudioTrack(){this.micCalls++;
  if(options.micGate)await options.micGate.promise;const track={closed:0,stopped:0,close(){this.closed++;},getMediaStreamTrack(){return {stop:()=>{this.stopped++;}};}};tracks.push(track);return track;}};
 const rtmSdk={createInstance(){const client=new EventEmitter();client.renewals=0;client.renewToken=async()=>{client.renewals++;if(options.rtmRenewFailure)throw Error('rtm_renew_failed');};client.login=async args=>{client.loginArgs=args;if(options.loginGate)await options.loginGate.promise;};client.logout=async()=>{client.loggedOut=true;};
  client.sendMessageToPeer=async(message,peer)=>{client.sent={message,peer};};client.createChannel=id=>{const channel=new EventEmitter();channel.id=id;channel.join=async()=>{channel.joined=true;};channel.leave=async()=>{channel.left=true;};channel.history=[];channel.sendMessage=async message=>{channel.sent=message;channel.history.push(message);if(options.chatGate)await options.chatGate.promise;if(options.chatFailure)throw Error('send_failed');};client.channel=channel;return channel;};rtmClients.push(client);return client;}};
 const c=new Controller({getSdk:async()=>sdk,getRtmSdk:async()=>rtmSdk,fetch,timers,onLog:message=>logs.push(message)});
 return {c,requests,logs,tracks,rtc,rtmClients,sdk,timers,options,setSeat:value=>{seated=value;},setMute:value=>{muted=value;},start:()=>c.start({share:'first',accountMode:'member',memberConfirmed:true})};
}
test('300-second credentials renew three times across twelve virtual minutes without reconnecting or repeating entry',async()=>{
 const options={expiry:1900000300},f=fixture(options);let now=1900000000000;f.c.now=()=>now;await f.start();
 for(let elapsed=240000;elapsed<=720000;elapsed+=240000){now=1900000000000+elapsed;options.expiry=Math.floor(now/1000)+300;
  const timer=[...f.timers.tasks.entries()].find(([,fn])=>fn.delay===240000);assert.ok(timer,'one-minute-early renewal timer');
  f.timers.tasks.delete(timer[0]);timer[1]();await settle(()=>f.rtmClients[0].renewals===elapsed/240000);
  assert.equal(f.c.state,'listening');assert.equal(f.c.micState,'off');}
 assert.equal(f.requests.filter(r=>r.url==='/api/member/renew').length,3);assert.equal(f.rtc[0].renewals,3);
 assert.equal(f.requests.filter(r=>r.url==='/api/member/connect').length,1);assert.equal(f.requests.filter(r=>r.url==='/api/member/enter').length,1);
 assert.equal(f.rtc.length,1);assert.equal(f.rtmClients.length,1);assert.equal(f.rtmClients[0].channel.history.length,0);assert.equal(f.sdk.micCalls,0);await f.c.stop();assert.equal(f.timers.tasks.size,0);
});
test('entry HTTP status survives start failure and resets on the next attempt',async()=>{
 const f=fixture({connectHttp:404});assert.equal(await f.start(),false);assert.equal(f.c.snapshot().errorStatus,404);assert.equal(f.rtc.length,0);
 f.options.connectHttp=503;assert.equal(await f.start(),false);assert.equal(f.c.snapshot().errorStatus,503);
 f.options.connectHttp=0;assert.equal(await f.start(),true);assert.equal(f.c.snapshot().errorStatus,0);await f.c.stop();
});
test('a listener retries soft renewal inside the old token lifetime without reconnecting or repeating entry',async()=>{
 const options={expiry:1900000300,renewFailure:true,renewHttp:503},f=fixture(options);let now=1900000240000;f.c.now=()=>now;await f.start();
 const s=f.c.session,expiry=s.tokenExpiresAt;f.c.queueTokenRenewal(s);await settle(()=>f.logs.some(x=>x.includes('5秒後に再試行')));
 assert.equal(f.c.state,'listening');assert.equal(s.tokenExpiresAt,expiry);assert.equal(f.rtc[0].renewals,undefined);
 const retry=[...f.timers.tasks.entries()].find(([id,fn])=>id===s.tokenTimer&&fn.delay===5000);assert.ok(retry);
 options.renewFailure=false;options.expiry=1900000545;now+=5000;f.timers.tasks.delete(retry[0]);retry[1]();await settle(()=>f.rtmClients[0].renewals===1);
 assert.equal(f.c.state,'listening');assert.equal(f.requests.filter(r=>r.url==='/api/member/connect').length,1);
 assert.equal(f.requests.filter(r=>r.url==='/api/member/enter').length,1);assert.equal(f.sdk.micCalls,0);await f.c.stop();
});
test('renewal retry cannot extend old expiry, survive stop, or mask hard/SDK/publication failures',async()=>{
 for(const status of [401,403,404,409]){const f=fixture({expiry:1900000300,renewFailure:true,renewHttp:status});f.c.now=()=>1900000240000;await f.start();
  f.c.queueTokenRenewal(f.c.session);await settle(()=>f.c.state==='error');assert.equal(f.timers.tasks.size,0);}
 const options={expiry:1900000300,renewFailure:true,renewHttp:503},f=fixture(options);let now=1900000240000;f.c.now=()=>now;await f.start();const s=f.c.session;
 f.c.queueTokenRenewal(s);await settle(()=>f.logs.some(x=>x.includes('5秒後に再試行')));assert.equal(s.tokenExpiresAt,1900000300000);
 now=1900000270000;f.c.queueTokenRenewal(s);await settle(()=>f.c.state==='error');assert.equal(f.timers.tasks.size,0);
 const g=fixture(options);g.c.now=()=>1900000240000;await g.start();g.c.queueTokenRenewal(g.c.session);await settle(()=>g.logs.some(x=>x.includes('5秒後に再試行')));
 await g.c.stop();assert.equal(g.timers.tasks.size,0);
 const h=fixture({...options,seated:true});h.c.now=()=>1900000240000;await h.start();await h.c.publishMic(true);h.c.queueTokenRenewal(h.c.session);
 await settle(()=>h.c.state==='error');assert.equal(h.tracks[0].stopped,1);
});
test('the renewal queue never retries invalid credentials or SDK errors as if they were HTTP blips',async()=>{
 for(const options of [{renewUid:8},{renewData:{rtm_token:token([1000],1)}},{rtcRenewError:true}]){
  const f=fixture({...options,expiry:1900000300});f.c.now=()=>1900000240000;await f.start();f.c.queueTokenRenewal(f.c.session);
  await settle(()=>f.c.state==='error');assert.equal(f.timers.tasks.size,0);assert.ok(!f.logs.some(x=>x.includes('5秒後に再試行')));
 }
});
test('earliest RTC/RTM expiry drives proactive renewal, and concurrent SDK warnings coalesce',async()=>{
 const gate=deferred(),f=fixture({expiry:1900000300,rtmExpiry:1900000200,renewGate:gate});f.c.now=()=>1900000000000;await f.start();
 assert.ok([...f.timers.tasks.values()].some(fn=>fn.delay===140000));
 f.rtmClients[0].emit('TokenPrivilegeWillExpire');f.rtc[0].emit('token-privilege-will-expire');f.rtc[0].emit('token-privilege-did-expire');
 await settle(()=>f.requests.some(r=>r.url==='/api/member/renew'));assert.equal(f.requests.filter(r=>r.url==='/api/member/renew').length,1);
 gate.resolve();await settle(()=>f.rtmClients[0].renewals===1);assert.equal(f.c.state,'listening');await f.c.stop();
});
test('renewal preserves an already explicit publish without opening, publishing or joining again',async()=>{
 const f=fixture({seated:true});await f.start();await f.c.publishMic(true);await f.c.renewMemberTokens(f.c.session);
 assert.equal(f.c.micState,'sdk-published-unverified');assert.equal(f.sdk.micCalls,1);assert.equal(f.rtc[0].publishes,1);assert.equal(f.rtc[0].roles.at(-1),'host');await f.c.stop();
});
test('official mute or lost seat during renewal stops capture and renews only audience rights',async()=>{
 for(const action of ['mute','leave']){const f=fixture({seated:true});await f.start();await f.c.publishMic(true);
  if(action==='mute')f.setMute(true);else f.setSeat(false);await f.c.renewMemberTokens(f.c.session);
  assert.equal(f.c.micState,'off');assert.equal(f.tracks[0].stopped,1);assert.equal(f.c.state,'listening');assert.equal(f.rtc[0].roles.at(-1),'audience');await f.c.stop();}
});
test('stop or replacement during renewal never applies a late token or rejoins',async()=>{
 for(const action of ['stop','replace']){const gate=deferred(),f=fixture({renewGate:gate});await f.start();const session=f.c.session,work=f.c.renewMemberTokens(session);
  await settle(()=>f.requests.some(r=>r.url==='/api/member/renew'));
  if(action==='stop')await f.c.stop();else {f.rtmClients[0].emit('ConnectionStateChanged','ABORTED','REMOTE_LOGIN');await settle(()=>f.c.state==='error');}
  gate.resolve();assert.equal(await work,false);assert.equal(f.rtc[0].renewals,undefined);assert.equal(f.rtmClients[0].renewals,0);assert.equal(f.rtc.length,1);assert.equal(f.timers.tasks.size,0);}
});
test('SDK renewal failure and timeout close capture and never login or auto-rejoin',async()=>{
 for(const failure of ['renewFailure','rtmRenewFailure','timeout']){const options={seated:true},f=fixture(options);await f.start();await f.c.publishMic(true);
  if(failure==='timeout')options.renewGate=deferred();else options[failure]=true;
  f.rtmClients[0].emit('TokenPrivilegeWillExpire');await settle(()=>f.requests.some(r=>r.url==='/api/member/renew'));
  if(failure==='timeout'){const timer=[...f.timers.tasks.entries()].find(([,fn])=>fn.delay===30000);f.timers.tasks.delete(timer[0]);timer[1]();}
  await settle(()=>f.c.state==='error');assert.equal(f.tracks[0].stopped,1);assert.equal(f.rtc.length,1);assert.equal(f.timers.tasks.size,0);
  if(failure==='timeout'){options.renewGate.resolve();await settle();assert.equal(f.rtmClients[0].renewals,0);}
 }
});
test('changed UID, expired RTM or unrequested publisher grant fails before SDK renewal',async()=>{
 for(const options of [{renewUid:8},{renewData:{rtm_token:token([1000],1)}},{renewData:{rtc_token:token([1,2]),seated:true,seat_id:3,muted:false}}]){
  const f=fixture(options);await f.start();await assert.rejects(f.c.renewMemberTokens(f.c.session),/更新トークンが一致しません/);
  assert.equal(f.rtc[0].renewals,undefined);assert.equal(f.rtmClients[0].renewals,0);await f.c.stop();}
});
test('renewal waits for pending publish, while a later publish waits for renewal without deadlocking',async()=>{
 const f=fixture({seated:true});await f.start();const gate=deferred();f.options.statusGate=gate;const publish=f.c.publishMic(true);
 await settle(()=>f.requests.some(r=>r.url.startsWith('/api/member/status')));const renewal=f.c.renewMemberTokens(f.c.session);gate.resolve();await Promise.all([publish,renewal]);assert.equal(f.c.micState,'sdk-published-unverified');await f.c.stop();
 const g=fixture({seated:true,renewGate:deferred()});await g.start();const renewing=g.c.renewMemberTokens(g.c.session);await settle(()=>g.requests.some(r=>r.url==='/api/member/renew'));
 const publishing=g.c.publishMic(true);g.options.renewGate.resolve();await Promise.all([renewing,publishing]);assert.equal(g.c.micState,'sdk-published-unverified');await g.c.stop();
});
test('mic revocation while renewal is pending discards stale publishing credentials',async()=>{
 const f=fixture({seated:true,renewGate:deferred()});await f.start();await f.c.publishMic(true);const count=f.rtc[0].renewals,work=f.c.renewMemberTokens(f.c.session);
 await settle(()=>f.requests.some(r=>r.url==='/api/member/renew'));await f.c.closeMic();f.options.renewGate.resolve();assert.equal(await work,false);
 assert.equal(f.rtc[0].renewals,count);assert.equal(f.c.micState,'off');assert.ok([...f.timers.tasks.values()].some(fn=>fn.delay===1000));await f.c.stop();
});
test('terminal RTM expiry/replacement and RTC kicks retain stop-without-reclaim behavior',async()=>{
 for(const [kind,reason] of [['rtm','REMOTE_LOGIN'],['rtm','TOKEN_EXPIRED'],['rtc','UID_BANNED'],['rtc','UID_CONFLICT']]){const f=fixture();await f.start();
  if(kind==='rtm')f.rtmClients[0].emit('ConnectionStateChanged','ABORTED',reason);else f.rtc[0].emit('connection-state-change','DISCONNECTED','CONNECTED',reason);
  await settle(()=>f.c.state==='error');assert.equal(f.requests.filter(r=>r.url==='/api/member/renew').length,0);assert.equal(f.rtc.length,1);
  if(reason==='REMOTE_LOGIN')assert.match(f.c.message,/別端末/);if(reason==='TOKEN_EXPIRED')assert.match(f.c.message,/期限切れ/);}
});
test('native request/approval wire format uses exact channel strings and signed int32 sender UID',()=>{
 const raw=JSON.parse(command('9007199254740993',0xff010203,3));assert.equal(raw.channelId,'9007199254740993');assert.equal(raw.sendId,-16711165);assert.equal(raw.messageType,3);assert.equal(raw.orderType,3);assert.equal(raw.ver,2);
 const session={room:{channel_id:'123'},moderators:[9]};assert.equal(approved({text:command('123',9,4,{channel_id:'123'})},'9',session),true);
 for(const [text,peer] of [[command('456',9,4,{channel_id:'456'}),'9'],[command('123',7,4,{channel_id:'123'}),'9'],[command('123',9,4,{channel_id:'123'}),'8'],['invalid','9']])assert.equal(approved({text},peer,session),false);
});
test('normal member needs one connection confirmation, joins RTC audience + RTM, never captures',async()=>{
 const f=fixture();await assert.rejects(f.c.start({share:'first',accountMode:'member'}),/先に確認/);assert.equal(f.requests.length,0);
 await f.start();assert.equal(f.c.state,'listening');assert.equal(f.rtc[0].roles[0],'audience');assert.equal(f.rtmClients[0].loginArgs.uid,'7');assert.equal(f.rtmClients[0].channel.id,'123');
 assert.equal(f.sdk.micCalls,0);assert.equal(f.c.snapshot().publishingAvailable,false);assert.ok(f.requests.some(r=>r.url==='/api/member/enter'));const s=JSON.stringify(f.c.snapshot());assert.ok(!s.includes('PRIVATE'));await f.c.stop();assert.equal(f.rtmClients[0].loggedOut,true);
});
test('non-auto room sends a genuine peer application; wrong peer/room approval never takes a seat',async()=>{
 const f=fixture();await f.start();await f.c.applySeat();assert.equal(f.c.snapshot().seatRequestState,'waiting');assert.equal(f.rtmClients[0].sent.peer,'9');
 assert.equal(JSON.parse(f.rtmClients[0].sent.message.text).orderType,3);assert.equal(JSON.parse(f.rtmClients[0].channel.sent.text).messageType,14);assert.ok(!f.requests.some(r=>r.url==='/api/member/apply'));
 f.rtmClients[0].emit('MessageFromPeer',{text:command('123',7,4,{channel_id:'123'})},'7');f.rtmClients[0].emit('MessageFromPeer',{text:command('456',9,4,{channel_id:'456'})},'9');await settle();
 assert.ok(!f.requests.some(r=>r.url==='/api/member/apply'));assert.equal(f.sdk.micCalls,0);await f.c.stop();
});
test('moderator approval takes the official seat muted, but does not automatically send',async()=>{
 const f=fixture();await f.start();await f.c.applySeat();f.rtmClients[0].emit('MessageFromPeer',{text:command('123',8,4,{channel_id:'123'})},'8');
 await settle(()=>f.c.snapshot().memberState?.seated);assert.equal(f.c.snapshot().publishingAvailable,true);assert.equal(f.sdk.micCalls,0);assert.equal(f.rtc[0].publishes,0);await f.c.stop();
});
test('auto-pass room obtains a muted official seat without sending a peer request',async()=>{
 const f=fixture({autoPass:true});await f.start();await f.c.applySeat();assert.equal(f.c.snapshot().memberState.muted,true);assert.ok(!f.rtmClients[0].sent);assert.equal(f.sdk.micCalls,0);await f.c.stop();
});
test('own seat + separate send consent renews RTC rights, uses host and restores mute on revocation',async()=>{
 const f=fixture({seated:true});await f.start();await assert.rejects(f.c.publishMic(false),/マイクオンを押して/);assert.equal(f.sdk.micCalls,0);
 await f.c.publishMic(true);assert.equal(f.rtc[0].renewed,true);assert.equal(f.rtc[0].roles.at(-1),'host');assert.equal(f.rtc[0].publishes,1);
 assert.equal(f.c.snapshot().transmittingVerified,false);assert.ok(!JSON.stringify(f.c.snapshot()).includes('PRIVATE'));
 await f.c.closeMic();assert.equal(f.tracks[0].stopped,1);assert.equal(f.tracks[0].closed,1);assert.equal(f.rtc[0].unpublishes,1);assert.equal(f.rtc[0].roles.at(-1),'audience');
 assert.equal(f.requests.filter(r=>r.url==='/api/member/mute').at(-1).body.muted,true);await f.c.stop();
});
test('no seat blocks send before microphone/device or publisher-token requests',async()=>{
 const f=fixture();await f.start();await assert.rejects(f.c.publishMic(true),/マイク席がまだありません/);assert.equal(f.sdk.micCalls,0);assert.ok(!f.requests.some(r=>r.url==='/api/member/publisher'));await f.c.stop();
});
test('seat removal in official status closes capture while remaining an account listener',async()=>{
 const f=fixture({seated:true});await f.start();await f.c.publishMic(true);f.setSeat(false);f.timers.fire();await settle(()=>f.c.micState==='off'&&f.rtc[0].unpublishes===1);
 assert.equal(f.tracks[0].stopped,1);assert.equal(f.c.running,true);assert.equal(f.c.snapshot().publishingAvailable,false);await f.c.stop();
});
test('stop during official unmute withdraws capture then remutes before permit release',async()=>{
 const gate=deferred(),f=fixture({seated:true,unmuteGate:gate});await f.start();const sent=f.c.publishMic(true);await settle(()=>f.requests.some(r=>r.url==='/api/member/mute'));
 const stopped=f.c.stop();assert.equal(f.tracks[0].stopped,1);gate.resolve();await Promise.all([sent,stopped]);assert.equal(f.rtc[0].publishes,0);
 const calls=f.requests.filter(r=>r.url.startsWith('/api/member/')&&r.body);assert.equal(calls.at(-2).body.muted,true);assert.equal(calls.at(-1).url,'/api/member/release');
});
test('revocation while member status is pending prevents a late microphone request',async()=>{
 const options={seated:true},f=fixture(options);await f.start();const gate=deferred();options.statusGate=gate;const sent=f.c.publishMic(true);await settle(()=>f.requests.some(r=>r.url.startsWith('/api/member/status')));
 await f.c.closeMic();gate.resolve();assert.equal(await sent,false);assert.equal(f.sdk.micCalls,0);await f.c.stop();
});
test('late RTM login after stop is logged out and never resumes membership or microphone',async()=>{
 const gate=deferred(),f=fixture({loginGate:gate});const started=f.start();await settle(()=>f.rtmClients[0]?.loginArgs);const stopped=f.c.stop();gate.resolve();await Promise.all([started,stopped]);
 assert.equal(f.c.session,null);assert.equal(f.rtmClients[0].loggedOut,true);assert.ok(!f.rtmClients[0].channel.joined);assert.equal(f.sdk.micCalls,0);assert.equal(f.timers.tasks.size,0);
});
test('RTM replacement/expiry stops the member instead of competing with another App connection',async()=>{
 const f=fixture({seated:true});await f.start();await f.c.publishMic(true);f.rtmClients[0].emit('ConnectionStateChanged','ABORTED','REMOTE_LOGIN');await settle(()=>f.c.state==='error');
 assert.equal(f.tracks[0].stopped,1);assert.equal(f.rtc.length,1);assert.equal(f.timers.tasks.size,0);
});
test('normal public text wire matches native messageType=0/type=1, signed RTC sender and profile',()=>{
 const raw=JSON.parse(textMessage(0xff010203,{name:'You',portrait:''},'こんにちは！',1900000000000)),body=JSON.parse(raw.content);
 assert.equal(raw.messageType,0);assert.equal(raw.orderType,-1);assert.equal(raw.sendId,-16711165);assert.equal(body.userId,'-16711165');
 assert.equal(body.type,1);assert.equal(body.content,'こんにちは！');assert.equal(body.name,'You');assert.equal(body.avatar,'');
 assert.equal(chatText({text:JSON.stringify(raw)},String(0xff010203),{channel_id:'123'}).text,'こんにちは！');
});
test('public text parser rejects spoofed senders, other rooms and non-text commands',()=>{
 const message=JSON.parse(textMessage(9,{name:'Host'},'Welcome',1));
 assert.equal(chatText({text:JSON.stringify(message)},'8',{channel_id:'123'}),null);
 for(const patch of [{channelId:'456'},{messageType:3},{ver:1}])assert.equal(chatText({text:JSON.stringify({...message,...patch})},'9',{channel_id:'123'}),null);
 assert.equal(chatText({text:'bad'},'9',{channel_id:'123'}),null);
});
test('public image wire is native type 14 with an official CDN url',()=>{
 const raw=JSON.parse(imageMessage(7,{name:'You'},{url:'https://cdn.gravity.place/room/a.png',width:40,height:40},1)),body=JSON.parse(raw.content),info=JSON.parse(body.content);
 assert.equal(raw.messageType,0);assert.equal(body.type,14);assert.equal(info.url,'https://cdn.gravity.place/room/a.png');
 const parsed=chatImage({text:JSON.stringify(raw)},'7',{channel_id:'123'});
 assert.equal(parsed.image,'https://cdn.gravity.place/room/a.png');assert.equal(parsed.width,40);assert.equal(parsed.height,40);
 assert.equal(chatText({text:JSON.stringify(raw)},'7',{channel_id:'123'}),null);
 const evil=JSON.parse(imageMessage(9,{name:'Host'},{url:'https://evil.invalid/a.png',width:40,height:40},1));
 assert.equal(chatImage({text:JSON.stringify(evil)},'9',{channel_id:'123'}),null);
});
test('an image another member posts is shown from the official CDN; this page has no way to send one',async()=>{
 const f=fixture();await f.start();await f.c.refreshBoard();
 assert.equal(typeof f.c.sendImage,'undefined');
 const wire=imageMessage(9,{name:'Host'},{url:'https://cdn.gravity.place/room/a.png',width:40,height:40},1);
 f.rtmClients[0].channel.emit('ChannelMessage',{text:wire},'9');await settle(()=>f.c.snapshot().chatMessages.some(m=>m.kind==='image'));
 assert.equal(f.c.snapshot().chatMessages.at(-1).image,'https://cdn.gravity.place/room/a.png');assert.equal(f.sdk.micCalls,0);await f.c.stop();
});
test('greeting is manual, sends exactly the Japanese text on RTM and never uses microphone',async()=>{
 const {GREETINGS}=require('../static/member-controller.js');
 const f=fixture();await f.start();await f.c.refreshBoard();assert.equal(f.rtmClients[0].channel.sent,undefined);
 assert.equal(await f.c.greet(),true);const data=JSON.parse(f.rtmClients[0].channel.sent.text);
 const text=JSON.parse(data.content).content;
 assert.ok([...GREETINGS.morning,...GREETINGS.day,...GREETINGS.night].includes(text));assert.equal(data.sendId,7);assert.equal(f.sdk.micCalls,0);assert.equal(f.rtc[0].publishes,0);
 assert.equal(f.c.snapshot().chatMessages.at(-1).own,true);await assert.rejects(f.c.greet(),/2秒待って/);await f.c.stop();assert.deepEqual(f.c.snapshot().chatMessages,[]);
});
test('public channel messages use the current room, safe text, bounded history, and leave clears it',async()=>{
 const f=fixture();await f.start();await f.c.refreshBoard();const old=f.rtmClients[0];
 for(let i=0;i<105;i++)old.channel.emit('ChannelMessage',{text:textMessage(9,{name:'Wrong'},'<img>'+i,1)},'9');
 assert.equal(f.c.snapshot().chatMessages.length,100);assert.equal(f.c.snapshot().chatMessages[0].name,'Host');
 await f.c.start({share:'second',accountMode:'member',memberConfirmed:true});old.channel.emit('ChannelMessage',{text:textMessage(9,{name:'Host'},'old',1)},'9');
 assert.deepEqual(f.c.snapshot().chatMessages,[]);await f.c.stop();
});
test('send rejects missing account profile, duplicate clicks and does not retry failed chat',async()=>{
 const empty=fixture({noProfile:true});await empty.start();await empty.c.refreshBoard();await assert.rejects(empty.c.greet(),/名刺/);assert.equal(empty.rtmClients[0].channel.sent,undefined);await empty.c.stop();
 const gate=deferred(),f=fixture({chatGate:gate,chatFailure:true});await f.start();await f.c.refreshBoard();const sent=f.c.greet();await settle(()=>f.rtmClients[0].channel.sent);
 await assert.rejects(f.c.greet(),/送信中です/);gate.resolve();await assert.rejects(sent,/send_failed/);assert.equal(f.c.snapshot().chatMessages.length,0);await f.c.stop();
});
test('changing rooms leaves both RTC/RTM and invalidates old room approval events',async()=>{
 const f=fixture();await f.start();await f.c.applySeat();const old=f.rtmClients[0];await f.c.start({share:'second',accountMode:'member',memberConfirmed:true});
 old.emit('MessageFromPeer',{text:command('123',9,4,{channel_id:'123'})},'9');await settle();assert.equal(old.loggedOut,true);assert.equal(f.rtmClients[1].channel.id,'456');assert.ok(!f.requests.some(r=>r.url==='/api/member/apply'));await f.c.stop();
});
test('a refreshed paged roster without self never permanently disables sending',async()=>{
 const f=fixture();await f.start();await f.c.refreshBoard();f.options.noProfile=true;f.options.omitSelf=true;
 await f.c.refreshBoard();assert.equal(f.c.snapshot().roomBoard.self_profile.name,'You');
 assert.ok(!f.c.snapshot().roomBoard.members.some(p=>p.is_self),'latest official page actually omitted self');
 assert.equal(require('../static/view-model.js').offStage(f.c.snapshot().roomBoard).filter(p=>p.is_self).length,1);
 assert.equal(f.c.snapshot().chatAvailable,true);assert.equal(await f.c.sendText('手动输入'),true);
 f.c.session.lastChatAt=null;assert.equal(await f.c.sendText('第二次发送'),true);assert.equal(f.c.snapshot().chatSending,false);await f.c.stop();
});
test('cached own roster card never survives leaving or transfers to a different room session',async()=>{
 const f=fixture();await f.start();await f.c.refreshBoard();assert.ok(f.c.snapshot().roomBoard.self_profile);
 await f.c.stop();assert.equal(f.c.snapshot().roomBoard,null);f.options.noProfile=true;f.options.omitSelf=true;
 await f.c.start({share:'second',accountMode:'member',memberConfirmed:true});await f.c.refreshBoard();assert.equal(f.c.snapshot().roomBoard.self_profile,null);
 assert.ok(require('../static/view-model.js').offStage(f.c.snapshot().roomBoard).every(p=>!p.is_self));await f.c.stop();
});
test('failed text clears the send latch and permits a later message without automatic retry',async()=>{
 const f=fixture({chatFailure:true});await f.start();await assert.rejects(f.c.sendText('第一条'),/send_failed/);
 assert.equal(f.c.snapshot().chatSending,false);f.options.chatFailure=false;assert.equal(await f.c.sendText('第二条'),true);
 assert.equal(f.rtmClients[0].channel.history.length,2);await f.c.stop();
});
test('hung RTM text times out, clears controls, and never appends a late result or retries',async()=>{
 const gate=deferred(),f=fixture({chatGate:gate});await f.start();const sent=f.c.sendText('timeout');
 await settle(()=>f.rtmClients[0].channel.sent);const timeout=[...f.timers.tasks.entries()].find(([,fn])=>fn.delay===12000);
 f.timers.tasks.delete(timeout[0]);timeout[1]();await assert.rejects(sent,/送信がタイムアウト/);assert.equal(f.c.snapshot().chatSending,false);
 f.options.chatGate=null;assert.equal(await f.c.sendText('recover'),true);gate.resolve();await settle();
 assert.equal(f.c.snapshot().chatMessages.length,1);assert.equal(f.rtmClients[0].channel.history.length,2);await f.c.stop();
});
test('explicit entry still greets once, default exit is silent even inside the chat cooldown',async()=>{
 const f=fixture();await f.c.start({share:'first',accountMode:'member',memberConfirmed:true,autoGreetings:true});
 const channel=f.rtmClients[0].channel;assert.equal(channel.history.length,0,'entry is silent by default');
 assert.equal(await f.c.sendText('手动'),true);await Promise.all([f.c.leaveRoom(),f.c.leaveRoom()]);
 assert.deepEqual(channel.history.map(m=>JSON.parse(JSON.parse(m.text).content).content),['手动']);
 assert.equal(f.c.state,'idle');assert.equal(f.sdk.micCalls,0);
});
test('unexpected disconnect stops quietly without sending an automatic farewell',async()=>{
 const f=fixture();await f.c.start({share:'first',accountMode:'member',memberConfirmed:true,autoGreetings:true});
 f.rtmClients[0].emit('ConnectionStateChanged','ABORTED');await settle(()=>f.c.state==='error');
 assert.equal(f.rtmClients[0].channel.history.length,0);
});
test('missing self profile does not gray out chat forever; a later official roster recovers it',async()=>{
 const f=fixture({noProfile:true});await f.start();assert.equal(f.c.snapshot().chatAvailable,true);
 await assert.rejects(f.c.sendText('first'),/名刺/);assert.equal(f.c.snapshot().chatSending,false);
 f.options.noProfile=false;assert.equal(await f.c.sendText('later'),true);await f.c.stop();
});
test('leaving never sends a farewell; entry is silent too',async()=>{
 const f=fixture();await f.c.start({share:'first',accountMode:'member',memberConfirmed:true,autoGreetings:true});await f.c.leaveRoom();
 assert.deepEqual(f.rtmClients[0].channel.history,[]);
});
test('block host stops capture, releases official presence before blocking and leaves RTC/RTM silently',async()=>{
 const f=fixture({seated:true});await f.c.start({share:'first',accountMode:'member',memberConfirmed:true,autoGreetings:true});await f.c.publishMic(true);
 const result=await f.c.blockHostAndLeave();assert.equal(result.blocked,true);assert.equal(f.tracks[0].stopped,1);assert.equal(f.rtc[0].leaves,1);assert.equal(f.rtmClients[0].loggedOut,true);
 const release=f.requests.findIndex(r=>r.url==='/api/member/release'),block=f.requests.findIndex(r=>r.url==='/api/profile/block-host');assert.ok(release>=0&&release<block);
 assert.equal(f.requests[block].body.expected_anchor_id,'9');assert.equal(f.requests[block].body.confirmed,true);assert.equal(f.c.state,'idle');assert.equal(f.timers.tasks.size,0);
 assert.equal(f.rtmClients[0].channel.history.length,0,'no entry greeting and no farewell on block');
});
test('failed block still exits quietly, without claiming success or automatically retrying',async()=>{
 const f=fixture({blockFailure:true});await f.c.start({share:'first',accountMode:'member',memberConfirmed:true,autoGreetings:true});
 await assert.rejects(f.c.blockHostAndLeave(),/ブロックは未確認/);assert.equal(f.c.running,false);assert.equal(f.rtmClients[0].loggedOut,true);
 assert.equal(f.requests.filter(r=>r.url==='/api/profile/block-host').length,1);assert.equal(f.rtmClients[0].channel.history.length,0);
});
test('unconfirmed presence cleanup refuses block, but local room and microphone still stop',async()=>{
 const f=fixture({releaseFailure:true});await f.start();await assert.rejects(f.c.blockHostAndLeave(),/ブロックは未確認/);
 assert.equal(f.c.running,false);assert.equal(f.rtmClients[0].loggedOut,true);assert.equal(f.rtc[0].leaves,1);assert.ok(!f.requests.some(r=>r.url==='/api/profile/block-host'));
});
test('double-click block is one submission and one release',async()=>{
 const f=fixture();await f.start();await Promise.all([f.c.blockHostAndLeave(),f.c.blockHostAndLeave()]);
 assert.equal(f.requests.filter(r=>r.url==='/api/profile/block-host').length,1);assert.equal(f.requests.filter(r=>r.url==='/api/member/release').length,1);
});
test('blocking from preview exits audio without creating account room presence or RTM',async()=>{
 const f=fixture();await f.c.start({share:'first',accountMode:'anonymous'});assert.equal(f.c.running,true);await f.c.blockHostAndLeave();
 assert.equal(f.rtc[0].leaves,1);assert.equal(f.rtmClients.length,0);assert.equal(f.requests.filter(r=>r.url==='/api/profile/block-host').length,1);
 assert.ok(!f.requests.some(r=>r.url.startsWith('/api/member/')));assert.equal(f.timers.tasks.size,0);
});
test('pending unsent text is cancelled by block rather than sent during cleanup',async()=>{
 const f=fixture();await f.start();const gate=deferred();f.options.statusGate=gate;
 const pending=f.c.sendText('queued');await settle(()=>f.requests.some(r=>r.url.startsWith('/api/member/status')));
 await f.c.blockHostAndLeave();gate.resolve();assert.equal(await pending,false);assert.equal(f.rtmClients[0].channel.history.length,0);
});
test('leaving during a gated roster refresh sends nothing and stops',async()=>{
 const gate=deferred(),f=fixture({boardGate:gate});const start=f.c.start({share:'first',accountMode:'member',memberConfirmed:true,autoGreetings:true});
 await settle(()=>f.requests.some(r=>r.url.startsWith('/api/member/board')));await f.c.blockHostAndLeave();gate.resolve();await start;
 assert.equal(f.rtmClients[0].channel.history.length,0);assert.equal(f.c.running,false);
});
test('late moderator approval while blocking does not acquire another seat',async()=>{
 const f=fixture();await f.start();await f.c.applySeat();const gate=deferred();f.options.releaseGate=gate;const block=f.c.blockHostAndLeave();
 await settle(()=>f.requests.some(r=>r.url==='/api/member/release'));f.rtmClients[0].emit('MessageFromPeer',{text:command('123',9,4,{channel_id:'123'})},'9');
 await settle();assert.ok(!f.requests.some(r=>r.url==='/api/member/apply'));gate.resolve();await block;
});
function giftWire(recipient='7',ts=Date.now(),sender=9){return {text:JSON.stringify({messageType:0,ver:2,sendId:sender,content:JSON.stringify({userId:String(sender),name:'Gift sender',type:15,ts,contentV2:JSON.stringify({user_id:recipient,user_name:'Recipient',gift_id:2,gift_name:'Rose',gift_count:1,total_gift_count:1})})})};}
test('gift notifications are bounded and deduplicated; auto thanks always sends',async()=>{
 const f=fixture();await f.start();assert.equal(f.c.snapshot().autoThanks,true);const channel=f.rtmClients[0].channel,m=giftWire();channel.emit('ChannelMessage',m,'9');channel.emit('ChannelMessage',m,'9');
 await settle(()=>channel.history.length===1&&!f.c.snapshot().chatSending);
 assert.equal(f.c.snapshot().chatMessages.filter(m=>m.kind==='gift').length,1);assert.equal(f.c.snapshot().autoThanks,true);await f.c.stop();
});
test('manual thank is only for a verified gift to self and tries once, even after an unknown result',async()=>{
 const f=fixture({chatFailure:true});await f.start();const channel=f.rtmClients[0].channel;
 channel.emit('ChannelMessage',giftWire(),'9');const line=f.c.snapshot().chatMessages[0];
 await settle(()=>line.thanksState==='unconfirmed');assert.equal(await f.c.thankGift(line.gift.key),false);assert.equal(channel.history.length,1);
 channel.emit('ChannelMessage',giftWire('8'),'9');await assert.rejects(f.c.thankGift(f.c.snapshot().chatMessages.at(-1).gift.key),/自分宛/);
 channel.emit('ChannelMessage',giftWire('7',Date.now()+1,8),'9');await assert.rejects(f.c.thankGift(f.c.snapshot().chatMessages.at(-1).gift.key),/出所/);await f.c.stop();
});
test('default-on auto thanks sends only a fresh verified gift to self, deduplicates and thanks every distinct gift',async()=>{
 const f=fixture();let now=1900000000000;f.c.now=()=>now;await f.start();assert.equal(f.c.snapshot().autoThanks,true);assert.equal(f.c.session.autoThanksSince,now);const channel=f.rtmClients[0].channel;
 for(const [recipient,ts,sender,peer]of [['8',now,9,'9'],['7',now-5001,9,'9'],['7',now-70000,9,'9'],['7',now,8,'9'],['7',now+70000,9,'9'],['7',now,7,'7']])channel.emit('ChannelMessage',giftWire(recipient,ts,sender),peer);
 await settle();assert.equal(channel.history.length,0);
 const m=giftWire('7',now,9);channel.emit('ChannelMessage',m,'9');await settle(()=>channel.history.length===1&&!f.c.snapshot().chatSending);
 const thanks=JSON.parse(JSON.parse(channel.history[0].text).content).content;
 assert.match(thanks,/Gift senderさん/);
 channel.emit('ChannelMessage',m,'9');now+=2001;channel.emit('ChannelMessage',giftWire('7',now),'9');await settle(()=>channel.history.length===2&&!f.c.snapshot().chatSending);
 now+=2001;channel.emit('ChannelMessage',giftWire('7',now),'9');await settle(()=>channel.history.length===3&&!f.c.snapshot().chatSending);await f.c.stop();
});
test('switching room restores default-on automatic thanks and discards old gift events',async()=>{
 const f=fixture();let now=1900000000000;f.c.now=()=>now;await f.start();const old=f.rtmClients[0].channel;now+=10000;await f.c.start({share:'second',accountMode:'member',memberConfirmed:true});
 old.emit('ChannelMessage',giftWire(),'9');assert.equal(f.c.snapshot().autoThanks,true);assert.equal(f.c.session.autoThanksSince,now);assert.deepEqual(f.c.snapshot().chatMessages,[]);assert.equal(f.rtmClients[1].channel.history.length,0);await f.c.stop();
});
test('entry, exit and re-entry are always silent; greetings need the 问好 button',async()=>{
 const f=fixture();await f.c.start({share:'first',accountMode:'member',memberConfirmed:true,autoGreetings:true});
 assert.equal(f.rtmClients[0].channel.history.length,0);await f.c.leaveRoom();
 await f.c.start({share:'first',accountMode:'member',memberConfirmed:true,autoGreetings:true});
 assert.equal(f.rtmClients[1].channel.history.length,0);await f.c.leaveRoom();
 await f.c.stop();
});
test('timeGreeting follows JST morning/day/night',()=>{
 const {timeGreeting,GREETINGS}=require('../static/member-controller.js');
 const first=()=>0;
 assert.equal(timeGreeting(new Date('2026-01-01T21:00:00Z'),first),GREETINGS.morning[0]);
 assert.equal(timeGreeting(new Date('2026-01-01T00:59:00Z'),first),GREETINGS.morning[0]);
 assert.equal(timeGreeting(new Date('2026-01-01T01:00:00Z'),first),GREETINGS.day[0]);
 assert.equal(timeGreeting(new Date('2026-01-01T08:59:00Z'),first),GREETINGS.day[0]);
 assert.equal(timeGreeting(new Date('2026-01-01T09:00:00Z'),first),GREETINGS.night[0]);
 assert.equal(timeGreeting(new Date('2026-01-01T15:00:00Z'),first),GREETINGS.night[0]);
 assert.equal(timeGreeting(new Date('2026-01-01T21:00:00Z'),()=>0.99),GREETINGS.morning.at(-1));
});
test('greetings are Japanese-only pools of at least eight lines each',()=>{
 const {GREETINGS}=require('../static/member-controller.js');
 for(const [slot,lines] of Object.entries(GREETINGS)){
  assert.ok(lines.length>=8,slot);
  for(const line of lines){
   assert.match(line,/[\u3040-\u30ff]/,line);
   assert.doesNotMatch(line,/你好|谢谢|早上好|晚上好|感谢/,line);
  }
 }
});
test('moderator invite takes a muted seat without publishing',async()=>{
 const f=fixture();await f.start();assert.equal(invited({text:command('123',9,1)},'9',f.c.session),true);
 f.rtmClients[0].emit('MessageFromPeer',{text:command('123',9,1)},'9');
 await settle(()=>f.c.snapshot().memberState?.seated);assert.equal(f.c.snapshot().memberState.muted,true);assert.equal(f.sdk.micCalls,0);await f.c.stop();
});
test('channel-broadcast invite also takes a muted seat',async()=>{
 const f=fixture();await f.start();
 f.rtmClients[0].channel.emit('ChannelMessage',{text:command('123',9,1)},'9');
 await settle(()=>f.c.snapshot().memberState?.seated);assert.equal(f.c.snapshot().memberState.muted,true);assert.equal(f.sdk.micCalls,0);await f.c.stop();
});
test('host invite still works when the manager list omits the host',async()=>{
 const f=fixture({moderators:[8]});await f.start();f.c.session.moderators=[8];
 f.rtmClients[0].emit('MessageFromPeer',{text:command('123',9,1)},'9');
 await settle(()=>f.c.snapshot().memberState?.seated);assert.equal(f.c.snapshot().memberState.muted,true);await f.c.stop();
});
const applies=f=>f.requests.filter(r=>r.url==='/api/member/apply').length;
test('an invite is checked against fresh seat state and retried after a failed attempt',async()=>{
 const f=fixture({applyFails:1});await f.start();
 f.rtmClients[0].emit('MessageFromPeer',{text:command('123',9,1)},'9');
 await settle(()=>applies(f)===1&&f.timers.tasks.size>0&&[...f.timers.tasks.values()].some(fn=>fn.delay===1500));
 assert.equal(f.c.snapshot().memberState.seated,false);
 const retry=[...f.timers.tasks.entries()].find(([,fn])=>fn.delay===1500);f.timers.tasks.delete(retry[0]);retry[1]();
 await settle(()=>f.c.snapshot().memberState?.seated);assert.equal(applies(f),2);assert.equal(f.c.snapshot().memberState.muted,true);assert.equal(f.sdk.micCalls,0);
 assert.ok(f.logs.some(m=>/マイク席招待に失敗/.test(m)));await f.c.stop();
});
test('an admin appointed after we joined can still invite: the list is refreshed once, strangers stay ignored',async()=>{
 const f=fixture({moderators:[9,8,77]});await f.start();assert.deepEqual(f.c.session.moderators,[9,8]);
 f.rtmClients[0].emit('MessageFromPeer',{text:command('123',77,1)},'77');
 await settle(()=>f.c.snapshot().memberState?.seated);assert.deepEqual(f.c.session.moderators,[9,8,77]);
 await f.c.leaveSeat();assert.equal(f.c.snapshot().memberState.seated,false);const before=applies(f);
 f.rtmClients[0].emit('MessageFromPeer',{text:command('123',55,1)},'55');
 await settle(()=>f.requests.filter(r=>r.url.startsWith('/api/member/status')).length>=3);await new Promise(r=>setImmediate(r));
 assert.equal(applies(f),before,'55 is not a moderator even after the refresh');await f.c.stop();
});
test('an invite does nothing when we are already seated, even if our cached state is old',async()=>{
 const f=fixture();await f.start();await f.c.applySeat().catch(()=>{});f.setSeat(true);f.setMute(false);await f.c.checkMember(f.c.session);
 const mutes=f.requests.filter(r=>r.url==='/api/member/mute').length,before=applies(f);
 f.rtmClients[0].emit('MessageFromPeer',{text:command('123',9,1)},'9');await settle();await new Promise(r=>setImmediate(r));
 assert.equal(applies(f),before);assert.equal(f.requests.filter(r=>r.url==='/api/member/mute').length,mutes,'a live mic is never re-muted by an invite');await f.c.stop();
});
test('repeated invites while one is being answered do not start parallel attempts',async()=>{
 const gate=deferred(),f=fixture({statusGate:gate});await f.start();
 gate.resolve();await settle();
 const base=applies(f);
 for(let i=0;i<4;i++)f.rtmClients[0].emit('MessageFromPeer',{text:command('123',9,1)},'9');
 await settle(()=>f.c.snapshot().memberState?.seated);assert.equal(applies(f),base+1);await f.c.stop();
});
test('a malformed or foreign invite is not even a candidate',()=>{
 const f=fixture();const session={room:{channel_id:'123'},moderators:[9]};
 assert.equal(commandSender({text:command('123',9,1)},'9',session,1),9);
 for(const [message,peer,order] of [[{text:command('456',9,1)},'9',1],[{text:command('123',9,3)},'9',1],[{text:command('123',9,1)},'10',1],[{text:'x'},'9',1],[{text:command('123',9,1)},'-1',1]])assert.equal(commandSender(message,peer,session,order),0);
 assert.equal(invited({text:command('123',10,1)},'10',session),false);
});
test('becoming visible again polls the room state at once',async()=>{
 const f=fixture();await f.start();const before=f.requests.filter(r=>r.url.startsWith('/api/member/status')).length;
 f.c.pollNow();await settle(()=>f.requests.filter(r=>r.url.startsWith('/api/member/status')).length>before);await f.c.stop();f.c.pollNow();
});
test('audio from people we block is never played: not at join, not when they publish later, and it stops when the block appears',async()=>{
 const f=fixture({moderators:[9,8],blockedFromServer:[4]});
 await f.start();
 const play=uid=>{const track={uid,played:0,stopped:0,setVolume(){},play(){this.played++;},stop(){this.stopped++;}};return {uid,audioTrack:track,track};};
 const client=f.rtc[0];client.subscribe=async()=>{};
 const quiet=play(4),loud=play(5);
 client.emit('user-published',quiet,'audio');client.emit('user-published',loud,'audio');await settle(()=>loud.track.played===1);
 assert.equal(quiet.track.played,0,'blocked from the first status poll on');assert.equal(f.c.snapshot().remoteAudioCount,1);
 f.c.applyBlocked(f.c.session,[4,5]);assert.equal(loud.track.stopped,1);assert.equal(f.c.snapshot().remoteAudioCount,0);
 const again=play(5);client.emit('user-published',again,'audio');await new Promise(r=>setImmediate(r));assert.equal(again.track.played,0);
 f.c.applyBlocked(f.c.session,[]);const back=play(5);client.emit('user-published',back,'audio');await settle(()=>back.track.played===1);
 await f.c.stop();
});
test('roster-flagged blocked people are silenced even before the server list knows them',async()=>{
 const f=fixture();await f.start();const client=f.rtc[0];client.subscribe=async()=>{};
 f.c.session.roomBoard={members:[{user_id:'9',rtc_uid:9,blocked:false},{user_id:'12',rtc_uid:12,blocked:true}],seats:[{seat_id:1,person:{user_id:'13',rtc_uid:13,blocked:true}}]};
 f.c.applyBlocked(f.c.session);assert.deepEqual([...f.c.session.mutedUids].sort((a,b)=>a-b),[12,13]);
 await f.c.stop();
});
test('public from lines never trigger an automatic reply',async()=>{
 const f=fixture();await f.start();await f.c.refreshBoard();
 const ask=()=>f.rtmClients[0].channel.emit('ChannelMessage',{text:JSON.stringify({messageType:0,orderType:-1,sendId:9,ver:2,channelId:'123',content:JSON.stringify({userId:'9',type:1,name:'Host',content:'from?'})})},'9');
 assert.equal('autoFrom' in f.c.snapshot(),false);
 ask();await settle();await new Promise(r=>setTimeout(r,5));assert.equal(f.rtmClients[0].channel.history.length,0);
 assert.match(f.c.snapshot().chatMessages.at(-1)?.text||'',/from/);
 await f.c.stop();
});
const sentOrders=f=>f.rtmClients[0].sentAll.map(x=>JSON.parse(x.message.text).orderType);
test('a normal open room takes the seat directly; a refused direct call falls back to asking the host',async()=>{
 const f=fixture({autoPass:true});await f.start();f.rtmClients[0].sentAll=[];const send=f.rtmClients[0].sendMessageToPeer;f.rtmClients[0].sendMessageToPeer=async(message,peer)=>{f.rtmClients[0].sentAll.push({message,peer});return send(message,peer);};
 await f.c.applySeat();assert.equal(f.c.snapshot().memberState.seated,true);assert.deepEqual(sentOrders(f),[]);await f.c.leaveSeat();
 f.options.applyFails=1;await f.c.applySeat();
 assert.deepEqual(sentOrders(f),[3]);assert.equal(f.rtmClients[0].sentAll[0].peer,'9');assert.equal(f.c.snapshot().seatRequestState,'waiting');
 f.rtmClients[0].emit('MessageFromPeer',{text:command('123',9,4)},'9');await settle(()=>f.c.snapshot().memberState?.seated);assert.equal(f.c.snapshot().memberState.muted,true);
 assert.ok(f.logs.some(m=>/直接着席できなかったので、ホストに申請します/.test(m)));await f.c.stop();
});
test('a group-call room (room_type 2) always asks the host first; an open one also tries the direct call',async()=>{
 const closed=fixture({roomType:2});await closed.start();closed.rtmClients[0].sentAll=[];const sc=closed.rtmClients[0].sendMessageToPeer;closed.rtmClients[0].sendMessageToPeer=async(m,p)=>{closed.rtmClients[0].sentAll.push({message:m,peer:p});return sc(m,p);};
 await closed.c.applySeat();assert.deepEqual(sentOrders(closed),[3]);assert.equal(applies(closed),0);assert.equal(closed.c.snapshot().seatRequestState,'waiting');
 closed.rtmClients[0].emit('MessageFromPeer',{text:command('123',9,4)},'9');await settle(()=>closed.c.snapshot().memberState?.seated);assert.equal(applies(closed),1);await closed.c.stop();
 const open=fixture({roomType:2,autoPass:true,applyFails:1});await open.start();open.rtmClients[0].sentAll=[];const so=open.rtmClients[0].sendMessageToPeer;open.rtmClients[0].sendMessageToPeer=async(m,p)=>{open.rtmClients[0].sentAll.push({message:m,peer:p});return so(m,p);};
 await open.c.applySeat();await settle(()=>applies(open)>=1);assert.deepEqual(sentOrders(open),[3]);assert.equal(open.c.snapshot().seatRequestState,'waiting','still waiting for the host after the direct call was refused');
 assert.ok(open.logs.some(m=>/承認待ちを続けます/.test(m)));open.rtmClients[0].emit('MessageFromPeer',{text:command('123',9,4)},'9');await settle(()=>open.c.snapshot().memberState?.seated);await open.c.stop();
});
test('hosts and admins take the seat directly, even in a group call, and a refusal is reported instead of hidden',async()=>{
 for(const options of [{owner:true,roomType:2},{adminSelf:true,roomType:2},{adminSelf:true}]){
  const f=fixture(options);await f.start();await f.c.applySeat();assert.equal(applies(f),1);assert.equal(f.c.snapshot().memberState.seated,true);await f.c.stop();}
 const refused=fixture({adminSelf:true,applyFails:1});await refused.start();await assert.rejects(refused.c.applySeat(),/apply_failed/);await refused.c.stop();
});
test('only the host can end the room: confirmed request, then the page stops without a second release',async()=>{
 const guest=fixture();await guest.start();await assert.rejects(guest.c.endRoom(),/ホストだけが/);assert.ok(!guest.requests.some(r=>r.url==='/api/member/destroy'));await guest.c.stop();
 const host=fixture({owner:true});await host.start();
 const done=await host.c.endRoom();assert.deepEqual(done,{destroyed:true});
 const call=host.requests.find(r=>r.url==='/api/member/destroy');assert.equal(call.body.confirmed,true);assert.equal(host.c.running,false);
 assert.ok(!host.requests.some(r=>r.url==='/api/member/release'),'the room is gone, nothing to release');
 const failing=fixture({owner:true,destroyFailure:true});await failing.start();await assert.rejects(failing.c.endRoom(),/destroy_failed/);
 assert.equal(failing.c.running,true);assert.equal(failing.c.session.leaving,false);await failing.c.stop();
});
test('the roster comes back whole from one call, with no load-more cursor to lose on refresh',async()=>{
 const f=fixture();await f.start();await f.c.refreshBoard();const requests=f.requests.filter(r=>r.url.startsWith('/api/member/board'));
 assert.ok(requests.every(r=>!r.url.includes('cursor')));assert.equal(f.c.snapshot().roomBoard.members.length,2);await f.c.stop();
});
test('member audio reconnecting does not halt the room',async()=>{
 const f=fixture();await f.start();f.rtc[0].emit('connection-state-change','RECONNECTING','CONNECTED','NETWORK');
 await settle();assert.equal(f.c.state,'listening');assert.equal(f.c.running,true);f.rtmClients[0].emit('ConnectionStateChanged','RECONNECTING','NETWORK');
 await settle();assert.equal(f.c.state,'listening');await f.c.stop();
});
test('soft status blips retry for minutes without dropping audio; hard rejections stop fast with their cause',async()=>{
 const f=fixture();await f.start();f.options.statusFailure=true;
 for(let i=0;i<5;i++){const timer=[...f.timers.tasks.entries()].find(([,fn])=>fn.delay===5000);assert.ok(timer);f.timers.tasks.delete(timer[0]);timer[1]();await settle();assert.equal(f.c.state,'listening');}
 assert.equal(f.c.session.softFails,5);assert.equal(f.c.session.hardFails,0);
 // One good poll clears the soft streak.
 f.options.statusFailure=false;
 const ok=[...f.timers.tasks.entries()].find(([,fn])=>fn.delay===5000);f.timers.tasks.delete(ok[0]);ok[1]();await settle();assert.equal(f.c.session.softFails,0);
 // A hard rejection (dead session) stops after a single retry, naming the cause.
 f.options.statusFailure=true;f.options.statusHttp=409;f.options.statusMessage='官方会话已失效，请同步 App 会话后重进。';
 for(let i=0;i<2;i++){const timer=[...f.timers.tasks.entries()].find(([,fn])=>fn.delay===5000);f.timers.tasks.delete(timer[0]);timer[1]();await settle();}
 await settle(()=>f.c.state==='error');assert.match(f.c.message,/官方会话已失效/);
});
test('round-the-clock soft failures stop only after about two minutes, not thirty seconds',async()=>{
 const f=fixture();await f.start();f.options.statusFailure=true;
 for(let i=0;i<23;i++){const timer=[...f.timers.tasks.entries()].find(([,fn])=>fn.delay===5000);assert.ok(timer);f.timers.tasks.delete(timer[0]);timer[1]();await settle();assert.equal(f.c.state,'listening');}
 const last=[...f.timers.tasks.entries()].find(([,fn])=>fn.delay===5000);f.timers.tasks.delete(last[0]);last[1]();
 await settle(()=>f.c.state==='error');assert.match(f.c.message,/長く取れません/);
});
test('degraded presence keeps audio and reports retrying instead of halting',async()=>{
 const f=fixture({degradedPresence:true});await f.start();
 await f.c.checkMember(f.c.session);
 assert.equal(f.c.snapshot().presence,'degraded');assert.equal(f.c.session.softFails,1);assert.equal(f.c.state,'listening');
 await f.c.stop();
});
test('room treasure is claimed after ten minutes once the box ids are known',async()=>{
 const f=fixture();await f.start();
 const box={text:JSON.stringify({messageType:0,ver:2,sendId:9,channelId:'123',content:JSON.stringify({type:99,contentV2:JSON.stringify({lucky_box_id:'88',issue_user_id:'9',channel_id:'123'})})})};
 f.rtmClients[0].channel.emit('ChannelMessage',box,'9');
 const timer=[...f.timers.tasks.entries()].find(([,fn])=>fn.delay===600000);assert.ok(timer);f.timers.tasks.delete(timer[0]);timer[1]();
 await settle(()=>f.requests.some(r=>r.url==='/api/member/lucky-box'));
 const call=f.requests.find(r=>r.url==='/api/member/lucky-box');assert.equal(call.body.lucky_box_id,'88');assert.equal(call.body.confirmed,true);await f.c.stop();
});
test('each public-chat box is claimed after ten minutes, not just the last one',async()=>{
 const f=fixture();await f.start();
 const box=id=>({text:JSON.stringify({messageType:0,ver:2,sendId:9,channelId:'123',content:JSON.stringify({type:99,contentV2:JSON.stringify({lucky_box_id:id,issue_user_id:'9',channel_id:'123'})})})});
 f.rtmClients[0].channel.emit('ChannelMessage',box('88'),'9');
 f.rtmClients[0].channel.emit('ChannelMessage',box('89'),'9');
 const timer=[...f.timers.tasks.entries()].find(([,fn])=>fn.delay===600000);assert.ok(timer);f.timers.tasks.delete(timer[0]);timer[1]();
 await settle(()=>f.requests.filter(r=>r.url==='/api/member/lucky-box').length===2);
 assert.deepEqual(f.requests.filter(r=>r.url==='/api/member/lucky-box').map(r=>r.body.lucky_box_id),['88','89']);
 await f.c.stop();
});
test('from lines are shown as plain chat without an automatic reply',async()=>{
 const f=fixture();await f.start();const channel=f.rtmClients[0].channel;
 const from={text:JSON.stringify({messageType:0,ver:2,sendId:9,channelId:'123',content:JSON.stringify({userId:'9',name:'Host',type:8,content:'from TW'})})};
 channel.emit('ChannelMessage',from,'9');await settle(()=>f.c.snapshot().chatMessages.length===1);
 assert.equal(f.c.snapshot().chatMessages[0].text,'from TW');assert.equal(channel.history.length,0);
 channel.emit('ChannelMessage',from,'9');await settle(()=>f.c.snapshot().chatMessages.length===2);assert.equal(channel.history.length,0);await f.c.stop();
});
test('host can kick someone out, kick them off a seat, approve applicants, and rewrite tags',async()=>{
 const host=fixture({owner:true});await host.start();
 await host.c.evictSeat(12);
 assert.equal(JSON.parse(host.rtmClients[0].sent.message.text).orderType,0);
 await host.c.kickFromRoom('555',12);
 assert.equal(host.requests.find(r=>r.url==='/api/member/kick').body.target_user_id,'555');
 assert.equal(JSON.parse(host.rtmClients[0].sent.message.text).messageType,4);
 host.rtmClients[0].emit('MessageFromPeer',{text:command('123',12,3,{channel_id:'123'})},'12');
 await settle(()=>host.c.snapshot().applyQueue.length===1);
 await host.c.allowApplicant(12);
 assert.equal(JSON.parse(host.rtmClients[0].sent.message.text).orderType,4);
 assert.equal(host.c.snapshot().applyQueue.length,0);
 await host.c.updateRoom({tags:'alpha,beta',notice:'hi',auto_pass:true});
 const upd=host.requests.find(r=>r.url==='/api/member/update-room');
 assert.equal(upd.body.tags,'alpha,beta');assert.equal(upd.body.notice,'hi');assert.equal(upd.body.auto_pass,true);
 const guest=fixture();await guest.start();
 await assert.rejects(guest.c.kickFromRoom('555',12),/ホストだけが/);
 await assert.rejects(guest.c.evictSeat(12),/ホストだけが/);
 await assert.rejects(guest.c.updateRoom({tags:'x'}),/ホストだけが/);
 await host.c.stop();await guest.c.stop();
});
 test('official kick from the host stops this page; a random peer type-4 is ignored',async()=>{
 const f=fixture();await f.start();
 f.rtmClients[0].emit('MessageFromPeer',{text:JSON.stringify({messageType:4,orderType:-1,channelId:'123',content:'{"channel_id":"123"}',sendId:12,ver:2})},'12');
 await settle();assert.equal(f.c.state,'listening');
 f.rtmClients[0].emit('MessageFromPeer',{text:JSON.stringify({messageType:4,orderType:-1,channelId:'123',content:'{"channel_id":"123"}',sendId:9,ver:2})},'9');
 await settle(()=>f.c.state==='error');assert.match(f.c.message,/ルームから外しました/);
});
 test('auto welcome clicks the native button, dog-greet uses the template, like is type 13',async()=>{
 const host=fixture({owner:true});await host.start();
 await settle(()=>host.c.session.roomBoard);
 host.c.session.autoWelcome=true;
 const join={text:JSON.stringify({messageType:0,ver:2,sendId:12,channelId:'123',content:JSON.stringify({userId:'12',name:'Guest',type:2,content:'',contentV2:JSON.stringify({showWelcomeBtn:1})})})};
 host.rtmClients[0].channel.emit('ChannelMessage',join,'12');
 await settle(()=>host.rtmClients[0].sent);
 assert.equal(JSON.parse(JSON.parse(host.rtmClients[0].sent.message.text).content).type,12);
 host.c.session.hostDog=true;host.c.session.hostWelcomeText='{name}，ようこそ！';
 host.rtmClients[0].channel.emit('MemberJoined','12');
 await settle(()=>host.rtmClients[0].channel.history.some(m=>JSON.parse(JSON.parse(m.text).content).type===1));
 assert.match(JSON.parse(JSON.parse(host.rtmClients[0].channel.history.at(-1).text).content).content,/ようこそ/);
 await host.c.likeRoom();
 assert.equal(JSON.parse(JSON.parse(host.rtmClients[0].channel.sent.text).content).type,13);
 await host.c.stop();
});
 test('listener mute stops that person without dropping the subscribed track',async()=>{
 const f=fixture();await f.start();
 const audio={volume:150,playCount:0,stopCount:0,setVolume(v){this.volume=v;},play(){this.playCount++;},stop(){this.stopCount++;}};
 f.rtc[0].emit('user-published',{uid:9,audioTrack:audio},'audio');await settle(()=>f.c.snapshot().remoteAudioCount===1);
 assert.equal(audio.playCount,1);
 assert.equal(f.c.toggleListenerMute(9,true),true);assert.equal(audio.volume,0);assert.equal(audio.stopCount,1);
 assert.equal(f.c.snapshot().remoteAudioCount,1);
 assert.equal(f.c.toggleListenerMute(9,false),true);assert.equal(audio.volume,150);assert.equal(audio.playCount,2);
 const late={volume:150,playCount:0,stopCount:0,setVolume(v){this.volume=v;},play(){this.playCount++;},stop(){this.stopCount++;}};
 assert.equal(f.c.toggleListenerMute(8,true),true);
 f.rtc[0].emit('user-published',{uid:8,audioTrack:late},'audio');await settle(()=>f.c.snapshot().remoteAudioCount===2);
 assert.equal(late.playCount,0);assert.equal(late.volume,0);assert.equal(late.stopCount,1);
 await f.c.stop();
});
 test('host can invite someone up and mute their seat; guests cannot',async()=>{
 const host=fixture({owner:true});await host.start();
 assert.equal(host.c.snapshot().isHost,true);
 await host.c.inviteToSeat(12);
 const sent=host.rtmClients[0].sent;assert.equal(sent.peer,'12');assert.equal(JSON.parse(sent.message.text).orderType,1);
 await assert.rejects(host.c.inviteToSeat(7),/招待先が無効/);
 await assert.rejects(host.c.muteSeat(64,true),/マイク席が無効/);
 await host.c.muteSeat(1,true);
 const call=host.requests.find(r=>r.url==='/api/member/seat-mute');
 assert.deepEqual(call.body,{channel_id:'123',member_permit:'PRIVATE-PERMIT',confirmed:true,seat_id:'1',muted:true});
 const guest=fixture();await guest.start();
 assert.equal(guest.c.snapshot().isHost,false);
 await assert.rejects(guest.c.inviteToSeat(12),/ホストだけが/);
 await assert.rejects(guest.c.muteSeat(1,true),/ホストだけが/);
 await host.c.stop();await guest.c.stop();
});
test('forceLeave detaches immediately even when a normal leave hangs on release',async()=>{
 const gate=deferred(),f=fixture({releaseGate:gate});await f.start();
 assert.equal(f.c.snapshot().running,true);
 const leaving=f.c.leaveRoom();
 // Normal leave detaches running=false early but hangs in 'stopping' behind
 // the blocked release; the force button must survive that state.
 await settle(()=>f.c.snapshot().state==='stopping');
 // Force must not wait for the hung release/dispose.
 const forced=await f.c.forceLeave();
 assert.equal(forced,true);
 const snap=f.c.snapshot();
 assert.equal(snap.running,false);assert.equal(snap.leaving,false);assert.equal(snap.state,'idle');
 assert.equal(f.c.session,null);
 const force=f.requests.find(r=>r.url==='/api/member/force-release');
 assert.ok(force);assert.equal(force.body.channel_id,'123');
 gate.resolve();await leaving.catch(()=>{});
 // A fresh entry works right after the force.
 await f.start();assert.equal(f.c.snapshot().running,true);await f.c.stop();
});
test('forceLeave while idle still reports idle and never throws',async()=>{
 const f=fixture();
 assert.equal(await f.c.forceLeave(),true);
 assert.equal(f.c.snapshot().running,false);
 assert.ok(!f.requests.some(r=>r.url==='/api/member/force-release'));
});
test('the shipped member subclass preserves anonymous make-before-break handover and releases the old client',async()=>{
 const f=fixture();await f.c.start({share:'first',accountMode:'anonymous'});const old=f.c.session;
 await f.c.rejoin(old.room,old.generation);assert.notEqual(f.c.session,old);assert.equal(f.rtc[0].leaves,1);
 assert.equal(f.rtmClients.length,0);await f.c.stop();assert.equal(f.timers.tasks.size,0);
});
test('terminal RTC disconnect really rejoins instead of pretending healthy audio is still playing',async()=>{
 const f=fixture();await f.start();f.rtc[0].emit('connection-state-change','DISCONNECTED','RECONNECTING','NETWORK_ERROR');
 await settle(()=>f.rtc[0].joins===2&&f.c.state==='listening');
 assert.equal(f.rtc.length,1);assert.equal(f.rtmClients.length,1);
 assert.equal(f.requests.filter(r=>r.url==='/api/member/enter').length,1);
 assert.equal(f.rtmClients[0].renewals,1);assert.equal(f.sdk.micCalls,0);await f.c.stop();assert.equal(f.timers.tasks.size,0);
});
test('microphone cannot reopen during a transport interruption or resume automatically on recovery',async()=>{
 const f=fixture({seated:true});await f.start();f.rtc[0].emit('connection-state-change','RECONNECTING','CONNECTED','NETWORK_ERROR');
 await assert.rejects(f.c.publishMic(true),/復旧中/);assert.equal(f.sdk.micCalls,0);assert.equal(f.c.snapshot().publishingAvailable,false);
 f.rtc[0].emit('connection-state-change','CONNECTED','RECONNECTING','');await settle();
 assert.equal(f.sdk.micCalls,0);assert.equal(f.c.micState,'off');await f.c.stop();assert.equal(f.timers.tasks.size,0);
});
test('RTC recovery drops stale audio tracks and meters before subscribing again',async()=>{
 const f=fixture();await f.start();let stops=0;
 f.rtc[0].emit('user-published',{uid:9,audioTrack:{play(){},setVolume(){},stop(){stops++;}}},'audio');
 await settle(()=>f.c.snapshot().remoteAudioCount===1);await f.c.recoverMemberRtc(f.c.session);
 assert.equal(stops,1);assert.equal(f.c.snapshot().remoteAudioCount,0);assert.equal(f.c.levelPeaks.size,0);
 f.rtc[0].emit('user-published',{uid:9,audioTrack:{play(){},setVolume(){},stop(){}}},'audio');
 await settle(()=>f.c.snapshot().remoteAudioCount===1);assert.equal(f.c.session.tracks.size,1);await f.c.stop();assert.equal(f.timers.tasks.size,0);
});
test('a late successful RTC recovery join is left after stop, not leaked behind a closed UI',async()=>{
 const f=fixture();await f.start();const gate=deferred();
 f.rtc[0].join=async()=>{f.rtc[0].joins++;await gate.promise;};
 const work=f.c.recoverMemberRtc(f.c.session);await settle(()=>f.rtc[0].joins===2);
 const stopped=f.c.stop();gate.resolve();await Promise.all([work,stopped]);
 assert.equal(f.c.state,'idle');assert.equal(f.c.session,null);assert.ok(f.rtc[0].leaves>=2);assert.equal(f.sdk.micCalls,0);assert.equal(f.timers.tasks.size,0);
});
test('stop cancels a queued RTC recovery and late renewal cannot resurrect the connection',async()=>{
 const f=fixture({renewFailure:true,renewHttp:503});await f.start();
 f.rtc[0].emit('connection-state-change','DISCONNECTED','RECONNECTING','NETWORK_ERROR');
 await settle(()=>f.c.session.rtcRecoveryTimer!=null);await f.c.stop();assert.equal(f.timers.tasks.size,0);assert.equal(f.rtc[0].joins,1);
 const g=fixture({renewGate:deferred()});await g.start();const session=g.c.session,work=g.c.recoverMemberRtc(session);
 await settle(()=>g.requests.some(r=>r.url==='/api/member/renew'));await g.c.stop();g.options.renewGate.resolve();await work;
 assert.equal(g.rtc[0].joins,1);assert.equal(g.timers.tasks.size,0);
});
test('retired invisible requests never fall through to audition or visible entry',async()=>{
 for(const accountMode of ['anonymous','member']){
  const f=fixture();await assert.rejects(f.c.start({share:'first',accountMode,memberConfirmed:true,stealth:true}),/非表示入室は廃止/);
  assert.equal(f.c.running,false);assert.equal(f.c.state,'idle');assert.equal(f.requests.length,0);
  assert.equal(f.rtc.length,0);assert.equal(f.rtmClients.length,0);assert.equal(f.timers.tasks.size,0);
 }
});
test('ordinary entry still registers presence and keeps seat flows',async()=>{
 const f=fixture();await f.start();
 assert.equal('stealth' in f.c.snapshot(),false);
 assert.equal(f.requests.filter(r=>r.url==='/api/member/enter').length,1);
 await f.c.stop();
});

test('page unload sends the release at once (keepalive) instead of after the RTC/RTM teardown',async()=>{
 const f=fixture();await f.start();
 assert.equal(f.c.releaseOnUnload(),true);
 const sent=f.requests.filter(r=>r.url==='/api/member/release');
 assert.equal(sent.length,1);assert.deepEqual(sent[0].body,{channel_id:'123',member_permit:'PRIVATE-PERMIT'});
 assert.equal(f.c.releaseOnUnload(),false,'only once');
 await f.c.stop();
 assert.equal(f.requests.filter(r=>r.url==='/api/member/release').length,1,'teardown does not release twice');
});
test('the top-bar force release works with no local room and sends no room id',async()=>{
 const f=fixture();
 const data=await f.c.forceRelease();
 assert.ok(data);const call=f.requests.find(r=>r.url==='/api/member/force-release');
 assert.deepEqual(call.body,{confirmed:true});
});
test('a box the official side refuses is skipped, never blocking the boxes after it',async()=>{
 const f=fixture();let n=0;const base=f.c.fetch;
 f.c.fetch=async(url,config)=>{const reply=await base(url,config);if(url==='/api/member/lucky-box'&&n++===0)return {ok:false,status:502,json:async()=>({errno:-1,errmsg:'expired'})};return reply;};
 await f.start();
 const box=id=>({text:JSON.stringify({messageType:0,ver:2,sendId:9,channelId:'123',content:JSON.stringify({type:99,contentV2:JSON.stringify({lucky_box_id:id,issue_user_id:'9',channel_id:'123'})})})});
 f.rtmClients[0].channel.emit('ChannelMessage',box('88'),'9');f.rtmClients[0].channel.emit('ChannelMessage',box('89'),'9');
 const ten=[...f.timers.tasks.entries()].find(([,fn])=>fn.delay===600000);f.timers.tasks.delete(ten[0]);ten[1]();
 await settle(()=>f.requests.filter(r=>r.url==='/api/member/lucky-box').length===2);
 f.rtmClients[0].channel.emit('ChannelMessage',box('90'),'9');
 await settle(()=>f.requests.filter(r=>r.url==='/api/member/lucky-box').length===3);
 assert.deepEqual(f.requests.filter(r=>r.url==='/api/member/lucky-box').map(r=>r.body.lucky_box_id),['88','89','90']);
 f.rtmClients[0].channel.emit('ChannelMessage',box('88'),'9');for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));
 assert.equal(f.requests.filter(r=>r.url==='/api/member/lucky-box').length,3,'each box is tried once');
 await f.c.stop();
});

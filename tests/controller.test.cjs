'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Controller, tokenPrivileges, describe } = require('../static/controller.js');
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
async function settle(condition = () => true) { for(let i=0;i<40;i++){ await new Promise(r=>setImmediate(r)); if(condition()) return; } throw new Error('test did not settle'); }
function token(ids=[1]) {
  const message=Buffer.alloc(10+6*ids.length); message.writeUInt16LE(ids.length,8);
  ids.forEach((id,i)=>{message.writeUInt16LE(id,10+i*6);message.writeUInt32LE(2000000000,12+i*6);});
  const body=Buffer.alloc(2+32+8+2+message.length); body.writeUInt16LE(32); body.writeUInt16LE(message.length,42);message.copy(body,44);
  return '006'+'0'.repeat(32)+body.toString('base64');
}
function track() { return { volume:null, playCount:0, stopCount:0, closeCount:0, captureStops:0,
  setVolume(v){this.volume=v;},play(){this.playCount++;},stop(){this.stopCount++;},close(){this.closeCount++;},
  getVolumeLevel(){return .5;},getMediaStreamTrack(){return {stop:()=>{this.captureStops++;}};} }; }
class Client extends EventEmitter {
  constructor(joinGate){super();this.joinGate=joinGate;this.leaves=0;this.publishes=0;this.unpublishes=0;this.subscribes=0;}
  async join(...args){this.joinArgs=args;if(this.joinGate)await this.joinGate.promise;}
  async setClientRole(role){this.role=role;}
  async leave(){this.leaves++;}
  async subscribe(){this.subscribes++;}
  async renewToken(){this.renewals=(this.renewals||0)+1;}
  async publish(){this.publishes++;if(this.publishGate)await this.publishGate.promise;}
  async unpublish(){this.unpublishes++;}
}
class Timers {
  constructor(){this.tasks=new Map();this.serial=0;}
  setTimeout(fn,delay){const id=++this.serial;this.tasks.set(id,{fn,delay});return id;}
  clearTimeout(id){this.tasks.delete(id);}
  fire(){const item=this.tasks.entries().next().value;if(!item)return;this.tasks.delete(item[0]);item[1].fn();}
}
function fixture(options={}) {
  const sdk={clients:[],micCalls:0,micTracks:[],setLogLevel(){},createClient(config){const c=new Client(this.clients.length===0?options.joinGate:null);c.config=config;this.clients.push(c);return c;},
    async createMicrophoneAudioTrack(){this.micCalls++;if(options.micGate)await options.micGate.promise;const t=track();this.micTracks.push(t);return t;}};
  const timers=new Timers();const logs=[];const states=[];const requests=[];
  const fetch=async(url,config)=>{
    requests.push({url,config});
    if(url.startsWith('/api/resolve')){
      if(options.resolveGate && requests.filter(r=>r.url.startsWith('/api/resolve')).length===1)await options.resolveGate.promise;
      return {ok:true,json:async()=>({errno:0,data:{channel_id:url.includes('second')?'456':'123',anchor_id:'9',title:'Test'}})};
    }
    if(url.startsWith('/api/owner/')) {
      const body=config?.body ? JSON.parse(config.body) : {};
      if(url.startsWith('/api/owner/connect'))return {ok:true,json:async()=>({errno:0,data:{rtc_token:token([1,2]),user_id:7,mode:'owner-test',eligible:true,muted:options.ownerInitiallyUnmuted ? false : true,seat_id:0,
        seat_provenance:'official-tls',reported_digest_rsa_verified:true,owner_permit:'synthetic-owner-permit',publishing_available:true}})};
      if(url.startsWith('/api/owner/status')&&options.ownerStatusGate)await options.ownerStatusGate.promise;
      if(url.startsWith('/api/owner/status')&&options.failOwnerStatus)return {ok:false,json:async()=>({errno:-1,errmsg:'房间权限已变化。'})};
      if(url.startsWith('/api/owner/mute')){
        if(body.muted===false&&options.unmuteGate)await options.unmuteGate.promise;
        if(body.muted===true&&options.remuteGate)await options.remuteGate.promise;
        options.ownerMuted=body.muted;
      }
      return {ok:true,json:async()=>({errno:0,data:{eligible:true,muted:options.ownerMuted ?? true,seat_id:0,seat_provenance:'official-tls',reported_digest_rsa_verified:true}})};
    }
    if(url.startsWith('/api/agora-token')) {
      if(options.failAccountToken)return {ok:false,json:async()=>({errno:40026,errmsg:'服务器会话已失效。'})};
      return {ok:true,json:async()=>({errno:0,data:{rtc_token:token(options.accountPrivileges || [1]),user_id:options.accountUid || 7,mode:'account-audience',publishing_available:false}})};
    }
    if(options.tokenGate)await options.tokenGate.promise;
    if(options.failTokens)throw new TypeError('fake request must not be logged');
    return {ok:true,json:async()=>({errno:0,data:{rtc_token:token(),user_id:7}})};
  };
  const c=new Controller({getSdk:async()=>sdk,fetch,timers,allowExperimentalPublish:options.allowExperimentalPublish,onChange:s=>states.push(s),onLog:s=>logs.push(s)});
  return {c,sdk,timers,logs,states,requests,options};
}

test('006 decoder returns declarations only, never credentials/signature proof',()=>{
  const parsed=tokenPrivileges(token());assert.equal(parsed.declaresPublishAudio,false);assert.equal(parsed.declaresJoin,true);assert.equal(parsed.signatureVerified,false);
  assert.equal(tokenPrivileges(token([1,2])).declaresPublishAudio,true);
  for(const raw of ['007invalid','006'+'0'.repeat(32)+'!!!!',null]) assert.equal(tokenPrivileges(raw).known,false);
  assert.ok(!JSON.stringify(parsed).includes(token()));
});
test('listen never requests a microphone or publishes, and IDs remain strings',async()=>{
  const f=fixture();await f.c.start({channel_id:'1074315896831759964',anchor_id:'9'});
  assert.equal(f.c.state,'listening');assert.equal(f.sdk.micCalls,0);assert.equal(f.sdk.clients[0].publishes,0);
  assert.equal(f.sdk.clients[0].joinArgs[1],'1074315896831759964');await f.c.stop();
});
test('volume zero remains zero both for existing and new remote tracks',async()=>{
  const f=fixture();await f.c.start({share:'first'});f.c.setVolume(0);const audio=track();
  f.sdk.clients[0].emit('user-published',{uid:1,audioTrack:audio},'audio');await settle();
  assert.equal(audio.volume,0);assert.equal(f.c.snapshot().remoteAudioCount,1);f.c.setVolume(400);assert.equal(audio.volume,400);
  f.c.setVolume(0);assert.equal(audio.volume,0);await f.c.stop();assert.equal(audio.stopCount,1);
});
test('unpublish cleanup uses stored UID even if SDK already cleared user.audioTrack',async()=>{
  const f=fixture();await f.c.start({share:'first'});const audio=track();f.sdk.clients[0].emit('user-published',{uid:1,audioTrack:audio},'audio');await settle();
  f.sdk.clients[0].emit('user-unpublished',{uid:1,audioTrack:null},'audio');assert.equal(audio.stopCount,1);assert.equal(f.c.snapshot().remoteAudioCount,0);await f.c.stop();
});
test('anonymous credentials rotate proactively, joining the new UID before retiring old playback',async()=>{
  const f=fixture();f.c.now=()=>2000000000000-300000;await f.c.start({share:'first'});
  const old=f.c.session,audio=track();old.client.emit('user-published',{uid:9,audioTrack:audio},'audio');await settle();
  assert.equal([...f.timers.tasks.values()][0].delay,240000);
  const joinGate=deferred(),create=f.sdk.createClient.bind(f.sdk);f.sdk.createClient=config=>{const c=create(config);c.joinGate=joinGate;return c;};
  f.timers.fire();f.timers.fire();await settle(()=>f.sdk.clients.length===2);
  assert.equal(old.client.leaves,0);assert.equal(audio.stopCount,0,'old audio survives while candidate connects');
  joinGate.resolve();await settle(()=>f.c.state==='listening');assert.equal(old.client.leaves,0,'wait for candidate audio, not just join');
  f.sdk.clients[1].emit('user-published',{uid:9,audioTrack:track()},'audio');await settle(()=>old.client.leaves===1);
  assert.equal(audio.stopCount,1);assert.equal(f.sdk.micCalls,0);await f.c.stop();assert.equal(f.timers.tasks.size,0);
});
test('stop during a proactive anonymous request cannot resurrect either old or candidate audio',async()=>{
  const f=fixture();await f.c.start({share:'first'});const old=f.c.session;f.options.tokenGate=deferred();
  const replacing=f.c.rejoin(old.room,old.generation);await settle(()=>f.requests.filter(r=>r.url.startsWith('/api/token?')).length===2);
  await f.c.stop();f.options.tokenGate.resolve();await replacing;
  assert.equal(f.sdk.clients.length,1);assert.equal(old.client.leaves,1);assert.equal(f.c.state,'idle');assert.equal(f.timers.tasks.size,0);
});
test('repeated expiry warnings during an anonymous credential request cannot create competing replacements',async()=>{
  const f=fixture();await f.c.start({share:'first'});const old=f.c.session;f.options.tokenGate=deferred();
  const replacing=f.c.rejoin(old.room,old.generation);await settle(()=>f.requests.filter(r=>r.url.startsWith('/api/token?')).length===2);
  old.client.emit('token-privilege-will-expire');old.client.emit('token-privilege-did-expire');
  f.options.tokenGate.resolve();await replacing;assert.equal(f.sdk.clients.length,2);
  assert.equal(f.requests.filter(r=>r.url.startsWith('/api/token?')).length,2);await f.c.stop();assert.equal(f.timers.tasks.size,0);
});
test('temporary anonymous credential failure leaves the old connection playing until retry succeeds',async()=>{
  const f=fixture();await f.c.start({share:'first'});const old=f.c.session;f.options.failTokens=true;
  f.sdk.clients[0].emit('token-privilege-will-expire');f.timers.fire();await settle(()=>f.c.retries===1);
  assert.equal(old.client.leaves,0);assert.equal(f.c.session,old);f.options.failTokens=false;
  f.timers.fire();await settle(()=>f.sdk.clients.length===2&&f.c.state==='listening');assert.equal(old.client.leaves,1);
  await f.c.stop();assert.equal(f.timers.tasks.size,0);
});
test('stop cancels expiry timer so it cannot rejoin',async()=>{
  const f=fixture();await f.c.start({share:'first'});f.sdk.clients[0].emit('token-privilege-did-expire');assert.equal(f.timers.tasks.size,1);
  await f.c.stop();assert.equal(f.timers.tasks.size,0);f.timers.fire();await settle();assert.equal(f.sdk.clients.length,1);assert.equal(f.c.running,false);
});
test('stopped pending share resolution cannot connect later',async()=>{
  const gate=deferred(),f=fixture({resolveGate:gate});const started=f.c.start({share:'first'});await settle(()=>f.requests.length>0);
  await f.c.stop();gate.resolve();await started;assert.equal(f.sdk.clients.length,0);assert.equal(f.c.state,'idle');
});
test('late pending join is withdrawn after stop, never left as a live session',async()=>{
  const gate=deferred(),f=fixture({joinGate:gate});const started=f.c.start({share:'first'});await settle(()=>f.sdk.clients.length===1);
  const stopped=f.c.stop();await settle(()=>f.sdk.clients[0].leaves>0);gate.resolve();await Promise.all([started,stopped]);
  assert.equal(f.c.session,null);assert.equal(f.c.state,'idle');assert.ok(f.sdk.clients[0].leaves>=1);
});
test('switching rooms invalidates old unresolved start and old client events',async()=>{
  const gate=deferred(),f=fixture({resolveGate:gate});const first=f.c.start({share:'first'});await settle(()=>f.requests.length>0);
  await f.c.start({share:'second'});gate.resolve();await first;assert.equal(f.sdk.clients.length,1);assert.equal(f.c.room.channel_id,'456');await f.c.stop();
});
test('failed join releases client and does not retain running state',async()=>{
  const gate=deferred(),f=fixture({joinGate:gate});const started=f.c.start({share:'first'});await settle(()=>f.sdk.clients.length===1);gate.reject(new Error('fake-token-private'));
  await started;assert.equal(f.c.running,false);assert.equal(f.c.session,null);assert.equal(f.c.state,'error');assert.ok(f.sdk.clients[0].leaves>0);assert.ok(!f.logs.join('').includes('fake-token-private'));
});
test('UID_BANNED halts instead of fetching another identity/token',async()=>{
  const f=fixture();await f.c.start({share:'first'});const count=f.requests.length;
  f.sdk.clients[0].emit('connection-state-change','DISCONNECTED','CONNECTED','UID_BANNED');await settle(()=>f.c.state==='error');
  assert.equal(f.c.running,false);assert.equal(f.timers.tasks.size,0);assert.equal(f.requests.length,count);assert.match(f.c.message,/別の身分/);
});
test('remote subscription belongs to its captured client, not a replacement',async()=>{
  const f=fixture();await f.c.start({share:'first'});const old=f.sdk.clients[0],audio=track();const subscribed=deferred();
  old.subscribe=async()=>{old.subscribes++;await subscribed.promise;};old.emit('user-published',{uid:1,audioTrack:audio},'audio');
  await f.c.start({share:'second'});subscribed.resolve();await settle();assert.equal(audio.playCount,0);assert.equal(f.sdk.clients[1].subscribes,0);await f.c.stop();
});
test('shipped controller blocks publication even with explicit consent',async()=>{
  const f=fixture();await f.c.start({share:'first'});
  assert.equal(f.c.snapshot().publishingAvailable,false);
  await assert.rejects(f.c.publishMic(true),/まだ送信できません/);
  assert.equal(f.sdk.micCalls,0);assert.equal(f.sdk.clients[0].publishes,0);await f.c.stop();
});
test('experimental lifecycle still requires explicit authorization before any mic/device call',async()=>{
  const f=fixture({allowExperimentalPublish:true});await f.c.start({share:'first'});
  for(const permission of [undefined,false,1,'true'])await assert.rejects(f.c.publishMic(permission),/ルームへ送信/);
  assert.equal(f.sdk.micCalls,0);assert.equal(f.sdk.clients[0].publishes,0);await f.c.stop();
});
test('local microphone self-check never publishes and closes physical capture',async()=>{
  const f=fixture();await f.c.checkMic();assert.equal(f.c.micState,'local-ready');assert.equal(f.sdk.clients.length,0);
  const mic=f.sdk.micTracks[0];await f.c.closeMic();assert.equal(mic.captureStops,1);assert.equal(mic.closeCount,1);assert.equal(f.c.micState,'off');
});
test('pending microphone permission cannot capture/publish after stop',async()=>{
  const gate=deferred(),f=fixture({micGate:gate});await f.c.start({share:'first'});const checking=f.c.checkMic();await settle(()=>f.sdk.micCalls===1);
  const stopped=f.c.stop();await settle(()=>f.sdk.clients[0].leaves>0);gate.resolve();await Promise.all([checking,stopped]);
  assert.equal(f.sdk.micTracks[0].closeCount,1);assert.equal(f.sdk.clients[0].publishes,0);assert.equal(f.c.micState,'off');
});
test('SDK publish acceptance is explicitly unverified, never speaking success',async()=>{
  const f=fixture({allowExperimentalPublish:true});await f.c.start({share:'first'});await f.c.publishMic(true);
  assert.equal(f.c.micState,'sdk-published-unverified');assert.equal(f.c.snapshot().transmittingVerified,false);assert.equal(f.sdk.clients[0].publishes,1);
  assert.match(f.logs.at(-1),/席や相手が聞こえるかは未検証/);await f.c.stop();assert.equal(f.sdk.clients[0].unpublishes,1);assert.equal(f.sdk.micTracks[0].closeCount,1);
});
test('expiry/reconnect withdraws capture and never auto-resumes the microphone',async()=>{
  const f=fixture({allowExperimentalPublish:true});await f.c.start({share:'first'});await f.c.publishMic(true);f.sdk.clients[0].emit('token-privilege-did-expire');
  await settle(()=>f.c.micState==='off');f.timers.fire();await settle(()=>f.sdk.clients.length===2&&f.c.state==='listening');
  assert.equal(f.sdk.micCalls,1);assert.equal(f.sdk.clients[1].publishes,0);assert.equal(f.sdk.micTracks[0].closeCount,1);await f.c.stop();
});
test('stop during pending publish ends capture immediately and withdraws late publication',async()=>{
  const f=fixture({allowExperimentalPublish:true});await f.c.start({share:'first'});const gate=deferred();f.sdk.clients[0].publishGate=gate;
  const publishing=f.c.publishMic(true);await settle(()=>f.sdk.clients[0].publishes===1);const stopped=f.c.stop();
  assert.equal(f.sdk.micTracks[0].captureStops,1);gate.resolve();await Promise.all([publishing,stopped]);assert.equal(f.sdk.clients[0].unpublishes,1);assert.equal(f.c.micState,'off');
});
test('retry budget ends after five failures, not an infinite loop',async()=>{
  const options={},f=fixture(options);await f.c.start({share:'first'});options.failTokens=true;f.sdk.clients[0].emit('token-privilege-did-expire');
  for(let i=0;i<5;i++){f.timers.fire();await settle(()=>f.timers.tasks.size>0||!f.c.running);}
  assert.equal(f.c.running,false);assert.equal(f.c.state,'error');assert.equal(f.timers.tasks.size,0);
});
test('account receive-only uses the official token endpoint and SDK live audience without mic/publication',async()=>{
  const f=fixture({allowExperimentalPublish:true});await f.c.start({channel_id:'123',anchor_id:'9',accountMode:'account'});
  assert.equal(f.c.state,'listening');assert.equal(f.c.snapshot().accountMode,'account');assert.equal(f.c.snapshot().publishingAvailable,false);
  assert.equal(f.sdk.clients[0].config.mode,'live');assert.equal(f.sdk.clients[0].role,'audience');
  assert.ok(f.requests.some(r=>r.url.startsWith('/api/agora-token')));assert.ok(!f.requests.some(r=>r.url.startsWith('/api/token?')));
  await assert.rejects(f.c.publishMic(true),/公式席が未確認/);assert.equal(f.sdk.micCalls,0);assert.equal(f.sdk.clients[0].publishes,0);await f.c.stop();
});
test('account failure never silently falls back to a different anonymous identity',async()=>{
  const f=fixture({failAccountToken:true});await f.c.start({channel_id:'123',anchor_id:'9',accountMode:'account'});
  assert.equal(f.c.state,'error');assert.equal(f.sdk.clients.length,0);assert.ok(f.requests.every(r=>!r.url.startsWith('/api/token?')));
});
test('account controller rejects publishing rights even if a backend response claims audience mode',async()=>{
  const f=fixture({accountPrivileges:[1,2]});await f.c.start({channel_id:'123',anchor_id:'9',accountMode:'account'});
  assert.equal(f.c.state,'error');assert.equal(f.sdk.clients.length,0);assert.equal(f.sdk.micCalls,0);
});
test('account token renewal stays on the original connection and never silently switches account UID',async()=>{
  const options={accountUid:7},f=fixture(options);await f.c.start({channel_id:'123',anchor_id:'9',accountMode:'account'});
  f.sdk.clients[0].emit('token-privilege-did-expire');await settle(()=>f.sdk.clients[0].renewals===1);
  assert.equal(f.sdk.clients.length,1);assert.equal(f.sdk.clients[0].role,'audience');assert.equal(f.sdk.micCalls,0);
  options.accountUid=8;f.sdk.clients[0].emit('token-privilege-did-expire');await settle(()=>!f.c.running);
  assert.equal(f.sdk.clients.length,1);assert.equal(f.c.state,'error');assert.equal(f.timers.tasks.size,0);
});
test('unknown exception text is never copied into user logs',()=>{assert.ok(!describe(new Error('private-code https://example.invalid')).includes('private-code'));});

test('owner mode requires explicit takeover confirmation before any request or device call',async()=>{
 const f=fixture();await assert.rejects(f.c.start({share:'first',accountMode:'owner'}),/ホスト引き継ぎ/);
 assert.equal(f.requests.length,0);assert.equal(f.sdk.clients.length,0);assert.equal(f.sdk.micCalls,0);
});
test('owner confirmed join uses live host, but never captures, publishes, unmutes or automatically reconnects',async()=>{
 const f=fixture();await f.c.start({share:'first',accountMode:'owner',ownerConfirmed:true});
 assert.equal(f.c.state,'listening');assert.equal(f.sdk.clients[0].role,'host');assert.equal(f.sdk.clients[0].config.mode,'live');
 assert.equal(f.sdk.micCalls,0);assert.equal(f.sdk.clients[0].publishes,0);
 assert.ok(!f.requests.some(r=>r.url==='/api/owner/mute'));assert.equal(f.c.snapshot().publishingAvailable,true);
 f.sdk.clients[0].emit('connection-state-change','RECONNECTING','CONNECTED','NETWORK');
 await settle(()=>!f.c.running&&f.c.state==='error');assert.equal(f.timers.tasks.size,0);assert.equal(f.sdk.clients.length,1);
 assert.ok(f.requests.some(r=>r.url==='/api/owner/release'));
});
test('owner send requires fresh consent and never claims independent listening success',async()=>{
 const f=fixture();await f.c.start({share:'first',accountMode:'owner',ownerConfirmed:true});
 await assert.rejects(f.c.publishMic(false),/ルームへ送信/);assert.equal(f.sdk.micCalls,0);
 await Promise.all([f.c.publishMic(true),f.c.publishMic(true)]);
 assert.equal(f.sdk.micCalls,1);assert.equal(f.sdk.clients[0].publishes,1);assert.equal(f.c.snapshot().transmittingVerified,false);
 const muteCalls=f.requests.filter(r=>r.url==='/api/owner/mute');assert.equal(muteCalls.length,1);assert.equal(JSON.parse(muteCalls[0].config.body).muted,false);
 await f.c.closeMic();assert.equal(f.sdk.micTracks[0].captureStops,1);assert.equal(f.sdk.clients[0].unpublishes,1);
 assert.equal(JSON.parse(f.requests.filter(r=>r.url==='/api/owner/mute').at(-1).config.body).muted,true);await f.c.stop();
});
test('stop during pending official unmute closes capture immediately, then remutes before releasing',async()=>{
 const gate=deferred(),f=fixture({unmuteGate:gate});await f.c.start({share:'first',accountMode:'owner',ownerConfirmed:true});
 const sent=f.c.publishMic(true);await settle(()=>f.requests.some(r=>r.url==='/api/owner/mute'));
 const stopped=f.c.stop();assert.equal(f.sdk.micTracks[0].captureStops,1);gate.resolve();await Promise.all([sent,stopped]);
 assert.equal(f.sdk.clients[0].publishes,0);assert.equal(f.c.micState,'off');
 const actions=f.requests.filter(r=>r.url.startsWith('/api/owner/')&&r.config.body).map(r=>({path:r.url,body:JSON.parse(r.config.body)}));
 assert.equal(actions.at(-2).body.muted,true);assert.equal(actions.at(-1).path,'/api/owner/release');
});
test('room/seat polling failure during owner publish closes capture and stops, no renewed host identity',async()=>{
 const options={},f=fixture(options);await f.c.start({share:'first',accountMode:'owner',ownerConfirmed:true});await f.c.publishMic(true);
 options.failOwnerStatus=true;f.timers.fire();await settle(()=>f.c.state==='error');
 assert.equal(f.sdk.micTracks[0].captureStops,1);assert.equal(f.sdk.clients.length,1);assert.equal(f.timers.tasks.size,0);
});
test('official mute detected during owner publish stops capture instead of bypassing it',async()=>{
 const options={},f=fixture(options);await f.c.start({share:'first',accountMode:'owner',ownerConfirmed:true});await f.c.publishMic(true);
 options.ownerMuted=true;f.timers.fire();await settle(()=>f.c.state==='error');assert.equal(f.sdk.micTracks[0].captureStops,1);
});
test('late owner join after stop releases permit without microphone or publication',async()=>{
 const gate=deferred(),f=fixture({joinGate:gate});const started=f.c.start({share:'first',accountMode:'owner',ownerConfirmed:true});
 await settle(()=>f.sdk.clients.length===1);const stopped=f.c.stop();gate.resolve();await Promise.all([started,stopped]);
 assert.ok(f.requests.some(r=>r.url==='/api/owner/release'));assert.equal(f.sdk.micCalls,0);assert.equal(f.timers.tasks.size,0);
});
test('revoking send while official status is pending prevents late capture and unmute',async()=>{
 const options={},f=fixture(options);await f.c.start({share:'first',accountMode:'owner',ownerConfirmed:true});
 const gate=deferred();options.ownerStatusGate=gate;const sent=f.c.publishMic(true);
 await settle(()=>f.requests.some(r=>r.url.startsWith('/api/owner/status')));
 await f.c.closeMic();gate.resolve();assert.equal(await sent,false);
 assert.equal(f.sdk.micCalls,0);assert.equal(f.sdk.clients[0].publishes,0);
 assert.ok(!f.requests.some(r=>r.url==='/api/owner/mute'));await f.c.stop();
});
test('revoking send during microphone permission closes the late track without unmuting',async()=>{
 const gate=deferred(),f=fixture({micGate:gate});await f.c.start({share:'first',accountMode:'owner',ownerConfirmed:true});
 const sent=f.c.publishMic(true);await settle(()=>f.sdk.micCalls===1);
 const closed=f.c.closeMic();gate.resolve();assert.equal(await sent,false);await closed;
 assert.equal(f.sdk.micTracks[0].closeCount,1);assert.equal(f.sdk.clients[0].publishes,0);
 assert.ok(!f.requests.some(r=>r.url==='/api/owner/mute'));await f.c.stop();
});
test('repeat close and a new self-check wait for official remute cleanup',async()=>{
 const options={},f=fixture(options);await f.c.start({share:'first',accountMode:'owner',ownerConfirmed:true});await f.c.publishMic(true);
 const gate=deferred();options.remuteGate=gate;
 const first=f.c.closeMic(),second=f.c.closeMic();let secondDone=false;void second.then(()=>{secondDone=true;});
 const checking=f.c.checkMic();await settle(()=>f.requests.filter(r=>r.url==='/api/owner/mute').length===2);
 assert.equal(secondDone,false);assert.equal(f.sdk.micCalls,1);assert.equal(f.sdk.micTracks[0].captureStops,1);
 gate.resolve();await Promise.all([first,second,checking]);assert.equal(f.sdk.micCalls,2);
 assert.equal(f.c.micState,'local-ready');assert.equal(f.sdk.clients[0].publishes,1);await f.c.stop();
});
test('owner start refuses a non-muted seat even if backend claims publishing is available',async()=>{
 const f=fixture({ownerInitiallyUnmuted:true});await f.c.start({share:'first',accountMode:'owner',ownerConfirmed:true});
 assert.equal(f.c.state,'error');assert.equal(f.sdk.clients.length,0);assert.equal(f.sdk.micCalls,0);
 assert.ok(f.requests.some(r=>r.url==='/api/owner/release'));
});
test('replay skips locally muted speakers and resumes the rest',async()=>{
  const f=fixture();await f.c.start({share:'first'});const audio=track(),other=track();
  f.sdk.clients[0].emit('user-published',{uid:1,audioTrack:audio},'audio');
  f.sdk.clients[0].emit('user-published',{uid:2,audioTrack:other},'audio');await settle();
  assert.equal(audio.playCount,1);assert.equal(other.playCount,1);
  f.c.session.listenerMuted=new Set([1]);f.c.replay();
  assert.equal(audio.playCount,1);assert.equal(audio.stopCount,1);assert.equal(other.playCount,2);
  f.c.session.listenerMuted.delete(1);f.c.replay();
  assert.equal(audio.playCount,2);assert.equal(other.playCount,3);
  await f.c.stop();
});
test('per-person volume scales only that track and survives re-subscribe',async()=>{
  const f=fixture();await f.c.start({share:'first'});const audio=track();
  f.sdk.clients[0].emit('user-published',{uid:1,audioTrack:audio},'audio');await settle();
  assert.equal(audio.volume,150);
  f.c.setUserVolume(1,50);assert.equal(audio.volume,75);assert.equal(f.c.userVolume(1),50);
  f.c.setUserVolume(1,500);assert.equal(f.c.userVolume(1),200);assert.equal(audio.volume,300);
  f.c.setUserVolume(2,0);
  const second=track();f.sdk.clients[0].emit('user-published',{uid:2,audioTrack:second},'audio');await settle();
  assert.equal(second.volume,0);assert.equal(audio.volume,300);
  await f.c.stop();
});
test('auto balance lifts quiet speakers and lowers loud ones, never silence',async()=>{
  const f=fixture();await f.c.start({share:'first'});
  const quiet=track(),loud=track();quiet.getVolumeLevel=()=>0.1;loud.getVolumeLevel=()=>0.9;
  f.sdk.clients[0].emit('user-published',{uid:1,audioTrack:quiet},'audio');
  f.sdk.clients[0].emit('user-published',{uid:2,audioTrack:loud},'audio');await settle();
  assert.equal(f.c.balanceVolumes(),true);
  assert.ok(quiet.volume>150);assert.ok(loud.volume<150);
  f.c.setAutoBalance(false);assert.equal(quiet.volume,150);assert.equal(loud.volume,150);
  assert.equal(f.c.balanceVolumes(),false);
  await f.c.stop();
});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createMemberService,publicPerson}=require('../gravity-member.cjs');
const {makeHandler}=require('../serve.cjs');
const {rtcUid,crc32}=require('../gravity-owner.cjs');
const {APP_ID}=require('../static/controller.js');
const user='123456',uid=rtcUid(user),now=1900000000000;
class Timers{constructor(){this.tasks=new Map();this.n=0;}setTimeout(fn){const n=++this.n;this.tasks.set(n,fn);return n;}clearTimeout(n){this.tasks.delete(n);}fire(){const item=this.tasks.entries().next().value;if(item){this.tasks.delete(item[0]);item[1]();}}}
function token(channel,ids=[1],expiry=2000000000){const m=Buffer.alloc(10+ids.length*6);m.writeUInt16LE(ids.length,8);ids.forEach((n,i)=>{m.writeUInt16LE(n,10+i*6);m.writeUInt32LE(expiry,12+i*6);});const b=Buffer.alloc(44+m.length);b.writeUInt16LE(32);b.writeUInt32LE(crc32(channel),34);b.writeUInt32LE(crc32(uid),38);b.writeUInt16LE(m.length,42);m.copy(b,44);return '006'+APP_ID+b.toString('base64');}
async function settle(fn){for(let i=0;i<40;i++){await new Promise(r=>setImmediate(r));if(fn())return;}throw Error('did not settle');}
const COUNTRIES={[user]:'JP','999':'TW'};
function fixture(options={}){let who={user,identity:'test-identity'},presenceUntil=0;const timers=new Timers(),reads=[],writes=[],rooms=new Map(),lookups=[],observed=[];
 const get=channel=>{if(!rooms.has(channel))rooms.set(channel,{anchor:'999',auto:1,seated:false,muted:1,seat:3});return rooms.get(channel);};
 const previewData=()=>({name:'Room',room_type:0,user_count:2,user_id:'999',group_user_list:[{user_id:555,name:'Guest',portrait:'https://cdn.gravity.place/g.png?x=1'}]});
 const service=createMemberService({identity:()=>who,device:()=>({app_version:'14.2'}),now:()=>options.now||now,timers,verify:()=>({reportedDigestVerified:!options.badSeats,payloadMatches:false}),
  // roomMemberList rows carry no country; the resolver (userListInfo in production) supplies it.
  people:{lookup:async ids=>{lookups.push([...ids]);return id=>(options.countries||COUNTRIES)[id]||'';}},onPeople:rows=>observed.push(...rows),blocked:()=>options.blockedIds||[],
  previewRead:async(extra,request,authority)=>{reads.push({kind:'roomPreview',extra,authority});return {errno:options.previewErrno??0,data:options.previewData??previewData()};},
  listedFollowRooms:async request=>{reads.push({kind:'followRooms'});if(options.followErrno)return {errno:options.followErrno};return {errno:0,data:{list:options.followList??[]}};},
  read:async(kind,extra,request,authority)=>{reads.push({kind,extra,authority});if(options.onRead)await options.onRead(kind,extra,authority);const r=get(extra.channel_id);
   if(kind==='roomInfo'){const empty=options.emptyInfo||options.emptyInfoOnce;if(options.emptyInfoOnce)options.emptyInfoOnce=false;
    return {errno:options.roomErrno??(options.closed?40202:0),data:{room_info:empty?{channel_id:'',user_id:0}:options.roomData??{channel_id:extra.channel_id,user_id:r.anchor,auto_pass:r.auto,name:r.name||'Room',room_type:options.roomType??0,notice:typeof r.notice==='string'?{notice:r.notice}:r.notice,tags:r.tags||''}}};}
   if(kind==='seats'){if(options.seatsErrno)return {errno:options.seatsErrno};if(options.seatRows)return {errno:0,data:{anchor_user_list:options.seatRows}};
    return {errno:0,data:{anchor_user_list:r.seated?[{seat_id:r.seat,mute_type:r.muted,user:{user_id:user}}]:[]}};}
   if(kind==='memberToken')return {errno:options.tokenError||0,data:{uid:options.badUid?1:uid,rtc_token:token(options.tokenChannel||extra.channel_id,extra.role_type==='1'?[1,2]:[1],options.expiry??2000000000),
    rtm_token:options.badRtm?'006'+APP_ID+'invalid':token('',[1000],options.expiry??2000000000)}};
   if(kind==='memberCount')return options.countError?{errno:40026,data:{}}:options.emptyRoom?{errno:1,data:{}}:{errno:0,data:{members:2}};
   if(kind==='managers')return {errno:0,data:{list:options.managers||[{user_id:'888'}]}};
   if(kind==='members'&&options.memberPages){const page=options.memberPages[extra.last_id?Number(extra.last_id):0]||[];return {errno:0,data:{list:page,last_id:page.length&&options.memberPages[Number(extra.last_id||0)+1]!==undefined?String(Number(extra.last_id||0)+1):'0'}};}
   if(kind==='members'){const rows=[{user_id:user,name:'You',portrait:'https://cdn.gravity.place/you.png?secret=removed',token:'PRIVATE',ext:{relation:3}},{user_id:'999',name:'Host',portrait:'https://evil.invalid/a',profile:'PRIVATE',ext:{relation:2}}];
    if(options.presenceTtlMs&&(options.now||now)>=presenceUntil)rows.shift();
    return {errno:0,data:{list:options.nullMembers?null:rows,last_id:options.cursor||0}};}
   throw Error('unexpected read');},
  write:async(kind,extra,request,authority)=>{writes.push({kind,extra});if(options.onWrite)await options.onWrite(kind,extra,authority);if(options.failWrite)return {errno:-4};const r=get(extra.channel_id);
   if(kind==='memberPresence'){
    if(extra.pkg_type==='AudioLive_Enter'&&options.enterFails){options.enterFails--;return {errno:options.enterErrno??409};}
    if(extra.pkg_type==='AudioLive_HeartBeat'&&options.failPresence)return {errno:options.failPresence};
    presenceUntil=extra.pkg_type==='AudioLive_Quit'?0:(options.now||now)+(options.presenceTtlMs||120000);
    return {errno:0,data:options.heartResponse??{interval:60}};}
   if(kind==='applySeat'){r.seated=true;r.muted=Number(extra.mute_type);}
   if(kind==='memberMute'){r.muted=Number(extra.mute_type);
    if(options.seatRows){const row=options.seatRows.find(x=>x.seat_id===Number(extra.seat_id));if(row)row.mute_type=Number(extra.mute_type);}}
   if(kind==='leaveSeat')r.seated=false;
   return {errno:0};},
  writeCreate:async extra=>{writes.push({kind:'createRoom',extra});if(options.failCreate)throw Error('timeout');return {errno:options.createErrno||0,data:options.createData??{channel_id:'555'}};},
  writeUpdate:async extra=>{writes.push({kind:'updateRoom',extra});const r=get(extra.channel_id);
   if(extra.notice!==undefined)r.notice=extra.notice;if(extra.auto_pass!==undefined)r.auto=extra.auto_pass==='1'?1:0;if(extra.tags!==undefined)r.tags=extra.tags;return {errno:0};},
  writeGroup:async extra=>{writes.push({kind:'groupEnter',extra});if(options.failGroup)throw Error('timeout');return {errno:0,data:{}};},
  writeDestroy:async extra=>{writes.push({kind:'destroyRoom',extra});if(options.failDestroy)throw Error('timeout');return {errno:options.destroyErrno||0,data:{chat_time:1}};},
  writeBox:async extra=>{writes.push({kind:'luckyBox',extra});if(options.failBox)throw Error('timeout');return {errno:0,data:1};}});
 return {service,options,reads,writes,timers,get,lookups,observed,setIdentity:value=>{who=value;},request:()=>{throw Error('no real network');}};
}
test('internal reward context requires confirmed entry, trusted host, a live lease and matching identity',async()=>{
 for(const action of ['expire','release','force','account']){
  const f=fixture();assert.equal(f.service.rewardContext(),null);
  const g=await f.service.connect('123',f.request);assert.equal(f.service.rewardContext(),null);
  await f.service.enter('123',f.request,g.member_permit);
  const r=f.service.rewardContext();assert.equal(r.channel_id,'123');assert.equal(r.anchor_id,'999');assert.equal(r.identity,'test-identity');assert.equal('proof' in r,false);
  if(action==='expire')f.options.now=now+90001;
  if(action==='release')await f.service.release('123',f.request,g.member_permit);
  if(action==='force')f.service.forceRelease('123',f.request);
  if(action==='account')f.setIdentity({user,identity:'other-login'});
  assert.equal(f.service.rewardContext(),null,action);
 }
});
test('permit-bound renewal returns fresh RTC/RTM without entering again, mutating seats or extending lease',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);f.options.now=now+60000;
 const renewed=await f.service.renew('123',f.request,g.member_permit);assert.equal(renewed.user_id,uid);assert.ok(renewed.rtc_token);assert.ok(renewed.rtm_token);
 assert.equal(f.reads.filter(r=>r.kind==='memberToken').at(-1).extra.role_type,'0');assert.deepEqual(f.reads.at(-1).authority,{expectedIdentity:'test-identity'});
 assert.deepEqual(f.writes.map(w=>w.extra.pkg_type),['AudioLive_Enter']);assert.equal('member_permit' in renewed,false);
 f.options.now=now+90001;await assert.rejects(f.service.renew('123',f.request,g.member_permit),/授权已失效/);await f.service.release('123',f.request,g.member_permit);
});
test('renewal publisher role requires official seat and this permit explicit unmute, not an App seat alone',async()=>{
 const f=fixture();f.get('123').seated=true;f.get('123').muted=0;const g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 await f.service.renew('123',f.request,g.member_permit);assert.equal(f.reads.at(-1).extra.role_type,'0');
 await f.service.mute('123',false,f.request,g.member_permit);await f.service.renew('123',f.request,g.member_permit);assert.equal(f.reads.at(-1).extra.role_type,'1');
 f.get('123').muted=1;await f.service.renew('123',f.request,g.member_permit);assert.equal(f.reads.at(-1).extra.role_type,'0');
 f.get('123').seated=false;await f.service.renew('123',f.request,g.member_permit);assert.equal(f.reads.at(-1).extra.role_type,'0');await f.service.release('123',f.request,g.member_permit);
});
test('unentered, wrong-room, expired, released or changed-account grants cannot refresh credentials',async()=>{
 for(const action of ['unentered','wrong-room','expire','release','account']){const f=fixture(),g=await f.service.connect('123',f.request);
  if(action!=='unentered')await f.service.enter('123',f.request,g.member_permit);
  if(action==='expire')f.options.now=now+100000;if(action==='release')await f.service.release('123',f.request,g.member_permit);
  if(action==='account')f.setIdentity({user,identity:'other'});const count=f.reads.filter(r=>r.kind==='memberToken').length;
  await assert.rejects(f.service.renew(action==='wrong-room'?'456':'123',f.request,g.member_permit));assert.equal(f.reads.filter(r=>r.kind==='memberToken').length,count);}
});
test('renewal rejects invalid, expired, wrong-room and changed-UID credentials without side effects',async()=>{
 for(const options of [{badUid:true},{tokenChannel:'456'},{expiry:1900000010},{badRtm:true},{tokenError:40026}]){const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
  Object.assign(f.options,options);await assert.rejects(f.service.renew('123',f.request,g.member_permit),/续期未确认/);assert.deepEqual(f.writes.map(w=>w.extra.pkg_type),['AudioLive_Enter']);}
});
test('identity change while renewal token read is queued cannot deliver new-account credentials',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 f.options.onRead=(kind,extra,authority)=>{if(kind==='memberToken'){assert.equal(authority.expectedIdentity,'test-identity');f.setIdentity({user,identity:'other'});}};
 await assert.rejects(f.service.renew('123',f.request,g.member_permit),/授权已失效/);assert.deepEqual(f.writes.map(w=>w.extra.pkg_type),['AudioLive_Enter']);
});
test('renew endpoint requires origin/action/permit, rejects client role escalation, and needs no new entry confirmation',async t=>{
 const f=fixture(),{post}=await app(t,f),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 const body={channel_id:'123',member_permit:g.member_permit};
 assert.equal((await post('renew',body,{Origin:'https://evil.invalid'})).status,403);
 assert.equal((await post('renew',body,{'X-Gravity-Action':'owner-control'})).status,403);
 assert.equal((await post('renew',{...body,role_type:1})).status,400);
 assert.equal((await post('renew',{channel_id:'123'})).status,403);
 const response=await post('renew',body);assert.equal(response.status,200);const data=(await response.json()).data;
 assert.equal(data.user_id,uid);assert.ok(data.rtm_token);assert.deepEqual(f.writes.map(w=>w.extra.pkg_type),['AudioLive_Enter']);await f.service.release('123',f.request,g.member_permit);
});
test('normal account status accepts different rooms with no permanent room/owner whitelist',async()=>{
 const f=fixture();for(const channel of ['123','456']){const state=await f.service.status(channel,f.request);assert.equal(state.seated,false);assert.equal(state.is_owner,false);}
 assert.equal(f.writes.length,0);assert.ok(!f.reads.some(x=>x.kind==='memberToken'||x.kind==='userOrigin'));assert.ok(!JSON.stringify(await f.service.status('123',f.request)).includes(user));
});
test('normal join grants audience RTC + RTM, not publisher rights and not a seat',async()=>{
 const f=fixture(),grant=await f.service.connect('123',f.request);assert.equal(grant.mode,'account-member');assert.equal(grant.publishing_available,false);
 assert.ok(grant.rtm_token);assert.equal(f.writes.length,0);assert.equal(f.reads.find(x=>x.kind==='memberToken').extra.role_type,'0');
 assert.equal(grant.moderator_rtc_uids.length,2);await f.service.release('123',f.request,grant.member_permit);
 const second=await f.service.connect('456',f.request);assert.notEqual(second.member_permit,grant.member_permit);await f.service.release('456',f.request,second.member_permit);
});
test('no official own seat means publisher/unmute fail before any token/write request',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request),reads=f.reads.filter(x=>x.kind==='memberToken').length;
 await assert.rejects(f.service.publisher('123',f.request,g.member_permit),/尚未获批/);await assert.rejects(f.service.mute('123',false,f.request,g.member_permit),/尚未获批/);
 assert.equal(f.reads.filter(x=>x.kind==='memberToken').length,reads);assert.equal(f.writes.length,0);await f.service.release('123',f.request,g.member_permit);
});
test('application is muted, targets the current room and dynamically derives own nonzero seat',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);const seat=await f.service.apply('123',f.request,g.member_permit);
 assert.equal(seat.seat_id,3);assert.equal(seat.muted,true);assert.deepEqual(f.writes[0],{kind:'applySeat',extra:{channel_id:'123',mute_type:'1'}});
 const publisher=await f.service.publisher('123',f.request,g.member_permit);assert.equal(publisher.user_id,uid);assert.equal(publisher.publishing_available,true);assert.ok(!('rtm_token' in publisher));
 await f.service.mute('123',false,f.request,g.member_permit);assert.equal(f.writes.at(-1).extra.seat_id,'3');
 await f.service.leave('123',f.request,g.member_permit);assert.equal(f.get('123').seated,false);await f.service.release('123',f.request,g.member_permit);
});
test('stop restores mute and removes only a seat acquired by this webpage',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.apply('123',f.request,g.member_permit);await f.service.mute('123',false,f.request,g.member_permit);
 await f.service.release('123',f.request,g.member_permit);assert.deepEqual(f.writes.map(x=>x.kind),['applySeat','memberMute','memberMute','leaveSeat']);assert.equal(f.get('123').seated,false);
});
test('joining an existing owner/guest seat does not remove that pre-existing seat on stop',async()=>{
 const f=fixture();f.get('123').seated=true;f.get('123').anchor=user;f.get('123').seat=0;
 const g=await f.service.connect('123',f.request);await f.service.mute('123',false,f.request,g.member_permit);await f.service.release('123',f.request,g.member_permit);
 assert.equal(f.get('123').seated,true);assert.equal(f.get('123').muted,1);assert.ok(f.writes.every(x=>x.kind!=='leaveSeat'));
});
test('wrong-room, expired and changed-account permits cannot operate on seats',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);
 await assert.rejects(f.service.apply('456',f.request,g.member_permit),/授权已失效/);
 f.options.now=now+100000;await assert.rejects(f.service.apply('123',f.request,g.member_permit),/授权已失效/);
 f.setIdentity({user,identity:'new-login'});await assert.rejects(f.service.mute('123',false,f.request,g.member_permit),/授权已失效/);assert.equal(f.writes.length,0);
});
test('a newly synchronized login can reconnect without using new credentials to mutate the old room',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.apply('123',f.request,g.member_permit);await f.service.mute('123',false,f.request,g.member_permit);
 const writes=f.writes.length;f.setIdentity({user,identity:'new-login'});const fresh=await f.service.connect('456',f.request);
 assert.equal(f.writes.length,writes);await assert.rejects(f.service.publisher('123',f.request,g.member_permit),/授权已失效/);
 await f.service.release('456',f.request,fresh.member_permit);
});
test('closed rooms, bad seat signatures and mismatched UIDs reject normal membership',async()=>{
 for(const opts of [{closed:true},{badSeats:true},{badUid:true}]){const f=fixture(opts);await assert.rejects(f.service.connect('123',f.request));assert.equal(f.writes.length,0);assert.equal(f.service.busy(),false);}
});
test('failed normal-member release preserves cleanup, revokes publication, then watchdog retries',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.apply('123',f.request,g.member_permit);await f.service.mute('123',false,f.request,g.member_permit);
 f.options.failWrite=true;await assert.rejects(f.service.release('123',f.request,g.member_permit));assert.equal(f.service.busy(),true);
 await assert.rejects(f.service.publisher('123',f.request,g.member_permit),/授权已失效/);f.options.failWrite=false;f.timers.fire();await settle(()=>!f.service.busy());assert.equal(f.get('123').seated,false);
});
test('native HTTP membership enters directly (no pre-Quit that could land after it), and skips a second enter',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);
 assert.deepEqual(await f.service.enter('123',f.request,g.member_permit),{entered:true});
 assert.deepEqual(f.writes.map(w=>w.extra.pkg_type),['AudioLive_Enter']);
 const enter=f.writes.at(-1);assert.equal(enter.kind,'memberPresence');
 assert.deepEqual(JSON.parse(enter.extra.pkg_data),{channel_id:'123',anchor_id:999,user_id:123456,seat_id:-1,person_num:2,app_version:'14.2',device:'ios'});
 assert.equal(f.writes.length,1);
 await f.service.enter('123',f.request,g.member_permit);assert.equal(f.writes.length,1);
 await f.service.release('123',f.request,g.member_permit);assert.equal(f.writes.at(-1).extra.pkg_type,'AudioLive_Quit');assert.equal(f.service.busy(),false);
});
test('a refused first Enter (leftover occupancy) is kicked with Quit, retried once, and reports the official errno',async()=>{
 const f=fixture({enterFails:1,enterErrno:409}),g=await f.service.connect('123',f.request);
 assert.deepEqual(await f.service.enter('123',f.request,g.member_permit),{entered:true});
 assert.deepEqual(f.writes.map(w=>w.extra.pkg_type),['AudioLive_Enter','AudioLive_Quit','AudioLive_Enter']);
 const again=fixture({enterFails:2,enterErrno:409}),grant=await again.service.connect('123',again.request);
 await assert.rejects(again.service.enter('123',again.request,grant.member_permit),/未成功（409）/);
 assert.equal(again.writes.filter(w=>w.extra.pkg_type==='AudioLive_Enter').length,2);
});
test('member country keeps ISO codes and drops install attribution such as organic',()=>{
 const who={user:'1'};
 assert.equal(publicPerson({user_id:'2',name:'A',user_country:'tw'},who).country,'TW');
 assert.equal(publicPerson({user_id:'2',name:'A',user_country:'organic'},who).country,'');
 assert.equal(publicPerson({user_id:'2',name:'A',ext:{user_country:'CN'}},who).country,'CN');
 assert.equal(publicPerson({user_id:'2',name:'A'},who).country,'');
});
test('official presence heartbeat prevents disappearance through ten simulated minutes of normal status polling',async()=>{
 const f=fixture({presenceTtlMs:120000}),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 for(let elapsed=5000;elapsed<=600000;elapsed+=5000){f.options.now=now+elapsed;await f.service.status('123',f.request,g.member_permit);
  if(elapsed%60000===0){const board=await f.service.board('123',f.request,g.member_permit);assert.ok(board.members.some(p=>p.is_self),'official roster must retain self at '+elapsed);}}
 assert.equal(f.writes.filter(w=>w.extra.pkg_type==='AudioLive_HeartBeat').length,10);
 assert.equal(f.writes.filter(w=>w.extra.pkg_type==='AudioLive_Enter').length,1,'heartbeats never repeat entry');await f.service.release('123',f.request,g.member_permit);
 assert.equal(f.writes.at(-1).extra.pkg_type,'AudioLive_Quit');
});
test('server heartbeat interval, updated seat and member count shape follow native LCS, with expected account binding',async()=>{
 let authority;const f=fixture({heartResponse:JSON.stringify({interval:15}),onWrite:(kind,extra,options)=>{if(extra.pkg_type==='AudioLive_HeartBeat')authority=options;}}),g=await f.service.connect('123',f.request);
 await f.service.enter('123',f.request,g.member_permit);f.options.now=now+14999;await f.service.status('123',f.request,g.member_permit);assert.equal(f.writes.filter(w=>w.extra.pkg_type==='AudioLive_HeartBeat').length,0);
 f.get('123').seated=true;f.get('123').seat=4;f.options.now=now+15000;await f.service.status('123',f.request,g.member_permit);
 const beat=f.writes.at(-1);assert.equal(beat.extra.pkg_type,'AudioLive_HeartBeat');assert.equal(beat.extra.version,'1');
 assert.deepEqual(JSON.parse(beat.extra.pkg_data),{channel_id:'123',anchor_id:999,user_id:123456,seat_id:4,person_num:2,app_version:'14.2',device:'ios'});
 assert.deepEqual(authority,{expectedIdentity:'test-identity'});f.options.heartResponse={interval:30};f.options.now=now+30000;await f.service.status('123',f.request,g.member_permit);
 f.options.now=now+59999;await f.service.status('123',f.request,g.member_permit);assert.equal(f.writes.filter(w=>w.extra.pkg_type==='AudioLive_HeartBeat').length,2);
 f.options.now=now+60000;await f.service.status('123',f.request,g.member_permit);assert.equal(f.writes.filter(w=>w.extra.pkg_type==='AudioLive_HeartBeat').length,3);
 await f.service.release('123',f.request,g.member_permit);
});
test('a plain status read, preview connection or failed/unconfirmed entry cannot create heartbeats',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);f.options.now=now+60000;
 await f.service.status('123',f.request);await f.service.status('123',f.request,g.member_permit);assert.equal(f.writes.length,0);
 f.options.failWrite=true;await assert.rejects(f.service.enter('123',f.request,g.member_permit));f.options.failWrite=false;
 f.options.now=now+120000;await f.service.status('123',f.request,g.member_permit);assert.ok(!f.writes.some(w=>w.extra.pkg_type==='AudioLive_HeartBeat'));
 await f.service.release('123',f.request,g.member_permit);
});
test('expired, released or changed-account permits cannot keep old official presence alive',async()=>{
 for(const action of ['expire','release','account']){const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
  if(action==='release')await f.service.release('123',f.request,g.member_permit);
  else if(action==='account')f.setIdentity({user,identity:'other'});
  f.options.now=now+(action==='expire'?100000:60000);await assert.rejects(f.service.status('123',f.request,g.member_permit),/授权已失效/);
  assert.ok(!f.writes.some(w=>w.extra.pkg_type==='AudioLive_HeartBeat'));}
});
test('unconfirmed heartbeat degrades status instead of falsely reporting presence or sending another entry',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);f.options.now=now+60000;f.options.failWrite=true;
 const degraded=await f.service.status('123',f.request,g.member_permit);
 assert.equal(degraded.presence,'degraded');assert.equal(f.writes.filter(w=>w.extra.pkg_type==='AudioLive_Enter').length,1);
 f.options.failWrite=false;await f.service.release('123',f.request,g.member_permit);assert.equal(f.writes.at(-1).extra.pkg_type,'AudioLive_Quit');
});
test('a room closing after registered entry does not block normal membership cleanup',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 f.options.closed=true;await f.service.release('123',f.request,g.member_permit);
 assert.equal(f.service.busy(),false);assert.equal(f.writes.at(-1).extra.pkg_type,'AudioLive_Quit');
});
test('failed membership cleanup keeps the official quit obligation for watchdog retry',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 f.options.failWrite=true;await assert.rejects(f.service.release('123',f.request,g.member_permit));
 assert.equal(f.service.busy(),true);f.options.failWrite=false;f.timers.fire();await settle(()=>!f.service.busy());
 assert.equal(f.writes.at(-1).extra.pkg_type,'AudioLive_Quit');
});
test('room board projects official member/seat lists and requires a room-bound permit',async()=>{
 const f=fixture();f.get('123').seated=true;const g=await f.service.connect('123',f.request);
 const board=await f.service.board('123',f.request,g.member_permit);
 assert.equal(board.members.length,2);assert.equal(board.self_profile.name,'You');assert.equal(board.self_profile.portrait,'https://cdn.gravity.place/you.png');
 assert.equal(board.members[1].portrait,'');assert.equal(board.members[1].country,'TW');assert.equal(board.seats[0].seat_id,3);assert.equal(board.seats[0].person.is_self,true);
 assert.equal(board.self_profile.country,'JP');assert.ok(!f.reads.some(x=>x.kind==='userOrigin'));
 assert.ok(!JSON.stringify(board).includes('PRIVATE'));assert.equal(f.writes.length,0);
 await assert.rejects(f.service.board('456',f.request,g.member_permit),/授权已失效/);
 await assert.rejects(f.service.board('123',f.request,null),/授权已失效/);
 await assert.rejects(f.service.board('123',f.request,g.member_permit,'bad'),/游标无效/);
 await f.service.release('123',f.request,g.member_permit);
});
test('the roster is read as several pages in one board call; a short page ends it without an extra empty request',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);
 const board=await f.service.board('123',f.request,g.member_permit);assert.equal(board.members.length,2);assert.equal(board.next_cursor,'');
 assert.equal(f.reads.filter(r=>r.kind==='members').length,1);
 const row=n=>({user_id:String(1000+n),name:'P'+n,ext:{relation:0}});
 f.options.memberPages=[Array.from({length:10},(_,i)=>row(i)),Array.from({length:10},(_,i)=>row(10+i)),Array.from({length:4},(_,i)=>row(20+i))];
 const all=await f.service.board('123',f.request,g.member_permit);assert.equal(all.members.length,24);assert.equal(all.next_cursor,'');
 assert.deepEqual(f.reads.filter(r=>r.kind==='members').slice(-3).map(r=>r.extra.last_id),[undefined,'1','2']);
 f.options.memberPages=Array.from({length:8},(_,p)=>Array.from({length:10},(_,i)=>row(p*10+i)));
 const capped=await f.service.board('123',f.request,g.member_permit);assert.equal(capped.members.length,50);assert.equal(capped.next_cursor,'5');
 f.options.memberPages=undefined;f.options.nullMembers=true;assert.deepEqual((await f.service.board('123',f.request,g.member_permit)).members,[]);
 await f.service.release('123',f.request,g.member_permit);
});
test('off-mic members get their country from the resolver, and relation bits go to the aligner',async()=>{
 const f=fixture();f.get('123').seated=true;const g=await f.service.connect('123',f.request);
 const board=await f.service.board('123',f.request,g.member_permit);
 assert.equal(board.members.find(p=>p.user_id==='999').country,'TW');assert.equal(board.self_profile.country,'JP');
 assert.deepEqual(f.lookups.at(-1).sort(),['123456','999'].sort());
 assert.ok(f.observed.some(r=>r.user_id==='999'&&r.relation===2));assert.ok(f.observed.every(r=>r.name===undefined||typeof r.name==='string'));
 f.options.countries={};const none=await f.service.board('123',f.request,g.member_permit);assert.equal(none.members[1].country,'');
 await f.service.release('123',f.request,g.member_permit);
});
test('status refreshes the moderator list at most once a minute so newly appointed admins can invite',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 assert.deepEqual(g.moderator_rtc_uids.sort(),[rtcUid('999'),rtcUid('888')].sort());
 f.options.managers=[{user_id:'888'},{user_id:'777'}];
 let state=await f.service.status('123',f.request,g.member_permit);assert.equal(state.moderator_rtc_uids.includes(rtcUid('777')),false);
 f.options.now=now+61000;state=await f.service.status('123',f.request,g.member_permit);assert.equal(state.moderator_rtc_uids.includes(rtcUid('777')),true);
 const reads=f.reads.filter(r=>r.kind==='managers').length;f.options.now=now+62000;await f.service.status('123',f.request,g.member_permit);assert.equal(f.reads.filter(r=>r.kind==='managers').length,reads);
 assert.equal('moderator_rtc_uids' in await f.service.status('123',f.request),false);
 await f.service.release('123',f.request,g.member_permit);
});
test('people we block are flagged in the roster, and their RTC uids come with connect and every status poll',async()=>{
 const f=fixture({blockedIds:['777','not-an-id']}),g=await f.service.connect('123',f.request);
 assert.deepEqual(g.blocked_rtc_uids,[rtcUid('777')]);
 f.options.memberPages=[[{user_id:'777',name:'Loud',ext:{relation:4}},{user_id:'778',name:'Fine',ext:{relation:3}},{user_id:'779',name:'Both',ext:{relation:12}},{user_id:'780',name:'Plain'}]];
 f.get('123').seated=true;
 const board=await f.service.board('123',f.request,g.member_permit);
 assert.deepEqual(board.members.map(p=>[p.user_id,p.blocked]),[['777',true],['778',false],['779',true],['780',false]]);
 await f.service.enter('123',f.request,g.member_permit);
 assert.deepEqual((await f.service.status('123',f.request,g.member_permit)).blocked_rtc_uids,[rtcUid('777')]);
 f.options.blockedIds=['777','779'];assert.deepEqual((await f.service.status('123',f.request,g.member_permit)).blocked_rtc_uids,[rtcUid('777'),rtcUid('779')]);
 assert.equal('blocked_rtc_uids' in await f.service.status('123',f.request),false);
 await f.service.release('123',f.request,g.member_permit);
});
test('a room nobody has joined yet (errno 1, empty data) counts as zero people, so entering and heartbeats work',async()=>{
 const f=fixture({emptyRoom:true}),g=await f.service.connect('123',f.request);
 assert.deepEqual(await f.service.enter('123',f.request,g.member_permit),{entered:true});
 assert.equal(JSON.parse(f.writes.at(-1).extra.pkg_data).person_num,0);
 f.options.now=now+61000;await f.service.status('123',f.request,g.member_permit);assert.equal(f.writes.at(-1).extra.pkg_type,'AudioLive_HeartBeat');
 await f.service.release('123',f.request,g.member_permit);
});
test('any other failure of the people count (an expired session, say) still stops entry',async()=>{
 const f=fixture({countError:true}),g=await f.service.connect('123',f.request);
 await assert.rejects(f.service.enter('123',f.request,g.member_permit),/房间成员人数未确认/);assert.ok(!f.writes.some(w=>w.extra?.pkg_type==='AudioLive_Enter'));
 await f.service.release('123',f.request,g.member_permit);
});
test('room_type comes with the state; group-call rooms register their own enter once, and a failing one never blocks entry',async()=>{
 const group=fixture({roomType:2}),g=await group.service.connect('123',group.request);assert.equal(g.room_type,2);
 await group.service.enter('123',group.request,g.member_permit);await group.service.enter('123',group.request,g.member_permit);
 assert.deepEqual(group.writes.filter(w=>w.kind==='groupEnter').map(w=>w.extra),[{channel_id:'123'}]);
 const flaky=fixture({roomType:2,failGroup:true}),h=await flaky.service.connect('123',flaky.request);
 assert.deepEqual(await flaky.service.enter('123',flaky.request,h.member_permit),{entered:true});
 const plain=fixture(),p=await plain.service.connect('123',plain.request);assert.equal(p.room_type,0);await plain.service.enter('123',plain.request,p.member_permit);
 assert.ok(!plain.writes.some(w=>w.kind==='groupEnter'));
 for(const [x,permit] of [[group,g],[flaky,h],[plain,p]])await x.service.release('123',x.request,permit.member_permit);
});
test('a refused seat request reports the official errno',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);
 f.options.failWrite=true;await assert.rejects(f.service.apply('123',f.request,g.member_permit),/errno -4/);f.options.failWrite=false;
 await f.service.release('123',f.request,g.member_permit);
});
test('only the host can end a room; ending it asks the official side once and releases the permit',async()=>{
 const guest=fixture(),g=await guest.service.connect('123',guest.request);
 await assert.rejects(guest.service.destroy('123',guest.request,g.member_permit),e=>e.status===403);assert.ok(!guest.writes.some(w=>w.kind==='destroyRoom'));
 await guest.service.release('123',guest.request,g.member_permit);
 const host=fixture();host.get('123').anchor=user;host.get('123').seated=true;host.get('123').seat=0;host.get('123').muted=0;
 const h=await host.service.connect('123',host.request);await host.service.enter('123',host.request,h.member_permit);
 assert.deepEqual(await host.service.destroy('123',host.request,h.member_permit),{destroyed:true});
 assert.deepEqual(host.writes.filter(w=>w.kind==='destroyRoom').map(w=>w.extra),[{channel_id:'123'}]);
 assert.equal(host.service.busy(),false);await assert.rejects(host.service.status('123',host.request,h.member_permit),/授权已失效/);
 const failing=fixture({failDestroy:true});failing.get('123').anchor=user;const f2=await failing.service.connect('123',failing.request);
 await assert.rejects(failing.service.destroy('123',failing.request,f2.member_permit),e=>e.status===504);assert.equal(failing.service.busy(),true);
 failing.options.failDestroy=false;failing.options.destroyErrno=7;await assert.rejects(failing.service.destroy('123',failing.request,f2.member_permit),/errno 7/);
 await failing.service.release('123',failing.request,f2.member_permit);
});
async function app(t,f,owner={}){const server=http.createServer(makeHandler({member:f.service,owner,request:f.request}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const base='http://127.0.0.1:'+server.address().port;
 return {post:(action,body,headers={})=>fetch(base+'/api/member/'+action,{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Gravity-Action':'member-control',...headers},body:JSON.stringify(body)})};}
test('normal member actions require same origin, confirmation, and reject roles/seat IDs',async t=>{
 const f=fixture(),{post}=await app(t,f);
 for(const headers of [{Origin:'https://evil.invalid'},{'X-Gravity-Action':'owner-control'},{'Content-Type':'text/plain'}])assert.equal((await post('connect',{channel_id:'123',confirmed:true},headers)).status,403);
 assert.equal((await post('connect',{channel_id:'123',confirmed:false})).status,400);
 assert.equal((await post('connect',{channel_id:'123',confirmed:true,role_type:1})).status,400);
 assert.equal((await post('apply',{channel_id:'123',confirmed:true,role:'host'})).status,400);assert.equal(f.reads.length,0);
});
test('old owner takeover and normal membership cannot connect concurrently through the gateway',async t=>{
 const f=fixture(),{post}=await app(t,f,{busy:()=>true});const r=await post('connect',{channel_id:'123',confirmed:true});assert.equal(r.status,409);assert.equal(f.reads.length,0);
});
test('drain at shutdown quits presence, remutes and leaves only what this page acquired',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 await f.service.apply('123',f.request,g.member_permit);await f.service.mute('123',false,f.request,g.member_permit);
 await f.service.drain(f.request);
 assert.deepEqual(f.writes.map(x=>x.extra.pkg_type||x.kind),['AudioLive_Enter','applySeat','memberMute','AudioLive_Quit','memberMute','leaveSeat']);
 assert.equal(f.get('123').seated,false);assert.equal(f.service.busy(),false);
 const writes=f.writes.length;await f.service.drain(f.request);assert.equal(f.writes.length,writes);
});
test('a failed shutdown drain keeps the permit and its cleanup obligation',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 f.options.failWrite=true;await assert.rejects(f.service.drain(f.request));assert.equal(f.service.busy(),true);
 f.options.failWrite=false;await f.service.drain(f.request);assert.equal(f.service.busy(),false);assert.equal(f.writes.at(-1).extra.pkg_type,'AudioLive_Quit');
});
test('createRoom posts verified defaults then rereads the new room card',async()=>{
 const f=fixture(),id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
 const room=await f.service.createRoom({name:'测试房',label_id:'2',auto_pass:true,confirmed:true,request_id:id,tags:'one, two'},f.request);
 assert.equal(room.channel_id,'555');assert.equal(f.writes[0].kind,'createRoom');assert.equal(f.writes[0].extra.auto_pass,'1');
 assert.equal(f.writes[0].extra.tags,'one,two');
 await f.service.createRoom({name:'测试房',label_id:'2',auto_pass:true,confirmed:true,request_id:id,tags:'one, two'},f.request);
 assert.equal(f.writes.filter(w=>w.kind==='createRoom').length,1);
});
test('host updateRoom can replace tags after create; guests cannot',async()=>{
 const guest=fixture(),g=await guest.service.connect('123',guest.request);await guest.service.enter('123',guest.request,g.member_permit);
 await assert.rejects(guest.service.updateRoom('123',guest.request,g.member_permit,{tags:'beta'}),e=>e.status===403);
 assert.ok(!guest.writes.some(w=>w.kind==='updateRoom'));
 await guest.service.release('123',guest.request,g.member_permit);
 const host=fixture();host.get('123').anchor=user;host.get('123').tags='alpha';
 const h=await host.service.connect('123',host.request);await host.service.enter('123',host.request,h.member_permit);
 const st=await host.service.updateRoom('123',host.request,h.member_permit,{tags:'beta'});
 assert.equal(st.tags,'beta');
 assert.deepEqual(host.writes.filter(w=>w.kind==='updateRoom').map(w=>w.extra),[{channel_id:'123',tags:'beta'}]);
 const cleared=await host.service.updateRoom('123',host.request,h.member_permit,{tags:''});
 assert.equal(cleared.tags,'');
 const nested=await host.service.updateRoom('123',host.request,h.member_permit,{notice:'hello'});
 assert.equal(nested.notice,'hello');
 await host.service.release('123',host.request,h.member_permit);
});
test('entered members can claim a treasure box through the mutating GET',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 const r=await f.service.claimBox('123',f.request,g.member_permit,{lucky_box_id:'88',issue_user_id:'9'});
 assert.equal(r.claimed,true);assert.equal(f.writes.at(-1).kind,'luckyBox');assert.equal(f.writes.at(-1).extra.lucky_box_id,'88');
 await f.service.release('123',f.request,g.member_permit);
});
test('only the host can mute another seat; guests, self-seat, empty and invalid seats are refused',async()=>{
 const guest=fixture(),g=await guest.service.connect('123',guest.request);await guest.service.enter('123',guest.request,g.member_permit);
 await assert.rejects(guest.service.seatMute('123',guest.request,g.member_permit,1,true),e=>e.status===403);
 assert.ok(!guest.writes.some(w=>w.kind==='memberMute'));
 await guest.service.release('123',guest.request,g.member_permit);
 const host=fixture({seatRows:[{seat_id:0,mute_type:0,user:{user_id:user}},{seat_id:1,mute_type:0,user:{user_id:'555'}}]});
 host.get('123').anchor=user;
 const h=await host.service.connect('123',host.request);await host.service.enter('123',host.request,h.member_permit);
 await assert.rejects(host.service.seatMute('123',host.request,h.member_permit,0,true),/自己的麦位/);
 await assert.rejects(host.service.seatMute('123',host.request,h.member_permit,2,true),/麦位不存在/);
 await assert.rejects(host.service.seatMute('123',host.request,h.member_permit,64,true),/麦位无效/);
 host.options.seatRows.push({seat_id:2,mute_type:0,user:{user_id:'0'}});
 await assert.rejects(host.service.seatMute('123',host.request,h.member_permit,2,true),/空麦位/);
 assert.ok(!host.writes.some(w=>w.kind==='memberMute'));
 await host.service.release('123',host.request,h.member_permit);
});
test('host seat mute writes the official seat and reconfirms it',async()=>{
 const host=fixture({seatRows:[{seat_id:0,mute_type:0,user:{user_id:user}},{seat_id:1,mute_type:0,user:{user_id:'555'}}]});
 host.get('123').anchor=user;
 const h=await host.service.connect('123',host.request);await host.service.enter('123',host.request,h.member_permit);
 const st=await host.service.seatMute('123',host.request,h.member_permit,1,true);
 assert.equal(st.is_owner,true);
 assert.deepEqual(host.writes.filter(w=>w.kind==='memberMute').map(w=>w.extra),[{channel_id:'123',seat_id:'1',mute_type:'1'}]);
 await host.service.seatMute('123',host.request,h.member_permit,1,false);
 assert.deepEqual(host.writes.filter(w=>w.kind==='memberMute').at(-1).extra,{channel_id:'123',seat_id:'1',mute_type:'0'});
 await host.service.release('123',host.request,h.member_permit);
});
test('seat-mute route needs host confirmation and a valid seat id',async t=>{
 const host=fixture({seatRows:[{seat_id:0,mute_type:0,user:{user_id:user}},{seat_id:1,mute_type:0,user:{user_id:'555'}}]});
 host.get('123').anchor=user;
 const {post}=await app(t,host),h=await host.service.connect('123',host.request);await host.service.enter('123',host.request,h.member_permit);
 const good={channel_id:'123',confirmed:true,member_permit:h.member_permit,seat_id:'1',muted:true};
 assert.equal((await post('seat-mute',{...good,confirmed:false})).status,400);
 assert.equal((await post('seat-mute',{...good,muted:'yes'})).status,400);
 assert.equal((await post('seat-mute',{...good,seat_id:'64'})).status,400);
 assert.equal((await post('seat-mute',{...good,seat_id:'0'})).status,400);
 assert.equal((await post('seat-mute',good)).status,200);
 const guest=fixture(),{post:guestPost}=await app(t,guest),g=await guest.service.connect('123',guest.request);
 await guest.service.enter('123',guest.request,g.member_permit);
 assert.equal((await guestPost('seat-mute',{channel_id:'123',confirmed:true,member_permit:g.member_permit,seat_id:'1',muted:true})).status,403);
 await host.service.release('123',host.request,h.member_permit);await guest.service.release('123',guest.request,g.member_permit);
});
test('host kick overwrites presence user_id; guests cannot kick',async()=>{
 const guest=fixture(),g=await guest.service.connect('123',guest.request);await guest.service.enter('123',guest.request,g.member_permit);
 await assert.rejects(guest.service.kick('123',guest.request,g.member_permit,'555'),e=>e.status===403);
 assert.ok(!guest.writes.some(w=>w.kind==='memberPresence'&&w.extra.pkg_type==='AudioLive_Kick'));
 await guest.service.release('123',guest.request,g.member_permit);
 const host=fixture();host.get('123').anchor=user;
 const h=await host.service.connect('123',host.request);await host.service.enter('123',host.request,h.member_permit);
 const st=await host.service.kick('123',host.request,h.member_permit,'555');
 assert.equal(st.kicked,true);assert.equal(st.target_user_id,'555');
 const kick=host.writes.filter(w=>w.kind==='memberPresence'&&w.extra.pkg_type==='AudioLive_Kick').at(-1);
 assert.equal(JSON.parse(kick.extra.pkg_data).user_id,555);
 await host.service.release('123',host.request,h.member_permit);
});
 test('failing presence heartbeat degrades status instead of stopping the room',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 f.options.now=now+61000;f.options.failPresence=7;
 const degraded=await f.service.status('123',f.request,g.member_permit);
 assert.equal(degraded.presence,'degraded');assert.match(degraded.presence_error,/心跳/);
 // The lease survives degradation: a later good poll recovers without re-entering.
 f.options.failPresence=0;f.options.now=now+122000;
 const ok=await f.service.status('123',f.request,g.member_permit);
 assert.equal(ok.presence,'ok');
 await f.service.release('123',f.request,g.member_permit);
});
test('dead sessions fail status fast with their cause; transport blips fail soft',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 for(const [roomErrno,status,pattern] of [[40026,401,/会话已失效/],[40025,401,/会话已失效/],[-1,503,/暂未确认/]]) {
  f.options.roomErrno=roomErrno;
  await assert.rejects(f.service.status('123',f.request,g.member_permit),e=>e.status===status&&pattern.test(e.message));
 }
 f.options.roomErrno=0;f.options.seatsErrno=-1;
 await assert.rejects(f.service.status('123',f.request,g.member_permit),e=>e.status===503&&/麦位/.test(e.message));
 f.options.seatsErrno=0;
 const ok=await f.service.status('123',f.request,g.member_permit);
 assert.equal(ok.mode,'account-member');
 await f.service.release('123',f.request,g.member_permit);
});
test('a default room-info payload is retried once against live seats, without claiming access was denied',async()=>{
 const f=fixture({emptyInfoOnce:true});
 assert.equal((await f.service.status('123',f.request)).eligible,true);
 assert.deepEqual(f.reads.map(r=>r.kind),['roomInfo','seats','roomInfo']);
 assert.ok(f.reads.every(r=>r.authority.expectedIdentity==='test-identity'));assert.equal(f.writes.length,0);
});
test('empty, cross-room and rounded room ids never authorize entry or falsely report closure',async()=>{
 for(const opts of [{emptyInfo:true},{roomData:{channel_id:'456',user_id:'999'}},{roomData:{channel_id:1075222680736887600,user_id:'999'}}]){
  const f=fixture(opts);await assert.rejects(f.service.connect('123',f.request),e=>e.status===503&&/信息暂不完整/.test(e.message));
  assert.equal(f.reads.filter(r=>r.kind==='roomInfo').length,2);assert.equal(f.writes.length,0);assert.equal(f.service.busy(),false);
  assert.ok(!f.reads.some(r=>r.kind==='memberToken'));
 }
});
test('official closed-room errno 40202, including after empty room info, is a precise 404',async()=>{
 for(const opts of [{roomErrno:40202,previewErrno:40202},{emptyInfo:true,seatsErrno:40202,previewErrno:40202},{seatsErrno:40202,previewErrno:40202}]){
  const f=fixture(opts);await assert.rejects(f.service.connect('123',f.request),e=>e.status===404&&/房间已结束/.test(e.message));
  assert.equal(f.writes.length,0);assert.equal(f.service.busy(),false);
 }
});
test('40202 with a live preview is a restricted room, not closed',async()=>{
 const f=fixture({roomErrno:40202});
 await assert.rejects(f.service.connect('123',f.request),e=>e.status===409&&/仍在线/.test(e.message)&&/无法进入/.test(e.message));
 assert.equal(f.writes.length,0);assert.equal(f.service.busy(),false);
});
test('40202 with a dead preview but a live follow-list card is not closed',async()=>{
 const f=fixture({roomErrno:40202,previewErrno:40202,followList:[{follow_type:2,list:[{channel_id:'123',ext:{is_close:0}}]}]});
 await assert.rejects(f.service.connect('123',f.request),e=>e.status===409&&/好友列表/.test(e.message));
 assert.equal(f.writes.length,0);
});
test('40202 with a dead preview and a closed follow-list card is 404',async()=>{
 const f=fixture({roomErrno:40202,previewErrno:40202,followList:[{follow_type:2,list:[{channel_id:'123',ext:{is_close:1}}]}]});
 await assert.rejects(f.service.connect('123',f.request),e=>e.status===404&&/房间已结束/.test(e.message));
});
test('unknown official errors and unverified seat data fail closed but retryably, never imply account permission',async()=>{
 for(const opts of [{roomErrno:50001},{seatsErrno:50001},{badSeats:true}]){
  const f=fixture(opts);await assert.rejects(f.service.connect('123',f.request),e=>e.status===503&&!/无权|已结束/.test(e.message));
  assert.equal(f.writes.length,0);assert.equal(f.service.busy(),false);
 }
});
test('an ambiguous room-info poll recovers without another Enter, but confirmed closure and auth loss stay hard',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 f.options.emptyInfo=true;await assert.rejects(f.service.status('123',f.request,g.member_permit),e=>e.status===503);
 f.options.emptyInfo=false;assert.equal((await f.service.status('123',f.request,g.member_permit)).presence,'ok');
 for(const [seatsErrno,status] of [[40026,401],[-5,403]]){f.options.seatsErrno=seatsErrno;
  await assert.rejects(f.service.status('123',f.request,g.member_permit),e=>e.status===status);}
 f.options.seatsErrno=40202;
 await assert.rejects(f.service.status('123',f.request,g.member_permit),e=>e.status===503&&/暂未确认/.test(e.message));
 assert.equal(f.writes.filter(w=>w.extra.pkg_type==='AudioLive_Enter').length,1);
 f.options.seatsErrno=0;await f.service.release('123',f.request,g.member_permit);
});
test('closed-room and uncertain-room HTTP errors remain distinct through the member route',async t=>{
 const f=fixture(),{post}=await app(t,f);f.options.emptyInfo=true;f.options.seatsErrno=40202;f.options.previewErrno=40202;
 const closed=await post('connect',{channel_id:'123',confirmed:true});assert.equal(closed.status,404);assert.match((await closed.json()).errmsg,/房间已结束/);
 f.options.previewErrno=0;const restricted=await post('connect',{channel_id:'123',confirmed:true});assert.equal(restricted.status,409);assert.match((await restricted.json()).errmsg,/仍在线/);
 f.options.seatsErrno=0;const uncertain=await post('connect',{channel_id:'123',confirmed:true});assert.equal(uncertain.status,503);
 assert.match((await uncertain.json()).errmsg,/暂不完整/);assert.equal(f.writes.length,0);
});
test('room preview needs no room permit and projects members without entering',async()=>{
 const f=fixture();
 // No connect/enter at all: preview is a signed read, not a presence.
 const preview=await f.service.preview('123',f.request);
 assert.equal(preview.title,'Room');assert.equal(preview.user_count,2);assert.equal(preview.anchor_id,'999');
 // Roster comes from roomMemberList (the preview endpoint itself returns no members).
 assert.equal(preview.members.length,2);assert.equal(preview.members[0].user_id,'123456');
 assert.equal(preview.members[1].user_id,'999');
 assert.deepEqual(preview.seats,[]);
 assert.ok(!f.writes.some(w=>w.extra&&w.extra.pkg_type==='AudioLive_Enter'));
 assert.equal(f.service.busy(),false);
 await assert.rejects(f.service.preview('bad',f.request));
 f.options.previewErrno=7;
 await assert.rejects(f.service.preview('123',f.request),/预览暂不可用/);
});
test('preview route is a same-origin GET without a member permit',async t=>{
 const f=fixture(),{post}=await app(t,f);
 const server=http.createServer(makeHandler({member:f.service,request:f.request}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const base='http://127.0.0.1:'+server.address().port;
 const ok=await fetch(base+'/api/member/preview?channel_id=123');
 assert.equal(ok.status,200);assert.equal((await ok.json()).data.members.length,2);
 assert.equal((await fetch(base+'/api/member/preview?channel_id=123',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await post('seat-mute',{channel_id:'123'})).status,400);
 server.close();
});
test('force-release drops the permit without proof so a refreshed tab can re-enter at once',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);
 assert.equal(f.service.busy(),true);
 // Force needs no proof and makes no upstream calls (presence expires on its own).
 const writes=f.writes.length,reads=f.reads.length;
 const result=f.service.forceRelease('123',f.request);
 assert.deepEqual(result,{released:true,forced:true,channel:'123'});
 assert.equal(f.service.busy(),false);
 assert.equal(f.writes.length,writes);assert.equal(f.reads.length,reads);
 // Old proof is dead, but a new connect works immediately.
 await assert.rejects(f.service.enter('123',f.request,g.member_permit),/授权已失效/);
 const fresh=await f.service.connect('123',f.request);
 assert.notEqual(fresh.member_permit,g.member_permit);
 await f.service.release('123',f.request,fresh.member_permit);
});
test('force-release with no permit is a no-op success; bad channel is rejected',async()=>{
 const f=fixture();
 assert.deepEqual(f.service.forceRelease('123',f.request),{released:true,forced:false,channel:'123'});
 assert.deepEqual(f.service.forceRelease('',f.request),{released:true,forced:false,channel:null});
 assert.throws(()=>f.service.forceRelease('bad',f.request),/房间参数无效/);
 assert.equal(f.service.busy(),false);
});
test('force-release route needs same origin and channel but no proof',async t=>{
 const f=fixture(),{post}=await app(t,f);
 const g=await f.service.connect('123',f.request);
 assert.equal((await post('force-release',{channel_id:'123',confirmed:true},{Origin:'https://evil.invalid'})).status,403);
 assert.equal((await post('force-release',{channel_id:'123',confirmed:true},{'X-Gravity-Action':'owner-control'})).status,403);
 assert.equal((await post('force-release',{channel_id:'bad',confirmed:true})).status,400);
 assert.equal((await post('force-release',{confirmed:false,channel_id:'123',extra:1})).status,400);
 // The top-bar force quit knows no room (a refreshed page): it still drops what the server holds.
 const response=await post('force-release',{confirmed:true});
 assert.equal(response.status,200);
 assert.deepEqual((await response.json()).data,{released:true,forced:true,channel:'123'});
 assert.equal(f.service.busy(),false);
 assert.deepEqual((await (await post('force-release',{channel_id:'123',confirmed:true})).json()).data,{released:true,forced:false,channel:'123'});
 const fresh=await f.service.connect('123',f.request);
 await f.service.release('123',f.request,fresh.member_permit);
});

test('room preview projects mic seats without entering',async()=>{
 const f=fixture({seatRows:[{seat_id:0,mute_type:0,user:{user_id:'999',name:'Host',portrait:'https://cdn.gravity.place/h.png'}}]});
 const preview=await f.service.preview('123',f.request);
 assert.equal(preview.seats.length,1);assert.equal(preview.seats[0].seat_id,0);
 assert.equal(preview.seats[0].person.user_id,'999');assert.equal(preview.seats[0].muted,false);
 assert.ok(!f.writes.some(w=>w.extra&&w.extra.pkg_type==='AudioLive_Enter'));
});

test('a refreshed page re-entering the same room takes over the old permit: no Quit race, seat kept, mic remuted',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 await f.service.apply('123',f.request,g.member_permit);await f.service.mute('123',false,f.request,g.member_permit);
 assert.equal(f.get('123').seated,true);assert.equal(f.get('123').muted,0);
 // The old page vanished without releasing; its 90 s lease is still running.
 const fresh=await f.service.connect('123',f.request);
 assert.notEqual(fresh.member_permit,g.member_permit);assert.equal(fresh.seated,true);
 assert.equal(f.get('123').muted,1,'the abandoned open mic is closed on the official seat');
 assert.ok(!f.writes.some(w=>w.extra.pkg_type==='AudioLive_Quit'),'no Quit that could land after the new Enter');
 await assert.rejects(f.service.status('123',f.request,g.member_permit),/授权已失效/);
 await f.service.enter('123',f.request,fresh.member_permit);
 // The carried seat is still cleaned up when the new page leaves.
 await f.service.release('123',f.request,fresh.member_permit);
 assert.equal(f.get('123').seated,false);assert.equal(f.service.busy(),false);
});
test('entering another room while an old permit lingers cleans the old room up first',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 await f.service.apply('123',f.request,g.member_permit);
 const other=await f.service.connect('456',f.request);
 assert.equal(f.get('123').seated,false);
 const quit=f.writes.filter(w=>w.extra.pkg_type==='AudioLive_Quit');
 assert.equal(quit.length,1);assert.equal(JSON.parse(quit[0].extra.pkg_data).channel_id,'123');
 await f.service.release('456',f.request,other.member_permit);
});
test('a failing cleanup of the old room never blocks entering a new one',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 f.options.onWrite=kind=>{if(kind==='memberPresence')throw Error('upstream down');};
 f.options.onRead=(kind,extra)=>{if(extra.channel_id==='123'&&kind==='seats')throw Error('upstream down');};
 const other=await f.service.connect('456',f.request);
 assert.ok(other.member_permit);assert.equal(f.service.busy(),true);
 f.options.onWrite=null;f.options.onRead=null;await f.service.release('456',f.request,other.member_permit);
});
test('in the room, 40202 with a dead preview is a confirmed end (404); with a live preview it stays soft (503)',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 f.options.seatsErrno=40202;
 await assert.rejects(f.service.status('123',f.request,g.member_permit),e=>e.status===503);
 f.options.previewErrno=0;f.options.previewData={name:'',user_id:0};
 await assert.rejects(f.service.status('123',f.request,g.member_permit),e=>e.status===404&&/房间已结束/.test(e.message));
 assert.equal(f.writes.filter(w=>w.extra.pkg_type==='AudioLive_Enter').length,1);
});
test('releasing after the host ended the room finishes instead of retrying forever',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 await f.service.apply('123',f.request,g.member_permit);await f.service.mute('123',false,f.request,g.member_permit);
 f.options.seatsErrno=40202;f.options.previewData={name:'',user_id:0};
 f.options.onWrite=(kind,extra)=>{if(kind==='memberPresence'&&extra.pkg_type==='AudioLive_Quit')f.options.failQuit=true;};
 assert.deepEqual(await f.service.release('123',f.request,g.member_permit),{released:true});
 assert.equal(f.service.busy(),false);assert.equal(f.timers.tasks.size,0);
});
test('a cleanup that keeps failing backs off and finally gives up instead of hammering every second',async()=>{
 const f=fixture(),g=await f.service.connect('123',f.request);await f.service.enter('123',f.request,g.member_permit);
 f.options.failWrite=true;
 await assert.rejects(f.service.release('123',f.request,g.member_permit));
 const delays=[];const original=f.timers.setTimeout.bind(f.timers);f.timers.setTimeout=(fn,ms)=>{delays.push(ms);return original(fn,ms);};
 for(let i=0;i<14&&f.timers.tasks.size;i++){f.timers.fire();await settle(()=>true).catch(()=>{});for(let k=0;k<20;k++)await new Promise(r=>setImmediate(r));}
 assert.equal(f.service.busy(),false,'gave up');
 assert.ok(delays.length>=8&&delays.length<=10);assert.ok(delays.every((ms,i)=>i===0||ms>=delays[i-1]));assert.equal(Math.max(...delays),60000);
});

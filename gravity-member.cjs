'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const api=require('./gravity-api.cjs');
const {loadSessionToken,loadIosDevice}=require('./gravity-sign-ios.cjs');
const {OwnerError,verifySeats,rtcUid,validPublisherToken,crc32}=require('./gravity-owner.cjs');
const {createSerial,countryCode}=require('./gravity-util.cjs');
const {createCountryResolver}=require('./gravity-people.cjs');
const {APP_ID,tokenPrivileges}=require('./static/controller.js');
const id=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}$/.test(value);
function exactId(value) {
 if(typeof value==='number'&&!Number.isSafeInteger(value))throw new OwnerError('官方身份字段不完整。');
 const result=String(value??'');if(!id(result))throw new OwnerError('官方身份字段不完整。');return result;
}
function publicPerson(row,who) {
 const user=exactId(row?.user_id??row?.user?.user_id),source=row.user||row;
 let portrait='';try{const u=new URL(source.portrait);if(u.protocol==='https:'&&u.hostname==='cdn.gravity.place'&&!u.username&&!u.password&&!u.port)portrait=u.origin+u.pathname;}catch{}
 const country=countryCode(source.user_country)||countryCode(source.ext?.user_country);
 const relation=Number.isSafeInteger(source.ext?.relation)?source.ext.relation:0;
 return {user_id:user,rtc_uid:rtcUid(user),name:typeof source.name==='string'?source.name.slice(0,80):'',portrait,country,is_self:user===who.user,blocked:(relation&4)===4};
}
function loadMemberIdentity() {
 try {const s=JSON.parse(fs.readFileSync(path.join(__dirname,'.session/www-token.json')));
  if(s.token!==loadSessionToken()||!id(s.user_id))return null;
  return {user:s.user_id,identity:api.sessionIdentity(s.token)};
 } catch {return null;}
}
function roomTags(raw){
 if(typeof raw!=='string'||!raw.trim())return '';
 return raw.split(/[,，]/).map(part=>part.trim()).filter(Boolean).slice(0,5).map(part=>part.slice(0,20)).join(',');
}
function createMemberService({identity=loadMemberIdentity,read=api.readSignedVoice,write=api.writeMemberVoice,
 writeCreate=api.writeCreateRoom,writeUpdate=api.writeUpdateRoom,writeBox=api.writeLuckyBox,writeGroup=api.writeGroupEnter,writeDestroy=api.writeDestroyRoom,verify=verifySeats,device=loadIosDevice,now=Date.now,timers=globalThis,
 people=createCountryResolver(),previewRead=api.readRoomPreview,onPeople=()=>{},blocked=()=>[],listedFollowRooms}={}) {
 let permit=null;
 const serial=createSerial(8,()=>new OwnerError('账号操作正在处理，请稍后重试。'));
 const createdRooms=new Map();
 function context(channel){const who=identity();if(!who||!id(channel))throw new OwnerError('需要有效的 App 会话和房间。',403);return who;}
 function authorize(channel,proof,cleanup=false){const who=context(channel);
  if(!permit||permit.proof!==proof||permit.channel!==channel||permit.identity!==who.identity||(!cleanup&&(permit.cleanupPending||permit.expires<=now())))throw new OwnerError('账号入房授权已失效，请重新连接。',403);
  return who;
 }
 // Only a verified official reason is a hard rejection. In particular, an
 // empty/default getRoomInfo payload is not evidence of missing permission.
 // 40202 is the official closed-room code, but the same errno also appears for
 // live private/friend rooms and as a transient read during a long stay. Confirm
 // closure with preview and the follow-room list before hiding a card; while the
 // account is already in the room, treat 40202 as a soft failure.
 function hardErrno(errno) { return errno === 40025 || errno === 40026; }
 function roomChannel(room){return id(String(room?.channel_id||''))?String(room.channel_id):'';}
 function previewAlive(response){
  const data=response?.data;
  if(response?.errno!==0||!data||typeof data!=='object')return false;
  const name=typeof data.name==='string'&&data.name.trim();
  const host=id(String(data.user_id??data.anchor_id??''));
  return !!(name||host);
 }
 function followHasLive(raw,channel){
  const want=String(channel);
  for(const group of Array.isArray(raw?.list)?raw.list:[]){
   if(![1,2].includes(Number(group?.follow_type)))continue;
   for(const item of Array.isArray(group.list)?group.list:[]){
    if(String(item?.channel_id)!==want)continue;
    return item?.ext?.is_close!==1;
   }
  }
  return false;
 }
 function checkRoomRead(response,label){
  if(hardErrno(response.errno))throw new OwnerError('官方会话已失效，请同步 App 会话后重进。',401);
  if(response.errno===-5)throw new OwnerError('账号身份已变化，请重新连接。',403);
  if(response.errno===-3)throw new OwnerError('缺少有效的 App 会话，请先同步。',401);
  if(response.errno!==0)throw new OwnerError(label+'暂未确认（官方 errno '+response.errno+'），稍后重试。',503);
 }
 async function rejectUnlessClosed(channel,request,authority){
  let preview;
  try{preview=await previewRead({channel_id:channel},request,authority);}
  catch{throw new OwnerError('房间详情暂不可用，请稍后重试。',503);}
  if(identity()?.identity!==authority.expectedIdentity)throw new OwnerError('账号身份已变化，请重新连接。',403);
  if(previewAlive(preview))throw new OwnerError('该房间仍在线，但当前无法进入（私密房或官方暂时拒绝读取）。请稍后重试，或改用 App。',409);
  if(typeof listedFollowRooms==='function'){
   try{
    const listed=await listedFollowRooms(request);
    if(identity()?.identity!==authority.expectedIdentity)throw new OwnerError('账号身份已变化，请重新连接。',403);
    if(listed?.errno===0&&followHasLive(listed.data,channel))
     throw new OwnerError('该房间仍在好友列表中，但当前无法进入（可能是私密房）。请稍后重试，或改用 App。',409);
   }catch(error){if(error instanceof OwnerError)throw error;}
  }
  throw new OwnerError('该房间已结束，请刷新列表选择仍在线的房间。',404);
 }
 async function inspect(channel,request){const who=context(channel),authority={expectedIdentity:who.identity};
  const inSession=!!(permit&&permit.channel===channel&&permit.identity===who.identity&&permit.entered);
  const closed=async response=>{
   if(response.errno!==40202)return false;
   if(inSession){
    // In the room a lone 40202 is usually a transient read: stay soft. Only when
    // the preview no longer names the room either (the host ended it) is it hard,
    // so the page stops at once instead of listening to silence for two minutes.
    try{await rejectUnlessClosed(channel,request,authority);}
    catch(error){if(error instanceof OwnerError&&(error.status===404||error.status===403))throw error;}
    throw new OwnerError('官方房间状态暂未确认，稍后重试。',503);
   }
   await rejectUnlessClosed(channel,request,authority);
   return true;
  };
  let info=await read('roomInfo',{channel_id:channel},request,authority);
  if(!(await closed(info)))checkRoomRead(info,'官方房间信息');
  const seats=await read('seats',{channel_id:channel},request,authority);
  if(!(await closed(seats)))checkRoomRead(seats,'官方麦位状态');
  // A live seat response can outlast a temporarily empty room-info response.
  // Recheck once, but never authorize using stale/cross-room information.
  if(roomChannel(info.data?.room_info)!==String(channel)){
   info=await read('roomInfo',{channel_id:channel},request,authority);
   if(!(await closed(info)))checkRoomRead(info,'官方房间信息');
  }
  const room=info.data?.room_info;
  if(roomChannel(room)!==String(channel))throw new OwnerError('官方房间信息暂不完整，稍后重试（未确认关房或权限变更）。',503);
  const anchor=exactId(room.user_id),validation=verify(seats.data);
  if(!validation.reportedDigestVerified)throw new OwnerError('官方麦位状态校验暂未通过，稍后重试。',503);
  const rows=seats.data.anchor_user_list;
  const own=rows.filter(row=>String(row.user?.user_id)===who.user);
  if(own.length>1||identity()?.identity!==who.identity)throw new OwnerError('账号或麦位身份已变化。',403);
  const seat=own[0]||null;
  const noticeText=typeof room.notice==='string'?room.notice:typeof room.notice?.notice==='string'?room.notice.notice:'';
  const notice=noticeText.slice(0,200),tags=typeof room.tags==='string'?roomTags(room.tags):'';
  return {who,anchor,seat,rows,auto:room.auto_pass===1,isOwner:anchor===who.user,roomType:Number.isSafeInteger(room.room_type)?room.room_type:0,notice,tags,validation};
 }
 function state(result){return {mode:'account-member',eligible:true,seated:!!result.seat,seat_id:result.seat?.seat_id??null,
  muted:result.seat?result.seat.mute_type===1:null,is_owner:result.isOwner,auto_pass:result.auto,room_type:result.roomType,
  notice:result.notice||'',tags:result.tags||'',anchor_rtc_uid:rtcUid(result.anchor),seat_provenance:'official-tls',reported_digest_rsa_verified:true,
  seat_payload_digest_verified:result.validation.payloadMatches};}
 function arm(request){const current=permit,generation=++current.generation;current.expires=now()+90_000;
  timers.clearTimeout(current.timer);current.timer=timers.setTimeout(()=>{void expire(current,request,generation);},90_000);current.timer.unref?.();}
 // Failed cleanup backs off (1 s → 60 s) and gives up after ten tries (~8 min):
 // without heartbeats the official presence lapses anyway, and a dead upstream
 // must not be hammered every second forever.
 function retry(current,request){current.cleanupPending=true;current.expires=now();const generation=++current.generation;
  current.cleanupFails=(current.cleanupFails||0)+1;timers.clearTimeout(current.timer);
  if(current.cleanupFails>10){if(permit===current)permit=null;return;}
  current.timer=timers.setTimeout(()=>{void expire(current,request,generation);},Math.min(60_000,1000*2**(current.cleanupFails-1)));current.timer.unref?.();}
 async function setMute(channel,muted,request,proof,renew=true){authorize(channel,proof,muted);const result=await inspect(channel,request);
  if(!result.seat){if(!muted)throw new OwnerError('尚未获批麦位，不能发送。');permit.unmuted=false;return state(result);}
  if(!muted)permit.unmuted=true;
  if(result.seat.mute_type!==(muted?1:0)){
   const changed=await write('memberMute',{channel_id:channel,seat_id:String(result.seat.seat_id),mute_type:muted?'1':'0'},request);
   if(changed.errno!==0)throw new OwnerError('官方麦位更新失败，请在 App 检查状态。');
  }
  const checked=await inspect(channel,request);
  if(!checked.seat||checked.seat.seat_id!==result.seat.seat_id||checked.seat.mute_type!==(muted?1:0))throw new OwnerError('官方麦位状态未确认。');
  if(muted)permit.unmuted=false;if(renew)arm(request);return state(checked);
 }
 // App Na/G0 and Ma/C1105y schedule AudioLive_HeartBeat using the server's interval.
 // The existing permit-bound status poll drives it; a heartbeat must not extend its own lease.
 function heartbeatInterval(data,previous=60_000){
  if(typeof data==='string'&&data.length<=8192){try{data=JSON.parse(data);}catch{return previous;}}
  return Number.isSafeInteger(data?.interval)&&data.interval>0&&data.interval<=3600?data.interval*1000:previous;
 }
 // A room nobody has joined yet (for example the one just created) answers errno 1 with empty data: that is zero people, not unknown.
 function memberTotal(count,message){
  if(count.errno===0&&Number.isSafeInteger(count.data?.members)&&count.data.members>=0)return count.data.members;
  if(count.errno===1&&(count.data==null||Object.keys(count.data).length===0))return 0;
  throw new OwnerError(message);
 }
 // The periodic presence heartbeat must never kill healthy audio by itself:
 // only auth/identity failures (403/401) escape; everything else degrades to 503
 // and the page keeps listening while it retries.
 async function heartbeat(current,result,request){
  if(!current.entered||!current.enterConfirmed||now()<current.nextHeartbeatAt)return;
  try{
   const count=await read('memberCount',{channel_id:current.channel},request,{expectedIdentity:current.identity});
   authorize(current.channel,current.proof);
   if(hardErrno(count.errno))throw new OwnerError('官方会话已失效，请同步 App 会话后重进。',401);
   const members=memberTotal(count,'官方在房人数暂未确认，稍后重试。');
   if(result.who.identity!==current.identity)throw new OwnerError('账号身份已变化，请重进。');
   const anchor=Number(result.anchor);if(!Number.isSafeInteger(anchor))throw new OwnerError('房主身份不完整。');
   const payload={...current.presence,anchor_id:anchor,seat_id:result.seat?.seat_id??(result.isOwner?0:-1),person_num:members};
   const response=await write('memberPresence',{pkg_type:'AudioLive_HeartBeat',version:'1',pkg_data:JSON.stringify(payload)},request,{expectedIdentity:current.identity});
   authorize(current.channel,current.proof);
   if(hardErrno(response.errno))throw new OwnerError('官方会话已失效，请同步 App 会话后重进。',401);
   if(response.errno!==0)throw new OwnerError('官方在房心跳未确认，稍后重试。',503);
   current.presence=payload;current.heartbeatInterval=heartbeatInterval(response.data,current.heartbeatInterval);current.nextHeartbeatAt=now()+current.heartbeatInterval;
  }catch(error){
   // Auth/identity problems escape as hard failures; transient count/presence
   // problems degrade so healthy audio survives.
   if(error instanceof OwnerError&&(error.status===401||error.status===403||/身份已变化/.test(error.message)))throw error;
   throw new OwnerError('官方在房心跳暂未确认，稍后重试。',503);
  }
 }
 async function reportPresence(current,joined,request){const who=authorize(current.channel,current.proof,!joined);
  if(joined){const result=await inspect(current.channel,request),count=await read('memberCount',{channel_id:current.channel},request);
   const members=memberTotal(count,'房间成员人数未确认。');
   if(identity()?.identity!==who.identity)throw new OwnerError('房间成员人数未确认。');
   const user=Number(who.user),anchor=Number(result.anchor),version=String(device()?.app_version||'');
   if(!Number.isSafeInteger(user)||!Number.isSafeInteger(anchor))throw new OwnerError('成员登记身份不完整。');
   if(!/^\d+(\.\d+){1,3}$/.test(version))throw new OwnerError('App 设备版本未确认。');
   current.presence={channel_id:current.channel,anchor_id:anchor,user_id:user,seat_id:result.seat?.seat_id??(result.isOwner?0:-1),
    person_num:members,app_version:version,device:'ios'};current.entered=true;current.roomType=result.roomType;
  }
  // Quit uses the authenticated entry snapshot, including if the room closed meanwhile.
  if(!current.presence)throw new OwnerError('成员登记状态不完整。');
  const payload=joined?current.presence:{...current.presence,person_num:Math.max(0,current.presence.person_num-1)};
  const cover=(pkg_type,data)=>write('memberPresence',{pkg_type,version:'1',pkg_data:JSON.stringify(data)},request,{expectedIdentity:who.identity});
  const staleQuit={...payload,person_num:Math.max(0,payload.person_num-1)};
  const kick=async()=>{try{await cover('AudioLive_Quit',staleQuit);}catch{}};
  // Enter first: a Quit sent just before a fresh Enter can be applied after it and leave us "not in the room",
  // which blocks taking a seat. Only a refused Enter (leftover occupancy of a refreshed tab) is kicked and retried.
  let response=await cover(joined?'AudioLive_Enter':'AudioLive_Quit',payload);
  if(joined&&response.errno!==0&&!current.enterConfirmed){
   await kick();response=await cover('AudioLive_Enter',payload);
  }
  if(response.errno!==0)throw new OwnerError(joined?'官方入房登记未成功（'+response.errno+'）；已尝试顶掉旧占用。':'官方离房登记未确认（'+response.errno+'）。');
  if(joined){current.enterConfirmed=true;current.heartbeatInterval=heartbeatInterval(response.data);current.nextHeartbeatAt=now()+current.heartbeatInterval;}
  else {current.entered=false;current.nextHeartbeatAt=null;}return {entered:joined};
 }
 // A room the host ended has no presence, mute or seat left to clean; a 404 from
 // the room check means done, not "retry forever".
 const roomGone=error=>error instanceof OwnerError&&error.status===404;
 async function cleanup(current,request){
  if(current.entered){
   try{await reportPresence(current,false,request);}
   catch(error){
    let gone=false;try{await inspect(current.channel,request);}catch(check){gone=roomGone(check);}
    if(!gone)throw error;current.entered=false;current.nextHeartbeatAt=null;
   }
  }
  if(current.unmuted){
   try{await setMute(current.channel,true,request,current.proof,false);}
   catch(error){if(!roomGone(error))throw error;current.unmuted=false;}
  }
  if(current.acquiredSeat){
   try{const result=await inspect(current.channel,request);
    if(result.seat){const response=await write('leaveSeat',{channel_id:current.channel},request);if(response.errno!==0)throw new OwnerError('下麦清理未确认。');
     if((await inspect(current.channel,request)).seat)throw new OwnerError('下麦清理未确认。');}
   }catch(error){if(!roomGone(error))throw error;}
   current.acquiredSeat=false;
  }
 }
 function expire(current,request,generation){const work=serial(async()=>{
  if(permit!==current||current.generation!==generation||current.expires>now())return;
  if(identity()?.identity!==current.identity){timers.clearTimeout(current.timer);permit=null;return;}
  await cleanup(current,request);if(permit===current){timers.clearTimeout(current.timer);permit=null;}
 });work.catch(()=>{if(permit===current&&current.generation===generation)retry(current,request);});}
 // Room managers plus the host may invite/approve over RTM. Kept fresh for the page because admins can change mid-session.
 // Everyone we block: the page never plays their audio, on top of the official mute the aligner sets.
 function blockedUids(){const out=[];for(const user of blocked().slice(0,5000)){try{out.push(rtcUid(exactId(user)));}catch{}}return out;}
 const moderatorUids=(anchor,managers)=>{const peers=new Set([rtcUid(anchor)]);
  for(const row of managers.slice(0,64)){const user=exactId(row.user_id??row.user?.user_id);peers.add(rtcUid(user));}return [...peers];};
 async function refreshModerators(current,result,request){
  if(current.moderators&&now()-current.moderatorsAt<60_000)return current.moderators;
  try{const managers=await read('managers',{channel_id:current.channel},request,{expectedIdentity:current.identity});
   if(managers.errno===0&&Array.isArray(managers.data?.list)){current.moderators=moderatorUids(result.anchor,managers.data.list);current.moderatorsAt=now();}
  }catch{}
  return current.moderators||null;
 }
 const status=(channel,request,proof)=>serial(async()=>{if(proof)authorize(channel,proof);const result=await inspect(channel,request);
  if(!proof)return state(result);
  // The page is alive and the room/seat is confirmed: keep the lease even if the
  // presence heartbeat below only degrades.
  arm(request);
  let presence='ok',presence_error='';
  try{await heartbeat(permit,result,request);}
  catch(error){
   if(error instanceof OwnerError&&error.status!==503)throw error;
   presence='degraded';presence_error=String(error?.message||'稍后重试').slice(0,120);
  }
  const moderators=await refreshModerators(permit,result,request);
  const out={...state(result),presence,blocked_rtc_uids:blockedUids()};
  if(presence_error)out.presence_error=presence_error;
  return moderators?{...out,moderator_rtc_uids:moderators}:out;});
 // roomMemberList pages are small and the old "load more" reset on every refresh, so read a few pages in one go.
 const MEMBER_PAGES=5,FULL_PAGE=10;
 async function memberRows(channel,anchor,request,start){
  const rows=[];let last=start,more='';
  for(let page=0;page<MEMBER_PAGES;page++){
   const list=await read('members',{channel_id:channel,anchor_id:anchor,...(last?{last_id:last}:{})},request);
   if(list.errno!==0||(list.data?.list!=null&&!Array.isArray(list.data.list)))throw new OwnerError('房间成员列表暂不可用。');
   const batch=list.data?.list||[];rows.push(...batch.slice(0,100));
   const next=String(list.data?.last_id??'');more='';
   if(batch.length<FULL_PAGE||!id(next)||next===last)break;
   last=next;more=next;
  }
  return {rows,more};
 }
 const board=(channel,request,proof,cursor='')=>serial(async()=>{authorize(channel,proof);
  if(cursor&&!id(cursor))throw new OwnerError('成员分页游标无效。',400);
  const result=await inspect(channel,request);
  const {rows,more}=await memberRows(channel,result.anchor,request,cursor);
  if(identity()?.identity!==result.who.identity)throw new OwnerError('房间成员列表暂不可用。');
  const members=[...new Map(rows.flatMap(row=>{try{const p=publicPerson(row,result.who);return [[p.user_id,p]];}catch{return [];}})).values()].slice(0,500);
  const seats=result.rows.map(row=>({seat_id:row.seat_id,muted:row.mute_type===1,
   person:String(row.user?.user_id||'0')==='0'?null:publicPerson(row,result.who)}));
  // Member rows carry no country; resolve the unknown ones in batches (cached) so off-mic people get the same badge.
  const unknown=[...members,...seats.map(s=>s.person).filter(Boolean)].filter(p=>!p.country);
  if(unknown.length){const country=await people.lookup([...new Set(unknown.map(p=>p.user_id))],request,{expectedIdentity:result.who.identity});
   for(const p of unknown)p.country=country(p.user_id);}
  // Rows also tell who follows/blocked us; hand that to the relation aligner without waiting for it.
  try{onPeople([...rows,...result.rows.map(row=>row.user)].filter(Boolean).map(row=>({user_id:row.user_id,relation:row.ext?.relation,name:row.name})));}catch{}
  return {members,seats,self_profile:members.find(p=>p.is_self)||seats.find(s=>s.person?.is_self)?.person||null,next_cursor:more};
 });
 const connect=(channel,request,{stealth=false}={})=>serial(async()=>{
  // Accept old normal clients' false only; never silently register a retired invisible request.
  if(stealth!==false)throw new OwnerError('隐身入口已取消，请选择试听或进房。',400);
  const who=context(channel);
  // A new App login is a new authority: never use it to mutate an old device's room.
  if(permit&&permit.identity!==who.identity){timers.clearTimeout(permit.timer);permit=null;}
  // One account, one room page; the newest explicit entry wins, like the App.
  // A permit still held here is a refreshed/closed page whose release never
  // arrived, or another tab (its next poll is refused and it stops). Another
  // room: clean it up first, best effort. Same room: keep the seat and only
  // remute; a Quit racing the new Enter could leave us "not in the room", and
  // Enter-retry already displaces leftover occupancy.
  let carrySeat=false;
  if(permit){const stale=permit;timers.clearTimeout(stale.timer);stale.generation++;
   if(stale.channel!==channel){try{await cleanup(stale,request);}catch{}}
   else {carrySeat=!!stale.acquiredSeat;if(stale.unmuted){try{await setMute(stale.channel,true,request,stale.proof,false);}catch{}}}
   if(permit===stale)permit=null;
  }
  const result=await inspect(channel,request);
  const token=await read('memberToken',{channel_id:channel,role_type:'0'},request),data=token.data,p=tokenPrivileges(data?.rtc_token);
  const uid=Number(data?.uid);
  if(token.errno!==0||uid!==rtcUid(result.who.user)||uid<1||data?.rtc_token?.slice(3,35)!==APP_ID||!p.known||!p.declaresJoin||p.declaresPublishAudio!==false||
    typeof data?.rtm_token!=='string'||!data.rtm_token.startsWith('006'+APP_ID)||identity()?.identity!==result.who.identity)throw new OwnerError('账号入房凭证不匹配。');
  const managers=await read('managers',{channel_id:channel},request);
  if(managers.errno!==0||!Array.isArray(managers.data?.list)||identity()?.identity!==result.who.identity)throw new OwnerError('房间管理权限或账号会话已变化。');
  const moderators=moderatorUids(result.anchor,managers.data.list);
  permit={proof:crypto.randomUUID(),channel,anchor:result.anchor,identity:result.who.identity,generation:0,unmuted:false,acquiredSeat:carrySeat&&!!result.seat,moderators,moderatorsAt:now()};arm(request);
  return {...state(result),user_id:uid,rtc_token:data.rtc_token,rtm_token:data.rtm_token,member_permit:permit.proof,
   moderator_rtc_uids:moderators,blocked_rtc_uids:blockedUids(),publishing_available:!!result.seat};
 });
 const enter=(channel,request,proof)=>serial(async()=>{authorize(channel,proof);const current=permit;
  if(current.entered&&current.enterConfirmed)return {entered:true};const result=await reportPresence(current,true,request);
  current.enteredAt=now();
  // Group-call rooms (room_type 2) also have an enter call of their own; the App sends it, so do the same. Best effort.
  if(current.roomType===2&&!current.groupEntered){current.groupEntered=true;
   try{authorize(channel,proof);await writeGroup({channel_id:channel},request,{expectedIdentity:current.identity});}catch{}}
  arm(request);return result;
 });
 const apply=(channel,request,proof)=>serial(async()=>{authorize(channel,proof);const before=await inspect(channel,request);
  if(before.seat){arm(request);return state(before);}
  // Native seat$1 uses applyForSeat; an approval-needed room first sends RTM orderType=3,
  // waits for authenticated orderType=4, then invokes this action. Keep capture muted.
  permit.acquiredSeat=true;const response=await write('applySeat',{channel_id:channel,mute_type:'1'},request);
  if(response.errno!==0)throw new OwnerError('上麦申请未成功（官方 errno '+response.errno+'）；请检查房间权限、麦位，或改向主持人申请。');
  const after=await inspect(channel,request);arm(request);return state(after);
 });
 const publisher=(channel,request,proof)=>serial(async()=>{authorize(channel,proof);const result=await inspect(channel,request);
  if(!result.seat)throw new OwnerError('尚未获批麦位，不能发送。');
  const token=await read('memberToken',{channel_id:channel,role_type:'1'},request),uid=rtcUid(result.who.user);
  if(token.errno!==0||Number(token.data?.uid)!==uid||!validPublisherToken(token.data?.rtc_token,channel,uid,now())||identity()?.identity!==result.who.identity)throw new OwnerError('麦位发布凭证未确认。');
  arm(request);return {...state(result),user_id:uid,rtc_token:token.data.rtc_token,publishing_available:true};
 });
 // Reuse the verified getAgoraToken pair, not Enter/login or a new membership permit.
 // Only a still-authorized page can renew; role 1 also requires this page's explicit unmute.
 const renew=(channel,request,proof)=>serial(async()=>{authorize(channel,proof);const current=permit;
  if(!current.enterConfirmed||!current.entered)throw new OwnerError('尚未确认入房，不能续期。',403);
  const result=await inspect(channel,request);authorize(channel,proof);
  const publishing=!!(current.unmuted&&result.seat&&result.seat.mute_type===0),uid=rtcUid(result.who.user);
  const response=await read('memberToken',{channel_id:channel,role_type:publishing?'1':'0'},request,{expectedIdentity:current.identity});
  authorize(channel,proof);
  const data=response.data,p=tokenPrivileges(data?.rtc_token),rtm=tokenPrivileges(data?.rtm_token);
  let bound=false;try{const b=Buffer.from(data.rtc_token.slice(35),'base64'),offset=2+b.readUInt16LE(0);
   bound=b.readUInt32LE(offset)===crc32(channel)&&b.readUInt32LE(offset+4)===crc32(uid);
  }catch{}
  if(response.errno!==0||Number(data?.uid)!==uid||data?.rtc_token?.slice(3,35)!==APP_ID||!bound||!p.known||!p.declaresJoin||
   p.declaresPublishAudio!==publishing||p.expiresAt<=now()+30_000||
   data?.rtm_token?.slice(3,35)!==APP_ID||!rtm.known||!rtm.declaresRtmLogin||rtm.expiresAt<=now()+30_000||
   (publishing&&!validPublisherToken(data.rtc_token,channel,uid,now())))throw new OwnerError('账号房间凭证续期未确认；请重新连接。');
  // Do not extend the watchdog here: only the existing status poll keeps the page alive.
  return {...state(result),user_id:uid,rtc_token:data.rtc_token,rtm_token:data.rtm_token};
 });
 const mute=(channel,muted,request,proof)=>serial(()=>setMute(channel,muted,request,proof));
 const leave=(channel,request,proof)=>serial(async()=>{authorize(channel,proof,true);const before=await inspect(channel,request);
  if(before.seat){if(before.isOwner)throw new OwnerError('房主请使用静音；结束房间在 App 操作。');
   const response=await write('leaveSeat',{channel_id:channel},request);if(response.errno!==0)throw new OwnerError('下麦未成功。');}
  const after=await inspect(channel,request);if(after.seat)throw new OwnerError('下麦状态未确认。');permit.acquiredSeat=false;permit.unmuted=false;arm(request);return state(after);
 });
 // Host only: mute/unmute another seat (抱下麦 = mute). Same verified updateAnchorStatus family
 // the page already uses for its own seat; the official side confirms per seat.
 const seatMute=(channel,request,proof,seatId,muted)=>serial(async()=>{authorize(channel,proof);
  if(!Number.isSafeInteger(seatId)||seatId<0||seatId>63)throw new OwnerError('麦位无效。',400);
  const before=await inspect(channel,request);authorize(channel,proof);
  if(!before.isOwner)throw new OwnerError('只有房主可以管理麦位。',403);
  const seat=before.rows.find(row=>row.seat_id===seatId);
  if(!seat)throw new OwnerError('麦位不存在。',404);
  if(String(seat.user?.user_id||'0')==='0')throw new OwnerError('空麦位无需操作。',400);
  if(exactId(seat.user.user_id)===before.who.user)throw new OwnerError('自己的麦位请用开麦/闭麦。',400);
  if(seat.mute_type===(muted?1:0)){arm(request);return state(before);}
  const changed=await write('memberMute',{channel_id:channel,seat_id:String(seatId),mute_type:muted?'1':'0'},request);
  if(changed.errno!==0)throw new OwnerError('官方麦位更新失败（errno '+changed.errno+'）。');
  const after=await inspect(channel,request);authorize(channel,proof);
  const now=after.rows.find(row=>row.seat_id===seatId);
  if(!now||String(now.user?.user_id||'0')==='0'||now.mute_type!==(muted?1:0))throw new OwnerError('官方麦位状态未确认。');
  arm(request);return state(after);
 });
 // Host: kick someone out of the room. Native Na/E0.H overwrites the presence
 // snapshot's user_id with the target, then posts AudioLive_Kick. RTM type 4 is sent by the page.
 const kick=(channel,request,proof,targetId)=>serial(async()=>{authorize(channel,proof);
  const target=exactId(targetId);const before=await inspect(channel,request);authorize(channel,proof);
  if(!before.isOwner)throw new OwnerError('只有房主可以把人移出房间。',403);
  if(target===before.who.user)throw new OwnerError('不能移出自己。',400);
  const current=permit;if(!current?.presence)throw new OwnerError('成员登记状态不完整。');
  const user=Number(target);if(!Number.isSafeInteger(user))throw new OwnerError('对象无效。',400);
  const payload={...current.presence,user_id:user};
  const response=await write('memberPresence',{pkg_type:'AudioLive_Kick',version:'1',pkg_data:JSON.stringify(payload)},request,{expectedIdentity:before.who.identity});
  authorize(channel,proof);
  if(response.errno!==0)throw new OwnerError('官方未确认移出（errno '+response.errno+'）。');
  arm(request);return {...state(before),kicked:true,target_user_id:target};
 });
 // Host: change notice, auto-approve, or tags after the room already exists.
 // Native qa/N0 only sends tags at create, but live updateRoom replaces tags (verified 2026-10-20).
 const updateRoom=(channel,request,proof,fields)=>serial(async()=>{authorize(channel,proof);
  if(!fields||typeof fields!=='object'||Array.isArray(fields))throw new OwnerError('房间参数无效。',400);
  const extra={channel_id:channel};
  if(fields.notice!==undefined){
   if(typeof fields.notice!=='string'||fields.notice.length>200)throw new OwnerError('公告最多 200 字。',400);
   extra.notice=fields.notice;
  }
  if(fields.auto_pass!==undefined){
   if(typeof fields.auto_pass!=='boolean')throw new OwnerError('免审批参数无效。',400);
   extra.auto_pass=fields.auto_pass?'1':'0';
  }
  if(fields.tags!==undefined){
   if(typeof fields.tags!=='string')throw new OwnerError('标签无效。',400);
   extra.tags=roomTags(fields.tags);
  }
  if(extra.notice===undefined&&extra.auto_pass===undefined&&extra.tags===undefined)throw new OwnerError('没有要改的房间字段。',400);
  const before=await inspect(channel,request);authorize(channel,proof);
  if(!before.isOwner)throw new OwnerError('只有房主可以改房间。',403);
  let response;try{response=await writeUpdate(extra,request,{expectedIdentity:before.who.identity});}
  catch{throw new OwnerError('改房间的结果未确认。',504);}
  if(response.errno!==0)throw new OwnerError('官方未确认改房间（errno '+response.errno+'）。');
  const after=await inspect(channel,request);authorize(channel,proof);arm(request);return state(after);
 });
 const release=(channel,request,proof)=>serial(async()=>{authorize(channel,proof,true);const current=permit;
  try{await cleanup(current,request);}catch(error){retry(current,request);throw error;}
  if(permit===current){timers.clearTimeout(current.timer);permit=null;}return {released:true};
 });
 // Shutdown: quit presence / remute / leave a seat this process obtained. A failure keeps the permit.
 const drain=request=>serial(async()=>{const current=permit;if(!current)return;
  await cleanup(current,request);if(permit===current){timers.clearTimeout(current.timer);permit=null;}
 });
 // Only the room's host can end it; the official side then closes the room for everyone.
 const destroy=(channel,request,proof)=>serial(async()=>{authorize(channel,proof);const current=permit;
  const result=await inspect(channel,request);authorize(channel,proof);
  if(!result.isOwner)throw new OwnerError('只有房主可以结束房间。',403);
  let response;try{response=await writeDestroy({channel_id:channel},request,{expectedIdentity:result.who.identity});}
  catch{throw new OwnerError('结束房间的结果未确认；请在 App 核对。',504);}
  if(response.errno!==0)throw new OwnerError('官方未确认结束房间（errno '+response.errno+'）。');
  // The room is gone: nothing left to remute or leave. Quit presence if the official side still takes it, then drop the permit.
  current.unmuted=false;current.acquiredSeat=false;
  try{await cleanup(current,request);}catch{}
  timers.clearTimeout(current.timer);if(permit===current)permit=null;
  return {destroyed:true};
 });
 const claimBox=(channel,request,proof,ids)=>serial(async()=>{authorize(channel,proof);
  if(!id(ids?.lucky_box_id)||!id(ids?.issue_user_id))throw new OwnerError('宝箱参数无效。',400);
  const result=await inspect(channel,request);authorize(channel,proof);
  const response=await writeBox({anchor_id:result.anchor,lucky_box_id:ids.lucky_box_id,issue_user_id:ids.issue_user_id},request,{expectedIdentity:result.who.identity});
  authorize(channel,proof);
  if(response.errno!==0)throw new OwnerError('宝箱领取未成功（官方 errno '+response.errno+'）。');
  arm(request);return {claimed:true,lucky_box_id:ids.lucky_box_id};
 });
 const createRoom=(body,request)=>{const who=identity();if(!who)throw new OwnerError('需要有效的 App 会话。',403);
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['name','label_id','auto_pass','confirmed','request_id','tags'].includes(k)))throw new OwnerError('开房参数无效。');
  const name=typeof body.name==='string'?body.name.trim().slice(0,40):'',tags=roomTags(body.tags);
  if(!name||!/^[1-9][0-9]{0,8}$/.test(body.label_id||'')||body.confirmed!==true||typeof body.request_id!=='string'||
   !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.request_id))throw new OwnerError('请填写房间名、分类并明确确认开房。');
  const key=who.identity+':'+body.request_id,payload=JSON.stringify([name,body.label_id,!!body.auto_pass,tags]);
  for(const [k,r]of createdRooms)if(r.expires<=now())createdRooms.delete(k);
  const old=createdRooms.get(key);if(old){if(old.payload!==payload)throw new OwnerError('提交编号已用于另一间房。',409);return old.work;}
  if(createdRooms.size>=16)throw new OwnerError('开房记录已满，请稍后再试。',429);
  let submitted=false;
  const work=serial(async()=>{if(identity()?.identity!==who.identity)throw new OwnerError('账号会话已变化，开房未执行。',409);
   const extra={star_id:'0',name,label_id:String(body.label_id),is_3D:'0',tags,bg_id:'0',game_id:'0',
    room_permission:'0',room_type:'0',auto_pass:body.auto_pass===true?'1':'0',sync_feed:'-1'};
   let created;try{submitted=true;created=await writeCreate(extra,request,{expectedIdentity:who.identity});}
   catch{throw new OwnerError('开房结果未确认；不会自动重试，请在 App 核对。',504);}
   if(created.errno!==0)throw new OwnerError('开房未成功，请稍后在 App 核对。');
   const raw=created.data,channel=id(raw)?raw:exactId(raw?.channel_id||raw?.room_info?.channel_id||raw?.roomId);
   const info=await read('roomInfo',{channel_id:channel},request,{expectedIdentity:who.identity});
   const room=info.data?.room_info;if(info.errno!==0||room?.channel_id!==channel)throw new OwnerError('房间已创建，但详情暂不可读；请刷新房间列表。',502);
   return {channel_id:channel,anchor_id:exactId(room.user_id),title:typeof room.name==='string'?room.name.slice(0,200):name,auto_pass:room.auto_pass===1,tags};
  });createdRooms.set(key,{payload,work,expires:now()+3600000});
  work.catch(()=>{if(!submitted&&createdRooms.get(key)?.work===work)createdRooms.delete(key);});return work;
 };
 // Room preview without entering: signed read only, no RTC/RTM, no presence,
 // no greeting. Anyone with a valid session can peek at any room card first.
 // The audition view renders this inline so trial looks like the entered room.
 const preview=(channel,request)=>serial(async()=>{
  const who=context(channel);
  const response=await previewRead({channel_id:channel},request,{expectedIdentity:who.identity});
  if(identity()?.identity!==who.identity)throw new OwnerError('账号会话已变化。',409);
  if(response.errno!==0)throw new OwnerError('房间预览暂不可用。');
  const info=response.data||{};
  const anchor=String(info.user_id??info.anchor_id??'');
  // getRoomPreviewInfo leaves group_user_list/user_count empty even in live rooms
  // (verified against a room with 9 people inside). The real roster comes from
  // roomMemberList, which is readable without entering; mic seats come from the
  // same anchorUserList the entered view uses.
  let members=[],seats=[];
  if(id(anchor)){
   try{
    const {rows}=await memberRows(channel,anchor,request,'');
    members=[...new Map(rows.flatMap(row=>{try{const p=publicPerson(row,who);return [[p.user_id,p]];}catch{return [];}})).values()].slice(0,100);
   }catch{members=[];}
   try{
    const seatResponse=await read('seats',{channel_id:channel},request,{expectedIdentity:who.identity});
    if(seatResponse.errno===0&&verify(seatResponse.data).reportedDigestVerified){
     seats=seatResponse.data.anchor_user_list.map(row=>({seat_id:row.seat_id,muted:row.mute_type===1,
      person:String(row.user?.user_id||'0')==='0'?null:publicPerson(row,who)}));
    }
   }catch{seats=[];}
   try{
    const unknown=[...new Set([...members,...seats.map(s=>s.person).filter(Boolean)].filter(p=>!p.country).map(p=>p.user_id))];
    if(unknown.length){const country=await people.lookup(unknown,request,{expectedIdentity:who.identity});
     for(const p of [...members,...seats.map(s=>s.person).filter(Boolean)])if(!p.country)p.country=country(p.user_id);}
   }catch{}
  }
  if(identity()?.identity!==who.identity)throw new OwnerError('账号会话已变化。',409);
  return {channel_id:channel,title:typeof info.name==='string'?info.name.slice(0,200):'',
   room_type:Number.isSafeInteger(info.room_type)?info.room_type:0,user_count:members.length,
   anchor_id:id(anchor)?anchor:'',members,seats};
 });
 // Force quit: drop the server permit immediately so a stuck page (or a
 // refreshed tab that lost its proof) can re-enter at once. No upstream
 // calls: official presence expires without heartbeats, and the next
 // connect kicks stale occupancy via Enter-retry. Never touches another
 // identity's permit except stale leftovers from a changed login.
 const forceRelease=(channel,request)=>{
  const who=identity();
  if(!who)throw new OwnerError('需要有效的 App 会话。',403);
  if(channel!=null&&channel!==''&&!id(channel))throw new OwnerError('房间参数无效。',400);
  const current=permit;
  if(!current)return {released:true,forced:false,channel:channel||null};
  timers.clearTimeout(current.timer);
  permit=null;
  return {released:true,forced:true,channel:current.channel||channel||null};
 };
 // Internal only: never expose a room authorization, proof or identity to the public status API.
 function rewardContext(){const who=identity();
  if(!who||!permit||permit.identity!==who.identity||!permit.entered||!permit.enterConfirmed||permit.cleanupPending||permit.expires<=now()||!id(permit.anchor))return null;
  return {identity:who.identity,channel_id:permit.channel,anchor_id:permit.anchor,entered_at:permit.enteredAt??null};
 }
 return {status,board,connect,enter,apply,publisher,renew,mute,leave,release,forceRelease,drain,destroy,claimBox,createRoom,seatMute,kick,updateRoom,preview,rewardContext,busy:()=>!!permit};
}
module.exports={createMemberService,loadMemberIdentity,publicPerson};

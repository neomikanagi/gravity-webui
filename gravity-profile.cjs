'use strict';
const api=require('./gravity-api.cjs');
const {loadMemberIdentity}=require('./gravity-member.cjs');
const {validId,clipped,countryCode,officialCdnImage,createSerial}=require('./gravity-util.cjs');
const {post,validCursor}=require('./gravity-feed.cjs');
const {officialUser}=require('./gravity-im-message.cjs');
class ProfileError extends Error{constructor(message,status=400){super(message);this.status=status;}}
const exactId=value=>typeof value==='number'&&!Number.isSafeInteger(value)?'':String(value??'');
function publicProfile(row){
 const id=exactId(row?.user_id);if(!validId(id)||officialUser(id))return null;
 const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
 return {user_id:id,name:clipped(row.name,80),portrait:officialCdnImage(row.portrait),custom_id:clipped(row.custom_id,40),
  bio:clipped(row.profile,2000),country:countryCode(row.user_country),character:clipped(row.ext?.character_attribute,80),
  online:row.ext?.online_status===1,counts:{fans:count(row.ext?.fans),following:count(row.ext?.follow),friends:count(row.ext?.friends)}};
}
function createProfileService({read=api.readSignedVoice,readRelation=api.readRelationList,readGifts=api.readGiftRecords,readFoot=api.readFootprints,write=api.writeProfileBlock,identity=loadMemberIdentity,now=Date.now,onPeople=()=>{},onBlocked=()=>{}}={}){
 let currentIdentity=null;
 const profiles=new Map(),receipts=new Map();
 const serial=createSerial(4,()=>new ProfileError('拉黑操作正在处理，请稍后重试。',429));
 function account(){const who=identity();if(!who)throw new ProfileError('官方账号会话不可用，请先恢复会话。',401);
  if(currentIdentity!==who.identity){profiles.clear();receipts.clear();currentIdentity=who.identity;}return who;}
 function same(who){if(account().identity!==who.identity)throw new ProfileError('账号会话已变化，请重新打开资料。',409);}
 function target(peer){if(!validId(peer)||officialUser(peer))throw new ProfileError('只能查看普通用户资料。');}
 async function signed(kind,extra,request,who,reader=read){same(who);const r=await reader(kind,extra,request,{expectedIdentity:who.identity});same(who);
  if(r.errno!==0)throw new ProfileError([40025,40026].includes(r.errno)?'官方会话已失效，请同步 App 会话。':'资料或帖子暂不可见，请稍后重试。',503);return r.data;}
 function relationPerson(row){
  const id=exactId(row?.user_id);if(!validId(id)||officialUser(id))return null;
  return {user_id:id,name:clipped(row.name,80),portrait:officialCdnImage(row.portrait),
   country:countryCode(row.user_country)||countryCode(row.ext?.user_country),
   online:row.ext?.online_status===1};
 }
 // Anyone's following/fans pages: the same endpoint the App's profile tabs use.
 async function relationList(kind,peer,cursor='',request){const who=account();target(peer);
  if(!['following','fans'].includes(kind))throw new ProfileError('名单参数无效。');
  if(typeof cursor!=='string'||(cursor&&!validCursor(cursor)))throw new ProfileError('分页参数无效。');
  const data=await signed(kind,{target_id:peer,...(cursor?{last_id:cursor}:{})},request,who,readRelation);
  if(!Array.isArray(data?.list))throw new ProfileError('名单数据不完整。',502);
  const people=data.list.slice(0,100).map(relationPerson).filter(p=>p&&p.user_id!==who.user);
  const next=validCursor(data.last_id)&&data.last_id!==cursor?data.last_id:'';
  return {user_id:peer,people,next_cursor:next};
 }
 function giftItem(row){
  const id=Number(row?.id);
  if(!Number.isSafeInteger(id)||id<1||typeof row?.name!=='string'||!row.name)return null;
  const price=Number(row?.price);
  return {id:String(id),name:clipped(row.name,80),image:officialCdnImage(row.preview_url),
   price:Number.isSafeInteger(price)&&price>=0?price:null};
 }
 // Footprint tabs: who visited me (0) / who I visited (1). Read-only.
 async function footprints(tab,cursor='',request){const who=account();
  if(![0,1].includes(tab))throw new ProfileError('足迹参数无效。');
  if(typeof cursor!=='string'||(cursor&&!/^[0-9|]{0,64}$/.test(cursor)))throw new ProfileError('分页参数无效。');
  same(who);
  const r=await readFoot({tab_type:tab,...(cursor?{last_id:cursor}:{})},request,{expectedIdentity:who.identity});
  same(who);
  if(r.errno!==0)throw new ProfileError([40025,40026].includes(r.errno)?'官方会话已失效，请同步 App 会话。':'足迹暂不可见，请稍后重试。',503);
  const rows=Array.isArray(r.data?.list)?r.data.list:[];
  const stamp=v=>{const t=new Date((Number(v)||0)*1000);return Number.isFinite(t.getTime())?t.toLocaleDateString()+' '+t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';};
  const items=rows.slice(0,100).map(row=>{
   const user=row?.user&&typeof row.user==='object'?row.user:null;
   const raw=user?.user_id,id=typeof raw==='number'&&Number.isSafeInteger(raw)?String(raw):String(raw??'');
   if(!validId(id)||officialUser(id))return null;
   const visits=Number(row?.visit_count);
   return {user_id:id,name:clipped(user.name,80),portrait:officialCdnImage(user.portrait),
    visits:Number.isSafeInteger(visits)&&visits>0?visits:1,last_visit:stamp(row?.last_visit_time)};
  }).filter(Boolean);
  const next=typeof r.data?.last_id==='string'&&/^[0-9|]{0,64}$/.test(r.data.last_id)&&r.data.last_id!==cursor?r.data.last_id:'';
  return {tab,visitors:items,next_cursor:next};
 }
 async function gifts(peer,listType,request){const who=account();target(peer);
  if(!['receive','send'].includes(listType))throw new ProfileError('礼物列表参数无效。');
  same(who);
  const r=await readGifts({list_type:listType,target_id:peer},request,{expectedIdentity:who.identity});
  same(who);
  if(r.errno!==0)throw new ProfileError([40025,40026].includes(r.errno)?'官方会话已失效，请同步 App 会话。':'礼物墙暂不可见，请稍后重试。',503);
  const data=r.data,rows=Array.isArray(data?.list)?data.list:[];
  const stat=data?.statistic&&typeof data.statistic==='object'?data.statistic:null;
  const num=v=>Number.isSafeInteger(v)&&v>=0?v:(typeof v==='number'&&Number.isFinite(v)&&v>=0?Math.floor(v):null);
  return {user_id:peer,list_type:listType,
   items:rows.slice(0,100).map(giftItem).filter(Boolean),
   statistic:stat?{coins:num(stat.coins),points:num(stat.points),total_gift_kind:num(stat.total_gift_kind)}:null};
 }
 async function person(peer,request){const who=account();target(peer);
  const cached=profiles.get(peer);if(cached&&cached.expires>now())return cached.person;
  const raw=await signed('userDetail',{target_id:peer},request,who),p=publicProfile(raw);
  if(!p||p.user_id!==peer)throw new ProfileError('用户资料不完整或已不可见。',404);
  try{onPeople([{user_id:peer,relation:raw.ext?.relation,name:p.name}]);}catch{}
  if(raw.should_hidden===1)throw new ProfileError('对方资料暂不可见。',403);
  while(profiles.size>=64)profiles.delete(profiles.keys().next().value);
  profiles.set(peer,{person:p,expires:now()+30000});return p;
 }
 async function posts(peer,cursor='',loaded='0',request){const who=account();target(peer);
  if(!validCursor(cursor)||typeof loaded!=='string'||!/^\d{1,5}$/.test(loaded)||Number(loaded)>10000)throw new ProfileError('个人帖子分页参数无效。');
  await person(peer,request);same(who);
  const data=await signed('personalFeed',{target_id:peer,last_id:cursor,accumulated_feed_cnt:loaded},request,who);
  if(!Array.isArray(data?.list)||data.list.length>100)throw new ProfileError('个人帖子数据不完整。',502);
  // Same official wrapper as feeds; don't relabel a recommendation or somebody else's post as this person's.
  const rows=data.list.filter(x=>x?.type==='r_feed').map(x=>post(x.content_feed)).filter(p=>p&&p.author.user_id===peer);
  return {user_id:peer,posts:[...new Map(rows.map(p=>[p.id,p])).values()],
   next_cursor:data.list.length&&validCursor(data.last_id)&&data.last_id!==cursor?data.last_id:'',loaded_count:Number(loaded)+data.list.length};
 }
 function blockHost(body,request){const who=account();
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['channel_id','expected_anchor_id','confirmed','request_id'].includes(k)))throw new ProfileError('拉黑参数无效。');
  const {channel_id,expected_anchor_id,confirmed,request_id}=body;
  if(!validId(channel_id)||!validId(expected_anchor_id)||confirmed!==true||typeof request_id!=='string'||
   !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request_id))throw new ProfileError('需要明确确认当前房间房主。');
  const key=who.identity+':'+request_id,payload=JSON.stringify([channel_id,expected_anchor_id]);
  for(const [k,r]of receipts)if(r.expires<=now())receipts.delete(k);
  const old=receipts.get(key);if(old){if(old.payload!==payload)throw new ProfileError('提交编号已用于其他房主。',409);return old.work;}
  if(receipts.size>=64)throw new ProfileError('操作记录已满，请稍后再试。',429);
  let submitted=false;
  const work=serial(async()=>{
   const data=await signed('roomInfo',{channel_id},request,who),room=data?.room_info;
   if(room?.channel_id!==channel_id)throw new ProfileError('房间已变化，拉黑未执行。',409);
   const anchor=exactId(room.user_id);
   if(!validId(anchor)||anchor!==expected_anchor_id)throw new ProfileError('房主已变化，拉黑未执行。',409);
   if(anchor===who.user||officialUser(anchor))throw new ProfileError('不能拉黑自己或官方账号。',403);
   same(who);let result;
   try{submitted=true;result=await write({target_user_id:anchor,action:'block'},request,{expectedIdentity:who.identity});}
   catch{throw new ProfileError('拉黑结果未确认；不会自动重试，请在 App 核对黑名单。',504);}
   same(who);
   if(result.errno!==0)throw new ProfileError('官方未确认拉黑成功；不会自动重试。',502);
   profiles.delete(anchor);try{onBlocked(anchor);}catch{}return {blocked:true,user_id:anchor,channel_id};
  });receipts.set(key,{payload,work,expires:now()+3600000});
  work.catch(()=>{if(!submitted&&receipts.get(key)?.work===work)receipts.delete(key);});return work;
 }
 function blockUser(body,request){const who=account();
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['target_user_id','confirmed','request_id'].includes(k)))throw new ProfileError('拉黑参数无效。');
  const {target_user_id,confirmed,request_id}=body;
  if(!validId(target_user_id)||confirmed!==true||typeof request_id!=='string'||
   !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request_id))throw new ProfileError('需要明确确认要拉黑的用户。');
  if(target_user_id===who.user||officialUser(target_user_id))throw new ProfileError('不能拉黑自己或官方账号。',403);
  const key=who.identity+':user:'+request_id,payload=target_user_id;
  for(const [k,r]of receipts)if(r.expires<=now())receipts.delete(k);
  const old=receipts.get(key);if(old){if(old.payload!==payload)throw new ProfileError('提交编号已用于其他人。',409);return old.work;}
  if(receipts.size>=64)throw new ProfileError('操作记录已满，请稍后再试。',429);
  let submitted=false;
  const work=serial(async()=>{same(who);let result;
   try{submitted=true;result=await write({target_user_id,action:'block'},request,{expectedIdentity:who.identity});}
   catch{throw new ProfileError('拉黑结果未确认；不会自动重试，请在 App 核对黑名单。',504);}
   same(who);
   if(result.errno!==0)throw new ProfileError('官方未确认拉黑成功；不会自动重试。',502);
   profiles.delete(target_user_id);try{onBlocked(target_user_id);}catch{}return {blocked:true,user_id:target_user_id};
  });receipts.set(key,{payload,work,expires:now()+3600000});
  work.catch(()=>{if(!submitted&&receipts.get(key)?.work===work)receipts.delete(key);});return work;
 }
 return {person,posts,relationList,gifts,footprints,blockHost,blockUser};
}
module.exports={ProfileError,publicProfile,createProfileService};

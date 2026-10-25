'use strict';
const crypto=require('node:crypto'),api=require('./gravity-api.cjs');
const {loadMemberIdentity}=require('./gravity-member.cjs');
const {officialCdnImage:image,countryCode}=require('./gravity-util.cjs');
const {createCountryResolver}=require('./gravity-people.cjs');
class FeedError extends Error{constructor(message,status=400){super(message);this.status=status;}}
const validSid=s=>typeof s==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(s);
const validCursor=s=>typeof s==='string'&&(s===''||(s.length<=2000&&/^[A-Za-z0-9_.:{}[\]",\\ -]+$/.test(s)&&!s.includes('..')&&!/https?:|javascript:/i.test(s)));
const clip=(v,n)=>typeof v==='string'?v.slice(0,n):'';
function person(p){const id=typeof p?.user_id==='number'&&!Number.isSafeInteger(p.user_id)?'':String(p?.user_id||'');
 if(!/^[1-9][0-9]{0,19}$/.test(id))return null;return {user_id:id,name:clip(p.name,80),portrait:image(p.portrait),
  country:countryCode(p.user_country)||countryCode(p.ext?.user_country)};}
const FEED_TYPE={recommended:'feed8',following:'feed6',latest:'feed5'};
function voteMeta(p){const ext=p?.ext&&typeof p.ext==='object'?p.ext:{};
 const count=p.vote_count??ext.vote_count;
 return {collected:Number(p.is_vote??ext.is_vote)===1,collect_count:Number.isSafeInteger(count)&&count>=0?count:0,can_collect:true};}
function post(p){if(!validSid(p?.id)||!person(p.user))return null;return {id:p.id,author:person(p.user),title:clip(p.title,500),text:clip(p.desc,10000),
 images:(Array.isArray(p.attaches)?p.attaches:[]).map(x=>image(x?.url)).filter(Boolean).slice(0,9),time:Number.isSafeInteger(p.time)?p.time:0,
 comment_count:Number.isSafeInteger(p.comment_count)&&p.comment_count>=0?p.comment_count:0,can_reply:p.allow_comment===1,...voteMeta(p)};}
function threadReply(p,sid,parent){if(!validSid(p?.id)||!person(p.user)||p.is_delete===1||p.comment_id!==parent||(p.sid!=null&&p.sid!==sid))return null;
 return {id:p.id,author:person(p.user),text:clip(p.content,4000),time:Number.isSafeInteger(p.time)?p.time:0};}
function comment(p,sid){if(!validSid(p?.id)||!person(p.user)||(p.sid!=null&&p.sid!==sid))return null;
 return {id:p.id,author:person(p.user),text:clip(p.content,4000),time:Number.isSafeInteger(p.time)?p.time:0,
  replies:(Array.isArray(p.reply)?p.reply:[]).slice(0,10).map(r=>threadReply(r,sid,p.id)).filter(Boolean),
  has_more_replies:p.reply_has_more===1};}
// ledger (from the tasks service): the persisted once-per-post memory and daily cap
// shared by the page's auto-likes and the background liker.
function createFeedService({read=api.readSignedVoice,write=api.writeFeed,identity=loadMemberIdentity,now=Date.now,people=createCountryResolver(),ledger=null}={}){
 const tickets=new Map(),receipts=new Map(),lastWrite=new Map(),seen=new Map();
 function account(){const who=identity();if(!who)throw new FeedError('官方账号会话不可用，请先恢复会话。',401);return who;}
 function checked(r){if(r.errno!==0)throw new FeedError([40025,40026].includes(r.errno)?'官方会话已失效，请同步 App 会话。':'帖子接口暂不可用。',503);return r.data;}
 function remember(who,sid,feedType){if(!validSid(sid))return;for(const [k,t]of seen)if(t.expires<=now())seen.delete(k);
  const key=who.identity+':'+sid,prev=seen.get(key),keep=prev&&prev.expires>now()?prev.feedType:'';
  const type=/^feed[0-9]{1,2}$/.test(feedType||'')?feedType:(keep||'feed8');
  seen.set(key,{expires:now()+900000,feedType:type});while(seen.size>=256)seen.delete(seen.keys().next().value);}
 function remembered(who,sid){const t=seen.get(who.identity+':'+sid);return t&&t.expires>now()?t:null;}
 async function list(mode,cursor,request){const who=account();if(!['recommended','following','latest'].includes(mode)||!validCursor(cursor))throw new FeedError('帖子列表参数无效。');
 const kind={recommended:'feedRecommended',following:'feedFollowing',latest:'feedLatest'}[mode];
 const data=checked(await read(kind,{last_id:cursor},request));if(!Array.isArray(data?.list))throw new FeedError('帖子数据不完整。',502);
 const posts=data.list.slice(0,100).filter(x=>x?.type==='r_feed').map(x=>post(x.content_feed)).filter(Boolean);
 posts.forEach(p=>remember(who,p.id,FEED_TYPE[mode]));
 // Feed rows carry no country of their own; resolve the unknown authors in one batch (cached).
 const unknown=[...new Map(posts.filter(p=>!p.author.country).map(p=>[p.author.user_id,p.author])).values()];
 if(unknown.length){const country=await people.lookup(unknown.map(a=>a.user_id),request,{expectedIdentity:who.identity});
  for(const a of unknown)a.country=country(a.user_id);}
 const next=validCursor(data.last_id)&&data.last_id!==cursor?data.last_id:'';return {posts,next_cursor:next};
 }
 async function detail(sid,cursor,request){const who=account();if(!validSid(sid)||!validCursor(cursor))throw new FeedError('帖子参数无效。');
 const raw=checked(await read('feedDetail',{sid},request)),feed=post(raw);if(!feed||feed.id!==sid)throw new FeedError('帖子已删除或无权查看。',404);
 remember(who,feed.id);
 const data=checked(await read('feedComments',{sid,last_id:cursor},request));if(!Array.isArray(data?.list))throw new FeedError('评论列表不完整。',502);
 if(identity()?.identity!==who.identity)throw new FeedError('账号已变化，请重新打开帖子。',403);
 const comments=data.list.slice(0,100).map(p=>comment(p,sid)).filter(Boolean);
 for(const [key,t]of tickets)if(t.expires<=now())tickets.delete(key);
 while(tickets.size>=64)tickets.delete(tickets.keys().next().value);
 const permit=crypto.randomUUID();tickets.set(permit,{sid,identity:who.identity,author:feed.author.user_id,comments:new Map(comments.map(c=>[c.id,c.author.user_id])),expires:now()+900000});
 return {post:feed,comments,next_cursor:validCursor(data.last_id)&&data.last_id!==cursor?data.last_id:'',reply_permit:permit};
 }
 async function reply(body,request){const who=account();if(!body||typeof body!=='object'||Array.isArray(body))throw new FeedError('回复参数无效。');
 const {sid,comment_id='',content,reply_permit,request_id,confirmed}=body;
 if(!validSid(sid)||typeof comment_id!=='string'||(comment_id&&!validSid(comment_id))||typeof content!=='string'||!content.trim()||content.trim().length>500||confirmed!==true||
  typeof request_id!=='string'||!/^[a-f0-9-]{36}$/.test(request_id))throw new FeedError('回复需确认目标和 1～500 字文字。');
 const key=who.identity+':'+request_id,payload=JSON.stringify([sid,comment_id,content.trim()]);
 for(const [k,r]of receipts)if(r.expires<=now())receipts.delete(k);
 const old=receipts.get(key);if(old){if(old.payload!==payload)throw new FeedError('该提交编号已用于另一条回复。',409);return old.work;}
 const ticket=tickets.get(reply_permit);
 if(!ticket||ticket.sid!==sid||ticket.identity!==who.identity||ticket.expires<=now()||(comment_id&&!ticket.comments.has(comment_id)))throw new FeedError('回复授权过期，请重新打开帖子。',403);
 if(receipts.size>=128)throw new FeedError('提交记录已满，请稍后再试。',429);
 if(lastWrite.has(who.identity)&&now()-lastWrite.get(who.identity)<2000)throw new FeedError('请稍等两秒再回复。',429);
 lastWrite.set(who.identity,now());
 let submitted=false;
 const work=(async()=>{const raw=checked(await read('feedDetail',{sid},request));const feed=post(raw);
  if(!feed||feed.id!==sid||!feed.can_reply||feed.author.user_id!==ticket.author||identity()?.identity!==who.identity)throw new FeedError('帖子已关闭评论、不可访问或账号已变化。',403);
  const extra=comment_id?{sid,comment_id,content:content.trim(),content_type:'0',b_user_id:ticket.comments.get(comment_id),a_user_id:ticket.author,route_path:'feedDetail'}
   :{sid,content:content.trim(),content_type:'0',to_user_id:ticket.author,route_path:'feedDetail'};
  let result;try{submitted=true;result=await write(comment_id?'feedReply':'feedComment',extra,request,{expectedIdentity:who.identity});}catch{throw new FeedError('提交结果未确认；不要重复发送，请先刷新评论查看。',502);}
  if(result.errno!==0)throw new FeedError('官方未确认回复成功（'+result.errno+'）；不会自动重发。',502);
  return {posted:true,id:clip(result.data?.comment_id||result.data?.reply_id,160),reply:comment_id?threadReply(result.data?.reply,sid,comment_id):null};
 })();receipts.set(key,{payload,work,expires:now()+3600000});
 // Only a confirmed preflight failure may be tried again; once write starts keep even unknown outcomes.
 work.catch(()=>{if(!submitted&&receipts.get(key)?.work===work)receipts.delete(key);});return work;
 }
 async function collect(body,request){const who=account();if(!body||typeof body!=='object'||Array.isArray(body))throw new FeedError('点赞参数无效。');
 const {sid,collected,confirmed,request_id,auto=false}=body;
 if(!validSid(sid)||typeof collected!=='boolean'||confirmed!==true||typeof request_id!=='string'||!/^[a-f0-9-]{36}$/.test(request_id)||typeof auto!=='boolean'||(auto&&!collected))throw new FeedError('点赞需确认已打开的帖子。');
 const mem=remembered(who,sid);if(!mem)throw new FeedError('请先打开或刷新帖子再点赞。',403);
 // An automatic like never repeats a post already auto-liked or unliked by hand, and stops at the day's cap.
 if(auto&&ledger){const gate=ledger.allowAuto(sid);if(!gate.ok)return {skipped:true,capped:!!gate.capped};}
 const key=who.identity+':collect:'+request_id,payload=JSON.stringify([sid,collected]);
 for(const [k,r]of receipts)if(r.expires<=now())receipts.delete(k);
 const old=receipts.get(key);if(old){if(old.payload!==payload)throw new FeedError('该提交编号已用于另一条点赞。',409);return old.work;}
 if(receipts.size>=128)throw new FeedError('提交记录已满，请稍后再试。',429);
 let submitted=false;
 const work=(async()=>{const raw=checked(await read('feedDetail',{sid},request)),feed=post(raw);
  if(!feed||feed.id!==sid||identity()?.identity!==who.identity)throw new FeedError('帖子已删除、不可访问或账号已变化。',403);
  if(feed.collected===collected)return {collected:feed.collected,collect_count:feed.collect_count};
  if(lastWrite.has(who.identity)&&now()-lastWrite.get(who.identity)<2000)throw new FeedError('请稍等两秒再操作。',429);
  lastWrite.set(who.identity,now());
  let result;try{submitted=true;result=await write('feedVote',{id:sid,vote:collected?'1':'0',to_user_id:feed.author.user_id,type:'f',feed_type:mem.feedType,route_path:''},request,{expectedIdentity:who.identity});}
  catch{throw new FeedError('点赞结果未确认；不要重复提交，请先刷新帖子查看。',502);}
  if(result.errno!==0)throw new FeedError('官方未确认点赞（'+result.errno+'）；不会自动重发。',502);
  try{if(auto)ledger?.autoLiked(sid);else if(!collected)ledger?.cancelled(sid);}catch{}
  const count=feed.collect_count+(collected?1:-1);
  return {collected,collect_count:count<0?0:count};
 })();receipts.set(key,{payload,work,expires:now()+3600000});
 work.catch(()=>{if(!submitted&&receipts.get(key)?.work===work)receipts.delete(key);});return work;
 }
 async function clearCollections(request,{limit=2000,gapMs=400,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  const who=account();const seenIds=new Set();let cancelled=0,failed=0,scanned=0,cursor='';
  for(let page=0;page<80&&cancelled+failed<limit;page++){
   const data=checked(await read('feedCollected',{last_id:cursor},request,{expectedIdentity:who.identity}));
   if(!Array.isArray(data?.list)||!data.list.length)break;
   const ids=[];
   for(const row of data.list.slice(0,100)){
    const feed=row?.type==='r_feed'?row.content_feed:row;
    if(validSid(feed?.id)&&!seenIds.has(feed.id)){seenIds.add(feed.id);ids.push(feed.id);}
   }
   scanned+=Math.min(data.list.length,100);
   if(!ids.length){
    const next=validCursor(data.last_id)&&data.last_id!==cursor?data.last_id:'';
    if(!next)break;cursor=next;continue;
   }
   for(const id of ids){
    if(cancelled+failed>=limit)break;
    if(identity()?.identity!==who.identity)throw new FeedError('账号已变化，收藏清理已停止。',403);
    const result=await write('feedCollect',{id,action:'cancel'},request,{expectedIdentity:who.identity});
    if(result.errno===0)cancelled++;else failed++;
    if(gapMs)await wait(gapMs);
   }
   cursor='';
  }
  return {cancelled,failed,scanned};
 }
 return {list,detail,reply,collect,clearCollections};
}
module.exports={createFeedService,FeedError,post,comment,threadReply,image,validSid,validCursor};

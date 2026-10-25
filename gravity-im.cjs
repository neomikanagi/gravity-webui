'use strict';
// Friends use signed HTTP reads. Private chat uses the App's native IM; no account token reaches the browser.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const api = require('./gravity-api.cjs');
const {loadMemberIdentity} = require('./gravity-member.cjs');
const {validId, clipped, officialCdnImage, sniffImage, countryCode, createSerial} = require('./gravity-util.cjs');
const {ImCore} = require('./gravity-imcore.cjs');
const M = require('./gravity-im-message.cjs');
class ImError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const KEEP = 100, MAX_CHATS = 50, IDLE_MS = 10 * 60 * 1000;
const SEND_ERRORS = {11003:'服务端处理失败，消息未发出。',11006:'消息太长，未发出。',11008:'对方已拒收你的消息。',
  11009:'你已被对方屏蔽，消息未发出。',11010:'找不到该用户，消息未发出。',11005:'无效的用户，消息未发出。'};
function deviceToken(file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')).deviceToken; if (/^[0-9a-f]{32}@@@$/.test(v)) return v; } catch {}
  const created = crypto.randomBytes(16).toString('hex') + '@@@';
  try { fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700}); fs.writeFileSync(file, JSON.stringify({deviceToken:created}), {mode:0o600}); } catch {}
  return created;
}
function publicPerson(row) {
  const raw = row?.user_id;
  const id = typeof raw === 'number' && !Number.isSafeInteger(raw) ? '' : String(raw ?? '');
  if (!validId(id) || M.officialUser(id)) return null;
  return {user_id:id, name:clipped(row.name,80), portrait:officialCdnImage(row.portrait), online:row.ext?.online_status === 1,
   country:countryCode(row.user_country)||countryCode(row.ext?.user_country)};
}
function createImService({read=api.readSignedVoice, write=api.writeProfileBlock, uploadImage=api.writePrivateImage, identity=loadMemberIdentity, now=Date.now, timers=globalThis, onBlocked=()=>{},
  createCore=options=>new ImCore(options), connectTimeoutMs=25000,
  stateFile=path.join(path.dirname(process.env.GRAVITY_ACCOUNT_STATE_FILE || path.join(__dirname,'.session/account-state.json')),'im-device.json')}={}) {
  let core=null, accountIdentity=null, state='idle', lastTouch=0, idleTimer=null, blocked=0, profile=null, token;
  let generation=0;
  const chats=new Map(), people=new Map(), receipts=new Map(), sends=[];
  const serial=createSerial(4,()=>new ImError('私信正在处理，请稍后重试。',429));
  function closeCore(next='idle') {
    const old=core; core=null; state=next;
    if(idleTimer){timers.clearInterval(idleTimer);idleTimer=null;}
    try{old?.close();}catch{}
  }
  function reset() {closeCore();chats.clear();people.clear();receipts.clear();sends.length=0;profile=null;blocked=0;generation++;lastSyncAt=0;}
  function account() {
    const who=identity();
    if(!who){if(accountIdentity!==null){reset();accountIdentity=null;}throw new ImError('官方账号会话不可用，请先恢复会话。',401);}
    if(accountIdentity!==who.identity){reset();accountIdentity=who.identity;}
    return who;
  }
  function same(who) {if(account().identity!==who.identity)throw new ImError('账号会话已变化，请重新打开聊天。',409);}
  function touch() {
    lastTouch=now();
    if(core&&!idleTimer){idleTimer=timers.setInterval(()=>{if(core&&now()-lastTouch>IDLE_MS)closeCore();},60000);idleTimer.unref?.();}
  }
  const signed=async(kind,extra,request,who)=>{
    same(who);
    const r=await read(kind,extra,request,{expectedIdentity:who.identity});
    same(who);return r;
  };
  async function ensureCore(request,who) {
    same(who);
    if(!core){
      token??=deviceToken(stateFile);
      const fresh=core=createCore({deviceToken:token,now,credentials:async()=>{
        const r=await signed('imToken',{},request,who);
        if(r.errno!==0||typeof r.data?.token!=='string'||String(r.data?.userID)!==who.user)throw new ImError('私信凭证暂不可用，请检查 App 会话。',503);
        return {userId:who.user,token:r.data.token};
      }});
      state='connecting';
      fresh.on('message',buffer=>{if(core===fresh){try{same(who);ingest(buffer,who.user);}catch{}}});
      fresh.on('kicked',()=>{if(core===fresh)closeCore('kicked');});
      fresh.on('lost',()=>{if(core===fresh)closeCore();});
    }
    const current=core;
    let timeout;
    try{
      await Promise.race([current.ready(),new Promise((_,reject)=>{timeout=timers.setTimeout(()=>reject(new ImError('私信连接超时，请手动重试。',503)),connectTimeoutMs);})]);
      same(who);
      if(core!==current)throw new ImError('私信连接已断开，请手动重新连接。',409);
      state='ready';touch();return current;
    }catch(error){
      if(core===current)closeCore();
      throw error instanceof ImError?error:new ImError('私信连接失败，请手动重新连接。',503);
    }finally{timers.clearTimeout(timeout);}
  }
  function active() {
    if(!core||state!=='ready')throw new ImError(state==='kicked'?'私信连接已让给其他设备，请点「重新连接」。':'私信未连接，请点「重新连接」。',409);
    touch();return core;
  }
  function chatState(peer) {
    let chat=chats.get(peer);
    if(!chat){
      if(chats.size>=MAX_CHATS)chats.delete(chats.keys().next().value);
      chat={messages:[],keys:new Set(),loaded:false,loading:null,unread:0,openedAt:0,permit:crypto.randomUUID()};chats.set(peer,chat);
    }
    return chat;
  }
  function add(chat,message) {
    if(chat.keys.has(message.id))return false;
    chat.keys.add(message.id);chat.messages.push(message);chat.messages.sort((a,b)=>a.time-b.time);
    while(chat.messages.length>KEEP)chat.keys.delete(chat.messages.shift().id);
    return true;
  }
  function toMessage(buffer,me) {
    let m;try{m=M.parseOneMsg(buffer);}catch{return null;}
    if(m.chatType!==1)return null;
    // The wire speaks user ids or RC ids (byte-swapped); resolve through whichever
    // side matches us instead of assuming one space, or live messages get dropped.
    const rcMe=M.rcId(me);
    const fromMe=m.from===me,fromMeRc=m.from===rcMe;
    const toMe=m.to===me,toMeRc=m.to===rcMe;
    const mine=fromMe||fromMeRc;
    if(!mine&&!toMe&&!toMeRc)return null;
    const other=mine?m.to:m.from;
    const peer=(fromMe||toMe)?other:M.rcId(other);
    if(!validId(peer)||peer===me)return null;
    if(m.kind==='ignore')return null;
    if(M.officialUser(peer)||M.officialRcId(peer)||m.service){if(!mine)blocked++;return null;}
    const id=m.clientMsgId&&m.clientMsgId!=='0'?m.clientMsgId:`${m.from}:${m.seq}`;
    // Incoming messages carry the sender's card: the new-message notice can name them without a lookup.
    const sender=mine?{}:{sender:{name:clipped(m.userName,80),portrait:officialCdnImage(m.userPortrait)}};
    if(m.kind==='room'&&m.room){
      return {peer,...sender,message:{id,mine,kind:'room',text:clipped(m.text,120)||'[语音房邀请]',room:m.room,time:m.serverTime||m.sendTime||now(),seq:m.seq}};
    }
    const image=m.kind==='image'?officialCdnImage(m.image):'';
    return {peer,...sender,message:{id,mine,kind:image?'image':m.kind==='text'?'text':'other',
      text:image?'[图片]':(clipped(m.text,m.kind==='text'?2000:120)||'[App 内的特殊消息，请在 App 查看]'),
      ...(image?{image}:{}),time:m.serverTime||m.sendTime||now(),seq:m.seq}};
  }
  // The latest unread incoming line per chat, for the page-wide "who wrote to you" notice.
  function noteIncoming(entry,parsed){
    const m=parsed.message;if(m.mine||(entry.lastIn&&entry.lastIn.time>m.time))return;
    entry.lastIn={time:m.time,text:clipped(m.text,60),name:parsed.sender?.name||entry.lastIn?.name||'',portrait:parsed.sender?.portrait||entry.lastIn?.portrait||''};
  }
  function ingest(buffer,me) {
    const parsed=toMessage(buffer,me);if(!parsed)return;
    const entry=chatState(parsed.peer);
    if(add(entry,parsed.message)&&!parsed.message.mine&&now()-entry.openedAt>15000){entry.unread=Math.min(99,entry.unread+1);noteIncoming(entry,parsed);}
  }
  function notices(){
    return [...chats].filter(([,c])=>c.unread>0).map(([peer,c])=>{const p=people.get(peer);
      return {user_id:peer,name:p?.name||c.lastIn?.name||'',portrait:p?.portrait||c.lastIn?.portrait||'',count:c.unread,text:c.lastIn?.text||'',time:c.lastIn?.time||0};})
      .sort((a,b)=>b.time-a.time).slice(0,10);
  }
  const unreadMap=()=>Object.fromEntries([...chats].filter(([,c])=>c.unread>0).map(([p,c])=>[p,c.unread]));
  let lastSyncAt=0;
  function convPeer(chatId,me) {
    // Server conversation ids join the two sides with ':'; each side may be a
    // user id or an RC id. The side matching us (either space) names the space.
    const parts=String(chatId||'').split(':');
    if(parts.length!==2)return null;
    const rcMe=M.rcId(me);
    const other=parts[0]===me||parts[0]===rcMe?parts[1]:parts[1]===me||parts[1]===rcMe?parts[0]:null;
    if(other==null)return null;
    const peer=(parts[0]===me||parts[1]===me)?other:M.rcId(other);
    return validId(peer)&&peer!==me?peer:null;
  }
  // Pull the server conversation list so chats we never opened still surface with
  // their history (server chatIds are used verbatim: no id-space guessing).
  async function syncConversations(current,who) {
    let convs;
    try{convs=await current.conversations(50);}catch{return false;}
    if(core!==current||identity()?.identity!==who.identity)return false;
    let changed=false;
    for(const conv of Array.isArray(convs)?convs:[]){
      if(conv?.chatType!==1||typeof conv?.chatId!=='string')continue;
      const peer=convPeer(conv.chatId,who.user);
      if(!peer||M.officialUser(peer)||peer===who.user)continue;
      const entry=chatState(peer);entry.serverChatId=conv.chatId;
      let raw=[];
      try{raw=await current.history(conv.chatId,30);}catch{continue;}
      entry.loaded=true;
      if(core!==current||identity()?.identity!==who.identity)return changed;
      for(const buffer of raw){
        const parsed=toMessage(buffer,who.user);
        if(!parsed||parsed.peer!==peer)continue;
        if(!add(entry,parsed.message))continue;
        changed=true;
        if(!parsed.message.mine&&parsed.message.time>entry.openedAt&&parsed.message.time>now()-86400000){
          entry.unread=Math.min(99,entry.unread+1);noteIncoming(entry,parsed);
        }
      }
    }
    lastSyncAt=now();
    return changed;
  }
  async function friends({kind='friends',cursor=''}={},request) {
    const who=account();
    if(!['friends','following'].includes(kind)||(cursor&&!validId(cursor)))throw new ImError('好友列表参数无效。');
    const r=await signed(kind,cursor?{last_id:cursor}:{},request,who).catch(error=>{if(error instanceof ImError)throw error;return {errno:-1};});
    if(r.errno!==0)throw new ImError([40025,40026].includes(r.errno)?'官方会话已失效，请同步 App 会话。':'好友列表暂不可用。',503);
    if(!Array.isArray(r.data?.list))throw new ImError('好友数据不完整。',502);
    // Keep the full bounded upstream page: dropping rows while advancing its cursor skips friends forever.
    if(r.data.list.length>1000)throw new ImError('好友数据过大。',502);
    const rows=r.data.list,filtered=rows.map(publicPerson).filter(p=>p&&p.user_id!==who.user);
    for(const p of filtered){people.set(p.user_id,p);if(people.size>1000)people.delete(people.keys().next().value);}
    const next=String(r.data.last_id??'');
    return {kind,people:[...new Map(filtered.map(p=>[p.user_id,p])).values()],hidden_official:rows.filter(row=>M.officialUser(row?.user_id)).length,
      next_cursor:rows.length&&validId(next)&&next!==cursor?next:'',unread:unreadMap(),state,generation};
  }
  // keep: a visible page is open, so it is the client in use; keep the connection warm.
  // A hidden or closed page stops asking and the idle timer hands messages back to the App.
  function status({keep=false}={}){account();if(keep&&core&&state==='ready')touch();
    return {state,unread:unreadMap(),notices:notices(),blocked_official:blocked,generation};}
  async function connect(request){const who=account();if(state==='kicked')closeCore();const current=await ensureCore(request,who);
   try{await syncConversations(current,who);}catch{}
   return status();}
  async function chat(peer,request) {
    const who=account();
    if(!validId(peer)||peer===who.user||M.officialUser(peer))throw new ImError('只能和普通用户私信。');
    const current=active();
    if(!people.has(peer)){
      const r=await signed('userDetail',{target_id:peer},request,who);
      const person=r.errno===0?publicPerson(r.data):null;
      if(!person||person.user_id!==peer)throw new ImError('无法核对收件人，请刷新名单。',502);
      people.set(peer,person);
    }
    const entry=chatState(peer);entry.openedAt=now();entry.unread=0;entry.lastIn=null;
    if(now()-lastSyncAt>60000)void syncConversations(current,who).catch(()=>{});
    if(!entry.loaded){
      entry.loading??=current.history(entry.serverChatId||M.chatId(who.user,peer),30).then(raw=>{
        same(who);if(core!==current)throw new ImError('私信连接已变化，请重新连接。',409);
        for(const buffer of raw){const parsed=toMessage(buffer,who.user);if(parsed?.peer===peer)add(entry,parsed.message);}entry.loaded=true;
      }).finally(()=>{entry.loading=null;});
      try{await entry.loading;}catch{same(who);}
    }
    same(who);
    return {peer,person:people.get(peer),state,messages:entry.messages.slice(-KEEP),history_loaded:entry.loaded,chat_permit:entry.permit,unread:unreadMap(),generation};
  }
  async function myProfile(request,who) {
    if(profile)return profile;
    const r=await signed('userDetail',{target_id:who.user},request,who);
    if(r.errno!==0||String(r.data?.user_id)!==who.user||typeof r.data.name!=='string')throw new ImError('无法核对自己的名片，消息未发出。',503);
    profile={...r.data,user_id:who.user};return profile;
  }
  // Private 1:1 images (native F7/x case 2): upload via D7.w source=private,
  // then send the type-25 CustomMsgContent over the same IM connection.
  function sendImage({peer, request_id, confirmed, chat_permit, buffer}, request) {
    const who=account();
    if(!validId(peer)||peer===who.user||M.officialUser(peer)||!Buffer.isBuffer(buffer)||!sniffImage(buffer)||confirmed!==true||
      typeof request_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request_id))throw new ImError('私信图片需要确认收件人并选择图片。');
    const digest=crypto.createHash('sha256').update(buffer).digest('hex');
    const key=who.identity+':'+request_id,payload=JSON.stringify(['image',peer,digest]);
    for(const [k,r] of receipts)if(r.expires<=now())receipts.delete(k);
    const old=receipts.get(key);
    if(old){if(old.payload!==payload)throw new ImError('该提交编号已用于另一条消息。',409);return old.work;}
    const entry=chats.get(peer);
    if(!entry||entry.permit!==chat_permit)throw new ImError('请先打开收件人的聊天，再发送。',403);
    active();
    if(receipts.size>=128)throw new ImError('提交记录已满，请稍后再试。',429);
    while(sends.length&&now()-sends[0]>=60000)sends.shift();
    if(sends.length&&now()-sends.at(-1)<1000)throw new ImError('发送太快，请稍等一秒。',429);
    if(sends.length>=20)throw new ImError('一分钟内最多发送 20 条，请稍后再发。',429);
    sends.push(now());let submitted=false;
    const work=serial(async()=>{
      same(who);const current=active();const me=await myProfile(request,who);
      same(who);if(core!==current||chats.get(peer)!==entry)throw new ImError('聊天已变化，消息未发出。',409);
      let uploaded;
      try{uploaded=await uploadImage(buffer,request,{expectedIdentity:who.identity});}
      catch{throw new ImError('图片上传结果未确认；不会自动重发。',504);}
      same(who);if(core!==current||chats.get(peer)!==entry)throw new ImError('聊天已变化，消息未发出。',409);
      if(uploaded?.errno!==0)throw new ImError('图片上传未成功。');
      const data=uploaded.data||{},url=officialCdnImage(data.url),width=Number(data.width),height=Number(data.height);
      if(data.mark==='porn'||data.mark==='qrcode')throw new ImError('图片未通过官方审核。');
      if(!url||!Number.isSafeInteger(width)||width<1||width>8192||!Number.isSafeInteger(height)||height<1||height>8192)throw new ImError('官方图片地址无效。');
      let result;
      try{submitted=true;result=await current.sendText(peer,M.imageContent({url,width,height,me,now:now()}));}
      catch(error){
        if(error.code==='im_send_rejected'){
          submitted=false;
          if(error.bizCode===11009){const done=await write({target_user_id:peer,action:'block'},request,{expectedIdentity:who.identity}).catch(()=>null);if(done?.errno===0){try{onBlocked(peer);}catch{}}}
          throw new ImError(error.bizCode===11009?'你已被对方屏蔽；已自动拉黑对方。':(SEND_ERRORS[error.bizCode]||'服务端拒收，消息未发出。'),502);
        }
        throw new ImError('发送结果未确认；对方可能已收到，请查看聊天，不会自动重发。',504);
      }
      same(who);
      const message={id:result.clientMsgId,mine:true,kind:'image',text:'[图片]',image:url,time:result.serverTime||now(),seq:result.seq};
      add(entry,message);touch();return {sent:true,message};
    });
    receipts.set(key,{payload,work,expires:now()+3600000});
    work.catch(()=>{if(!submitted&&receipts.get(key)?.work===work)receipts.delete(key);});
    return work;
  }
  function send(body,request) {
    const who=account();
    if(!body||typeof body!=='object'||Array.isArray(body))throw new ImError('私信参数无效。');
    const {peer,text,request_id,confirmed,chat_permit}=body,content=typeof text==='string'?text.trim():'';
    if(!validId(peer)||peer===who.user||M.officialUser(peer)||!content||[...content].length>500||confirmed!==true||
      typeof request_id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request_id))throw new ImError('私信需要确认收件人和 1～500 字文字。');
    const key=who.identity+':'+request_id,payload=JSON.stringify([peer,content]);
    for(const [k,r] of receipts)if(r.expires<=now())receipts.delete(k);
    const old=receipts.get(key);
    if(old){if(old.payload!==payload)throw new ImError('该提交编号已用于另一条消息。',409);return old.work;}
    const entry=chats.get(peer);
    if(!entry||entry.permit!==chat_permit)throw new ImError('请先打开收件人的聊天，再发送。',403);
    active();
    if(receipts.size>=128)throw new ImError('提交记录已满，请稍后再试。',429);
    while(sends.length&&now()-sends[0]>=60000)sends.shift();
    if(sends.length&&now()-sends.at(-1)<1000)throw new ImError('发送太快，请稍等一秒。',429);
    if(sends.length>=20)throw new ImError('一分钟内最多发送 20 条，请稍后再发。',429);
    sends.push(now());let submitted=false;
    const work=serial(async()=>{
      same(who);const current=active();const me=await myProfile(request,who);
      same(who);if(core!==current||chats.get(peer)!==entry)throw new ImError('聊天已变化，消息未发出。',409);
      let result;
      try{submitted=true;result=await current.sendText(peer,M.textContent({text:content,me,now:now()}));}
      catch(error){
        if(error.code==='im_send_rejected'){
          submitted=false;
          if(error.bizCode===11009){const done=await write({target_user_id:peer,action:'block'},request,{expectedIdentity:who.identity}).catch(()=>null);if(done?.errno===0){try{onBlocked(peer);}catch{}}}
          throw new ImError(error.bizCode===11009?'你已被对方屏蔽；已自动拉黑对方。':(SEND_ERRORS[error.bizCode]||'服务端拒收，消息未发出。'),502);
        }
        throw new ImError('发送结果未确认；对方可能已收到，请查看聊天，不会自动重发。',504);
      }
      same(who);
      const message={id:result.clientMsgId,mine:true,kind:'text',text:content,time:result.serverTime||now(),seq:result.seq};
      add(entry,message);touch();return {sent:true,message};
    });
    receipts.set(key,{payload,work,expires:now()+3600000});
    work.catch(()=>{if(!submitted&&receipts.get(key)?.work===work)receipts.delete(key);});
    return work;
  }
  function drain(){reset();}
  return {friends,status,connect,chat,send,sendImage,drain,busy:()=>state==='connecting'};
}
module.exports={ImError,createImService,publicPerson};

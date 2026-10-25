/* Normal account membership and seat lifecycle. No room whitelist or per-room capture. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./controller.js'),require('./gift-events.js'));
 else root.GravityMember=factory(root.GravityWeb,root.GravityGifts);
})(typeof globalThis!=='undefined'?globalThis:this,function(base,gifts){
 'use strict';
 const {UserError,tokenPrivileges,APP_ID}=base;
 function command(channel,uid,order,content=null){return JSON.stringify({messageType:3,orderType:order,channelId:String(channel),
  ...(content===null?{}:{content:JSON.stringify(content)}),sendId:Number(uid)|0,ver:2});}
 // Sender uid when the RTM peer message is a well-formed command for this room, else 0. Who may send it is a separate check.
 function commandSender(message,peer,session,order){try{if(typeof message?.text!=='string'||message.text.length>4096)return 0;
  const data=JSON.parse(message.text),uid=Number(peer),payload=JSON.parse(data.content||'{}');
  return Number.isSafeInteger(uid)&&uid>0&&
   data.messageType===3&&data.orderType===order&&data.ver===2&&data.channelId===String(session.room.channel_id)&&
   (Number(data.sendId)>>>0)===uid&&(payload.channel_id==null||payload.channel_id===String(session.room.channel_id))?uid:0;
 }catch{return 0;}}
 function commandPeer(message,peer,session,order){const uid=commandSender(message,peer,session,order);return uid>0&&session.moderators.includes(uid);}
 function approved(message,peer,session){return commandPeer(message,peer,session,4);}
 function invited(message,peer,session){return commandPeer(message,peer,session,1);}
 function rtmText(message){return typeof message==='string'?message:(typeof message?.text==='string'?message.text:'');}
 // Host/admin invite: trust the Agora peer (authenticated), not sendId which some App builds set to user_id.
 // A named target in the payload must be us; omitted target means this peer message is already addressed to us.
 function inviteFrom(message,peer,session){try{
  const text=rtmText(message);if(!text||text.length>4096)return 0;
  const uid=Number(peer);if(!Number.isSafeInteger(uid)||uid<1)return 0;
  const data=JSON.parse(text);
  if(Number(data.messageType)!==3||Number(data.orderType)!==1||Number(data.ver)!==2)return 0;
  if(data.channelId!=null&&String(data.channelId)!==String(session.room.channel_id))return 0;
  const payload=JSON.parse(data.content||'{}');
  if(payload.channel_id!=null&&String(payload.channel_id)!==String(session.room.channel_id))return 0;
  const target=payload.user_id??payload.target_id??payload.to_uid??payload.toUserId??payload.target_uid;
  if(target!=null){const t=Number(target);if(Number.isFinite(t)&&t!==0&&t!==session.uid&&(t>>>0)!==session.uid)return 0;}
  return uid;
 }catch{return 0;}}
 function authorizedInviter(session,uid){return Number.isSafeInteger(uid)&&uid>0&&(session.moderators.includes(uid)||session.memberState?.anchor_rtc_uid===uid);}
 function prefOn(key){try{return globalThis.localStorage?.getItem(key)==='1';}catch{return false;}}
 function prefText(key){try{return String(globalThis.localStorage?.getItem(key)||'');}catch{return '';}}
 function peerEnvelope(type,channel,uid,content){return JSON.stringify({messageType:type,orderType:-1,channelId:String(channel),
  content:typeof content==='string'?content:JSON.stringify(content||{}),sendId:Number(uid)|0,ver:2});}
 function kicked(message,peer,session){try{if(typeof message?.text!=='string'||message.text.length>4096)return false;
  const data=JSON.parse(message.text),uid=Number(peer);
  return Number.isSafeInteger(uid)&&uid>0&&Number(data.messageType)===4&&Number(data.ver)===2&&
   (data.channelId==null||String(data.channelId)===String(session.room.channel_id));}catch{return false;}}
 function joinWelcome(message,peer,room){try{
  const parsed=chatPayload(message,peer,room);if(!parsed||parsed.text.type!==2||parsed.uid<1)return 0;
  let show=1;try{show=JSON.parse(parsed.text.contentV2||'{}').showWelcomeBtn;}catch{show=1;}
  return show===0?0:parsed.uid;}catch{return 0;}}
 function welcomeLine(name,template){
  const who=String(name||'').trim()||'だれか';
  const raw=String(template||'').trim();
  if(!raw)return who+'，ようこそ！';
  if(raw.includes('{name}'))return raw.replaceAll('{name}',who);
  if(raw.includes('用户名'))return raw.replaceAll('用户名',who);
  return who+'，'+raw;
 }
 function officialChatImage(url){try{const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||u.hash)return '';
  if(u.hostname!=='cdn.gravity.place'||u.pathname.includes('..')||!/^\/[A-Za-z0-9._\/-]+\.(png|jpe?g|webp|gif)$/i.test(u.pathname))return '';
  return u.origin+u.pathname;}catch{return '';}}
 function chatPayload(message,peer,room){if(typeof message?.text!=='string'||message.text.length>32768)return null;
  const data=JSON.parse(message.text),uid=Number(peer),text=JSON.parse(data.content||'{}');
  if(!Number.isSafeInteger(uid)||uid<1||uid>0xffffffff||data.messageType!==0||data.ver!==2||
   (data.channelId!=null&&data.channelId!==String(room.channel_id))||(Number(data.sendId)>>>0)!==uid||
   (Number(text.userId)>>>0)!==uid)return null;
  return {uid,name:typeof text.name==='string'?text.name.slice(0,80):'',text};}
 function chatText(message,peer,room){try{
  const parsed=chatPayload(message,peer,room);if(!parsed||![1,8].includes(parsed.text.type)||typeof parsed.text.content!=='string'||!parsed.text.content.trim()||parsed.text.content.length>2000)return null;
  return {rtc_uid:parsed.uid,name:parsed.name,text:parsed.text.content,type:parsed.text.type};
 }catch{return null;}}
 function chatImage(message,peer,room){try{
  const parsed=chatPayload(message,peer,room),info=parsed&&parsed.text.type===14&&typeof parsed.text.content==='string'?JSON.parse(parsed.text.content):null;
  const image=info&&officialChatImage(info.url),width=Number(info&&info.width),height=Number(info&&info.height);
  if(!image||!Number.isSafeInteger(width)||width<1||width>8192||!Number.isSafeInteger(height)||height<1||height>8192)return null;
  return {kind:'image',rtc_uid:parsed.uid,name:parsed.name,image,width,height,text:'[画像]',type:14};
 }catch{return null;}}
 // Manual greeting for the 问好 button: JST morning/day/night. Entry and exit
 // themselves stay silent; this is the only greeting and it needs a press.
 // Typed the way people greet in a Japanese voice room's chat: short, polite-casual,
 // "お邪魔します" on the way in, no odd lines like "are you still there?".
 const GREETINGS={
  morning:['おはようございます☀️','おはよう〜！お邪魔します','おはようございます、ゆっくりさせてもらいます','おはよ〜☀️ 聞きに来ました','おはようございます！今日もよろしくです',
   'おはようございます、朝から失礼します🙏','おはようございます〜聞き専でお邪魔します','おはよ！朝から楽しそうですね','おはようございます、お邪魔しまーす'],
  day:['こんにちは〜！','こんにちは、お邪魔します🙏','こんにちは！ゆっくりさせてもらいます','こんちゃ〜、お邪魔します','こんにちは、聞き専でお邪魔します',
   'やっほー、こんにちは☺️','こんにちは！楽しそうなので来ました','こんにちは〜よろしくお願いします✨','どうも〜、こんにちは！','こんにちは、少しだけお邪魔します'],
  night:['こんばんは〜！','こんばんは、お邪魔します🙏','こんばんは！ゆっくりさせてもらいます','ばんは〜、お邪魔します','こんばんは、聞き専でお邪魔します🌙',
   'こんばんは☺️ 楽しそうなので来ました','こんばんは〜よろしくお願いします✨','こんばんは！今日もお疲れさまです','こんばんは、少しだけお邪魔します','こんばんは〜まったりさせてください🌙'],
 };
 function pickLine(list,rng){const n=list.length;if(!n)return '';const i=Math.floor((typeof rng==='function'?rng():Math.random())*n);return list[Math.max(0,Math.min(n-1,i))];}
 function timeGreeting(when=new Date(),rng){
  const hour=Number(new Intl.DateTimeFormat('en',{hour:'numeric',hour12:false,timeZone:'Asia/Tokyo'}).format(when));
  return pickLine(hour>=5&&hour<10?GREETINGS.morning:hour>=10&&hour<18?GREETINGS.day:GREETINGS.night,rng);
 }
 function textMessage(uid,profile,text,ts,type=1){const body={userId:String(uid|0),name:profile.name,avatar:profile.portrait||'',
  avatarFrame:'',avatarFrameId:'',avatar3DState:0,avatarTransparent:'',avatarBgImg:'',bubbleId:0,tagUrl:'',tagId:'',tagActivityEndTime:0,
  tagAndroidUrl:'',tagIosUrl:'',tagWorldIconUrl:'',tagFormat:'',tagPointX:0,tagPointY:0,vipLevel:0,charmLevel:0,gender:0,
  voiceCreatorStatus:0,anchorLevelIcon:'',family:'{}',crownRank:0,newPeople:0,firstSight:0,nickNameColor:{},
  content:text,contentV2:'',type,ts,animationInfo:{}};
  return JSON.stringify({messageType:0,orderType:-1,content:JSON.stringify(body),sendId:uid|0,ver:2});
 }
 class Controller extends base.Controller {
  constructor({getRtmSdk=async()=>globalThis.AgoraRTM,now=Date.now,...options}){super(options);this.getRtmSdk=getRtmSdk;this.now=now;this.memberPublishWork=null;}
  // Reject retired requests instead of silently registering an expected invisible entry.
  async start(input){if(input?.stealth)throw new UserError('非表示入室は廃止しました。試聴か入室を選んでください。');return super.start(input);}
  snapshot(){const s=super.snapshot(),session=this.session;
   return {...s,memberState:session?.memberState||null,roomBoard:session?.roomBoard||null,chatMessages:session?.chatMessages||[],
    autoThanks:true,autoBalance:true,presence:session?.presenceState||null,chatSending:!!session?.chatWork,leaving:!!session?.leaving,seatBusy:!!session?.applyWork||!!session?.seatWork,
    chatAvailable:this.accountMode==='member'&&this.active(session)&&!!session?.memberJoined&&!session?.leaving,
    seatRequestState:session?.requestPending?'waiting':session?.memberState?.seated?'seated':'none',
    isHost:this.accountMode==='member'&&session?.memberState?.is_owner===true,
    applyQueue:session?.applyQueue||[],hostDog:!!session?.hostDog,hostWelcomeText:session?.hostWelcomeText||'',
    autoWelcome:!!session?.autoWelcome,autoLikeRoom:!!session?.autoLikeRoom,listenerMuted:[...session?.listenerMuted||[]],
    publishingAvailable:this.accountMode==='member'?!!session?.memberPermit&&session.memberState?.seated===true&&!session.rtcInterrupted&&!session.rtcRecovering&&this.state==='listening'&&!this.micClosing:s.publishingAvailable};}
  cleanState(data){return Object.fromEntries(['mode','eligible','seated','seat_id','muted','is_owner','auto_pass','room_type','notice','tags','anchor_rtc_uid','seat_provenance','reported_digest_rsa_verified','seat_payload_digest_verified'].map(key=>[key,data[key]]));}
  memberAction(action,session,extra={}){return this.request('/api/member/'+action,undefined,{method:'POST',keepalive:true,
   headers:{'Content-Type':'application/json','X-Gravity-Action':'member-control'},
   body:JSON.stringify({channel_id:String(session.room.channel_id),member_permit:session.memberPermit,...extra})});}
  validState(data){return data?.mode==='account-member'&&data.eligible===true&&data.seat_provenance==='official-tls'&&
   data.reported_digest_rsa_verified===true&&typeof data.seated==='boolean'&&(!data.seated||(Number.isSafeInteger(data.seat_id)&&data.seat_id>=0&&data.seat_id<=63&&typeof data.muted==='boolean'));}
  async join(room,generation,signal,previous=null){if(this.accountMode!=='member')return super.join(room,generation,signal,previous);
   const data=await this.memberAction('connect',{room},{confirmed:true});
   const unused=()=>data.member_permit?this.memberAction('release',{room,memberPermit:data.member_permit}).catch(()=>{}):Promise.resolve();
   let transferred=false;
   try {
    if(!this.isCurrent(generation)){await unused();return;}
    const uid=Number(data.user_id),p=tokenPrivileges(data.rtc_token);
    if(!this.validState(data)||!Number.isSafeInteger(uid)||uid<1||uid>0xffffffff||!p.known||!p.declaresJoin||p.declaresPublishAudio!==false||
     typeof data.rtm_token!=='string'||!Array.isArray(data.moderator_rtc_uids)||typeof data.member_permit!=='string')throw new UserError('アカウント入室トークンが不完全です。');
    const [sdk,rtmSdk]=await Promise.all([this.getSdk(),this.getRtmSdk()]);
    if(!this.isCurrent(generation)){await unused();return;}
    if(!rtmSdk?.createInstance)throw new UserError('Agora RTM SDK が読み込めていません。');
    sdk.setLogLevel(4);
    const rtm=rtmSdk.createInstance(APP_ID,{enableLogUpload:false,logFilter:rtmSdk.LOG_FILTER_OFF??{error:false,warn:false,info:false,track:false,debug:false}});
    const session={generation,room,client:sdk.createClient({mode:'live',codec:'vp8'}),tracks:new Map(),joined:false,joinPromise:null,disposing:null,
     memberPermit:data.member_permit,memberState:this.cleanState(data),moderators:data.moderator_rtc_uids,uid,rtm,channel:rtm.createChannel(String(room.channel_id)),
     memberJoined:false,memberTimer:null,tokenTimer:null,tokenWork:null,requestPending:false,applyWork:null,roomBoard:null,boardWork:null,lastBoardAt:0,chatMessages:[],chatWork:null,lastChatAt:null,
     blockedUids:new Set(),listenerMuted:new Set(),leaving:false,applyQueue:[],
     hostDog:prefOn('gravity.hostDog'),hostWelcomeText:prefText('gravity.hostWelcomeText'),
     autoWelcome:prefOn('gravity.autoWelcome'),autoLikeRoom:prefOn('gravity.autoLikeRoom'),likedRoom:false,
     giftSeen:new Map(),giftThanks:new Set(),autoThanks:true,autoThanksSince:null,lastAutoThanksAt:null,
     pendingBoxes:[],boxClaimed:new Set(),boxReady:false,boxWork:null,welcomeWork:null};
    this.accountUid=uid;this.session=session;transferred=true;this.privileges=p;
    session.renewCredentials=()=>this.queueTokenRenewal(session);
    session.recoverRtc=()=>{void this.recoverMemberRtc(session);};
    this.applyBlocked(session,data.blocked_rtc_uids);
    this.attach(session);this.attachRtm(session);
    session.joinPromise=(async()=>{
     await session.client.setClientRole('audience');if(!this.active(session))return;
     await session.client.join(APP_ID,String(room.channel_id),data.rtc_token,uid);if(!this.active(session))return;
     await rtm.login({uid:String(uid),token:data.rtm_token});if(!this.active(session))return;
     await session.channel.join();
    })();
    await session.joinPromise;session.joined=true;
    if(!this.active(session)){await this.dispose(session);return;}
    const presence=await this.memberAction('enter',session,{confirmed:true});
    if(presence?.entered!==true)throw new UserError('公式の入室登録が確認できませんでした。');
    if(!this.active(session)){await this.dispose(session);return;}
    session.autoThanksSince=this.now();session.memberJoined=true;session.enteredAt=this.now();
    this.connections++;this.state='listening';this.message='入室済み · 公式アカウント（RTC + RTM）';
    this.log('メンバー通路がつながりました。マイクはオフです。発言はいまのルームの公式マイク席を使います。');this.emit();this.scheduleMemberCheck(session);
    this.scheduleTokenRenewal(session,data);this.scheduleBox(session);
    // Silent entry means no automatic greeting, not invisible presence.
    void this.refreshBoard(session).then(()=>{if(this.active(session)&&session.autoLikeRoom)void this.likeRoom(session);})
     .catch(()=>{if(this.active(session))this.log('メンバー名簿を取得できません。あとで自動更新します。');});
   }catch(error){if(!transferred)await unused();throw error;}
  }
  attachRtm(session){
   session.rtm.on('MessageFromPeer',(message,peer)=>{
    if(!this.active(session)||session.leaving)return;
    if(kicked(message,peer,session)&&authorizedInviter(session,Number(peer))){void this.halt('ホストがあなたをルームから外しました。');return;}
    const inviter=inviteFrom(message,peer,session);
    if(inviter){void this.acceptInvite(session,inviter);return;}
    const off=commandSender(message,peer,session,0);
    if(off&&authorizedInviter(session,off)){void this.leaveSeat().catch(()=>{});return;}
    const applicant=commandSender(message,peer,session,3);
    if(applicant&&session.memberState?.is_owner){this.noteApplicant(session,applicant);return;}
    if(!session.requestPending||!approved(message,peer,session))return;
    session.requestPending=false;
    void this.takeSeat(session).catch(error=>{if(this.active(session)){this.log(base.describe(error));this.emit();}});
   });
   session.rtm.on('ConnectionStateChanged',(state,reason)=>{
    if(!this.active(session)||!session.memberJoined)return;
    if(reason==='REMOTE_LOGIN'||reason==='TOKEN_EXPIRED'||reason==='BANNED_BY_SERVER'||state==='ABORTED'){
     const detail=reason==='REMOTE_LOGIN'?'同じアカウントの別端末がチャット接続を置き換えました':reason==='TOKEN_EXPIRED'?'チャットトークンの期限切れ':reason==='BANNED_BY_SERVER'?'サーバーが切断または拒否しました':'チャット接続が切れました';
     void this.halt(`メンバー接続が停止：${detail}。マイクを閉じました。接続は自動では取り戻しません。`);
    }else if(state==='RECONNECTING')this.log('チャットが短時間切れました。自動再接続を待ちます…');
    else if(state==='CONNECTED')this.log('チャットが再接続しました。');
   });
   session.rtm.on('TokenExpired',()=>{if(this.active(session))void this.halt('アカウントのチャットトークンが期限切れです。停止しました。再接続してください。');});
   session.rtm.on('TokenPrivilegeWillExpire',()=>this.queueTokenRenewal(session));
   session.channel.on('ChannelMessage',(message,peer)=>{if(!this.active(session))return;
    const inviter=inviteFrom(message,peer,session);
    if(inviter){void this.acceptInvite(session,inviter);return;}
    const applicant=commandSender(message,peer,session,3);
    if(applicant&&session.memberState?.is_owner){this.noteApplicant(session,applicant);return;}
    const welcome=joinWelcome(message,peer,session.room);
    if(welcome&&session.autoWelcome&&welcome!==session.uid)void this.clickWelcome(session,welcome);
    const text=chatText(message,peer,session.room);if(text){this.addChat(session,text);}
    else {const image=chatImage(message,peer,session.room);if(image)this.addChat(session,image);
     else {const gift=gifts.giftEvent(message,peer,session.room);if(gift)this.receiveGift(session,gift);
      else {const box=gifts.boxEvent(message,session.room);if(box)this.noteBox(session,box);else void this.checkMember(session).catch(()=>{});}}}
   });
   session.channel.on('MemberJoined',memberId=>{if(this.active(session))void this.onMemberJoined(session,memberId);});
   session.channel.on('MemberLeft',()=>{if(this.active(session))void this.refreshBoard(session).catch(()=>{});});
  }
  // Silence everyone we block: the server's block list (every status poll) plus anyone the roster flags as blocked.
  applyBlocked(session,uids){
   if(Array.isArray(uids))session.blockedUids=new Set(uids.filter(n=>Number.isSafeInteger(n)&&n>0).slice(0,5000));
   const flagged=[...(session.roomBoard?.members||[]),...(session.roomBoard?.seats||[]).map(s=>s.person).filter(Boolean)].filter(p=>p.blocked&&p.rtc_uid).map(p=>p.rtc_uid);
   this.setMutedUids(session,[...session.blockedUids,...flagged]);
  }
  listenerMuted(uid){return !!this.session?.listenerMuted?.has(Number(uid));}
  toggleListenerMute(uid,muted){
   const session=this.session;if(!session)return false;
   const n=Number(uid);if(!Number.isSafeInteger(n)||n<1||n===session.uid)return false;
   if(!session.listenerMuted)session.listenerMuted=new Set();
   if(muted===false)session.listenerMuted.delete(n);else session.listenerMuted.add(n);
   this.playRemote(session.tracks.get(String(n)),n,session);this.emit();return true;
  }
  noteApplicant(session,uid){
   if(!session.memberState?.is_owner||!Number.isSafeInteger(uid)||uid<1||uid===session.uid)return;
   if(!Array.isArray(session.applyQueue))session.applyQueue=[];
   if(session.applyQueue.some(item=>item.uid===uid))return;
   const name=[...(session.roomBoard?.members||[]),...(session.roomBoard?.seats||[]).map(s=>s.person).filter(Boolean)].find(p=>p.rtc_uid===uid)?.name||'';
   session.applyQueue=[...session.applyQueue,{uid,name}].slice(-20);this.emit();
  }
  onMemberJoined(session,memberId){
   void this.refreshBoard(session).catch(()=>{});
   const uid=Number(memberId);
   if(!session.hostDog||session.memberState?.is_owner!==true||!Number.isSafeInteger(uid)||uid<1||uid===session.uid)return;
   const name=[...(session.roomBoard?.members||[]),...(session.roomBoard?.seats||[]).map(s=>s.person).filter(Boolean)].find(p=>p.rtc_uid===uid)?.name;
   const line=welcomeLine(name,session.hostWelcomeText);
   session.greetWork=(session.greetWork||Promise.resolve()).then(()=>{if(!this.active(session)||!session.hostDog)return;return this.sendText(line,{lifecycle:true});})
    .catch(error=>{if(this.active(session))this.log('入室のあいさつは送っていません：'+base.describe(error));});
  }
  clickWelcome(session,uid){
   if(!this.active(session)||session.leaving||uid===session.uid)return;
   if(!session.welcomed)session.welcomed=new Set();
   if(session.welcomed.has(uid))return;session.welcomed.add(uid);
   const profile=session.roomBoard?.self_profile;if(!profile)return;
   const text=textMessage(session.uid,profile,JSON.stringify({channel_id:String(session.room.channel_id)}),this.now(),12);
   void session.rtm.sendMessageToPeer({text},String(uid),{enableOfflineMessaging:false}).catch(()=>{});
  }
  async likeRoom(session=this.session){
   if(!this.active(session)||session.leaving||session.likedRoom)return false;
   const profile=session.roomBoard?.self_profile;if(!profile)return false;
   session.likedRoom=true;
   try{await session.channel.sendMessage({text:textMessage(session.uid,profile,'{}',this.now(),13)});return true;}
   catch{if(this.active(session))session.likedRoom=false;return false;}
  }
  setPref(name,value){
   const on=value===true;
   if(!['hostDog','autoWelcome','autoLikeRoom'].includes(name))return false;
   try{globalThis.localStorage?.setItem('gravity.'+name,on?'1':'0');}catch{}
   if(this.session)this.session[name]=on;
   if(name==='autoLikeRoom'&&on&&this.session?.memberJoined&&!this.session.likedRoom)void this.likeRoom(this.session);
   this.emit();return true;
  }
  setWelcomeText(text){
   const v=String(text||'').slice(0,80);
   try{globalThis.localStorage?.setItem('gravity.hostWelcomeText',v);}catch{}
   if(this.session)this.session.hostWelcomeText=v;return v;
  }
  scheduleTokenRenewal(session,data,delayMs=null){if(!this.active(session)||!session.memberJoined||session.leaving)return;
   if(session.tokenTimer!==null)this.timers.clearTimeout(session.tokenTimer);
   const expirations=[data.rtc_token,data.rtm_token].map(token=>tokenPrivileges(token).expiresAt).filter(Number.isFinite);
   if(delayMs===null&&expirations.length===2)session.tokenExpiresAt=Math.min(...expirations);
   // The official 006 pair currently lives for 300 seconds. Renew in place one minute early.
   const delay=delayMs??(expirations.length?Math.min(2_147_483_647,Math.max(1000,Math.min(...expirations)-this.now()-60_000)):60_000);
   session.tokenTimer=this.timers.setTimeout(()=>{session.tokenTimer=null;this.queueTokenRenewal(session);},delay);
  }
  queueTokenRenewal(session){if(!this.active(session)||!session.memberJoined||session.leaving||session.rtcRecovering||session.rtcRecoveryTimer!=null)return;
   void this.renewMemberTokens(session).catch(error=>{if(!this.active(session)||session.leaving)return;
    // A temporary inspection/network failure must not kill a listener at the
    // four-minute renewal. Retry only inside the OLD credentials' lifetime;
    // never retry a hard rejection, SDK error, or uncertain active publication.
    if(error?.retryableRenewalRead===true&&this.micState==='off'&&session.tokenExpiresAt-this.now()>30_000){
     this.log('ルームトークンはまだ更新できていません。5秒後に再試行します。受信は続けます（再入室しません）。');
     this.scheduleTokenRenewal(session,{},5000);return;
    }
    void this.halt('ルームトークンの更新に失敗しました。マイクを閉じて停止：'+base.describe(error));});
  }
  async recoverMemberRtc(session){
   if(!this.active(session)||!session.memberJoined||session.leaving||session.rtcRecovering||session.rtcRecoveryTimer!=null)return;
   session.rtcRecovering=true;
   this.state='reconnecting';this.message='音声が切れました。復旧中（マイクオフ）…';this.emit();
   try{
    await this.closeMic();
    if(session.tokenWork)await session.tokenWork;
    if(!this.active(session)||session.leaving)return;
    const restored=await this.renewMemberTokens(session,true);
    if(!restored||!this.active(session)||session.leaving)return;
    session.rtcRecoveryFails=0;session.rtcInterrupted=false;this.connections++;this.state='listening';this.message='入室中 · 音声を復旧しました（マイクオフ）';
    this.log('音声を復旧しました：同じアカウント・同じルーム。入室登録・チャットログイン・マイクオンはやり直していません。');this.emit();
   }catch(error){
    if(!this.active(session)||session.leaving)return;
    session.rtcRecoveryFails=(session.rtcRecoveryFails||0)+1;
    if(error?.retryableRenewalRead===true&&session.rtcRecoveryFails<5){
     this.log('音声の復旧はまだです。あとで再試行します。');
     session.rtcRecoveryTimer=this.timers.setTimeout(()=>{session.rtcRecoveryTimer=null;void this.recoverMemberRtc(session);},Math.min(15000,1000*2**session.rtcRecoveryFails));
    }else void this.halt('音声の復旧に失敗しました。停止してマイクオフ：'+base.describe(error));
   }finally{session.rtcRecovering=false;if(this.active(session)&&!session.leaving)this.emit();}
  }
  async renewMemberTokens(session,rejoinRtc=false){if(!this.active(session)||!session.memberJoined||session.leaving)return false;
   if(session.tokenWork)return session.tokenWork;
   if(session.tokenTimer!==null)this.timers.clearTimeout(session.tokenTimer);session.tokenTimer=null;
   const publishing=this.memberPublishWork,attempt={active:true};
   const current=()=>attempt.active&&this.active(session)&&!session.leaving;
   const work=(async()=>{if(publishing)await publishing;
    if(!current())return false;
    const intent=this.micIntent;
    const data=await this.memberAction('renew',session).catch(error=>{
     // Only the HTTP read may be retried. Invalid returned credentials or an
     // SDK failure (including a partial RTC/RTM update) must stop.
     if(error instanceof base.UserError&&[0,429,500,502,503,504].includes(error.status))error.retryableRenewalRead=true;
     throw error;
    });
    if(!current())return false;
    if(intent!==this.micIntent){this.scheduleTokenRenewal(session,data,1000);return false;}
    const p=tokenPrivileges(data?.rtc_token),rtm=tokenPrivileges(data?.rtm_token);
    if(!this.validState(data)||Number(data.user_id)!==session.uid||data.rtc_token?.slice(3,35)!==APP_ID||!p.known||!p.declaresJoin||
     p.expiresAt<=this.now()+30_000||data.rtm_token?.slice(3,35)!==APP_ID||!rtm.known||!rtm.declaresRtmLogin||rtm.expiresAt<=this.now()+30_000||
     (p.declaresPublishAudio&&(!data.seated||data.muted!==false||this.micState!=='sdk-published-unverified')))
     throw new UserError('同じアカウントの更新トークンが一致しません。');
    if((!data.seated||data.muted===true||!p.declaresPublishAudio)&&this.micState==='sdk-published-unverified'){
     await this.closeMic();if(!current())return false;
    }
    if(rejoinRtc){
     // DISCONNECTED is terminal for Agora's automatic reconnect. Reuse the
     // official identity and room, but never resume physical capture.
     for(const track of session.tracks.values())try{track.stop();}catch{}
     session.tracks.clear();this.levelPeaks.clear();
     await session.client.leave();if(!current())return false;
     await session.client.setClientRole('audience');if(!current())return false;
     session.joined=false;
     session.joinPromise=session.client.join(APP_ID,String(session.room.channel_id),data.rtc_token,session.uid);
     await session.joinPromise;session.joined=true;
     if(!current()){await session.client.leave().catch(()=>{});return false;}
    }else await session.client.renewToken(data.rtc_token);
    if(!current())return false;
    await session.rtm.renewToken(data.rtm_token);
    if(!current())return false;
    this.privileges=p;session.memberState=this.cleanState(data);this.scheduleTokenRenewal(session,data);
    this.log('音声とチャットのトークンを元の接続のまま更新しました（再ログイン／再入室なし）。');this.emit();return true;
   })();
   const bounded=this.bounded(work,30_000,()=>{attempt.active=false;},'更新がタイムアウトしました。再接続してください。');
   session.tokenWork=bounded;try{return await bounded;}finally{attempt.active=false;if(session.tokenWork===bounded)session.tokenWork=null;}
  }
  scheduleMemberCheck(session){if(!this.active(session)||session.leaving||session.memberTimer!==null)return;
   session.memberTimer=this.timers.setTimeout(()=>{session.memberTimer=null;
    void this.checkMember(session).then(()=>{this.scheduleMemberCheck(session);}).catch((error)=>{
     // Hard rejections (closed room, dead session, changed account: 4xx) stop fast
     // with their own message. Soft blips (network/5xx/degraded presence) keep
     // healthy audio alive and only stop after ~2 minutes of nothing working.
     const hard=[400,401,403,404,409].includes(error?.status||0);
     if(hard){session.hardFails=(session.hardFails||0)+1;session.softFails=0;}
     else{session.softFails=(session.softFails||0)+1;session.hardFails=0;}
     if(!this.active(session)||session.leaving)return;
     if(session.hardFails>=2)void this.halt(base.describe(error)+'。停止してマイクを閉じました。');
     else if(session.softFails>=24)void this.halt('ネットワークまたは公式の在室確認が長く取れません。停止してマイクを閉じました。手動で入り直せます。');
     else{this.log(hard?base.describe(error)+'（再試行中）':'ルーム状態を一時的に取得できません。あとで再試行します。');this.scheduleMemberCheck(session);}
    });
   },5000);
  }
  async checkMember(session){if(session.statusWork)return session.statusWork;
   const work=(async()=>{const data=await this.request('/api/member/status?channel_id='+encodeURIComponent(session.room.channel_id),this.abort?.signal,
    {headers:{'X-Gravity-Member-Permit':session.memberPermit}});
    if(!this.active(session))return null;if(!this.validState(data))throw new UserError('公式マイク席の状態が不完全です。');
    if((!data.seated||data.muted===true)&&this.micState==='sdk-published-unverified'){
     await this.closeMic();if(!this.active(session))return null;this.log('公式側で席を離れたかミュートです。こちらの送信は閉じました。');
    }
    session.memberState=this.cleanState(data);if(data.seated)session.requestPending=false;
    if(Array.isArray(data.moderator_rtc_uids)&&data.moderator_rtc_uids.length<=65&&data.moderator_rtc_uids.every(n=>Number.isSafeInteger(n)&&n>0))session.moderators=data.moderator_rtc_uids;
    this.applyBlocked(session,data.blocked_rtc_uids);
    if(data.presence==='degraded'){session.softFails=(session.softFails||0)+1;session.hardFails=0;session.presenceState='degraded';
     this.log('在室確認が一時的に取れていません（'+(data.presence_error||'あとで再試行')+'）。受信は続けます。');
     if(session.softFails>=24){const stale=new UserError('ネットワークまたは公式の在室確認が長く取れません。');stale.status=503;throw stale;}
    }else{session.softFails=0;session.hardFails=0;session.presenceState='ok';}
    this.emit();
    // A big room costs several roster pages per refresh, so refresh it less often.
    if(this.now()-session.lastBoardAt>=((session.roomBoard?.members.length||0)>100?30_000:10_000))void this.refreshBoard(session).catch(()=>{});return data;
   })();session.statusWork=work;try{return await work;}finally{if(session.statusWork===work)session.statusWork=null;}
  }
  // The server reads several roster pages per call, so a refresh is always the whole (capped) roster; there is no "load more".
  async refreshBoard(session=this.session){if(!this.active(session)||!session.memberJoined||session.leaving)return null;
   if(session.boardWork)return session.boardWork;
   const work=(async()=>{const data=await this.request('/api/member/board?'+new URLSearchParams({channel_id:String(session.room.channel_id)}),
    this.abort?.signal,{headers:{'X-Gravity-Member-Permit':session.memberPermit}});
    if(!this.active(session))return null;
    if(!Array.isArray(data.members)||!Array.isArray(data.seats))throw new UserError('ルームメンバーデータが不完全です。');
    session.roomBoard={...data,members:[...new Map(data.members.map(p=>[p.user_id,p])).values()].slice(0,500),
     // A paged roster is not a revocation of an already authenticated self profile.
     self_profile:data.self_profile||data.seats.find(s=>s.person?.is_self)?.person||session.roomBoard?.self_profile||null};
    session.lastBoardAt=this.now();this.applyBlocked(session);this.emit();return session.roomBoard;
   })();session.boardWork=work;try{return await work;}finally{if(session.boardWork===work)session.boardWork=null;}
  }
  addChat(session,message){if(!this.active(session))return;
   const person=session.roomBoard?.members.find(p=>p.rtc_uid===message.rtc_uid);
   session.chatMessages.push({...message,name:person?.name||message.name||String(message.rtc_uid)});
   session.chatMessages=session.chatMessages.slice(-100);this.emit();
  }
  // Gift thanks are always on: every verified gift to us gets one queued thanks. No switch.
  receiveGift(session,gift){if(!this.active(session)||session.giftSeen.has(gift.key))return;
   session.giftSeen.set(gift.key,this.now());while(session.giftSeen.size>300)session.giftSeen.delete(session.giftSeen.keys().next().value);
   this.addChat(session,{kind:'gift',rtc_uid:gift.sender_uid,name:gift.sender_name,gift,thanksState:'none',
    text:`🎁 ${gift.recipient_uid===session.uid?'あなた':gift.recipient_name}：${gift.gift_name} × ${gift.count}${gift.source_verified?'':'（出所未確認）'}`});
   if(session.memberJoined&&!session.leaving&&gift.source_verified&&gift.has_timestamp&&
      gift.timestamp>=session.autoThanksSince-5000&&Math.abs(this.now()-gift.timestamp)<=60000&&gift.recipient_uid===session.uid&&gift.sender_uid!==session.uid){
    session.thanksWork=(session.thanksWork||Promise.resolve()).then(()=>this.thankGift(gift.key,true))
     .catch(error=>{if(this.active(session))this.log('自動お礼は確認できませんでした：'+base.describe(error));});
   }
  }
  async thankGift(key,automatic=false){const session=this.session;if(!this.active(session)||!session.memberJoined||session.leaving)throw new UserError('先にアカウントで入室してください。');
   const line=session.chatMessages.find(m=>m.gift?.key===key),gift=line?.gift;
   if(!gift||!gift.source_verified||gift.recipient_uid!==session.uid||gift.sender_uid===session.uid)throw new UserError('出所を確認できて、自分宛のギフトにだけお礼します。');
   if(session.giftThanks.has(key))return false;
   if(session.chatWork)await session.chatWork.catch(()=>{});
   if(!this.active(session)||session.leaving||session.giftThanks.has(key))return false;
   session.giftThanks.add(key);while(session.giftThanks.size>300)session.giftThanks.delete(session.giftThanks.values().next().value);line.thanksState='pending';this.emit();
   try{const sent=await this.sendText(gifts.thanksText(gift),automatic?{lifecycle:true}:{});line.thanksState=sent?'sent':'unconfirmed';return sent;}
   catch(error){line.thanksState='unconfirmed';throw error;}finally{this.emit();}
  }
  async sendText(text,{lifecycle=false,allowLeaving=false}={}){const session=this.session;
   if(this.accountMode!=='member'||!this.active(session)||!session.memberJoined)throw new UserError('先に公式アカウントで入室してください。');
   if(typeof text!=='string'||!text.trim()||text.trim().length>200)throw new UserError('チャットは1〜200字で入力してください。');
   if(session.leaving&&!allowLeaving)throw new UserError('退室中です。');
   if(session.chatWork)throw new UserError('送信中です。');
   if(!lifecycle&&session.lastChatAt!==null&&this.now()-session.lastChatAt<2000)throw new UserError('2秒待ってから送ってください。');
   const attempt={active:true};
   const current=()=>attempt.active&&this.active(session)&&(!session.leaving||allowLeaving);
   const task=(async()=>{await this.checkMember(session);if(!current())return false;
    if(!session.roomBoard?.self_profile)await this.refreshBoard(session);
    if(!current())return false;
    const profile=session.roomBoard?.self_profile;if(!profile)throw new UserError('自分のメンバー名刺がまだ確認できていません。名簿を更新してから送ってください。');
    if(!current())return false;
    await session.channel.sendMessage({text:textMessage(session.uid,profile,text.trim(),this.now())});
    if(!current())return false;
    if(!lifecycle)session.lastChatAt=this.now();
    this.addChat(session,{rtc_uid:session.uid,name:profile.name,text:text.trim(),own:true});return true;
   })();
   const work=this.bounded(task,12_000,()=>{attempt.active=false;},'送信がタイムアウトし、結果は未確認です。自動では再送しません。');
   session.chatWork=work;this.emit();try{return await work;}finally{attempt.active=false;if(session.chatWork===work)session.chatWork=null;this.emit();}
  }
  bounded(task,ms,cancel,message){let timer;
   const timeout=new Promise((_,reject)=>{timer=this.timers.setTimeout(()=>{cancel();reject(new UserError(message));},ms);});
   return Promise.race([task,timeout]).finally(()=>this.timers.clearTimeout(timer));
  }
  greet(){return this.sendText(timeGreeting());}
  scheduleBox(session){if(session.boxTimer!=null)this.timers.clearTimeout(session.boxTimer);
   session.boxTimer=this.timers.setTimeout(()=>{session.boxTimer=null;session.boxReady=true;void this.claimReadyBox(session);},600000);}
  noteBox(session,box){if(!this.active(session)||session.leaving)return;
   const key=box.lucky_box_id+':'+box.issue_user_id;
   if(session.boxClaimed.has(key))return;
   if(!session.pendingBoxes.some(b=>b.lucky_box_id===box.lucky_box_id&&b.issue_user_id===box.issue_user_id))session.pendingBoxes.push(box);
   if(session.boxReady)void this.claimReadyBox(session);}
  async claimReadyBox(session){if(!this.active(session)||session.leaving||!session.boxReady||session.boxWork)return;
   const work=(async()=>{
    // Each box once, in order. A box the official side refuses (expired, emptied)
    // is dropped; kept at the head it used to block every box announced after it.
    while(this.active(session)&&!session.leaving&&session.pendingBoxes.length){
     const box=session.pendingBoxes.shift(),key=box.lucky_box_id+':'+box.issue_user_id;
     if(session.boxClaimed.has(key))continue;
     session.boxClaimed.add(key);
     try{await this.memberAction('lucky-box',session,{confirmed:true,lucky_box_id:box.lucky_box_id,issue_user_id:box.issue_user_id});
      if(this.active(session))this.log('ルーム宝箱を受け取りました。');
     }catch(error){if(this.active(session))this.log('宝箱を受け取れなかったので、この箱は飛ばします：'+base.describe(error));}
    }
    this.emit();
   })();
   session.boxWork=work;try{await work;}finally{if(session.boxWork===work)session.boxWork=null;}
  }
  // Manual greeting for the 问好 button: JST morning/noon/night. Pure function of the hour.
  // Entry and exit stay silent; nothing sends automatically.
  async leaveRoom(){const session=this.session;if(!this.active(session)||this.accountMode!=='member')return this.stop();
   if(session.exitWork)return session.exitWork;
   session.leaving=true;const closing=this.closeMic();this.emit();
   const work=(async()=>{await closing;if(this.session===session&&this.active(session))await this.stop();})();session.exitWork=work;return work;
  }
  // Refresh/close: the normal teardown leaves RTC/RTM first and the page is gone
  // before its release request goes out, so the server held the room for 90 s.
  // Fire the release synchronously (keepalive) before anything else.
  releaseOnUnload(){const session=this.session;
   if(this.accountMode!=='member'||!session?.memberPermit||session.memberReleased)return false;
   session.memberReleased=true;
   try{void Promise.resolve(this.fetch('/api/member/release',{method:'POST',keepalive:true,cache:'no-store',
    headers:{'Content-Type':'application/json','X-Gravity-Action':'member-control'},
    body:JSON.stringify({channel_id:String(session.room.channel_id),member_permit:session.memberPermit})})).catch(()=>{});}catch{}
   return true;
  }
  // Server side of force quit, also usable with no local room (a refreshed page):
  // drops whatever account room permit the server still holds.
  async forceRelease(channel=''){
   const abort=new AbortController(),timer=this.timers.setTimeout(()=>abort.abort(),10000);
   try{
    const response=await this.fetch('/api/member/force-release',{signal:abort.signal,method:'POST',keepalive:true,cache:'no-store',
     headers:{'Content-Type':'application/json','X-Gravity-Action':'member-control'},
     body:JSON.stringify({...(/^[1-9][0-9]{0,19}$/.test(channel)?{channel_id:channel}:{}),confirmed:true})});
    const result=await response.json().catch(()=>({}));
    return response.ok&&result.errno===0?result.data:null;
   }catch{return null;}finally{try{this.timers.clearTimeout(timer);}catch{}}
  }
  // Force quit: never waits. Detaches locally first so a hung leave
  // (stuck closeMic/dispose/release) cannot keep the buttons disabled; the
  // server permit is dropped best-effort and the next connect kicks stale
  // official occupancy via Enter-retry. Always callable, even while leaving.
  async forceLeave(){
   const session=this.session,room=session?.room||this.room;
   const channel=room?.channel_id!=null?String(room.channel_id):'';
   const memberMode=this.accountMode==='member';
   this.generation++;this.running=false;this.cancelWork();
   if(session){
    if(session.memberTimer!=null)this.timers.clearTimeout(session.memberTimer);session.memberTimer=null;
    if(session.tokenTimer!=null)this.timers.clearTimeout(session.tokenTimer);session.tokenTimer=null;
    if(session.rtcRecoveryTimer!=null)this.timers.clearTimeout(session.rtcRecoveryTimer);session.rtcRecoveryTimer=null;
    if(session.boxTimer!=null)this.timers.clearTimeout(session.boxTimer);session.boxTimer=null;
    session.leaving=true;session.requestPending=false;
   }
   this.session=null;this.state='idle';this.message='強制退出しました';this.privileges=null;
   try{void this.closeMic();}catch{}
   if(session){
    for(const track of session.tracks?.values()||[]){try{track.stop();}catch{}}
    try{session.tracks?.clear?.();}catch{}
    void (async()=>{
     try{await session.client?.leave?.();}catch{}
     try{await session.channel?.leave?.();}catch{}
     try{await session.rtm?.logout?.();}catch{}
     try{session.channel?.removeAllListeners?.();session.rtm?.removeAllListeners?.();}catch{}
     try{session.client?.removeAllListeners?.();}catch{}
    })();
   }
   this.emit();
   if(memberMode&&/^[1-9][0-9]{0,19}$/.test(channel))await this.forceRelease(channel);
   this.log('このページのルームを強制退出しました。再入室できます。席表示がおかしいときはマイクオフ／席を離れるを一度押してください。');
   this.emit();
   return true;
  }
  // Host only: end the room for everyone (the page otherwise just leaves it open). Explicit confirmation is the caller's job.
  async endRoom(){const session=this.session;
   if(!this.active(session)||!session.memberJoined||session.memberState?.is_owner!==true)throw new UserError('ホストだけがルームを終了できます。');
   if(session.endWork)return session.endWork;
   session.leaving=true;session.requestPending=false;this.emit();
   const work=(async()=>{try{
    await this.closeMic();
    const data=await this.memberAction('destroy',session,{confirmed:true});
    if(data?.destroyed!==true)throw new UserError('公式はルーム終了を確認していません。');
    session.memberReleased=true;
   }catch(error){if(this.active(session)){session.leaving=false;session.endWork=null;this.emit();}throw error;}
   await this.stop();return {destroyed:true};})();
   session.endWork=work;return work;
  }
  async blockHostAndLeave(){const session=this.session;
   if(!this.active(session)||!session.room)throw new UserError('先にルームを選んで入室してください。');
   if(session.blockWork)return session.blockWork;
   const room={...session.room};session.leaving=true;
   if(session.memberTimer!=null)this.timers.clearTimeout(session.memberTimer);session.memberTimer=null;session.requestPending=false;
   const closing=this.closeMic();this.emit();
   const work=(async()=>{const abort=new AbortController();try{
    await closing;
    if(this.session!==session||!this.active(session))throw new UserError('ルーム接続が変わったため、ブロックは実行していません。');
    // Release seats/presence while the host is still unblocked; blocking first can revoke room inspection.
    if(session.memberPermit){const released=await this.memberAction('release',session);
     if(released?.released!==true)throw new UserError('退室登録が確認できなかったため、ブロックは実行していません。');session.memberReleased=true;}
    if(this.session!==session||!this.active(session))throw new UserError('ルーム接続が変わったため、ブロックは実行していません。');
    await this.stop();
    const task=this.request('/api/profile/block-host',abort.signal,{method:'POST',headers:{'Content-Type':'application/json','X-Gravity-Action':'profile-control'},
     body:JSON.stringify({channel_id:String(room.channel_id),expected_anchor_id:String(room.anchor_id),confirmed:true,request_id:globalThis.crypto.randomUUID()})});
    const result=await this.bounded(task,30000,()=>abort.abort(),'ブロック結果は未確認です。自動では再試行しません。App で確認してください。');
    if(result?.blocked!==true||result.user_id!==String(room.anchor_id))throw new UserError('公式はブロック成功を確認していません。');
    return result;
   }catch(error){throw new UserError('いまのルームは退室済みです。ブロックは未確認：'+base.describe(error));}
   finally{if(this.session===session&&this.active(session))await this.leaveRoom();}
   })();session.blockWork=work;return work;
  }
  // A host/admin invite: take the seat muted. The admin list may have changed since we joined, the cached seat state may be a
  // poll old, and one failed attempt (busy queue, flaky network) must not leave the invitation unanswered, so refresh and retry.
  acceptInvite(session,uid){
   // A host that keeps re-inviting must not start parallel retry loops.
   if(session.inviteWork)return session.inviteWork;
   const work=this.runInvite(session,uid).finally(()=>{if(session.inviteWork===work)session.inviteWork=null;});
   return session.inviteWork=work;
  }
  async runInvite(session,uid){
   try{
    if(!authorizedInviter(session,uid)){
     this.log('マイク席の招待を受けました。管理名簿を確認中…');
     await this.checkMember(session);
     if(!this.active(session)||!authorizedInviter(session,uid)){
      if(this.active(session))this.log('招待元がホスト／管理名簿にいないので無視しました。');
      return;
     }
    }
    for(let attempt=0;attempt<3;attempt++){
     if(!this.active(session)||session.leaving)return;
     try{
      const state=await this.checkMember(session);if(!this.active(session)||session.leaving)return;
      if(state?.seated)return;
      if(await this.takeSeat(session))return;
      if(!this.active(session)||session.leaving||session.memberState?.seated)return;
     }catch(error){if(this.active(session)){this.log('マイク席招待に失敗'+(attempt<2?'。あとで再試行：':'：')+base.describe(error));this.emit();}}
     if(attempt<2)await new Promise(resolve=>this.timers.setTimeout(resolve,attempt?4000:1500));
    }
   }catch(error){if(this.active(session)){this.log(base.describe(error));this.emit();}}
  }
  // Called when the page becomes visible again: browsers throttle timers in background tabs, so poll now instead of waiting.
  pollNow(){const session=this.session;if(this.active(session)&&session.memberJoined&&!session.leaving)void this.checkMember(session).catch(()=>{});}
  async takeSeat(session){if(!this.active(session)||session.leaving)return false;if(session.applyWork)return session.applyWork;
   const work=(async()=>{const data=await this.memberAction('apply',session,{confirmed:true});
    if(!this.active(session))return false;if(!this.validState(data))throw new UserError('マイク席の状態が確認できません。');
    session.memberState=this.cleanState(data);session.requestPending=!data.seated;
    if(data.seated&&data.muted!==true){await this.memberAction('mute',session,{muted:true});if(!this.active(session))return false;session.memberState.muted=true;}
    this.log(data.seated?'マイク席に座りました（マイクオフ）':'申請しました。公式の席を待ちます。');this.emit();return data.seated;
   })();session.applyWork=work;try{return await work;}finally{if(session.applyWork===work)session.applyWork=null;}
  }
  // Taking a seat, the way the App does it:
  //  - the host, an admin, or a room that lets anyone straight on (not a group call): ask the seat API directly,
  //    and if the official side refuses, fall back to asking the host rather than giving up;
  //  - everyone else, and every group-call room (room_type 2): send the host the seat request over RTM and wait for the
  //    approval (the host's client auto-approves when the room is open). In an open group room the direct call is
  //    also tried alongside, since either answer gets us on the mic.
  async applySeat(){const session=this.session;
   if(!this.active(session)||!session.memberJoined)throw new UserError('先に公式アカウントで入室してください。');
   const data=await this.checkMember(session);if(!data||!this.active(session))return false;
   if(data.seated){if(!data.muted){const muted=await this.memberAction('mute',session,{muted:true});if(this.active(session)){session.memberState=this.cleanState(muted);this.emit();}}return true;}
   const group=data.room_type===2,privileged=data.is_owner||session.moderators.includes(session.uid);
   if(privileged||(!group&&data.auto_pass)){
    try{return await this.takeSeat(session);}
    catch(error){if(privileged||!this.active(session))throw error;this.log('直接着席できなかったので、ホストに申請します：'+base.describe(error));}
   }
   return this.requestSeat(session,data,group&&data.auto_pass===true);
  }
  async requestSeat(session,data,alsoDirect=false){
   session.requestPending=true;this.emit();
   try {await session.rtm.sendMessageToPeer({text:command(session.room.channel_id,session.uid,3)},String(data.anchor_rtc_uid),{enableOfflineMessaging:false});
    if(!this.active(session))return false;
    if(session.moderators.length>1)await session.channel.sendMessage({text:JSON.stringify({messageType:14,orderType:-1,content:'{}',sendId:session.uid|0,ver:2})})
      .catch(()=>this.log('ホストに送りました。管理者への通知は未確認です。'));
    this.log(data.room_type===2?'グループ通話のホストにマイク席を申請しました。承認待ちです。':'ホストにマイク席を申請しました。承認待ちです。');
    if(alsoDirect)void this.takeSeat(session).catch(error=>{if(this.active(session))this.log('オープンなグループ通話で直接着席できませんでした。承認待ちを続けます：'+base.describe(error));});
    return false;
   }catch(error){session.requestPending=false;this.emit();throw error;}
  }
  // Host tools: invite = RTM orderType 1; kick off mic = orderType 0; kick from
  // room = AudioLive_Kick + RTM type 4. Seat mute stays available but the page
  // uses local この人をミュート instead of a volume slider.
  async inviteToSeat(targetRtcUid){const session=this.session;
   if(!this.active(session)||!session.memberJoined||session.leaving)throw new UserError('先に公式アカウントで入室してください。');
   if(session.memberState?.is_owner!==true)throw new UserError('ホストだけがマイク席へ招待できます。');
   const target=Number(targetRtcUid);
   if(!Number.isSafeInteger(target)||target<1||target>0xffffffff||target===session.uid)throw new UserError('招待先が無効です。');
   await session.rtm.sendMessageToPeer({text:command(session.room.channel_id,session.uid,1,{channel_id:String(session.room.channel_id)})},String(target),{enableOfflineMessaging:false});
   if(!this.active(session))return false;
   this.log('マイク席へ招待しました。相手の応答を待ちます。');this.emit();return true;
  }
  async evictSeat(targetRtcUid){const session=this.session;
   if(!this.active(session)||!session.memberJoined||session.leaving)throw new UserError('先に公式アカウントで入室してください。');
   if(session.memberState?.is_owner!==true)throw new UserError('ホストだけが席から下ろすことができます。');
   const target=Number(targetRtcUid);
   if(!Number.isSafeInteger(target)||target<1||target>0xffffffff||target===session.uid)throw new UserError('対象が無効です。');
   await session.rtm.sendMessageToPeer({text:command(session.room.channel_id,session.uid,0,{channel_id:String(session.room.channel_id)})},String(target),{enableOfflineMessaging:false});
   if(!this.active(session))return false;
   this.log('席から降りてもらいました。');this.emit();return true;
  }
  async allowApplicant(uid){const session=this.session;
   if(!this.active(session)||!session.memberJoined||session.leaving)throw new UserError('先に公式アカウントで入室してください。');
   if(session.memberState?.is_owner!==true)throw new UserError('ホストだけがマイク席を許可できます。');
   const target=Number(uid);
   if(!Number.isSafeInteger(target)||target<1||target>0xffffffff||target===session.uid)throw new UserError('申請対象が無効です。');
   await session.rtm.sendMessageToPeer({text:command(session.room.channel_id,session.uid,4,{channel_id:String(session.room.channel_id)})},String(target),{enableOfflineMessaging:false});
   session.applyQueue=(session.applyQueue||[]).filter(item=>item.uid!==target);
   if(!this.active(session))return false;
   this.log('マイク席を許可しました。');this.emit();return true;
  }
  async kickFromRoom(targetUserId,targetRtcUid){const session=this.session;
   if(!this.active(session)||!session.memberJoined||session.leaving)throw new UserError('先に公式アカウントで入室してください。');
   if(session.memberState?.is_owner!==true)throw new UserError('ホストだけが人をルームから外せます。');
   if(!/^[1-9][0-9]{0,19}$/.test(String(targetUserId||'')))throw new UserError('対象が無効です。');
   const data=await this.memberAction('kick',session,{confirmed:true,target_user_id:String(targetUserId)});
   if(!this.active(session))return false;if(data?.kicked!==true)throw new UserError('公式は退出を確認していません。');
   const rtc=Number(targetRtcUid);
   if(Number.isSafeInteger(rtc)&&rtc>0)await session.rtm.sendMessageToPeer({text:peerEnvelope(4,session.room.channel_id,session.uid,{channel_id:String(session.room.channel_id)})},String(rtc),{enableOfflineMessaging:false}).catch(()=>{});
   this.log('ルームから外しました。');this.emit();return true;
  }
  async updateRoom(fields){const session=this.session;
   if(!this.active(session)||!session.memberJoined||session.leaving)throw new UserError('先に公式アカウントで入室してください。');
   if(session.memberState?.is_owner!==true)throw new UserError('ホストだけがルームを変更できます。');
   const extra={confirmed:true};
   if(fields?.notice!==undefined)extra.notice=String(fields.notice);
   if(fields?.tags!==undefined)extra.tags=String(fields.tags);
   if(fields?.auto_pass!==undefined)extra.auto_pass=fields.auto_pass===true;
   const data=await this.memberAction('update-room',session,extra);
   if(!this.active(session))return false;if(!this.validState(data))throw new UserError('ルーム状態が確認できません。');
   session.memberState=this.cleanState(data);this.log('ルーム設定を保存しました。');this.emit();return true;
  }
  async muteSeat(seatId,muted){const session=this.session;
   if(!this.active(session)||!session.memberJoined||session.leaving)throw new UserError('先に公式アカウントで入室してください。');
   if(session.memberState?.is_owner!==true)throw new UserError('ホストだけがマイク席を管理できます。');
   if(!Number.isSafeInteger(seatId)||seatId<0||seatId>63||typeof muted!=='boolean')throw new UserError('マイク席が無効です。');
   const data=await this.memberAction('seat-mute',session,{confirmed:true,seat_id:String(seatId),muted});
   if(!this.active(session))return false;if(!this.validState(data))throw new UserError('マイク席の状態が確認できません。');
   session.memberState=this.cleanState(data);await this.refreshBoard(session).catch(()=>{});
   if(this.active(session)){this.log(muted?'その席をミュートしました。':'その席のミュートを解除しました。');this.emit();}return true;
  }
  async leaveSeat(){const session=this.session;if(!this.active(session)||!session.memberPermit)return;
   session.requestPending=false;await this.closeMic();if(!this.active(session))return;
   const data=await this.memberAction('leave',session);
   if(this.active(session)){session.memberState=this.cleanState(data);this.log('席を離れました。受信は続けます。');this.emit();}
  }
  async publishMic(authorized=false){if(this.accountMode!=='member')return super.publishMic(authorized);
   if(authorized!==true)throw new UserError('マイクオンを押して、ルームへの送信を確認してください。');
   const session=this.session;if(!this.active(session)||!session.memberJoined||session.leaving)throw new UserError('先に公式アカウントで入室してください。');
   if(session.rtcInterrupted||session.rtcRecovering||session.rtcRecoveryTimer!=null)throw new UserError('音声接続を復旧中です。直ってから手動でマイクオンしてください。');
   if(this.memberPublishWork)return this.memberPublishWork;if(this.micState==='sdk-published-unverified')return true;
   const intent=this.micIntent;
   const work=(async()=>{try{
    if(session.tokenWork)await session.tokenWork;
    if(!this.active(session)||intent!==this.micIntent)return false;
    const state=await this.checkMember(session);if(!this.active(session)||intent!==this.micIntent)return false;
    if(!state?.seated)throw new UserError('マイク席がまだありません。先にマイク席へを押してください。');
    const data=await this.memberAction('publisher',session,{confirmed:true}),p=tokenPrivileges(data.rtc_token);
    if(!this.active(session)||intent!==this.micIntent)return false;
    if(!this.validState(data)||!data.seated||Number(data.user_id)!==session.uid||!p.known||!p.declaresJoin||!p.declaresPublishAudio)throw new UserError('公式の配信権限が確認できません。');
    await session.client.renewToken(data.rtc_token);if(!this.active(session)||intent!==this.micIntent)return false;
    const track=await this.checkMic(),record=this.mic;if(!track||!record||!this.active(session))return false;
    record.session=session;this.micState='publishing';this.emit();
    record.memberUnmute=this.memberAction('mute',session,{muted:false,confirmed:true});await record.memberUnmute;
    if(this.mic!==record||!this.active(session))return false;
    await session.client.setClientRole('host');if(this.mic!==record||!this.active(session))return false;
    record.publishPromise=session.client.publish([track]);await record.publishPromise;
    if(this.mic!==record||!this.active(session))return false;
    session.memberState={...this.cleanState(data),muted:false};this.micState='sdk-published-unverified';
    this.log('公式席のミュートを解除し、SDK は送信を受け付けました。相手が聞こえて初めて発声確認になります。');this.emit();return true;
   }catch(error){await this.closeMic();throw error;}})();
   this.memberPublishWork=work;try{return await work;}finally{if(this.memberPublishWork===work)this.memberPublishWork=null;}
  }
  async closeMic(){const session=this.mic?.session||this.session;await super.closeMic();
   if(session?.memberPermit&&this.active(session)){await session.client.setClientRole('audience').catch(()=>{});this.emit();}
  }
  async dispose(session){if(!session?.memberPermit)return super.dispose(session);if(session.memberDisposing)return session.memberDisposing;
   if(session.memberTimer!==null)this.timers.clearTimeout(session.memberTimer);session.memberTimer=null;session.requestPending=false;
   if(session.tokenTimer!==null)this.timers.clearTimeout(session.tokenTimer);session.tokenTimer=null;
   if(session.rtcRecoveryTimer!=null)this.timers.clearTimeout(session.rtcRecoveryTimer);session.rtcRecoveryTimer=null;
   if(session.boxTimer!=null)this.timers.clearTimeout(session.boxTimer);session.boxTimer=null;
   session.memberDisposing=(async()=>{await super.dispose(session);
    try{await session.channel.leave();}catch{}try{await session.rtm.logout();}catch{}
    session.channel.removeAllListeners?.();session.rtm.removeAllListeners?.();
    if(!session.memberReleased)await this.memberAction('release',session).catch(()=>this.log('マイク席の掃除は確認できませんでした。バックグラウンドで再試行します。'));session.memberPermit=null;
   })();return session.memberDisposing;
  }
 }
 return {Controller,command,approved,invited,commandSender,inviteFrom,authorizedInviter,kicked,welcomeLine,joinWelcome,chatText,chatImage,textMessage,timeGreeting,GREETINGS};
});

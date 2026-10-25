/* Mobile-first UI. Account/RTC/RTM lifecycle lives in the controllers. */
(function(){
 'use strict';
 const ids=['btnBrowse','connectionBadge','appNotice','status','audioStatus','audioCount','boardTitle','roomMode','roomContents','auditionNotice','micBar','micInfo','hostPanel','hostNotice','btnSaveNotice','hostTags','btnSaveTags','hostAutoPass','applyQueue','applyList','publicChatBlock','btnReplay','log','btnStopPreview','btnExitRoom','btnForceLeave','btnEndRoom','btnBlockHost','btnApplySeat','btnLeaveSeat','btnOpenMic','btnCloseMic','micLevel','micStatus','memberStatus','secureHint','boardStatus','seatList','memberList','seatCount','memberCount','memberPager','btnPrevMembers','btnNextMembers','memberPage','autoWelcome','autoLikeRoom','autoTranslate','publicChat','chatForm','chatInput','btnChatSend','btnTimeGreet','chatStatus','hostGreetRow','hostDog','hostWelcomeText','searchForm','searchInput','btnSearch','searchStatus','btnRefreshRooms','btnCreateRoom','roomsStatus','roomList','btnPrevRooms','btnNextRooms','pageStatus','roomLabel','roomLabelControl','searchRecommendations','friendsStatus','friendList','btnRefreshFriends','btnMoreFriends','createRoomDialog','createRoomForm','createRoomName','createRoomLabel','createRoomTags','createRoomAutoPass','btnCreateRoomSubmit','btnCloseCreateRoom','createRoomStatus'];
 const el=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
 const workspace=document.querySelector('.workspace');let browsing=false;
 const micAllowed=!!(window.isSecureContext&&navigator.mediaDevices?.getUserMedia);
 let actionPending=false,forcing=false,accountReady=false,listBusy=false,rooms=[],pageIndex=0,nextCursor='',directoryMode='',searchActive=false,listGeneration=0,listAbort=null;
 // Official directory rows can lag behind a room closing. Refresh visible
 // discovery, and suppress only rooms positively confirmed ended (HTTP 404).
 let roomsAttemptAt=0,friendsAttemptAt=0;
 const closedRooms=new Map();
 function availableRooms(rows){const now=Date.now();for(const [id,until] of closedRooms)if(until<=now)closedRooms.delete(id);
  return rows.filter(room=>!closedRooms.has(String(room.channel_id)));}
 const logLines=[];
 function log(message){logLines.push(`[${new Date().toLocaleTimeString()}] ${message}`);if(logLines.length>100)logLines.shift();el.log.textContent=logLines.join('\n');el.log.scrollTop=el.log.scrollHeight;}
 function notice(message){el.appNotice.textContent=message||'';el.appNotice.hidden=!message;}
 const controller=new GravityMember.Controller({getSdk:async()=>{if(!window.AgoraRTC)throw new GravityWeb.UserError('音声コンポーネントが読み込めていません。更新してください。');return window.AgoraRTC;},onLog:log,onChange:render});
 async function action(fn){if(actionPending)return;actionPending=true;notice('');render(controller.snapshot());try{return await fn();}catch(error){notice(GravityWeb.describe(error));}finally{actionPending=false;render(controller.snapshot());}}
 function isBusy(s){return actionPending||s.leaving||['resolving','connecting','reconnecting','stopping'].includes(s.state);}
 let lastRoomKey='',lastHostFill='',shownBoard,shownMembers=[],memberPageIndex=0;
 const chatRows=new WeakMap();
 function render(s){
  const busy=isBusy(s),member=s.accountMode==='member'&&s.state==='listening',audition=s.accountMode==='anonymous'&&s.running;
  workspace.classList.toggle('has-room',s.running);workspace.classList.toggle('show-discovery',browsing);
  el.btnBrowse.hidden=!s.running;el.btnBrowse.textContent=browsing?'一覧を閉じる':'ルームを探す';
  el.connectionBadge.textContent=member?(s.micState==='sdk-published-unverified'?'入室中 · マイクオン':'入室中'):audition?'試聴中':s.running?'接続中':'未接続';
  el.status.textContent=s.state==='listening'?'':s.message;
  el.audioStatus.hidden=!s.running;el.audioCount.textContent=`${GravityView.remoteSpeakers(s)}人`;
  el.boardTitle.textContent=s.room?.title||'メンバーとチャット';el.roomMode.textContent=member?'入室中':audition?'匿名試聴 · 未入室':'いまのルーム';
  el.btnExitRoom.hidden=!member;el.btnExitRoom.disabled=busy;
  el.btnExitRoom.textContent='退室';
  // Force quit lives in the top bar and is always there: clickable while busy,
  // leaving or stuck in 'stopping', and with no local room at all (a refreshed
  // page whose old connection the server still holds).
  el.btnForceLeave.hidden=false;el.btnForceLeave.disabled=forcing;
  el.btnEndRoom.hidden=!(member&&s.memberState?.is_owner===true);el.btnEndRoom.disabled=busy;
  el.btnStopPreview.hidden=!audition;el.btnStopPreview.disabled=busy;
  el.btnBlockHost.hidden=!member||s.memberState?.is_owner===true;el.btnBlockHost.disabled=busy||!accountReady;
  el.btnCreateRoom.disabled=!accountReady||listBusy||busy;
  el.roomContents.hidden=!(member||audition);
  el.auditionNotice.hidden=!audition;
  el.micBar.hidden=!member;el.micInfo.hidden=!member;
  el.memberStatus.hidden=!member;el.secureHint.hidden=!member;el.publicChatBlock.hidden=!member;
  const roomKey=String(s.room?.channel_id||'')+':'+s.accountMode;
  if(roomKey!==lastRoomKey){el.chatInput.value='';el.chatStatus.textContent='';lastRoomKey=roomKey;lastHostFill='';memberPageIndex=0;}
  const host=!!(member&&s.isHost);
  el.hostPanel.hidden=!host;el.hostGreetRow.hidden=!host;
  if(host){
   if(roomKey!==lastHostFill){lastHostFill=roomKey;el.hostNotice.value=s.memberState?.notice||'';el.hostTags.value=s.memberState?.tags||'';
    if(!el.hostWelcomeText.value)el.hostWelcomeText.value=s.hostWelcomeText||'';}
   if(document.activeElement!==el.hostAutoPass)el.hostAutoPass.checked=!!s.memberState?.auto_pass;
   el.hostDog.checked=!!s.hostDog;el.hostAutoPass.disabled=busy;el.btnSaveNotice.disabled=busy;el.btnSaveTags.disabled=busy;
  }else lastHostFill='';
  if(member){el.autoWelcome.checked=!!s.autoWelcome;el.autoLikeRoom.checked=!!s.autoLikeRoom;}
  const queue=host?(s.applyQueue||[]):[];el.applyQueue.hidden=!queue.length;
  if(el.applyList.children.length!==queue.length||queue.some((item,i)=>el.applyList.children[i]?.dataset.uid!==String(item.uid))){
   el.applyList.replaceChildren();for(const item of queue){const li=document.createElement('li');li.dataset.uid=String(item.uid);li.textContent=item.name||String(item.uid);
    const btn=document.createElement('button');btn.type='button';btn.className='compact';btn.textContent='許可';btn.disabled=busy;
    btn.addEventListener('click',()=>{void action(()=>controller.allowApplicant(item.uid));});li.append(btn);el.applyList.append(li);}
  }else for(const btn of el.applyList.querySelectorAll('button'))btn.disabled=busy;
  const controls=GravityView.micControls(s,micAllowed);
  for(const [id,key] of [['btnApplySeat','apply'],['btnLeaveSeat','leave'],['btnOpenMic','open'],['btnCloseMic','close']])el[id].disabled=busy||!controls[key];
  el.btnApplySeat.textContent='マイク席へ';
  el.micStatus.textContent=s.micClosing?'マイクオフ中…':({'off':'マイクオフ','checking':'マイク許可待ち…','local-ready':'マイク準備中…','publishing':'マイクオン中…','sdk-published-unverified':'マイクオン'})[s.micState]||'マイクオフ';
  el.memberStatus.textContent=member?(s.memberState?.seated?`${s.memberState.seat_id}番席${s.memberState.is_owner?' · ホスト席':''}`:s.seatRequestState==='waiting'?'ホストの承認待ち':'席の外'):'';
  el.secureHint.textContent=micAllowed?'':'マイクには HTTPS とブラウザの許可が必要です。';
  // The roster is replaced (never mutated) on refresh, so object identity says whether the lists are stale.
  // Audition reuses the same lists from the no-entry preview: same room view, only the account is outside.
  const board=member?s.roomBoard:(audition?auditionBoard:null);
  if(board!==shownBoard){shownBoard=board;const seats=board?.seats||[];shownMembers=board?GravityView.offStage(board):[];
   renderPeople(el.seatList,seats,true,member&&s.isHost);renderMembers(member&&s.isHost);
   el.seatCount.textContent=`${seats.filter(row=>row.person).length}人`;}
  el.boardStatus.textContent=member&&!s.roomBoard?'名簿を読み込み中…':(member&&s.presence==='degraded'?'在室確認を再試行中。受信は続けます…':(audition?auditionStatusText:''));
  const chatScroll=el.publicChat.scrollTop,follow=chatScroll+el.publicChat.clientHeight>=el.publicChat.scrollHeight-24;
  const rows=s.chatMessages.map(message=>{let row=chatRows.get(message);if(!row){row=chatRow(message);chatRows.set(message,row);}return row;});
  if(el.publicChat.children.length!==rows.length||rows.some((row,i)=>el.publicChat.children[i]!==row.li))el.publicChat.replaceChildren(...rows.map(row=>row.li));
  for(const row of rows){if(row.transBox)row.transBox.hidden=!el.autoTranslate.checked||!row.transBox.lastChild.textContent;if(row.button){const state=row.message.thanksState,label=({pending:'お礼中',sent:'お礼済み',unconfirmed:'未確認'})[state]||'ありがとう',off=busy||s.chatSending||state!=='none';
   if(row.button.textContent!==label)row.button.textContent=label;if(row.button.disabled!==off)row.button.disabled=off;}
  }
  el.publicChat.scrollTop=follow?el.publicChat.scrollHeight:chatScroll;
  el.chatInput.disabled=!s.chatAvailable||busy;el.btnChatSend.disabled=!s.chatAvailable||s.chatSending||busy;el.btnTimeGreet.disabled=!s.chatAvailable||s.chatSending||busy;
  for(const target of [el.roomList,el.friendList])for(const item of target.children){
   const selected=s.running&&item.dataset.channelId===String(s.room?.channel_id);
   item.classList.toggle('current',selected);
   const currentMode=s.accountMode==='member'?'member':'anonymous';
   for(const button of item.querySelectorAll('button[data-mode]')){const mode=button.dataset.mode,active=selected&&currentMode===mode;
    const label=active?(mode==='member'?'入室中':'試聴中'):(mode==='member'?'入室':'試聴');
    button.disabled=busy||(mode==='member'&&!accountReady)||active;if(button.textContent!==label)button.textContent=label;}
  }
 }
 // A chat line is immutable once added; only its thank-you button changes state, so lines are built once.
 function chatRow(message){const li=document.createElement('li'),row={message,li,button:null};
  li.classList.toggle('own',!!message.own);li.classList.toggle('gift',message.kind==='gift');
  const who=document.createElement('span');who.textContent=`${message.name}${message.own?'（自分）':''}：`;li.append(who);
  if(message.kind==='image'&&message.image){const img=document.createElement('img');img.className='chat-photo';img.src=message.image;img.alt='画像';img.width=Math.min(240,message.width||240);img.referrerPolicy='no-referrer';li.append(img);}
  else {const body=document.createElement('span');body.textContent=message.text;li.append(body);}
  if(window.GravityTranslate?.enabled()&&typeof message.text==='string'&&!message.own&&message.kind!=='gift'&&message.kind!=='image'&&!(window.GravityTranslate.skipTranslate||window.GravityTranslate.looksChinese)(message.text)){
   const tbox=document.createElement('div');tbox.className='chat-trans';tbox.hidden=true;
   const tag=document.createElement('span');tag.className='trans-tag';tag.textContent='訳';tbox.append(tag);
   const tspan=document.createElement('span');tbox.append(tspan);li.append(tbox);row.transBox=tbox;
   const cached=window.GravityTranslate.peek(message.text.trim());
   const fill=t=>{if(t&&tbox.isConnected){tspan.textContent=t;tbox.hidden=!el.autoTranslate.checked;}};
   if(cached)fill(cached);else void window.GravityTranslate.translateText(message.text).then(fill);
  }
  if(message.gift?.source_verified&&message.gift.recipient_uid===controller.accountUid&&message.gift.sender_uid!==controller.accountUid){
   const button=document.createElement('button');button.type='button';button.className='secondary compact gift-thank';
   button.addEventListener('click',()=>{void controller.thankGift(message.gift.key).catch(error=>notice(GravityWeb.describe(error)));});li.append(button);row.button=button;
  }
  return row;}
 function cdnImage(url){try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='cdn.gravity.place'&&!u.username&&!u.password&&!u.port?u.origin+u.pathname:'';}catch{return '';}}
 // The roster refreshes itself; a long one is shown a page at a time (the section itself collapses).
 function renderMembers(host=false){const p=GravityView.page(shownMembers,memberPageIndex,GravityView.MEMBER_PAGE_SIZE);memberPageIndex=p.index;
  renderPeople(el.memberList,p.rows,false,host);el.memberCount.textContent=`${shownMembers.length}人`;
  el.memberPager.hidden=p.count<=1;el.memberPage.textContent=`${p.index+1} / ${p.count}`;el.btnPrevMembers.disabled=p.index===0;el.btnNextMembers.disabled=p.index>=p.count-1;}
 function renderPeople(target,rows,seats=false,host=false){target.replaceChildren();const off=isBusy(controller.snapshot());for(const row of rows){const person=seats?row.person:row,li=document.createElement('li');
  const contact=person&&!person.is_self&&!GravityView.officialUser(person.user_id),show=()=>{void window.GravityProfileUI?.open(person);};
  const portrait=cdnImage(person?.portrait);if(portrait){const img=document.createElement('img');img.src=portrait;img.alt='';img.width=img.height=28;img.referrerPolicy='no-referrer';
   const wrap=document.createElement(contact?'button':'span');if(contact){wrap.type='button';wrap.className='person-avatar';wrap.setAttribute('aria-label',`プロフィールを見る：${person.name||person.user_id}`);wrap.addEventListener('click',show);}else wrap.className='person-avatar static';
   wrap.append(img);if(person.country){const badge=document.createElement('span');badge.className='country-badge';badge.textContent=person.country;wrap.append(badge);}li.append(wrap);}
  const label=document.createElement(contact?'button':'span');
  if(contact){label.type='button';label.className='person-link';label.title='プロフィールと投稿を見る';label.addEventListener('click',show);}
  label.textContent=`${seats?row.seat_id+' · ':''}${person?(person.name||person.user_id)+(person.is_self?'（自分）':''):'空き席'}${seats&&person?(row.muted?' · マイクオフ':' · マイクオン'):''}${person?.blocked?' · ミュート中':''}`;li.append(label);
  if(host&&contact&&seats&&person?.rtc_uid){
   const down=document.createElement('button');down.type='button';down.className='secondary compact seat-tool';
   down.textContent='席から下ろす';down.title='マイク席から降りてもらいます';down.disabled=off;
   down.addEventListener('click',()=>{void action(()=>controller.evictSeat(person.rtc_uid));});li.append(down);
  } else if(host&&contact&&!seats&&person?.rtc_uid){
   const invite=document.createElement('button');invite.type='button';invite.className='secondary compact seat-tool';
   invite.textContent='席へ招待';invite.title='マイク席へ招待します';invite.disabled=off;
   invite.addEventListener('click',()=>{void action(()=>controller.inviteToSeat(person.rtc_uid));});li.append(invite);
  }
  if(host&&contact&&person?.user_id){
   const kick=document.createElement('button');kick.type='button';kick.className='destructive compact seat-tool';
   kick.textContent='退出させる';kick.title='ルームから退出させます';kick.disabled=off;
   kick.addEventListener('click',()=>{if(!confirm(((person.name||person.user_id))+' をルームから退出させますか？'))return;void action(()=>controller.kickFromRoom(person.user_id,person.rtc_uid));});li.append(kick);
  }
  if(person&&!person.is_self&&person.rtc_uid){const mute=document.createElement('label');mute.className='listener-mute';
   const box=document.createElement('input');box.type='checkbox';box.checked=controller.listenerMuted(person.rtc_uid);
   box.addEventListener('click',event=>event.stopPropagation());
   box.addEventListener('change',event=>{event.stopPropagation();controller.toggleListenerMute(person.rtc_uid,box.checked);});
   mute.append(box,' この人をミュート');li.append(mute);}
  target.append(li);}}
 // Audition roster: the same no-entry preview the old popup used, now rendered
 // inline so trial looks like the entered room. No RTC/RTM beyond anonymous
 // audio, no presence, no greeting; profile clicks work the same.
 let auditionBoard=null,auditionStatusText='',auditionTimer=0,auditionChannel='';
 async function loadAuditionBoard(){
  const channel=auditionChannel;
  if(!channel||controller.snapshot().accountMode!=='anonymous'||!controller.snapshot().running)return;
  try{
   const response=await fetch('/api/member/preview?channel_id='+encodeURIComponent(channel),{cache:'no-store'});
   const result=await response.json().catch(()=>({}));
   if(channel!==auditionChannel)return;
   if(!response.ok||result.errno!==0)throw new GravityWeb.UserError(result.errmsg||'名簿を取得できません。');
   const data=result.data||{};
   auditionBoard={members:Array.isArray(data.members)?data.members:[],seats:Array.isArray(data.seats)?data.seats:[]};
   auditionStatusText=(data.members&&data.members.length?'':'いまは誰もいません · ')+'更新 '+new Date().toLocaleTimeString();
  }catch(error){if(channel===auditionChannel)auditionStatusText=GravityWeb.describe(error);}
  render(controller.snapshot());
 }
 function startAuditionPolling(channel){stopAuditionPolling();auditionChannel=String(channel||'');auditionBoard=null;auditionStatusText='名簿を読み込み中…';
  if(auditionChannel){void loadAuditionBoard();auditionTimer=setInterval(()=>{if(!document.hidden)void loadAuditionBoard();},15000);}}
 function stopAuditionPolling(){clearInterval(auditionTimer);auditionTimer=0;auditionChannel='';auditionBoard=null;auditionStatusText='';shownBoard=null;shownMembers=[];memberPageIndex=0;}
 async function enterRoom(room,mode){await action(async()=>{
  if(mode!=='anonymous'&&mode!=='member')throw new GravityWeb.UserError('試聴か入室だけ使えます。ページを更新してやり直してください。');
  const s=controller.snapshot(),currentMode=s.accountMode==='member'?'member':'anonymous';
  if(s.running&&String(s.room?.channel_id)===String(room.channel_id)&&currentMode===mode)return;
  if(s.accountMode==='member'&&s.running)await controller.leaveRoom();
  stopAuditionPolling();browsing=false;
  const ok=await controller.start({channel_id:String(room.channel_id),anchor_id:String(room.anchor_id),title:room.title,anchor_name:room.anchor_name,count:room.count,
   accountMode:mode==='anonymous'?'anonymous':'member',memberConfirmed:mode!=='anonymous'});
  if(ok&&mode==='anonymous')startAuditionPolling(room.channel_id);else stopAuditionPolling();
  if(!ok&&controller.state==='error'){
   notice(controller.message);
   if(mode==='member'&&controller.snapshot().errorStatus===404){
    closedRooms.set(String(room.channel_id),Date.now()+300_000);if(closedRooms.size>200)closedRooms.delete(closedRooms.keys().next().value);
    rooms=availableRooms(rooms);friendRows=availableRooms(friendRows);renderRooms();renderFriendRooms();
    notice(controller.message+' 期限切れの項目を外しました。');if(!searchActive)void loadRooms(false,true);
   }
  }
  if(ok&&innerWidth<860)document.getElementById('roomPanel').scrollIntoView({block:'start',behavior:'smooth'});
 });}
 function roomItem(room,friend=false){const item=document.createElement('li');item.dataset.channelId=String(room.channel_id);
  const anchor={user_id:String(room.anchor_id||''),name:room.anchor_name,portrait:room.portrait};
  const anchorPersonal=/^[1-9][0-9]{0,19}$/.test(anchor.user_id)&&!GravityView.officialUser(anchor.user_id);
  const openAnchor=()=>{if(anchorPersonal)void window.GravityProfileUI?.open(anchor);};
  const portrait=cdnImage(room.portrait||room.cover);if(portrait){const img=document.createElement('img');img.className='portrait';img.alt='';img.width=img.height=40;img.loading='lazy';img.referrerPolicy='no-referrer';img.src=portrait;
   if(anchorPersonal){const photo=document.createElement('button');photo.type='button';photo.className='person-avatar';photo.title=`ホストのプロフィール：${room.anchor_name||room.anchor_id}`;photo.setAttribute('aria-label',photo.title);photo.append(img);photo.addEventListener('click',openAnchor);item.append(photo);}else item.append(img);}
  const meta=document.createElement('div');meta.className='meta';const title=document.createElement('div');title.className='title';title.textContent=room.title||'無題のルーム';
  const sub=document.createElement('div');sub.className='sub';
  if(friend&&(room.friends?.length||room.friend_names?.length)){
   for(const person of (room.friends?.length?room.friends:room.friend_names.map(name=>({name})))){
    if(sub.hasChildNodes())sub.append('、');
    if(person.user_id&&!GravityView.officialUser(person.user_id)){const who=document.createElement('button');who.type='button';who.className='person-link';who.textContent=person.name||person.user_id;who.title='プロフィールと投稿を見る';
     who.addEventListener('click',()=>{void window.GravityProfileUI?.open(person);});sub.append(who);}else sub.append(person.name||person.user_id||'');
   }
   if(room.follow_type===2&&!room.friends?.length&&!room.friend_names?.length)sub.textContent='フォロー中のフレンドがいます';
  } else sub.textContent=friend?(room.follow_type===2?'フォロー中のフレンドがいます':'フォロー中のホスト'):[room.anchor_name,room.count!=null?`${room.count}人`:'',room.label].filter(Boolean).join(' · ');
  if(!friend&&anchorPersonal){sub.replaceChildren();const who=document.createElement('button');who.type='button';who.className='person-link';who.textContent=room.anchor_name||room.anchor_id;who.title='ホストのプロフィールと投稿を見る';who.addEventListener('click',openAnchor);sub.append(who);
   for(const extra of [room.count!=null?`${room.count}人`:'',room.label].filter(Boolean)){const tail=document.createElement('span');tail.textContent=' · '+extra;sub.append(tail);}}
  if(friend){const badge=document.createElement('span');badge.className='friend-state';badge.textContent=room.follow_type===1?'自分のルーム':'他のルーム';meta.append(badge);}
  meta.append(title,sub);const buttons=document.createElement('div');buttons.className='room-actions';
  for(const [mode,label,title] of [['anonymous','試聴','入室せず、音声と名簿だけ'],['member','入室','']]){const btn=document.createElement('button');btn.type='button';btn.dataset.mode=mode;btn.className=mode==='member'?'':'secondary';btn.textContent=label;if(title)btn.title=title;btn.addEventListener('click',()=>{void enterRoom(room,mode);});buttons.append(btn);}
  item.append(meta,buttons);return item;}
 function renderRooms(){const p=GravityView.page(rooms,pageIndex);pageIndex=p.index;el.roomList.replaceChildren(...p.rows.map(room=>roomItem(room)));
  el.roomsStatus.textContent=rooms.length?`${searchActive?'検索結果':directoryMode==='hot'?'人気のルーム':'オンラインのルーム'} · ${rooms.length}${nextCursor?' +':''}`:'オンラインのルームはありません';
  el.pageStatus.textContent=`${pageIndex+1} / ${p.count}${nextCursor?' +':''}`;el.btnPrevRooms.disabled=listBusy||pageIndex===0;el.btnNextRooms.disabled=listBusy||(pageIndex>=p.count-1&&!nextCursor);
  render(controller.snapshot());}
 async function fetchData(url,signal){const response=await fetch(url,{signal,cache:'no-store'}),result=await response.json().catch(()=>({}));if(!response.ok||result.errno!==0)throw new GravityWeb.UserError(result.errmsg||'読み込めませんでした。やり直してください。');return result.data||{};}
 async function postJson(url,body,action){const response=await fetch(url,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-Gravity-Action':action},body:JSON.stringify(body)}),result=await response.json().catch(()=>({}));if(!response.ok||result.errno!==0)throw new GravityWeb.UserError(result.errmsg||'操作できませんでした。やり直してください。');return result.data||{};}
 function fillLabels(select,labels,blankText){const current=select.value;select.replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent=blankText;select.append(blank);for(const label of labels){const option=document.createElement('option');option.value=label.id;option.textContent=label.label;select.append(option);}if([...select.options].some(o=>o.value===current))select.value=current;}
 function beginList(){listAbort?.abort();listAbort=new AbortController();listBusy=true;el.btnSearch.disabled=el.btnRefreshRooms.disabled=true;renderRooms();return {generation:++listGeneration,signal:listAbort.signal};}
 function finishList(generation){if(generation!==listGeneration)return;listBusy=false;el.btnSearch.disabled=el.btnRefreshRooms.disabled=false;el.roomLabel.disabled=searchActive||directoryMode!=='official';renderRooms();void loadAccount();}
 async function searchRooms(keyword){const q=String(keyword||'').trim().slice(0,100);if(!q)return;el.searchInput.value=q;const {generation,signal}=beginList();el.searchStatus.textContent='検索中…';
  try{const data=await fetchData('/api/search?'+new URLSearchParams({keyword:q,limit:'20'}),signal);if(generation!==listGeneration)return;
   rooms=availableRooms(Array.isArray(data.rooms)?data.rooms:[]);nextCursor='';pageIndex=0;searchActive=true;el.searchStatus.textContent=data.notice||'';
  }catch(error){if(generation===listGeneration&&!signal.aborted)notice(GravityWeb.describe(error));}finally{finishList(generation);}}
 async function loadRooms(append=false,background=false){if(background&&(listBusy||searchActive))return;
  const cursor=append?nextCursor:'';if(append&&!cursor)return;roomsAttemptAt=Date.now();const {generation,signal}=beginList();el.searchStatus.textContent='';
  try{const data=await fetchData('/api/rooms?'+new URLSearchParams({label_id:el.roomLabel.value,...(cursor?{cursor}:{})}),signal);if(generation!==listGeneration)return;
   const same=append&&data.mode===directoryMode,previous=rooms.length,combined=same?[...rooms,...(data.rooms||[])]:data.rooms||[];
   rooms=availableRooms([...new Map(combined.map(r=>[String(r.channel_id),r])).values()]).slice(0,200);directoryMode=data.mode||'';searchActive=false;
   if(!same&&!background)pageIndex=0;else if(same&&rooms.length>previous)pageIndex++;
   nextCursor=data.next_cursor&&data.next_cursor!==cursor&&(!append||rooms.length>previous)&&rooms.length<200?data.next_cursor:'';
   if(directoryMode!=='official')el.roomLabel.value='';el.searchStatus.textContent=data.notice||'';
  }catch(error){if(!background&&generation===listGeneration&&!signal.aborted)notice(GravityWeb.describe(error));}finally{finishList(generation);}}
 // No bulk per-room probes: just one directory read per minute while visible.
 // Background failures retain the old list and never interrupt room audio.
 function refreshDiscovery(){if(document.hidden||workspace.hidden||document.querySelector('dialog[open]'))return;
  const s=controller.snapshot();if(s.running&&!browsing&&innerWidth<860)return;
  if(!searchActive&&!listBusy&&Date.now()-roomsAttemptAt>=60_000)void loadRooms(false,true);
  if(!friendBusy&&Date.now()-friendsAttemptAt>=60_000)void loadFriends();
 }
 async function loadAccount(){try{const status=await fetchData('/api/account/status');accountReady=status.state==='verified'||status.state==='ready_unverified';}catch{accountReady=false;}render(controller.snapshot());}
 async function loadDiscovery(){const result=await Promise.allSettled([fetchData('/api/labels'),fetchData('/api/search/recommendations')]);
  if(result[0].status==='fulfilled'){const labels=result[0].value.labels||[];fillLabels(el.roomLabel,labels,'すべてのルーム');fillLabels(el.createRoomLabel,labels,'分類を選ぶ');el.roomLabelControl.hidden=false;}
  if(result[1].status==='fulfilled')for(const keyword of result[1].value.keywords||[]){const btn=document.createElement('button');btn.type='button';btn.className='secondary';btn.textContent=keyword;btn.addEventListener('click',()=>{void searchRooms(keyword);});el.searchRecommendations.append(btn);}
  await loadAccount();void loadFriends();}
 let friendRows=[],friendCursor='',friendBusy=false;
 function renderFriendRooms(message=''){el.friendList.replaceChildren(...friendRows.map(room=>roomItem(room,true)));el.friendsStatus.textContent=friendRows.length?'':message||'フォロー中のフレンドはルームにいません';}
 async function loadFriends(append=false){if(friendBusy)return;friendsAttemptAt=Date.now();friendBusy=true;el.btnRefreshFriends.disabled=el.btnMoreFriends.disabled=true;
  try{const data=await fetchData('/api/friends/rooms'+(append&&friendCursor?'?cursor='+encodeURIComponent(friendCursor):''));
   friendRows=availableRooms(append?[...friendRows,...data.rooms]:data.rooms||[]);friendCursor=data.next_cursor||'';
   renderFriendRooms(data.notice);
  }catch(error){el.friendsStatus.textContent=GravityWeb.describe(error);}finally{friendBusy=false;el.btnRefreshFriends.disabled=el.btnMoreFriends.disabled=false;el.btnMoreFriends.hidden=!friendCursor;render(controller.snapshot());}}
 el.searchForm.addEventListener('submit',event=>{event.preventDefault();void searchRooms(el.searchInput.value);});
 el.btnRefreshRooms.addEventListener('click',()=>{void loadRooms();});el.roomLabel.addEventListener('change',()=>{void loadRooms();});
 el.btnCreateRoom.addEventListener('click',()=>{el.createRoomStatus.textContent='';if(!el.createRoomDialog.open)el.createRoomDialog.showModal();});
 el.btnCloseCreateRoom.addEventListener('click',()=>{if(el.createRoomDialog.open)el.createRoomDialog.close();});
 el.createRoomForm.addEventListener('submit',event=>{event.preventDefault();void action(async()=>{el.createRoomStatus.textContent='作成中…';el.btnCreateRoomSubmit.disabled=true;
  try{const data=await postJson('/api/rooms/create',{name:el.createRoomName.value.trim(),label_id:el.createRoomLabel.value,tags:el.createRoomTags.value.trim(),auto_pass:el.createRoomAutoPass.checked,confirmed:true,request_id:crypto.randomUUID()},'room-control');
   if(el.createRoomDialog.open)el.createRoomDialog.close();el.createRoomName.value='';const s=controller.snapshot();if(s.accountMode==='member'&&s.running)await controller.leaveRoom();browsing=false;stopAuditionPolling();
   // Nobody is in a brand-new room, so no entry greeting (or goodbye) for it.
   const ok=await controller.start({channel_id:String(data.channel_id),anchor_id:String(data.anchor_id),title:data.title,accountMode:'member',memberConfirmed:true,});
   if(!ok&&controller.state==='error')notice(controller.message);if(ok&&innerWidth<860)document.getElementById('roomPanel').scrollIntoView({block:'start',behavior:'smooth'});
  }catch(error){el.createRoomStatus.textContent=GravityWeb.describe(error);throw error;}finally{el.btnCreateRoomSubmit.disabled=false;}});});
 el.btnPrevRooms.addEventListener('click',()=>{if(!listBusy){pageIndex--;renderRooms();}});
 el.btnNextRooms.addEventListener('click',()=>{if(listBusy)return;if((pageIndex+1)*GravityView.PAGE_SIZE<rooms.length){pageIndex++;renderRooms();}else void loadRooms(true);});
 el.btnRefreshFriends.addEventListener('click',()=>{void loadFriends();});el.btnMoreFriends.addEventListener('click',()=>{void loadFriends(true);});
 try{if(localStorage.getItem('gravity.translate')==='0'){el.autoTranslate.checked=false;window.GravityTranslate?.setEnabled(false);}}
 catch{}
 try{el.autoWelcome.checked=localStorage.getItem('gravity.autoWelcome')==='1';el.autoLikeRoom.checked=localStorage.getItem('gravity.autoLikeRoom')==='1';
  el.hostDog.checked=localStorage.getItem('gravity.hostDog')==='1';el.hostWelcomeText.value=localStorage.getItem('gravity.hostWelcomeText')||'';}catch{}
 el.autoTranslate.addEventListener('change',()=>{window.GravityTranslate?.setEnabled(el.autoTranslate.checked);render(controller.snapshot());});
 el.autoWelcome.addEventListener('change',()=>controller.setPref('autoWelcome',el.autoWelcome.checked));
 el.autoLikeRoom.addEventListener('change',()=>controller.setPref('autoLikeRoom',el.autoLikeRoom.checked));
 el.hostDog.addEventListener('change',()=>controller.setPref('hostDog',el.hostDog.checked));
 el.hostWelcomeText.addEventListener('change',()=>controller.setWelcomeText(el.hostWelcomeText.value));
 el.hostGreetRow.addEventListener('submit',event=>event.preventDefault());
 el.btnSaveNotice.addEventListener('click',()=>{void action(()=>controller.updateRoom({notice:el.hostNotice.value}));});
 el.btnSaveTags.addEventListener('click',()=>{void action(()=>controller.updateRoom({tags:el.hostTags.value}));});
 el.hostAutoPass.addEventListener('change',()=>{void action(()=>controller.updateRoom({auto_pass:el.hostAutoPass.checked}));});
 el.btnBrowse.addEventListener('click',()=>{window.GravityFeedUI?.showRooms();browsing=!browsing;render(controller.snapshot());if(browsing)refreshDiscovery();if(browsing&&innerWidth<860)document.querySelector('.discovery').scrollIntoView({block:'start',behavior:'smooth'});});
 el.btnBlockHost.addEventListener('click',()=>{void action(async()=>{const result=await controller.blockHostAndLeave();notice('ホストをブロックして退室しました。別れのメッセージは送っていません。');
  rooms=rooms.filter(r=>String(r.anchor_id)!==result.user_id);friendRows=friendRows.filter(r=>String(r.anchor_id)!==result.user_id);el.friendList.replaceChildren(...friendRows.map(r=>roomItem(r,true)));renderRooms();});});
 el.btnEndRoom.addEventListener('click',()=>{if(!confirm('ルームを終了すると全員が退室します。よろしいですか？'))return;void action(async()=>{await controller.endRoom();notice('ルームを終了しました。');});});
 el.btnExitRoom.addEventListener('click',()=>{void action(()=>controller.leaveRoom());});el.btnStopPreview.addEventListener('click',()=>{stopAuditionPolling();void action(()=>controller.stop());});
 // Force quit bypasses the action() gate on purpose: when a normal leave hangs,
 // actionPending/leaving would otherwise keep every button disabled forever.
 // With nothing local to detach it still tells the server to drop any room it holds.
 el.btnForceLeave.addEventListener('click',()=>{if(forcing)return;
  forcing=true;el.btnForceLeave.disabled=true;notice('強制退出中…');stopAuditionPolling();
  const s=controller.snapshot(),local=s.running||s.leaving||s.state==='stopping'||!!controller.session;
  const work=local?controller.forceLeave().then(()=>'いまのルームを強制退出しました。再入室できます。')
   :controller.forceRelease().then(data=>data?.forced?'サーバー上の残留入室を破棄しました。再入室できます。':data?'強制退出する接続はありません。そのまま入室できます。':'強制退出は確認できませんでした。このページにルーム接続はありません。そのまま入室できます。');
  void work.then(message=>{notice(message);}).catch(error=>{notice(GravityWeb.describe(error));}).finally(()=>{forcing=false;render(controller.snapshot());});
 });
 el.btnReplay.addEventListener('click',()=>{controller.replay();el.btnReplay.hidden=true;});
 el.btnPrevMembers.addEventListener('click',()=>{memberPageIndex--;renderMembers(controller.snapshot().isHost);});el.btnNextMembers.addEventListener('click',()=>{memberPageIndex++;renderMembers(controller.snapshot().isHost);});
 for(const [id,fn] of [['btnApplySeat',()=>controller.applySeat()],['btnLeaveSeat',()=>controller.leaveSeat()],['btnOpenMic',()=>controller.publishMic(true)],['btnCloseMic',()=>controller.closeMic()]])el[id].addEventListener('click',()=>{void action(fn);});
 el.btnTimeGreet.addEventListener('click',()=>{if(el.btnTimeGreet.disabled)return;const text=window.GravityMember.timeGreeting();el.chatStatus.textContent='送信中…';
  void controller.sendText(text).then(sent=>{el.chatStatus.textContent=sent?'送信しました':'接続が変わりました';}).catch(error=>{el.chatStatus.textContent=GravityWeb.describe(error);});});
 el.chatForm.addEventListener('submit',event=>{event.preventDefault();if(event.isComposing||el.btnChatSend.disabled)return;const text=el.chatInput.value;el.chatStatus.textContent='送信中…';
  void controller.sendText(text).then(sent=>{el.chatStatus.textContent=sent?'送信しました':'接続が変わりました';if(sent&&el.chatInput.value===text)el.chatInput.value='';}).catch(error=>{el.chatStatus.textContent=GravityWeb.describe(error);});});
 if(window.AgoraRTC)window.AgoraRTC.onAutoplayFailed=()=>{el.btnReplay.hidden=false;};
 // Safety net for the body scroll lock used by feed/profile/im dialogs: if no
 // modal dialog is open but the lock class leaked (e.g. double-close threw
 // before cleanup), drop it so the page can scroll again. Audio keeps going.
 setInterval(()=>{if(document.body.classList.contains('feed-detail-open')&&!document.querySelector('dialog[open]'))document.body.classList.remove('feed-detail-open');},2000);
 for(const dialog of [el.createRoomDialog])dialog?.addEventListener('close',()=>{if(!document.querySelector('dialog[open]'))document.body.classList.remove('feed-detail-open');});
 setInterval(()=>{if(!document.hidden&&controller.snapshot().running)controller.balanceVolumes();},2000);
 setInterval(()=>{if(document.hidden)return;const level=controller.micLevel();if(el.micLevel.value!==level)el.micLevel.value=level;},250);
 // Release first and synchronously: the page is gone before stop()'s own release.
 window.addEventListener('pagehide',()=>{controller.releaseOnUnload();void controller.stop();});
 document.getElementById('btnRoomView').addEventListener('click',()=>queueMicrotask(refreshDiscovery));
 setInterval(refreshDiscovery,15_000);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden){controller.pollNow();refreshDiscovery();}});
 render(controller.snapshot());void loadRooms().then(loadDiscovery);
 // Private-chat room cards and share-link buttons enter through here; the IM
 // view closes its own dialog first and resolves anchor_id before calling.
 window.GravityRoomUI={enterRoom};
})();

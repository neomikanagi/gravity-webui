/* Private chat is independent of room RTC/RTM. Opening a person connects; background GET polling never reclaims a session. */
(function(){
 'use strict';
 const ids=['btnRoomView','btnFeedView','btnFriendView','friendUnreadBadge','feedPanel','friendsPanel','imNotice','imNoticeList','btnDismissImNotice','btnUnreadIm','btnRefreshFriendsIm','btnConnectIm','imStatus','imFriends','btnMoreFriendsIm','imBlocked',
  'imChatDialog','imChatTitle','imChatAvatar','btnCloseImChat','btnReconnectImChat','imMessages','imChatStatus','imComposer','imInput','btnImSend','btnImImage','imImageInput'];
 const el=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)])),workspace=document.querySelector('.workspace'),diagnostics=document.querySelector('.diagnostics');
 if(!el.friendsPanel)return;
 let people=[],cursor='',loaded=false,busy=false,unreadOnly=false,listGeneration=0,imState='idle',unread={},notices=[],noticeSeen=0,blocked=0,accountGeneration=null;
 let chat=null,messages=[],permit='',chatGeneration=0,sending=false,connecting=false,statusTimer=0,chatTimer=0,sendNotice='',revision=0;
 const drafts=new Map(),attempts=new Map(),polls=new Set();
 async function api(url,body){
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),30000);
  try{
   const response=await fetch(url,{signal:abort.signal,cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json','X-Gravity-Action':'im-control'},body:JSON.stringify(body)}:{})});
   const result=await response.json();
   if(!response.ok||result.errno!==0){const error=new Error(result.errmsg||'リクエストに失敗しました。しばらくしてやり直してください。');error.status=response.status;throw error;}
   if(accountGeneration!==null&&result.data.generation!==undefined&&accountGeneration!==result.data.generation){
    closeChat();drafts.clear();attempts.clear();people=[];loaded=false;cursor='';listGeneration++;renderList();
    accountGeneration=result.data.generation;throw new Error('アカウントのセッションが変わりました。フレンド名簿を更新してください。');
   }
   if(result.data.generation!==undefined)accountGeneration=result.data.generation;
   return result.data;
  }catch(error){if(error.status===401){closeChat();drafts.clear();people=[];loaded=false;renderList();}
   if(error.name==='AbortError')throw new Error(body?'操作結果は未確認です。手動で更新してください。自動では再試行しません。':'読み込みがタイムアウトしました。やり直してください。');throw error;
  }finally{clearTimeout(timer);}
 }
 function showFriends(){
  el.feedPanel.hidden=true;workspace.hidden=true;diagnostics.hidden=true;el.friendsPanel.hidden=false;
  for(const [button,name] of [[el.btnRoomView,'rooms'],[el.btnFeedView,'posts'],[el.btnFriendView,'friends']])button.setAttribute('aria-pressed',String(name==='friends'));
  history.replaceState(null,'','#friends');if(!loaded)void loadList();startStatus();void autoConnect();
  void window.GravityFootprintsUI?.load();
 }
 // Connect once on entry so incoming messages actually arrive (idle only: never
 // steal the connection back when the App holds it). The page then keeps it warm.
 let autoTried=false;
 async function autoConnect(){
  if(autoTried||connecting||imState!=='idle')return;autoTried=true;
  try{await connect();}catch(error){el.imStatus.textContent=error.message;}
 }
 function leaveFriends(){el.friendsPanel.hidden=true;}
 function startStatus(){stopStatus();statusTimer=setInterval(()=>{if(!document.hidden)void refreshStatus();},10000);void refreshStatus();}
 // The visible page receives private messages: connect when the server holds no IM
 // connection (never after the App took it back: that needs the reconnect button).
 let lastAutoAt=0;
 function autoReceive(){if(imState!=='idle'||connecting||document.hidden||Date.now()-lastAutoAt<60000)return;lastAutoAt=Date.now();void connect().catch(()=>{});}
 function stopStatus(){clearInterval(statusTimer);statusTimer=0;}
 async function refreshStatus(){
  try{const data=await api('/api/im/status?keep=1');imState=data.state;unread=data.unread||{};notices=Array.isArray(data.notices)?data.notices:[];blocked=data.blocked_official||0;renderStatus();renderList();renderChat();autoReceive();}
  catch(error){el.imStatus.textContent=error.message;}
 }
 function unreadTotal(){return Object.values(unread).reduce((n,v)=>n+(Number(v)>0?Number(v):0),0);}
 function unreadPeers(){return Object.keys(unread).filter(id=>Number(unread[id])>0);}
 function renderStatus(){
  el.imStatus.textContent={idle:'メッセージ未接続（人を押すとチャット開始）',connecting:'メッセージ接続中…',ready:'メッセージ接続済み',kicked:'メッセージ接続は他の端末に渡しました'}[imState]||'メッセージを使えません';
  el.btnConnectIm.hidden=!['idle','kicked'].includes(imState);el.btnConnectIm.disabled=connecting;
  el.btnReconnectImChat.hidden=!chat||!['idle','kicked'].includes(imState);el.btnReconnectImChat.disabled=connecting;
  el.imBlocked.textContent=blocked>0?`公式・システムメッセージを ${blocked} 件ブロックしました`:'';
  const total=unreadTotal(),peers=unreadPeers();
  if(el.friendUnreadBadge){el.friendUnreadBadge.hidden=!total;el.friendUnreadBadge.textContent=total>99?'99+':String(total);}
  if(el.btnUnreadIm){
   el.btnUnreadIm.hidden=!total&&!unreadOnly;el.btnUnreadIm.textContent=unreadOnly?`未読 · ${peers.length}`:(total?`未読 · ${peers.length}`:'未読');
   el.btnUnreadIm.classList.toggle('pressed',unreadOnly);
   el.btnUnreadIm.setAttribute('aria-pressed',String(unreadOnly));
  }
  el.btnFriendView?.classList.toggle('has-unread',total>0);
  document.title=total?`(${total>99?'99+':total}) GRAVITY`:'GRAVITY';
  renderNotice();
 }
 // Page-wide "who wrote to you": one tap opens that chat. Nothing is marked read
 // until a chat is actually opened (the page never sends official read receipts).
 function renderNotice(){
  if(!el.imNotice)return;
  const rows=notices.filter(n=>n.count>0&&n.user_id!==chat?.user_id),newest=rows.reduce((t,n)=>Math.max(t,n.time||0),0);
  el.imNotice.hidden=!rows.length||newest<=noticeSeen;if(el.imNotice.hidden)return;
  el.imNoticeList.replaceChildren(...rows.slice(0,5).map(n=>{const li=document.createElement('li'),person={user_id:n.user_id,name:n.name,portrait:n.portrait};
   const open=document.createElement('button');open.type='button';open.className='im-notice-open';open.setAttribute('aria-label',`${n.name||n.user_id} のメッセージを開く`);
   const who=document.createElement('strong');who.textContent=(n.name||n.user_id)+(n.count>1?` · ${n.count}件`:'');
   const line=document.createElement('span');line.className='muted small';line.textContent=n.text||'新しいメッセージ';
   const text=document.createElement('span');text.className='im-notice-text';text.append(who,line);
   open.append(avatar(person),text);open.addEventListener('click',()=>{void openChat(person);});li.append(open);return li;}));
  if(rows.length>5){const li=document.createElement('li'),more=document.createElement('button');more.type='button';more.className='secondary compact';more.textContent=`ほか ${rows.length-5}人 · フレンドへ`;more.addEventListener('click',()=>{showFriends();showUnread();});li.append(more);el.imNoticeList.append(li);}
 }
 function avatar(person){const img=document.createElement('img');img.className='portrait';img.alt='';img.width=img.height=40;img.loading='lazy';img.referrerPolicy='no-referrer';if(person.portrait)img.src=person.portrait;return img;}
 function renderList(){
  el.imFriends.replaceChildren();
  const byId=new Map(people.map(p=>[p.user_id,p]));
  const rows=unreadOnly?unreadPeers().map(id=>byId.get(id)||{user_id:id,name:id,portrait:'',online:false}):people;
  for(const person of rows){
   const count=Number(unread[person.user_id])||0;
   const li=document.createElement('li');li.className='im-friend'+(count?' has-unread':'');
   const meta=document.createElement('div');meta.className='meta';
   const title=document.createElement('button');title.type='button';title.className='person-link title';title.textContent=person.name||person.user_id;title.addEventListener('click',()=>void window.GravityProfileUI?.open(person));
   const sub=document.createElement('div');sub.className='sub';sub.textContent=[person.online?'オンライン':'',person.country||'',count?`未読 ${count}`:''].filter(Boolean).join(' · ');meta.append(title,sub);
   const open=document.createElement('button');open.type='button';open.className='secondary compact';open.textContent=count?`メッセージ · ${count}`:'メッセージ';
   open.setAttribute('aria-label',`${person.name||person.user_id} にメッセージ`);open.addEventListener('click',()=>void openChat(person));
   const photo=document.createElement('button');photo.type='button';photo.className='person-avatar';photo.setAttribute('aria-label',`プロフィールを見る：${person.name||person.user_id}`);photo.append(avatar(person));photo.addEventListener('click',()=>void window.GravityProfileUI?.open(person));
   if(count){const dot=document.createElement('span');dot.className='unread-dot';dot.setAttribute('aria-hidden','true');photo.append(dot);}
   li.append(photo,meta,open);el.imFriends.append(li);
  }
  el.btnMoreFriendsIm.hidden=unreadOnly||!cursor;el.btnMoreFriendsIm.disabled=busy;el.btnRefreshFriendsIm.disabled=busy;
 }
 async function loadList(append=false){
  if(append&&!cursor)return;const generation=++listGeneration;busy=true;renderList();el.imFriends.setAttribute('aria-busy','true');
  try{
   const data=await api('/api/im/friends?'+new URLSearchParams({kind:'friends',...(append?{cursor}:{})}));if(generation!==listGeneration)return;
   people=[...new Map([...(append?people:[]),...data.people].map(p=>[p.user_id,p])).values()];cursor=data.next_cursor||'';unread=data.unread||unread;imState=data.state;loaded=true;renderStatus();
   if(!people.length)el.imStatus.textContent='まだフレンドがいません（相互フォローがフレンド。フォロー／フォローバックは自動同期します）';
  }catch(error){el.imStatus.textContent=error.message;}
  finally{busy=false;el.imFriends.removeAttribute('aria-busy');renderList();}
 }
 function stamp(ms){const date=new Date(ms);return Number.isFinite(date.getTime())?date.toLocaleString([],{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';}
 // Friend-shared rooms: type-44 cards carry only channel_id, so resolve the
 // anchor over preview first, then hand the room to the room view to enter.
 async function enterSharedRoom(channelId,mode){
  if(!window.GravityRoomUI?.enterRoom){el.imChatStatus.textContent='ルーム画面を使えません。先にルームタブを開いてください。';return;}
  el.imChatStatus.textContent='ルームを確認中…';
  try{
   const response=await fetch('/api/member/preview?channel_id='+encodeURIComponent(channelId),{cache:'no-store'});
   const result=await response.json().catch(()=>({}));
   if(!response.ok||result.errno!==0)throw new Error(result.errmsg||'ルームを使えません。');
   const data=result.data||{};
   if(!/^[1-9][0-9]{0,19}$/.test(data.anchor_id||''))throw new Error('ルーム情報が不完全です。');
   closeChat();
   await window.GravityRoomUI.enterRoom({channel_id:channelId,anchor_id:data.anchor_id,title:data.title||'',anchor_name:''},mode);
  }catch(error){el.imChatStatus.textContent=error.message;}
 }
 // Official room share links sometimes arrive as plain text; offer one-tap entry for the first one.
 const ROOM_URL_RE=/https:\/\/(?:www\.gravity\.place\/share\/shareVoiceRoomOnline|h5\.gravity\.place\/shareVoiceRoomOnline|api\.gravity\.place\/gravity\/url\/[A-Za-z0-9]{4,12})[^\s]*/;
 function roomUrlIn(text){if(typeof text!=='string')return '';const m=text.match(ROOM_URL_RE);return m?m[0]:'';}
 async function enterSharedUrl(url,mode){
  if(!window.GravityRoomUI?.enterRoom){el.imChatStatus.textContent='ルーム画面を使えません。先にルームタブを開いてください。';return;}
  el.imChatStatus.textContent='共有リンクを解析中…';
  try{
   const response=await fetch('/api/resolve?url='+encodeURIComponent(url),{cache:'no-store'});
   const result=await response.json().catch(()=>({}));
   if(!response.ok||result.errno!==0)throw new Error(result.errmsg||'リンクが無効か、ルームは終了しています。');
   const data=result.data||{};
   if(!/^[1-9][0-9]{0,19}$/.test(data.channel_id||'')||!/^[1-9][0-9]{0,19}$/.test(data.anchor_id||''))throw new Error('リンクに有効なルーム情報がありません。');
   closeChat();
   await window.GravityRoomUI.enterRoom({channel_id:String(data.channel_id),anchor_id:String(data.anchor_id),title:data.title||'',anchor_name:data.anchor_name||''},mode);
  }catch(error){el.imChatStatus.textContent=error.message;}
 }
 function renderMessages(stick=false){
  const box=el.imMessages,near=box.scrollHeight-box.scrollTop-box.clientHeight<60;box.replaceChildren();
  for(const message of messages){const li=document.createElement('li');li.className='im-msg '+(message.mine?'mine':'theirs')+(message.kind==='other'?' other':'')+(message.kind==='room'?' room':'');const bubble=document.createElement('span');bubble.className='im-bubble';
   if(message.kind==='image'&&message.image){bubble.classList.add('im-image');const img=document.createElement('img');img.src=message.image;img.alt=message.text||'画像';img.referrerPolicy='no-referrer';img.loading='lazy';bubble.append(img);}
   else if(message.kind==='room'&&message.room){bubble.classList.add('im-room');const name=document.createElement('span');name.className='im-room-name';name.textContent='🎙️ '+(message.room.name||message.text||'ボイスルーム');bubble.append(name);
    const sub=document.createElement('span');sub.className='muted small';sub.textContent=[message.room.label_info,message.room.room_type===2?'グループ通話':''].filter(Boolean).join(' · ');if(sub.textContent)bubble.append(sub);
    const actions=document.createElement('span');actions.className='im-room-actions';
    for(const [mode,label] of [['member','入室'],['anonymous','試聴']]){const btn=document.createElement('button');btn.type='button';btn.className='secondary compact';btn.textContent=label;
     btn.addEventListener('click',()=>{void enterSharedRoom(message.room.channel_id,mode);});actions.append(btn);}
    bubble.append(actions);}
   else bubble.textContent=message.text;
   const time=document.createElement('time');time.className='muted small';time.textContent=stamp(message.time);li.append(bubble,time);
   if(message.kind==='text'&&typeof message.text==='string'){const url=roomUrlIn(message.text);
    if(url){const join=document.createElement('span');join.className='im-room-actions';
     for(const [mode,label] of [['member','入室'],['anonymous','試聴']]){const btn=document.createElement('button');btn.type='button';btn.className='secondary compact';btn.textContent=(label==='入室'?'🔗 ':'')+label+'このルーム';btn.title=url;
      btn.addEventListener('click',()=>{void enterSharedUrl(url,mode);});join.append(btn);}
     li.append(join);}}
   if(!message.mine&&message.kind==='text'&&window.GravityTranslate?.enabled()&&typeof message.text==='string'&&!(window.GravityTranslate.skipTranslate||window.GravityTranslate.looksChinese)(message.text)){
    const trans=document.createElement('span');trans.className='im-trans';trans.hidden=true;li.append(trans);
    const fill=t=>{if(t&&trans.isConnected){trans.textContent='訳 '+t;trans.hidden=false;}};
    const cached=window.GravityTranslate.peek(message.text.trim());
    if(cached)fill(cached);else void window.GravityTranslate.translateText(message.text).then(fill);
   }
   box.append(li);}
  if(stick||near)box.scrollTop=box.scrollHeight;
 }
 function renderChat(){const disabled=sending||connecting||!chat||!permit||imState!=='ready';el.imInput.disabled=disabled;el.btnImSend.disabled=disabled;if(el.btnImImage)el.btnImImage.disabled=disabled;renderStatus();}
 function stashDraft(){if(chat){drafts.set(chat.user_id,el.imInput.value);while(drafts.size>50)drafts.delete(drafts.keys().next().value);}}
 async function connect(){connecting=true;renderChat();try{const data=await api('/api/im/connect',{confirmed:true});imState=data.state;unread=data.unread||{};if(Array.isArray(data.notices))notices=data.notices;}finally{connecting=false;renderChat();}}
 async function openChat(person){
  const peer=String(person?.user_id||'');
  if(!/^\d{1,20}$/.test(peer)||window.GravityView?.officialUser(peer)||person.is_self)return;
  stashDraft();chat={...person,user_id:peer};messages=[];permit='';sendNotice='';revision++;const generation=++chatGeneration;stopChatTimer();renderNotice();
  el.imChatTitle.textContent=person.name||peer;el.imChatAvatar.replaceChildren(avatar(person));el.imInput.value=drafts.get(peer)||'';
  el.imChatStatus.textContent='メッセージ接続と履歴読み込み中…';renderMessages(true);renderChat();
  if(!el.imChatDialog.open)el.imChatDialog.showModal();document.body.classList.add('feed-detail-open');
  try{if(imState!=='ready'){if(imState==='kicked')throw new Error('メッセージ接続は他の端末に渡しました。「再接続」で続けます。');await connect();}
   if(generation===chatGeneration){await pollChat(generation,true);startChatTimer();}
  }catch(error){if(generation===chatGeneration)el.imChatStatus.textContent=error.message;}
 }
 async function pollChat(generation,first=false){
  if(!chat||generation!==chatGeneration||polls.has(generation)||sending)return;polls.add(generation);const version=revision;
  try{
   const data=await api('/api/im/chat?'+new URLSearchParams({peer:chat.user_id}));if(generation!==chatGeneration||version!==revision)return;
   imState=data.state;unread=data.unread||{};permit=data.chat_permit;notices=notices.filter(n=>n.user_id!==chat?.user_id);
   const changed=JSON.stringify(data.messages)!==JSON.stringify(messages);messages=data.messages;if(changed||first)renderMessages(first);
   if(!sending&&!sendNotice)el.imChatStatus.textContent=data.history_loaded?(messages.length?'':'まだ履歴がありません。書いてみてください'):'履歴の読み込みに失敗しました。新規送信はできます。手動で更新してください。';
  }catch(error){if(generation===chatGeneration){el.imChatStatus.textContent=error.message;if(error.status===409){imState=/其他设备/.test(error.message)?'kicked':'idle';stopChatTimer();}}}
  finally{polls.delete(generation);if(generation===chatGeneration)renderChat();}
 }
 function startChatTimer(){stopChatTimer();const generation=chatGeneration;chatTimer=setInterval(()=>{if(!document.hidden&&el.imChatDialog.open)void pollChat(generation);},3000);}
 function stopChatTimer(){clearInterval(chatTimer);chatTimer=0;}
 function syncBodyLock(){if(!document.querySelector('dialog[open]'))document.body.classList.remove('feed-detail-open');}
 function closeChat(){stashDraft();stopChatTimer();chatGeneration++;chat=null;permit='';messages=[];renderMessages();if(el.imChatDialog.open)el.imChatDialog.close();syncBodyLock();void refreshStatus();}
 el.btnCloseImChat.addEventListener('click',closeChat);el.imChatDialog.addEventListener('cancel',closeChat);el.imChatDialog.addEventListener('close',syncBodyLock);
 el.imInput.addEventListener('input',()=>{stashDraft();sendNotice='';});
 el.imInput.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!event.isComposing){event.preventDefault();el.imComposer.requestSubmit();}});
 el.imComposer.addEventListener('submit',event=>{
  event.preventDefault();if(sending||!chat||!permit||imState!=='ready')return;
  const text=el.imInput.value.trim();if(!text||[...text].length>500){el.imChatStatus.textContent='1〜500字で入力してください。';return;}
  const peer=chat.user_id,key=JSON.stringify([peer,text]),generation=chatGeneration;
  if(!attempts.has(key))attempts.set(key,crypto.randomUUID());while(attempts.size>50)attempts.delete(attempts.keys().next().value);
  sending=true;sendNotice='';renderChat();el.imChatStatus.textContent='送信中…';
  void api('/api/im/send',{peer,text,chat_permit:permit,request_id:attempts.get(key),confirmed:true}).then(data=>{
   if(!data.sent)throw new Error('送信結果は未確認です。');attempts.delete(key);drafts.delete(peer);
   if(generation!==chatGeneration)return;
   if(!messages.some(m=>m.id===data.message.id))messages=[...messages,data.message];revision++;el.imInput.value='';el.imChatStatus.textContent=sendNotice='送信しました';renderMessages(true);
  }).catch(error=>{if(generation===chatGeneration)el.imChatStatus.textContent=sendNotice=error.message;})
   .finally(()=>{sending=false;renderChat();});
 });
 async function reconnect(){try{await connect();sendNotice='';if(chat){await pollChat(chatGeneration,true);startChatTimer();}renderList();}catch(error){el.imStatus.textContent=error.message;if(chat)el.imChatStatus.textContent=error.message;}}
 // 1:1 private images: picked file uploads over multipart, then the type-25 message sends over IM.
 function sendImageFile(file){
  if(sending||!chat||!permit||imState!=='ready')return;
  if(!file||!/^image\/(jpeg|png|gif)$/.test(file.type)||file.size>1_048_576){el.imChatStatus.textContent='1MB以下の jpg/png/gif を選んでください。';return;}
  const peer=chat.user_id,generation=chatGeneration;
  const form=new FormData();
  form.append('peer',peer);form.append('chat_permit',permit);form.append('confirmed','true');
  form.append('request_id',crypto.randomUUID());form.append('file',file,file.name||'image.png');
  sending=true;sendNotice='';renderChat();el.imChatStatus.textContent='画像送信中…';
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),60000);
  void fetch('/api/im/send-image',{signal:abort.signal,method:'POST',headers:{'X-Gravity-Action':'im-control'},body:form}).then(async response=>{
   const result=await response.json().catch(()=>({}));
   if(!response.ok||result.errno!==0)throw Object.assign(new Error(result.errmsg||'送信に失敗しました。'),{status:response.status});
   return result.data;
  }).then(data=>{
   if(!data.sent)throw new Error('送信結果は未確認です。');
   if(generation!==chatGeneration)return;
   if(!messages.some(m=>m.id===data.message.id))messages=[...messages,data.message];revision++;el.imChatStatus.textContent=sendNotice='送信しました';renderMessages(true);
  }).catch(error=>{
   if(generation===chatGeneration)el.imChatStatus.textContent=sendNotice=(error.name==='AbortError'?'送信がタイムアウトし、結果は未確認です。自動では再送しません。':error.message);
  }).finally(()=>{clearTimeout(timer);sending=false;if(el.imImageInput)el.imImageInput.value='';renderChat();});
 }
 if(el.btnImImage&&el.imImageInput){
  el.btnImImage.addEventListener('click',()=>el.imImageInput.click());
  el.imImageInput.addEventListener('change',()=>{const file=el.imImageInput.files?.[0];if(file)sendImageFile(file);});
 }
 function showUnread(){
  const peers=unreadPeers();
  if(!peers.length){unreadOnly=false;renderStatus();renderList();return;}
  unreadOnly=true;renderStatus();renderList();
 }
 el.btnUnreadIm?.addEventListener('click',()=>{if(unreadOnly){unreadOnly=false;renderStatus();renderList();}else showUnread();});
 el.btnRefreshFriendsIm.addEventListener('click',()=>void loadList());
 el.btnDismissImNotice?.addEventListener('click',()=>{noticeSeen=notices.reduce((t,n)=>Math.max(t,n.time||0),0);renderNotice();});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshStatus();});
 el.btnMoreFriendsIm.addEventListener('click',()=>void loadList(true));el.btnConnectIm.addEventListener('click',()=>void reconnect());el.btnReconnectImChat.addEventListener('click',()=>void reconnect());
 el.btnFriendView.addEventListener('click',showFriends);for(const button of [el.btnRoomView,el.btnFeedView])button.addEventListener('click',leaveFriends);
 // The unread badge on the フレンド tab polls from page load (a local read; it never connects IM).
 window.GravityImUI={showFriends,leaveFriends,openChat};if(location.hash==='#friends')showFriends();else startStatus();
})();

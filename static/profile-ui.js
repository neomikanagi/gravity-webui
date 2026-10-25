/* One public-person popup for friend and room people. Viewing a profile never starts IM or changes rooms. */
(function(){
 'use strict';
 const ids=['profileDialog','profileTitle','profileCard','profileStatus','profilePosts','profilePostsStatus','btnProfileChat','btnProfileBlock','btnCloseProfile','btnPrevProfilePosts','btnNextProfilePosts','profilePostPage','btnRefreshProfile','profileRelations','btnProfileFollowing','btnProfileFans','btnProfileGiftsRecv','btnProfileGiftsSent','profileRelation','profileRelationStatus','btnMoreRelation'];
 const el=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
 let person=null,selected=null,posts=[],cursor='',loadedCount=0,index=0,generation=0,abort=null,busy=false;
 let relMode=null,relCursor='',relBusy=false;
 async function request(url,signal,options={}){const controller=new AbortController(),forward=()=>controller.abort();signal.addEventListener('abort',forward,{once:true});if(signal.aborted)forward();
  const timer=setTimeout(()=>controller.abort(),30000);
  try{const response=await fetch(url,{signal:controller.signal,cache:'no-store',...options}),result=await response.json();
   if(!response.ok||result.errno!==0)throw new Error(result.errmsg||'プロフィールを取得できません。');return result.data;
  }catch(error){if(error.name==='AbortError')throw new Error('読み込みがタイムアウトしました。やり直してください。');throw error;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',forward);}}
 function renderPerson(p){el.profileCard.replaceChildren();
  const head=document.createElement('div');head.className='profile-head';
  if(p.portrait){const img=document.createElement('img');img.className='portrait';img.src=p.portrait;img.alt='';img.referrerPolicy='no-referrer';head.append(img);}
  const meta=document.createElement('div'),name=document.createElement('h3');name.textContent=p.name||p.user_id;
  const id=document.createElement('p');id.className='muted small';id.textContent=`ID · ${p.custom_id||p.user_id}`;meta.append(name,id);head.append(meta);el.profileCard.append(head);
  const facts=[p.country,p.character,p.online?'オンライン':''].filter(Boolean);if(facts.length){const line=document.createElement('p');line.className='muted small';line.textContent=facts.join(' · ');el.profileCard.append(line);}
  const counts=[];for(const [key,label]of [['fans','フォロワー'],['following','フォロー'],['friends','フレンド']])if(Number.isSafeInteger(p.counts?.[key]))counts.push(`${label} ${p.counts[key]}`);
  if(counts.length){const line=document.createElement('p');line.className='muted small';line.textContent=counts.join(' · ');el.profileCard.append(line);}
  const bio=document.createElement('p');bio.className='profile-bio';bio.textContent=p.bio||'自己紹介はありません';el.profileCard.append(bio);
 }
 function renderPosts(){const page=GravityView.page(posts,index);index=page.index;el.profilePosts.replaceChildren();
  for(const post of page.rows){const box=GravityFeedUI.postContent(post),button=document.createElement('button');button.type='button';button.className='secondary compact';button.textContent=`開く / コメント · ${post.comment_count}`;
   button.addEventListener('click',()=>void GravityFeedUI.openPost(post.id));box.append(button);el.profilePosts.append(box);}
  el.profilePostPage.textContent=`${index+1} / ${page.count}${cursor?' +':''}`;
  el.btnPrevProfilePosts.disabled=busy||index===0;el.btnNextProfilePosts.disabled=busy||(index===page.count-1&&!cursor);el.btnRefreshProfile.disabled=busy;
 }
 async function loadPosts(append=false){if(!person||busy||append&&!cursor)return;
  const current=generation,peer=person.user_id,previous=posts.length;busy=true;renderPosts();el.profilePostsStatus.textContent='投稿を読み込み中…';
  try{const data=await request('/api/profile/posts?'+new URLSearchParams({user_id:peer,cursor:append?cursor:'',loaded:append?String(loadedCount):'0'}),abort.signal);
   if(current!==generation)return;
   posts=[...new Map([...(append?posts:[]),...data.posts].map(p=>[p.id,p])).values()].slice(0,200);cursor=data.next_cursor||'';loadedCount=data.loaded_count||0;
   if(posts.length>=200)cursor='';if(append&&posts.length>previous)index=Math.floor(previous/GravityView.PAGE_SIZE);
   el.profilePostsStatus.textContent=posts.length?'':'見える投稿はありません';
  }catch(error){if(current===generation&&!abort.signal.aborted)el.profilePostsStatus.textContent=error.message;}
  finally{if(current===generation){busy=false;renderPosts();}}
 }
 async function open(card){const peer=String(card?.user_id||'');if(!/^[1-9][0-9]{0,19}$/.test(peer)||GravityView.officialUser(peer))return;
  abort?.abort();abort=new AbortController();const current=++generation;selected={...card,user_id:peer};person=null;posts=[];cursor='';loadedCount=0;index=0;busy=true;
  relMode=null;relCursor='';relBusy=false;el.profileRelations.hidden=true;el.profileRelation.replaceChildren();el.profileRelationStatus.textContent='';el.btnMoreRelation.hidden=true;
  el.profileTitle.textContent=card.name||'プロフィール';el.profileCard.replaceChildren();el.profilePostsStatus.textContent='';el.profileStatus.textContent='プロフィールを読み込み中…';el.btnProfileChat.disabled=true;el.btnProfileBlock.disabled=true;renderPosts();
  if(!el.profileDialog.open)el.profileDialog.showModal();document.body.classList.add('feed-detail-open');document.querySelector('.profile-body').scrollTop=0;
  try{const data=await request('/api/profile/person?'+new URLSearchParams({user_id:peer}),abort.signal);if(current!==generation)return;
   person=data.person;el.profileTitle.textContent=person.name||'プロフィール';renderPerson(person);el.profileStatus.textContent='';el.btnProfileChat.disabled=false;el.btnProfileBlock.disabled=!!person.is_self;
   renderRelationTabs();
   busy=false;await loadPosts();
  }catch(error){if(current===generation&&!abort.signal.aborted)el.profileStatus.textContent=error.message;}
  finally{if(current===generation){busy=false;renderPosts();}}
 }
 // Anyone's following/fans/gift wall, paged. Rows open nested profiles (generation-guarded).
 function cdnImage(url){try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='cdn.gravity.place'&&!u.username&&!u.password&&!u.port?u.origin+u.pathname:'';}catch{return '';}}
 function renderRelationTabs(){
  el.profileRelation.replaceChildren();el.profileRelationStatus.textContent='';el.btnMoreRelation.hidden=true;relMode=null;relCursor='';
  if(!person){el.profileRelations.hidden=true;return;}
  el.profileRelations.hidden=false;
  const counts=person.counts||{};
  el.btnProfileFollowing.textContent='フォロー'+(Number.isSafeInteger(counts.following)?' · '+counts.following:'');
  el.btnProfileFans.textContent='フォロワー'+(Number.isSafeInteger(counts.fans)?' · '+counts.fans:'');
 }
 function relationRow(p){
  const li=document.createElement('li');
  const portrait=cdnImage(p.portrait);
  if(portrait){const img=document.createElement('img');img.src=portrait;img.alt='';img.width=img.height=28;img.referrerPolicy='no-referrer';
   const photo=document.createElement('button');photo.type='button';photo.className='person-avatar';photo.setAttribute('aria-label',`プロフィールを見る：${p.name||p.user_id}`);photo.append(img);
   if(p.country){const badge=document.createElement('span');badge.className='country-badge';badge.textContent=p.country;photo.append(badge);}
   photo.addEventListener('click',()=>void open(p));li.append(photo);}
  const name=document.createElement('button');name.type='button';name.className='person-link';name.title='プロフィールと投稿を見る';
  name.textContent=(p.name||p.user_id)+(p.online?' · オンライン':'')+(!portrait&&p.country?' · '+p.country:'');name.addEventListener('click',()=>void open(p));li.append(name);
  return li;
 }
 function giftRow(g){
  const li=document.createElement('li');
  if(g.image){const img=document.createElement('img');img.src=g.image;img.alt='';img.width=img.height=28;img.referrerPolicy='no-referrer';li.append(img);}
  const label=document.createElement('span');label.textContent=g.name+(g.price!=null?' · '+g.price:'');li.append(label);
  return li;
 }
 async function loadRelation(mode,append=false){
  if(!person||relBusy||(append&&!relCursor))return;
  const current=generation,peer=person.user_id;relBusy=true;el.btnMoreRelation.disabled=true;el.profileRelationStatus.textContent='読み込み中…';
  try{
   let data;
   if(mode==='following'||mode==='fans')data=await request('/api/profile/'+mode+'?'+new URLSearchParams({user_id:peer,...(append?{cursor:relCursor}:{})}),abort.signal);
   else data=await request('/api/profile/gifts?'+new URLSearchParams({user_id:peer,list_type:mode==='gifts-recv'?'receive':'send'}),abort.signal);
   if(current!==generation||!person||person.user_id!==peer||relMode!==mode)return;
   if(!append)el.profileRelation.replaceChildren();
   if(mode==='following'||mode==='fans'){
    for(const p of data.people||[])el.profileRelation.append(relationRow(p));
    relCursor=data.next_cursor||'';
    el.profileRelationStatus.textContent=el.profileRelation.children.length?'':'この人たちは公開されていません';
   }else{
    const stat=data.statistic;
    if(stat&&(stat.coins!=null||stat.points!=null||stat.total_gift_kind!=null))
     el.profileRelationStatus.textContent='累計：'+[stat.coins!=null?'ゴールド'+stat.coins:'',stat.points!=null?'シルバー'+stat.points:'',stat.total_gift_kind!=null?stat.total_gift_kind+'種':''].filter(Boolean).join(' · ');
    else el.profileRelationStatus.textContent='';
    for(const g of data.items||[])el.profileRelation.append(giftRow(g));
    if(!el.profileRelation.children.length&&!el.profileRelationStatus.textContent)el.profileRelationStatus.textContent='記録はありません';
    relCursor='';
   }
   el.btnMoreRelation.hidden=!relCursor;
  }catch(error){if(current===generation&&!abort.signal.aborted)el.profileRelationStatus.textContent=error.message;}
  finally{if(current===generation){relBusy=false;el.btnMoreRelation.disabled=false;}}
 }
 function chooseRelation(mode){if(!person||relBusy)return;relMode=mode;relCursor='';el.profileRelation.replaceChildren();void loadRelation(mode);}
 el.btnProfileFollowing.addEventListener('click',()=>chooseRelation('following'));
 el.btnProfileFans.addEventListener('click',()=>chooseRelation('fans'));
 el.btnProfileGiftsRecv.addEventListener('click',()=>chooseRelation('gifts-recv'));
 el.btnProfileGiftsSent.addEventListener('click',()=>chooseRelation('gifts-send'));
 el.btnMoreRelation.addEventListener('click',()=>{if(relMode&&(relMode==='following'||relMode==='fans'))void loadRelation(relMode,true);});
 function syncBodyLock(){if(!document.querySelector('dialog[open]'))document.body.classList.remove('feed-detail-open');}
 function close(){abort?.abort();generation++;person=null;selected=null;busy=false;relMode=null;relCursor='';relBusy=false;el.btnProfileChat.disabled=true;el.btnProfileBlock.disabled=true;if(el.profileDialog.open)el.profileDialog.close();el.profileCard.replaceChildren();el.profilePosts.replaceChildren();el.profileRelation.replaceChildren();el.profileRelationStatus.textContent='';el.btnMoreRelation.hidden=true;el.profileRelations.hidden=true;
  syncBodyLock();}
 el.btnCloseProfile.addEventListener('click',close);el.profileDialog.addEventListener('cancel',close);el.profileDialog.addEventListener('close',syncBodyLock);
 el.btnProfileChat.addEventListener('click',()=>{if(person)void GravityImUI.openChat(person);});
 el.btnProfileBlock.addEventListener('click',()=>{if(!person||person.is_self||el.btnProfileBlock.disabled)return;
  if(!window.confirm(`${person.name||person.user_id} をブロックしますか？相手はメッセージもあなたのルームにも入れなくなります。`))return;
  const peer=person.user_id;el.btnProfileBlock.disabled=true;el.profileStatus.textContent='ブロック中…';
  void request('/api/profile/block',abort?.signal||new AbortController().signal, {method:'POST',headers:{'Content-Type':'application/json','X-Gravity-Action':'profile-control'},body:JSON.stringify({target_user_id:peer,confirmed:true,request_id:crypto.randomUUID()})})
   .then(()=>{if(selected&&String(selected.user_id)===String(peer))el.profileStatus.textContent='このユーザーをブロックしました。';})
   .catch(error=>{if(selected&&String(selected.user_id)===String(peer)){el.profileStatus.textContent=error.message;el.btnProfileBlock.disabled=false;}});});
 el.btnPrevProfilePosts.addEventListener('click',()=>{if(!busy){index--;renderPosts();}});
 el.btnNextProfilePosts.addEventListener('click',()=>{if(busy)return;if((index+1)*GravityView.PAGE_SIZE<posts.length){index++;renderPosts();}else void loadPosts(true);});
 el.btnRefreshProfile.addEventListener('click',()=>{if(selected&&!busy)void open(selected);});
 window.GravityProfileUI={open,close};
})();

/* Independent feed view; switching tabs never stops the room's audio connection. */
(function(){
 'use strict';
 const ids=['btnRoomView','btnFeedView','feedPanel','feedMode','btnRefreshFeed','autoLike','feedStatus','feedList','btnPrevFeed','btnNextFeed','feedPage','feedDetailDialog','feedDetailTitle','btnRefreshFeedDetail','btnCloseFeedDetail','feedDetailContent','feedDetailStatus','feedComments','btnMoreFeedComments','feedReplyForm','feedReplyTarget','btnReplyPost','feedReplyInput','btnFeedReplySend','feedReplyStatus'];
 const el=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)])),workspace=document.querySelector('.workspace'),diagnostics=document.querySelector('.diagnostics');
 let loaded=false,listBusy=false,posts=[],cursor='',index=0,listGeneration=0,listAbort=null;
 let detail=null,comments=[],commentCursor='',target=null,detailGeneration=0,detailAbort=null,detailBusy=false,replyBusy=false,collectBusy=false;
 const drafts=new Map(),attempts=new Map(),collectIds=new Map();
 // Auto-like (auto-like.js): every post pulled into the public feeds gets one like, slowly. Profile posts are never touched.
 const store={get(key){try{return localStorage.getItem(key);}catch{return null;}},set(key,value){try{localStorage.setItem(key,value);}catch{}}};
 const today=()=>new Date().toISOString().slice(0,10);
 function dayCount(){try{const saved=JSON.parse(store.get('gravity.autoLike.count')||'null');return saved&&saved.day===today()?saved.n:0;}catch{return 0;}}
 const liker=GravityAutoLike.create({posts:()=>posts,enabled:()=>el.autoLike.checked,wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  isBusy:()=>collectBusy||replyBusy||detailBusy||listBusy,dayCount,bumpDay:()=>store.set('gravity.autoLike.count',JSON.stringify({day:today(),n:dayCount()+1})),
  onStatus:text=>{el.feedStatus.textContent=text;},
  like:async post=>{collectBusy=true;try{return await request('/api/feed/collect',{body:{sid:post.id,collected:true,confirmed:true,request_id:crypto.randomUUID(),auto:true}});}finally{collectBusy=false;if(detail)renderReply();}},
  onLiked:(post,data)=>{applyCollect(post.id,data);paintLike(post);}});
 function showRooms(){document.getElementById('friendsPanel').hidden=true;document.getElementById('btnFriendView').setAttribute('aria-pressed','false');el.feedPanel.hidden=true;workspace.hidden=false;diagnostics.hidden=false;el.btnRoomView.setAttribute('aria-pressed','true');el.btnFeedView.setAttribute('aria-pressed','false');history.replaceState(null,'',location.pathname+location.search);}
 function showPosts(){document.getElementById('friendsPanel').hidden=true;document.getElementById('btnFriendView').setAttribute('aria-pressed','false');el.feedPanel.hidden=false;workspace.hidden=true;diagnostics.hidden=true;el.btnRoomView.setAttribute('aria-pressed','false');el.btnFeedView.setAttribute('aria-pressed','true');history.replaceState(null,'','#posts');if(!loaded)void loadList();}
 window.GravityFeedUI={showRooms,showPosts,openPost,postContent};
 async function request(url,{signal,body}={}){const abort=new AbortController(),forward=()=>abort.abort();signal?.addEventListener('abort',forward,{once:true});if(signal?.aborted)abort.abort();
  const timer=setTimeout(()=>abort.abort(),30000);
  try{const response=await fetch(url,{signal:abort.signal,cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json','X-Gravity-Action':'feed-control'},body:JSON.stringify(body)}:{})});
   const result=await response.json();if(!response.ok||result.errno!==0)throw new Error(result.errmsg||'リクエストに失敗しました。しばらくしてやり直してください。');return result.data;
  }catch(error){if(error.name==='AbortError')throw new Error(body?'送信結果は未確認です。先に更新して確認してください。自動では再送しません。':'読み込みがタイムアウトしました。やり直してください。');throw error;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',forward);}}
 function authorLine(author,time){const row=document.createElement('div');row.className='feed-author';
  const open=()=>{void window.GravityProfileUI?.open(author);};
  const personal=!window.GravityView?.officialUser(author.user_id);
  if(author.portrait){const img=document.createElement('img');img.src=author.portrait;img.alt='';img.width=img.height=32;img.referrerPolicy='no-referrer';
   if(personal){const photo=document.createElement('button');photo.type='button';photo.className='person-avatar';photo.setAttribute('aria-label',`プロフィールを見る：${author.name||author.user_id}`);photo.append(img);photo.addEventListener('click',open);row.append(photo);}else row.append(img);}
  const name=document.createElement(personal?'button':'span');
  if(personal){name.type='button';name.className='person-link';name.title='プロフィールと投稿を見る';name.addEventListener('click',open);}
  name.textContent=author.name||author.user_id;row.append(name);
  if(author.country){const badge=document.createElement('span');badge.className='country-badge feed-country';badge.textContent=author.country;badge.title='地域';row.append(badge);}
  if(time){const date=document.createElement('span');date.className='muted small';const value=new Date(time>1e12?time:time*1000);date.textContent=Number.isFinite(value.getTime())?value.toLocaleDateString():'';row.append(date);}return row;}
 function postContent(post,full=false){const box=document.createElement('article');box.className='feed-post';box.append(authorLine(post.author,post.time));
  if(post.title){const h=document.createElement('h3');h.textContent=post.title;box.append(h);}
  const text=document.createElement('p');text.className='feed-text';text.textContent=!full&&post.text.length>140?post.text.slice(0,140)+'…':post.text;box.append(text);
  if(!full&&post.text.length>140){const more=document.createElement('button');more.type='button';more.className='secondary compact';more.textContent='全文を表示';more.addEventListener('click',()=>{void openPost(post.id);});box.append(more);}
  if(post.images?.length){const images=document.createElement('div');images.className='feed-images';for(const url of post.images){const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener noreferrer';const img=document.createElement('img');img.src=url;img.alt='投稿画像';img.loading='lazy';img.referrerPolicy='no-referrer';a.append(img);images.append(a);}box.append(images);}
  const like=document.createElement('button');like.type='button';like.className='secondary compact feed-collect';
  like.textContent=(post.collected?'いいね済':'いいね')+' · '+(post.collect_count||0);
  like.disabled=collectBusy||replyBusy||detailBusy||!(post.can_collect||post.collected);
  like.dataset.sid=post.id;like.addEventListener('click',event=>{event.preventDefault();void submitCollect(post);});box.append(like);
  return box;}
 function applyCollect(sid,data){const row=posts.find(p=>p.id===sid);if(row){row.collected=data.collected;row.collect_count=data.collect_count;}
  if(detail?.post.id===sid){detail.post.collected=data.collected;detail.post.collect_count=data.collect_count;}}
 function submitCollect(post){if(collectBusy||replyBusy||detailBusy||!(post.can_collect||post.collected))return;
  const collected=!post.collected;if(collected&&!post.can_collect)return;const key=JSON.stringify([post.id,collected]);
  if(!collectIds.has(key))collectIds.set(key,crypto.randomUUID());while(collectIds.size>100)collectIds.delete(collectIds.keys().next().value);
  collectBusy=true;renderList();if(detail){renderReply();el.feedDetailContent.replaceChildren(postContent(detail.post,true));}
  const status=detail?.post.id===post.id?el.feedDetailStatus:el.feedStatus;status.textContent='いいね中…';
  void request('/api/feed/collect',{body:{sid:post.id,collected,confirmed:true,request_id:collectIds.get(key)}}).then(data=>{
   applyCollect(post.id,data);collectIds.delete(key);status.textContent='';
  }).catch(error=>{status.textContent=error.message;}).finally(()=>{collectBusy=false;renderList();if(detail){renderReply();el.feedDetailContent.replaceChildren(postContent(detail.post,true));}});}
 function paintLike(post){for(const button of document.querySelectorAll('.feed-collect'))if(button.dataset.sid===post.id){button.textContent=(post.collected?'いいね済':'いいね')+' · '+(post.collect_count||0);button.disabled=collectBusy||replyBusy||detailBusy||!(post.can_collect||post.collected);}}
 function renderList(){const p=GravityView.page(posts,index);index=p.index;el.feedList.replaceChildren();for(const post of p.rows){const box=postContent(post),button=document.createElement('button');button.type='button';button.className='secondary compact';button.textContent=`コメント / 返信 · ${post.comment_count}`;button.addEventListener('click',()=>{void openPost(post.id);});box.append(button);el.feedList.append(box);}
  el.feedPage.textContent=`${index+1} / ${p.count}${cursor?' +':''}`;el.btnPrevFeed.disabled=listBusy||index===0;el.btnNextFeed.disabled=listBusy||(index===p.count-1&&!cursor);
  el.btnRefreshFeed.disabled=el.feedMode.disabled=listBusy||collectBusy;}
 async function loadList(append=false){if(append&&!cursor)return;listAbort?.abort();listAbort=new AbortController();const generation=++listGeneration;listBusy=true;renderList();el.feedStatus.textContent='投稿を読み込み中…';
  try{const data=await request('/api/feed/list?'+new URLSearchParams({mode:el.feedMode.value,...(append?{cursor}:{})}),{signal:listAbort.signal});if(generation!==listGeneration)return;
   const old=posts.length;posts=[...new Map((append?[...posts,...data.posts]:data.posts).map(p=>[p.id,p])).values()].slice(0,200);
   cursor=data.next_cursor&&(!append||posts.length>old)&&posts.length<200?data.next_cursor:'';index=append?(posts.length>old?Math.floor(old/GravityView.PAGE_SIZE):index):0;loaded=true;el.feedStatus.textContent=posts.length?'':'表示できる投稿はありません';
  }catch(error){if(generation===listGeneration)el.feedStatus.textContent=error.message;}finally{if(generation===listGeneration){listBusy=false;renderList();void liker.run();}}}
 const draftKey=()=>detail?JSON.stringify([detail.post.id,target?.id||'']):'';
 function stashDraft(){if(detail){drafts.set(draftKey(),el.feedReplyInput.value);while(drafts.size>100)drafts.delete(drafts.keys().next().value);}}
 function chooseTarget(next,stash=true){if(stash)stashDraft();target=next;el.feedReplyInput.value=drafts.get(draftKey())||'';
  el.feedReplyTarget.textContent=target?`${target.author.name||target.author.user_id} のコメントに返信`:`${detail?.post.author.name||''} の投稿に返信`;
  el.feedReplyStatus.textContent='';renderReply();}
 function renderReply(){const disabled=replyBusy||detailBusy||collectBusy||!detail?.post.can_reply;el.feedReplyInput.disabled=el.btnFeedReplySend.disabled=disabled;el.btnReplyPost.disabled=replyBusy||detailBusy||collectBusy||!detail;el.btnMoreFeedComments.disabled=replyBusy||detailBusy||collectBusy;el.btnRefreshFeedDetail.disabled=replyBusy||detailBusy||collectBusy||!detail;}
 function renderComments(){el.feedComments.replaceChildren();for(const c of comments){const li=document.createElement('li');li.append(authorLine(c.author,c.time));const text=document.createElement('p');text.className='feed-text';text.textContent=c.text;const button=document.createElement('button');button.type='button';button.className='secondary compact';button.textContent='返信';button.disabled=replyBusy||detailBusy||!detail.post.can_reply;button.addEventListener('click',()=>{chooseTarget(c);el.feedReplyInput.focus();});li.append(text,button);if(c.replies?.length){const nested=document.createElement('ul');nested.className='feed-comment-replies';for(const r of c.replies){const item=document.createElement('li');item.append(authorLine(r.author,r.time));const content=document.createElement('p');content.className='feed-text';content.textContent=r.text;item.append(content);nested.append(item);}li.append(nested);}
   if(c.has_more_replies){const note=document.createElement('p');note.className='muted small';note.textContent='入れ子の返信がまだあります。全文は App で見てください。';li.append(note);}el.feedComments.append(li);}
  el.btnMoreFeedComments.hidden=!commentCursor;}
 async function openPost(sid,append=false){if(replyBusy||detailBusy)return;stashDraft();detailAbort?.abort();detailAbort=new AbortController();const generation=++detailGeneration;
  if(!append){detail=null;target=null;comments=[];commentCursor='';el.feedDetailContent.replaceChildren();el.feedComments.replaceChildren();el.feedReplyInput.value='';el.feedReplyStatus.textContent='';if(!el.feedDetailDialog.open)el.feedDetailDialog.showModal();document.body.classList.add('feed-detail-open');document.querySelector('.feed-detail-body').scrollTop=0;}
  detailBusy=true;el.feedDetailStatus.textContent='投稿とコメントを読み込み中…';renderReply();renderComments();
  try{const data=await request('/api/feed/detail?'+new URLSearchParams({sid,...(append&&commentCursor?{cursor:commentCursor}:{})}),{signal:detailAbort.signal});if(generation!==detailGeneration)return;
   detail=data;comments=append?[...comments,...data.comments.map(c=>({...c,permit:data.reply_permit}))]:data.comments.map(c=>({...c,permit:data.reply_permit}));
   comments=[...new Map(comments.map(c=>[c.id,c])).values()].slice(0,200);commentCursor=data.next_cursor||'';el.feedDetailContent.replaceChildren(postContent(data.post,true));
   el.feedDetailStatus.textContent=data.post.can_reply?(comments.length?'':'まだコメントはありません'): '作者がコメントを閉じています。';
   renderComments();if(!append)chooseTarget(null,false);renderReply();
  }catch(error){if(generation===detailGeneration)el.feedDetailStatus.textContent=error.message;}
  finally{if(generation===detailGeneration){detailBusy=false;renderReply();renderComments();}}
 }
 el.feedReplyInput.addEventListener('input',stashDraft);
 el.feedReplyForm.addEventListener('submit',event=>{event.preventDefault();if(event.isComposing||replyBusy||detailBusy||!detail?.post.can_reply)return;
  const content=el.feedReplyInput.value.trim();if(!content||content.length>500){el.feedReplyStatus.textContent='返信は1〜500字で入力してください。';return;}
  const sid=detail.post.id,comment_id=target?.id||'',savedDraftKey=draftKey(),key=JSON.stringify([sid,comment_id,content]);
  if(!attempts.has(key))attempts.set(key,crypto.randomUUID());while(attempts.size>100)attempts.delete(attempts.keys().next().value);
  const body={sid,comment_id,content,reply_permit:target?.permit||detail.reply_permit,request_id:attempts.get(key),confirmed:true};
  replyBusy=true;renderReply();renderComments();el.feedReplyStatus.textContent='送信中…';
  void request('/api/feed/reply',{body}).then(data=>{if(!data.posted)throw new Error('送信結果は未確認です。コメントを更新して確認してください。');el.feedReplyStatus.textContent='送信しました';if(comment_id&&data.reply){const parent=comments.find(c=>c.id===comment_id);if(parent)parent.replies=[...new Map([...(parent.replies||[]),data.reply].map(r=>[r.id,r])).values()];}el.feedReplyInput.value='';drafts.delete(savedDraftKey);attempts.delete(key);
  }).catch(error=>{el.feedReplyStatus.textContent=error.message;}).finally(()=>{replyBusy=false;renderReply();renderComments();});
 });
 function syncBodyLock(){if(!document.querySelector('dialog[open]'))document.body.classList.remove('feed-detail-open');}
 function closeDetail(){stashDraft();detailAbort?.abort();detailGeneration++;detailBusy=false;if(el.feedDetailDialog.open)el.feedDetailDialog.close();syncBodyLock();}
 el.btnCloseFeedDetail.addEventListener('click',closeDetail);el.feedDetailDialog.addEventListener('cancel',closeDetail);el.feedDetailDialog.addEventListener('close',syncBodyLock);
 el.btnRefreshFeedDetail.addEventListener('click',()=>{if(detail)void openPost(detail.post.id);});
 el.btnReplyPost.addEventListener('click',()=>chooseTarget(null));el.btnMoreFeedComments.addEventListener('click',()=>{if(detail)void openPost(detail.post.id,true);});
 el.autoLike.checked=store.get('gravity.autoLike')!=='0';
 el.autoLike.addEventListener('change',()=>{store.set('gravity.autoLike',el.autoLike.checked?'1':'0');if(el.autoLike.checked)void liker.run();});
 el.btnRoomView.addEventListener('click',showRooms);el.btnFeedView.addEventListener('click',showPosts);el.btnRefreshFeed.addEventListener('click',()=>{void loadList();});el.feedMode.addEventListener('change',()=>{void loadList();});
 el.btnPrevFeed.addEventListener('click',()=>{index--;renderList();});el.btnNextFeed.addEventListener('click',()=>{if((index+1)*10<posts.length){index++;renderList();}else void loadList(true);});
 if(location.hash==='#posts')showPosts();
})();

/* Read-only view of the server-side follow/block aligner. It never changes anything itself. */
(function(){
 'use strict';
 const summary=document.getElementById('relationSummary'),log=document.getElementById('relationLog'),tab=document.getElementById('btnFriendView');
 if(!summary||!log)return;
 const LABEL={follow:'フォローバック',unfollow:'フォロー解除',block:'ブロック',unblock:'ブロック解除',mute:'ミュート'};
 let timer=null;
 function render(data){
  if(!data.enabled){summary.textContent='自動同期：オフ';log.replaceChildren();return;}
  summary.textContent=`自動同期：${data.ready?'稼働中':'初回の基準を作成中…'} · フォロワー ${data.followers} · フォロー ${data.following} · ブロック ${data.blocked} / ミュート ${data.muted}`;
  log.replaceChildren(...data.recent.map(item=>{const li=document.createElement('li');
   li.textContent=`${new Date(item.at).toLocaleString()} · ${LABEL[item.action]||item.action} · ${item.name||item.user_id}${item.ok?'':'（失敗、あとで再試行）'}`;return li;}));
  if(!data.recent.length){const li=document.createElement('li');li.className='muted small';li.textContent='まだ自動操作の記録はありません。フォローされたらフォローバック、外されたらフォロー解除、ブロックされたらブロックします。';log.append(li);}
 }
 async function load(){
  try{const response=await fetch('/api/relation/status',{cache:'no-store'}),result=await response.json();
   if(response.ok&&result.errno===0)render(result.data);}catch{}
 }
 function schedule(){clearInterval(timer);timer=setInterval(()=>{if(!document.hidden&&!document.getElementById('friendsPanel').hidden)void load();},60000);}
 tab?.addEventListener('click',()=>{void load();schedule();});
 void load();
})();

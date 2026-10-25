(()=>{'use strict';
 const panel=document.getElementById('rewardPanel'),summary=document.getElementById('rewardSummary'),detail=document.getElementById('rewardDetail'),list=document.getElementById('rewardLog');
 if(!panel||!summary||!detail||!list)return;
 let busy=false;
 const add=(text,items)=>{const li=document.createElement('li');li.textContent=text;items.append(li);};
 function render(data){
  const r=data.rewards||{},count=(Number(data.today_writes)||0)+(Number(r.today_claims)||0);
  const title=data.enabled===false||data.auto===false?'自動受け取りは停止中':r.last_error?'自動受け取りを確認してください':'自動受け取り · 今日 '+count+'件';
  if(summary.textContent!==title)summary.textContent=title;
  const info=[];
  if(r.last_error)info.push(r.last_error);
  if(r.sign)info.push('リスニングチェックイン：'+r.sign.current+'/'+r.sign.target+'分 · '+r.sign.state);
  if(r.room){const done=(r.room.levels||[]).filter(x=>x.state==='已领取').length;info.push('いまのルーム宝箱：受取済み '+done+'段階');}
  else info.push('通常入室後に宝箱を自動確認します。試聴では登録も受け取りもしません');
  if(data.ads?.remaining>0)info.push('広告あと '+data.ads.remaining+'回。バックグラウンドで自動受け取り');
  detail.replaceChildren();
  for(const text of info)add(text,detail);
  for(const t of (r.personal||[]).filter(t=>t.status===1||/上がる|ルームに|マイク|房间|上麦/.test(t.name)).slice(0,8)){
   add(t.name+'：'+(t.current??'?')+'/'+(t.target??'?')+' · '+t.state,detail);
  }
  if(r.room)for(const level of (r.room.levels||[]).slice(0,12))add(level.level+'段階の箱：'+level.state+(level.remaining==null?'':' · 残り '+level.remaining),detail);
  const records=[...(r.recent||[]),...(data.recent||[]).map(x=>({...x,state:x.ok?'claimed':'pending'}))].sort((a,b)=>b.at-a.at).slice(0,12);
  list.replaceChildren();
  for(const x of records){
   const awards=(x.rewards||[]).map(p=>p.name+(p.count==null?'':' ×'+p.count)).join('、');
   add(new Date(x.at).toLocaleTimeString()+' '+x.label+' · '+({claimed:'受取済み',reconciled:'公式確認済',retry:'再確認待ち',pending:'結果未確認'}[x.state]||x.state)+(awards?' · '+awards:''),list);
  }
  if(!records.length)add('まだ受け取り記録はありません。条件が揃うと自動で受け取ります。マイク席・部屋移動・ギフト・課金は代行しません。',list);
 }
 async function load(){
  if(busy||document.hidden)return;busy=true;const c=new AbortController(),timer=setTimeout(()=>c.abort(),10000);
  try{const res=await fetch('/api/tasks/status',{signal:c.signal});const body=await res.json();if(!res.ok||body.errno!==0)throw Error('status');render(body.data||{});}
  catch{summary.textContent='自動受け取り · 状態は未更新';}
  finally{clearTimeout(timer);busy=false;}
 }
 void load();setInterval(()=>{void load();},5000);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void load();});
})();

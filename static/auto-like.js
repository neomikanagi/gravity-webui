/* Automatic liking of posts pulled into the public feeds. Pure logic: the page supplies posts, the like call and timing. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.GravityAutoLike=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 /**
  * One post is auto-tried once, so a like the user takes back by hand stays removed. Likes go out one at a time with a gap
  * (the server allows one write per 2 s). `isBusy()` is true while a manual action or list load is in flight.
  */
 function create({posts,enabled,isBusy,like,onLiked,onStatus=()=>{},wait,gap=2400,dayCap=400,dayCount=()=>0,bumpDay=()=>{}}){
  const tried=new Set();let running=false,total=0;
  async function run(){
   if(running)return;running=true;
   try{for(;;){
    if(!enabled()||dayCount()>=dayCap)break;
    const next=posts().find(p=>!p.collected&&p.can_collect&&!tried.has(p.id));if(!next)break;
    if(isBusy()){await wait(600);continue;}
    tried.add(next.id);
    try{
     const data=await like(next);
     // The server remembers every post ever auto-liked or unliked by hand (across days and reloads) and the day's cap.
     if(data&&data.skipped){if(data.capped)break;continue;}
     onLiked(next,data);bumpDay();total++;onStatus(`自動いいね ${total}件`);
    }catch(error){
     const message=String(error&&error.message||'');
     // Too quick: this post gets another go after the gap. Anything else (closed to likes, deleted) just moves on.
     if(/两秒|稍后|rate|busy/i.test(message))tried.delete(next.id);
     if(/会话已失效/.test(message)){onStatus(message);break;}
    }
    await wait(gap);
   }}finally{running=false;}
  }
  return {run,tried,get running(){return running;}};
 }
 return {create};
});

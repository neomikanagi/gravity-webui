/* Pure presentation helpers. No account actions or network calls. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.GravityView=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const PAGE_SIZE=10,MEMBER_PAGE_SIZE=20;
 function page(rooms,index,size=PAGE_SIZE){const count=Math.max(1,Math.ceil(rooms.length/size)),current=Math.max(0,Math.min(index,count-1));
  return {rows:rooms.slice(current*size,(current+1)*size),index:current,count};}
 function officialUser(id){const n=String(id||'');
  return n==='1000000000'||n==='1000002002'||n==='1000002003'||n==='989907610'||(n.length===10&&n>='1000001000'&&n<'1000002000');}
 function offStage(board){const seated=new Set((board?.seats||[]).flatMap(s=>s.person?[String(s.person.user_id)]:[])),members=board?.members||[],self=board?.self_profile;
  // The current page may omit us; the controller retains only this room session's verified self card.
  const rows=self?.is_self===true&&!members.some(p=>String(p.user_id)===String(self.user_id))?[self,...members]:members;
  return rows.filter(p=>!seated.has(String(p.user_id)));}
 // Count subscribed remote audio tracks, not seats or instantaneous volume.
 function remoteSpeakers(s){return s.running&&Number.isSafeInteger(s.remoteAudioCount)&&s.remoteAudioCount>=0?s.remoteAudioCount:0;}
 function micControls(s,allowed){const active=s.accountMode==='member'&&s.state==='listening',seated=active&&s.memberState?.seated===true;
  const open=s.micState==='sdk-published-unverified',pending=s.micClosing||['checking','local-ready','publishing'].includes(s.micState)||s.seatBusy;
  return {apply:active&&!seated&&!pending,leave:seated&&!pending&&!s.memberState?.is_owner,
   open:seated&&!open&&!pending&&allowed&&s.publishingAvailable,close:open&&!s.micClosing};}
 return {PAGE_SIZE,MEMBER_PAGE_SIZE,page,officialUser,offStage,remoteSpeakers,micControls};
});

/* Native TextMessage types 15/31 + NormalGiftMessageInfo; notifications, not payment receipts. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.GravityGifts=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const uid=v=>{if((typeof v!=='string'&&typeof v!=='number')||! /^-?(0|[1-9][0-9]{0,9})$/.test(String(v)))return null;const n=Number(v);return Number.isSafeInteger(n)&&n>=-2147483648&&n<=4294967295&&(n>>>0)>0?n>>>0:null;};
 const name=v=>typeof v==='string'?v.slice(0,80):'';
 function giftEvent(message,peer,room){try{
  if(typeof message?.text!=='string'||message.text.length>32768)return null;
  const outer=JSON.parse(message.text),text=JSON.parse(outer.content||'{}');
  if(outer.messageType!==0||outer.ver!==2||![15,31].includes(text.type)||(outer.channelId!=null&&outer.channelId!==String(room.channel_id)))return null;
  const gift=JSON.parse(text.contentV2||'{}'),sender=uid(text.userId),recipient=uid(gift.user_id);
  if(!sender||!recipient||uid(outer.sendId)!==sender||(gift.channel_id!=null&&gift.channel_id!==String(room.channel_id))||
   !Number.isSafeInteger(gift.gift_id)||gift.gift_id<1||typeof gift.gift_name!=='string'||!gift.gift_name.trim())return null;
  const count=gift.total_gift_count>0?gift.total_gift_count:gift.gift_count;
  if(!Number.isSafeInteger(count)||count<1||count>1000000)return null;
  const ts=Number.isSafeInteger(text.ts)&&text.ts>0?text.ts:null;
  return {sender_uid:sender,recipient_uid:recipient,sender_name:name(text.name)||String(sender),recipient_name:name(gift.user_name)||String(recipient),
   gift_name:name(gift.gift_name),count,source_verified:uid(peer)===sender,timestamp:ts,has_timestamp:ts!==null,
   key:[room.channel_id,sender,recipient,gift.gift_id,ts||'',count].join(':')};
 }catch{return null;}}
 function pick(list,rng){const n=list.length;if(!n)return '';const i=Math.floor((typeof rng==='function'?rng():Math.random())*n);return list[Math.max(0,Math.min(n-1,i))];}
 // Lines as people actually type them in Japanese voice-room chat: short, warm, a
 // light emoji, no stiff or odd phrasing. Every line names the sender.
 const gifted=gift=>gift.count>1?`${gift.gift_name}×${gift.count}`:gift.gift_name;
 const THANKS=[
  (who)=>`${who}、ギフトありがとうございます！`,
  (who)=>`${who}ありがとう〜！めっちゃ嬉しい☺️`,
  (who)=>`わ、${who}ありがとう！嬉しすぎる🥹`,
  (who,gift)=>`${who}、${gifted(gift)}ありがとうございます✨`,
  (who,gift)=>`${who}、${gifted(gift)}ありがとう！テンション上がる〜`,
  (who)=>`${who}、ギフトありがとう🎁 ゆっくりしていってね`,
  (who)=>`${who}、ギフト助かります！ありがとうございます🙏`,
  (who)=>`${who}、いつもありがとう🙌`,
  (who)=>`${who}、ありがとう！ほんと嬉しい💕`,
  (who)=>`${who}ありがとう〜🙏✨`,
  (who)=>`${who}、素敵なギフトありがとうございます！`,
  (who)=>`${who}、優しい…ありがとう🥹`,
  (who)=>`${who}神すぎる…ありがとう！`,
  (who)=>`${who}、お気持ちありがとうございます☺️`,
  (who)=>`ありがとう${who}！嬉しい〜`,
  (who)=>`${who}、ギフトありがとう！これからもよろしくね`,
  (who)=>`${who}、ありがとうございます😭✨`,
  (who)=>`${who}、うれしい！ありがとうね`,
  (who)=>`${who}、わざわざありがとう🙏`,
  (who)=>`${who}、ギフトいただきました！感謝です🙇`,
 ];
 // Add さん unless the name already carries an honorific; never "さんさん".
 function honor(name){const n=String(name||'').trim().slice(0,60);
  if(!n)return '送ってくれた方';
  return /(さん|ちゃん|くん|君|様|さま|氏|たん)$/.test(n)?n:n+'さん';}
 function thanksText(gift,rng){
  return pick(THANKS,rng)(honor(gift.sender_name),gift);
 }
 function boxEvent(message,room){try{
  if(typeof message?.text!=='string'||message.text.length>32768)return null;
  const outer=JSON.parse(message.text),text=JSON.parse(outer.content||'{}');
  if(outer.messageType!==0||outer.ver!==2||(outer.channelId!=null&&outer.channelId!==String(room.channel_id)))return null;
  let info=text;try{info=JSON.parse(text.contentV2||text.content||'{}');}catch{info=text;}
  const lucky=String(info.lucky_box_id||info.luckyBoxId||'');const issue=String(info.issue_user_id||info.issueUserId||'');
  if(!/^[1-9][0-9]{0,19}$/.test(lucky)||!/^[1-9][0-9]{0,19}$/.test(issue))return null;
  if(info.channel_id!=null&&String(info.channel_id)!==String(room.channel_id))return null;
  return {lucky_box_id:lucky,issue_user_id:issue};
 }catch{return null;}}
 return {giftEvent,thanksText,boxEvent,THANKS};
});

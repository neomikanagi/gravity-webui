'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {giftEvent,thanksText,boxEvent,THANKS}=require('../static/gift-events.js');
function wire({outer={},inner={},gift={}}={}){return {text:JSON.stringify({messageType:0,ver:2,sendId:9,channelId:'123',...outer,content:JSON.stringify({userId:'9',name:'Host',type:15,ts:1900000000000,...inner,contentV2:JSON.stringify({user_id:'7',user_name:'You',gift_id:2,gift_name:'Rose',gift_count:1,total_gift_count:3,...gift})})})};}
test('native gift types 15/31 show sender, recipient, gift and cumulative quantity, with verified peer',()=>{
 for(const type of [15,31]){const g=giftEvent(wire({inner:{type}}),'9',{channel_id:'123'});assert.equal(g.sender_uid,9);assert.equal(g.recipient_uid,7);assert.equal(g.count,3);assert.equal(g.source_verified,true);assert.equal(g.timestamp,1900000000000);assert.equal(thanksText(g,()=>0),'Hostさん、ギフトありがとうございます！');
  assert.match(thanksText(g,()=>0.99),/Hostさん/);}
 assert.equal(giftEvent(wire({gift:{total_gift_count:0}}),'9',{channel_id:'123'}).count,1);
});
test('thanks lines are a 16–20 Japanese pool and every draw names the sender',()=>{
 assert.ok(THANKS.length>=16&&THANKS.length<=20);
 const g=giftEvent(wire(),'9',{channel_id:'123'});
 const seen=new Set();
 for(let i=0;i<THANKS.length;i++){
  const line=thanksText(g,()=>i/THANKS.length);
  assert.match(line,/Hostさん/);
  assert.match(line,/[\u3040-\u30ff]/);
  assert.doesNotMatch(line,/你好|谢谢|早上好|晚上好|感谢/);
  seen.add(line);
 }
 assert.equal(seen.size,THANKS.length);
});
test('gift parser rejects invalid/signed-overflow IDs, malformed JSON, wrong rooms and bogus quantities',()=>{
 assert.equal(giftEvent({text:'bad'},'9',{channel_id:'123'}),null);
 for(const patch of [{outer:{sendId:8}},{outer:{channelId:'456'}},{outer:{ver:1}},{inner:{type:1}},{inner:{userId:'7e0'}},{gift:{user_id:'4294967296'}},{gift:{user_id:'-4294967289'}},{gift:{channel_id:'456'}},{gift:{gift_count:0,total_gift_count:0}},{gift:{total_gift_count:1000001}},{gift:{gift_name:''}}])assert.equal(giftEvent(wire(patch),'9',{channel_id:'123'}),null);
 const high=giftEvent(wire({outer:{sendId:-16711165},inner:{userId:'-16711165'},gift:{user_id:'-16711165'}}),'4278256131',{channel_id:'123'});assert.equal(high.recipient_uid,4278256131);assert.equal(high.source_verified,true);
});
test('relay or mismatched peer notifications remain visible but cannot authorize thanks',()=>{
 const g=giftEvent(wire(),'8',{channel_id:'123'});assert.ok(g);assert.equal(g.source_verified,false);
 assert.equal(giftEvent(wire({inner:{ts:0}}),'9',{channel_id:'123'}).has_timestamp,false);
});
test('treasure notifications expose official box and issuer ids',()=>{
 const message={text:JSON.stringify({messageType:0,ver:2,channelId:'123',content:JSON.stringify({contentV2:JSON.stringify({lucky_box_id:'88',issue_user_id:'9',channel_id:'123'})})})};
 assert.deepEqual(boxEvent(message,{channel_id:'123'}),{lucky_box_id:'88',issue_user_id:'9'});
 assert.equal(boxEvent(message,{channel_id:'456'}),null);
});
module.exports={wire};

test('thanks never doubles an honorific or prints an empty name',()=>{
 const g=giftEvent(wire(),'9',{channel_id:'123'});
 for(const [name,expected] of [['みかちゃん','みかちゃん、'],['たろうさん','たろうさん、'],['Host','Hostさん、']])assert.ok(thanksText({...g,sender_name:name},()=>0).startsWith(expected));
 assert.doesNotMatch(thanksText({...g,sender_name:''},()=>0),/さんさん|^、/);
 assert.match(thanksText({...g,gift_name:'バラ',count:3},()=>3/THANKS.length),/バラ×3/);
 assert.doesNotMatch(thanksText({...g,gift_name:'バラ',count:1},()=>3/THANKS.length),/×1/);
});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {createImService,publicPerson}=require('../gravity-im.cjs');
const {textMessage}=require('../gravity-imcore.cjs'),pb=require('../gravity-pb.cjs'),M=require('../gravity-im-message.cjs');
const ME='2000000001',PEER='2000000002';
const one=({from=PEER,to=ME,text='hello',id=7,chatType=1,service=false}={})=>{
 const raw=pb.first(pb.decode(textMessage({fromId:from,toId:to,text:JSON.stringify({type:0,content:text,user:{chatType:service?'SERVICE':'USER'}}),clientMsgId:BigInt(id),serverNow:100000})),1);
 if(chatType!==1)return Buffer.concat([pb.enc.varint(1,chatType),...pb.decode(raw).filter(f=>f.field!==1).map(f=>f.wire===2?pb.enc.bytes(f.field,f.value):pb.enc.varint(f.field,f.value))]);return raw;
};
function setup(t,{rows=[{user_id:PEER,name:'Friend',portrait:'https://cdn.gravity.place/a.png'}],history=[],convs=[],onBlocked}={}){
 let clock=100000,who={user:ME,identity:'original'},fail=null;
 const calls=[],cores=[],writes=[];
 class Core extends EventEmitter{
  async ready(){await this.options.credentials();this.readyCount=(this.readyCount||0)+1;}
  async conversations(){return convs;}
  async history(id){this.histories=(this.histories||0)+1;this.historyIds=(this.historyIds||[]).concat(id);if(this.historyFail)throw Error('history');return history;}
  async sendText(peer,text){this.sent=(this.sent||[]).concat({peer,text});if(fail)throw fail;return {seq:'4',serverTime:clock,clientMsgId:'44'};}
  close(){this.closed=true;}
 }
 const service=createImService({stateFile:'/dev/null/device.json',identity:()=>who,now:()=>clock,onBlocked,
  read:async(kind,extra,request,options)=>{calls.push({kind,extra,options});if(['friends','following'].includes(kind))return {errno:0,data:{list:rows,last_id:PEER}};
   if(kind==='imToken')return {errno:0,data:{token:'secret',userID:who.user}};
   return {errno:0,data:{user_id:extra.target_id,name:'verified',portrait:'https://cdn.gravity.place/a.png'}};},
  write:async(extra,request,options)=>{writes.push({extra,options});return {errno:0};},
  createCore:options=>{const c=new Core();c.options=options;cores.push(c);return c;}});
 t.after(()=>service.drain());
 return {service,calls,cores,writes,advance:ms=>clock+=ms,change:v=>who=v,fail:v=>fail=v,
  async open(){await service.friends();await service.connect();return service.chat(PEER);}};
}
const body=(chat,extra={})=>({peer:PEER,text:'hi',request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',chat_permit:chat.chat_permit,confirmed:true,...extra});
test('IM lists remove official accounts, duplicates, self and unsafe IDs, without tokens',async t=>{
 const f=setup(t,{rows:[{user_id:PEER,name:'<img onerror=x>',token:'secret'},{user_id:PEER},{user_id:ME},{user_id:'1000001101'},{user_id:'989907610'},{user_id:9007199254740994}]});
 const r=await f.service.friends();assert.equal(r.people.length,1);assert.equal(r.hidden_official,2);assert.equal(JSON.stringify(r).includes('secret'),false);assert.equal(f.cores.length,0);
 assert.equal(publicPerson({user_id:'123',portrait:'https://evil.invalid/a.png'}).portrait,'');
 for(const kind of ['__proto__','constructor','evil'])await assert.rejects(f.service.friends({kind}));
});
test('full bounded friend pages are retained instead of skipping rows behind the official cursor',async t=>{
 const f=setup(t,{rows:Array.from({length:150},(_,i)=>({user_id:String(200+i)}))});assert.equal((await f.service.friends()).people.length,150);
});
test('chat reads cannot log in or reclaim a session, only explicit connect can',async t=>{
 const f=setup(t);await assert.rejects(f.service.chat(PEER),e=>e.status===409);assert.equal(f.cores.length,0);
 await f.open();f.cores[0].emit('kicked');assert.equal(f.service.status().state,'kicked');
 await assert.rejects(f.service.chat(PEER),e=>e.status===409);assert.equal(f.cores.length,1);
 await f.service.connect();assert.equal(f.cores.length,2);assert.equal(f.service.status().state,'ready');
});
test('history image messages keep official CDN urls',async t=>{
 const payload=JSON.stringify({type:25,content:'[图片]',extInfo:JSON.stringify({url:'https://cdn.gravity.place/chat.gif'})});
 const raw=pb.first(pb.decode(textMessage({fromId:PEER,toId:ME,text:payload,clientMsgId:21n,serverNow:100000})),1);
 const f=setup(t,{history:[raw]});const chat=await f.open();
 assert.equal(chat.messages[0].kind,'image');assert.equal(chat.messages[0].image,'https://cdn.gravity.place/chat.gif');
});
test('incoming and history text render safely, exclude system/group/not-ours and deduplicate pushes',async t=>{
 const f=setup(t,{history:[one(),one({from:'1000001101',id:8}),one({service:true,id:9}),one({chatType:2,id:10}),one({to:'123',id:11})]});
 const chat=await f.open();assert.equal(chat.messages.length,1);assert.equal(chat.history_loaded,true);
 f.cores[0].emit('message',one());f.cores[0].emit('message',one({text:'<img src=x>',id:12}));
 assert.equal((await f.service.chat(PEER)).messages.length,2);assert.equal(f.service.status().blocked_official,2);
 assert.equal((await f.service.chat(PEER)).messages.at(-1).text,'<img src=x>');
});
test('failed history is labelled, retried and never fabricated as empty success',async t=>{
 const f=setup(t);await f.service.friends();await f.service.connect();f.cores[0].historyFail=true;
 assert.equal((await f.service.chat(PEER)).history_loaded,false);f.cores[0].historyFail=false;
 assert.equal((await f.service.chat(PEER)).history_loaded,true);assert.equal(f.cores[0].histories,2);
});
test('unread counts cover ordinary incoming messages only and clear when opened',async t=>{
 const f=setup(t);await f.open();f.advance(20000);f.cores[0].emit('message',one({id:12}));f.cores[0].emit('message',one({from:'1000001101',id:13}));
 assert.deepEqual(f.service.status().unread,{[PEER]:1});await f.service.chat(PEER);assert.deepEqual(f.service.status().unread,{});
});
test('sending requires a verified chat target, confirmation and valid per-account permit',async t=>{
 const f=setup(t),chat=await f.open();
 for(const patch of [{chat_permit:'bad'},{confirmed:false},{peer:'1000001101'},{peer:ME},{text:'x'.repeat(501)},{request_id:'-'.repeat(36)}]){
  assert.throws(()=>f.service.send(body(chat,patch)));}
 const r=await f.service.send(body(chat));assert.equal(r.sent,true);assert.equal(f.cores[0].sent.length,1);
 const native=JSON.parse(f.cores[0].sent[0].text);assert.equal(native.content,'hi');assert.equal(native.user.name,'verified');
 assert.ok(f.calls.every(c=>c.options.expectedIdentity==='original'));
});
test('identical concurrent/repeated submissions share one native send; payload reuse is rejected',async t=>{
 const f=setup(t),chat=await f.open(),b=body(chat);const a=f.service.send(b),c=f.service.send(b);assert.equal(a,c);await a;
 assert.equal((await f.service.send(b)).sent,true);assert.equal(f.cores[0].sent.length,1);
 assert.throws(()=>f.service.send(body(chat,{text:'another'})),e=>e.status===409);
});
test('unknown send result is retained, not retried; explicit refusal is safely retryable',async t=>{
 const f=setup(t),chat=await f.open(),b=body(chat);f.fail({code:'im_timeout'});await assert.rejects(f.service.send(b),e=>e.status===504);
 f.fail(null);f.advance(2000);await assert.rejects(f.service.send(b));assert.equal(f.cores[0].sent.length,1);
 const next=body(chat,{request_id:'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'});f.fail({code:'im_send_rejected',bizCode:11008});await assert.rejects(f.service.send(next),/拒收/);
 f.fail(null);f.advance(2000);assert.equal((await f.service.send(next)).sent,true);
});
test('being blocked by the peer auto-blocks them and does not retry the same send',async t=>{
 const f=setup(t),chat=await f.open(),blocked=body(chat,{request_id:'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee'});
 f.fail({code:'im_send_rejected',bizCode:11009});await assert.rejects(f.service.send(blocked),/已自动拉黑/);
 assert.deepEqual(f.writes,[{extra:{target_user_id:PEER,action:'block'},options:{expectedIdentity:'original'}}]);
});
test('the automatic block after 11009 is reported, so the person is muted as well',async t=>{
 const seen=[],f=setup(t,{onBlocked:id=>seen.push(id)}),chat=await f.open();
 f.fail({code:'im_send_rejected',bizCode:11009});await assert.rejects(f.service.send(body(chat,{request_id:'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee'})),/已自动拉黑/);
 assert.deepEqual(seen,[PEER]);
});
test('changing account or removing the session closes IM and clears old private data and permits',async t=>{
 const f=setup(t),chat=await f.open();f.advance(20000);f.cores[0].emit('message',one());
 f.change({user:'222',identity:'new'});assert.deepEqual(f.service.status().unread,{});assert.equal(f.cores[0].closed,true);assert.equal(f.service.status().state,'idle');
 assert.throws(()=>f.service.send(body(chat)),e=>e.status===403);f.change(null);assert.throws(()=>f.service.status(),e=>e.status===401);
});
test('account change while queued aborts sending rather than using a new identity',async t=>{
 const f=setup(t),chat=await f.open(),pending=f.service.send(body(chat));f.change({user:'222',identity:'new'});
 await assert.rejects(pending,e=>e.status===409);assert.equal(f.cores[0].sent?.length||0,0);
});
test('rate limiting refuses a second new send inside one second',async t=>{
 const f=setup(t),chat=await f.open();await f.service.send(body(chat));assert.throws(()=>f.service.send(body(chat,{request_id:'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'})),e=>e.status===429);
});
test('live messages in RC-id space land on the right peer instead of being dropped',async t=>{
 const f=setup(t);await f.open();
 f.advance(20000);
 const rcPeer=M.rcId(PEER),rcMe=M.rcId(ME);
 f.cores[0].emit('message',one({from:rcPeer,to:rcMe,id:21}));
 assert.deepEqual(f.service.status().unread,{[PEER]:1});
 const chat=await f.service.chat(PEER);
 assert.ok(chat.messages.some(m=>m.text==='hello'&&!m.mine));
});
test('connect pulls the server conversation list and backfills unopened chats',async t=>{
 const serverChatId=`${M.rcId(ME)}:${M.rcId(PEER)}`;
 const f=setup(t,{history:[one({id:31})],convs:[{chatType:1,chatId:serverChatId,lastSeq:'9',lastTime:100000}]});
 await f.service.friends();await f.service.connect();
 assert.deepEqual(f.service.status().unread,{[PEER]:1});
 assert.deepEqual(f.cores[0].historyIds,[serverChatId]);
 const chat=await f.service.chat(PEER);
 assert.equal(chat.history_loaded,true);
 assert.ok(chat.messages.some(m=>m.text==='hello'));
 assert.deepEqual(f.service.status().unread,{});
});
test('room cards arrive as clickable rooms, not opaque special messages',async t=>{
 const room={channel_id:'123456',name:'夜话房',is_3D:0,label_info:'聊天',room_type:0};
 const payload=JSON.stringify({type:44,content:'语音房',detail:Buffer.from(JSON.stringify(room),'utf8').toString('base64')});
 const raw=pb.first(pb.decode(textMessage({fromId:PEER,toId:ME,text:payload,clientMsgId:31n,serverNow:100000})),1);
 const f=setup(t,{history:[raw]});const chat=await f.open();
 assert.equal(chat.messages[0].kind,'room');assert.equal(chat.messages[0].room.channel_id,'123456');
});
test('private image sending uploads source=private then sends type-25 over IM',async t=>{
 const uploads=[];
 const f=setup(t);f.service.drain;
 const svc=createImService({stateFile:'/dev/null/device2.json',identity:()=>({user:ME,identity:'img'}),
  now:()=>100000,read:async(kind,extra)=>kind==='imToken'?{errno:0,data:{token:'s',userID:ME}}:kind==='userDetail'?{errno:0,data:{user_id:ME,name:'Me',portrait:'https://cdn.gravity.place/me.png'}}:{errno:0,data:{list:[{user_id:PEER,name:'F'}],last_id:''}},
  write:async()=>({errno:0}),uploadImage:async(buffer,request,options)=>{uploads.push({buffer,options});
   assert.equal(options.expectedIdentity,'img');return {errno:0,data:{url:'https://cdn.gravity.place/p.png',width:120,height:90,mark:''}};},
  createCore:options=>{const {EventEmitter}=require('node:events');const c=new EventEmitter();
   c.ready=async()=>{await options.credentials();};c.conversations=async()=>[];c.history=async()=>[];
   c.sendText=async(peer,text)=>{c.sentText=text;return {seq:'9',serverTime:100000,clientMsgId:'99'};};c.close=()=>{};return c;}});
 t.after(()=>svc.drain());
 await svc.friends();await svc.connect();const chat=await svc.chat(PEER);
 const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(32,1)]);
 for(const bad of [{peer:PEER,request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',chat_permit:'bad',confirmed:true,buffer:png},
   {peer:PEER,request_id:'bad',chat_permit:chat.chat_permit,confirmed:true,buffer:png},
   {peer:PEER,request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',chat_permit:chat.chat_permit,confirmed:false,buffer:png},
   {peer:ME,request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',chat_permit:chat.chat_permit,confirmed:true,buffer:png},
   {peer:PEER,request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',chat_permit:chat.chat_permit,confirmed:true,buffer:Buffer.from('nope')}])
  assert.throws(()=>svc.sendImage(bad));
 const r=await svc.sendImage({peer:PEER,request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',chat_permit:chat.chat_permit,confirmed:true,buffer:png});
 assert.equal(r.sent,true);assert.equal(r.message.kind,'image');assert.equal(r.message.image,'https://cdn.gravity.place/p.png');
 assert.equal(uploads.length,1);

});
test('private image upload rejects audit marks and bad urls',async t=>{
 for(const data of [{url:'https://cdn.gravity.place/p.png',width:1,height:1,mark:'porn'},{url:'https://evil.invalid/x.png',width:1,height:1}])
  await assert.rejects((async()=>{const svc=createImService({stateFile:'/dev/null/device3.json',identity:()=>({user:ME,identity:'img3'}),
   now:()=>100000,read:async(kind)=>kind==='imToken'?{errno:0,data:{token:'s',userID:ME}}:{errno:0,data:{list:[{user_id:PEER,name:'F'}],last_id:''}},
   uploadImage:async()=>({errno:0,data}),createCore:options=>{const {EventEmitter}=require('node:events');const c=new EventEmitter();
    c.ready=async()=>{await options.credentials();};c.conversations=async()=>[];c.history=async()=>[];
    c.sendText=async()=>({seq:'1',serverTime:1,clientMsgId:'1'});c.close=()=>{};return c;}});
   try{await svc.friends();await svc.connect();const chat=await svc.chat(PEER);
    const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(32,1)]);
    await svc.sendImage({peer:PEER,request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',chat_permit:chat.chat_permit,confirmed:true,buffer:png});
   }finally{svc.drain();}})());
});

test('new-message notices name the sender from the message itself, newest first, and clear when that chat opens',async t=>{
 const f=setup(t);await f.service.friends();await f.service.connect();f.advance(20000);
 const STRANGER='2000000003';
 const named=(from,text,id)=>pb.first(pb.decode(textMessage({fromId:from,toId:ME,text:JSON.stringify({type:0,content:text,user:{chatType:'USER',name:'Mika',portrait:'https://cdn.gravity.place/m.png?x=1'}}),clientMsgId:BigInt(id),serverNow:200000})),1);
 f.cores[0].emit('message',one({id:21,text:'first'}));f.advance(1000);
 f.cores[0].emit('message',named(STRANGER,'こんばんは！',22));
 const notices=f.service.status().notices;
 assert.deepEqual(notices.map(n=>n.user_id),[STRANGER,PEER]);
 assert.equal(notices[0].name,'Mika');assert.equal(notices[0].text,'こんばんは！');assert.equal(notices[0].portrait,'https://cdn.gravity.place/m.png');
 assert.equal(notices[1].name,'Friend','a known friend keeps the list name');assert.equal(notices[1].count,1);
 await f.service.chat(PEER);
 assert.deepEqual(f.service.status().notices.map(n=>n.user_id),[STRANGER]);
});
test('a visible page keeps the IM connection warm; a plain status read does not',async t=>{
 const f=setup(t);await f.service.connect();
 f.advance(9*60*1000);f.service.status({keep:true});f.advance(9*60*1000);
 assert.equal(f.service.status().state,'ready');
});

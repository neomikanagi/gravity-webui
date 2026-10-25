'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const api=require('../gravity-api.cjs');
const server=require('../serve.cjs');
const options={token:'synthetic%2Btoken%3D',device:{idfa:'synthetic-idfa',uwd:'synthetic-uwd',app_version:'14.2',zone:'9'},ts:1791344121};
const nativeRoom={channel_id:'1000000000000000001',user_id:2000000009,name:'Native room',label_info:{id:2,label:'Chat'},topic:'Topic',notice:'Notice',tags:'one,two',ext:{user_count:12,cover_img:'https://cdn.gravity.place/room/image.png',user_list:[{user_id:44,name:'Not the host',profile:'PRIVATE-PROFILE'},{user_id:2000000009,name:'Owner',portrait:'https://cdn.gravity.place/owner/image.png',token:'PRIVATE-TOKEN'}]},secret:'PRIVATE-SECRET'};
function upstream(data={list:[]}){return {status:200,body:Buffer.from(JSON.stringify({errno:0,data}))};}
async function runServer(t,injections){
 const instance=http.createServer(server.makeHandler(injections));
 await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>{instance.closeAllConnections();instance.close(resolve);}));
 return 'http://127.0.0.1:'+instance.address().port;
}
test('native App rooms are mapped to the same safe card schema as public share rooms',()=>{
 const rooms=server.publicRooms({list:[nativeRoom]});
 assert.deepEqual(rooms,[{channel_id:nativeRoom.channel_id,anchor_id:'2000000009',title:'Native room',anchor_name:'Owner',count:12,label:'Chat',tags:['one','two'],topic:'Topic',notice:'Notice',portrait:'https://cdn.gravity.place/owner/image.png',cover:'https://cdn.gravity.place/room/image.png'}]);
 const text=JSON.stringify(rooms);assert.ok(!text.includes('PRIVATE-'));assert.ok(!text.includes('Not the host'));
});
test('native directory pages larger than 20 rows are retained with a bounded mapper',()=>{
 const rows=Array.from({length:160},(_,i)=>({...nativeRoom,channel_id:String(i+1)}));
 assert.equal(server.publicRooms({list:rows.slice(0,28)}).length,28);
 assert.equal(server.publicRooms({list:rows}).length,100);
});
test('missing native host details do not mislabel another attendee as the owner',()=>{
 const room=structuredClone(nativeRoom);room.ext.user_list=room.ext.user_list.slice(0,1);
 assert.equal(server.publicRooms({list:[room]})[0].anchor_name,'');
});
test('numeric unsafe IDs are rejected rather than rounded',()=>{
 assert.deepEqual(server.publicRooms({list:[{...nativeRoom,channel_id:Number(nativeRoom.channel_id)}]}),[]);
 assert.deepEqual(server.publicRooms({list:[{...nativeRoom,user_id:Number.MAX_SAFE_INTEGER+1}]}),[]);
});
test('signed search makes one request with fresh protocol params and no Android or limit guesses',async()=>{
 const calls=[];
 const result=await api.trySignedSearch({keyword:'中文 雑談',limit:'10'},async request=>{calls.push(request);return upstream();},options);
 assert.equal(result.errno,0);assert.equal(calls.length,1);
 const url=new URL('https://'+calls[0].hostname+calls[0].path);
 assert.equal(url.pathname,'/gravity/voice/search');assert.equal(url.searchParams.get('keyword'),'中文 雑談');
 assert.equal(url.searchParams.get('token'),options.token);assert.equal(url.searchParams.get('ts'),'1791344121');
 assert.match(url.searchParams.get('sign'),/^[0-9a-f]{32}$/);
 for(const key of ['limit','api_security','pkg','brand','nonce','app_version_code'])assert.equal(url.searchParams.has(key),false);
});
test('missing sessions/device and unsupported endpoint never trigger probes or network',async()=>{
 let calls=0;const request=async()=>{calls++;throw Error('no network');};
 assert.equal((await api.trySignedSearch({keyword:'a'},request,{...options,token:null})).errno,-3);
 assert.equal((await api.trySignedSearch({keyword:'a'},request,{...options,device:null})).errno,-4);
 await assert.rejects(api.readSignedVoice('https://evil.invalid',{},request,options),/unsupported_voice_read/);
 assert.equal(calls,0);
});
test('rank pagination uses the channel cursor while label requests stay within captured schema',async()=>{
 const calls=[];const request=async input=>{calls.push(new URL('https://'+input.hostname+input.path));return upstream();};
 await api.trySignedRooms({cursor:nativeRoom.channel_id},request,options);
 assert.equal(calls[0].searchParams.get('channel_id'),nativeRoom.channel_id);
 await api.trySignedRooms({label_id:'2'},request,options);
 assert.equal(calls[1].pathname,'/gravity/voice/listRoomForLabel');assert.equal(calls[1].searchParams.get('label_id'),'2');
 assert.match(calls[1].searchParams.get('session_id'),/^[0-9A-F-]{36}$/);
 assert.equal(calls[1].searchParams.has('channel_id'),false);
 assert.equal((await api.trySignedRooms({cursor:'bad'},request,options)).errno,-1);
 assert.equal((await api.trySignedRooms({label_id:'https://evil.invalid'},request,options)).errno,-1);
 assert.equal(calls.length,2);
});
test('upstream failures are bounded and never relay credential-bearing error messages',async()=>{
 const result=await api.trySignedSearch({keyword:'a'},async()=>({status:200,body:Buffer.from(JSON.stringify({errno:-4,errmsg:'PRIVATE-TOKEN',data:{secret:'x'}}))}),options);
 assert.equal(result.errno,-4);assert.ok(!JSON.stringify(result).includes('PRIVATE-TOKEN'));assert.ok(!result.data);
 const malformed=await api.trySignedSearch({keyword:'a'},async()=>({status:200,body:Buffer.from('not JSON')}),options);
 assert.equal(malformed.errno,-1);
});
test('search shortcuts use the selected Japanese keywords without upstream requests or a valid session',async t=>{
 let calls=0;
 for(const state of ['verified','rejected_session']){
  const base=await runServer(t,{account:()=>({state}),request:async()=>{calls++;throw Error('no network');}});
  const result=await(await fetch(base+'/api/search/recommendations')).json();
  assert.deepEqual(result,{errno:0,data:{keywords:['中国語','人間関係','占い']}});
 }
 assert.equal(calls,0);
});
test('official native search results are mapped and empty official searches do not fall back',async t=>{
 let fallbackCalls=0;
 const base=await runServer(t,{signedSearch:async extra=>({errno:0,data:{list:extra.keyword==='none'?[]:[nativeRoom]}}),searchFallback:async()=>{fallbackCalls++;throw Error('must not call');}});
 const hit=await(await fetch(base+'/api/search?keyword=live')).json();assert.equal(hit.data.mode,'official');assert.equal(hit.data.rooms.length,1);
 const empty=await(await fetch(base+'/api/search?keyword=none')).json();assert.equal(empty.data.mode,'official');assert.deepEqual(empty.data.rooms,[]);assert.equal(fallbackCalls,0);
});
test('official directory, categories and cursor are exposed without private App fields',async t=>{
 const calls=[];
 const base=await runServer(t,{signedRooms:async extra=>{calls.push(extra);return {errno:0,data:{list:[nativeRoom],last_id:nativeRoom.channel_id}};},signedLabels:async()=>({errno:0,data:{list:[{id:2,label:'Chat',secret:'PRIVATE'}]}}),request:async()=>{throw Error('no fallback');}});
 const rooms=await(await fetch(base+'/api/rooms')).json();assert.equal(rooms.data.mode,'official');assert.equal(rooms.data.next_cursor,nativeRoom.channel_id);assert.equal(rooms.data.rooms.length,1);
 const labels=await(await fetch(base+'/api/labels')).json();assert.deepEqual(labels.data.labels,[{id:'2',label:'Chat'}]);
 const sameCursor=await(await fetch(base+'/api/rooms?cursor='+nativeRoom.channel_id)).json();assert.equal(sameCursor.data.next_cursor,'');
 assert.equal((await fetch(base+'/api/rooms?label_id=bad')).status,400);
 assert.equal((await fetch(base+'/api/rooms?cursor=bad')).status,400);
 assert.equal(calls.length,2);
});

test('rank rows the official list marks ended (ext.is_close=1) never become room cards',()=>{
 const live={...nativeRoom,ext:{...(nativeRoom.ext||{}),is_close:0}},ended={...nativeRoom,channel_id:'1075421072908679451',ext:{...(nativeRoom.ext||{}),is_close:1}};
 const noFlag={...nativeRoom,channel_id:'1075421072908679452',ext:{}};
 assert.deepEqual(server.publicRooms({list:[live,ended,noFlag]}).map(r=>r.channel_id),[live.channel_id,noFlag.channel_id]);
 assert.deepEqual(server.publicRooms({list:[{...ended,ext:{is_close:'1'}}]}),[]);
 assert.deepEqual(server.publicFollowRooms({list:[{follow_type:1,list:[ended]}]}),[]);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');
const server = require('../serve.cjs');
const DIRECT='https://www.gravity.place/share/shareVoiceRoomOnline?channel_id=1000000000000000001&anchorId=2000000009';
async function app(t, request=async()=>{throw new Error('test must not use upstream');}) {
  const s=http.createServer(server.makeHandler({request, signedRooms:async()=>({errno:-3})}));await new Promise(r=>s.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));
  return `http://127.0.0.1:${s.address().port}`;
}
test('direct room IDs stay exact 64-bit strings',()=>{
  const room=server.parseRoomFromUrl(DIRECT);assert.equal(room.channel_id,'1000000000000000001');assert.equal(room.anchor_id,'2000000009');
  assert.equal(server.extractShortCode('AbCdE'),'AbCdE');assert.equal(server.extractShortCode('https://api.gravity.place/gravity/url/AbCdE'),'AbCdE');
});
test('only canonical official HTTPS room links/short codes are accepted',async()=>{
  for(const url of ['http://api.gravity.place/gravity/url/AbCdE','https://api.gravity.place.evil.invalid/gravity/url/AbCdE',
    'https://127.0.0.1/gravity/url/AbCdE','https://user@api.gravity.place/gravity/url/AbCdE',
    'https://api.gravity.place:8443/gravity/url/AbCdE','https://www.gravity.place/account?channel_id=1&anchorId=2',
    'https://www.gravity.place/share/shareVoiceRoomOnline?channel_id=NaN&anchorId=1',
    'https://www.gravity.place/share/shareVoiceRoomOnline?channel_id=0&anchorId=1']){
    let calls=0;await assert.rejects(server.resolveShareInput(url,async()=>{calls++;throw new Error('upstream');}));assert.equal(calls,0);
  }
});
test('short-link redirects are parsed, never followed to arbitrary hosts',async()=>{
  let calls=0;
  await assert.rejects(server.resolveShareInput('AbCdE',async()=>{calls++;return {status:302,headers:{location:'https://127.0.0.1/share/shareVoiceRoomOnline?channel_id=1&anchorId=2'}};}));
  assert.equal(calls,1);
  const room=await server.resolveShareInput('AbCdE',async()=>({status:302,headers:{location:DIRECT}}));assert.equal(room.channel_id,'1000000000000000001');
});
test('HTTPS request rejects nonofficial upstream before any network call',async()=>{
  await assert.rejects(server.httpsRequest({hostname:'127.0.0.1',path:'/gravity/test'}));
  await assert.rejects(server.httpsRequest({hostname:'api.gravity.place',path:'/account'}));
});
test('public IPv4 filter excludes private/sink addresses',()=>{
  for(const ip of ['0.0.0.0','127.0.0.1','10.1.2.3','172.16.0.53','192.168.1.2','169.254.1.2','100.64.1.1','224.1.1.1','999.1.2.3'])assert.equal(server.publicIPv4(ip),false,ip);
  assert.equal(server.publicIPv4('8.8.8.8'),true);
});
test('upstream lookup uses normal resolver when public, no DNS mutation',async t=>{
  t.mock.method(dns,'lookup',(host,options,cb)=>cb(null,'8.8.8.8',4));
  const result=await new Promise((resolve,reject)=>server.officialLookup('api.gravity.place',{all:true},(err,ips)=>err?reject(err):resolve(ips)));
  assert.deepEqual(result,[{address:'8.8.8.8',family:4}]);
});
test('sink fallback is per-request/fixed-host and keeps private addresses out',async t=>{
  t.mock.method(dns,'lookup',(host,options,cb)=>cb(null,'0.0.0.0',4));
  let resolvedHost;
  t.mock.method(dns,'Resolver',function(){return {setServers(){},resolve4(host,cb){resolvedHost=host;cb(null,['127.0.0.1','8.8.8.8']);}};});
  const ip=await new Promise((resolve,reject)=>server.officialLookup('api.gravity.place',{},(err,address)=>err?reject(err):resolve(address)));
  assert.equal(ip,'8.8.8.8');assert.equal(resolvedHost,'api.gravity.place');
  await assert.rejects(new Promise((resolve,reject)=>server.officialLookup('other.invalid',{},err=>err?reject(err):resolve())));
});
test('health/status are local, redacted and accurately mark login/speaking unverified',async t=>{
  const base=await app(t);const health=await fetch(base+'/api/health');assert.equal(health.status,200);assert.equal((await health.json()).mode,'anonymous-audition');
  const status=await(await fetch(base+'/api/status')).json();assert.equal(status.data.gravity_session_established,false);assert.equal(status.data.speaking_end_to_end_verified,false);assert.equal(status.data.login_errno,1);
  const text=JSON.stringify(status);assert.ok(!text.includes('rtc_token'));assert.ok(!text.includes('@'));assert.ok(!text.includes('channel_id'));
});
test('root and legacy audition route serve the same corrected UI with no stale success claim',async t=>{
  const base=await app(t);const root=await(await fetch(base+'/')).text(),legacy=await(await fetch(base+'/audition_loop.html')).text();
  assert.equal(root,legacy);assert.match(root,/id="btnOpenMic"/);assert.ok(!root.includes('房间内其他人应能听到你'));assert.match(root,/controller.js/);
  assert.ok(!root.includes('id="roomLinkInput"'));assert.ok(!root.includes('id="listenMode"'));assert.ok(!root.includes('id="sendConsent"'));assert.ok(!root.includes('本机自检'));assert.ok(!root.includes('id="shareUrl"'));assert.ok(!root.includes('type="range"'));
  assert.match(root,/id="roomList"/);assert.match(root,/id="btnRefreshRooms"/);
  assert.match(root,/id="searchForm"/);assert.match(root,/id="searchInput"/);
  assert.ok(!root.includes('不收密码'));assert.ok(!root.includes('SDK 接受 publish'));
});
test('POST and cross-site API requests cannot create login/forwarding actions',async t=>{
  const base=await app(t);assert.equal((await fetch(base+'/api/token',{method:'POST',body:'action=register'})).status,405);
  assert.equal((await fetch(base+'/api/status',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
});
test('static path escapes are denied, code outside static is never served',async t=>{
  const base=await app(t);assert.equal((await fetch(base+'/%2e%2e%2fserve.cjs')).status,403);assert.equal((await fetch(base+'/serve.cjs')).status,404);
  const response=await fetch(base+'/controller.js');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-cache');assert.ok(response.headers.get('etag'));assert.equal(response.headers.get('x-content-type-options'),'nosniff');
});
test('resolver rejects SSRF inputs without invoking the upstream',async t=>{
  let calls=0;const base=await app(t,async()=>{calls++;throw new Error('must not call');});
  const response=await fetch(base+'/api/resolve?url='+encodeURIComponent('https://localhost/secret'));assert.equal(response.status,400);assert.equal(calls,0);
});
test('metadata failure does not destroy a valid room resolution',async t=>{
  let calls=0;const base=await app(t,async()=>{calls++;throw new Error('optional metadata unavailable');});
  const response=await fetch(base+'/api/resolve?url='+encodeURIComponent(DIRECT));assert.equal(response.status,200);assert.equal((await response.json()).data.channel_id,'1000000000000000001');assert.equal(calls,1);
});
test('token parameters are validated and proxy does not expose arbitrary upstream fields',async t=>{
  const calls=[];const base=await app(t,async options=>{calls.push(options);return {status:200,body:Buffer.from(JSON.stringify({errno:0,data:{rtc_token:'fake-test-token',user_id:12,extra:'must-not-export'}}))};});
  assert.equal((await fetch(base+'/api/token?channel_id=NaN&anchor_id=2')).status,400);assert.equal(calls.length,0);
  const result=await(await fetch(base+'/api/token?channel_id=1000000000000000001&anchor_id=2')).json();assert.deepEqual(result.data,{rtc_token:'fake-test-token',user_id:12});assert.ok(calls[0].path.includes('1000000000000000001'));assert.equal(calls[0].hostname,'api.gravity.place');
});
test('room list keeps 64-bit IDs as strings and only allowlisted public card fields',()=>{
  const rooms=server.publicRooms({room_list:[
    {channel_id:'1000000000000000001',voice_name:'Live',member_count:6,secret:'no',
      label:'Chat',tags:'one,two,three',topic:'Hello',notice:'Line',
      cover_img:'https://cdn.gravity.place/voiceroom/img/online/x.png',
      anchor_info:{user_id:2000000009,name:'Host',portrait:'https://cdn.gravity.place/virtual/portrait/x.png'}},
    {channel_id:'1000000000000000002',voice_name:'No cdn',member_count:1,
      anchor_info:{user_id:2000000009,name:'Host',portrait:'https://evil.invalid/x.png'}},
    {channel_id:1000000000000000001,voice_name:'Numeric channel',anchor_info:{user_id:2,name:'x'}},
    {channel_id:'1',voice_name:'No host'},{channel_id:'not-id',anchor_info:{user_id:3}},
  ],secret:'no'});
  assert.deepEqual(rooms,[{
    channel_id:'1000000000000000001',anchor_id:'2000000009',title:'Live',anchor_name:'Host',count:6,
    label:'Chat',tags:['one','two','three'],topic:'Hello',notice:'Line',
    portrait:'https://cdn.gravity.place/virtual/portrait/x.png',
    cover:'https://cdn.gravity.place/voiceroom/img/online/x.png',
  },{channel_id:'1000000000000000002',anchor_id:'2000000009',title:'No cdn',anchor_name:'Host',count:1}]);
});
test('official CDN images keep https cdn.gravity.place paths only',()=>{
  assert.equal(server.officialCdnImage('https://cdn.gravity.place/virtual/portrait/x.png'),'https://cdn.gravity.place/virtual/portrait/x.png');
  assert.equal(server.officialCdnImage('https://cdn.gravity.place/virtual/portrait/x.png?x=1'),'https://cdn.gravity.place/virtual/portrait/x.png');
  assert.equal(server.officialCdnImage('https://cdn.gravity.place/chat.gif'),'https://cdn.gravity.place/chat.gif');
  for(const url of ['https://evil.invalid/x.png','http://cdn.gravity.place/x.png','https://user@cdn.gravity.place/x.png','javascript:alert(1)']){
    assert.equal(server.officialCdnImage(url),'');
  }
});
test('search validates keyword and uses injected signed search without upstream',async t=>{
  const calls=[];const base=await app(t,async options=>{calls.push(options);throw new Error('must not call');});
  assert.equal((await fetch(base+'/api/search')).status,400);
  const mockSearch=async(extra,request,options)=>{calls.push({extra,options});return {errno:0,data:{room_list:[{channel_id:'1000000000000000001',voice_name:'Hit',member_count:3,anchor_info:{user_id:2000000009,name:'Host'}}]}};};
  const s=http.createServer(server.makeHandler({signedSearch:mockSearch,request:async()=>{calls.push('upstream');throw new Error('no');}}));
  await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));
  const url=`http://127.0.0.1:${s.address().port}`;
  const result=await(await fetch(url+'/api/search?keyword=live&limit=5')).json();
  assert.equal(result.errno,0);assert.equal(result.data.rooms[0].title,'Hit');
  assert.equal(calls.filter(c=>c==='upstream').length,0);
});
test('search falls back to hot-room filter when signing fails',async t=>{
  const failSearch=async()=>({errno:-4,errmsg:'sign check failed'});
  const fallback=async(extra,request,publicRooms)=>({errno:0,data:{rooms:publicRooms({room_list:[{channel_id:'1000000000000000001',voice_name:'Live',member_count:1,anchor_info:{user_id:2000000009,name:'Host'}}]}),keyword:extra.keyword,mode:'hot_filter'}});
  const s=http.createServer(server.makeHandler({signedSearch:failSearch,searchFallback:fallback,request:async()=>({status:200,body:Buffer.from('{}')})}));
  await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));
  const res=await fetch(`http://127.0.0.1:${s.address().port}/api/search?keyword=live`);
  assert.equal(res.status,200);
  const body=await res.json();
  assert.equal(body.data.mode,'hot_filter');
  assert.equal(body.data.rooms[0].title,'Live');
});
test('room list proxy only calls the official hot-room path and never forwards secrets or off-cdn images',async t=>{
  const calls=[];const base=await app(t,async options=>{calls.push(options);return {status:200,body:Buffer.from(JSON.stringify({errno:0,data:{
    room_list:[{channel_id:'1000000000000000001',voice_name:'Live',member_count:6,anchor_info:{user_id:2000000009,name:'Host',portrait:'https://evil.invalid/x.png'}}],
    secret:'must-not-export'}}))};});
  const result=await(await fetch(base+'/api/rooms')).json();
  assert.equal(calls[0].hostname,'api.gravity.place');
  assert.equal(calls[0].path,'/gravity/voice/getHotRoomOrPlan?ddd=3');
  assert.deepEqual(result.data.rooms,[{channel_id:'1000000000000000001',anchor_id:'2000000009',title:'Live',anchor_name:'Host',count:6}]);
  const text=JSON.stringify(result);assert.ok(!text.includes('secret'));assert.ok(!text.includes('portrait'));assert.ok(!text.includes('evil.invalid'));
});
test('unknown exceptions never echo request URLs/upstream bodies/secrets',async t=>{
  const base=await app(t,async()=>{throw new Error('fake-secret-value https://example.invalid/?code=fake');});
  const text=await(await fetch(base+'/api/token?channel_id=1&anchor_id=2')).text();assert.ok(!text.includes('fake-secret'));assert.ok(!text.includes('example.invalid'));
});

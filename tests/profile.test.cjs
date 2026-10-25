'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createProfileService,publicProfile}=require('../gravity-profile.cjs');
const {createVoiceApi}=require('../gravity-api.cjs');
const {checkRequest}=require('../gravity-upstream.cjs');
const row=id=>({id:'post-'+id,user:{user_id:id,name:'User'},desc:'<img src=x>',title:'Title',time:123,attaches:[],allow_comment:1});
function setup(extra={}){let who={user:'7',identity:'one'},anchor='9',fail=false,hidden=false,gate=null;
 const reads=[],writes=[];
 const service=createProfileService({...extra,identity:()=>who,read:async(kind,extra,request,options)=>{
  reads.push({kind,extra,options});if(gate)await gate;
  if(kind==='userDetail')return {errno:0,data:{user_id:extra.target_id,name:'<img>',profile:'Bio',portrait:'https://cdn.gravity.place/a.png',birthdate:20000101,encrypt_email:'secret',should_hidden:hidden?1:0,ext:{fans:3,follow:4,friends:5}}};
  if(kind==='roomInfo')return {errno:0,data:{room_info:{channel_id:extra.channel_id,user_id:anchor}}};
  return {errno:0,data:{list:[{type:'r_feed',content_feed:row(extra.target_id)},{type:'r_feed',content_feed:row('111')},{type:'recommendation',content_feed:row(extra.target_id)}],last_id:'next'}};
 },write:async(extra,request,options)=>{writes.push({extra,options});if(fail)throw Error('timeout');return {errno:0};}});
 return {service,reads,writes,change:v=>who=v,host:v=>anchor=v,fail:v=>fail=v,hidden:v=>hidden=v,gate:v=>gate=v};
}
const body=extra=>({channel_id:'123',expected_anchor_id:'9',confirmed:true,request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',...extra});
test('profile exposes public card and bio, never birthday, login or credential metadata',async()=>{
 const f=setup(),p=await f.service.person('9');assert.equal(p.bio,'Bio');assert.equal(p.user_id,'9');assert.deepEqual(p.counts,{fans:3,following:4,friends:5});
 assert.equal(JSON.stringify(p).includes('secret'),false);assert.equal('birthdate' in p,false);assert.equal(publicProfile({user_id:9007199254740994}),null);
 assert.equal(publicProfile({user_id:'1000001101'}),null);assert.equal(publicProfile({user_id:'9',portrait:'https://evil.invalid/a.png'}).portrait,'');
 assert.equal(publicProfile({user_id:'9',user_country:'organic'}).country,'');
 assert.equal(publicProfile({user_id:'9',user_country:'jp'}).country,'JP');
});
test('personal posts retain only official feed wrappers authored by selected person and preserve native paging count',async()=>{
 const f=setup(),r=await f.service.posts('9','','0');assert.equal(r.posts.length,1);assert.equal(r.posts[0].author.user_id,'9');assert.equal(r.next_cursor,'next');assert.equal(r.loaded_count,3);
 assert.ok(f.reads.every(x=>x.options.expectedIdentity==='one'));assert.deepEqual(f.reads.at(-1).extra,{target_id:'9',last_id:'',accumulated_feed_cnt:'0'});
});
test('invalid and hidden profiles do not read personal feeds or mutate relationships',async()=>{
 const f=setup();for(const p of ['bad','1000001101'])await assert.rejects(f.service.person(p));
 for(const [cursor,loaded]of [['?evil','0'],['','abc'],['','10001']])await assert.rejects(f.service.posts('9',cursor,loaded));
 f.hidden(true);await assert.rejects(f.service.posts('9'),e=>e.status===403);assert.ok(!f.reads.some(x=>x.kind==='personalFeed'));assert.equal(f.writes.length,0);
});
test('account change during profile fetch never returns or caches old-account data',async()=>{
 const f=setup();let release;f.gate(new Promise(r=>release=r));const pending=f.service.person('9');f.change({user:'8',identity:'two'});release();
 await assert.rejects(pending,e=>e.status===409);f.gate(null);await f.service.person('9');assert.equal(f.reads.length,2);
});
test('viewing profiles never blocks; blocking requires confirmation and bound current host',async()=>{
 const f=setup();await f.service.person('9');await f.service.posts('9');assert.equal(f.writes.length,0);
 for(const patch of [{confirmed:false},{channel_id:'bad'},{expected_anchor_id:'bad'},{target_user_id:'99'},{request_id:'-'.repeat(36)}])assert.throws(()=>f.service.blockHost(body(patch)));
 const r=await f.service.blockHost(body());assert.equal(r.blocked,true);assert.deepEqual(f.writes,[{extra:{target_user_id:'9',action:'block'},options:{expectedIdentity:'one'}}]);
});
test('host mismatch, self, official and changed account are refused before mutating GET',async()=>{
 for(const anchor of ['10','7','1000001101']){
  const f=setup();f.host(anchor);await assert.rejects(f.service.blockHost(body({expected_anchor_id:anchor==='10'?'9':anchor})));assert.equal(f.writes.length,0);
 }
 const f=setup(),pending=f.service.blockHost(body());f.change({user:'8',identity:'two'});await assert.rejects(pending);assert.equal(f.writes.length,0);
});
test('same block submission is deduplicated and cannot be reused for another host',async()=>{
 const f=setup(),a=f.service.blockHost(body()),b=f.service.blockHost(body());assert.equal(a,b);await a;await f.service.blockHost(body());assert.equal(f.writes.length,1);
 assert.throws(()=>f.service.blockHost(body({expected_anchor_id:'10'})),e=>e.status===409);
});
test('unknown native block result is retained, never blindly submitted twice',async()=>{
 const f=setup();f.fail(true);await assert.rejects(f.service.blockHost(body()),e=>e.status===504);f.fail(false);
 await assert.rejects(f.service.blockHost(body()),e=>e.status===504);assert.equal(f.writes.length,1);
});
test('mutating GET allowlist refuses unmarked block, POST, crossed directions and spoofed markers',()=>{
 const base={hostname:'api.gravity.place',path:'/gravity/relation/black?target_user_id=9&action=block',mutation:'block-user'};
 assert.equal(checkRequest(base).method,'GET');
 for(const patch of [{mutation:undefined},{method:'POST',body:'x'},{path:'/gravity/relation/black?target_user_id=9&action=unblock'},{path:'/gravity/relation/black?target_user_id=9&action=block&action=unblock'},{mutation:'receive-lucky-box'},{path:'/gravity/user/detail?target_id=9'}])assert.throws(()=>checkRequest({...base,...patch}));
 const box={hostname:'api.gravity.place',path:'/gravity/voice/receiveLuckyBox?anchor_id=9&lucky_box_id=88&issue_user_id=9',mutation:'receive-lucky-box'};
 assert.equal(checkRequest(box).method,'GET');
 for(const patch of [{mutation:undefined},{path:'/gravity/voice/receiveLuckyBox?anchor_id=9&lucky_box_id=88'}])assert.throws(()=>checkRequest({...box,...patch}));
 const collect={hostname:'api.gravity.place',path:'/gravity/feed/collect?id=post-1&action=collect',mutation:'feed-collect'};
 assert.equal(checkRequest(collect).method,'GET');
 for(const patch of [{mutation:undefined},{path:'/gravity/feed/collect?id=post-1&action=like'},{path:'/gravity/feed/collect?id=../x&action=collect'}])assert.throws(()=>checkRequest({...collect,...patch}));
 assert.equal(checkRequest({hostname:'api.gravity.place',path:'/gravity/voice/createRoomV2',method:'POST',body:'name=x&label_id=2'}).method,'POST');
 assert.equal(checkRequest({hostname:'api.gravity.place',path:'/gravity/voice/updateRoom',method:'POST',body:'channel_id=1&tags=a'}).method,'POST');
 assert.throws(()=>checkRequest({hostname:'api.gravity.place',path:'/gravity/voice/updateRoom',method:'POST'}));
 // Unblock has its own marker and only works with action=unblock; the old image upload door is gone.
 const unblock={hostname:'api.gravity.place',path:'/gravity/relation/black?target_user_id=9&action=unblock',mutation:'unblock-user'};
 assert.equal(checkRequest(unblock).method,'GET');
 for(const patch of [{mutation:undefined},{mutation:'block-user'},{path:'/gravity/relation/black?target_user_id=9&action=block'},{path:'/gravity/relation/black?target_user_id=x&action=unblock'}])assert.throws(()=>checkRequest({...unblock,...patch}));
 assert.throws(()=>checkRequest({hostname:'api.gravity.place',path:'/gravity/common/newUploadV2',method:'POST',body:Buffer.alloc(64),mutation:'voice-image-upload',contentType:'multipart/form-data; boundary=----GravityUpload0123456789ab'}));
 // Follow is the encrypted POST the App uses; a plain form body is refused.
 const follow={hostname:'api.gravity.place',path:'/gravity/relation/followEncrypt',method:'POST',body:'QUJD',contentType:'application/raw; charset=utf-8'};
 assert.equal(checkRequest(follow).encrypted,true);
 for(const patch of [{contentType:undefined},{body:'a=b&c=d'},{method:'GET'}])assert.throws(()=>checkRequest({...follow,...patch}));
 for(const path of ['/gravity/point/pointAwardReceiveV2Encrypt','/gravity/point/signAwardReceiveEncrypt','/gravity/point/finishedADEncryptV2','/gravity/limitRelation/lottery']){
  const ok={hostname:'api.gravity.place',path,method:'POST',body:'QUJD',contentType:'application/raw; charset=utf-8'};
  assert.equal(checkRequest(ok).encrypted,true);
  assert.throws(()=>checkRequest({...ok,body:'id=7'}));
 }
});
test('follow/unfollow are signed encrypted POSTs to followEncrypt, bound to the expected account',async()=>{
 const crypto=require('node:crypto'),v=createVoiceApi({tokenLoader:()=>'TOKEN',deviceLoader:()=>({idfa:'device',uwd:'uwd'}),stateFile:'/dev/null/no-state'}),calls=[];
 const request=async options=>{calls.push(options);return {status:200,body:Buffer.from('{"errno":0,"data":{"relation_type":3}}')};};
 const identity=require('../gravity-api.cjs').sessionIdentity('TOKEN');
 assert.throws(()=>v.writeFollow({action:'follow',user_id_b:'bad'},request));assert.throws(()=>v.writeFollow({action:'remove',user_id_b:'9'},request));
 assert.throws(()=>v.writeFollow({action:'follow',user_id_b:'9',extra:'x'},request));
 for(const action of ['follow','unfollow']){
  const r=await v.writeFollow({action,user_id_b:'9'},request,{expectedIdentity:identity});assert.equal(r.errno,0);
  const call=calls.at(-1);assert.equal(call.path,'/gravity/relation/followEncrypt');assert.equal(call.method,'POST');assert.equal(call.contentType,'application/raw; charset=utf-8');
  assert.match(call.body,/^[A-Za-z0-9+/]+={0,2}$/);assert.ok(!call.body.includes('user_id_b'));
 }
 const before=calls.length;await v.writeFollow({action:'follow',user_id_b:'9'},request,{expectedIdentity:'other'});assert.equal(calls.length,before);
});
test('unblock goes through the same guarded GET with its own marker',async()=>{
 const v=createVoiceApi({tokenLoader:()=>'TOKEN',deviceLoader:()=>({idfa:'device',uwd:'uwd'}),stateFile:'/dev/null/no-state'}),calls=[];
 const request=async options=>{calls.push(options);return {status:200,body:Buffer.from('{"errno":0,"data":1}')};};
 await v.writeProfileBlock({target_user_id:'9',action:'unblock'},request);
 assert.equal(calls[0].mutation,'unblock-user');assert.equal(new URL(calls[0].path,'https://api.gravity.place').searchParams.get('action'),'unblock');
 assert.throws(()=>v.writeProfileBlock({target_user_id:'9',action:'remove'},request));
 for(const kind of ['fans','blacklist','userList'])await v.readSignedVoice(kind,{},request);
 assert.deepEqual(calls.slice(1).map(c=>new URL(c.path,'https://api.gravity.place').pathname),['/gravity/relation/fansList','/gravity/relation/blackList','/gravity/user/userListInfo']);
 assert.ok(calls.slice(1).every(c=>c.mutation===undefined&&c.method===undefined));
});
test('native block uses signed GET action=block, remains outside read API and enforces expected account',async()=>{
 const v=createVoiceApi({tokenLoader:()=> 'TOKEN',deviceLoader:()=>({idfa:'device',uwd:'uwd'}),stateFile:'/dev/null/no-state'}),calls=[];
 const request=async options=>{calls.push(options);return {status:200,body:Buffer.from('{"errno":0,"data":1}')};};
 await assert.rejects(v.readSignedVoice('blockUser',{},request));assert.throws(()=>v.writeProfileBlock({target_user_id:'9',action:'mute'},request));
 await v.writeProfileBlock({target_user_id:'9',action:'block'},request,{expectedIdentity:require('../gravity-api.cjs').sessionIdentity('TOKEN')});
 assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.equal(calls[0].mutation,'block-user');const url=new URL(calls[0].path,'https://api.gravity.place');
 assert.equal(url.pathname,'/gravity/relation/black');assert.equal(url.searchParams.get('target_user_id'),'9');assert.equal(url.searchParams.get('action'),'block');assert.ok(/^[a-f0-9]{32}$/.test(url.searchParams.get('sign')));assert.ok(url.searchParams.has('ts'));assert.equal(url.searchParams.has('api_security'),false);
 await v.writeProfileBlock({target_user_id:'9',action:'block'},request,{expectedIdentity:'other'});assert.equal(calls.length,1);
});
test('profile overlay block confirms a chosen ordinary user without inventing a room host',async()=>{
 const f=setup(),id='bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
 for(const patch of [{confirmed:false},{target_user_id:'bad'},{target_user_id:'7'},{request_id:'nope'}])assert.throws(()=>f.service.blockUser({target_user_id:'9',confirmed:true,request_id:id,...patch}));
 const r=await f.service.blockUser({target_user_id:'11',confirmed:true,request_id:id});
 assert.equal(r.blocked,true);assert.equal(r.user_id,'11');
});

test('a successful block is reported (so the person is muted too); a failed one is not; room and relation rows are passed on',async()=>{
 const blocked=[],people=[],f=setup({onBlocked:id=>blocked.push(id),onPeople:rows=>people.push(...rows)}),id='dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee';
 await f.service.person('9');assert.deepEqual(people,[{user_id:'9',relation:undefined,name:'<img>'}]);
 await f.service.blockUser({target_user_id:'11',confirmed:true,request_id:id});assert.deepEqual(blocked,['11']);
 await f.service.blockHost(body({request_id:'eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee'}));assert.deepEqual(blocked,['11','9']);
 f.fail(true);await assert.rejects(f.service.blockUser({target_user_id:'12',confirmed:true,request_id:'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'}));assert.deepEqual(blocked,['11','9']);
});
test('mute (shield) is a guarded GET with its own marker and can only ever mute',async()=>{
 const base={hostname:'api.gravity.place',path:'/gravity/relation/shield?target_user_id=9&action=shield',mutation:'shield-user'};
 assert.equal(checkRequest(base).method,'GET');
 for(const patch of [{mutation:undefined},{mutation:'block-user'},{path:'/gravity/relation/shield?target_user_id=9&action=unshield'},{path:'/gravity/relation/shield?target_user_id=x&action=shield'},{path:'/gravity/relation/shield?target_user_id=9&action=shield&action=unshield'},{method:'POST',body:'x'}])assert.throws(()=>checkRequest({...base,...patch}));
 assert.throws(()=>checkRequest({...base,path:'/gravity/relation/black?target_user_id=9&action=shield'}));
 const v=createVoiceApi({tokenLoader:()=>'TOKEN',deviceLoader:()=>({idfa:'device',uwd:'uwd'}),stateFile:'/dev/null/no-state'}),calls=[];
 const request=async options=>{calls.push(options);return {status:200,body:Buffer.from('{"errno":0,"data":1}')};};
 const identity=require('../gravity-api.cjs').sessionIdentity('TOKEN');
 assert.equal((await v.writeShield({target_user_id:'9',action:'shield'},request,{expectedIdentity:identity})).errno,0);
 assert.equal(calls[0].mutation,'shield-user');assert.equal(new URL(calls[0].path,'https://api.gravity.place').pathname,'/gravity/relation/shield');
 for(const bad of [{target_user_id:'9',action:'unshield'},{target_user_id:'x',action:'shield'},{target_user_id:'9',action:'shield',extra:1}])assert.throws(()=>v.writeShield(bad,request));
 await assert.rejects(v.readSignedVoice('shieldUser',{},request));
 await v.readSignedVoice('shieldList',{},request);assert.equal(new URL(calls.at(-1).path,'https://api.gravity.place').pathname,'/gravity/relation/shieldList');assert.equal(calls.at(-1).mutation,undefined);
});
test('anyone’s following/fans pages project safe people with paging', async () => {
  const rows = [
    {user_id: '20', name: 'Friend', portrait: 'https://cdn.gravity.place/f.png', user_country: 'tw', ext: {online_status: 1}},
    {user_id: '1000001101'},
    {user_id: '7', name: 'Self'},
  ];
  const calls = [];
  const f = setup({
    readRelation: async (kind, extra) => {
      calls.push([kind, extra]);
      if (extra.target_id === '404') return {errno: 40001};
      return {errno: 0, data: {list: rows, last_id: 'next'}};
    },
  });
  for (const kind of ['following', 'fans']) {
    const r = await f.service.relationList(kind, '9', '');
    assert.equal(r.people.length, 1);
    assert.deepEqual(r.people[0], {user_id: '20', name: 'Friend', portrait: 'https://cdn.gravity.place/f.png', country: 'TW', online: true});
    assert.equal(r.next_cursor, 'next');
  }
  assert.deepEqual(calls[0], ['following', {target_id: '9'}]);
  const paged = await f.service.relationList('following', '9', 'next');
  assert.deepEqual(calls.at(-1), ['following', {target_id: '9', last_id: 'next'}]);
  await assert.rejects(f.service.relationList('following', '9', '?evil'));
  await assert.rejects(f.service.relationList('followers', '9', ''));
  await assert.rejects(f.service.relationList('following', 'bad', ''));
  await assert.rejects(f.service.relationList('following', '404', ''));
});
test('anyone’s gift wall projects receive/send items with tolerant statistics', async () => {
  const calls = [];
  const f = setup({
    readGifts: async extra => {
      calls.push(extra);
      return {errno: 0, data: {list: [{id: 5, name: 'Rose', preview_url: 'https://cdn.gravity.place/r.png', price: 10}, {id: 0}], last_id: '', statistic: {coins: 100, points: 200, total_gift_kind: 3}}};
    },
  });
  for (const listType of ['receive', 'send']) {
    const r = await f.service.gifts('9', listType);
    assert.equal(r.items.length, 1);
    assert.deepEqual(r.items[0], {id: '5', name: 'Rose', image: 'https://cdn.gravity.place/r.png', price: 10});
    assert.deepEqual(r.statistic, {coins: 100, points: 200, total_gift_kind: 3});
  }
  assert.deepEqual(calls[0], {list_type: 'receive', target_id: '9'});
  await assert.rejects(f.service.gifts('9', 'all'));
  await assert.rejects(f.service.gifts('bad', 'receive'));
});
test('relation/gift read helpers reject malformed fields before signing', () => {
  const {createVoiceApi} = require('../gravity-api.cjs');
  const api = createVoiceApi({tokenLoader: () => 't', deviceLoader: () => ({idfa: 'i', uwd: 'u'}), stateFile: '/no-state'});
  const noop = () => { throw Error('no network'); };
  assert.throws(() => api.readRelationList('friends', {}, noop), /unsupported_relation_list/);
  assert.throws(() => api.readRelationList('following', {target_id: 'bad'}, noop), /unsupported_relation_list/);
  assert.throws(() => api.readRelationList('fans', {last_id: '?x'}, noop), /unsupported_relation_list/);
  assert.throws(() => api.readGiftRecords({list_type: 'all'}, noop), /unsupported_gift_records/);
  assert.throws(() => api.readGiftRecords({list_type: 'receive', target_id: 'x'}, noop), /unsupported_gift_records/);
  assert.throws(() => api.readRoomPreview({channel_id: '0'}, noop), /unsupported_room_preview/);
  assert.throws(() => api.readRoomPreview({channel_id: '123', extra: 1}, noop), /unsupported_room_preview/);
});
test('footprints project visitors with counts and pipe cursors', async () => {
  const calls = [];
  const f = setup({
    readFoot: async extra => {
      calls.push(extra);
      return {errno: 0, data: {list: [
        {visit_count: 3, last_visit_time: 1791639179, user: {user_id: 2000000005, name: 'Visitor', portrait: 'https://cdn.gravity.place/v.png'}},
        {visit_count: 0, user: {user_id: 'bad'}},
      ], last_id: '1|2|3'}};
    },
  });
  const r = await f.service.footprints(0, '');
  assert.equal(r.visitors.length, 1);
  assert.equal(r.visitors[0].user_id, '2000000005');
  assert.equal(r.visitors[0].visits, 3);
  assert.match(r.visitors[0].last_visit, /\d/);
  assert.equal(r.next_cursor, '1|2|3');
  assert.deepEqual(calls[0], {tab_type: 0});
  await f.service.footprints(1, '1|2|3');
  assert.deepEqual(calls[1], {tab_type: 1, last_id: '1|2|3'});
  await assert.rejects(f.service.footprints(2, ''));
  await assert.rejects(f.service.footprints(0, '?evil'));
});

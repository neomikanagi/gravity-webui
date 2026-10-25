'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createRelationService}=require('../gravity-relation.cjs');
const ME={user:'1',identity:'id-1'};
const row=(id,relation,name='P'+id)=>({user_id:Number(id),name,ext:{relation}});
function setup(options={}){
 let clock=1900000000000,saved=options.saved||null,who=ME;
 const lists={fans:options.fans||[],following:options.following||[],blacklist:options.blacklist||[],shieldList:options.shieldList||[]},details=options.details||{},calls=[],writes=[],logs=[];
 const failing=new Set(options.failing||[]);
 const page=(rows,last)=>{const start=last?rows.findIndex(r=>String(r.user_id)===last)+1:0,part=rows.slice(start,start+2);return {list:part,last_id:part.length?String(part.at(-1).user_id):'0'};};
 const read=async(kind,extra,request,authority)=>{calls.push({kind,extra,authority});
  if(kind in lists){if(options.listError)return {errno:40026};return {errno:0,data:page(lists[kind],extra.last_id)};}
  if(kind==='userDetail'){const d=details[extra.target_id];return d===undefined?{errno:-6}:{errno:0,data:{user_id:Number(extra.target_id),name:'D'+extra.target_id,ext:{relation:d}}};}
  throw Error('unexpected read '+kind);};
 const write=(label)=>async(extra)=>{const key=label+':'+(extra.user_id_b||extra.target_user_id);writes.push({label,...extra});
  if(label==='shield'&&!failing.has(key)&&!lists.shieldList.some(r=>String(r.user_id)===extra.target_user_id))lists.shieldList.push(row(extra.target_user_id,3));
  return {errno:failing.has(key)?-1:0,data:{relation_type:3}};};
 const service=createRelationService({read,follow:write('follow'),block:write('block'),shield:write('shield'),identity:()=>who,request:()=>{throw Error('no network');},now:()=>clock,
  store:{load:()=>saved,save:v=>{saved=JSON.parse(JSON.stringify(v));}},sleep:async()=>{},timers:{setTimeout:()=>1,clearTimeout(){}},log:m=>logs.push(m),enabled:options.enabled!==false});
 return {service,lists,details,calls,writes,logs,failing,advance:ms=>{clock+=ms;},setWho:v=>{who=v;},saved:()=>saved};
}
const actions=f=>f.writes.filter(w=>w.label!=='shield').map(w=>[w.label,w.action,w.user_id_b||w.target_user_id]);
test('the first sweep only learns the baseline: nobody already around is followed or unfollowed',async()=>{
 const f=setup({fans:[row(11,3),row(12,2)],following:[row(11,3),row(13,1)]});
 assert.equal(await f.service.tick(),true);assert.deepEqual(f.writes,[]);
 const s=f.service.status();assert.equal(s.ready,true);assert.equal(s.followers,2);assert.equal(s.following,2);
 assert.deepEqual(f.saved().followers.sort(),['11','12']);
 await f.service.tick();await f.service.tick();assert.deepEqual(f.writes,[],'12 follows us and we chose not to follow back: left alone');
});
test('someone who newly follows us is followed back once',async()=>{
 const f=setup({fans:[row(11,3)],following:[row(11,3)]});await f.service.tick();
 f.lists.fans=[row(20,2,'Newbie'),row(11,3)];await f.service.tick();
 assert.deepEqual(actions(f),[['follow','follow','20']]);assert.equal(f.service.status().recent[0].name,'Newbie');
 f.lists.fans=[row(20,3),row(11,3)];f.lists.following=[row(20,3),row(11,3)];await f.service.tick();await f.service.tick();
 assert.equal(f.writes.length,1,'no repeat once the relation is mutual');
});
test('someone who stops following us is unfollowed, but a person we follow who never followed us is not',async()=>{
 const f=setup({fans:[row(11,3),row(12,3)],following:[row(11,3),row(12,3),row(13,1)]});await f.service.tick();
 f.lists.fans=[row(12,3)];f.lists.following=[row(11,1),row(12,3),row(13,1)];
 await f.service.tick();await f.service.tick();await f.service.tick();
 assert.deepEqual(actions(f),[['follow','unfollow','11']]);
 assert.equal(f.service.status().following,2);
});
test('someone who blocks us is blocked back, in lists, rooms and profiles; ours and unknown states are left alone',async()=>{
 const f=setup({fans:[row(11,3)],following:[row(11,3),row(14,9)]});await f.service.tick();
 assert.deepEqual(actions(f),[['block','block','14']]);
 f.service.observe([{user_id:'21',relation:8,name:'Room'},{user_id:'22',relation:12},{user_id:'23',relation:72},{user_id:'1',relation:8},{user_id:'1000000000',relation:8},{user_id:'24',relation:null},{user_id:'x',relation:8}]);
 await f.service.tick();
 assert.deepEqual(actions(f),[['block','block','14'],['block','block','21']]);
});
test('a follower who vanished from both lists is looked up; a block is mirrored, an unreadable profile is ignored',async()=>{
 const f=setup({fans:[row(11,3),row(15,3),row(16,3)],following:[row(11,3),row(15,3),row(16,3)],details:{15:8,16:0}});await f.service.tick();
 f.lists.fans=[row(11,3)];f.lists.following=[row(11,3)];f.details[17]=undefined;
 await f.service.tick();await f.service.tick();await f.service.tick();
 assert.deepEqual(actions(f),[['block','block','15']]);
 assert.ok(f.calls.some(c=>c.kind==='userDetail'&&c.extra.target_id==='16'));
});
test('a block this service made is lifted when they lift theirs, and only those',async()=>{
 const f=setup({fans:[row(15,3)],following:[row(15,3)],details:{15:8}});await f.service.tick();
 f.lists.fans=[];f.lists.following=[];await f.service.tick();await f.service.tick();await f.service.tick();
 assert.deepEqual(actions(f),[['block','block','15']]);
 f.details[15]=12;for(let i=0;i<3;i++)await f.service.tick();assert.equal(actions(f).length,1,'still blocked by them');
 f.details[15]=4;for(let i=0;i<3;i++)await f.service.tick();
 assert.deepEqual(actions(f).at(-1),['block','unblock','15']);
 f.details[15]=0;for(let i=0;i<3;i++)await f.service.tick();assert.equal(actions(f).length,2,'once undone it is not touched again');
 const manual=setup({fans:[row(30,3)],following:[row(30,3)]});await manual.service.tick();
 manual.service.observe([{user_id:'31',relation:4}]);await manual.service.tick();assert.deepEqual(actions(manual),[],'blocks the user made by hand are never auto-lifted');assert.deepEqual(manual.writes.map(w=>w.label+':'+w.target_user_id),['shield:31'],'but they are muted');
});
test('failed actions back off, then retry; three failures wait an hour',async()=>{
 const f=setup({fans:[row(11,3)],following:[row(11,3)],failing:['follow:20']});await f.service.tick();
 f.lists.fans=[row(20,2),row(11,3)];await f.service.tick();assert.equal(f.writes.length,1);assert.equal(f.service.status().recent[0].ok,false);
 await f.service.tick();assert.equal(f.writes.length,1,'inside the back-off');
 f.advance(121000);await f.service.tick();assert.equal(f.writes.length,2);
 f.advance(121000);await f.service.tick();assert.equal(f.writes.length,3);
 f.advance(121000);await f.service.tick();assert.equal(f.writes.length,3,'third failure: an hour');
 f.failing.clear();f.advance(3600000);await f.service.tick();assert.equal(f.writes.length,4);assert.equal(f.service.status().recent[0].ok,true);
});
test('writes per day are capped and per-tick bursts are bounded',async()=>{
 const f=setup({fans:[],following:[]});await f.service.tick();
 f.service.observe(Array.from({length:30},(_,i)=>({user_id:String(100+i),relation:8})));await f.service.tick();
 assert.equal(f.writes.length,8);await f.service.tick();assert.equal(f.writes.length,16);
});
test('changing the official account starts over, a dead session stops quietly, and the switch turns everything off',async()=>{
 const f=setup({fans:[row(11,3)],following:[row(11,3)]});await f.service.tick();assert.equal(f.service.status().ready,true);
 f.setWho({user:'2',identity:'id-2'});assert.equal(f.service.status().ready,false);assert.equal(f.service.status().followers,0);
 const dead=setup({listError:true,fans:[row(11,3)]});assert.equal(await dead.service.tick(),false);assert.deepEqual(dead.writes,[]);
 const off=setup({enabled:false,fans:[row(11,3)]});assert.equal(await off.service.tick(),false);assert.equal(off.calls.length,0);off.service.observe([{user_id:'5',relation:8}]);assert.equal(off.service.status().pending,0);
});
test('writes are bound to the account that was read, and only fixed user ids are sent',async()=>{
 const f=setup({fans:[row(11,3)],following:[row(11,3)]});await f.service.tick();f.service.observe([{user_id:'21',relation:8}]);
 await f.service.tick();
 assert.ok(f.calls.filter(c=>c.authority).every(c=>c.authority.expectedIdentity==='id-1'));
 assert.deepEqual(Object.keys(f.writes[0]).sort(),['action','label','target_user_id']);
});
test('the status route is read-only, same-site only, and shows what the aligner did',async()=>{
 const http=require('node:http'),{makeHandler}=require('../serve.cjs');
 const f=setup({fans:[row(11,3)],following:[row(11,3)]});await f.service.tick();f.lists.fans=[row(20,2,'Newbie'),row(11,3)];await f.service.tick();
 const server=http.createServer(makeHandler({relation:f.service}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const base='http://127.0.0.1:'+server.address().port;
  const ok=await fetch(base+'/api/relation/status');const body=await ok.json();assert.equal(ok.status,200);
  assert.equal(body.data.enabled,true);assert.equal(body.data.recent[0].action,'follow');assert.equal(body.data.recent[0].name,'Newbie');assert.ok(!JSON.stringify(body).includes('token'));
  const cross=await fetch(base+'/api/relation/status',{headers:{'Sec-Fetch-Site':'cross-site'}});assert.equal(cross.status,403);
  const post=await fetch(base+'/api/relation/status',{method:'POST'});assert.equal(post.status,405);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

const mutes=f=>f.writes.filter(w=>w.label==='shield').map(w=>w.target_user_id);
test('everyone we block is put on the official mute list, in batches, and stays there',async()=>{
 const f=setup({blacklist:[row(40,4),row(41,4),row(42,12)],shieldList:[row(41,3)]});
 await f.service.tick();
 assert.deepEqual(mutes(f),['40','42']);assert.ok(f.writes.filter(w=>w.label==='shield').every(w=>w.action==='shield'));
 const s=f.service.status();assert.equal(s.blocked,3);assert.equal(s.muted,3);assert.equal(f.service.blockedIds().sort().join(),'40,41,42');
 f.advance(1000);for(let i=0;i<4;i++)await f.service.tick();assert.equal(mutes(f).length,2,'already muted: nothing to repeat');
});
test('a mute someone removes by hand is put back on the next sweep',async()=>{
 const f=setup({blacklist:[row(40,4)],shieldList:[row(40,3)]});await f.service.tick();assert.deepEqual(mutes(f),[]);
 f.lists.shieldList=[];for(let i=0;i<3;i++)await f.service.tick();assert.deepEqual(mutes(f),['40']);
});
test('a block made anywhere else is silenced at once and muted soon; the mute list failing to load changes nothing',async()=>{
 const f=setup({fans:[row(11,3)],following:[row(11,3)]});await f.service.tick();
 f.service.noteBlocked('50');f.service.noteBlocked('1');f.service.noteBlocked('1000000000');f.service.noteBlocked('x');
 assert.deepEqual(f.service.blockedIds(),['50']);await f.service.tick();assert.deepEqual(mutes(f),['50']);
 const saved=f.saved();assert.deepEqual(saved.blocked,['50']);
});
test('a person flagged as blocked in a room list is muted the moment they show up, once',async()=>{
 const f=setup({blacklist:[row(40,4)],shieldList:[row(40,3)]});await f.service.tick();
 f.service.observe([{user_id:'60',relation:4,name:'Loud'},{user_id:'40',relation:4},{user_id:'61',relation:68},{user_id:'62',relation:3}]);
 assert.ok(f.service.blockedIds().includes('60'));await f.service.tick();
 assert.deepEqual(mutes(f).sort(),['60','61']);assert.equal(f.service.status().recent.find(r=>r.action==='mute')?.name!==undefined,true);
});
test('mutes that keep failing back off for a day instead of eating the daily write budget',async()=>{
 const f=setup({blacklist:[row(40,4)],failing:['shield:40']});
 const round=async()=>{f.advance(121000);for(let i=0;i<3;i++)await f.service.tick();};
 for(let i=0;i<3;i++)await round();
 const tries=mutes(f).length;assert.equal(tries,3);
 f.advance(2*3600000);for(let i=0;i<3;i++)await f.service.tick();assert.equal(mutes(f).length,tries,'a day-long back-off after repeated refusals');
 f.advance(24*3600000);for(let i=0;i<3;i++)await f.service.tick();assert.equal(mutes(f).length,tries+1);
});
test('a block this service makes is muted right after, and unblocking stops silencing them',async()=>{
 const f=setup({fans:[row(11,3)],following:[row(11,3),row(14,9)]});await f.service.tick();
 assert.deepEqual(actions(f),[['block','block','14']]);assert.deepEqual(mutes(f),[]);
 await f.service.tick();assert.ok(mutes(f).includes('14'));assert.ok(f.service.blockedIds().includes('14'));
});

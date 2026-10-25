'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createRewardsService,rewardStore,personalTasks,roomLevels,jstDay}=require('../gravity-rewards.cjs');
const {createVoiceApi}=require('../gravity-api.cjs');
const {checkRequest}=require('../gravity-upstream.cjs');
const {makeHandler}=require('../serve.cjs');
const copy=x=>structuredClone(x);
function fixture(options={}){
 let time=Date.parse('2026-10-22T03:00:00Z'),who={user:'123',identity:'audit'},currentRoom=null,on=true,saved=null;
 const writes=[],reads=[],timers=new Map();let nextTimer=1;
 const data={
  tabs:{list:[{tab_id:1,tab_type:1},{tab_id:2,tab_type:3},{tab_id:4,tab_type:4}]},
  tasks:{direct_list:[],generic_task:[{task_id:2,task_name:'上麦',status:0,current:0,target:1,prize_list:[{award_name:'银币',count:1000}]},{task_id:14,task_name:'进两个房主的房',status:0,current:0,target:2,prize_list:[{award_name:'银币',count:2000}]}],achievement_task:[]},
  sign:{sign_status:-1,voice_stay_time:15,voice_stay_current:0,accumulate_sign:0,list:[{point:6500}]},
  boxes:{task_popular_value:10000,anchor_sernior_level:3,box_award_status:0,task_list:[{level:1,status:1,task_target:1000,sernior_level:0,remain_count:10,can_receive:1}]},
 };
 const store={load:()=>copy(saved),save:x=>{if(options.storeFail)throw Error('disk full');saved=copy(x);}};
 const build=()=>createRewardsService({identity:()=>who,roomContext:()=>currentRoom,auto:()=>on,now:()=>time,store,
  accountState:()=>({state:options.rejected?'rejected_session':'verified'}),enabled:options.enabled!==false,
  timers:{setTimeout:(fn,delay)=>{const id=nextTimer++;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id)},
  read:async(kind,extra,request,authority)=>{
   reads.push({kind,extra,authority});
   if(options.onRead)await options.onRead(kind,extra);
   if(options.failRead===kind)return {errno:-1};
   const value={rewardTabs:data.tabs,rewardTasks:extra.tab_id==='4'?{generic_task:[],direct_list:[],achievement_task:[]}:data.tasks,rewardSign:data.sign,rewardRoom:data.boxes}[kind];
   return {errno:0,data:copy(value)};
  },
  write:async(kind,extra,request,authority)=>{
   assert.equal(authority.expectedIdentity,who?.identity);assert.equal(authority.authorize(),true);
   writes.push({kind,extra,authority});
   if(options.onWrite)return options.onWrite(kind,extra,authority);
   if(kind==='taskReward'){data.tasks.generic_task.find(t=>String(t.task_id)===extra.task_id).status=2;return {errno:0,data:{list:[{award_name:'银币',count:1000}]}};}
   if(kind==='weeklySignReward'){data.sign.sign_status=1;return {errno:0,data:{list:[{award_name:'银币',count:6500}]}};}
   if(kind==='roomTaskReward'){data.boxes.task_list.find(t=>String(t.level)===extra.task_level).status=2;return {errno:0,data:{status:0,award_list:[{award_name:'扭蛋券',prize:1}]}};}
  },
 });
 let service=build();
 return {get service(){return service;},writes,reads,data,options,timers,store,
  room:(anchor='987',channel='456')=>{currentRoom={identity:who.identity,anchor_id:anchor,channel_id:channel};},
  leave:()=>{currentRoom=null;},account:()=>{who={user:'999',identity:'new-login'};},pause:()=>{on=false;},
  advance:ms=>{time+=ms;},setTime:ms=>{time=ms;},now:()=>time,restart:()=>{service=build();},state:()=>copy(saved),
 };
}

test('H5 personal and room projection are fail-closed and retain real reward fields',()=>{
 assert.equal(personalTasks({generic_task:[{task_id:0},{task_id:2,status:1,task_name:'x',secret:'secret'}]})[0].status,1);
 assert.equal(personalTasks({generic_task:[{task_id:2,status:0}],direct_list:[{task_id:2,status:1}]}).length,1);
 assert.equal(personalTasks({generic_task:[{task_id:2,status:'1'}]})[0].status,-2);
 const f=fixture();assert.equal(roomLevels(f.data.boxes)[0].eligible,true);
 for(const changes of [{can_receive:0},{status:2},{status:3},{remain_count:0},{task_target:20000},{sernior_level:4},{can_receive:undefined}]){
  const value=copy(f.data.boxes);Object.assign(value.task_list[0],changes);assert.equal(roomLevels(value)[0].eligible,false,JSON.stringify(changes));
 }
});

test('real on-mic and two-host task completions are automatically claimed, unfinished tasks never are',async()=>{
 const f=fixture();f.room();await f.service.tick();assert.equal(f.writes.length,1,'only eligible box');
 f.writes.length=0;f.data.tasks.generic_task[0].status=1;f.data.tasks.generic_task[1].status=1;f.advance(11000);
 await f.service.tick();assert.deepEqual(f.writes.map(x=>x.extra),[{task_id:'2'},{task_id:'14'}]);
 assert.equal(f.service.status().today_claims,3);
 await f.service.tick();assert.equal(f.writes.length,2,'no duplicate in same pass/day');
});

test('paid-task rewards may be collected after a real completion, but no task action or paid draw is ever emitted',async()=>{
 const f=fixture();f.data.tasks.generic_task=[{task_id:55,status:1,task_name:'real gift already sent',target:30,current:30}];
 await f.service.tick();assert.deepEqual(f.writes.map(x=>x.kind),['taskReward']);
 assert.deepEqual(f.writes[0].extra,{task_id:'55'});
});

test('seven-day stay sign uses H5 status 0, not legacy claimable 1, and does not infer readiness from a local timer',async()=>{
 for(const status of [-1,0,1]){
  const f=fixture();f.data.sign.sign_status=status;await f.service.tick();
  assert.equal(f.writes.filter(x=>x.kind==='weeklySignReward').length,status===0?1:0);
 }
 const f=fixture();f.data.sign.voice_stay_current=15;await f.service.tick();assert.equal(f.writes.length,0,'locked status still wins');
});

test('eligible tiered boxes require a trusted entered lease; local inspection or audition never qualifies',async()=>{
 const f=fixture();await f.service.tick();assert.equal(f.writes.length,0);assert.equal(f.reads.some(r=>r.kind==='rewardRoom'),false);
 f.room();await f.service.tick();assert.equal(f.writes[0].kind,'roomTaskReward');assert.deepEqual(f.writes[0].extra,{anchor_id:'987',channel_id:'456',task_level:'1'});
 assert.equal(f.service.status().room.levels[0].state,'已领取');
 f.leave();assert.equal(f.service.status().room,null);assert.equal(f.writes[0].authority.authorize(),false,'queued call loses its room permission');
});

test('box nested failure statuses, phone and relation errors never count as a successful prize',async()=>{
 for(const [errno,status] of [[0,1],[0,2],[0,3],[0,4],[0,5],[0,6],[0,7],[-13,null],[42001,null],[502141,null]]){
  const f=fixture({onWrite:()=>({errno,data:{status}})});f.room();await f.service.tick();
  assert.equal(f.service.status().today_claims,0,`${errno}/${status}`);
  await f.service.tick();assert.equal(f.writes.length,1,'no repeated hammering');
  if(status===4)assert.equal(f.state().entries[0].state,'done');
 }
});

test('unknown/malformed successful envelopes stay pending and are never presented as paid',async()=>{
 const f=fixture({onWrite:()=>({errno:0,data:{}})});f.data.tasks.generic_task[0].status=1;
 await f.service.tick();assert.equal(f.service.status().today_claims,0);assert.notEqual(f.state().entries[0].state,'done');
});

test('durable pending journal precedes HTTP; restart reconciles timeout success without sending a second claim',async()=>{
 let f;f=fixture({onWrite:(kind)=>{
  assert.equal(f.state().entries[0].state,'pending');
  f.data.tasks.generic_task[0].status=2;throw Error('response was lost');
 }});f.data.tasks.generic_task[0].status=1;
 await f.service.tick();assert.equal(f.writes.length,1);assert.equal(f.state().entries[0].state,'pending');
 f.restart();await f.service.tick();assert.equal(f.writes.length,1);assert.equal(f.state().entries[0].state,'done');
 assert.equal(f.service.status().recent[0].state,'reconciled');
});

test('unknown result waits before retry and requires a fresh claimable server response',async()=>{
 const f=fixture({onWrite:()=>{throw Error('timeout');}});f.data.tasks.generic_task[0].status=1;
 await f.service.tick();f.advance(61000);await f.service.tick();assert.equal(f.writes.length,1);
 f.advance(61000);await f.service.tick();assert.equal(f.writes.length,2);
 assert.equal(f.reads.filter(x=>x.kind==='rewardTasks').length>=3,true);
});

test('journal failure stops every write, rather than falling through to another reward lane',async()=>{
 const f=fixture({storeFail:true});f.room();f.data.tasks.generic_task[0].status=1;f.data.sign.sign_status=0;
 assert.equal(await f.service.tick(),false);assert.equal(f.writes.length,0);assert.match(f.service.status().last_error,/存储/);
});

test('a failed personal endpoint cannot starve ready sign or room box lanes',async()=>{
 for(const options of [{failRead:'rewardTasks'},{onRead:kind=>{if(kind==='rewardTasks')throw Error('socket timeout');}}]){
  const f=fixture(options);f.room();f.data.sign.sign_status=0;
  await f.service.tick();assert.deepEqual(f.writes.map(x=>x.kind),['weeklySignReward','roomTaskReward']);
  assert.match(f.service.status().last_error,/personal/);
 }
});

test('one denied room box does not block later eligible tiers',async()=>{
 const f=fixture({onWrite:(kind,extra)=>({errno:0,data:{status:extra.task_level==='1'?6:0,award_list:[]}})});f.room();
 f.data.boxes.task_list.push({...f.data.boxes.task_list[0],level:2});await f.service.tick();
 assert.equal(f.writes.length,2);assert.equal(f.service.status().today_claims,1);
});

test('account, room, auto and shutdown changes during reads prevent mutations',async()=>{
 for(const change of ['account','leave','pause','stop']){
  let f;f=fixture({onRead:kind=>{if(kind==='rewardRoom'){
   if(change==='account')f.account();if(change==='leave')f.leave();if(change==='pause')f.pause();if(change==='stop')f.service.stop();
  }}});f.room();await f.service.tick();assert.equal(f.writes.length,0,change);
 }
});

test('new login cannot see previous identity progress or receipts',async()=>{
 const f=fixture();f.room();await f.service.tick();assert.equal(f.service.status().today_claims,1);
 f.account();assert.equal(f.service.status().recent.length,0);assert.equal(f.service.status().room,null);
});

test('day rollover uses JST midnight and does not share a box journal across dates',async()=>{
 assert.equal(jstDay(Date.parse('2026-10-22T14:59:59Z')),'2026-10-22');
 assert.equal(jstDay(Date.parse('2026-10-22T15:00:00Z')),'2026-10-23');
 const f=fixture();f.setTime(Date.parse('2026-10-22T14:59:59Z'));f.room();await f.service.tick();
 f.advance(2000);f.data.boxes.task_list[0].status=1;await f.service.tick();assert.equal(f.writes.length,2);assert.equal(f.service.status().today_claims,1);
});

test('same-host reentry or channel change cannot re-claim a daily box',async()=>{
 const f=fixture();f.room();await f.service.tick();f.data.boxes.task_list[0].status=1;f.room('987','999');await f.service.tick();
 assert.equal(f.writes.length,1);
 f.room('888','777');await f.service.tick();assert.equal(f.writes.length,2);
});

test('tick is single-flight; burst signals coalesce; stop prevents rescheduling or wake',async()=>{
 let release;const hold=new Promise(r=>release=r);const f=fixture({onRead:kind=>kind==='rewardTabs'?hold:undefined});
 const work=f.service.tick();assert.equal(await f.service.tick(),false);release();await work;
 f.service.start();f.service.wake();f.service.wake();assert.equal(f.timers.size,1);
 f.service.stop();assert.equal(f.timers.size,0);f.service.wake();assert.equal(f.timers.size,0);
});

test('member seat transitions trigger fast refresh without turning every poll into a new scan',()=>{
 const f=fixture();f.room();f.service.start();f.service.observe({seated:false});
 const first=[...f.timers.keys()][0];f.service.observe({seated:false});assert.equal([...f.timers.keys()][0],first);
 f.service.observe({seated:true});assert.notEqual([...f.timers.keys()][0],first);f.service.stop();
});

test('per-pass and persisted daily attempt limits bound successful AND failed claims',async()=>{
 const f=fixture();f.data.tasks.generic_task=Array.from({length:30},(_,i)=>({task_id:i+1,status:1,task_name:'task '+i}));
 await f.service.tick();assert.equal(f.writes.length,12);
 f.advance(61000);await f.service.tick();assert.equal(f.writes.length,24);
 const saved=f.state();saved.attempts=200;f.store.save(saved);f.restart();await f.service.tick();assert.equal(f.writes.length,24);
 assert.equal(f.service.status().today_attempts,200);
});
test('malformed persisted counters fail closed, rather than resetting a potentially used ledger',async()=>{
 const f=fixture();await f.service.tick();const saved=f.state();saved.attempts='broken';f.store.save(saved);f.restart();
 f.data.tasks.generic_task[0].status=1;await f.service.tick();assert.equal(f.writes.length,0);assert.match(f.service.status().last_error,/存储/);
});
test('expired personal tasks and malformed sign states are not guessed into eligibility',async()=>{
 const f=fixture();f.data.tasks.generic_task=[{task_id:99,status:1,end_time:1}];f.data.sign.sign_status='0';
 await f.service.tick();assert.equal(f.writes.length,0);
});
test('explicit pause, missing identity and rejected session prevent every official scan',async()=>{
 const f=fixture();f.pause();await f.service.tick();assert.equal(f.reads.length,0);
 const rejected=fixture({rejected:true});await rejected.service.tick();assert.equal(rejected.reads.length,0);
 const disabled=fixture({enabled:false});await disabled.service.tick();assert.equal(disabled.reads.length,0);
 const noUser=createRewardsService({identity:()=>null});assert.equal(await noUser.tick(),false);
});
test('reward journal commits an owner-private file and refuses corrupt state',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gravity-reward-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'state.json'),store=rewardStore(file);assert.equal(store.load(),null);
 store.save({version:1});assert.deepEqual(store.load(),{version:1});assert.equal(fs.statSync(file).mode&0o777,0o600);
 fs.writeFileSync(file,'broken');assert.throws(()=>store.load(),/unreadable/);
});

test('API reward helpers use only verified contracts and encrypted writes except the form room-box claim',async()=>{
 const api=createVoiceApi({tokenLoader:()=> 'synthetic-token',deviceLoader:()=>({idfa:'fixture',uwd:'fixture',app_version:'14.2'}),stateFile:'/no-state'}),calls=[];
 const request=async opts=>{calls.push(opts);checkRequest(opts);return {status:200,body:Buffer.from(JSON.stringify({errno:0,data:{list:[]}}))};};
 await api.readReward('rewardTasks',{tab_id:'1'},request);
 await api.writeReward('taskReward',{task_id:'2'},request);
 await api.writeReward('weeklySignReward',{},request);
 await api.writeReward('roomTaskReward',{anchor_id:'9',channel_id:'8',task_level:'1'},request);
 assert.match(calls[0].path,/voiceTask\/taskList\?/);assert.equal(calls[1].contentType,'application/raw; charset=utf-8');assert.equal(calls[2].method,'POST');
 assert.match(calls[3].body,/task_level=1/);assert.equal(calls[3].contentType,undefined);
 for(const args of [['taskReward',{task_id:'0'}],['weeklySignReward',{award_type:0}],['roomTaskReward',{anchor_id:'9',channel_id:'8',task_level:'101'}],['createRoom',{}]])assert.throws(()=>api.writeReward(...args,request),/unsupported/);
 assert.throws(()=>api.readReward('rewardTasks',{tab_id:'1',user_id:'99'},request),/unsupported/);
});

test('queued reward re-checks room authority at dequeue, not only before joining the global queue',async()=>{
 let release,valid=true;const hold=new Promise(r=>release=r),calls=[];
 const api=createVoiceApi({tokenLoader:()=> 'fixture',deviceLoader:()=>({idfa:'i',uwd:'u'}),stateFile:'/no-state'});
 const first=api.readReward('rewardTabs',{},async()=>{await hold;return {status:200,body:Buffer.from('{"errno":0,"data":{}}')};});
 const second=api.writeReward('roomTaskReward',{anchor_id:'9',channel_id:'8',task_level:'1'},async o=>{calls.push(o);return {status:200,body:Buffer.from('{"errno":0,"data":{}}')};},{authorize:()=>valid});
 valid=false;release();await first;assert.equal((await second).errno,-5);assert.equal(calls.length,0);
});

test('upstream blocks GET bypass, duplicate room ids, arbitrary posts, and plaintext encrypted claims',()=>{
 const base={hostname:'api.gravity.place'};
 for(const p of ['/gravity/h5/voiceTask/drawEncrypt','/gravity/h5/voiceTask/signAwardReceiveEncrypt','/gravity/h5/getAwardForH5'])assert.throws(()=>checkRequest({...base,path:p+'?task_id=2'}));
 assert.throws(()=>checkRequest({...base,path:'/gravity/h5/getAwardForH5',method:'POST',body:'anchor_id=9&anchor_id=10&channel_id=8&task_level=1'}));
 assert.throws(()=>checkRequest({...base,path:'/gravity/h5/voiceTask/drawEncrypt',method:'POST',body:'task_id=2'}));
 assert.throws(()=>checkRequest({...base,path:'/gravity/h5/user/updateSetting',method:'POST',body:'x=1'}));
});

test('status HTTP is same-origin, read-only, and never leaks journal identity or authorization callbacks',async t=>{
 const f=fixture();f.room();await f.service.tick();
 const tasks={status:()=>({auto:true,enabled:true}),setAuto:()=>({auto:false})};
 const server=http.createServer(makeHandler({tasks,rewards:f.service}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const base='http://127.0.0.1:'+server.address().port;
 const res=await fetch(base+'/api/tasks/status',{headers:{Origin:base}});assert.equal(res.status,200);const text=await res.text();
 assert.equal(JSON.parse(text).data.rewards.today_claims,1);assert.equal(text.includes('"identity"'),false);assert.equal(text.includes('authorize'),false);
 assert.equal((await fetch(base+'/api/tasks/status',{headers:{Origin:'https://evil.invalid'}})).status,403);
 assert.equal(f.writes.length,1,'status GET never claims anything');
});

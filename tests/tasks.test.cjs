'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const {createTasksService, TasksError, mission, lotteryEntry, projectMissions, projectSign, adTimesLeft} = require('../gravity-tasks.cjs');
const {makeHandler} = require('../serve.cjs');

test('mission projection keeps verified fields and drops the rest', () => {
  const m = mission({id: 7, name: 'Chat', progress: '3/5', status: 1, type: 1, add_point: 50, secret: 'PRIVATE'});
  assert.deepEqual(m, {id: 7, name: 'Chat', progress: '3/5', status: 1, type: 1, points: 50});
  assert.equal(mission({id: 0}), null);
  assert.equal(mission({id: 'x'}), null);
  assert.equal(lotteryEntry(null), null);
  const free = lotteryEntry({name: '扭蛋', free_times: 2, price: 0});
  assert.equal(free.free, 2); assert.equal(free.price, 0);
});

function fixture(options = {}) {
  const reads = [], writes = [];
  const missions = options.missions ?? [{id: 7, name: 'Chat', status: 1, type: 0, add_point: 10}, {id: 8, name: 'Done', status: 2, type: 0}];
  const grow = options.grow ?? [];
  const sign = options.sign ?? [{id: 1, name: '签到', status: 1, add_point: 5}];
  const lottery = options.lottery ?? [{name: '扭蛋', free_times: 1}];
  const signBare = options.signBare === true;
  const service = createTasksService({
    identity: () => ({user: '123', identity: 'test-id'}),
    read: async (kind, extra) => {
      reads.push({kind, extra});
      if (kind === 'pointMissions') return {errno: 0, data: {list: missions, grow_list: grow}};
      if (kind === 'signMissions') return {errno: 0, data: signBare ? sign[0] : {list: sign}};
      return {errno: 0, data: {list: lottery}};
    },
    pointAward: async extra => { writes.push({kind: 'pointAward', extra}); return {errno: 0, data: true}; },
    signAward: async extra => { writes.push({kind: 'signAward', extra}); return {errno: 0, data: {}}; },
    lotteryDraw: async extra => { writes.push({kind: 'lotteryDraw', extra}); return {errno: 0, data: {}}; },
    adComplete: async extra => { writes.push({kind: 'adComplete', extra}); return {errno: 0, data: {}}; },
    writeFeed: async (kind, extra) => { writes.push({kind, extra}); return {errno: 0}; },
    readVoice: async (kind, extra) => {
      reads.push({kind, extra});
      if (kind === 'adPopup') return {errno: 0, data: options.adPopup ?? {current_times: 5, total_times: 5, status: 2}};
      if (kind === 'lotteryInfo') return {errno: 0, data: options.lotteryInfo ?? {is_free: 0}};
      if (kind === 'feedRecommended') return {errno: 0, data: {list: options.feed ?? []}};
      return {errno: -1};
    },
    accountState: () => ({state: 'verified'}),
    wait: async () => {},
    store: {load: () => null, save: () => {}},
    timers: {setTimeout: () => 0, clearTimeout: () => {}},
    log: () => {},
  });
  return {service, reads, writes};
}
const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('list projects missions, sign-ins and lottery entries in one call', async () => {
  const f = fixture();
  const data = await f.service.list();
  assert.equal(data.missions.length, 2); assert.equal(data.sign.length, 1);
  // lotteryList and lotteryCards are merged (2 rows from the two sources here).
  assert.equal(data.lottery.length, 2);
  assert.deepEqual(f.reads.map(r => r.kind), ['pointMissions', 'signMissions', 'lotteryList', 'lotteryCards']);
  assert.deepEqual(f.reads[0].extra, {user_id: '123'});
  assert.deepEqual(f.reads[2].extra, {source: 'cp'});
});

test('tick auto-claims only reward-waiting missions and never draws couple lottery', async () => {
  const f = fixture();
  assert.equal(await f.service.tick(), true);
  assert.deepEqual(f.writes.map(w => w.kind), ['pointAward', 'signAward']);
  assert.deepEqual(f.writes[0].extra, {id: '7', award_type: 0});
  assert.deepEqual(f.writes[1].extra, {award_type: 0});
  const st = f.service.status();
  assert.equal(st.today_writes, 2); assert.equal(st.recent.length, 2);
  // Second tick does not reclaim the same items.
  assert.equal(await f.service.tick(), true);
  assert.equal(f.writes.length, 2);
});

test('tick leaves unfinished missions and paid lottery draws for manual handling', async () => {
  const f = fixture({missions: [{id: 9, status: 0}], sign: [{id: 1, status: 0}], lottery: [{name: '扭蛋', price: 100}]});
  assert.equal(await f.service.tick(), true);
  assert.equal(f.writes.length, 0);
});
test('official grow_list and a bare SignMission object are claimable', async () => {
  assert.deepEqual(projectMissions({list: [{id: 35, status: 1}], grow_list: [{id: 47, status: 1, name: 'icon'}]}).map(m => m.id), [35, 47]);
  assert.equal(projectSign({id: 1, name: '毎日ログイン', status: 0, add_point: 1000})[0].status, 0);
  assert.equal(adTimesLeft({current_times: 2, total_times: 5}), 3);
  const growing = fixture({
    missions: [{id: 35, name: 'msg', status: 1, type: 0, add_point: 2000}],
    grow: [{id: 47, name: 'icon', status: 1, type: 0, add_point: 10000}],
    sign: [{id: 1, name: '毎日ログイン', status: 0, add_point: 1000}],
    signBare: true,
    lottery: [{name: 'cp', lottery_price: 600}],
  });
  assert.equal(await growing.service.tick(), true);
  assert.deepEqual(growing.writes.map(w => w.kind + ':' + (w.extra.id || w.extra.award_type)), ['pointAward:35', 'pointAward:47']);
  const signing = fixture({
    missions: [{id: 8, status: 2}],
    sign: [{id: 1, name: '毎日ログイン', status: 1, add_point: 1000}],
    signBare: true,
    lottery: [{name: 'cp', lottery_price: 600}],
  });
  assert.equal(await signing.service.tick(), true);
  assert.deepEqual(signing.writes.map(w => w.kind), ['signAward']);
});
test('tick claims remaining ads and likes recommended posts in the background', async () => {
  const f = fixture({
    missions: [{id: 8, status: 2}], sign: [{id: 1, status: 2}], lottery: [{name: 'cp', lottery_price: 600}],
    adPopup: {current_times: 4, total_times: 5, status: 1},
    lotteryInfo: {is_free: 1},
    feed: [{type: 'r_feed', content_feed: {id: 'post-1', is_vote: 0, user: {user_id: '12'}}}],
  });
  assert.equal(await f.service.tick(), true);
  assert.deepEqual(f.writes.filter(w => w.kind === 'adComplete').map(w => w.extra.scene), ['ad_point', 'ad_draw']);
  assert.deepEqual(f.writes.find(w => w.kind === 'feedVote').extra, {id: 'post-1', vote: '1', to_user_id: '12', type: 'f', feed_type: 'feed8', route_path: ''});
  assert.equal(f.service.status().today_likes, 1);
  assert.equal(f.service.status().recent.some(x => x.kind === 'like' || String(x.label).startsWith('点赞')), false);
});
test('tick claims remaining ads within its per-pass budget', async () => {
  const f = fixture({
    missions: [{id: 8, status: 2}], sign: [{id: 1, status: 2}], lottery: [{name: 'cp', lottery_price: 600}],
    adPopup: {current_times: 0, total_times: 5, status: 1},
    lotteryInfo: {is_free: 0},
  });
  assert.equal(await f.service.tick(), true);
  assert.deepEqual(f.writes.filter(w => w.kind === 'adComplete').map(w => w.extra.scene), ['ad_point', 'ad_point', 'ad_point', 'ad_point', 'ad_point']);
  assert.equal(f.service.status().today_writes, 5);
});

test('server ad quota 25 is recognized and claimed within the per-pass budget',async()=>{
 assert.equal(adTimesLeft({total_times:25,current_times:1}),24);
 const f=fixture({missions:[],sign:[],adPopup:{total_times:25,current_times:1,status:1},lotteryInfo:{is_free:1}});
 await f.service.tick();
 assert.deepEqual(f.writes.filter(w=>w.kind==='adComplete').map(w=>w.extra.scene),['ad_point','ad_point','ad_point','ad_point','ad_point','ad_draw']);
 assert.equal(f.service.status().ads.remaining,24);
});
test('ad recovery resumes at server-used offset instead of getting stuck at the first claimed local key',async()=>{
 let time=1700000000000,current=0,round=1;const calls=[];
 const service=createTasksService({identity:()=>({user:'123',identity:'resume-test'}),now:()=>time,wait:async()=>{},store:{load:()=>null,save:()=>{}},accountState:()=>({state:'verified'}),
  read:async()=>({errno:0,data:{list:[],grow_list:[]}}),
  readVoice:async kind=>({errno:0,data:kind==='adPopup'?{total_times:5,current_times:current,status:1}:kind==='lotteryInfo'?{is_free:0}:{list:[]}}),
  adComplete:async()=>{calls.push(round);if(round===1&&calls.length===2)return {errno:-1};current++;return {errno:0,data:{}};}});
 await service.tick();assert.equal(current,1);round=2;time+=180000;await service.tick();
 assert.equal(current,5);assert.equal(calls.filter(x=>x===2).length,4);
});
test('growth type 2 is preserved, distinct from daily ids, and forwarded without remapping',async()=>{
 assert.equal(mission({id:7,type:2}).type,2);assert.equal(mission({id:7,type:99}).type,-1);
 const f=fixture({missions:[{id:7,type:0,status:1}],grow:[{id:7,type:2,status:1}],sign:[]});
 await f.service.tick();assert.deepEqual(f.writes.filter(w=>w.kind==='pointAward').map(w=>w.extra.award_type),[0,2]);
});
test('manual claim validates confirmation and award fields', async () => {
  const f = fixture();
  const rid = n => `aaaaaaa${n}-bbbb-cccc-dddd-eeeeeeeeeeee`;
  await assert.rejects(f.service.claim({kind: 'point', confirmed: false, request_id: rid(1)}), /确认/);
  await assert.rejects(f.service.claim({kind: 'point', confirmed: true, request_id: rid(2)}), /参数/);
  await assert.rejects(f.service.claim({kind: 'point', id: '7', award_type: 5, confirmed: true, request_id: rid(3)}), /参数/);
  await assert.rejects(f.service.claim({kind: 'nope', confirmed: true, request_id: rid(4)}), /确认/);
  assert.deepEqual(await f.service.claim({kind: 'point', id: '7', award_type: 1, confirmed: true, request_id: rid(5)}), {claimed: true, kind: 'point'});
  assert.deepEqual(f.writes[0].extra, {id: '7', award_type: 1});
  assert.deepEqual(await f.service.claim({kind: 'sign', confirmed: true, request_id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'}), {claimed: true, kind: 'sign'});
  assert.deepEqual(await f.service.claim({kind: 'lottery', confirmed: true, request_id: 'cccccccc-dddd-eeee-ffff-111111111111'}), {claimed: true, kind: 'lottery'});
});

test('auto switch persists and tasks routes are same-origin guarded', async t => {
  const f = fixture();
  const server = http.createServer(makeHandler({tasks: f.service}));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = path => fetch(base + path, {headers: {Origin: base}});
  const post = (path, body, action = 'tasks-control') => fetch(base + path, {method: 'POST',
    headers: {Origin: base, 'Content-Type': 'application/json', 'X-Gravity-Action': action}, body: JSON.stringify(body)});
  assert.equal((await (await get('/api/tasks/status')).json()).data.auto, true);
  assert.equal((await (await post('/api/tasks/auto', {auto: false})).json()).data.auto, false);
  assert.equal((await (await get('/api/tasks/list')).json()).data.missions.length, 2);
  assert.equal((await post('/api/tasks/claim', {kind: 'sign', confirmed: true, request_id: uuid})).status, 200);
  assert.equal((await post('/api/tasks/claim', {kind: 'sign', confirmed: true, request_id: uuid}, 'wrong')).status, 403);
  assert.equal(f.service.status().auto, false);
});

test('task write helpers reject malformed fields before any signing', async () => {
  const {createVoiceApi} = require('../gravity-api.cjs');
  const api = createVoiceApi({tokenLoader: () => 't', deviceLoader: () => ({idfa: 'i', uwd: 'u'}), stateFile: '/no-state'});
  assert.throws(() => api.writePointAward({id: '0', award_type: 0}, () => { throw Error('no network'); }), /unsupported_task_award/);
  assert.throws(() => api.writePointAward({id: '7', award_type: 3}, () => { throw Error('no network'); }), /unsupported_task_award/);
  assert.throws(() => api.writeSignAward({award_type: 1}, () => { throw Error('no network'); }), /unsupported_sign_award/);
  assert.throws(() => api.writeLotteryDraw({source: 'cp'}, () => { throw Error('no network'); }), /unsupported_lottery_draw/);
  assert.throws(() => api.readTaskList('pointMissions', {}, () => { throw Error('no network'); }), /unsupported_task_list/);
  assert.throws(() => api.readTaskList('lotteryList', {source: 'xx'}, () => { throw Error('no network'); }), /unsupported_lottery_list/);
  assert.throws(() => api.writeAdComplete({scene: 'other'}, () => { throw Error('no network'); }), /unsupported_ad_complete/);
  assert.throws(() => api.writeAdComplete({scene: 'ad_point', extra: 1}, () => { throw Error('no network'); }), /unsupported_ad_complete/);
});

test('like memory survives days: auto-liked or hand-unliked posts are never auto-liked again, and the page shares the cap',async()=>{
 let day=Date.parse('2026-10-19T03:00:00Z');const saved={value:null};
 const store={load:()=>saved.value&&JSON.parse(JSON.stringify(saved.value)),save:v=>{saved.value=JSON.parse(JSON.stringify(v));}};
 const writes=[];let feed=[];
 const make=()=>createTasksService({identity:()=>({user:'123',identity:'test-id'}),now:()=>day,store,wait:async()=>{},
  read:async kind=>kind==='pointMissions'?{errno:0,data:{list:[],grow_list:[]}}:kind==='signMissions'?{errno:0,data:{list:[]}}:{errno:0,data:{list:[]}},
  readVoice:async kind=>kind==='adPopup'?{errno:0,data:{current_times:5,total_times:5,status:2}}:kind==='lotteryInfo'?{errno:0,data:{is_free:0}}:{errno:0,data:{list:feed}},
  writeFeed:async(kind,extra)=>{writes.push(extra.id);return {errno:0};},adComplete:async()=>({errno:0}),pointAward:async()=>({errno:0}),signAward:async()=>({errno:0}),lotteryDraw:async()=>({errno:0})});
 const row=id=>({type:'r_feed',content_feed:{id,is_vote:0,user:{user_id:'12'}}});
 let s=make();feed=[row('p1')];await s.tick();assert.deepEqual(writes,['p1']);
 // Next day the post shows up unliked again (the user took the like back in the App): not re-liked.
 day+=86400000;s=make();await s.tick();assert.deepEqual(writes,['p1']);
 // A post the user unliked on the page is never auto-liked, by the page or here.
 s.likeLedger.cancelled('p2');feed=[row('p2'),row('p3')];await s.tick();assert.deepEqual(writes,['p1','p3']);
 assert.deepEqual(s.likeLedger.allowAuto('p2'),{ok:false,capped:false});
 assert.deepEqual(s.likeLedger.allowAuto('p9'),{ok:true,capped:false});
 s.likeLedger.autoLiked('p9');assert.deepEqual(s.likeLedger.allowAuto('p9'),{ok:false,capped:false});
 assert.equal(s.status().today_likes,2,'page auto-likes count toward the same daily total');
 assert.equal(s.status().recent.some(x=>x.kind==='like'||String(x.label).startsWith('点赞')),false);
});
test('status hides leftover like journal rows from the reward log',()=>{
 const service=createTasksService({identity:()=>({user:'123',identity:'test-id'}),
  store:{load:()=>({version:1,identity:'test-id',auto:true,day:'2026-10-22',writes:1,claimed:[],likes:1,liked:['p1'],noLike:[],
   recent:[{at:1,kind:'like',label:'点赞 p1',ok:true},{at:2,kind:'ad',label:'广告银币 1',ok:true}]}),save:()=>{}},
  accountState:()=>({state:'verified'}),timers:{setTimeout:()=>0,clearTimeout:()=>{}}});
 assert.deepEqual(service.status().recent.map(x=>x.label),['广告银币 1']);
});

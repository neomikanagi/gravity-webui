'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {create}=require('../static/auto-like.js');
const post=(id,extra={})=>({id,collected:false,can_collect:true,...extra});
function harness(posts,options={}){const liked=[],waits=[],status=[];let day=options.day||0;
 const liker=create({posts:()=>posts,enabled:()=>options.enabled!==false,isBusy:()=>!!options.busy&&options.busy(),wait:async ms=>{waits.push(ms);if(options.onWait)options.onWait(ms);},
  like:async p=>{liked.push(p.id);if(options.fail)return options.fail(p,liked.length);return {collected:true,collect_count:1};},
  onLiked:(p,data)=>{p.collected=data.collected;},onStatus:t=>status.push(t),dayCount:()=>day,bumpDay:()=>{day++;},dayCap:options.dayCap??400});
 return {liker,liked,waits,status,day:()=>day};}
test('every pulled post that can be liked gets exactly one like, spaced by the gap',async()=>{
 const h=harness([post('a'),post('b',{collected:true}),post('c',{can_collect:false}),post('d')]);await h.liker.run();
 assert.deepEqual(h.liked,['a','d']);assert.deepEqual(h.waits,[2400,2400]);assert.equal(h.day(),2);assert.equal(h.status.at(-1),'自動いいね 2件');
 await h.liker.run();assert.deepEqual(h.liked,['a','d'],'a second pass finds nothing new');
});
test('a like the user took back by hand is not redone, and newly pulled posts are picked up',async()=>{
 const posts=[post('a')],h=harness(posts);await h.liker.run();posts[0].collected=false;posts.push(post('b'));
 await h.liker.run();assert.deepEqual(h.liked,['a','b']);
});
test('too-quick answers retry the same post; other failures move on; a dead session stops the run',async()=>{
 let calls=0;const h=harness([post('a'),post('b')],{fail:(p)=>{calls++;if(calls===1)throw new Error('请稍等两秒再操作。');return {collected:true,collect_count:1};}});
 await h.liker.run();assert.deepEqual(h.liked,['a','a','b']);
 const closed=harness([post('x'),post('y')],{fail:p=>{if(p.id==='x')throw new Error('这篇帖子不允许点赞。');return {collected:true,collect_count:1};}});
 await closed.liker.run();assert.deepEqual(closed.liked,['x','y']);
 const dead=harness([post('x'),post('y')],{fail:()=>{throw new Error('官方会话已失效，请同步 App 会话。');}});
 await dead.liker.run();assert.deepEqual(dead.liked,['x']);assert.match(dead.status.at(-1),/会话已失效/);
});
test('the switch, the daily cap and busy pages are respected',async()=>{
 const off=harness([post('a')],{enabled:false});await off.liker.run();assert.deepEqual(off.liked,[]);
 const capped=harness([post('a'),post('b'),post('c')],{day:398,dayCap:400});await capped.liker.run();assert.deepEqual(capped.liked,['a','b']);
 let busy=true;const waiting=harness([post('a')],{busy:()=>busy,onWait:ms=>{if(ms===600)busy=false;}});await waiting.liker.run();assert.deepEqual(waiting.liked,['a']);assert.ok(waiting.waits.includes(600));
});
test('overlapping runs do not double-like',async()=>{
 const h=harness([post('a'),post('b')]);await Promise.all([h.liker.run(),h.liker.run()]);assert.deepEqual(h.liked,['a','b']);
});

test('a post the server says to skip (already auto-liked, unliked by hand, day cap) is not counted or retried',async()=>{
 const {create}=require('../static/auto-like.js');
 const posts=[{id:'a',can_collect:true},{id:'b',can_collect:true},{id:'c',can_collect:true}];let bumped=0;const liked=[];
 const replies={a:{skipped:true,capped:false},b:{collected:true,collect_count:1},c:{skipped:true,capped:true}};
 const liker=create({posts:()=>posts,enabled:()=>true,isBusy:()=>false,wait:async()=>{},like:async p=>replies[p.id],onLiked:p=>liked.push(p.id),bumpDay:()=>bumped++});
 await liker.run();
 assert.deepEqual(liked,['b']);assert.equal(bumped,1);
 assert.equal(liker.tried.has('a'),true,'never asked again this page');
});

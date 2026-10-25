'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {makeHandler,httpsRequest}=require('../serve.cjs');
async function start(t){const calls=[],s=http.createServer(makeHandler({feed:{list:async(...args)=>{calls.push(['list',...args.slice(0,2)]);return {posts:[],next_cursor:''};},detail:async(...args)=>{calls.push(['detail',...args.slice(0,2)]);return {post:{id:'p'}};},reply:async body=>{calls.push(['reply',body]);return {posted:true};},collect:async body=>{calls.push(['collect',body]);return {collected:true,collect_count:1};}}}));
 await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));return {url:'http://127.0.0.1:'+s.address().port,calls};}
test('feed reads use injected fixed domain service and do not expose arbitrary proxy endpoints',async t=>{
 const f=await start(t);assert.equal((await fetch(f.url+'/api/feed/list?mode=latest&cursor=x')).status,200);assert.equal((await fetch(f.url+'/api/feed/detail?sid=p')).status,200);
 assert.deepEqual(f.calls,[['list','latest','x'],['detail','p','']]);assert.equal((await fetch(f.url+'/api/feed/giftBuy',{method:'POST'})).status,405);
 assert.equal((await fetch(f.url+'/api/feed/list',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
});
test('reply requires exact same origin, JSON and explicit action; browser cannot select recipient or upstream',async t=>{
 const f=await start(t),headers={Origin:f.url,'Content-Type':'application/json','X-Gravity-Action':'feed-control','Sec-Fetch-Site':'same-origin'};
 for(const patch of [{Origin:'https://evil.invalid'},{Origin:''},{'Content-Type':'text/plain'},{'X-Gravity-Action':'member-control'},{'Sec-Fetch-Site':'same-site'}])assert.equal((await fetch(f.url+'/api/feed/reply',{method:'POST',headers:{...headers,...patch},body:'{}'})).status,403);
 for(const body of ['null','[]','bad',JSON.stringify({to_user_id:'99'}),JSON.stringify({content:'x'.repeat(4097)})])assert.equal((await fetch(f.url+'/api/feed/reply',{method:'POST',headers,body})).status,400);
 assert.equal(f.calls.length,0);assert.equal((await fetch(f.url+'/api/feed/reply',{method:'POST',headers,body:JSON.stringify({sid:'p',content:'hello',confirmed:true})})).status,200);assert.equal(f.calls.length,1);
 assert.equal((await fetch(f.url+'/api/feed/collect',{method:'POST',headers,body:JSON.stringify({sid:'p',collected:true,confirmed:true})})).status,200);
 assert.equal((await fetch(f.url+'/api/feed/collect',{method:'POST',headers,body:JSON.stringify({sid:'p',collected:true,confirmed:true,to_user_id:'99'})})).status,400);
});
test('reply upstream refuses plaintext and non-allowlisted write operations before network',async()=>{
 await assert.rejects(httpsRequest({hostname:'api.gravity.place',path:'/gravity/feed/addCommentEncrypt',method:'POST',body:'content=plain'}));
 await assert.rejects(httpsRequest({hostname:'api.gravity.place',path:'/gravity/feed/voteEncrypt',method:'POST',body:'vote=1'}));
 await assert.rejects(httpsRequest({hostname:'api.gravity.place',path:'/gravity/feed/addComment',method:'POST',body:'plain'}));
});

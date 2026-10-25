'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createFeedService,post,comment,image}=require('../gravity-feed.cjs');
const {createVoiceApi,sessionIdentity}=require('../gravity-api.cjs');
const {encryptRequest,decryptResponse,aesEncrypt}=require('../gravity-encrypt.cjs');
const rawPost={id:'post-1',user:{user_id:'9007199254740993',name:'Author',portrait:'https://cdn.gravity.place/p.png?x=1'},title:'Title',desc:'<img onerror=bad()>',attaches:[{url:'https://cdn.gravity.place/f.jpg'},{url:'https://evil.invalid/x.jpg'}],allow_comment:1,comment_count:2,time:1900000000};
const rawComment={id:'comment-1',sid:'post-1',user:{user_id:'12',name:'Reader'},content:'Comment',time:1900000000};
function fixture(options={}){const calls=[],writes=[];let time=1900000000000,who={user:'7',identity:'identity-7'};
 const service=createFeedService({identity:()=>who,now:()=>time,read:async(kind,extra)=>{calls.push({kind,extra});
  if(options.readGate)await options.readGate;
  return options.failure||{errno:0,data:kind==='feedDetail'?{...rawPost,...options.post}:kind==='feedComments'?{list:[rawComment,{...rawComment,sid:'other'}],last_id:options.cursor||''}:{list:[{type:'ad',content_feed:rawPost},{type:'r_feed',content_feed:rawPost}],last_id:options.cursor||''}};
 },write:async(kind,extra,request,context)=>{writes.push({kind,extra,context});if(options.writeGate)await options.writeGate;if(options.writeFailure)throw Error('PRIVATE');return options.result||{errno:0,data:{comment_id:'new-comment'}};}});
 return {service,calls,writes,options,advance:ms=>{time+=ms;},setIdentity:value=>{who=value;},body:async(content='Reply',comment_id='')=>({sid:'post-1',comment_id,content,confirmed:true,reply_permit:(await service.detail('post-1','')).reply_permit,request_id:crypto.randomUUID()})};}
test('feed projection preserves exact IDs, text only and fixed CDN images without arbitrary fields',()=>{
 const p=post({...rawPost,secret:'PRIVATE'});assert.equal(p.author.user_id,'9007199254740993');assert.equal(p.text,'<img onerror=bad()>');assert.deepEqual(p.images,['https://cdn.gravity.place/f.jpg']);assert.ok(!JSON.stringify(p).includes('PRIVATE'));
 assert.equal(p.collected,false);assert.equal(p.collect_count,0);assert.equal(p.can_collect,true);
 assert.equal(post({...rawPost,is_vote:1,vote_count:4}).collected,true);
 assert.equal(post({...rawPost,is_vote:1,vote_count:4}).collect_count,4);
 assert.equal(post({...rawPost,user:{user_id:9007199254740993}}),null);assert.equal(post({...rawPost,id:'../x'}),null);
 for(const u of ['javascript:alert(1)','http://cdn.gravity.place/x.png','https://user@cdn.gravity.place/x.png','https://evil.invalid/x.png'])assert.equal(image(u),'');
});
test('recommended/following/latest are fixed reads; detail binds only official comments to reply permits',async()=>{
 const f=fixture();for(const mode of ['recommended','following','latest'])assert.equal((await f.service.list(mode,'')).posts.length,1);
 assert.deepEqual(f.calls.map(c=>c.kind),['feedRecommended','feedFollowing','feedLatest']);
 const d=await f.service.detail('post-1','');assert.equal(d.comments.length,1);assert.match(d.reply_permit,/^[a-f0-9-]{36}$/);
 await assert.rejects(f.service.list('arbitrary',''),/参数/);await assert.rejects(f.service.detail('post-1','https://evil.invalid'),/参数/);
});
test('full bounded upstream page is retained rather than losing posts before its next cursor',async()=>{
 const service=createFeedService({identity:()=>({identity:'test'}),read:async()=>({errno:0,data:{list:Array.from({length:50},(_,i)=>({type:'r_feed',content_feed:{...rawPost,id:'post-'+i}})),last_id:'next'}})});
 const data=await service.list('following','');assert.equal(data.posts.length,50);assert.equal(data.next_cursor,'next');
});
test('latest keeps the official JSON pager token so load-more can continue',async()=>{
 const cursor=JSON.stringify({PgKey:{db_time:{Value:'1792660213'},delete_status:{Value:'0'},id:{Value:'6_44156652'}},LastId:'',StrategyLastID:'1:[1792660144,"3_43895983"]'});
 const f=fixture({cursor});
 const page=await f.service.list('latest','');
 assert.equal(page.next_cursor,cursor);
 assert.deepEqual(f.calls[0],{kind:'feedLatest',extra:{last_id:''}});
 await f.service.list('latest',cursor);
 assert.deepEqual(f.calls[1],{kind:'feedLatest',extra:{last_id:cursor}});
 await assert.rejects(()=>f.service.list('recommended','../x'),/帖子列表参数无效/);
 await assert.rejects(()=>f.service.list('recommended','https://evil.invalid'),/帖子列表参数无效/);
});
test('embedded thread replies use verified parent IDs, safe profiles and omit deleted/foreign replies',()=>{
 const reply={id:'reply-1',comment_id:'comment-1',sid:'post-1',user:{user_id:'13',name:'Reply author'},content:'<script>text</script>',time:1900000000};
 const c=comment({...rawComment,reply:[reply,{...reply,is_delete:1},{...reply,comment_id:'other'}],reply_has_more:1},'post-1');
 assert.equal(c.replies.length,1);assert.equal(c.replies[0].text,'<script>text</script>');assert.equal(c.has_more_replies,true);
});
test('no App identity or rejected official session fails closed, without credential/error leaks',async()=>{
 const f=fixture();f.setIdentity(null);await assert.rejects(f.service.list('latest',''),/会话/);assert.equal(f.calls.length,0);
 const expired=fixture({failure:{errno:40026,errmsg:'PRIVATE'}});await assert.rejects(expired.service.list('latest',''),error=>error.status===503&&!error.message.includes('PRIVATE'));
});
test('post reply derives recipient and sends only official encrypted write fields',async()=>{
 const f=fixture(),body=await f.body('  Hello  ');assert.equal((await f.service.reply(body)).posted,true);
 assert.deepEqual(f.writes,[{kind:'feedComment',extra:{sid:'post-1',content:'Hello',content_type:'0',to_user_id:'9007199254740993',route_path:'feedDetail'},context:{expectedIdentity:'identity-7'}}]);
});
test('comment reply derives the selected comment author and post author server-side',async()=>{
 const f=fixture(),body=await f.body('Reply','comment-1');await f.service.reply(body);assert.equal(f.writes[0].kind,'feedReply');assert.equal(f.writes[0].extra.b_user_id,'12');assert.equal(f.writes[0].extra.a_user_id,'9007199254740993');
});
test('reply rejects malformed confirmation, IDs, length and unpublished comment targets before write',async()=>{
 const f=fixture(),body=await f.body();
 for(const patch of [{confirmed:false},{sid:'../x'},{content:''},{content:'x'.repeat(501)},{request_id:'1'},{comment_id:0},{comment_id:'unseen'},{reply_permit:'guessed'}])await assert.rejects(f.service.reply({...body,...patch}));
 assert.equal(f.writes.length,0);
});
test('reply permits expire and cannot migrate between accounts or changed post authors',async()=>{
 for(const change of ['time','account','author','closed']){const f=fixture(),body=await f.body();
  if(change==='time')f.advance(900001);else if(change==='account')f.setIdentity({user:'8',identity:'different'});else f.options.post=change==='closed'?{allow_comment:0}:{user:{user_id:'99',name:'Other'}};
  await assert.rejects(f.service.reply(body));assert.equal(f.writes.length,0);
 }
});
test('concurrent duplicate clicks share a single write and changed payload cannot reuse the request ID',async()=>{
 let release;const f=fixture({writeGate:new Promise(r=>release=r)}),body=await f.body();const a=f.service.reply(body),b=f.service.reply(body);release();assert.deepEqual(await a,await b);assert.equal(f.writes.length,1);
 await assert.rejects(f.service.reply({...body,content:'different'}),error=>error.status===409);
});
test('unknown result is cached without retry, while a new reply is rate-limited',async()=>{
 const f=fixture({writeFailure:true}),body=await f.body();await assert.rejects(f.service.reply(body),/结果未确认/);await assert.rejects(f.service.reply(body),/结果未确认/);assert.equal(f.writes.length,1);
 await assert.rejects(f.service.reply({...body,request_id:crypto.randomUUID(),content:'New'}),error=>error.status===429);
 f.advance(2001);f.options.writeFailure=false;assert.equal((await f.service.reply({...body,request_id:crypto.randomUUID(),content:'New'})).posted,true);
});
test('confirmed preflight failure may recover with the same ID because no write started',async()=>{
 const f=fixture(),body=await f.body();f.options.failure={errno:-1};await assert.rejects(f.service.reply(body));assert.equal(f.writes.length,0);
 f.options.failure=null;f.advance(2001);assert.equal((await f.service.reply(body)).posted,true);assert.equal(f.writes.length,1);
});
test('official nonzero write result never claims success or resends automatically',async()=>{
 const f=fixture({result:{errno:40041,errmsg:'PRIVATE'}}),body=await f.body();await assert.rejects(f.service.reply(body),/40041/);await assert.rejects(f.service.reply(body),/40041/);assert.equal(f.writes.length,1);
});
test('encrypted request matches native RSA PKCS1 + AES CBC zero padding with separate response key',()=>{
 const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),envelopeKey=Buffer.from('0123456789abcdef'),responseKey=Buffer.from('abcdef0123456789');
 const encrypted=encryptRequest({content:'こんにちは！',token:'synthetic',sign:'synthetic-sign'},{publicKey:pair.publicKey,envelopeKey,responseKey});
 const wire=JSON.parse(Buffer.from(encrypted.body,'base64'));
 const block=crypto.privateDecrypt({key:pair.privateKey,padding:crypto.constants.RSA_NO_PADDING},Buffer.from(wire.key,'base64'));
 assert.equal(block[0],0);assert.equal(block[1],2);assert.equal(block.subarray(block.indexOf(0,2)+1).toString(),envelopeKey.toString('base64'));
 const payload=JSON.parse(decryptResponse(Buffer.from(wire.data),envelopeKey));assert.equal(payload.content,'こんにちは！');assert.equal(payload.secret_key,responseKey.toString());assert.equal(payload.sign,'synthetic-sign');
 const response=aesEncrypt(Buffer.from(JSON.stringify({errno:0,data:{comment_id:'new'}})),responseKey).toString('base64');assert.equal(JSON.parse(decryptResponse(Buffer.from(response),responseKey)).errno,0);
 assert.equal(decryptResponse(Buffer.from('{"errno":1}'),responseKey),'{"errno":1}');for(const s of ['bad!','AAAA'])assert.throws(()=>decryptResponse(Buffer.from(s),responseKey));
});
test('feed API write sends only encrypted raw body, and account switch while queued refuses the write',async()=>{
 let token='synthetic-7',release;const api=createVoiceApi({tokenLoader:()=>token,deviceLoader:()=>({idfa:'synthetic',uwd:'synthetic'}),stateFile:'/nonexistent/synthetic-feed-state'});
 const gate=new Promise(r=>release=r),read=api.trySignedLabels(async()=>{await gate;return {status:200,body:Buffer.from('{"errno":0,"data":{}}')};});
 let writes=0;const request=async options=>{writes++;assert.equal(options.method,'POST');assert.equal(options.path,'/gravity/feed/addCommentEncrypt');assert.equal(options.contentType,'application/raw; charset=utf-8');const body=JSON.parse(Buffer.from(options.body,'base64'));assert.ok(body.data&&body.key);assert.ok(!options.body.includes('synthetic-7'));return {status:200,body:Buffer.from('{"errno":0,"data":{}}')};};
 const write=api.writeFeed('feedComment',{sid:'post-1',content:'hello'},request,{expectedIdentity:sessionIdentity(token)});token='synthetic-8';release();await read;assert.equal((await write).errno,-5);assert.equal(writes,0);
 assert.equal((await api.writeFeed('feedComment',{sid:'post-1',content:'hello'},request,{expectedIdentity:sessionIdentity(token)})).errno,0);assert.equal(writes,1);
 assert.throws(()=>api.writeFeed('giftPurchase',{},request),/unsupported/);
});
test('like is an encrypted vote bound to an already-read post',async()=>{
 const f=fixture();await assert.rejects(f.service.collect({sid:'post-1',collected:true,confirmed:true,request_id:crypto.randomUUID()}),/先打开/);
 await f.service.list('latest','');
 const id=crypto.randomUUID();assert.deepEqual(await f.service.collect({sid:'post-1',collected:true,confirmed:true,request_id:id}),{collected:true,collect_count:1});
 assert.deepEqual(f.writes,[{kind:'feedVote',extra:{id:'post-1',vote:'1',to_user_id:'9007199254740993',type:'f',feed_type:'feed5',route_path:''},context:{expectedIdentity:'identity-7'}}]);
 assert.deepEqual(await f.service.collect({sid:'post-1',collected:true,confirmed:true,request_id:id}),{collected:true,collect_count:1});assert.equal(f.writes.length,1);
});
test('unlike, unseen IDs and changed payload cannot reuse a request',async()=>{
 const f=fixture({post:{is_vote:1,vote_count:2}});await f.service.detail('post-1','');
 assert.deepEqual(await f.service.collect({sid:'post-1',collected:false,confirmed:true,request_id:crypto.randomUUID()}),{collected:false,collect_count:1});
 assert.equal(f.writes[0].extra.vote,'0');
 const f2=fixture();await f2.service.list('latest','');const id=crypto.randomUUID();
 await f2.service.collect({sid:'post-1',collected:true,confirmed:true,request_id:id});
 await assert.rejects(f2.service.collect({sid:'post-1',collected:false,confirmed:true,request_id:id}),error=>error.status===409);
});
test('unknown like result is cached, and likes use native encrypted voteEncrypt',async()=>{
 const f=fixture({writeFailure:true});await f.service.list('latest','');const body={sid:'post-1',collected:true,confirmed:true,request_id:crypto.randomUUID()};
 await assert.rejects(f.service.collect(body),/结果未确认/);await assert.rejects(f.service.collect(body),/结果未确认/);assert.equal(f.writes.length,1);
 let token='synthetic-7';const api=createVoiceApi({tokenLoader:()=>token,deviceLoader:()=>({idfa:'synthetic',uwd:'synthetic'}),stateFile:'/nonexistent/synthetic-vote-state'});
 const calls=[];const request=async options=>{calls.push(options);return {status:200,body:Buffer.from('{"errno":0,"data":{}}')};};
 assert.equal((await api.writeFeed('feedVote',{id:'post-1',vote:'1',to_user_id:'12',type:'f',feed_type:'feed8',route_path:''},request,{expectedIdentity:sessionIdentity(token)})).errno,0);
 assert.equal(calls[0].method,'POST');assert.equal(calls[0].path,'/gravity/feed/voteEncrypt');
 assert.equal(calls[0].contentType,'application/raw; charset=utf-8');
 const wire=JSON.parse(Buffer.from(calls[0].body,'base64'));assert.ok(wire.data&&wire.key);
 assert.throws(()=>api.writeFeed('feedVote',{id:'post-1',vote:'2',to_user_id:'12',type:'f',feed_type:'feed8',route_path:''},request),/unsupported/);
});
test('clearCollections pages collectListV2 and cancels each saved post once',async()=>{
 const lists=[[{type:'r_feed',content_feed:{...rawPost,id:'saved-1'}},{id:'saved-2',user:rawPost.user}],[]];
 const writes=[];
 const service=createFeedService({identity:()=>({user:'7',identity:'identity-7'}),
  read:async kind=>{if(kind!=='feedCollected')return {errno:0,data:{list:[]}};return {errno:0,data:{list:lists.shift()||[],last_id:''}};},
  write:async(kind,extra)=>{writes.push({kind,extra});return {errno:0};}});
 assert.deepEqual(await service.clearCollections(undefined,{gapMs:0}),{cancelled:2,failed:0,scanned:2});
 assert.deepEqual(writes.map(w=>[w.kind,w.extra.id,w.extra.action]),[['feedCollect','saved-1','cancel'],['feedCollect','saved-2','cancel']]);
});
test('feed list authors without a country are resolved in one batch and cached',async()=>{
 const lookups=[];let who={user:'7',identity:'identity-7'};
 const service=createFeedService({identity:()=>who,
  read:async kind=>({errno:0,data:{list:[{type:'r_feed',content_feed:{...rawPost}},{type:'r_feed',content_feed:{...rawPost,id:'post-2',user:{user_id:'12',name:'Reader'}}}],last_id:''}}),
  people:{lookup:async ids=>{lookups.push([...ids]);return id=>id==='9007199254740993'?'CN':'';}}});
 const first=await service.list('recommended','');
 assert.equal(first.posts[0].author.country,'CN');assert.equal(first.posts[1].author.country,'');
 assert.deepEqual(lookups,[['9007199254740993','12']]);
});
test('feed person keeps a row country when the row carries one',()=>{
 const postWithCountry=require('../gravity-feed.cjs').post({...rawPost,user:{user_id:'13',name:'C',user_country:'tw'}});
 assert.equal(postWithCountry.author.country,'TW');
});

test('automatic likes go through the shared ledger; a like taken back by hand is never re-added',async()=>{
 const notes=[];let time=1900000000000,voted=0;const writes=[];
 const ledger={allowAuto:id=>({ok:!notes.includes('auto:'+id)&&!notes.includes('cancel:'+id),capped:false}),autoLiked:id=>notes.push('auto:'+id),cancelled:id=>notes.push('cancel:'+id)};
 const service=createFeedService({identity:()=>({user:'7',identity:'identity-7'}),now:()=>time,ledger,
  read:async kind=>({errno:0,data:kind==='feedDetail'?{...rawPost,is_vote:voted,vote_count:voted}:{list:[{type:'r_feed',content_feed:rawPost}],last_id:''}}),
  write:async(kind,extra)=>{writes.push(extra.vote);voted=extra.vote==='1'?1:0;return {errno:0};}});
 await service.list('latest','');
 assert.deepEqual(await service.collect({sid:'post-1',collected:true,confirmed:true,request_id:crypto.randomUUID(),auto:true}),{collected:true,collect_count:1});
 time+=3000;await service.collect({sid:'post-1',collected:false,confirmed:true,request_id:crypto.randomUUID()});
 assert.deepEqual(notes,['auto:post-1','cancel:post-1']);
 time+=3000;assert.deepEqual(await service.collect({sid:'post-1',collected:true,confirmed:true,request_id:crypto.randomUUID(),auto:true}),{skipped:true,capped:false});
 assert.deepEqual(writes,['1','0']);
 await assert.rejects(service.collect({sid:'post-1',collected:false,confirmed:true,request_id:crypto.randomUUID(),auto:true}),/点赞需确认/);
 // A deliberate manual like is still allowed.
 assert.deepEqual(await service.collect({sid:'post-1',collected:true,confirmed:true,request_id:crypto.randomUUID()}),{collected:true,collect_count:1});
});

'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {APP_ID}=require('../static/controller.js');
const {makeHandler}=require('../serve.cjs');
const {createVoiceApi}=require('../gravity-api.cjs');
function token(ids=[1],app=APP_ID) {
 const message=Buffer.alloc(10+6*ids.length);message.writeUInt16LE(ids.length,8);
 ids.forEach((id,i)=>{message.writeUInt16LE(id,10+i*6);message.writeUInt32LE(2000000000,12+i*6);});
 const body=Buffer.alloc(44+message.length);body.writeUInt16LE(32);body.writeUInt16LE(message.length,42);message.copy(body,44);
 return '006'+app+body.toString('base64');
}
async function app(t,signedAudienceToken) {
 const instance=http.createServer(makeHandler({signedAudienceToken,request:async()=>{throw Error('no network');}}));
 await new Promise(r=>instance.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{instance.closeAllConnections();instance.close(r);}));
 return 'http://127.0.0.1:'+instance.address().port;
}
test('protocol audience request is fixed to role_type=0; callers cannot choose SDK/publisher roles',async()=>{
 const api=createVoiceApi({tokenLoader:()=>null,deviceLoader:()=>null,stateFile:'/nonexistent/gravity-test-state'});
 const options={token:'synthetic-account-token',device:{idfa:'synthetic-idfa',uwd:'synthetic-uwd'}};
 let calls=0;
 const result=await api.tryAccountAudienceToken({channel_id:'123',role_type:'1'},async req=>{
  calls++;const url=new URL('https://api.gravity.place'+req.path);assert.equal(url.pathname,'/gravity/voice/getAgoraToken');
  assert.equal(url.searchParams.get('role_type'),'0');assert.equal(url.searchParams.get('channel_id'),'123');
  return {status:200,body:Buffer.from(JSON.stringify({errno:0,data:{uid:7,rtc_token:token(),rtm_token:'PRIVATE-RTM'}}))};
 },options);
 assert.equal(result.errno,0);assert.equal(calls,1);
 assert.equal((await api.tryAccountAudienceToken({channel_id:'bad'},()=>{throw Error('no call');},options)).errno,-1);
});
test('account API exposes only the validated audience RTC token and UID, never RTM or account fields',async t=>{
 const rtc=token();const base=await app(t,async extra=>{assert.deepEqual(extra,{channel_id:'123'});return {errno:0,data:{uid:7,rtc_token:rtc,rtm_token:'PRIVATE-RTM',email:'PRIVATE-EMAIL',secret:'PRIVATE-SECRET'}};});
 const response=await fetch(base+'/api/agora-token?channel_id=123');assert.equal(response.status,200);
 const result=await response.json();assert.deepEqual(result.data,{rtc_token:rtc,user_id:7,mode:'account-audience',publishing_available:false});
 assert.ok(!JSON.stringify(result).includes('PRIVATE-'));
});
test('invalid ID, cross-site request and role escalation are rejected before any signed request',async t=>{
 let calls=0;const base=await app(t,async()=>{calls++;throw Error('must not call');});
 for(const url of ['/api/agora-token?channel_id=bad','/api/agora-token?channel_id=123&role_type=1'])assert.equal((await fetch(base+url)).status,400);
 assert.equal((await fetch(base+'/api/agora-token?channel_id=123',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal(calls,0);
});
test('publisher, malformed or wrong-App tokens and invalid UIDs are not delivered to the browser',async t=>{
 const cases=[{uid:7,rtc_token:token([1,2])},{uid:7,rtc_token:token([1],'0'.repeat(32))},
  {uid:7,rtc_token:'007unsupported'},{uid:0,rtc_token:token()},{uid:2**32,rtc_token:token()},{uid:7,rtc_token:token([])}];
 let i=0;const base=await app(t,async()=>({errno:0,data:{...cases[i++],rtm_token:'PRIVATE-RTM'}}));
 for(const item of cases){const response=await fetch(base+'/api/agora-token?channel_id=123');assert.equal(response.status,502);const body=await response.text();assert.ok(!body.includes(item.rtc_token));assert.ok(!body.includes('PRIVATE'));}
});
test('expired account does not silently downgrade to anonymous or echo upstream credential-bearing errors',async t=>{
 const base=await app(t,async()=>({errno:40026,errmsg:'PRIVATE-TOKEN'}));
 const response=await fetch(base+'/api/agora-token?channel_id=123');assert.equal(response.status,401);
 const body=await response.text();assert.match(body,/会话已失效/);assert.ok(!body.includes('PRIVATE'));
});

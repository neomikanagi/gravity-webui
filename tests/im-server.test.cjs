'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {makeHandler}=require('../serve.cjs');
async function start(t){const calls=[],im=Object.fromEntries(['friends','status','chat','connect','send','sendImage'].map(name=>[name,async(...args)=>{calls.push([name,args[0]]);return {state:'idle'};}]));
 const s=http.createServer(makeHandler({im}));await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));return {url:'http://127.0.0.1:'+s.address().port,calls};}
test('IM GETs are same-site, fixed service calls, never arbitrary credential endpoints',async t=>{
 const f=await start(t);for(const [url,name] of [['friends?kind=following&cursor=1','friends'],['status','status'],['chat?peer=123','chat']]){
  assert.equal((await fetch(f.url+'/api/im/'+url)).status,200);assert.equal(f.calls.at(-1)[0],name);}
 assert.equal((await fetch(f.url+'/api/im/token')).status,405);
 assert.equal((await fetch(f.url+'/api/im/chat?peer=123',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
});
test('IM mutations require exact origin, action, JSON and explicit connection confirmation',async t=>{
 const f=await start(t),headers={Origin:f.url,'Content-Type':'application/json','X-Gravity-Action':'im-control','Sec-Fetch-Site':'same-origin'};
 for(const patch of [{Origin:'https://evil.invalid'},{Origin:''},{'Content-Type':'text/plain'},{'X-Gravity-Action':'feed-control'},{'Sec-Fetch-Site':'same-site'}]){
  assert.equal((await fetch(f.url+'/api/im/send',{method:'POST',headers:{...headers,...patch},body:'{}'})).status,403);}
 for(const body of ['null','[]','bad',JSON.stringify({token:'secret'}),JSON.stringify({text:'x'.repeat(4097)})]){
  assert.equal((await fetch(f.url+'/api/im/send',{method:'POST',headers,body})).status,400);}
 assert.equal(f.calls.length,0);
 assert.equal((await fetch(f.url+'/api/im/connect',{method:'POST',headers,body:'{}'})).status,400);
 assert.equal((await fetch(f.url+'/api/im/connect',{method:'POST',headers,body:'{"confirmed":true}'})).status,200);
 assert.equal((await fetch(f.url+'/api/im/send',{method:'POST',headers,body:JSON.stringify({peer:'123',text:'hi',request_id:'id',chat_permit:'permit',confirmed:true})})).status,200);
 assert.equal(f.calls.length,2);
});
test('IM image upload requires same-origin multipart with explicit confirmation',async t=>{
 const f=await start(t),headers={Origin:f.url,'X-Gravity-Action':'im-control','Sec-Fetch-Site':'same-origin'};
 const multipart=(fields,file)=>{const b='----TestBoundary12345678';const parts=[];
  for(const [k,v] of Object.entries(fields))parts.push(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`);
  parts.push(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n${file}\r\n--${b}--\r\n`);
  return {body:parts.join(''),type:`multipart/form-data; boundary=${b}`};}
 const good={peer:'123',chat_permit:'permit',request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',confirmed:'true'};
 // Wrong action / cross-site / JSON body are all rejected before touching the service.
 for(const patch of [{'X-Gravity-Action':'feed-control'},{'Sec-Fetch-Site':'cross-site'}]){
  const m=multipart(good,'x');
  assert.equal((await fetch(f.url+'/api/im/send-image',{method:'POST',headers:{...headers,...patch,'Content-Type':m.type},body:m.body})).status,403);}
 assert.equal((await fetch(f.url+'/api/im/send-image',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).status,403);
 const badFields={...good,confirmed:'false'};
 const m1=multipart(badFields,'x');
 assert.equal((await fetch(f.url+'/api/im/send-image',{method:'POST',headers:{...headers,'Content-Type':m1.type},body:m1.body})).status,400);
 // Oversize bodies are rejected.
 const big=multipart(good,'x'.repeat(1_300_000));
 assert.equal((await fetch(f.url+'/api/im/send-image',{method:'POST',headers:{...headers,'Content-Type':big.type},body:big.body})).status,400);
});
test('IM image upload reaches the service with peer, permit and raw bytes',async t=>{
 const f=await start(t),headers={Origin:f.url,'X-Gravity-Action':'im-control','Sec-Fetch-Site':'same-origin'};
 const b='----TestBoundary12345678';
 const body=`--${b}\r\nContent-Disposition: form-data; name="peer"\r\n\r\n123\r\n--${b}\r\nContent-Disposition: form-data; name="chat_permit"\r\n\r\npermit\r\n--${b}\r\nContent-Disposition: form-data; name="request_id"\r\n\r\naaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\r\n--${b}\r\nContent-Disposition: form-data; name="confirmed"\r\n\r\ntrue\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nbytes\r\n--${b}--\r\n`;
 const r=await fetch(f.url+'/api/im/send-image',{method:'POST',headers:{...headers,'Content-Type':`multipart/form-data; boundary=${b}`},body});
 assert.equal(r.status,200);
 const call=f.calls.at(-1);assert.equal(call[0],'sendImage');
 assert.deepEqual([call[1].peer,call[1].confirmed,call[1].buffer.toString()],['123',true,'bytes']);
});

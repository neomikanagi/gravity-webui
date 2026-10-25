'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),https=require('node:https'),{EventEmitter}=require('node:events');
const {createSerial}=require('../gravity-util.cjs');
const {httpsRequest,DEADLINE_MS}=require('../gravity-upstream.cjs');
const {drainAccount}=require('../serve.cjs');
const root=path.join(__dirname,'..');
function localModules(entry,seen=new Set()){
 if(seen.has(entry))return seen;seen.add(entry);
 for(const [,name] of fs.readFileSync(path.join(root,entry),'utf8').matchAll(/require\('\.\/([A-Za-z0-9_.-]+\.cjs)'\)/g))localModules(name,seen);
 return seen;
}
test('every server module serve.cjs can load is copied into the image',()=>{
 const modules=[...localModules('serve.cjs')],docker=fs.readFileSync(path.join(root,'Dockerfile'),'utf8');
 assert.ok(modules.length>=10);
 for(const name of modules){assert.ok(docker.includes(name),'Dockerfile misses '+name);new (require('node:vm').Script)(fs.readFileSync(path.join(root,name),'utf8'),{filename:name});}
 for(const name of modules)for(const [,data] of fs.readFileSync(path.join(root,name),'utf8').matchAll(/require\('\.\/([A-Za-z0-9_.-]+\.json)'\)/g))assert.ok(docker.includes(data),'Dockerfile misses data file '+data);
});
test('serial queue runs jobs in order, survives failures and refuses overflow',async()=>{
 const serial=createSerial(2,()=>new Error('busy')),order=[];let release;
 const first=serial(()=>new Promise(resolve=>{release=()=>{order.push('first');resolve('a');};}));
 const second=serial(async()=>{order.push('second');throw new Error('boom');});
 await assert.rejects(serial(async()=>'never'),/busy/);
 release();assert.equal(await first,'a');await assert.rejects(second,/boom/);
 assert.deepEqual(order,['first','second']);assert.equal(await serial(async()=>'again'),'again');
});
test('upstream requests have a total deadline, not only an idle timeout',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const req=new EventEmitter();let destroyed=null;
 req.setTimeout=()=>{};req.end=()=>{};req.destroy=error=>{destroyed=error;req.emit('error',error);};
 t.mock.method(https,'request',()=>req);
 const pending=httpsRequest({hostname:'api.gravity.place',path:'/gravity/voice/search?x=1'});
 t.mock.timers.tick(DEADLINE_MS-1);assert.equal(destroyed,null);
 t.mock.timers.tick(1);await assert.rejects(pending,/upstream_deadline/);assert.equal(destroyed.message,'upstream_deadline');
});
test('a finished upstream response clears the deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const req=new EventEmitter();let destroyed=false;req.setTimeout=()=>{};req.destroy=()=>{destroyed=true;};
 let callback;t.mock.method(https,'request',(options,cb)=>{callback=cb;return req;});
 req.end=()=>{const res=new EventEmitter();res.statusCode=200;res.headers={};callback(res);res.emit('data',Buffer.from('{"errno":0}'));res.emit('end');};
 const result=await httpsRequest({hostname:'api.gravity.place',path:'/gravity/voice/search'});
 assert.equal(result.status,200);assert.equal(result.body.toString(),'{"errno":0}');t.mock.timers.tick(DEADLINE_MS*2);assert.equal(destroyed,false);
});
test('shutdown drain asks both account services and reports whether cleanup was confirmed',async()=>{
 const calls=[],service=name=>({drain:async request=>{calls.push([name,request]);}});
 assert.equal(await drainAccount({owner:service('owner'),member:service('member')},'req'),true);assert.deepEqual(calls,[['owner','req'],['member','req']]);
 assert.equal(await drainAccount({owner:service('owner'),member:{drain:async()=>{throw new Error('write failed');}}}),false);
 assert.equal(await drainAccount({owner:{},member:{}}),true);
});

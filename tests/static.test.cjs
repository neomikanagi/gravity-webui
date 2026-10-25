'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const {createStaticServer,acceptsEncoding,etagMatches}=require('../gravity-static.cjs');
const BIG='/* app */'+'function f(){return "gravity";}\n'.repeat(200);
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gravity-static-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'vendor'));
 fs.writeFileSync(path.join(root,'index.html'),'<!doctype html><title>x</title>');
 fs.writeFileSync(path.join(root,'app.js'),BIG);fs.writeFileSync(path.join(root,'tiny.js'),'1');
 fs.writeFileSync(path.join(root,'vendor','sdk@1.0.0.min.js'),BIG);fs.writeFileSync(path.join(root,'.secret.js'),'secret');
 fs.writeFileSync(path.join(root,'vendor','._sdk.js'),'junk');
 return root;
}
async function serve(t,root){
 const serveStatic=createStaticServer(root);
 const server=http.createServer((req,res)=>{res.setHeader('Cache-Control','no-store');serveStatic(req,res,new URL(req.url,'http://x').pathname).catch(()=>{res.statusCode=500;res.end();});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const port=server.address().port;
 // http.get keeps Accept-Encoding exactly as given and never decompresses.
 return (pathname,{method='GET',headers={}}={})=>new Promise((resolve,reject)=>{
  http.request({port,host:'127.0.0.1',path:pathname,method,headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));}).on('error',reject).end();
 });
}
test('app files are revalidated: content ETag, 304 on match, no-store never applied',async t=>{
 const get=await serve(t,fixture(t));const first=await get('/app.js');
 assert.equal(first.status,200);assert.equal(first.headers['cache-control'],'no-cache');assert.equal(first.headers['content-type'],'application/javascript; charset=utf-8');
 assert.equal(first.body.toString(),BIG);assert.equal(Number(first.headers['content-length']),first.body.length);
 const second=await get('/app.js',{headers:{'If-None-Match':first.headers.etag}});assert.equal(second.status,304);assert.equal(second.body.length,0);assert.equal(second.headers.etag,first.headers.etag);
 assert.equal((await get('/app.js',{headers:{'If-None-Match':'"other"'}})).status,200);
 assert.equal((await get('/app.js',{headers:{'If-None-Match':'W/'+first.headers.etag+', "x"'}})).status,304);
});
test('changed files are picked up without restart and get a new ETag',async t=>{
 const root=fixture(t),get=await serve(t,root),before=await get('/app.js');
 fs.writeFileSync(path.join(root,'app.js'),BIG+'// changed');
 const after=await get('/app.js');assert.notEqual(after.headers.etag,before.headers.etag);assert.ok(after.body.toString().endsWith('// changed'));
});
test('brotli/gzip are negotiated per representation and decode to the original bytes',async t=>{
 const get=await serve(t,fixture(t));
 const br=await get('/app.js',{headers:{'Accept-Encoding':'gzip, br'}});assert.equal(br.headers['content-encoding'],'br');assert.equal(zlib.brotliDecompressSync(br.body).toString(),BIG);
 const gz=await get('/app.js',{headers:{'Accept-Encoding':'gzip;q=0.8'}});assert.equal(gz.headers['content-encoding'],'gzip');assert.equal(zlib.gunzipSync(gz.body).toString(),BIG);
 const plain=await get('/app.js',{headers:{'Accept-Encoding':'br;q=0, identity'}});assert.equal(plain.headers['content-encoding'],undefined);assert.equal(plain.body.toString(),BIG);
 assert.equal(new Set([br.headers.etag,gz.headers.etag,plain.headers.etag]).size,3);assert.match(br.headers.vary,/Accept-Encoding/);
 assert.ok(br.body.length<BIG.length/4);
 const cached=await get('/app.js',{headers:{'Accept-Encoding':'br','If-None-Match':br.headers.etag}});assert.equal(cached.status,304);
 assert.equal((await get('/tiny.js',{headers:{'Accept-Encoding':'br'}})).headers['content-encoding'],undefined);
});
test('versioned vendor SDKs are cached immutably; app code is not',async t=>{
 const get=await serve(t,fixture(t));
 assert.equal((await get('/vendor/sdk@1.0.0.min.js')).headers['cache-control'],'public, max-age=31536000, immutable');
 assert.equal((await get('/index.html')).headers['cache-control'],'no-cache');
});
test('HEAD returns headers only; root and legacy alias serve index',async t=>{
 const get=await serve(t,fixture(t));const head=await get('/app.js',{method:'HEAD'});
 assert.equal(head.status,200);assert.equal(head.body.length,0);assert.equal(Number(head.headers['content-length']),BIG.length);
 assert.equal((await get('/')).body.toString(),(await get('/audition_loop.html')).body.toString());
});
test('dotfiles, directories, escapes and malformed URLs are refused with bounded JSON errors',async t=>{
 const get=await serve(t,fixture(t));
 for(const url of ['/.secret.js','/vendor/._sdk.js','/vendor','/missing.js','/%00'])assert.equal((await get(url)).status,404,url);
 assert.equal((await get('/%2e%2e%2fpackage.json')).status,403);
 const bad=await get('/%E0%A4%A');assert.equal(bad.status,400);assert.equal(JSON.parse(bad.body).errno,-3);
});
test('header parsing helpers handle q-values, weak tags and wildcards',()=>{
 assert.equal(acceptsEncoding('gzip, deflate, br','br'),true);assert.equal(acceptsEncoding('br;q=0','br'),false);assert.equal(acceptsEncoding('','gzip'),false);assert.equal(acceptsEncoding(undefined,'gzip'),false);
 assert.equal(etagMatches('*','"a"'),true);assert.equal(etagMatches('"b", W/"a"','"a"'),true);assert.equal(etagMatches(undefined,'"a"'),false);
});

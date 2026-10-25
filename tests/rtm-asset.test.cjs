'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.join(__dirname,'..');
test('native-compatible RTM 1.5.1 browser asset is pinned, integrity locked and included in the image',()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));assert.equal(pkg.dependencies['agora-rtm-sdk'],'1.5.1');
 const lock=fs.readFileSync(path.join(root,'pnpm-lock.yaml'),'utf8');assert.match(lock,/agora-rtm-sdk@1\.5\.1/);assert.match(lock,/integrity: sha512-/);
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'static/vendor/rtm@1.5.1.min.js'))).digest('hex'),'a0af344332723f63e605252d2f30523ae4eccf5eb08758c75f71dc1ca3bc7e48');
 const docker=fs.readFileSync(path.join(root,'Dockerfile'),'utf8');assert.match(docker,/gravity-member\.cjs/);assert.match(docker,/COPY static/);
 const html=fs.readFileSync(path.join(root,'static/index.html'),'utf8');assert.match(html,/member-controller\.js/);assert.match(html,/rtm@1\.5\.1\.min\.js/);
});

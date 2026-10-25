'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
test('session/native analysis and TLS files are excluded from the image build context',()=>{
 const ignored=new Set(read('.dockerignore').trim().split(/\r?\n/));
 for(const name of ['.session','_analysis','*.pem','.env'])assert.ok(ignored.has(name),name);
 const dockerfile=read('Dockerfile');assert.ok(!dockerfile.includes('COPY . '));
 for(const name of ['gravity-feed.cjs','gravity-encrypt.cjs'])assert.ok(dockerfile.includes(name));
 assert.ok(ignored.has('**/._*'));
 for(const name of ['feed-ui.js','gift-events.js'])assert.ok(read('static/index.html').includes('/'+name));
 assert.ok(!dockerfile.includes('evidence'));
});
test('runtime credentials are read-only; only non-secret rejection fingerprints are writable',()=>{
 const compose=read('docker-compose.yml');
 assert.match(compose,/\.session:\/app\/\.session:ro/);assert.match(compose,/tls:\/tls:ro/);
 assert.match(compose,/GRAVITY_ACCOUNT_STATE_FILE: \/state\/account-state\.json/);
 assert.match(compose,/\.\/state:\/state/);
 assert.ok(!compose.includes('/mnt/'));
 assert.ok(!/ipv4_address/.test(compose));
});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('both people lists default expanded; gift thanks is always on with no switch',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../static/index.html'),'utf8');
 for(const id of ['seatList','memberList']){
  const block=[...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)].find(([, ,body])=>body.includes(`id="${id}"`));
  assert.ok(block,`${id} disclosure exists`);assert.match(block[1],/\bopen(?:\s|$|=)/);
 }
 assert.ok(!html.includes('id="autoGiftThanks"'),'no gift-thanks switch: thanks are always on');
 assert.ok(!html.includes('id="autoFrom"'),'no from auto-reply switch: the feature is removed');
 assert.match(html,/ギフトを受け取ったら自動でお礼/);
 assert.match(html,/id="btnProfileBlock"/);
 assert.match(html,/id="btnCreateRoom"/);
 assert.match(html,/いまのアカウントで作成し、成功したらすぐ入室/);
 assert.match(html,/ギフトごとに1回/);
 assert.match(html,/id="btnUnreadIm"/);
 assert.match(html,/id="friendUnreadBadge"/);
});

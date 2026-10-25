'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {page,offStage,remoteSpeakers,micControls}=require('../static/view-model.js');
test('room pages contain ten items, do not accumulate, and clamp after list changes',()=>{
 const rows=Array.from({length:23},(_,i)=>i);assert.deepEqual(page(rows,0).rows,rows.slice(0,10));
 assert.deepEqual(page(rows,1).rows,rows.slice(10,20));assert.deepEqual(page(rows,2).rows,[20,21,22]);
 assert.equal(page([1],2).index,0);assert.deepEqual(page([],0),{rows:[],index:0,count:1});
});
test('off-stage members exclude every occupied seat by stable user ID, not nickname',()=>{
 const board={members:[{user_id:'1',name:'same'},{user_id:'2',name:'same'},{user_id:'3'}],seats:[{person:{user_id:1}},{person:null}]};
 assert.deepEqual(offStage(board).map(p=>p.user_id),['2','3']);assert.deepEqual(offStage(null),[]);
 board.members[0].is_self=true;board.self_profile=board.members[0];assert.deepEqual(offStage(board).map(p=>p.user_id),['2','3']);
});
test('paged refresh keeps this session verified self visible once, without copying departed strangers',()=>{
 const self={user_id:'7',is_self:true,name:'You'},board={members:[{user_id:'9',name:'Host'}],seats:[],self_profile:self};
 assert.deepEqual(offStage(board).map(p=>p.user_id),['7','9']);
 board.members=[{...self,name:'Fresh name'},{user_id:'9'}];assert.equal(offStage(board).filter(p=>p.is_self).length,1);assert.equal(offStage(board)[0].name,'Fresh name');
 board.members=[];board.seats=[{person:self}];assert.deepEqual(offStage(board),[],'on-stage self is not duplicated off stage');
 board.self_profile={user_id:'10',is_self:false};board.seats=[];assert.deepEqual(offStage(board),[],'only a verified own card may be retained');
});
test('remote speaker count uses subscribed audio tracks equally for preview and member, never roster/seat totals',()=>{
 for(const accountMode of ['anonymous','member']){
  const s={running:true,accountMode,remoteAudioCount:3,roomBoard:{seats:Array(10).fill({person:{user_id:'1'}})}};
  assert.equal(remoteSpeakers(s),3);s.remoteAudioCount=0;assert.equal(remoteSpeakers(s),0);
  s.remoteAudioCount=3;s.running=false;assert.equal(remoteSpeakers(s),0);
 }
 for(const remoteAudioCount of [-1,NaN,undefined,1.5])assert.equal(remoteSpeakers({running:true,remoteAudioCount}),0);
});
test('microphone controls implement down/seated/closed/open states, no automatic capture',()=>{
 const s={accountMode:'member',state:'listening',micState:'off',publishingAvailable:true,memberState:{seated:false}};
 assert.deepEqual(micControls(s,true),{apply:true,leave:false,open:false,close:false});
 s.memberState.seated=true;assert.deepEqual(micControls(s,true),{apply:false,leave:true,open:true,close:false});
 s.micState='sdk-published-unverified';assert.deepEqual(micControls(s,true),{apply:false,leave:true,open:false,close:true});
 s.micClosing=true;assert.ok(Object.values(micControls(s,true)).every(v=>!v));
 s.micClosing=false;s.micState='off';s.memberState.is_owner=true;assert.equal(micControls(s,true).leave,false);
 s.accountMode='anonymous';assert.ok(Object.values(micControls(s,true)).every(v=>!v));
 s.accountMode='member';s.memberState={seated:false};s.seatRequestState='waiting';s.micState='off';s.micClosing=false;s.seatBusy=false;
 assert.equal(micControls(s,true).apply,true,'waiting for approval still allows another apply tap');
});

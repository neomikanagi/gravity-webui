'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {publicFollowRooms,makeHandler}=require('../serve.cjs');
const {createVoiceApi}=require('../gravity-api.cjs');
const row=(channel_id,user_id)=>({channel_id,user_id,name:'Room',ext:{user_list:[{user_id,name:'Host',portrait:'https://evil.invalid/private'}],user_count:3},private_token:'secret'});
test('follow rooms use official create/join groups, omit reservations and private fields',()=>{
 const rooms=publicFollowRooms({list:[{follow_type:1,list:[row('123',9)]},{follow_type:2,list:[row('456',8)]},{follow_type:3,list:[row('789',7)]}]});
 assert.equal(rooms.length,2);assert.equal(rooms[0].follow_type,1);assert.deepEqual(rooms[0].friend_names,['Host']);
 assert.equal(rooms[1].follow_type,2);assert.deepEqual(rooms[1].friend_names,[]);assert.ok(!JSON.stringify(rooms).includes('secret'));assert.ok(!JSON.stringify(rooms).includes('evil'));
});
test('joined-elsewhere friend names are matched to the official following list, never guessed from host/attendees',()=>{
 const item=row('456',8);item.ext.user_list.push({user_id:7,name:'Friend',portrait:''},{user_id:6,name:'Stranger'});
 const rooms=publicFollowRooms({list:[{follow_type:2,list:[item]}]},[{user_id:7,name:'Verified Friend',email:'private'}]);
 assert.deepEqual(rooms[0].friend_names,['Verified Friend']);assert.deepEqual(rooms[0].friends,[{user_id:'7',name:'Verified Friend',portrait:'',country:''}]);
 assert.ok(!JSON.stringify(rooms).includes('private'));assert.ok(!JSON.stringify(rooms).includes('Stranger'));
});
test('follow room request is fixed, signed and read-only with no invented pagination fields',async()=>{
 const api=createVoiceApi({tokenLoader:()=> 'test',deviceLoader:()=>({idfa:'i',uwd:'u'}),stateFile:'/no-state'});let call;
 await api.trySignedFollowRooms(async o=>{call=o;return {status:200,body:Buffer.from(JSON.stringify({errno:0,data:{list:[]}}))};});
 assert.ok(call.path.startsWith('/gravity/voice/listRoomForFollow?'));assert.equal(call.method,undefined);
 assert.equal(new URL('https://api.gravity.place'+call.path).searchParams.has('cursor'),false);
});
test('follow endpoint handles empty lists and unavailable sessions without public-hot fabrication',async t=>{
 const server=http.createServer(makeHandler({signedFollowRooms:async()=>({errno:0,data:{list:[]}})}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const data=await(await fetch(`http://127.0.0.1:${server.address().port}/api/friends/rooms`)).json();assert.deepEqual(data.data,{rooms:[],next_cursor:''});
});

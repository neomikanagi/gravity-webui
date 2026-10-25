'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const pb = require('../gravity-pb.cjs');
const maf = require('../gravity-maf.cjs');
const M = require('../gravity-im-message.cjs');
const core = require('../gravity-imcore.cjs');

const hex = value => Buffer.from(value, 'hex');

// ---- protobuf codec -------------------------------------------------------------------------------------------------
test('protobuf codec round-trips varints, strings and nested messages and keeps 64-bit ids exact', () => {
  const big = 5000000000000000001n;
  const encoded = Buffer.concat([pb.enc.varint(1, 300), pb.enc.string(2, '日本語'), pb.enc.varint(3, big), pb.enc.bool(4, true),
    pb.enc.message(5, [pb.enc.string(1, 'inner'), pb.enc.varint(2, 7)])]);
  const f = pb.decode(encoded);
  assert.equal(pb.num(f, 1), 300);
  assert.equal(pb.str(f, 2), '日本語');
  assert.equal(pb.id(f, 3), String(big));
  assert.equal(pb.num(f, 4), 1);
  const inner = pb.decode(pb.first(f, 5));
  assert.equal(pb.str(inner, 1), 'inner');
  assert.equal(pb.num(inner, 2), 7);
  assert.equal(pb.str(f, 99), '');
});
test('protobuf decoder rejects truncated, over-deep and unsupported wire data', () => {
  assert.throws(() => pb.decode(hex('0a05616263')), /truncated/);
  assert.throws(() => pb.decode(hex('08')), /truncated/);
  assert.throws(() => pb.decode(hex('0b')), /unsupported_wire/);
  let nested = Buffer.alloc(0);
  for (let i = 0; i < 12; i++) nested = pb.enc.message(1, [nested]);
  const walk = (buffer, depth = 0) => { for (const field of pb.decode(buffer, depth)) if (field.wire === 2 && field.value.length) walk(field.value, depth + 1); };
  assert.throws(() => walk(nested), /too_deep/);
});

// ---- maf transport: byte-exact vectors captured from the App's own libhichannel-jni.so (unidbg trace) -----------------
test('static key table has 200 AES-256 keys and matches the two keys observed live', () => {
  assert.equal(maf.KEYS.length, 200);
  assert.ok(maf.KEYS.every(key => key.length === 32));
  assert.equal(maf.KEYS[111].toString('hex'), '0981a23aa4484d83de00994abd9d4d06af3c68c36f8b99637dcef4d8dba05c6f');
  assert.equal(maf.KEYS[152].toString('hex'), '52ad16bee7580652298e3a272fe0b005cd3fc3394e53c66ba786ad0ef2fb7fbe');
});
test('handshake request frame equals the native client frame for the same key index and public key', () => {
  const publicKey = hex('0432e6880a6130479d5fbdb634b8641b5a29242ff553aecc12037602e0');
  assert.equal(maf.s1Frame(111, publicKey).toString('hex'),
    '4869563200000037000028110000000001016f00000030ee4a0bb79b8a156336e584c5430194186913119ea0c070af3cb6e28dd5e088d547bf04f2c51d4fb4f26e1c2402fa7724');
});
test('native server handshake answer decrypts to the server public key and AES-128 session length', () => {
  const {frames, rest} = maf.parseFrames(hex('486956320000003000002612000000005279f4577a32d6d04bfaf58bda08f2205bfb1a7d6cf514ad445b7ca5a2cbb6b304cb9ba7bdacea10e1fc79087fa035b6'));
  assert.equal(rest.length, 0);
  const [f] = frames;
  // the server sets the compress bit on S2 although the handshake body itself is not deflated; the client never reads it there
  assert.deepEqual([f.type, f.pad, f.encrypted, f.compressed], [2, 9, false, true]);
  const plain = maf.aesDecrypt(maf.KEYS[111], f.body).subarray(0, f.body.length - f.pad);
  assert.equal(plain.toString('hex'), '01010000001d047017c5e8741db44c462e8f26ab4589fd7129ecfc6e3908908292d2b800000010');
});
test('session frames: client frame header/cipher and server channel-key frame match the native client', () => {
  const key = hex('7b98ecc5ae78685e2d0103765c3d0000');
  const deflated = hex('789c636080036503432363135333730bcbc4a4e494d43474be8383032323502197635e4a517e668a82a13190c7ede8e7126fa867a467a067000028410f83');
  const cipher = maf.aesEncrypt(key, deflated);
  assert.equal(maf.frame(8, cipher, {pad: cipher.length - deflated.length, encrypted: true, compressed: true}).toString('hex'),
    '486956320000004000000b1800000000705d4a9231d37f897288dcfccfdafc683f2ca9d37bc6c31464744aad738c712aaa76bf2f840b148e2583eb6138cdf1e7b73a71b0fa2faf8bd2484460b30ca9eb');
  const [server] = maf.parseFrames(hex('486956320000003000003318000000004993cdf28e84832ebce32e45c10567d85f49d560aca9c291a1579f3411683a2c6805b8bfeb24d26ece0787acf7e25e2e')).frames;
  const reply = maf.decodeData(key, server);
  assert.equal(reply.readUInt32BE(0), 24);
  assert.equal(reply.subarray(4).toString(), '1XGTZeLr/T2mrwvQezdmXg==');
});
test('channel info block equals the one the native client sends', () => {
  assert.equal(maf.channelInfo({deviceToken: '0123456789abcdef0123456789abcdef@@@'}).toString('hex'),
    '000000000000000000000023303132333435363738396162636465663031323334353637383961626364656640404001010000000a416e64726f69642031330000000b414e445f312e322e302e30');
});
test('secp112r2 key agreement and application round trip work with the negotiated 16-byte key', () => {
  const a = crypto.createECDH(maf.CURVE), b = crypto.createECDH(maf.CURVE);
  const pa = a.generateKeys(), pb2 = b.generateKeys();
  assert.equal(pa.length, 29);
  const secret = a.computeSecret(pb2);
  assert.equal(secret.length, 14);
  assert.deepEqual(secret, b.computeSecret(pa));
  const key = Buffer.alloc(16); secret.copy(key);
  const [f] = maf.parseFrames(maf.encodeData(key, Buffer.from('hello'), maf.TYPE.APP)).frames;
  assert.equal(f.type, maf.TYPE.APP);
  assert.equal(maf.decodeData(key, f).toString(), 'hello');
});
test('frame parser handles split and coalesced reads and rejects bad magic or oversize frames', () => {
  const key = Buffer.alloc(16, 7);
  const one = maf.encodeData(key, Buffer.from('a')), two = maf.encodeData(key, Buffer.from('b'));
  const joined = Buffer.concat([one, two]);
  const part = maf.parseFrames(joined.subarray(0, one.length + 10));
  assert.equal(part.frames.length, 1);
  assert.equal(part.rest.length, 10);
  assert.equal(maf.parseFrames(Buffer.concat([part.rest, joined.subarray(one.length + 10)])).frames.length, 1);
  assert.throws(() => maf.parseFrames(Buffer.alloc(16, 1)), /bad_magic/);
  const huge = Buffer.alloc(16); huge.write('HiV2'); huge.writeUInt32BE(0x200000, 4);
  assert.throws(() => maf.parseFrames(huge), /frame_too_large/);
  assert.throws(() => maf.frame(8, Buffer.alloc(0xfff1)), /frame_too_large/);
  // 16-byte keep-alive: type 7, version bit, sequence in the last word
  assert.equal(maf.frame(maf.TYPE.PING, Buffer.alloc(0), {tail: 3}).toString('hex'), '48695632000000000000001703000000');
});

// ---- app message format -------------------------------------------------------------------------------------------------
test('RC ids, chat ids and message ids follow the App rules', () => {
  assert.equal(M.rcId('2000000001'), '1996592181');
  assert.equal(M.rcId(M.rcId('2000000002')), '2000000002');
  assert.equal(M.chatId('2000000001', '1000001101'), '1000001101:2000000001');
  assert.equal(M.chatId('2000000002', '2000000001'), '2000000001:2000000002');
  assert.equal(M.peerOf('2000000001:2000000002', '2000000001'), '2000000002');
  assert.equal(M.messageId('2000000001', 1791443991965), '1791443991.965_' + crypto.createHash('md5').update('2000000001').digest('hex').toUpperCase().slice(8, 24));
});
test('official/system accounts are recognised by the App ranges and nothing else', () => {
  for (const id of ['1000000000', '1000001000', '1000001101', '1000001999', '1000002002', '1000002003']) assert.equal(M.officialUser(id), true, id);
  for (const id of ['1000002000', '1000002001', '999999999', '2000000002', '', 'abc', null, '99999999999999999999999']) assert.equal(M.officialUser(id), false, String(id));
  assert.equal(M.officialRcId('989907610'), true);
  assert.equal(M.officialRcId('1996592181'), false);
});
test('outgoing text is the App CustomMsgContent JSON and survives a OneMsg round trip', () => {
  const me = {user_id: '2000000001', name: '名前', portrait: 'https://cdn.gravity.place/a.png', portrait_is_3d: 0, portrait_frame: '', portrait_bg_img: '', transparent_portrait: ''};
  const json = M.textContent({text: 'こんにちは\n<b>x</b>', me, now: 1791443991965});
  const parsed = JSON.parse(json);
  assert.equal(parsed.content, 'こんにちは\n<b>x</b>');
  assert.deepEqual([parsed.type, parsed.format, parsed.notification, parsed.hasGray], [0, 0, true, '1']);
  assert.equal(parsed.mid.startsWith('1791443991.965_'), true);
  assert.deepEqual(parsed.user, {badgeUrl: '', chatType: 'USER', id: '1996592181', name: '名前', portrait: 'https://cdn.gravity.place/a.png',
    portrait_is_3d: '0', portrait_bg_img: '', portrait_frame: '', transparent_portrait: ''});
  const buffer = pb.decode(core.textMessage({fromId: me.user_id, toId: '2000000002', text: json, clientMsgId: 5n, serverNow: 1791443991965}))[0].value;
  const m = M.parseOneMsg(buffer);
  assert.deepEqual([m.from, m.to, m.chatType, m.kind, m.text, m.template], ['2000000001', '2000000002', 1, 'text', 'こんにちは\n<b>x</b>', 'bdim_hi_text']);
  assert.equal(m.serverTime, 1791443991965);
});
test('non-text App messages are labelled instead of shown as raw JSON', () => {
  const body = JSON.stringify({type: 114, content: '[スタンプ]'});
  const one = pb.enc.message(6, [pb.enc.message(4, [pb.enc.string(2, body)])]);
  const m = M.parseOneMsg(Buffer.concat([pb.enc.varint(1, 1), pb.enc.string(2, '2000000002'), pb.enc.string(4, '2000000001'), one]));
  assert.deepEqual([m.kind, m.text, m.type], ['other', '[スタンプ]', 114]);
});
test('ChatAid / AI-reply promo cards are dropped instead of shown as App-only text', () => {
  const encode = body => {
    const one = pb.enc.message(6, [pb.enc.message(4, [pb.enc.string(2, body)])]);
    return M.parseOneMsg(Buffer.concat([pb.enc.varint(1, 1), pb.enc.string(2, '2000000002'), pb.enc.string(4, '2000000001'), one]));
  };
  assert.equal(encode(JSON.stringify({type: 98, content: 'AI返信助手'})).kind, 'ignore');
  assert.equal(encode(JSON.stringify({type: 114, content: '[スタンプ]', isAi: true})).kind, 'ignore');
  assert.equal(encode(JSON.stringify({type: 0, content: 'hi', isAi: true})).kind, 'text');
  assert.equal(encode(JSON.stringify({type: 0, content: '普通消息'})).kind, 'text');
});
test('App image messages expose the official CDN url instead of raw JSON', () => {
  const encode = body => {
    const one = pb.enc.message(6, [pb.enc.message(4, [pb.enc.string(2, body)])]);
    return M.parseOneMsg(Buffer.concat([pb.enc.varint(1, 1), pb.enc.string(2, '2000000002'), pb.enc.string(4, '2000000001'), one]));
  };
  const m = encode(JSON.stringify({type: 25, content: '[图片]', extInfo: JSON.stringify({url: 'https://cdn.gravity.place/chat.png?x=1'})}));
  assert.deepEqual([m.kind, m.image, m.type], ['image', 'https://cdn.gravity.place/chat.png?x=1', 25]);
  const extra = encode(JSON.stringify({type: 25, content: '[图片]', extra: {url: 'https://cdn.gravity.place/chat.gif'}}));
  assert.equal(extra.image, 'https://cdn.gravity.place/chat.gif');
});

// ---- application packets --------------------------------------------------------------------------------------------------
test('UpPacket carries service/method/seq and keeps a 64-bit uid exact', () => {
  const packet = pb.decode(core.upPacket({service: 'IMPlusMsg', method: 'Send', seq: 105, sessionId: 'S', uid: '5000000000000000001', appId: 2, data: Buffer.from('xyz')}));
  assert.deepEqual([pb.str(packet, 1), pb.str(packet, 2), pb.str(packet, 3), pb.num(packet, 4), pb.id(packet, 5), pb.num(packet, 6)],
    ['S', 'IMPlusMsg', 'Send', 105, '5000000000000000001', 2]);
  const biz = pb.decode(pb.first(packet, 9));
  assert.equal(pb.num(biz, 1), 1);
  assert.equal(pb.first(biz, 2).toString(), 'xyz');
});
test('push parser extracts chat messages, ack ids and logout notices', () => {
  const oneMsg = Buffer.from('chat-bytes');
  const chatPush = pb.enc.message(1, [pb.enc.varint(1, 7), pb.enc.varint(2, 1),
    pb.enc.message(3, [pb.enc.varint(1, 1), pb.enc.message(2, [pb.enc.varint(1, 1), pb.enc.message(2, [pb.enc.varint(1, 1), pb.enc.bytes(2, oneMsg)])])]),
    pb.enc.bytes(4, Buffer.from('offline')), pb.enc.varint(6, 99n)]);
  const logout = pb.enc.message(1, [pb.enc.varint(1, 8), pb.enc.varint(2, 0), pb.enc.message(3, [pb.enc.varint(1, 2), pb.enc.message(3, [pb.enc.varint(1, 1)])]), pb.enc.varint(6, 100)]);
  const [chat, out] = core.parsePush(Buffer.concat([chatPush, logout]));
  assert.deepEqual([chat.kind, chat.confirm, chat.ackId, chat.hasOffline, chat.oneMsg.toString()], ['message', true, '99', true, 'chat-bytes']);
  assert.deepEqual([out.kind, out.confirm], ['logout', false]);
  assert.deepEqual(core.parsePush(Buffer.from([0xff, 0xff])), []);
  const confirm = pb.decode(core.pushConfirmRequest([chat]));
  assert.equal(confirm.length, 2); // online + offline status, as the App sends
});
test('private image content round-trips as the App type-25 detail payload', () => {
  const me = {user_id: '2000000001', name: 'n'};
  const json = M.imageContent({url: 'https://cdn.gravity.place/p.png', width: 120, height: 90, me, now: 1791443991965});
  const parsed = JSON.parse(json);
  assert.deepEqual([parsed.type, parsed.content], [25, '[图片]']);
  const detail = JSON.parse(Buffer.from(parsed.detail, 'base64').toString('utf8'));
  assert.deepEqual(detail, {url: 'https://cdn.gravity.place/p.png', width: 120, height: 90});
  const one = pb.enc.message(6, [pb.enc.message(4, [pb.enc.string(2, json)])]);
  const m = M.parseOneMsg(Buffer.concat([pb.enc.varint(1, 1), pb.enc.string(2, '2000000002'), pb.enc.string(4, '2000000001'), one]));
  assert.deepEqual([m.kind, m.image, m.type], ['image', 'https://cdn.gravity.place/p.png', 25]);
});
test('base64 detail image payloads decode like lc/c.a; plain JSON detail still works', () => {
  const encode = body => {
    const one = pb.enc.message(6, [pb.enc.message(4, [pb.enc.string(2, body)])]);
    return M.parseOneMsg(Buffer.concat([pb.enc.varint(1, 1), pb.enc.string(2, '2000000002'), pb.enc.string(4, '2000000001'), one]));
  };
  const detail = Buffer.from(JSON.stringify({url: 'https://cdn.gravity.place/d.gif', width: 10, height: 10}), 'utf8').toString('base64');
  assert.equal(encode(JSON.stringify({type: 25, content: '[图片]', detail})).image, 'https://cdn.gravity.place/d.gif');
  assert.equal(M.decodeDetail('not base64 json {}'), 'not base64 json {}');
  assert.equal(JSON.parse(M.decodeDetail(detail)).url, 'https://cdn.gravity.place/d.gif');
});
test('friend-shared voice rooms parse to clickable cards; bad channel ids stay other', () => {
  const encode = body => {
    const one = pb.enc.message(6, [pb.enc.message(4, [pb.enc.string(2, body)])]);
    return M.parseOneMsg(Buffer.concat([pb.enc.varint(1, 1), pb.enc.string(2, '2000000002'), pb.enc.string(4, '2000000001'), one]));
  };
  const room = {channel_id: '123456', name: '夜话房', is_3D: 0, label_info: '聊天', room_type: 2};
  const detail = Buffer.from(JSON.stringify(room), 'utf8').toString('base64');
  const m = encode(JSON.stringify({type: 44, content: '语音房邀请', detail}));
  assert.deepEqual([m.kind, m.room.channel_id, m.room.name, m.room.room_type], ['room', '123456', '夜话房', 2]);
  const bad = encode(JSON.stringify({type: 44, content: 'x', detail: Buffer.from(JSON.stringify({channel_id: 'abc'}), 'utf8').toString('base64')}));
  assert.equal(bad.kind, 'other');
  assert.equal(M.roomCard({type: 44}), null);
  assert.equal(M.roomCard({type: 0, detail}), null);
});

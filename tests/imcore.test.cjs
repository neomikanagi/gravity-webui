'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict'), net = require('node:net'), crypto = require('node:crypto');
const pb = require('../gravity-pb.cjs');
const maf = require('../gravity-maf.cjs');
const {ImCore} = require('../gravity-imcore.cjs');
const M = require('../gravity-im-message.cjs');

const ME = '2000000001', PEER = '2000000002';

// A tiny in-process gateway speaking the real wire protocol (server side of the handshake included).
function gateway({loginCode = 0, respond = {}} = {}) {
  const seen = [], connections = [];
  const server = net.createServer(socket => {
    connections.push(socket);
    let buffer = Buffer.alloc(0), session = null, ecdh = null, keyIndex = 0;
    const down = (seq, bizCode, data = Buffer.alloc(0), extra = {}) => Buffer.concat([
      pb.enc.string(1, extra.sessionId || 'SESSION-1'), pb.enc.varint(2, seq), pb.enc.varint(3, extra.channelCode ?? 200), pb.enc.varint(4, 5000000000000000001n), pb.enc.varint(5, 2),
      pb.enc.message(6, [pb.enc.varint(1, 2), pb.enc.varint(2, bizCode), pb.enc.bytes(3, data)]),
    ]);
    const sendApp = payload => socket.write(maf.encodeData(session, payload, maf.TYPE.APP_DOWN));
    socket.pushApp = sendApp;
    socket.down = down;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = maf.parseFrames(buffer); buffer = parsed.rest;
      for (const f of parsed.frames) {
        if (f.type === maf.TYPE.S1) {
          keyIndex = f.body[2];
          const plain = maf.aesDecrypt(maf.KEYS[keyIndex], f.body.subarray(7)).subarray(0, 1 + 4 + 29 + 4);
          assert.equal(plain[0], 1);
          ecdh = crypto.createECDH(maf.CURVE);
          const serverPub = ecdh.generateKeys();
          const secret = ecdh.computeSecret(plain.subarray(5, 5 + 29));
          session = Buffer.alloc(16); secret.copy(session);
          const body = Buffer.concat([Buffer.from([1, 1]), uint(29), serverPub, uint(16)]);
          const cipher = maf.aesEncrypt(maf.KEYS[keyIndex], body);
          socket.write(maf.frame(maf.TYPE.S2, cipher, {pad: cipher.length - body.length}));
        } else if (f.type === maf.TYPE.CHANNEL) {
          const info = maf.decodeData(session, f);
          seen.push({channelInfoBytes: info.length});
          const key = Buffer.from('CHANNELKEY==');
          socket.write(maf.encodeData(session, Buffer.concat([uint(key.length), key]), maf.TYPE.CHANNEL));
        } else if (f.type === maf.TYPE.APP) {
          const packet = pb.decode(maf.decodeData(session, f));
          const service = pb.str(packet, 2), method = pb.str(packet, 3), seq = pb.num(packet, 4);
          const biz = pb.decode(pb.first(packet, 9));
          const call = {service, method, seq, sessionId: pb.str(packet, 1), uid: pb.id(packet, 5), appId: pb.num(packet, 6), system: pb.num(packet, 8) === 1, data: pb.first(biz, 2)};
          seen.push(call);
          const custom = respond[method]?.(call, socket);
          if (custom === 'silent') continue;
          let reply;
          if (custom) reply = down(seq, custom.bizCode ?? 0, custom.data, custom);
          else if (method === 'Login') reply = down(seq, loginCode, Buffer.alloc(0));
          else if (method === 'Heartbeat') reply = down(seq, 0, pb.enc.varint(2, 1791448314000n));
          else if (method === 'Send') reply = down(seq, 0, Buffer.concat([pb.enc.varint(1, 4), pb.enc.varint(2, 1791448314905n)]));
          else reply = down(seq, 0);
          sendApp(reply);
        }
      }
    });
    socket.on('error', () => {});
  });
  const uint = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, seen, connections,
    close: () => { connections.forEach(s => s.destroy()); server.close(); },
  })));
}

function makeCore(port, options = {}) {
  return new ImCore({
    deviceToken: '0123456789abcdef0123456789abcdef@@@', credentials: async () => ({userId: ME, token: 'T'.repeat(40)}),
    createConnection: () => new maf.MafConnection({gateways: [['127.0.0.1', port]], random: () => 0}),
    requestTimeoutMs: 400, heartbeatMs: 60000, pingMs: 60000, ...options,
  });
}

test('login runs RegApp, Heartbeat, Login and an online Heartbeat with the session id, in order', async () => {
  const gw = await gateway();
  const core = makeCore(gw.port);
  try {
    await core.ready();
    const calls = gw.seen.filter(c => c.method);
    assert.deepEqual(calls.map(c => c.method), ['RegApp', 'Heartbeat', 'Login', 'Heartbeat']);
    assert.ok(calls.every(c => c.service === 'CoreSession' && c.system));
    const reg = pb.decode(calls[0].data);
    assert.equal(pb.str(reg, 1), 'n16yrnuy2s088wg');
    assert.equal(pb.str(reg, 2), 'CHANNELKEY==');
    assert.equal(pb.str(reg, 4), '6C85B1555F650400B158FBCBA7257767');
    const login = pb.decode(calls[2].data);
    assert.deepEqual([pb.str(login, 2), pb.str(login, 4).length], [ME, 40]);
    assert.equal(calls[3].sessionId, 'SESSION-1');
    assert.equal(calls[3].uid, '5000000000000000001');
    assert.equal(core.state, 'ready');
    assert.equal(core.uid, '5000000000000000001');
  } finally { core.close(); gw.close(); }
});

test('a rejected login surfaces the official codes and leaves the core idle', async () => {
  const gw = await gateway({loginCode: 10101});
  const core = makeCore(gw.port);
  try {
    await assert.rejects(core.ready(), error => error.code === 'im_login_rejected' && error.bizCode === 10101 && error.channelCode === 200);
    assert.equal(core.state, 'idle');
  } finally { core.close(); gw.close(); }
});

test('sendText writes the App OneMsg and returns the server sequence', async () => {
  const gw = await gateway();
  const core = makeCore(gw.port, {now: () => 1791448314000});
  try {
    const result = await core.sendText(PEER, '{"content":"hi"}');
    assert.deepEqual([result.seq, result.serverTime], ['4', 1791448314905]);
    const send = gw.seen.find(c => c.method === 'Send');
    assert.equal(send.service, 'IMPlusMsg');
    assert.equal(send.system, false);
    assert.equal(send.sessionId, 'SESSION-1');
    const one = M.parseOneMsg(pb.first(pb.decode(send.data), 1));
    assert.deepEqual([one.from, one.to, one.chatType, one.template, one.text], [ME, PEER, 1, 'bdim_hi_text', '{"content":"hi"}']);
    assert.equal(one.serverTime, 1791448314000); // local clock + offset learned from the Heartbeat reply
  } finally { core.close(); gw.close(); }
});

test('an explicit server refusal of a send carries bizCode; a silent server times out', async () => {
  const gw = await gateway({respond: {Send: (call, socket) => (call.data.length > 400 ? 'silent' : {bizCode: 11008})}});
  const core = makeCore(gw.port);
  try {
    await assert.rejects(core.sendText(PEER, 'x'), error => error.code === 'im_send_rejected' && error.bizCode === 11008);
    await assert.rejects(core.sendText(PEER, 'y'.repeat(600)), error => error.code === 'im_timeout');
  } finally { core.close(); gw.close(); }
});

test('pushed chat messages are emitted and acknowledged with PushConfirm; a logout push ends the session', async () => {
  const gw = await gateway();
  const core = makeCore(gw.port);
  const messages = []; let kicked = false;
  core.on('message', buffer => messages.push(buffer)); core.on('kicked', () => { kicked = true; });
  try {
    await core.ready();
    const oneMsg = Buffer.concat([pb.enc.varint(1, 1), pb.enc.string(2, PEER), pb.enc.string(4, ME)]);
    const push = (ack, onlineMsg) => pb.enc.message(1, [pb.enc.varint(1, ack), pb.enc.varint(2, 1), pb.enc.message(3, onlineMsg), pb.enc.varint(6, ack)]);
    const chat = push(41n, [pb.enc.varint(1, 1), pb.enc.message(2, [pb.enc.varint(1, 1), pb.enc.message(2, [pb.enc.varint(1, 1), pb.enc.bytes(2, oneMsg)])])]);
    const socket = gw.connections[0];
    socket.pushApp(Buffer.concat([pb.enc.string(1, 'S'), pb.enc.varint(2, 0), pb.enc.varint(3, 200), pb.enc.message(6, [pb.enc.varint(1, 3), pb.enc.varint(2, 0), pb.enc.bytes(3, chat)])]));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(messages.length, 1);
    assert.equal(M.parseOneMsg(messages[0]).from, PEER);
    const confirm = gw.seen.find(c => c.method === 'PushConfirm');
    assert.ok(confirm, 'PushConfirm sent');
    assert.deepEqual([confirm.service, confirm.system], ['CoreMsg', true]);
    assert.equal(pb.id(pb.decode(pb.first(pb.decode(confirm.data), 1)), 1), '41');
    const logout = push(42n, [pb.enc.varint(1, 2), pb.enc.message(3, [pb.enc.varint(1, 1)])]);
    socket.pushApp(Buffer.concat([pb.enc.string(1, 'S'), pb.enc.varint(2, 0), pb.enc.varint(3, 200), pb.enc.message(6, [pb.enc.varint(1, 3), pb.enc.varint(2, 0), pb.enc.bytes(3, logout)])]));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(kicked, true);
    assert.equal(core.state, 'idle');
  } finally { core.close(); gw.close(); }
});

test('losing the connection rejects in-flight requests and emits lost', async () => {
  const gw = await gateway({respond: {QueryActiveContacts: () => 'silent'}});
  const core = makeCore(gw.port, {requestTimeoutMs: 5000});
  let lost = 0; core.on('lost', () => lost++);
  try {
    await core.ready();
    const pending = core.conversations();
    await new Promise(resolve => setTimeout(resolve, 40));
    gw.connections[0].destroy();
    await assert.rejects(pending, error => error.code === 'im_not_connected');
    assert.equal(lost, 1);
    assert.equal(core.state, 'idle');
    await assert.rejects(core.history(M.chatId(ME,PEER)), error => error.code === 'im_not_connected');
    assert.equal(gw.connections.length,1,'ended core must not reopen behind a background read');
  } finally { core.close(); gw.close(); }
});

test('gateway failover: the first unreachable gateway is skipped', async () => {
  const gw = await gateway();
  const dead = net.createServer(); await new Promise(resolve => dead.listen(0, '127.0.0.1', resolve));
  const deadPort = dead.address().port; dead.close();
  const core = new ImCore({
    deviceToken: '0123456789abcdef0123456789abcdef@@@', credentials: async () => ({userId: ME, token: 'T'.repeat(40)}),
    createConnection: () => new maf.MafConnection({gateways: [['127.0.0.1', deadPort], ['127.0.0.1', gw.port]], random: () => 0}),
  });
  try { await core.ready(); assert.equal(core.state, 'ready'); } finally { core.close(); gw.close(); }
});

test('gateway failover survives a peer closing during handshake, not only connection refusal', async () => {
  const gw = await gateway(), bad = net.createServer(socket => socket.end());
  await new Promise(resolve => bad.listen(0, '127.0.0.1', resolve));
  const core = new ImCore({deviceToken:'0123456789abcdef0123456789abcdef@@@', credentials:async()=>({userId:ME,token:'T'}),
    createConnection:()=>new maf.MafConnection({gateways:[['127.0.0.1',bad.address().port],['127.0.0.1',gw.port]],random:()=>0})});
  try { await core.ready(); assert.equal(core.state,'ready'); } finally { core.close();bad.close();gw.close(); }
});

test('closing while IM credentials load cannot resurrect a connection', async () => {
  let release, created=0;
  const core=new ImCore({credentials:()=>new Promise(resolve=>{release=resolve;}),createConnection:()=>{created++;throw Error('must not dial');}});
  const pending=core.ready();core.close();release({userId:ME,token:'secret'});
  await assert.rejects(pending,e=>e.code==='im_not_connected');assert.equal(created,0);assert.equal(core.state,'idle');
});

test('malformed successful send receipt is unknown, never reported as sent', async () => {
  const gw=await gateway({respond:{Send:()=>({data:Buffer.alloc(0)})}}),core=makeCore(gw.port);
  try{await assert.rejects(core.sendText(PEER,'hi'),e=>e.code==='im_send_unconfirmed');}finally{core.close();gw.close();}
});

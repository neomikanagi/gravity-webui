'use strict';
// Native IM session over the maf transport: RegApp -> Heartbeat -> Login, then request/response + push.
// Wire messages mirror the App's com.gclub.im.frame.pb (field numbers from the decompiled classes).
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const pb = require('./gravity-pb.cjs');
const {MafConnection} = require('./gravity-maf.cjs');

const API_KEY = 'n16yrnuy2s088wg';                       // IMPlusSDK.init in App.onCreate
const SIGN = '6C85B1555F650400B158FBCBA7257767';        // N5.s.f7247a default
const APP_VERSION = '15.2.1', SDK_VERSION = 'AND_1.2.0.0';
const SERVICE = {CORE_SESSION: 'CoreSession', CORE_MSG: 'CoreMsg', MSG: 'IMPlusMsg'};
const CHAT_USER = 1;

class ImCoreError extends Error {
  constructor(code, message, status = 502, detail = {}) { super(message || code); this.code = code; this.status = status; Object.assign(this, detail); }
}

const kv = (key, data) => pb.enc.message(1, [pb.enc.string(1, key), pb.enc.string(2, data)]);
function bizPackage(data) { return pb.enc.message(9, [pb.enc.varint(1, 1), pb.enc.bytes(2, data)]); }

function upPacket({service, method, seq, sessionId = '', uid = '0', appId = 0, data, system = false, bua = true}) {
  const parts = [];
  if (sessionId) parts.push(pb.enc.string(1, sessionId));
  parts.push(pb.enc.string(2, service), pb.enc.string(3, method), pb.enc.varint(4, seq));
  if (uid && String(uid) !== '0') parts.push(pb.enc.varint(5, BigInt(uid)));
  if (appId) parts.push(pb.enc.varint(6, appId));
  if (bua) parts.push(pb.enc.message(7, [pb.enc.string(1, APP_VERSION), pb.enc.varint(2, 50), pb.enc.varint(3, 50)]));
  parts.push(pb.enc.bool(8, system), bizPackage(data));
  return Buffer.concat(parts);
}

function parseDown(buffer) {
  const f = pb.decode(buffer);
  const biz = pb.first(f, 6);
  const b = Buffer.isBuffer(biz) ? pb.decode(biz) : [];
  return {
    sessionId: pb.str(f, 1), seq: pb.num(f, 2), channelCode: pb.num(f, 3), uid: pb.id(f, 4), appId: pb.num(f, 5),
    packetType: pb.num(b, 1), bizCode: pb.num(b, 2), data: pb.first(b, 3) || Buffer.alloc(0),
  };
}

// DownPacket(type NOTIFICATION) -> PushMsgs -> PushOneMsg -> PushData -> NormalMessage -> ImPushData -> OneMsg.
const PUSH = {NORMAL: 1, SYS_NOTIFY: 2, CHAT_MSG: 1, LOGOUT_NOTIFY: 1};
function parsePush(data) {
  const items = [];
  let list;
  try { list = pb.all(pb.decode(data), 1); } catch { return items; }
  for (const raw of list) {
    try {
      const one = pb.decode(raw);
      const item = {ackId: pb.id(one, 6), confirm: pb.num(one, 2) === 1, hasOffline: Buffer.isBuffer(pb.first(one, 4)), kind: 'other'};
      const online = pb.first(one, 3);
      if (Buffer.isBuffer(online)) {
        const pushData = pb.decode(online);
        const type = pb.num(pushData, 1);
        if (type === PUSH.NORMAL) {
          const normal = pb.first(pushData, 2);
          const im = Buffer.isBuffer(normal) ? pb.first(pb.decode(normal), 2) : null;
          if (Buffer.isBuffer(im)) {
            const imPush = pb.decode(im);
            if (pb.num(imPush, 1) === PUSH.CHAT_MSG && Buffer.isBuffer(pb.first(imPush, 2))) Object.assign(item, {kind: 'message', oneMsg: pb.first(imPush, 2)});
          }
        } else if (type === PUSH.SYS_NOTIFY) {
          const notify = pb.first(pushData, 3);
          if (Buffer.isBuffer(notify) && pb.num(pb.decode(notify), 1) === PUSH.LOGOUT_NOTIFY) item.kind = 'logout';
        }
      }
      items.push(item);
    } catch {}
  }
  return items;
}
const pushConfirmRequest = items => Buffer.concat(items.flatMap(i => [
  pb.enc.message(1, [pb.enc.varint(1, BigInt(i.ackId || 0)), pb.enc.varint(2, 1)]),
  i.hasOffline ? pb.enc.message(1, [pb.enc.varint(1, BigInt(i.ackId || 0)), pb.enc.varint(3, 1)]) : null,
].filter(Boolean)));

const regAppRequest = ({channelKey, deviceToken}) => Buffer.concat([
  pb.enc.string(1, API_KEY), pb.enc.string(2, channelKey),
  pb.enc.message(3, [pb.enc.string(1, deviceToken), pb.enc.varint(2, 0), pb.enc.string(3, 'Pixel 7'), pb.enc.string(4, ''),
    pb.enc.string(5, '0'), pb.enc.varint(6, 8)]),
  pb.enc.string(4, SIGN),
  pb.enc.message(5, [pb.enc.varint(1, 8), pb.enc.string(2, 'Pixel 7'), pb.enc.string(3, 'Android 13'), pb.enc.string(4, '1'),
    pb.enc.string(6, '1080x2400'), pb.enc.string(7, 'Google'), pb.enc.string(8, '6.3')]),
]);
const loginRequest = ({channelKey, userId, token, lang = 'ja'}) => Buffer.concat([
  pb.enc.string(1, channelKey), pb.enc.string(2, userId), pb.enc.string(4, token),
  kv('systemLang', lang), kv('lang', lang), kv('country', 'JP'),
]);
const heartbeatRequest = ({channelKey, appId, sessionId}) => Buffer.concat([
  pb.enc.string(1, channelKey),
  pb.enc.message(3, [pb.enc.varint(1, appId), sessionId ? pb.enc.string(2, sessionId) : null, pb.enc.bool(3, false)]),
]);

// One OneMsg text message, field for field as BDHiIMTextMessage -> OneMsgConverter writes it (set* fields are always serialized).
function textMessage({fromId, toId, text, clientMsgId, serverNow}) {
  const ms = BigInt(serverNow);
  return pb.enc.message(1, [
    pb.enc.varint(1, CHAT_USER), pb.enc.string(2, fromId), pb.enc.string(3, fromId), pb.enc.string(4, toId), pb.enc.varint(5, 0),
    pb.enc.message(6, [pb.enc.message(4, [pb.enc.string(1, 'text_0'), pb.enc.string(2, text), pb.enc.string(3, ''), pb.enc.string(4, ''), pb.enc.string(5, '')])]),
    pb.enc.string(7, ''), pb.enc.varint(8, ms), pb.enc.varint(9, ms), pb.enc.bool(10, false),
    pb.enc.string(12, 'bdim_hi_text'), pb.enc.varint(13, BigInt(clientMsgId)), pb.enc.string(14, ''), pb.enc.string(15, ''),
    pb.enc.varint(16, 0), pb.enc.string(17, ''),
  ]);
}

class ImCore extends EventEmitter {
  constructor({credentials, deviceToken, createConnection = () => new MafConnection(), now = Date.now,
    requestTimeoutMs = 12000, heartbeatMs = 45000, pingMs = 25000} = {}) {
    super();
    Object.assign(this, {credentials, deviceToken, createConnection, now, requestTimeoutMs, heartbeatMs, pingMs});
    this.state = 'idle'; this.conn = null; this.seq = 100; this.pending = new Map();
    this.appId = 0; this.uid = '0'; this.sessionId = ''; this.userId = ''; this.opening = null; this.timers = [];
    this.timeOffset = 0; this.messageCounter = crypto.randomInt(0, 1 << 16); this.epoch = 0; this.stopped = false;
  }

  ready() {
    if (this.stopped) return Promise.reject(new ImCoreError('im_not_connected', 'IM session ended; explicit reconnect required', 503));
    if (this.state === 'ready') return Promise.resolve();
    return this.opening ||= this.#open().finally(() => { this.opening = null; });
  }

  async #open() {
    this.state = 'connecting';
    const epoch = ++this.epoch;
    try {
      const {userId, token} = await this.credentials();
      if (epoch !== this.epoch) throw new ImCoreError('im_not_connected', 'IM opening cancelled', 503);
      const conn = this.conn = this.createConnection();
      conn.on('payload', payload => this.#onPayload(payload));
      conn.on('error', () => {});
      conn.once('close', () => this.#lost(conn));
      await conn.open({deviceToken: this.deviceToken});
      if (epoch !== this.epoch) throw new ImCoreError('im_not_connected', 'IM opening cancelled', 503);
      const reg = await this.#call(SERVICE.CORE_SESSION, 'RegApp', regAppRequest({channelKey: conn.channelKey, deviceToken: this.deviceToken}), {system: true});
      this.#check('RegApp', reg);
      this.appId = reg.appId;
      await this.#call(SERVICE.CORE_SESSION, 'Heartbeat', heartbeatRequest({channelKey: conn.channelKey, appId: this.appId}), {system: true})
        .then(r => { this.#check('Heartbeat', r); this.#syncClock(r); });
      const login = await this.#call(SERVICE.CORE_SESSION, 'Login', loginRequest({channelKey: conn.channelKey, userId, token}), {system: true});
      this.#check('Login', login);
      this.userId = userId; this.uid = login.uid || '0'; this.sessionId = login.sessionId;
      // The App heartbeats once more with the session id; without it the session stays SESSION_OFFLINE (10110).
      const online = await this.#call(SERVICE.CORE_SESSION, 'Heartbeat',
        heartbeatRequest({channelKey: conn.channelKey, appId: this.appId, sessionId: this.sessionId}), {system: true});
      this.#check('Heartbeat', online); this.#syncClock(online);
      if (epoch !== this.epoch) throw new ImCoreError('im_not_connected', 'IM opening cancelled', 503);
      this.state = 'ready';
      this.timers.push(setInterval(() => this.#heartbeat(), this.heartbeatMs), setInterval(() => conn.ping(), this.pingMs));
      this.timers.forEach(t => t.unref?.());
      this.emit('ready');
    } catch (error) {
      if (epoch === this.epoch) this.#teardown();
      throw error instanceof ImCoreError ? error : new ImCoreError(error.code || 'im_unavailable', error.message, 502);
    }
  }

  // HeartbeatResp.timestamp (field 2) is the server clock; the App adds the offset to every message time.
  #syncClock(reply) {
    try { const t = pb.num(pb.decode(reply.data), 2); if (t > 0) this.timeOffset = t - this.now(); } catch {}
  }

  #check(step, r) {
    // channelCode 200 = Channel success (N5.b.c), bizCode 0 = SESSION_SUCCESS.
    if (r.channelCode !== 200 || r.bizCode !== 0) {
      throw new ImCoreError(`im_${step.toLowerCase()}_rejected`, `IM ${step} rejected`, 502, {channelCode: r.channelCode, bizCode: r.bizCode});
    }
  }

  #call(service, method, data, {system = false, timeoutMs = this.requestTimeoutMs} = {}) {
    const seq = ++this.seq > 9999 ? (this.seq = 101) : this.seq;
    const packet = upPacket({service, method, seq, sessionId: this.sessionId, uid: this.uid, appId: this.appId, data, system});
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new ImCoreError('im_timeout', 'IM request timed out', 504)); }, timeoutMs);
      this.pending.set(seq, {resolve: r => { clearTimeout(timer); resolve(r); }, reject: e => { clearTimeout(timer); reject(e); }});
      try { this.conn.send(packet); } catch (error) { this.pending.delete(seq); clearTimeout(timer); reject(new ImCoreError('im_not_connected', error.message, 503)); }
    });
  }

  #onPayload(payload) {
    let packet;
    try { packet = parseDown(payload); } catch { return; }
    const waiter = packet.packetType === 2 ? this.pending.get(packet.seq) : null;
    if (waiter) { this.pending.delete(packet.seq); waiter.resolve(packet); return; }
    if (packet.packetType === 3 && packet.channelCode === 200 && packet.bizCode === 0) this.#onPush(packet);
  }

  #onPush(packet) {
    const items = parsePush(packet.data);
    const confirm = items.filter(i => i.confirm && i.ackId);
    if (confirm.length && this.state === 'ready') {
      // The App acknowledges every push (official ones too); otherwise the server redelivers them on each login.
      this.#call(SERVICE.CORE_MSG, 'PushConfirm', pushConfirmRequest(confirm), {system: true}).catch(() => {});
    }
    for (const item of items) {
      if (item.kind === 'message') this.emit('message', item.oneMsg);
      else if (item.kind === 'logout') { this.emit('kicked'); this.#teardown(); return; }
    }
  }

  #heartbeat() {
    if (this.state !== 'ready') return;
    const conn = this.conn;
    this.#call(SERVICE.CORE_SESSION, 'Heartbeat', heartbeatRequest({channelKey: conn.channelKey, appId: this.appId, sessionId: this.sessionId}), {system: true})
      .then(r => { if (r.channelCode !== 200 || r.bizCode !== 0) this.#lost(conn); else if (conn === this.conn) this.#syncClock(r); }, () => this.#lost(conn));
  }

  async request(service, method, data, options) {
    await this.ready();
    return this.#call(service, method, data, options);
  }
  async conversations(limit = 50) {
    const reply = await this.request(SERVICE.MSG, 'QueryActiveContacts', Buffer.concat([pb.enc.varint(1, 0), pb.enc.varint(2, limit), pb.enc.varint(3, 1), pb.enc.varint(4, 0)]));
    this.#check('QueryActiveContacts', reply);
    const f = pb.decode(reply.data);
    return pb.all(f, 2).map(raw => { const c = pb.decode(raw); return {chatType: pb.num(c, 1), chatId: pb.str(c, 2), lastSeq: pb.id(c, 3), lastTime: pb.num(c, 4)}; });
  }
  // Latest `count` messages of one user chat (chatId "<small>:<large>"); returns raw OneMsg buffers, oldest first as the server sends them.
  async history(chatId, count = 30) {
    const range = pb.enc.message(1, [pb.enc.varint(1, CHAT_USER), pb.enc.string(2, chatId), pb.enc.varint(3, 0), pb.enc.varint(4, (1n << 63n) - 1n), pb.enc.varint(5, count)]);
    const reply = await this.request(SERVICE.MSG, 'QueryMsgs', Buffer.concat([range, pb.enc.varint(3, 0)]));
    this.#check('QueryMsgs', reply);
    return pb.all(pb.decode(reply.data), 1);
  }
  async sendText(toId, text) {
    await this.ready();
    const serverNow = this.now() + this.timeOffset;
    // MessageIDGenerator: (ms << 20) + counter
    const clientMsgId = (BigInt(this.now()) << 20n) + BigInt(++this.messageCounter);
    const reply = await this.#call(SERVICE.MSG, 'Send', textMessage({fromId: this.userId, toId, text, clientMsgId, serverNow}));
    this.#check('Send', reply);
    const f = pb.decode(reply.data);
    if (!pb.id(f, 1) || !pb.num(f, 2)) throw new ImCoreError('im_send_unconfirmed', 'IM receipt incomplete', 504);
    return {seq: pb.id(f, 1), serverTime: pb.num(f, 2), clientMsgId: String(clientMsgId)};
  }

  #lost(conn) {
    if (!conn || conn !== this.conn) return;
    this.#teardown();
    this.emit('lost');
  }
  #teardown() {
    this.stopped = true; ++this.epoch;
    this.timers.splice(0).forEach(clearInterval);
    const conn = this.conn; this.conn = null; this.state = 'idle';
    this.appId = 0; this.uid = '0'; this.sessionId = '';
    this.pending.forEach(p => p.reject(new ImCoreError('im_not_connected', 'IM connection closed', 503)));
    this.pending.clear();
    try { conn?.close(); } catch {}
  }
  close() { this.#teardown(); }
}

module.exports = {ImCore, ImCoreError, upPacket, parseDown, parsePush, pushConfirmRequest, regAppRequest, loginRequest, heartbeatRequest, textMessage, SERVICE, API_KEY, SIGN};

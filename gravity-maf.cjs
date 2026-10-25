'use strict';
// Native IM transport ("maf://", frames start with "HiV2"): ECDH(secp112r2) handshake, AES-ECB, zlib.
// Layout derived from libhichannel-jni.so and checked against the live gateway; see docs/IM_PROTOCOL.md.
const net = require('node:net');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {EventEmitter} = require('node:events');

const MAGIC = Buffer.from('HiV2');
const HEADER = 16;
const MAX_BODY = 0xfff0;            // native Maf::write limit
// 8 = channel info exchange right after the handshake; application packets: 5 = client->server UpPacket, 6 = server->client DownPacket.
const TYPE = {S1: 1, S2: 2, APP: 5, APP_DOWN: 6, PING: 7, CHANNEL: 8};
const FLAG_VERSION = 0x10, FLAG_ENCRYPTED = 0x100, FLAG_COMPRESSED = 0x200;
const CURVE = 'secp112r2';          // CreateECDHAlgorithm(1) -> NID 705
const ECDH_INDEX = 1;
const GATEWAYS = [
  ['54.238.70.11', 80], ['35.75.175.91', 80], ['35.76.196.134', 80],
  ['3.113.239.19', 8001], ['18.181.9.55', 8001], ['35.75.35.75', 8001],
];
const KEYS = require('./gravity-maf-keys.json').map(hex => Buffer.from(hex, 'hex'));

class MafError extends Error { constructor(code, message) { super(message || code); this.code = code; } }

const zeroPad = data => data.length % 16 ? Buffer.concat([data, Buffer.alloc(16 - data.length % 16)]) : data;
function aesEcb(key, data, decrypt) {
  const algorithm = key.length === 32 ? 'aes-256-ecb' : 'aes-128-ecb';
  const cipher = (decrypt ? crypto.createDecipheriv : crypto.createCipheriv)(algorithm, key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
const aesEncrypt = (key, plain) => aesEcb(key, zeroPad(plain), false);
const aesDecrypt = (key, cipher) => {
  if (cipher.length % 16) throw new MafError('bad_cipher_length');
  return aesEcb(key, cipher, true);
};

// word2 layout (big endian): [3:0] type, bit4 version, bit8 encrypted, bit9 compressed, [13:10] zero padding added by AES.
function frame(type, body, {pad = 0, encrypted = false, compressed = false, tail = 0} = {}) {
  if (body.length > MAX_BODY) throw new MafError('frame_too_large');
  const header = Buffer.alloc(HEADER);
  MAGIC.copy(header, 0);
  header.writeUInt32BE(body.length, 4);
  header.writeUInt32BE(((pad & 15) << 10) | (compressed ? FLAG_COMPRESSED : 0) | (encrypted ? FLAG_ENCRYPTED : 0) | FLAG_VERSION | type, 8);
  header.writeUInt32LE(tail >>> 0, 12);
  return Buffer.concat([header, body]);
}

// Split a receive buffer into complete frames; returns the unconsumed remainder.
function parseFrames(buffer) {
  const frames = [];
  let pos = 0;
  while (buffer.length - pos >= HEADER) {
    if (!buffer.subarray(pos, pos + 4).equals(MAGIC)) throw new MafError('bad_magic');
    const length = buffer.readUInt32BE(pos + 4);
    if (length > 0x100000) throw new MafError('frame_too_large');
    if (buffer.length - pos - HEADER < length) break;
    const word2 = buffer.readUInt32BE(pos + 8);
    frames.push({
      type: word2 & 15, encrypted: !!(word2 & FLAG_ENCRYPTED), compressed: !!(word2 & FLAG_COMPRESSED),
      pad: (word2 >> 10) & 15, body: buffer.subarray(pos + HEADER, pos + HEADER + length),
    });
    pos += HEADER + length;
  }
  return {frames, rest: buffer.subarray(pos)};
}

function s1Frame(keyIndex, publicKey) {
  const plain = Buffer.concat([Buffer.from([ECDH_INDEX]), u32(publicKey.length), publicKey, Buffer.from([1, 1, 1, 1])]);
  const cipher = aesEncrypt(KEYS[keyIndex], plain);
  const body = Buffer.concat([Buffer.from([1, 1, keyIndex]), u32(cipher.length), cipher]);
  return frame(TYPE.S1, body, {pad: cipher.length - plain.length});
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }

// S2 plaintext: 01 01 | u32 len | server public key | u32 session key length.
function readS2(keyIndex, f, ecdh) {
  if (f.type !== TYPE.S2) throw new MafError('handshake_unexpected_frame');
  const plain = aesDecrypt(KEYS[keyIndex], f.body).subarray(0, f.body.length - f.pad);
  if (plain.length < 10 || plain[0] !== 1) throw new MafError('handshake_rejected');
  const keyLength = plain.readUInt32BE(2);
  if (keyLength > plain.length - 10) throw new MafError('handshake_malformed');
  const serverKey = plain.subarray(6, 6 + keyLength);
  const sessionLength = plain.readUInt32BE(6 + keyLength);
  if (![16, 24, 32].includes(sessionLength)) throw new MafError('handshake_malformed');
  const secret = ecdh.computeSecret(serverKey);
  const key = Buffer.alloc(sessionLength);
  secret.copy(key, 0, 0, Math.min(secret.length, sessionLength));
  return key;
}

// Data frame <-> payload using the negotiated session key.
function encodeData(sessionKey, payload, type = TYPE.APP, tail = 0) {
  const deflated = zlib.deflateSync(payload);
  const cipher = aesEncrypt(sessionKey, deflated);
  return frame(type, cipher, {pad: cipher.length - deflated.length, encrypted: true, compressed: true, tail});
}
function decodeData(sessionKey, f) {
  let body = f.body;
  if (f.encrypted) body = aesDecrypt(sessionKey, body).subarray(0, body.length - f.pad);
  if (f.compressed) body = zlib.inflateSync(body, {maxOutputLength: 2 * 1024 * 1024});
  return body;
}

// Device block sent right after the handshake (ChannelInfoImpl, layout observed from the native client).
function channelInfo({channelKey = '', extraInfo = '', deviceToken, apn = 1, network = 1, os = 'Android 13', sdk = 'AND_1.2.0.0'}) {
  const s = value => { const b = Buffer.from(value, 'utf8'); return Buffer.concat([u32(b.length), b]); };
  return Buffer.concat([s(channelKey), s(extraInfo), s(deviceToken), Buffer.from([apn, network]), s(os), s(sdk)]);
}

class MafConnection extends EventEmitter {
  constructor({gateways = GATEWAYS, connect = net.connect, random = crypto.randomInt, connectTimeoutMs = 6000, stepTimeoutMs = 8000} = {}) {
    super();
    Object.assign(this, {gateways, dial: connect, random, connectTimeoutMs, stepTimeoutMs});
    this.socket = null; this.sessionKey = null; this.buffer = Buffer.alloc(0); this.pingSeq = 0; this.closed = false;
    this.waiters = []; this.queued = []; this.cancelled = false; this.established = false;
  }
  static get TYPE() { return TYPE; }

  async open(device) {
    const errors = [];
    const start = this.random(0, this.gateways.length);
    for (let i = 0; i < this.gateways.length; i++) {
      const [host, port] = this.gateways[(start + i) % this.gateways.length];
      if (this.cancelled) throw new MafError('connection_closed');
      try { await this.#session(host, port, device); return {host, port}; }
      catch (error) { errors.push(error.code || error.message); this.#drop(); }
      if (this.cancelled) throw new MafError('connection_closed');
    }
    throw new MafError('gateway_unavailable', errors.join(','));
  }

  async #session(host, port, device) {
    await this.#dial(host, port);
    const ecdh = crypto.createECDH(CURVE);
    const publicKey = ecdh.generateKeys();
    const keyIndex = this.random(0, KEYS.length);
    this.socket.write(s1Frame(keyIndex, publicKey));
    this.sessionKey = readS2(keyIndex, await this.#nextFrame(), ecdh);
    this.socket.write(encodeData(this.sessionKey, channelInfo(device), TYPE.CHANNEL));
    const reply = decodeData(this.sessionKey, await this.#nextFrame());
    const length = reply.length >= 4 ? reply.readUInt32BE(0) : 0;
    if (!length || length > reply.length - 4) throw new MafError('channel_rejected');
    this.channelKey = reply.subarray(4, 4 + length).toString('utf8'); this.established = true;
    this.socket.removeAllListeners('data');
    this.socket.on('data', chunk => this.#onData(chunk));
    const early = this.queued.splice(0);
    early.forEach(f => this.#handleFrame(f));
    if (this.buffer.length) this.#onData(Buffer.alloc(0));
  }

  #dial(host, port) {
    return new Promise((resolve, reject) => {
      this.closed = false; this.sessionKey = null; this.established = false;
      this.buffer = Buffer.alloc(0); this.waiters = []; this.queued = [];
      const socket = this.socket = this.dial({host, port});
      const timer = setTimeout(() => socket.destroy(new MafError('connect_timeout')), this.connectTimeoutMs);
      socket.setNoDelay?.(true);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.on('error', error => { clearTimeout(timer); reject(error); });
      socket.on('data', chunk => { if (socket === this.socket) this.#collect(chunk); });
      socket.on('close', () => {
        clearTimeout(timer); reject(new MafError('connection_closed'));
        if (socket === this.socket) this.#closed();
      });
    });
  }
  // Handshake phase: frames are pulled one at a time.
  #collect(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      const {frames, rest} = parseFrames(this.buffer);
      this.buffer = rest;
      for (const f of frames) { const waiter = this.waiters.shift(); if (waiter) waiter.resolve(f); else this.queued.push(f); }
    } catch (error) { this.waiters.splice(0).forEach(w => w.reject(error)); this.socket?.destroy(); }
  }
  #nextFrame() {
    if (this.queued.length) return Promise.resolve(this.queued.shift());
    return new Promise((resolve, reject) => {
      const waiter = {resolve: f => { clearTimeout(timer); resolve(f); }, reject: e => { clearTimeout(timer); reject(e); }};
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1);
        reject(new MafError('handshake_timeout'));
      }, this.stepTimeoutMs);
      this.waiters.push(waiter);
    });
  }
  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let parsed;
    try { parsed = parseFrames(this.buffer); } catch (error) { this.emit('error', error); this.close(); return; }
    this.buffer = parsed.rest;
    parsed.frames.forEach(f => this.#handleFrame(f));
  }
  #handleFrame(f) {
    this.emit('frame', f.type, f.body.length);
    if (f.type !== TYPE.APP_DOWN && f.type !== TYPE.APP) return;
    try { this.emit('payload', decodeData(this.sessionKey, f)); } catch (error) { this.emit('error', error); }
  }
  #closed() { this.waiters.splice(0).forEach(w => w.reject(new MafError('connection_closed'))); if (!this.closed) { this.closed = true; if (this.established) this.emit('close'); } }
  #drop() {
    this.waiters.splice(0).forEach(w => w.reject(new MafError('connection_closed')));
    const socket = this.socket; this.socket = null; socket?.destroy(); this.queued = []; this.sessionKey = null;
  }

  send(payload) {
    if (!this.socket || this.socket.destroyed || !this.sessionKey) throw new MafError('not_connected');
    this.socket.write(encodeData(this.sessionKey, payload));
  }
  ping() {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(frame(TYPE.PING, Buffer.alloc(0), {tail: ++this.pingSeq}).subarray(0, HEADER));
  }
  close() { this.cancelled = true; const notify = !this.closed; this.closed = true; this.#drop(); if (notify) this.emit('close'); }
}

module.exports = {
  MafConnection, MafError, GATEWAYS, KEYS, TYPE, CURVE,
  aesEncrypt, aesDecrypt, frame, parseFrames, s1Frame, readS2, encodeData, decodeData, channelInfo,
};

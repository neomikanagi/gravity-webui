'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const api = require('./gravity-api.cjs');
const {APP_ID, tokenPrivileges} = require('./static/controller.js');
const {loadSessionToken} = require('./gravity-sign-ios.cjs');
const {createSerial} = require('./gravity-util.cjs');
// Public verification key from Android Ka/c.java (VoiceRoomSeatDataValidator).
const SEAT_KEY = crypto.createPublicKey({format:'der', type:'spki', key:Buffer.from(
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDSQBf/lkom/I0e/K8ALluii0BmtX7ApBegYwlckxOPHRSYyCHWf+yEyLmqg9pzXy3edzzcSK+TRwDFaspZcAW6hTLuxK5FEJvRxCRVmkv/i9JU1AG0F9/wR1AzAMHYIrJeEXYwQGZw3vSys5l/debvUDhiQ6P7/mC3FPY+Ty8u3QIDAQAB', 'base64')});
class OwnerError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
function exactId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new OwnerError('官方身份字段不完整，未接管。');
  const text = String(value ?? '0');
  if (!/^(0|[1-9][0-9]{0,19})$/.test(text)) throw new OwnerError('官方身份字段不完整，未接管。');
  return text;
}
function canonicalSeats(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 64) throw new OwnerError('官方席位数据不完整，未接管。');
  return '{"list":[' + rows.map(row => {
    if (!Number.isSafeInteger(row.seat_id) || row.seat_id < 0 || row.seat_id > 63 || ![0,1].includes(row.mute_type)) throw new OwnerError('官方席位数据不完整，未接管。');
    return `{"user_id":${exactId(row.user?.user_id)},"seat_id":${row.seat_id},"mute_type":${row.mute_type}}`;
  }).join(',') + ']}';
}
function verifySeats(data, key = SEAT_KEY) {
  try {
    const digest = crypto.createHash('md5').update(canonicalSeats(data?.anchor_user_list)).digest('hex');
    const reportedDigestVerified = /^[a-f0-9]{32}$/.test(data.anchor_list_sign) && typeof data.verify_sign === 'string' &&
      /^[A-Za-z0-9+/=\r\n]{64,1024}$/.test(data.verify_sign) &&
      crypto.verify('RSA-SHA256', Buffer.from(data.anchor_list_sign), key, Buffer.from(data.verify_sign, 'base64'));
    // iOS response serialization differs from Android's canonical JSON. RSA verifies the reported
    // digest only; the payload's authority is the fixed official HTTPS response, not this digest.
    return {reportedDigestVerified, payloadMatches:reportedDigestVerified && digest === data.anchor_list_sign};
  } catch { return {reportedDigestVerified:false, payloadMatches:false}; }
}
// Native RcCloudInfo.uidToRcId swaps the low and third bytes; it is not the App user ID.
function rtcUid(userId) {
  const n = BigInt(userId);
  return Number(((n & 0xff000000n) | ((n & 255n) << 16n) | (n & 65280n) | ((n >> 16n) & 255n)) & 0xffffffffn);
}
function crc32(text) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(String(text))) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function validPublisherToken(token, channel, uid, now = Date.now()) {
  try {
    const p = tokenPrivileges(token);
    if (token?.slice(3,35) !== APP_ID || !p.known || !p.declaresJoin || !p.declaresPublishAudio) return false;
    const bytes = Buffer.from(token.slice(35), 'base64');
    const offset = 2 + bytes.readUInt16LE(0);
    if (bytes.readUInt32LE(offset) !== crc32(channel) || bytes.readUInt32LE(offset+4) !== crc32(uid)) return false;
    const start = offset + 10, count = bytes.readUInt16LE(start+8);
    const required = new Map();
    for (let i=0; i<count; i++) required.set(bytes.readUInt16LE(start+10+i*6), bytes.readUInt32LE(start+12+i*6));
    return [1,2].every(privilege => required.get(privilege) > now/1000 + 30);
  } catch { return false; }
}
function loadOwnerScope() {
  try {
    const session = JSON.parse(fs.readFileSync(path.join(__dirname, '.session/www-token.json')));
    const room = JSON.parse(fs.readFileSync(path.join(__dirname, '.session/owned-test-room.json')));
    if (session.token !== loadSessionToken() || !id(session.user_id) || !id(room.channel_id) || room.anchor_id !== session.user_id) return null;
    return {channel:room.channel_id, owner:session.user_id, identity:api.sessionIdentity(session.token)};
  } catch { return null; }
}
function createOwnerService({scope = loadOwnerScope, read = api.readSignedVoice, write = api.writeOwnerMute,
  key = SEAT_KEY, now = Date.now, timers = globalThis} = {}) {
  let permit = null;
  const serial = createSerial(8, () => new OwnerError('房主操作正在处理，请稍后重试。'));
  function context(channel) {
    const current = scope();
    if (!current || !id(channel) || channel !== current.channel) throw new OwnerError('接管只对已授权的自建房开放；不会连接其他房主席位。', 403);
    return current;
  }
  function authorize(channel, proof, cleanup = false) {
    const current = context(channel);
    if (!permit || proof !== permit.proof || permit.identity !== current.identity || permit.channel !== channel || (!cleanup && (permit.cleanupPending || permit.expires <= now()))) {
      throw new OwnerError('接管授权已失效，请停止并重新手动连接。', 403);
    }
    return current;
  }
  function armWatchdog(request) {
    const current = permit;
    current.generation = (current.generation || 0) + 1;
    const generation = current.generation;
    current.expires = now() + 90_000;
    timers.clearTimeout(current.timer);
    current.timer = timers.setTimeout(() => { void expirePermit(current, request, generation); }, 90_000);
    current.timer.unref?.();
  }
  // Watchdog must re-check expiry after the serial lock: a slow status inspect can outlive the
  // original timer, renew, and must not be killed by the stale timeout. Failed remute retries
  // instead of leaving an expired permit blocking connect forever.
  function expirePermit(current, request, generation) {
    const work = serial(async () => {
      if (permit !== current || current.generation !== generation || current.expires > now()) return;
      if (current.unmuted) await setMute(current.channel, true, request, current.proof, false);
      if (permit === current && current.generation === generation) {
        timers.clearTimeout(current.timer);
        permit = null;
      }
    });
    work.catch(() => {
      if (permit !== current || current.generation !== generation) return;
      timers.clearTimeout(current.timer);
      current.timer = timers.setTimeout(() => { void expirePermit(current, request, generation); }, 1000);
      current.timer.unref?.();
    });
  }
  async function inspect(channel, request) {
    const current = context(channel);
    const info = await read('roomInfo', {channel_id:channel}, request);
    const room = info.data?.room_info;
    if (info.errno !== 0 || room?.channel_id !== channel || exactId(room?.user_id) !== current.owner) throw new OwnerError('自建房已关闭或账号权限已变化，未接管。');
    const seats = await read('seats', {channel_id:channel}, request);
    const verification = verifySeats(seats.data, key);
    if (seats.errno !== 0 || !verification.reportedDigestVerified) throw new OwnerError('官方席位签名校验未通过，未接管。');
    if (scope()?.identity !== current.identity) throw new OwnerError('App 会话已变化，未接管。');
    const occupied = seats.data.anchor_user_list.filter(row => exactId(row.user?.user_id) !== '0');
    const own = occupied.filter(row => exactId(row.user?.user_id) === current.owner);
    if (own.length !== 1 || own[0].seat_id !== 0) throw new OwnerError('房主席位已失去，未接管。');
    return {current, seat:own[0], occupied:occupied.length, verification};
  }
  function publicState(result) {
    return {eligible:true, mode:'owner-test', seat_id:result.seat.seat_id, muted:result.seat.mute_type === 1,
      occupied_seats:result.occupied, seat_provenance:'official-tls', reported_digest_rsa_verified:true,
      seat_payload_digest_verified:result.verification.payloadMatches, standalone_room_verified:false};
  }
  const status = (channel, request, proof) => serial(async () => {
    if (proof) authorize(channel, proof);
    const result = await inspect(channel, request);
    if (proof) armWatchdog(request);
    return publicState(result);
  });
  const connect = (channel, request) => serial(async () => {
    if (permit && permit.expires > now()) throw new OwnerError('另一个网页接管仍有效，请先停止该连接，或等待授权超时清理。');
    if (permit) {
      const stale = permit;
      if (stale.unmuted) await setMute(stale.channel, true, request, stale.proof, false);
      if (permit === stale) { timers.clearTimeout(stale.timer); permit = null; }
    }
    const result = await inspect(channel, request);
    if (result.seat.mute_type !== 1) throw new OwnerError('请先在 App 将房主席位静音，再确认接管。');
    const token = await read('ownerToken', {channel_id:channel, role_type:'1'}, request);
    const uid = Number(token.data?.uid), rtc = token.data?.rtc_token;
    if (token.errno !== 0 || uid !== rtcUid(result.current.owner) || uid < 1 || !validPublisherToken(rtc, channel, uid, now()) || scope()?.identity !== result.current.identity) {
      throw new OwnerError('房主发布凭证与账号、房间或有效期不匹配，未连接。');
    }
    permit = {proof:crypto.randomUUID(), identity:result.current.identity, channel, expires:now()+90_000, unmuted:false, generation:0};
    armWatchdog(request);
    return {...publicState(result), rtc_token:rtc, user_id:uid, owner_permit:permit.proof, publishing_available:true};
  });
  async function setMute(channel, muted, request, proof, renewWatchdog = true) {
    authorize(channel, proof, muted);
    const result = await inspect(channel, request);
    if (!muted) permit.unmuted = true; // Mark before request; a timeout is not proof it wasn't applied.
    if (result.seat.mute_type !== (muted ? 1 : 0)) {
      const updated = await write({channel_id:channel, seat_id:'0', mute_type:muted ? '1' : '0'}, request);
      if (updated.errno !== 0) throw new OwnerError('官方席位状态更新失败；已停止发送，请在 App 检查静音。');
    }
    const checked = await inspect(channel, request);
    if (checked.seat.mute_type !== (muted ? 1 : 0)) throw new OwnerError('官方席位状态未确认；已停止发送，请在 App 检查静音。');
    if (muted) permit.unmuted = false;
    if (renewWatchdog) armWatchdog(request);
    return publicState(checked);
  }
  const mute = (channel, muted, request, proof) => serial(() => setMute(channel, muted, request, proof));
  const release = (channel, request, proof) => serial(async () => {
    authorize(channel, proof, true);
    const current = permit;
    try {
      if (current.unmuted) await setMute(channel, true, request, proof, false);
    } catch (error) {
      // The page may already be gone. Keep the remute obligation, but never allow this
      // permit to publish/renew again; a stale release cannot cancel a newer watchdog.
      current.cleanupPending = true;
      current.expires = now();
      const generation = ++current.generation;
      timers.clearTimeout(current.timer);
      current.timer = timers.setTimeout(() => { void expirePermit(current, request, generation); }, 1000);
      current.timer.unref?.();
      throw error;
    }
    if (permit === current) { timers.clearTimeout(current.timer); permit = null; }
    return {released:true};
  });
  // Shutdown: remute if this process unmuted the seat, then forget the permit. A failure keeps the permit.
  const drain = request => serial(async () => {
    const current = permit;
    if (!current) return;
    if (current.unmuted) await setMute(current.channel, true, request, current.proof, false);
    if (permit === current) { timers.clearTimeout(current.timer); permit = null; }
  });
  return {status, connect, mute, release, drain, busy:()=>!!permit};
}
module.exports = {OwnerError, canonicalSeats, verifySeats, rtcUid, crc32, validPublisherToken, loadOwnerScope, createOwnerService};

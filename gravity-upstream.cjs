'use strict';
// The only door to the official API: one fixed host, fixed write allowlist, bounded size and time.
const https = require('node:https');
const dns = require('node:dns');
const { InputError } = require('./gravity-util.cjs');

const API_HOST = 'api.gravity.place';
const MAX_BODY_BYTES = 1_000_000;
const IDLE_TIMEOUT_MS = 15_000;
// Idle timeout alone lets a slowly trickling response hold the global account request queue.
const DEADLINE_MS = 25_000;
const WRITE_PATHS = new Set([
  '/gravity/voice/updateAnchorStatus', '/gravity/voice/applyForSeat', '/gravity/voice/leaveForSeat',
  '/gravity/lcs/cover', '/gravity/feed/addCommentEncrypt', '/gravity/feed/addCommentReplyEncrypt', '/gravity/feed/voteEncrypt',
  '/gravity/voice/createRoomV2', '/gravity/voice/updateRoom', '/gravity/relation/followEncrypt', '/gravity/voice/enterGroupRoom', '/gravity/voice/destroyRoom',
  '/gravity/point/pointAwardReceiveV2Encrypt', '/gravity/point/signAwardReceiveEncrypt',
  '/gravity/limitRelation/lottery', '/gravity/point/finishedADEncryptV2',
  '/gravity/h5/voiceTask/drawEncrypt', '/gravity/h5/voiceTask/signAwardReceiveEncrypt', '/gravity/h5/getAwardForH5',
]);
const ENCRYPTED_PATHS = new Set([
  '/gravity/feed/addCommentEncrypt', '/gravity/feed/addCommentReplyEncrypt', '/gravity/feed/voteEncrypt', '/gravity/relation/followEncrypt',
  '/gravity/point/pointAwardReceiveV2Encrypt', '/gravity/point/signAwardReceiveEncrypt',
  '/gravity/limitRelation/lottery', '/gravity/point/finishedADEncryptV2',
  '/gravity/h5/voiceTask/drawEncrypt', '/gravity/h5/voiceTask/signAwardReceiveEncrypt',
]);
const ENCRYPTED_TYPE = 'application/raw; charset=utf-8';

// Keep container/host DNS unchanged. Only this fixed upstream may fall back to
// public DNS if the configured resolver sinks it to a non-public address.
function publicIPv4(ip) {
  const p = ip.split('.').map(Number);
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) && p.every(n => n >= 0 && n <= 255) &&
    p[0] > 0 && p[0] < 224 && ![10, 127].includes(p[0]) &&
    !(p[0] === 169 && p[1] === 254) && !(p[0] === 172 && p[1] >= 16 && p[1] <= 31) &&
    !(p[0] === 192 && (p[1] === 168 || p[1] === 0)) && !(p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}

function officialLookup(host, options, callback) {
  if (host !== API_HOST) return callback(new Error('unsupported_upstream_host'));
  dns.lookup(host, { family: 4 }, (error, address) => {
    const done = ip => options?.all ? callback(null, [{ address: ip, family: 4 }]) : callback(null, ip, 4);
    if (!error && publicIPv4(address)) return done(address);
    const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
    resolver.setServers(['1.1.1.1', '8.8.8.8']);
    resolver.resolve4(host, (failure, addresses) => {
      const ip = addresses?.find(publicIPv4);
      if (failure || !ip) return callback(new Error('upstream_dns_unavailable'));
      done(ip);
    });
  });
}

function checkRequest(options) {
  if (options.hostname !== API_HOST || !options.path.startsWith('/gravity/')) throw new InputError('不支持的上游地址。');
  const method = options.method || 'GET';
  const url = new URL(options.path, 'https://' + API_HOST);
  const body = method === 'POST' ? options.body : undefined;
  // These are writes even when a reader tries a GET with a signed query.
  if (['/gravity/h5/voiceTask/drawEncrypt', '/gravity/h5/voiceTask/signAwardReceiveEncrypt', '/gravity/h5/getAwardForH5'].includes(url.pathname) && method !== 'POST') {
    throw new InputError('领取只能通过专用写入操作。');
  }
  if (url.pathname === '/gravity/h5/getAwardForH5') {
    const fields = new URLSearchParams(typeof body === 'string' ? body : '');
    const id = key => fields.getAll(key).length === 1 && /^[1-9][0-9]{0,19}$/.test(fields.get(key) || '');
    if (!id('anchor_id') || !id('channel_id') || !id('task_level') || Number(fields.get('task_level')) > 100) {
      throw new InputError('房间任务领取参数无效。');
    }
  }
  // Native D7.w (UploadImageRequest): multipart POST gravity/common/newUploadV2.
  // Only source=private (1:1 private images) is allowed; source=voiceroom stays disabled.
  if (url.pathname === '/gravity/common/newUploadV2' || options.mutation === 'private-image-upload') {
    const type = typeof options.contentType === 'string' ? options.contentType : '';
    const upload = url.pathname === '/gravity/common/newUploadV2' && method === 'POST' && options.mutation === 'private-image-upload' &&
      Buffer.isBuffer(body) && body.length > 32 && body.length <= 1_200_000 &&
      /^multipart\/form-data; boundary=[A-Za-z0-9'()+_,.\/=\?-]{8,70}$/.test(type);
    if (!upload) throw new InputError('写入只能通过明确确认的账号操作。');
    return { method, body, encrypted: false, contentType: type };
  }
  // Native relation/black, receiveLuckyBox and feed/collect mutate via GET; require a dedicated internal write marker.
  if (url.pathname === '/gravity/relation/black' || url.pathname === '/gravity/relation/shield' || url.pathname === '/gravity/voice/receiveLuckyBox' ||
      url.pathname === '/gravity/feed/collect' || options.mutation) {
    const id = key => url.searchParams.getAll(key).length === 1 && /^[1-9][0-9]{0,19}$/.test(url.searchParams.get(key) || '');
    const direction = { 'block-user': 'block', 'unblock-user': 'unblock' }[options.mutation];
    const block = url.pathname === '/gravity/relation/black' && method === 'GET' && !!direction &&
      url.searchParams.get('action') === direction && url.searchParams.getAll('action').length === 1 && id('target_user_id');
    const shield = url.pathname === '/gravity/relation/shield' && method === 'GET' && options.mutation === 'shield-user' &&
      url.searchParams.get('action') === 'shield' && url.searchParams.getAll('action').length === 1 && id('target_user_id');
    const box = url.pathname === '/gravity/voice/receiveLuckyBox' && method === 'GET' && options.mutation === 'receive-lucky-box' &&
      id('anchor_id') && id('lucky_box_id') && id('issue_user_id');
    const collect = url.pathname === '/gravity/feed/collect' && method === 'GET' && options.mutation === 'feed-collect' &&
      url.searchParams.getAll('action').length === 1 && ['collect', 'cancel'].includes(url.searchParams.get('action') || '') &&
      url.searchParams.getAll('id').length === 1 && /^[A-Za-z0-9_.:-]{1,160}$/.test(url.searchParams.get('id') || '');
    if (!block && !shield && !box && !collect) throw new InputError('写入只能通过明确确认的账号操作。');
  }
  if (method !== 'GET' && method !== 'POST') throw new InputError('不支持的上游操作。');
  if (method === 'POST' && (!WRITE_PATHS.has(options.path) || typeof body !== 'string' || body.length > 32768)) {
    throw new InputError('不支持的上游操作。');
  }
  const encrypted = ENCRYPTED_PATHS.has(options.path);
  if (encrypted && (options.contentType !== ENCRYPTED_TYPE || !/^[A-Za-z0-9+/]+={0,2}$/.test(body || ''))) {
    throw new InputError('写入必须使用官方加密格式。');
  }
  return { method, body, encrypted };
}

// Only one fixed official API host. Never follow redirects to arbitrary hosts.
function httpsRequest(options) {
  let checked;
  try { checked = checkRequest(options); } catch (error) { return Promise.reject(error); }
  const { method, body, encrypted, contentType } = checked;
  return new Promise((resolve, reject) => {
    let deadline;
    const settle = (fn, value) => { clearTimeout(deadline); fn(value); };
    const req = https.request({ ...options, lookup: officialLookup, method, headers: {
      'User-Agent': 'gravity-webui/2', Accept: 'application/json',
      ...(body === undefined ? {} : {
        'Content-Type': encrypted ? ENCRYPTED_TYPE : contentType || 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body),
      }),
    } }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) { res.destroy(); req.destroy(new Error('upstream_response_too_large')); }
        else chunks.push(chunk);
      });
      res.on('error', error => settle(reject, error));
      res.on('end', () => settle(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', error => settle(reject, error));
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error('upstream_timeout')));
    deadline = setTimeout(() => req.destroy(new Error('upstream_deadline')), DEADLINE_MS);
    deadline.unref?.();
    req.end(body);
  });
}

module.exports = { API_HOST, DEADLINE_MS, publicIPv4, officialLookup, httpsRequest, checkRequest };

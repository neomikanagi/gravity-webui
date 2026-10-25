'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const IOS_DEVICE_FILE = path.join(__dirname, '.session', 'ios-device.json');
const AES_KEY = Buffer.from('baisimeji9262019', 'utf8');
const AES_IV = Buffer.from('qrstuvwxyz123456', 'utf8');
const BLOB_A = 'cCGuKONrxsRu/GiEbT6+/g==';
const BLOB_B = '4RGuJzQWuSPF5GwInA/0XrpPDVzWl2GuLMBZvmIx/Jw=';
// ExtensionNetworkEncrypt.sign: mov w9, #0xa04b; movk w9, #0x197, lsl #16.
const TS_MOD = 26714187;
const SECRET_PARAM = 'api_security';

let _partA;
let _partB;

function aesDecryptB64(b64) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', AES_KEY, AES_IV);
  return Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()]).toString('utf8');
}

function saltParts() {
  if (!_partA) _partA = aesDecryptB64(BLOB_A);
  if (!_partB) _partB = aesDecryptB64(BLOB_B);
  return { partA: _partA, partB: _partB };
}

function apiSecurityForTs(ts) {
  const { partA, partB } = saltParts();
  const r = Number(ts) % TS_MOD;
  return `${partA}${r}${partB}`;
}

function md5Hex(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

function loadIosDevice() {
  try {
    const j = JSON.parse(fs.readFileSync(IOS_DEVICE_FILE, 'utf8'));
    if (typeof j.idfa === 'string' && j.idfa.length > 0 && typeof j.uwd === 'string' && j.uwd.length > 0) {
      return j;
    }
  } catch {}
  return null;
}

function loadSessionToken() {
  try {
    const file = path.join(__dirname, '.session', 'www-token.json');
    const session = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof session.token === 'string' && session.token.length > 8 ? session.token : null;
  } catch { return null; }
}

function defaultZone() {
  return String(-new Date().getTimezoneOffset() / 60);
}

function buildIosBaseParams({ token, device }) {
  const d = device || loadIosDevice() || {};
  const zone = d.zone != null ? String(d.zone) : defaultZone();
  return {
    app_version: d.app_version || '14.2',
    country: d.country || 'JP',
    device: 'ios',
    idfa: d.idfa || '',
    languageV2: d.languageV2 || 'ja',
    model: d.model || 'iPad8,6',
    operator_name: d.operator_name ?? '',
    product: 'gravity',
    referrer: d.referrer || 'default',
    sim_country: d.sim_country ?? '',
    sys_lang: d.sys_lang || 'ja-JP',
    system_version: d.system_version || '18.7',
    token,
    user_country: d.user_country || 'JP',
    uwd: d.uwd || '',
    zone,
  };
}

/** iOS ExtensionNetworkEncrypt.sign: transient api_security + sorted key=value, UTF-8 MD5. */
function finalizeIosSign(params, tsOverride) {
  const map = { ...params };
  delete map.sign;
  delete map.ts;
  delete map[SECRET_PARAM];
  const ts = tsOverride != null ? Number(tsOverride) : Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(ts) || ts < 0) throw new TypeError('invalid_ios_timestamp');
  map.ts = String(ts);
  map[SECRET_PARAM] = apiSecurityForTs(ts);
  const keys = Object.keys(map).sort();
  let concat = '';
  for (const key of keys) {
    const value = map[key];
    concat += value == null ? `${key}=` : `${key}=${value}`;
  }
  map.sign = md5Hex(concat);
  delete map[SECRET_PARAM];
  return map;
}

module.exports = {
  loadSessionToken,
  loadIosDevice,
  buildIosBaseParams,
  finalizeIosSign,
  apiSecurityForTs,
  IOS_DEVICE_FILE,
  TS_MOD,
  SECRET_PARAM,
};

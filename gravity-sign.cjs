'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const APK_SIGN_MD5 = '3db95da32907a41c5a3262312f942362';
const API_SALT = 'hwqigv110fde1b10nh';
const TS_MOD = 787653;
const SECRET_PARAM = 'api_security';
const TS_PARAM = 'ts';
const APP_VERSION = '15.2.1';
const APP_VERSION_CODE = '647';

function md5Hex(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

function randomNonce() {
  return crypto.randomUUID().toUpperCase();
}

function tsRemainder(ts) {
  return ts % TS_MOD;
}

/** Native cs.c concatenation (libgbus rodata salt + apk_sign MD5 + ts remainder). */
function nativeApiSecurity(ts) {
  const r = tsRemainder(ts);
  const part = String(r);
  return APK_SIGN_MD5 + API_SALT + part;
}

/** Candidate api_security values derived from libgbus.cs_c disassembly hints. */
function apiSecurityCandidates(ts) {
  const r = tsRemainder(ts);
  const apk = APK_SIGN_MD5;
  const salt = API_SALT;
  const part = String(r);
  const out = new Set([nativeApiSecurity(ts)]);
  for (const p of [part, part.padStart(6, '0'), part.padStart(9, '0')]) {
    out.add(apk + salt + p);
    out.add(salt + apk + p);
    out.add(apk + p + salt);
    out.add(salt + p + apk);
    out.add(md5Hex(apk + salt + p));
    out.add(md5Hex(salt + apk + p));
  }
  out.add(md5Hex(apk + salt));
  return [...out];
}

function defaultZone() {
  return String(-new Date().getTimezoneOffset() / 60);
}

function buildBaseParams({ token, nonce, zone = defaultZone() }) {
  const params = {
    app_version: APP_VERSION,
    app_version_code: APP_VERSION_CODE,
    system_version: '14',
    sdk_version: '34',
    device: 'android',
    sys_lang: 'ja-JP',
    country: 'JP',
    model: 'Pixel_7',
    referrer: '',
    brand: 'google',
    pkg: 'anonymous.sns.community.gravity',
    zone,
    product: 'gravity',
    nonce: nonce || randomNonce(),
    idfa: '',
    languageV2: 'ja',
    user_country: 'JP',
    sim_country: 'jp',
    operator_name: '',
  };
  if (token) params.token = token;
  return params;
}

function finalizeSign(params, apiSecurity) {
  const map = { ...params };
  delete map.sign;
  delete map[TS_PARAM];
  delete map[SECRET_PARAM];
  const ts = Math.floor(Date.now() / 1000);
  map[TS_PARAM] = String(ts);
  map[SECRET_PARAM] = apiSecurity;
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

function signRequest(extra, options = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const base = buildBaseParams({ token: options.token, nonce: options.nonce });
  const merged = { ...base, ...extra };
  const candidate = options.apiSecurity ?? apiSecurityCandidates(ts)[0];
  return finalizeSign(merged, candidate);
}

function loadSessionToken() {
  const file = path.join(__dirname, '.session', 'www-token.json');
  if (!fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof j.token === 'string' && j.token.length > 8 ? j.token : null;
  } catch {
    return null;
  }
}

module.exports = {
  md5Hex,
  apiSecurityCandidates,
  nativeApiSecurity,
  buildBaseParams,
  finalizeSign,
  signRequest,
  loadSessionToken,
  SECRET_PARAM,
  TS_PARAM,
  APK_SIGN_MD5,
  API_SALT,
  TS_MOD,
};

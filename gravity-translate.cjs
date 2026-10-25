'use strict';
// Public-chat / IM translation through the operator's own DeepL key.
// The key never reaches the browser: this module runs server-side only.
// Default target is English. Leave DEEPL_AUTH_KEY empty to disable translation.
const crypto = require('node:crypto');
const {createSerial} = require('./gravity-util.cjs');

class TranslateError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const TARGETS = new Set(['ZH', 'JA', 'EN']);
const DEFAULT_TARGET = 'EN';
// Skip already-English lines (latin letters, no CJK). Keep in sync with static/translate.js.
function looksEnglish(text) {
  if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(text)) return false;
  return /[A-Za-z]/.test(text);
}
function skipTranslate(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return true;
  if (looksEnglish(trimmed)) return true;
  const letters = trimmed.replace(/\p{Extended_Pictographic}/gu, '').replace(/[\uFE0F\u200D\u20E3]/g, '')
    .replace(/[\s\d]+/g, '').replace(/[\p{P}\p{S}]/gu, '');
  return !/[\u3040-\u30ff\u4e00-\u9fffA-Za-z\u00C0-\u024F\u0400-\u04FF\uAC00-\uD7AF]/u.test(letters);
}

function createTranslateService({
  fetchImpl = globalThis.fetch,
  key = process.env.DEEPL_AUTH_KEY || '',
  now = Date.now,
  dayBudget = 100000,
  timeoutMs = 10000,
} = {}) {
  const serial = createSerial(4, () => new TranslateError('翻译正在处理，请稍后重试。', 429));
  const cache = new Map();   // sha256(text|target) -> {text, expires}
  const receipts = new Map();// identity-less request_id -> {payload, work, expires}
  let day = '', used = 0;

  function endpoint() {
    return key.endsWith(':fx')
      ? 'https://api-free.deepl.com/v2/translate'
      : 'https://api.deepl.com/v2/translate';
  }
  function budget() {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) { day = today; used = 0; }
    return {day, used};
  }
  async function run(text, target) {
    if (!key) throw new TranslateError('翻译未配置（缺少 DeepL key），请先在 .env 里设置（DEEPL_AUTH_KEY）。', 503);
    const digest = crypto.createHash('sha256').update(target + '|' + text).digest('hex');
    const hit = cache.get(digest);
    if (hit && hit.expires > now()) return {text: hit.text, cached: true};
    const quota = budget();
    if (quota.used + text.length > dayBudget) {
      throw new TranslateError('今日翻译额度已用完，明天再试。', 429);
    }
    const body = new URLSearchParams({text, target_lang: target});
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(endpoint(), {
        method: 'POST', signal: abort.signal,
        headers: {'Authorization': 'DeepL-Auth-Key ' + key, 'Content-Type': 'application/x-www-form-urlencoded'},
        body,
      });
    } catch {
      throw new TranslateError('翻译接口暂不可用，请稍后重试。', 502);
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 456) throw new TranslateError('DeepL 本月免费额度已用完。', 429);
    if (!response.ok) throw new TranslateError('翻译失败，请稍后重试。', 502);
    let result;
    try { result = await response.json(); } catch { throw new TranslateError('翻译返回无效，请稍后重试。', 502); }
    const translated = result?.translations?.[0]?.text;
    if (typeof translated !== 'string' || !translated) throw new TranslateError('翻译返回无效，请稍后重试。', 502);
    quota.used += text.length; used = quota.used;
    cache.set(digest, {text: translated.slice(0, 2000), expires: now() + 24 * 3600 * 1000});
    while (cache.size > 2000) cache.delete(cache.keys().next().value);
    return {text: translated.slice(0, 2000), cached: false};
  }
  async function translate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(k => !['text', 'target_lang', 'request_id'].includes(k))) {
      throw new TranslateError('翻译参数无效。');
    }
    const {text, request_id} = body;
    const target = body.target_lang || DEFAULT_TARGET;
    if (typeof text !== 'string' || !text.trim() || text.length > 500 || !TARGETS.has(target) ||
        typeof request_id !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request_id)) {
      throw new TranslateError('翻译需要 1～500 字文字与提交编号。');
    }
    const trimmed = text.trim();
    if (skipTranslate(trimmed)) return Promise.resolve({text: trimmed, cached: true, skipped: true});
    const key2 = request_id, payload = JSON.stringify([trimmed, target]);
    for (const [k, r] of receipts) if (r.expires <= now()) receipts.delete(k);
    const old = receipts.get(key2);
    if (old) {
      if (old.payload !== payload) throw new TranslateError('该提交编号已用于另一条翻译。', 409);
      return old.work;
    }
    if (receipts.size >= 128) throw new TranslateError('翻译记录已满，请稍后再试。', 429);
    const work = serial(() => run(trimmed, target));
    receipts.set(key2, {payload, work, expires: now() + 3600000});
    work.catch(() => { if (receipts.get(key2)?.work === work) receipts.delete(key2); });
    return work;
  }
  return {translate, looksEnglish, skipTranslate, usage: () => ({...budget(), budget: dayBudget})};
}

module.exports = {createTranslateService, TranslateError, looksEnglish, skipTranslate};

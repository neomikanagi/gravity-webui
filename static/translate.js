/* Room/IM English translation through the server-side DeepL proxy. The key never reaches the browser. */
(function(root){
 'use strict';
 const cache = new Map(), pending = new Map();
 function enabled() {
  try { return globalThis.localStorage?.getItem('gravity.translate') !== '0'; } catch { return true; }
 }
 function setEnabled(on) {
  try { globalThis.localStorage?.setItem('gravity.translate', on ? '1' : '0'); } catch {}
 }
 function looksEnglish(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (/[\u4e00-\u9fff\u3040-\u30ff]/.test(trimmed)) return false;
  return /[A-Za-z]/.test(trimmed);
 }
 function skipTranslate(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return true;
  if (looksEnglish(trimmed)) return true;
  const letters = trimmed.replace(/\p{Extended_Pictographic}/gu, '').replace(/[\uFE0F\u200D\u20E3]/g, '')
   .replace(/[\s\d]+/g, '').replace(/[\p{P}\p{S}]/gu, '');
  return !/[\u3040-\u30ff\u4e00-\u9fffA-Za-z\u00C0-\u024F\u0400-\u04FF\uAC00-\uD7AF]/u.test(letters);
 }
 function peek(text) { return cache.get(text) || null; }
 async function translateText(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed || trimmed.length > 500 || skipTranslate(trimmed)) return null;
  if (cache.has(trimmed)) return cache.get(trimmed);
  if (pending.has(trimmed)) return pending.get(trimmed);
  const work = (async () => {
   const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000);
   try {
    const response = await fetch('/api/translate', {method: 'POST', signal: abort.signal, cache: 'no-store',
     headers: {'Content-Type': 'application/json', 'X-Gravity-Action': 'translate-control'},
     body: JSON.stringify({text: trimmed, target_lang: 'EN', request_id: globalThis.crypto.randomUUID()})});
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.errno !== 0 || typeof result.data?.text !== 'string') return null;
    const out = result.data.text.slice(0, 2000);
    cache.set(trimmed, out);
    while (cache.size > 500) cache.delete(cache.keys().next().value);
    return out;
   } catch { return null; }
   finally { clearTimeout(timer); pending.delete(trimmed); }
  })();
  pending.set(trimmed, work);
  return work;
 }
 root.GravityTranslate = {enabled, setEnabled, looksEnglish, skipTranslate, peek, translateText};
})(typeof globalThis !== 'undefined' ? globalThis : this);

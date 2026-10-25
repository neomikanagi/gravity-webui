'use strict';
// Small helpers shared by the server modules. Nothing here talks to the network or to the account.

/** Caller mistake (bad input / forbidden shape); mapped to HTTP 400 by the handler. */
class InputError extends Error {}

/** Positive decimal ID kept as a string (64-bit IDs must never pass through Number). */
function validId(value) {
  return typeof value === 'string' && /^[0-9]{1,20}$/.test(value) && /[1-9]/.test(value);
}

/** Truncate untrusted upstream text; non-strings become ''. */
function clipped(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Official user_country is ISO-3166 alpha-2. Ignore install-attribution junk such as organic. */
function countryCode(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z]{2}$/.test(text) ? text.toUpperCase() : '';
}

/** Only https://cdn.gravity.place/<plain path>.(png|jpg|jpeg|webp|gif) survives; query/hash are dropped. */
function officialCdnImage(url) {
  if (typeof url !== 'string' || url.length > 500) return '';
  let u;
  try { u = new URL(url); } catch { return ''; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || u.hash) return '';
  if (u.hostname !== 'cdn.gravity.place') return '';
  if (u.pathname.includes('..') || !/^\/[A-Za-z0-9._\/-]+\.(png|jpe?g|webp|gif)$/i.test(u.pathname)) return '';
  return `${u.origin}${u.pathname}`;
}

/** jpg/png/gif by magic bytes, capped at 1MB. Mirrors the native voice-room picker (bmp excluded: CDN projection does not serve it). */
function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.length > 1_048_576) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return {ext: 'jpg', type: 'image/jpeg'};
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
      buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return {ext: 'png', type: 'image/png'};
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38 &&
      (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61) return {ext: 'gif', type: 'image/gif'};
  return null;
}

/**
 * Run async jobs strictly one after another and refuse new ones beyond `limit` queued/running.
 * A failed job never blocks the next one. `busyError()` builds the rejection for the overflow case.
 */
function createSerial(limit, busyError) {
  let queue = Promise.resolve();
  let pending = 0;
  return function serial(job) {
    if (pending >= limit) return Promise.reject(busyError());
    pending++;
    const work = queue.then(job);
    queue = work.catch(() => {}).finally(() => { pending--; });
    return work;
  };
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

module.exports = { InputError, validId, clipped, countryCode, officialCdnImage, sniffImage, createSerial, sendJson };

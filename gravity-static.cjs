'use strict';
// Static files for the page: in-memory cache, content ETags, br/gzip, safe paths.
// App code is always revalidated (`no-cache`, a cheap 304 when unchanged) so a deploy is never masked by a stale
// copy; vendored SDKs have version-pinned names (tests lock their hash), so they are cached immutably.
// If a vendored file ever changes, change its file name and index.html together.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { sendJson } = require('./gravity-util.cjs');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const INDEX_ALIASES = new Set(['', 'index.html', 'audition_loop.html']);
const MIN_COMPRESS_BYTES = 1024;
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

function acceptsEncoding(header, name) {
  for (const part of String(header || '').split(',')) {
    const [token, ...params] = part.trim().split(';');
    if (token.trim().toLowerCase() !== name) continue;
    const q = params.map(p => p.trim()).find(p => /^q=/i.test(p));
    return !q || Number(q.slice(2)) > 0;
  }
  return false;
}

function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag);
}

function createStaticServer(root) {
  const base = path.resolve(root);
  const cache = new Map(); // absolute file -> {key, body, etag, encoded: Map<encoding, Promise<Buffer>>}

  async function load(file) {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return null;
    const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const hit = cache.get(file);
    if (hit?.key === key) return hit;
    const body = await fs.promises.readFile(file);
    const entry = { key, body, etag: `"${crypto.createHash('sha1').update(body).digest('base64url')}"`, encoded: new Map() };
    cache.set(file, entry);
    return entry;
  }

  function encode(entry, encoding) {
    let job = entry.encoded.get(encoding);
    if (!job) {
      job = encoding === 'br'
        ? brotli(entry.body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: entry.body.length } })
        : gzip(entry.body, { level: 9 });
      entry.encoded.set(encoding, job);
      job.catch(() => entry.encoded.delete(encoding));
    }
    return job;
  }

  return async function serveStatic(req, res, pathname) {
    let relative;
    try { relative = decodeURIComponent(pathname).replace(/^\/+/, ''); }
    catch { return sendJson(res, 400, { errno: -3, errmsg: '路径无效。' }); }
    if (INDEX_ALIASES.has(relative)) relative = 'index.html';
    const file = path.resolve(base, relative);
    if (!file.startsWith(base + path.sep)) return sendJson(res, 403, { errno: -3, errmsg: '路径不可访问。' });
    const parts = path.relative(base, file).split(path.sep);
    const missing = () => sendJson(res, 404, { errno: -3, errmsg: '页面不存在。' });
    if (parts.some(part => part.startsWith('.'))) return missing(); // e.g. macOS ._* sidecar files
    let entry;
    try { entry = await load(file); } catch { entry = null; }
    if (!entry) return missing();

    const ext = path.extname(file);
    const compressible = ext in TYPES && entry.body.length >= MIN_COMPRESS_BYTES;
    const accept = req.headers['accept-encoding'];
    const wanted = !compressible ? null : acceptsEncoding(accept, 'br') ? 'br' : acceptsEncoding(accept, 'gzip') ? 'gzip' : null;
    let body = entry.body, encoding = null;
    if (wanted) {
      try { body = await encode(entry, wanted); encoding = wanted; } catch { body = entry.body; }
    }
    const etag = encoding ? entry.etag.slice(0, -1) + (encoding === 'br' ? '-br' : '-gz') + '"' : entry.etag;
    const headers = {
      'Cache-Control': parts[0] === 'vendor' ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: etag,
      ...(compressible ? { Vary: 'Accept-Encoding' } : {}),
    };
    if (etagMatches(req.headers['if-none-match'], etag)) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, {
      ...headers,
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      ...(encoding ? { 'Content-Encoding': encoding } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}

module.exports = { createStaticServer, acceptsEncoding, etagMatches };

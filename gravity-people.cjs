'use strict';
// Country badges for people whose list rows carry none. roomMemberList rows have no user_country
// (seat rows do); user/userListInfo (native FriendListRequest, comma-joined target_user_ids) does.
const api = require('./gravity-api.cjs');
const { countryCode, validId } = require('./gravity-util.cjs');

function createCountryResolver({ read = api.readSignedVoice, now = Date.now, ttl = 6 * 3600_000, unknownTtl = 60_000,
  failCooldown = 30_000, max = 3000, chunk = 40, maxChunks = 3 } = {}) {
  const cache = new Map();
  let coolUntil = 0;
  const fresh = id => (cache.get(id)?.expires ?? 0) > now();
  /** Resolve unknown ids in a few batches; returns id => ISO country ('' when unknown). Never throws. */
  async function lookup(ids, request, options = {}) {
    const missing = [...new Set(ids.filter(id => validId(id) && !fresh(id)))];
    if (missing.length && now() >= coolUntil) {
      for (let i = 0; i < missing.length && i < chunk * maxChunks; i += chunk) {
        const batch = missing.slice(i, i + chunk);
        let result;
        try { result = await read('userList', { target_user_ids: batch.join(',') }, request, options); } catch { result = { errno: -1 }; }
        if (result?.errno !== 0 || !Array.isArray(result.data?.list)) { coolUntil = now() + failCooldown; break; }
        for (const row of result.data.list) {
          const raw = row?.user_id;
          const id = typeof raw === 'number' && !Number.isSafeInteger(raw) ? '' : String(raw ?? '');
          if (batch.includes(id)) cache.set(id, { country: countryCode(row.user_country), expires: now() + ttl });
        }
        // Ids the server left out stay unknown briefly instead of being asked again on every refresh.
        for (const id of batch) if (!fresh(id)) cache.set(id, { country: '', expires: now() + unknownTtl });
      }
      while (cache.size > max) cache.delete(cache.keys().next().value);
    }
    return id => (fresh(id) ? cache.get(id).country : '');
  }
  return { lookup };
}

module.exports = { createCountryResolver };

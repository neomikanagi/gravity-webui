'use strict';
// Keeps follow / block state mirrored with the people around the account:
//   they follow us -> follow back      they unfollow us -> unfollow them
//   they block us  -> block them       they unblock us  -> undo a block this service made
// Everyone we block is also put on the official mute list (relation/shield) and stays there: a sweep re-applies it.
// Official lists carry a relation bitmask per person (ext.relation): 1 we follow, 2 they follow us,
// 4 we block them, 8 they block us. Anything with other bits set is left alone.
const fs = require('node:fs');
const path = require('node:path');
const api = require('./gravity-api.cjs');
const { httpsRequest } = require('./gravity-upstream.cjs');
const { loadMemberIdentity } = require('./gravity-member.cjs');
const { validId, clipped } = require('./gravity-util.cjs');
const { officialUser } = require('./gravity-im-message.cjs');

const FOLLOWING = 1, FOLLOWED = 2, BLOCKING = 4, BLOCKED = 8, KNOWN_BITS = 15;
const TICK_MS = 60_000;          // newest fans checked every minute
const FULL_EVERY = 3;            // full follower/following sweep every third tick
const PAGE_CAP = 15;             // list pages per sweep (20 rows each)
const DETAIL_CAP = 12;           // profile lookups for people who vanished from both lists, per sweep
const ACTION_CAP = 8;            // account writes per tick
const DAY_CAP = 200;             // account writes per day
const WRITE_GAP_MS = 3000;
const LOG_KEEP = 30;

function rowId(row) {
  const raw = row?.user_id;
  if (typeof raw === 'number' && !Number.isSafeInteger(raw)) return '';
  const text = String(raw ?? '');
  return validId(text) ? text : '';
}
function relationOf(row) {
  const value = row?.ext?.relation;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function fileStore(file) {
  return {
    load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } },
    save(value) {
      const temp = file + '.' + process.pid + '.tmp';
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
        fs.renameSync(temp, file);
      } catch { try { fs.unlinkSync(temp); } catch {} }
    },
  };
}
const defaultStateFile = () => path.join(path.dirname(process.env.GRAVITY_ACCOUNT_STATE_FILE || path.join(__dirname, '.session/account-state.json')), 'relation-state.json');

function createRelationService({
  read = api.readSignedVoice, follow = api.writeFollow, block = api.writeProfileBlock, identity = loadMemberIdentity,
  shield = api.writeShield, request = httpsRequest, now = Date.now, store = fileStore(defaultStateFile()), sleep = ms => new Promise(r => setTimeout(r, ms)),
  timers = globalThis, log = () => {}, enabled = process.env.GRAVITY_RELATION_SYNC !== '0',
} = {}) {
  let st = null;                 // persisted state for the current account
  let tickCount = 0, running = false, timer = null, lastScanAt = 0, lastFullAt = 0, blockCursor = 0;
  const queue = new Map();       // "action:id" -> item
  const failures = new Map();    // "action:id" -> {fails, next}
  const people = { followers: new Set(), following: new Set(), autoBlocked: new Set(), blocked: new Set(), muted: new Set() };
  let mutedKnown = false;      // the official mute list has been read completely at least once

  function fresh(who) {
    return { version: 1, identity: who.identity, baselined: false, followers: [], following: [], autoBlocked: [], blocked: [], day: '', writes: 0, recent: [] };
  }
  function load(who) {
    if (st?.identity === who.identity) return;
    const saved = store.load();
    st = saved && saved.version === 1 && saved.identity === who.identity ? saved : fresh(who);
    people.followers = new Set(st.followers); people.following = new Set(st.following); people.autoBlocked = new Set(st.autoBlocked);
    people.blocked = new Set(st.blocked || []); people.muted = new Set(); mutedKnown = false;
    queue.clear(); failures.clear();
  }
  function persist() {
    st.followers = [...people.followers].slice(-5000); st.following = [...people.following].slice(-5000);
    st.autoBlocked = [...people.autoBlocked].slice(-2000); st.blocked = [...people.blocked].slice(-5000);
    store.save(st);
  }
  const today = () => new Date(now()).toISOString().slice(0, 10);
  function record(action, id, name, ok) {
    st.recent.unshift({ at: now(), action, user_id: id, name: clipped(name, 40), ok });
    st.recent.length = Math.min(st.recent.length, LOG_KEEP);
  }

  /** What, if anything, to do about one person given their relation bits. Uses the previous snapshot. */
  function decide(id, rel) {
    if (rel === null || (rel & ~KNOWN_BITS) !== 0) return null;
    const f = rel & FOLLOWING, b = rel & FOLLOWED, ib = rel & BLOCKING, tb = rel & BLOCKED;
    if (tb && !ib) return 'block';
    if (ib && !tb && people.autoBlocked.has(id)) return 'unblock';
    if (ib || tb || !st.baselined) return null;
    // Follow back only people newly seen following us, so someone we unfollowed by hand is not chased forever.
    if (b && !f && !people.followers.has(id)) return 'follow';
    if (!b && f && people.followers.has(id)) return 'unfollow';
    return null;
  }
  function enqueue(action, id, name) {
    if (!action || !id || officialUser(id)) return;
    const key = action + ':' + id, gate = failures.get(key);
    if (gate && gate.next > now()) return;
    if (!queue.has(key) && queue.size < 100) queue.set(key, { action, id, name: clipped(name, 40) });
  }
  /** Feed rows from any official list/room board: [{user_id, relation, name?}]. Only queues work. */
  function observe(rows, who = identity()) {
    if (!enabled || !who || !Array.isArray(rows)) return;
    load(who);
    for (const row of rows.slice(0, 600)) {
      const id = rowId(row);
      if (!id || id === who.user) continue;
      const rel = Number.isSafeInteger(row.relation) ? row.relation : null;
      enqueue(decide(id, rel), id, row.name);
      if (rel !== null && (rel & BLOCKING)) { people.blocked.add(id); if (mutedKnown && !people.muted.has(id)) enqueue('mute', id, row.name); }
    }
  }

  async function page(kind, cursor, who) {
    const result = await read(kind, cursor ? { last_id: cursor } : {}, request, { expectedIdentity: who.identity });
    if (result?.errno !== 0 || !Array.isArray(result.data?.list)) throw new Error('relation_list_unavailable');
    return result.data;
  }
  /** Walk one official list. `complete` is true only when the end of the list was reached. */
  async function sweep(kind, who, pages) {
    const rows = [], seen = new Set();
    let cursor = '', complete = false;
    for (let i = 0; i < pages; i++) {
      const data = await page(kind, cursor, who);
      rows.push(...data.list.slice(0, 100));
      const next = String(data.last_id ?? '');
      if (!data.list.length || !validId(next) || seen.has(next) || next === cursor) { complete = true; break; }
      seen.add(next); cursor = next;
      await sleep(150);
    }
    return { rows, complete };
  }
  function ingest(rows, into) {
    for (const row of rows) {
      const id = rowId(row), rel = relationOf(row);
      if (!id || id === (identity()?.user)) continue;
      into.set(id, { rel, name: row.name });
    }
  }

  async function scan(who, full) {
    const present = new Map();
    const fans = await sweep('fans', who, full ? PAGE_CAP : 1);
    ingest(fans.rows, present);
    let following = null;
    if (full) { following = await sweep('following', who, PAGE_CAP); ingest(following.rows, present); }
    const complete = full && fans.complete && following.complete;
    const previous = new Set([...people.followers, ...people.following]);
    for (const [id, item] of present) enqueue(decide(id, item.rel), id, item.name);
    if (!st.baselined && complete) {
      people.followers = new Set([...present].filter(([, v]) => (v.rel ?? 0) & FOLLOWED).map(([id]) => id));
      people.following = new Set([...present].filter(([, v]) => (v.rel ?? 0) & FOLLOWING).map(([id]) => id));
      st.baselined = true; persist();
    } else {
      for (const [id, item] of present) {
        const rel = item.rel ?? 0;
        // A new fan we have not (yet) followed back stays unrecorded, so a failed follow-back is retried instead of forgotten.
        if (rel & FOLLOWING) people.following.add(id);
        if ((rel & FOLLOWED) && (rel & FOLLOWING)) people.followers.add(id);
      }
    }
    if (complete) {
      // Anyone who dropped out of both lists may have blocked us (a block removes the relation); look at their profile.
      const vanished = [...previous].filter(id => !present.has(id)).slice(0, DETAIL_CAP);
      // Blocks this service made never show up in the lists, so look at a few of them each sweep to see if they lifted theirs.
      const mirrored = [...people.autoBlocked];
      for (let i = 0; i < Math.min(DETAIL_CAP, mirrored.length); i++) vanished.push(mirrored[(blockCursor + i) % mirrored.length]);
      blockCursor = mirrored.length ? (blockCursor + DETAIL_CAP) % mirrored.length : 0;
      for (const id of new Set(vanished)) {
        const detail = await read('userDetail', { target_id: id }, request, { expectedIdentity: who.identity }).catch(() => ({ errno: -1 }));
        if (detail?.errno === 0) enqueue(decide(id, relationOf(detail.data)), id, detail.data?.name);
        await sleep(150);
      }
      const keepers = new Set(present.keys());
      for (const id of [...people.followers]) if (!keepers.has(id)) people.followers.delete(id);
      for (const id of [...people.following]) if (!keepers.has(id)) people.following.delete(id);
      lastFullAt = now();
    }
    lastScanAt = now();
  }

  /** Read the block list and the mute list; everyone blocked but not muted is queued to be muted. */
  async function syncMutes(who) {
    const black = await sweep('blacklist', who, PAGE_CAP);
    const shielded = await sweep('shieldList', who, PAGE_CAP);
    const names = new Map();
    for (const row of black.rows) { const id = rowId(row); if (id) names.set(id, row.name); }
    if (black.complete) { people.blocked = new Set(names.keys()); }
    else for (const id of names.keys()) people.blocked.add(id);
    if (shielded.complete) { people.muted = new Set(shielded.rows.map(rowId).filter(Boolean)); mutedKnown = true; }
    if (mutedKnown) for (const id of people.blocked) if (!people.muted.has(id)) enqueue('mute', id, names.get(id));
  }
  async function act(item, who) {
    if (identity()?.identity !== who.identity || item.id === who.user || officialUser(item.id)) return false;
    let result;
    try {
      const options = { expectedIdentity: who.identity };
      if (item.action === 'mute') result = await shield({ target_user_id: item.id, action: 'shield' }, request, options);
      else if (item.action === 'follow' || item.action === 'unfollow') result = await follow({ action: item.action, user_id_b: item.id }, request, options);
      else result = await block({ target_user_id: item.id, action: item.action }, request, options);
    } catch { result = { errno: -1 }; }
    return result?.errno === 0;
  }
  function applied(item) {
    const { action, id } = item;
    if (action === 'follow') { people.following.add(id); people.followers.add(id); }
    else if (action === 'unfollow') { people.following.delete(id); people.followers.delete(id); }
    else if (action === 'block') { people.autoBlocked.add(id); people.blocked.add(id); people.following.delete(id); people.followers.delete(id); enqueue('mute', id, item.name); }
    else if (action === 'unblock') { people.autoBlocked.delete(id); people.blocked.delete(id); }
    else if (action === 'mute') people.muted.add(id);
  }
  async function drain(who) {
    let done = 0;
    if (st.day !== today()) { st.day = today(); st.writes = 0; }
    for (const [key, item] of [...queue]) {
      if (done >= ACTION_CAP || st.writes >= DAY_CAP) break;
      queue.delete(key);
      // The decision is re-made from the latest bits at enqueue time; stale items fall out when state moved on.
      if (identity()?.identity !== who.identity) break;
      if (done) await sleep(WRITE_GAP_MS);
      const ok = await act(item, who);
      done++; st.writes++;
      record(item.action, item.id, item.name, ok);
      if (ok) { applied(item); failures.delete(key); log(`relation ${item.action} ok ${item.id}`); }
      else {
        const gate = failures.get(key) || { fails: 0, next: 0 };
        gate.fails++; gate.next = now() + (gate.fails >= 3 ? (item.action === 'mute' ? 86_400_000 : 3600_000) : 120_000); failures.set(key, gate);
        // After repeated refusals stop chasing: treat the fan as known, like someone we chose not to follow.
        if (item.action === 'follow' && gate.fails >= 6) people.followers.add(item.id);
        log(`relation ${item.action} failed ${item.id}`);
      }
    }
    if (done) persist();
  }

  /** One pass: look at the newest fans (or sweep everything), then do all queued work (incl. rows from observe). Never throws. */
  async function tick(forceFull = false) {
    if (!enabled || running) return false;
    const who = identity();
    if (!who || api.accountStatus().state === 'rejected_session') return false;
    running = true;
    try {
      load(who);
      const full = forceFull || !st.baselined || tickCount % FULL_EVERY === 0;
      tickCount++;
      await scan(who, full);
      if (full) { try { await syncMutes(who); } catch (error) { log('relation mute sync skipped: ' + (error?.message || 'error')); } }
      await drain(who);
      if (full) persist();
      return true;
    } catch (error) { log('relation tick skipped: ' + (error?.message || 'error')); return false; }
    finally { running = false; }
  }
  /** A block was made elsewhere (profile, IM auto-block): keep them out of earshot now, mute them officially soon. */
  function noteBlocked(userId) {
    const id = String(userId ?? '');
    const who = identity();
    if (!enabled || !who || !validId(id) || id === who.user || officialUser(id)) return;
    load(who);
    people.blocked.add(id); people.muted.delete(id);
    enqueue('mute', id, '');
    persist();
  }
  /** User ids of everyone the account blocks (what the room page must never play). */
  function blockedIds() {
    const who = identity();
    if (!who) return [];
    load(who);
    return [...people.blocked];
  }

  function start() {
    if (!enabled || timer) return;
    const loop = () => { timer = timers.setTimeout(async () => { await tick(); loop(); }, TICK_MS); timer.unref?.(); };
    timer = timers.setTimeout(async () => { await tick(); loop(); }, 20_000);
    timer.unref?.();
  }
  function stop() { timers.clearTimeout(timer); timer = null; }
  function status() {
    const who = identity();
    if (who) load(who);
    return {
      enabled, ready: !!st?.baselined, last_scan_at: lastScanAt || null, last_full_scan_at: lastFullAt || null,
      followers: people.followers.size, following: people.following.size, blocked: people.blocked.size, muted: people.muted.size, pending: queue.size,
      today_writes: st?.day === today() ? st.writes : 0, recent: st ? st.recent.slice(0, 20) : [],
    };
  }
  return { observe, noteBlocked, blockedIds, tick, start, stop, status };
}

module.exports = { createRelationService, fileStore, FOLLOWING, FOLLOWED, BLOCKING, BLOCKED };

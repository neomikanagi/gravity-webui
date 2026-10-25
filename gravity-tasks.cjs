'use strict';
// Daily silver missions (point), sign-in, rewarded-ad progress, feed likes.
// List shapes: PointTaskList.list + grow_list, SignMission as a bare object (hb/u/i),
// ad complete = finishedADEncryptV2 {scene: ad_point|ad_draw} for remaining official quota (jb/C2929a).
// Point claim = {id, award_type: task.type}; sign claim = {award_type: 0}.
// Couple lottery costs 600 and is never auto-drawn. Daily free gacha is the ad_draw scene.
const path = require('node:path');
const api = require('./gravity-api.cjs');
const {httpsRequest} = require('./gravity-upstream.cjs');
const {loadMemberIdentity} = require('./gravity-member.cjs');
const {clipped, createSerial} = require('./gravity-util.cjs');
const {jstDay, rewardStore} = require('./gravity-rewards.cjs');

class TasksError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const CLAIMABLE = 1;
const TICK_MS = 20 * 60 * 1000;
const DAY_WRITES = 40;
const LIKE_DAY_CAP = 400;
const LIKE_TICK_CAP = 20;
// Post ids auto-liked (by the page or here) or unliked by hand on the page: never auto-liked again.
const LIKE_MEMORY = 5000;
const AD_GAP_MS = 16_000;
const LIKE_GAP_MS = 2_400;

function num(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function mission(row) {
  const id = Number(row?.id);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const status = Number(row?.status);
  return {
    id, name: clipped(row?.name, 80), progress: clipped(row?.progress, 40),
    status: [0, 1, 2].includes(status) ? status : -1,
    type: row?.type === undefined ? 0 : [0,1,2].includes(Number(row.type)) ? Number(row.type) : -1,
    points: num(row?.add_point) ?? 0,
  };
}
function lotteryEntry(row) {
  if (!row || typeof row !== 'object') return null;
  const id = row.id ?? row.lottery_id ?? row.card_id ?? null;
  const free = row.free_times ?? row.free_count ?? row.remain_free ?? row.free ?? 0;
  const price = row.price ?? row.cost ?? row.consume ?? row.need_point ?? row.lottery_price ?? null;
  return {
    id: id == null ? '' : clipped(String(id), 80),
    name: clipped(row.name ?? row.title, 80),
    free: Number.isSafeInteger(free) && free > 0 ? free : 0,
    price: Number.isSafeInteger(price) ? price : (price == null ? null : -1),
    status: Number.isSafeInteger(row.status) ? row.status : null,
  };
}
function projectMissions(data) {
  if (!data || typeof data !== 'object') return [];
  const rows = [
    ...(Array.isArray(data.list) ? data.list : []),
    ...(Array.isArray(data.grow_list) ? data.grow_list : []),
    ...(Array.isArray(data.daily_task_list) ? data.daily_task_list : []),
    ...(Array.isArray(data.grow_task_list) ? data.grow_task_list : []),
    ...(Array.isArray(data.missions) ? data.missions : []),
  ];
  const seen = new Set(), items = [];
  for (const row of rows) {
    const m = mission(row);
    if (!m || seen.has(m.type + ':' + m.id)) continue;
    seen.add(m.type + ':' + m.id);
    items.push(m);
  }
  return items.slice(0, 100);
}
function projectSign(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.list)) return data.list.map(mission).filter(Boolean).slice(0, 20);
  const one = mission(data);
  return one ? [one] : [];
}
function adTimesLeft(data) {
  const current = Number(data?.current_times);
  const total = Number(data?.total_times);
  if (!Number.isSafeInteger(total) || total < 1 || total > 1000) return 0;
  if (!Number.isSafeInteger(current) || current < 0 || current > total) return 0;
  return total - current;
};
function feedPostId(row) {
  const id = row?.type === 'r_feed' ? row.content_feed?.id : row?.id;
  return typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(id) ? id : '';
}
function feedAuthorId(row) {
  const feed = row?.type === 'r_feed' ? row.content_feed : row;
  const id = String(feed?.user?.user_id ?? '');
  return /^[1-9][0-9]{0,19}$/.test(id) ? id : '';
}
function alreadyVoted(row) {
  const feed = row?.type === 'r_feed' ? row.content_feed : row;
  const ext = feed?.ext && typeof feed.ext === 'object' ? feed.ext : {};
  return Number(feed?.is_vote ?? ext.is_vote) === 1;
}
function fileStore(file) { return rewardStore(file); }
const defaultStateFile = () => path.join(path.dirname(process.env.GRAVITY_ACCOUNT_STATE_FILE || path.join(__dirname, '.session/account-state.json')), 'tasks-state.json');

function createTasksService({
  read = api.readTaskList, pointAward = api.writePointAward, signAward = api.writeSignAward,
  lotteryDraw = api.writeLotteryDraw, identity = loadMemberIdentity, request = httpsRequest,
  now = Date.now, store = fileStore(defaultStateFile()), timers = globalThis, log = () => {},
  enabled = process.env.GRAVITY_TASKS_SYNC !== '0',
  readVoice = api.readSignedVoice, writeFeed = api.writeFeed, adComplete = api.writeAdComplete,
  accountState = api.accountStatus,
  wait,
} = {}) {
  const serial = createSerial(4, () => new TasksError('任务正在处理，请稍后重试。', 429));
  const receipts = new Map();
  let st = null, timer = null, running = false, lastRunAt = 0, ads = null;
  const today = () => jstDay(now());
  const pause = wait || (ms => new Promise(resolve => {
    const t = timers.setTimeout(resolve, ms);
    t?.unref?.();
  }));

  function resetDay() {
    st.day = today(); st.writes = 0; st.claimed = []; st.likes = 0;
  }
  function fresh(who) {
    return {version: 1, identity: who.identity, auto: true, day: '', writes: 0, claimed: [], likes: 0, recent: [], liked: [], noLike: []};
  }
  function load(who) {
    if (st?.identity === who.identity) return;
    const saved = store.load();
    st = saved && saved.version === 1 && saved.identity === who.identity ? saved : fresh(who);
    if (!Array.isArray(st.claimed)) st.claimed = [];
    if (!Array.isArray(st.recent)) st.recent = [];
    if (!Array.isArray(st.pending)) st.pending = [];
    if (!Number.isSafeInteger(st.likes) || st.likes < 0) st.likes = 0;
    // Older state only kept today's likes as claimed "like:<id>@<day>" entries.
    if (!Array.isArray(st.liked)) st.liked = st.claimed.filter(c => typeof c === 'string' && c.startsWith('like:')).map(c => c.slice(5).replace(/@[0-9-]+$/, ''));
    if (!Array.isArray(st.noLike)) st.noLike = [];
  }
  function persist() {
    st.claimed = st.claimed.slice(-500);
    st.recent = st.recent.filter(x => x?.kind !== 'like').slice(0, 20);
    st.liked = st.liked.slice(-LIKE_MEMORY);
    st.noLike = st.noLike.slice(-LIKE_MEMORY);
    store.save(st);
  }
  function account() {
    const who = identity();
    if (!who) throw new TasksError('官方账号会话不可用，请先恢复会话。', 401);
    load(who);
    if (st.day !== today()) resetDay();
    return who;
  }
  function record(kind, label, ok) {
    st.recent.unshift({at: now(), kind, label: clipped(label, 60), ok});
    st.recent = st.recent.slice(0, 20);
  }
  async function signed(kind, extra, who) {
    const r = await read(kind, extra, request, {expectedIdentity: who.identity});
    if (identity()?.identity !== who.identity) throw new TasksError('账号会话已变化。', 409);
    return r;
  }
  async function voice(kind, extra, who) {
    const r = await readVoice(kind, extra, request, {expectedIdentity: who.identity});
    if (identity()?.identity !== who.identity) throw new TasksError('账号会话已变化。', 409);
    return r;
  }
  async function list() {
    const who = account();
    const [point, sign, lottery, cards] = await Promise.all([
      signed('pointMissions', {user_id: who.user}, who).catch(() => ({errno: -1})),
      signed('signMissions', {}, who).catch(() => ({errno: -1})),
      signed('lotteryList', {source: 'cp'}, who).catch(() => ({errno: -1})),
      signed('lotteryCards', {source: 'cp'}, who).catch(() => ({errno: -1})),
    ]);
    if (identity()?.identity !== who.identity) throw new TasksError('账号会话已变化。', 409);
    const out = {missions: [], sign: [], lottery: [], errors: []};
    if (point?.errno === 0) out.missions = projectMissions(point.data);
    else out.errors.push('missions');
    if (sign?.errno === 0) {
      const items = projectSign(sign.data);
      if (!items.length && sign.data && typeof sign.data === 'object' && !sign.data.id && !Array.isArray(sign.data.list))
        out.errors.push('sign');
      else out.sign = items;
    } else out.errors.push('sign');
    for (const result of [lottery, cards]) {
      if (result?.errno !== 0) continue;
      const rows = [
        ...(Array.isArray(result.data?.list) ? result.data.list : []),
        ...(Array.isArray(result.data?.card_list) ? result.data.card_list : []),
      ];
      const wrapper = lotteryEntry(result.data);
      if (wrapper && (wrapper.free > 0 || wrapper.price === 0)) out.lottery.push(wrapper);
      for (const row of rows.slice(0, 50)) {
        const entry = lotteryEntry(row);
        if (entry) out.lottery.push(entry);
      }
    }
    out.lottery = out.lottery.slice(0, 50);
    return out;
  }
  async function claim(body) {
    const who = account();
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(k => !['kind', 'id', 'award_type', 'confirmed', 'request_id'].includes(k))) {
      throw new TasksError('领取参数无效。');
    }
    const {kind, confirmed, request_id} = body;
    if (!['point', 'sign', 'lottery'].includes(kind) || confirmed !== true || typeof request_id !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request_id)) {
      throw new TasksError('领取需要明确确认与提交编号。');
    }
    const key = who.identity + ':' + request_id;
    const payload = kind === 'point'
      ? JSON.stringify([kind, String(body.id || ''), Number(body.award_type)])
      : JSON.stringify([kind]);
    for (const [k, r] of receipts) if (r.expires <= now()) receipts.delete(k);
    const old = receipts.get(key);
    if (old) {
      if (old.payload !== payload) throw new TasksError('该提交编号已用于另一项领取。', 409);
      return old.work;
    }
    if (receipts.size >= 64) throw new TasksError('领取记录已满，请稍后再试。', 429);
    let submitted = false;
    const work = serial(async () => {
      if (identity()?.identity !== who.identity) throw new TasksError('账号会话已变化，领取未执行。', 409);
      if (st.day !== today()) resetDay();
      if (st.writes >= DAY_WRITES) throw new TasksError('今日自动领取已达上限，明天再试。', 429);
      let result, label;
      try {
        submitted = true;
        if (kind === 'point') {
          if (!/^[1-9][0-9]{0,9}$/.test(String(body.id || '')) || ![0, 1, 2].includes(Number(body.award_type))) {
            throw new TasksError('任务参数无效。');
          }
          label = 'point:' + body.id;
          result = await pointAward({id: String(body.id), award_type: Number(body.award_type)}, request, {expectedIdentity: who.identity});
        } else if (kind === 'sign') {
          label = 'sign';
          result = await signAward({award_type: 0}, request, {expectedIdentity: who.identity});
        } else {
          label = 'lottery';
          result = await lotteryDraw({}, request, {expectedIdentity: who.identity});
        }
      } catch (error) {
        if (error instanceof TasksError) throw error;
        throw new TasksError('领取结果未确认；不会自动重试，请稍后核对。', 504);
      }
      if (identity()?.identity !== who.identity) throw new TasksError('账号会话已变化。', 409);
      if (result?.errno !== 0) throw new TasksError('官方未确认领取成功。', 502);
      st.writes++;
      st.claimed.push(label + '@' + today());
      record(kind, label, true);
      persist();
      return {claimed: true, kind};
    });
    receipts.set(key, {payload, work, expires: now() + 3600000});
    work.catch(() => { if (!submitted && receipts.get(key)?.work === work) receipts.delete(key); });
    return work;
  }
  async function take(kind, extra, who, label, pretty) {
    if (st.writes >= DAY_WRITES || !st.auto || identity()?.identity !== who.identity) return false;
    if (st.claimed.includes(label) || st.pending.some(p => p.label === label && now()-p.at < 120_000)) return false;
    st.pending = st.pending.filter(p => now()-p.at < 86400_000 && p.label !== label);
    st.pending.push({label, at:now()});
    persist();
    try {
      const result = kind === 'point' ? await pointAward(extra, request, {expectedIdentity: who.identity})
        : kind === 'sign' ? await signAward(extra, request, {expectedIdentity: who.identity})
        : kind === 'ad' ? await adComplete(extra, request, {expectedIdentity: who.identity})
        : await lotteryDraw(extra, request, {expectedIdentity: who.identity});
      if (identity()?.identity !== who.identity) return false;
      if (result?.errno === 0) {
        st.writes++;
        st.claimed.push(label);
        record(kind, pretty, true);
        st.pending = st.pending.filter(p => p.label !== label);
        persist();
        log('tasks auto-' + kind);
        return true;
      }
      log('tasks ' + kind + ' errno ' + result?.errno + ' ' + label);
    } catch (error) {
      log('tasks ' + kind + ' failed ' + label + ': ' + clipped(error?.message, 80));
    }
    return false;
  }
  async function claimReady(data, who) {
    let done = 0;
    for (const m of data.missions) {
      if (done >= 12 || st.writes >= DAY_WRITES) break;
      if (m.status !== CLAIMABLE || ![0,1,2].includes(m.type)) continue;
      if (await take('point', {id: String(m.id), award_type: m.type}, who, 'point:' + m.type + ':' + m.id + '@' + today(), (m.name || String(m.id)) + ' +' + m.points))
        done++;
    }
    for (const m of data.sign) {
      if (done >= 12 || st.writes >= DAY_WRITES) break;
      if (m.status !== CLAIMABLE) continue;
      if (await take('sign', {award_type: 0}, who, 'sign@' + today(), '签到 +' + m.points))
        done++;
    }
    return done;
  }
  async function watchAds(who) {
    let popup;
    try { popup = await voice('adPopup', {}, who); }
    catch (error) { log('ad popup failed: ' + clipped(error?.message, 80)); return 0; }
    if (popup?.errno !== 0) { log('ad popup errno ' + popup?.errno); return 0; }
    let left = adTimesLeft(popup.data);
    if (popup.data?.status === 2) left = 0;
    ads = {total:popup.data?.total_times, used:popup.data?.current_times, remaining:left};
    let n = 0;
    const first = Number(popup.data.current_times);
    for (let i = 0; i < Math.min(left, 5); i++) {
      if (st.writes >= DAY_WRITES || !st.auto) break;
      if (i) await pause(AD_GAP_MS);
      if (identity()?.identity !== who.identity) break;
      const index = first + i + 1;
      if (await take('ad', {scene: 'ad_point'}, who, 'ad:ad_point@' + today() + ':' + index, '广告银币 ' + index)) n++;
      else break;
    }
    if (!st.claimed.includes('ad:ad_draw@' + today()) && st.writes < DAY_WRITES) {
      let info = {errno: -1};
      try { info = await voice('lotteryInfo', {}, who); }
      catch (error) { log('lotteryInfo failed: ' + clipped(error?.message, 80)); }
      if (info?.errno === 0 && Number(info.data?.is_free) === 1) {
        if (n) await pause(AD_GAP_MS);
        if (identity()?.identity === who.identity &&
            await take('ad', {scene: 'ad_draw'}, who, 'ad:ad_draw@' + today(), '免费抽奖广告')) n++;
      }
    }
    return n;
  }
  // "Each post once" and "a like you take back stays removed" hold across days and
  // page reloads, and the page's auto-likes share this memory and the daily cap.
  const likeable = id => !st.liked.includes(id) && !st.noLike.includes(id);
  function ledgerAccount() {
    const who = identity();
    if (!who) return null;
    load(who);
    if (st.day !== today()) resetDay();
    return who;
  }
  const likeLedger = {
    allowAuto(id) {
      if (!ledgerAccount()) return {ok: false, capped: false};
      if (st.likes >= LIKE_DAY_CAP) return {ok: false, capped: true};
      return {ok: likeable(id), capped: false};
    },
    autoLiked(id) {
      if (!ledgerAccount()) return;
      st.likes++;
      if (!st.liked.includes(id)) st.liked.push(id);
      persist();
    },
    cancelled(id) {
      if (!ledgerAccount()) return;
      if (!st.noLike.includes(id)) st.noLike.push(id);
      persist();
    },
  };
  async function likeFeed(who) {
    if ((st.likes || 0) >= LIKE_DAY_CAP) return 0;
    let rec;
    try { rec = await voice('feedRecommended', {last_id: ''}, who); }
    catch (error) { log('feed list failed: ' + clipped(error?.message, 80)); return 0; }
    if (rec?.errno !== 0 || !Array.isArray(rec.data?.list)) return 0;
    let n = 0;
    for (const row of rec.data.list) {
      if (n >= LIKE_TICK_CAP || st.likes >= LIKE_DAY_CAP) break;
      const id = feedPostId(row);
      const author = feedAuthorId(row);
      if (!id || !author || alreadyVoted(row) || !likeable(id)) continue;
      try {
        const result = await writeFeed('feedVote', {id, vote: '1', to_user_id: author, type: 'f', feed_type: 'feed8', route_path: ''}, request, {expectedIdentity: who.identity});
        if (identity()?.identity !== who.identity) break;
        if (result?.errno === 0) {
          st.likes++;
          st.liked.push(id);
          n++;
        } else log('like errno ' + result?.errno + ' ' + id);
      } catch (error) {
        log('like failed ' + id + ': ' + clipped(error?.message, 80));
      }
      if (n) await pause(LIKE_GAP_MS);
    }
    if (n) log('tasks auto-liked ' + n);
    return n;
  }
  async function tick() {
    if (!enabled || running) return false;
    const who = identity();
    if (!who || accountState().state === 'rejected_session') return false;
    running = true;
    try {
      load(who);
      if (!st.auto) return false;
      if (st.day !== today()) resetDay();
      const data = await list().catch(() => null);
      if (!data || identity()?.identity !== who.identity) return false;
      await claimReady(data, who);
      await watchAds(who);
      const again = await list().catch(() => null);
      if (again && identity()?.identity === who.identity) await claimReady(again, who);
      await likeFeed(who);
      lastRunAt = now();
      persist();
      return true;
    } catch (error) {
      log('tasks tick skipped: ' + (error?.message || 'error'));
      return false;
    } finally {
      running = false;
    }
  }
  function setAuto(on) {
    const who = account();
    st.auto = on === true;
    persist();
    return {auto: st.auto};
  }
  function start() {
    if (!enabled || timer) return;
    const loop = () => {
      timer = timers.setTimeout(async () => { await tick(); loop(); }, TICK_MS);
      timer.unref?.();
    };
    timer = timers.setTimeout(async () => { await tick(); loop(); }, 60_000);
    timer.unref?.();
  }
  function stop() { timers.clearTimeout(timer); timer = null; }
  function status() {
    const who = identity();
    if (who) load(who);
    return {
      enabled, auto: st ? st.auto !== false : true, last_run_at: lastRunAt || null,
      today_writes: st?.day === today() ? st.writes : 0,
      today_likes: st?.day === today() ? st.likes || 0 : 0,
      ads,
      recent: st ? st.recent.filter(x => x?.kind !== 'like').slice(0, 10) : [],
    };
  }
  return {list, claim, tick, setAuto, start, stop, status, likeLedger};
}

module.exports = {createTasksService, TasksError, mission, lotteryEntry, projectMissions, projectSign, adTimesLeft};

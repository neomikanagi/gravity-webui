'use strict';
// Official H5 voice tasks. Only claim server-confirmed rewards; never manufacture task progress.
// Contracts: https://cdn-f1.gravity.place/static/gravity-wapplus/index-m1clKz69.js
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const api = require('./gravity-api.cjs');
const {httpsRequest} = require('./gravity-upstream.cjs');
const {loadMemberIdentity} = require('./gravity-member.cjs');
const {clipped} = require('./gravity-util.cjs');
const ACTIVE_MS = 10_000, IDLE_MS = 60_000, UNKNOWN_MS = 120_000;
const DAILY_ATTEMPTS = 200, PASS_ATTEMPTS = 12;
const numeric = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const positiveId = v => /^[1-9][0-9]{0,19}$/.test(String(v ?? ''));
const jstDay = ms => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

function rewardStore(file) {
  return {
    load() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw new Error('reward_store_unreadable'); }
    },
    save(value) {
      fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
      const temp = file + '.' + crypto.randomUUID() + '.tmp';
      let fd;
      try {
        fd = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(value) + '\n');
        fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temp, file);
        // Commit the rename too: the pending journal must be durable before a claim leaves the process.
        const dir = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temp); } catch {}
      }
    },
  };
}
const defaultFile = () => path.join(path.dirname(process.env.GRAVITY_ACCOUNT_STATE_FILE || path.join(__dirname, '.session/account-state.json')), 'rewards-state.json');
function prizes(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 30).map(p => ({name:clipped(p?.award_name || p?.prize_name, 70),
    count:numeric(p?.count) ? p.count : numeric(p?.prize) ? p.prize : null})).filter(p => p.name);
}
function personalTasks(data) {
  const seen = new Set(), out = [];
  for (const key of ['direct_list', 'generic_task', 'achievement_task']) {
    for (const t of Array.isArray(data?.[key]) ? data[key].slice(0, 100) : []) {
      if (!positiveId(t?.task_id) || seen.has(String(t.task_id))) continue;
      seen.add(String(t.task_id));
      out.push({id:String(t.task_id), name:clipped(t.task_name, 90), status:[0,1,2].includes(t.status) ? t.status : -2,
        current:numeric(t.current) ? t.current : null, target:numeric(t.target) ? t.target : null,
        starts:numeric(t.start_time) ? t.start_time : 0, ends:numeric(t.end_time) ? t.end_time : 0,
        rewards:prizes(t.prize_list)});
    }
  }
  return out;
}
function roomLevels(data) {
  if (!Array.isArray(data?.task_list)) return [];
  return data.task_list.slice(0, 100).filter(t => numeric(t?.level) && t.level > 0 && t.level <= 100).map(t => {
    let reason = '';
    if (t.status === 2) reason = '已领取';
    else if (t.status === 3 || t.remain_count === 0) reason = '已领完';
    else if (!numeric(data.anchor_sernior_level) || !numeric(t.sernior_level) || data.anchor_sernior_level < t.sernior_level) reason = '房间等级不足';
    else if (!numeric(data.task_popular_value) || !numeric(t.task_target) || data.task_popular_value < t.task_target) reason = '房间任务未达成';
    else if (t.can_receive !== 1) reason = '等官方确认领取资格（停留/关系/指定用户等）';
    else if (t.status !== 1 || !numeric(t.remain_count)) reason = '官方状态待确认';
    return {level:t.level, status:t.status, remaining:numeric(t.remain_count) ? t.remain_count : null,
      eligible:!reason, reason:reason || '可领取', rewards:prizes(t.award_list)};
  });
}
function createRewardsService({
  read = api.readReward, write = api.writeReward, request = httpsRequest,
  identity = loadMemberIdentity, roomContext = () => null, auto = () => true,
  accountState = api.accountStatus, enabled = process.env.GRAVITY_TASKS_SYNC !== '0',
  store = rewardStore(defaultFile()), now = Date.now, timers = globalThis, log = () => {},
} = {}) {
  let st = null, running = false, started = false, stopping = false, timer = null, generation = 0, lastStarted = -Infinity;
  let tabs = [], tabsAt = -Infinity, due = new Map(), signDue = 0, lastSignal = '', lastError = '', errorIdentity = '';
  let view = {personal:[], sign:null, room:null, last_run_at:null};
  const allowed = () => enabled && !stopping && auto() !== false;
  function load(who) {
    if (st?.identity === who.identity) return st;
    const saved = store.load();
    if (saved && (saved.version !== 1 || !numeric(saved.attempts) || !numeric(saved.claims) || typeof saved.identity !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(saved.day || '') || !Array.isArray(saved.entries) || !Array.isArray(saved.recent) ||
        !saved.entries.every(e => e && typeof e.key === 'string' && numeric(e.at) && numeric(e.next_at) && numeric(e.failures) && ['pending','retry','done'].includes(e.state)))) throw new Error('reward_store_invalid');
    st = saved?.identity === who.identity ? saved : {version:1, identity:who.identity, day:jstDay(now()), attempts:0, claims:0, entries:[], recent:[]};
    tabs = []; tabsAt = -Infinity; due.clear(); signDue = 0;
    view = {personal:[], sign:null, room:null, last_run_at:null};
    return st;
  }
  function persist(s) {
    s.entries = s.entries.filter(e => e && typeof e.key === 'string' && numeric(e.at) && e.at >= now() - 8*86400_000).slice(-1600);
    s.recent = s.recent.slice(0, 30);
    try { store.save(s); } catch { throw new Error('storage_unavailable'); }
  }
  function active(who, s) { return st === s && identity()?.identity === who.identity && allowed() && !['rejected_session','missing_session'].includes(accountState().state); }
  function room(who) {
    const r = roomContext();
    return r && r.identity === who.identity && positiveId(r.channel_id) && positiveId(r.anchor_id) ? r : null;
  }
  function sameRoom(who, original) {
    const r = room(who);
    return !!r && r.channel_id === original.channel_id && r.anchor_id === original.anchor_id;
  }
  async function get(kind, extra, who, s) {
    if (!active(who, s)) throw new Error('reward_authority_changed');
    let r;
    try { r = await read(kind, extra, request, {expectedIdentity:who.identity}); }
    catch { throw new Error('reward_read_failed_' + kind); }
    if (!active(who, s)) throw new Error('reward_authority_changed');
    if (r?.errno !== 0 || !r.data || typeof r.data !== 'object') throw new Error('reward_read_failed_' + kind);
    return r.data;
  }
  function entry(s, key) { return s.entries.find(e => e.key === key); }
  function record(s, kind, label, state, awards = []) {
    s.recent.unshift({at:now(), kind, label:clipped(label, 90), state, rewards:awards});
    s.recent = s.recent.slice(0, 30);
  }
  function reconcile(s, key, claimed) {
    const old = entry(s, key);
    if (claimed && old && old.state !== 'done') {
      old.state = 'done'; old.reason = '官方已确认领取'; old.at = now();
      record(s, old.kind, old.label, 'reconciled'); persist(s);
    }
  }
  function blocked(s, key, fallback) {
    const e = entry(s, key);
    if (e?.state === 'done') return '已领取';
    if (e && e.next_at > now()) return e.reason || '等待复核';
    return fallback;
  }
  async function take({kind, extra, key, label, box}, who, s, budget) {
    if (!active(who, s) || jstDay(now()) !== s.day || budget.count >= PASS_ATTEMPTS || s.attempts >= DAILY_ATTEMPTS || (box && !sameRoom(who, box))) return false;
    let e = entry(s, key);
    if (e?.state === 'done' || (e && e.next_at > now())) return false;
    // The caller just fetched an authoritative claimable state. Ambiguous older attempts may be retried
    // only after the reconciliation delay, with the same server-side once-per-period reward key.
    if (!e) { e = {key, kind, label, failures:0}; s.entries.push(e); }
    Object.assign(e, {state:'pending', at:now(), next_at:now()+UNKNOWN_MS, reason:'领取结果待官方复核'});
    s.attempts++; budget.count++;
    persist(s); // Fail closed on journal errors, before any HTTP mutation.
    let result;
    try {
      result = await write(kind, extra, request, {expectedIdentity:who.identity,
        authorize:() => active(who,s) && jstDay(now()) === s.day && (!box || sameRoom(who,box))});
    } catch {
      if (active(who,s)) { record(s, kind, label, 'pending'); persist(s); }
      return false;
    }
    if (!active(who,s)) return false;
    // Room claims have an inner status: errno=0 alone does NOT mean a prize was received.
    const success = result?.errno === 0 && (box ? result.data?.status === 0 : Array.isArray(result.data?.list));
    const already = box && result?.errno === 0 && result.data?.status === 4;
    if (success || already) {
      e.state = 'done'; e.reason = already ? '官方已领取' : '已领取'; e.next_at = 0;
      if (success) {
        s.claims++;
        record(s, kind, label, 'claimed', prizes(box ? result.data.award_list : result.data.list));
        log('reward claimed ' + kind); // Do not log user, room, token or raw server payload.
      }
    } else {
      e.failures++;
      e.state = result?.errno === 0 && !box ? 'pending' : 'retry';
      const code = result?.errno;
      const inner = box && code === 0 ? result.data?.status : null;
      e.reason = code === -13 ? '需在 App 绑定手机号' :
        ({42001:'仅关注者可领',42002:'仅好友可领',502140:'应援度不足',502141:'仅指定用户可领'})[code] ||
        ({2:'房间人气不足',5:'已领完',6:'等停留满十分钟',7:'房间等级不足'})[inner] || '官方未确认领取，稍后复核';
      e.next_at = now() + (code === -13 ? 24*3600_000 : Math.min(30*60_000, UNKNOWN_MS * 2**Math.min(e.failures-1,4)));
      record(s, kind, label, e.state);
    }
    persist(s);
    return success;
  }
  async function personal(who, s, budget) {
    if (now() - tabsAt >= 10*60_000) {
      const data = await get('rewardTabs', {}, who, s);
      if (!Array.isArray(data.list)) throw new Error('reward_tabs_invalid');
      tabs = data.list.filter(t => [1,4,5].includes(t?.tab_type) && positiveId(t.tab_id)).slice(0, 6);
      tabsAt = now();
    }
    for (const tab of tabs) {
      if ((due.get(String(tab.tab_id)) || 0) > now()) continue;
      const data = await get('rewardTasks', {tab_id:String(tab.tab_id)}, who, s);
      if (!['direct_list','generic_task','achievement_task'].some(k => Array.isArray(data[k]))) throw new Error('reward_tasks_invalid');
      const items = personalTasks(data);
      due.set(String(tab.tab_id), now() + (tab.tab_type === 1 && room(who) ? ACTIVE_MS : IDLE_MS));
      for (const t of items) {
        // Scope includes server period metadata, but never local progress/current (not an identity).
        const key = 'task:' + s.day + ':' + t.id + ':' + t.starts + ':' + t.ends;
        reconcile(s, key, t.status === 2);
        if (t.status === 1 && (!t.ends || t.ends*1000 > now())) {
          await take({kind:'taskReward', extra:{task_id:t.id}, key, label:t.name || '个人任务'}, who, s, budget);
        }
        t.state = blocked(s, key, t.status === 1 ? '可领取' : t.status === 2 ? '已领取' : '未达成');
      }
      if (!active(who,s)) return;
      view.personal = [...view.personal.filter(t => t.tab_id !== String(tab.tab_id)), ...items.map(t => ({...t,tab_id:String(tab.tab_id)}))].slice(0, 200);
    }
  }
  async function sign(who, s, budget) {
    if (signDue > now()) return;
    const data = await get('rewardSign', {}, who, s);
    if (![-1,0,1].includes(data.sign_status) || !numeric(data.voice_stay_time) || !numeric(data.voice_stay_current)) throw new Error('reward_sign_invalid');
    const key = 'sign:' + s.day;
    reconcile(s, key, data.sign_status === 1);
    // H5 sign status is -1 locked, 0 claimable, 1 claimed (NOT legacy SignMission.status).
    if (data.sign_status === 0) await take({kind:'weeklySignReward', extra:{}, key, label:'听房七日签到'}, who, s, budget);
    signDue = now() + (room(who) ? 30_000 : IDLE_MS);
    if (active(who,s)) view.sign = {current:data.voice_stay_current, target:data.voice_stay_time,
      day:numeric(data.accumulate_sign) ? data.accumulate_sign + (data.sign_status === 1 ? 0 : 1) : null,
      state:blocked(s,key,data.sign_status === 1 ? '已领取' : data.sign_status === 0 ? '可领取' : '听房进度未达成'),
      rewards:Array.isArray(data.list) ? data.list.slice(0,7).map(t => ({points:numeric(t?.point) ? t.point : null,has_box:positiveId(t?.box_id)})) : []};
  }
  async function boxes(who, s, budget) {
    const r = room(who);
    if (!r) { view.room = null; return; }
    const data = await get('rewardRoom', {anchor_id:r.anchor_id,channel_id:r.channel_id}, who, s);
    if (!sameRoom(who,r)) { view.room = null; return; }
    if (!Array.isArray(data.task_list)) throw new Error('reward_room_invalid');
    const levels = roomLevels(data);
    for (const level of levels) {
      // Official rules reset at JST midnight; same host's accumulated stay is shared across its rooms.
      const key = 'box:' + s.day + ':' + r.anchor_id + ':' + level.level;
      reconcile(s,key,level.status === 2);
      if (level.eligible) await take({kind:'roomTaskReward',extra:{anchor_id:r.anchor_id,channel_id:r.channel_id,task_level:String(level.level)},
        key,label:'房间 ' + level.level + ' 级宝箱',box:r},who,s,budget);
      level.state = blocked(s,key,level.reason);
    }
    if (active(who,s) && sameRoom(who,r)) view.room = {channel_id:r.channel_id,condition:data.box_award_status,
      progress:numeric(data.task_popular_value) ? data.task_popular_value : null,levels};
    else view.room = null;
  }
  async function tick() {
    if (!allowed() || running || ['rejected_session','missing_session'].includes(accountState().state)) return false;
    const who = identity();
    if (!who) return false;
    running = true; lastStarted = now();
    try {
      const s = load(who), day = jstDay(now());
      if (s.day !== day) {
        s.day = day; s.attempts = 0; s.claims = 0; due.clear(); signDue = 0;
        view = {personal:[],sign:null,room:null,last_run_at:null};
      }
      const budget = {count:0}, failures = [];
      // Isolate lanes: an unavailable personal/event endpoint must not starve room boxes or sign-in.
      for (const [name, fn] of [['personal',personal],['sign',sign],['boxes',boxes]]) {
        if (!active(who,s)) break;
        try { await fn(who,s,budget); }
        catch (error) {
          // Storage failures must stop all lanes, not silently send a write without a journal.
          if (!String(error.message).startsWith('reward_')) throw error;
          failures.push(name);
        }
      }
      if (active(who,s)) {
        view.last_run_at = now();
        lastError = failures.length ? '暂未刷新：' + failures.join(' / ') : '';
        errorIdentity = who.identity;
        persist(s);
      }
      return failures.length === 0;
    } catch {
      lastError = '领奖状态存储不可用；已停止写请求以防重复领取';
      errorIdentity = who.identity;
      log('reward scan stopped: storage/state unavailable');
      return false;
    } finally { running = false; }
  }
  function schedule(ms) {
    if (!started) return;
    timers.clearTimeout(timer);
    const gen = generation;
    timer = timers.setTimeout(async () => {
      timer = null;
      if (!started || gen !== generation) return;
      await tick();
      if (started && gen === generation && timer === null) schedule(roomContext() ? ACTIVE_MS : IDLE_MS);
    }, ms);
    timer?.unref?.();
  }
  function wake() {
    if (!started || !allowed()) return;
    due.clear(); signDue = 0;
    schedule(Math.max(1500, 3000 - (now() - lastStarted)));
  }
  function observe(memberState) {
    const r = roomContext();
    const signal = r ? JSON.stringify([r.identity,r.anchor_id,r.channel_id,memberState?.seated]) : '';
    if (signal !== lastSignal) { lastSignal = signal; wake(); }
  }
  function start() { if (started || !enabled) return; stopping = false; started = true; generation++; schedule(1000); }
  function stop() { stopping = true; started = false; generation++; timers.clearTimeout(timer); timer = null; }
  function status() {
    const who = identity();
    if (!who || st?.identity !== who.identity) return {enabled,auto:allowed(),running:false,today_claims:0,recent:[],personal:[],sign:null,room:null,last_error:who?.identity === errorIdentity ? lastError : ''};
    return {enabled,auto:allowed(),running,last_error:lastError,today_claims:st.day === jstDay(now()) ? st.claims : 0,
      today_attempts:st.day === jstDay(now()) ? st.attempts : 0,limit:DAILY_ATTEMPTS,
      ...view,room:room(who) && view.room?.channel_id === room(who).channel_id ? view.room : null,
      recent:st.recent.slice(0,15)};
  }
  return {tick,start,stop,wake,observe,status};
}
module.exports = {createRewardsService,rewardStore,personalTasks,roomLevels,jstDay};

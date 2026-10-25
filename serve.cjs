#!/usr/bin/env node
'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const { InputError, validId, clipped, officialCdnImage, sendJson: json } = require('./gravity-util.cjs');
const { API_HOST, publicIPv4, officialLookup, httpsRequest } = require('./gravity-upstream.cjs');
const { publicRooms, publicFollowRooms } = require('./gravity-public.cjs');
const { parseRoomFromUrl, extractShortCode, resolveShareInput, fetchRoomInfo } = require('./gravity-share.cjs');
const { createStaticServer } = require('./gravity-static.cjs');
const { accountStatus, trySignedSearch, trySignedRooms, trySignedLabels, trySignedFollowRooms, trySignedFollowing, tryAccountAudienceToken, hotRoomKeywordSearch } = require('./gravity-api.cjs');
const { APP_ID, tokenPrivileges } = require('./static/controller.js');
const { OwnerError, createOwnerService } = require('./gravity-owner.cjs');
const { createMemberService } = require('./gravity-member.cjs');
const { createFeedService, FeedError } = require('./gravity-feed.cjs');
const { createImService, ImError } = require('./gravity-im.cjs');
const { createProfileService, ProfileError } = require('./gravity-profile.cjs');
const { createRelationService } = require('./gravity-relation.cjs');
const { createTranslateService, TranslateError } = require('./gravity-translate.cjs');
const { createTasksService, TasksError } = require('./gravity-tasks.cjs');
const { createRewardsService } = require('./gravity-rewards.cjs');

const TOKEN_PATH = '/gravity/h5/voiceroom/getVoiceToken';
const LIST_PATH = '/gravity/voice/getHotRoomOrPlan';
const SEARCH_SHORTCUTS = Object.freeze(['中国語', '人間関係', '占い']);
const MEMBER_ACTIONS = ['connect', 'enter', 'apply', 'publisher', 'renew', 'mute', 'leave', 'release', 'lucky-box', 'destroy', 'seat-mute', 'kick', 'update-room'];
// docker stop gives 10 s before SIGKILL; leave room to exit cleanly.
const DRAIN_MS = 8000;

// Archived snapshot: historical live-verification flags only, no account data.
function publicStatus() {
  return {
    verified_at: null, account_alias: null,
    anonymous_receive_verified: true,
    gravity_session_established: false,
    google_callback_received: true,
    login_errno: 1,
    speaking_end_to_end_verified: false,
    sdk_publish_accepted: true,
    independent_receiver_audio_verified: false,
    rtc_declares_publish_audio: false,
  };
}

function accountNotice(errno, fallback) {
  return errno === 40025 || errno === 40026
    ? '服务器保存的官方会话已失效（可能在其他设备登录），请先同步已有的新 App 会话；没有有效会话时再在官方 App 登录，不必重新抓包。' + fallback
    : '官方账号接口暂不可用。' + fallback;
}

const crossSite = req => req.headers['sec-fetch-site'] === 'cross-site';

/**
 * Account/feed writes only come from our own page: same origin, a per-surface action header, JSON, small body.
 * `fail(message, status)` builds the surface's own error type.
 */
async function guardedJson(req, { action, maxChars, fail, denied, tooLong, invalid }) {
  const origin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  if (req.headers.origin !== origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') ||
      req.headers['x-gravity-action'] !== action || req.headers['content-type'] !== 'application/json') {
    throw fail(denied, 403);
  }
  let text = '';
  for await (const chunk of req) {
    text += chunk.toString('utf8');
    if (text.length > maxChars) throw fail(tooLong);
  }
  try { return JSON.parse(text); } catch { throw fail(invalid); }
}
async function accountBody(req, member = false, anyChannel = false) {
  const allowed = member ? ['channel_id', 'confirmed', 'member_permit', 'stealth', 'muted', 'seat_id', 'lucky_box_id', 'issue_user_id', 'target_user_id', 'notice', 'auto_pass', 'tags'] : ['channel_id', 'confirmed', 'owner_permit', 'muted'];
  const body = await guardedJson(req, {
    action: member ? 'member-control' : 'owner-control', maxChars: 2048,
    fail: (message, status) => status ? new OwnerError(message, status) : new InputError(message),
    denied: '账号操作只能由本站页面明确确认。', tooLong: '操作内容过长。', invalid: '操作内容无效。',
  });
  // The top-bar force quit works without knowing the room (a refreshed page lost it).
  const channelOk = validId(body?.channel_id) || (anyChannel && body?.channel_id == null);
  if (!body || typeof body !== 'object' || Array.isArray(body) || !channelOk ||
      Object.keys(body).some(key => !allowed.includes(key))) throw new InputError('账号操作参数无效。');
  return body;
}
async function feedBody(req, allowed = ['sid', 'comment_id', 'content', 'reply_permit', 'request_id', 'confirmed']) {
  const body = await guardedJson(req, {
    action: 'feed-control', maxChars: 4096, fail: (message, status) => new FeedError(message, status),
    denied: '帖子操作只能由本站页面确认。', tooLong: '帖子操作内容过长。', invalid: '帖子操作无效。',
  });
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !allowed.includes(key))) {
    throw new FeedError('帖子参数无效。');
  }
  return body;
}

async function imBody(req, allowed) {
  const body = await guardedJson(req, {
    action: 'im-control', maxChars: 4096, fail: (message, status) => new ImError(message, status || 400),
    denied: '私信只能由本站页面确认发送。', tooLong: '私信内容过长。', invalid: '私信内容无效。',
  });
  if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !allowed.includes(key))) throw new ImError('私信参数无效。');
  return body;
}
// Browser file upload for 1:1 private images: same-origin multipart only.
// Text fields are tiny; the single file part is capped at ~1.2MB (official side sniffs jpg/png/gif).
function splitMultipart(buf, boundary) {
  const open = Buffer.from('--' + boundary);
  const close = Buffer.from('--' + boundary + '--');
  const parts = [];
  let i = 0;
  while (i < buf.length) {
    if (buf.slice(i, i + close.length).equals(close)) break;
    if (!buf.slice(i, i + open.length).equals(open)) throw new InputError('图片内容无效。');
    i += open.length;
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) i += 2;
    else throw new InputError('图片内容无效。');
    const headerEnd = buf.indexOf('\r\n\r\n', i);
    if (headerEnd < 0 || headerEnd - i > 1024) throw new InputError('图片内容无效。');
    const headers = buf.slice(i, headerEnd).toString('utf8');
    i = headerEnd + 4;
    const next = buf.indexOf(Buffer.from('\r\n--' + boundary), i);
    if (next < 0) throw new InputError('图片内容无效。');
    parts.push({headers, body: buf.slice(i, next)});
    i = next + 2;
    if (parts.length > 8) throw new InputError('图片内容无效。');
  }
  if (!parts.length) throw new InputError('图片内容无效。');
  return parts;
}
async function imImageBody(req) {
  const origin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  const type = String(req.headers['content-type'] || '');
  const bound = /^multipart\/form-data; boundary=([A-Za-z0-9'()+_,.\/=\?-]{8,70})$/i.exec(type);
  if (req.headers.origin !== origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') ||
      req.headers['x-gravity-action'] !== 'im-control' || !bound) {
    throw new ImError('私信只能由本站页面确认发送。', 403);
  }
  const chunks = []; let n = 0;
  for await (const chunk of req) {
    n += chunk.length;
    if (n > 1_200_000) throw new InputError('图片过大。');
    chunks.push(chunk);
  }
  const fields = {}, parts = splitMultipart(Buffer.concat(chunks), bound[1]);
  let file = null;
  for (const part of parts) {
    const name = /(?:^|;)\s*name="([A-Za-z0-9_]+)"/.exec(part.headers)?.[1];
    if (!name) throw new ImError('私信参数无效。');
    if (/filename=/i.test(part.headers)) {
      if (name !== 'file' || file) throw new ImError('私信参数无效。');
      file = part.body;
    } else {
      if (fields[name] !== undefined || part.body.length > 256) throw new ImError('私信参数无效。');
      fields[name] = part.body.toString('utf8');
    }
  }
  if (fields.confirmed !== 'true' || !validId(fields.peer) || typeof fields.chat_permit !== 'string' ||
      !fields.chat_permit || typeof fields.request_id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(fields.request_id) ||
      !file || Object.keys(fields).some(key => !['peer', 'confirmed', 'chat_permit', 'request_id'].includes(key))) {
    throw new ImError('私信参数无效。');
  }
  return {peer: fields.peer, chat_permit: fields.chat_permit, request_id: fields.request_id, confirmed: true, buffer: file};
}

function makeHandler({
  request = httpsRequest,
  status = publicStatus,
  account = accountStatus,
  signedSearch = trySignedSearch,
  signedRooms = trySignedRooms,
  signedLabels = trySignedLabels,
  signedFollowRooms = trySignedFollowRooms,
  signedFollowing = trySignedFollowing,
  signedAudienceToken = tryAccountAudienceToken,
  searchFallback = hotRoomKeywordSearch,
  owner = createOwnerService(),
  relation = createRelationService(),
  member = createMemberService({ onPeople: rows => relation.observe(rows), blocked: () => relation.blockedIds(), listedFollowRooms: signedFollowRooms }),
  feed = createFeedService(),
  translate = createTranslateService(),
  tasks = createTasksService(),
  rewards = createRewardsService({roomContext: () => member.rewardContext?.(), auto: () => tasks.status().auto}),
  im = createImService({ onBlocked: id => relation.noteBlocked(id) }),
  profile = createProfileService({ onPeople: rows => relation.observe(rows), onBlocked: id => relation.noteBlocked(id) }),
} = {}) {
  const serveStatic = createStaticServer(path.join(__dirname, 'static'));
  // Owner takeover and member entry both drive the one account; start them one at a time.
  let connectQueue = Promise.resolve();
  const connectAccount = fn => { const result = connectQueue.then(fn); connectQueue = result.catch(() => {}); return result; };

  async function feedApi(req, res, u) {
    if (crossSite(req)) throw new FeedError('请从本站页面访问。', 403);
    if (req.method === 'GET' && u.pathname === '/api/feed/list') {
      return json(res, 200, { errno: 0, data: await feed.list(u.searchParams.get('mode') || 'recommended', u.searchParams.get('cursor') || '', request) });
    }
    if (req.method === 'GET' && u.pathname === '/api/feed/detail') {
      return json(res, 200, { errno: 0, data: await feed.detail(u.searchParams.get('sid'), u.searchParams.get('cursor') || '', request) });
    }
    if (req.method === 'POST' && u.pathname === '/api/feed/reply') {
      return json(res, 200, { errno: 0, data: await feed.reply(await feedBody(req), request) });
    }
    if (req.method === 'POST' && u.pathname === '/api/feed/collect') {
      return json(res, 200, { errno: 0, data: await feed.collect(await feedBody(req, ['sid', 'collected', 'confirmed', 'request_id', 'auto']), request) });
    }
    return json(res, 405, { errno: -1, errmsg: '不支持的帖子操作。' });
  }

  async function imApi(req, res, u) {
    if (crossSite(req)) throw new ImError('请从本站页面访问。', 403);
    if (req.method === 'GET' && u.pathname === '/api/im/friends') {
      return json(res, 200, { errno: 0, data: await im.friends({ kind: u.searchParams.get('kind') || 'friends', cursor: u.searchParams.get('cursor') || '' }, request) });
    }
    if (req.method === 'GET' && u.pathname === '/api/im/status') return json(res, 200, { errno: 0, data: im.status({ keep: u.searchParams.get('keep') === '1' }) });
    if (req.method === 'GET' && u.pathname === '/api/im/chat') return json(res, 200, { errno: 0, data: await im.chat(u.searchParams.get('peer') || '', request) });
    if (req.method === 'POST' && u.pathname === '/api/im/connect') {
      const body = await imBody(req, ['confirmed']);
      if (body.confirmed !== true) throw new ImError('需要确认：连接私信会让其他设备上的私信连接下线。');
      return json(res, 200, { errno: 0, data: await im.connect(request) });
    }
    if (req.method === 'POST' && u.pathname === '/api/im/send') {
      return json(res, 200, { errno: 0, data: await im.send(await imBody(req, ['peer', 'text', 'request_id', 'confirmed', 'chat_permit']), request) });
    }
    if (req.method === 'POST' && u.pathname === '/api/im/send-image') {
      return json(res, 200, { errno: 0, data: await im.sendImage(await imImageBody(req), request) });
    }
    return json(res, 405, { errno: -1, errmsg: '不支持的私信操作。' });
  }

  async function profileApi(req, res, u) {
    if (crossSite(req)) throw new ProfileError('请从本站页面访问。', 403);
    if (req.method === 'GET' && u.pathname === '/api/profile/person') {
      return json(res, 200, {errno: 0, data: {person: await profile.person(u.searchParams.get('user_id') || '', request)}});
    }
    if (req.method === 'GET' && u.pathname === '/api/profile/posts') {
      return json(res, 200, {errno: 0, data: await profile.posts(u.searchParams.get('user_id') || '', u.searchParams.get('cursor') || '', u.searchParams.get('loaded') || '0', request)});
    }
    if (req.method === 'GET' && (u.pathname === '/api/profile/following' || u.pathname === '/api/profile/fans')) {
      const kind = u.pathname.endsWith('/fans') ? 'fans' : 'following';
      return json(res, 200, {errno: 0, data: await profile.relationList(kind, u.searchParams.get('user_id') || '', u.searchParams.get('cursor') || '', request)});
    }
    if (req.method === 'GET' && u.pathname === '/api/profile/gifts') {
      return json(res, 200, {errno: 0, data: await profile.gifts(u.searchParams.get('user_id') || '', u.searchParams.get('list_type') || 'receive', request)});
    }
    if (req.method === 'GET' && u.pathname === '/api/profile/footprints') {
      const tab = Number(u.searchParams.get('tab') || '0');
      return json(res, 200, {errno: 0, data: await profile.footprints(tab, u.searchParams.get('cursor') || '', request)});
    }
    if (req.method === 'POST' && u.pathname === '/api/profile/block-host') {
      const body = await guardedJson(req, {action: 'profile-control', maxChars: 2048,
        fail: (message, status) => new ProfileError(message, status || 400), denied: '拉黑只能由本站页面明确确认。', tooLong: '操作内容过长。', invalid: '操作内容无效。'});
      return json(res, 200, {errno: 0, data: await profile.blockHost(body, request)});
    }
    if (req.method === 'POST' && u.pathname === '/api/profile/block') {
      const body = await guardedJson(req, {action: 'profile-control', maxChars: 2048,
        fail: (message, status) => new ProfileError(message, status || 400), denied: '拉黑只能由本站页面明确确认。', tooLong: '操作内容过长。', invalid: '操作内容无效。'});
      return json(res, 200, {errno: 0, data: await profile.blockUser(body, request)});
    }
    return json(res, 405, {errno: -1, errmsg: '不支持的资料操作。'});
  }

  async function translateApi(req, res) {
    if (crossSite(req)) throw new TranslateError('请从本站页面访问。', 403);
    const body = await guardedJson(req, {
      action: 'translate-control', maxChars: 2048,
      fail: (message, status) => new TranslateError(message, status || 400),
      denied: '翻译只能由本站页面请求。', tooLong: '翻译内容过长。', invalid: '翻译内容无效。',
    });
    return json(res, 200, { errno: 0, data: await translate.translate(body) });
  }

  async function tasksApi(req, res, u) {
    const origin = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    if (crossSite(req) || (req.headers.origin && req.headers.origin !== origin)) throw new TasksError('请从本站页面访问。', 403);
    if (req.method === 'GET' && u.pathname === '/api/tasks/list') {
      return json(res, 200, {errno: 0, data: await tasks.list()});
    }
    if (req.method === 'GET' && u.pathname === '/api/tasks/status') {
      return json(res, 200, {errno: 0, data: {...tasks.status(), rewards:rewards.status()}});
    }
    if (req.method === 'POST' && (u.pathname === '/api/tasks/claim' || u.pathname === '/api/tasks/auto')) {
      const body = await guardedJson(req, {action: 'tasks-control', maxChars: 2048,
        fail: (message, status) => new TasksError(message, status || 400),
        denied: '任务只能由本站页面确认。', tooLong: '任务内容过长。', invalid: '任务内容无效。'});
      if (u.pathname === '/api/tasks/auto') {
        if (!body || typeof body !== 'object' || typeof body.auto !== 'boolean' || Object.keys(body).some(k => k !== 'auto')) {
          throw new TasksError('自动领取参数无效。');
        }
        const result = tasks.setAuto(body.auto);
        rewards.wake();
        return json(res, 200, {errno: 0, data: result});
      }
      return json(res, 200, {errno: 0, data: await tasks.claim(body)});
    }
    return json(res, 405, {errno: -1, errmsg: '不支持的任务操作。'});
  }

  async function memberApi(req, res, u) {
    if (req.method === 'GET' && (u.pathname === '/api/member/status' || u.pathname === '/api/member/board' || u.pathname === '/api/member/preview')) {
      if (crossSite(req)) throw new OwnerError('请从本站页面访问。', 403);
      const channel = u.searchParams.get('channel_id'), proof = req.headers['x-gravity-member-permit'];
      const data = u.pathname === '/api/member/status'
        ? await member.status(channel, request, proof)
        : u.pathname === '/api/member/board'
        ? await member.board(channel, request, proof, u.searchParams.get('cursor') || '')
        : await member.preview(channel, request);
      if (proof && u.pathname === '/api/member/status') rewards.observe(data);
      return json(res, 200, { errno: 0, data });
    }
    const action = u.pathname.slice('/api/member/'.length);
    if (req.method === 'POST' && action === 'force-release') {
      if (crossSite(req)) throw new OwnerError('请从本站页面访问。', 403);
      const body = await accountBody(req, true, true);
      return json(res, 200, { errno: 0, data: member.forceRelease(body.channel_id ?? null, request) });
    }
    if (req.method === 'POST' && MEMBER_ACTIONS.includes(action)) {
      const body = await accountBody(req, true);
      if (['connect', 'enter', 'apply', 'publisher', 'destroy'].includes(action) && body.confirmed !== true) throw new InputError('请在网页确认本次账号操作。');
      let data;
      if (action === 'connect') {
        data = await connectAccount(() => {
          if (owner.busy?.()) throw new OwnerError('房主接管仍在使用账号，请先停止。');
          return member.connect(body.channel_id, request, {stealth: body.stealth ?? false});
        });
      } else if (action === 'mute') {
        if (typeof body.muted !== 'boolean' || (!body.muted && body.confirmed !== true)) throw new InputError('发送声音需要明确确认。');
        data = await member.mute(body.channel_id, body.muted, request, body.member_permit);
      } else if (action === 'lucky-box') {
        if (body.confirmed !== true) throw new InputError('请在网页确认领取宝箱。');
        data = await member.claimBox(body.channel_id, request, body.member_permit, {lucky_box_id:body.lucky_box_id, issue_user_id:body.issue_user_id});
      } else if (action === 'seat-mute') {
        if (body.confirmed !== true || typeof body.muted !== 'boolean') throw new InputError('管理麦位需要明确确认。');
        const seatId = Number(body.seat_id);
        if (!Number.isSafeInteger(seatId) || seatId < 0 || seatId > 63) throw new InputError('麦位无效。');
        data = await member.seatMute(body.channel_id, request, body.member_permit, seatId, body.muted);
      } else if (action === 'kick') {
        if (body.confirmed !== true) throw new InputError('移出房间需要明确确认。');
        data = await member.kick(body.channel_id, request, body.member_permit, body.target_user_id);
      } else if (action === 'update-room') {
        if (body.confirmed !== true) throw new InputError('改房间需要明确确认。');
        data = await member.updateRoom(body.channel_id, request, body.member_permit, {notice: body.notice, auto_pass: body.auto_pass, tags: body.tags});
      } else data = await member[action](body.channel_id, request, body.member_permit);
      if (['enter','apply','publisher','leave','release','destroy'].includes(action)) rewards.wake();
      return json(res, 200, { errno: 0, data });
    }
    return json(res, 405, { errno: -3, errmsg: '不支持的账号入房操作。' });
  }

  async function ownerApi(req, res, u) {
    if (req.method === 'GET' && u.pathname === '/api/owner/status') {
      if (crossSite(req)) throw new OwnerError('请从本站页面访问。', 403);
      const data = await owner.status(u.searchParams.get('channel_id'), request, req.headers['x-gravity-owner-permit']);
      return json(res, 200, { errno: 0, data });
    }
    if (req.method === 'POST' && ['connect', 'mute', 'release'].some(action => u.pathname === '/api/owner/' + action)) {
      const body = await accountBody(req);
      let data;
      if (u.pathname.endsWith('/connect')) {
        if (body.confirmed !== true) throw new InputError('需要明确确认 App 连接冲突风险；未接管。');
        data = await connectAccount(() => {
          if (member.busy?.()) throw new OwnerError('账号入房仍在使用，请先停止。');
          return owner.connect(body.channel_id, request);
        });
      } else if (u.pathname.endsWith('/mute')) {
        if (typeof body.muted !== 'boolean' || (!body.muted && body.confirmed !== true)) throw new InputError('发送声音需要单独明确确认。');
        data = await owner.mute(body.channel_id, body.muted, request, body.owner_permit);
      } else data = await owner.release(body.channel_id, request, body.owner_permit);
      return json(res, 200, { errno: 0, data });
    }
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { errno: -3, errmsg: '不支持的房主操作。' });
  }

  async function friendRooms(req, res) {
    const parsed = await signedFollowRooms(request).catch(() => ({ errno: -1 }));
    if (parsed.errno !== 0) return json(res, 503, { errno: parsed.errno, errmsg: accountNotice(parsed.errno, '关注好友的房间暂不可用。') });
    const following = [];
    if (parsed.data?.list?.some(g => g.follow_type === 2 && g.list?.length)) {
      let cursor = ''; const visited = new Set();
      for (let page = 0; page < 5; page++) {
        const result = await signedFollowing(cursor, request).catch(() => ({ errno: -1 }));
        if (result.errno !== 0 || !Array.isArray(result.data?.list)) break;
        following.push(...result.data.list.slice(0, 100));
        const next = result.data.last_id;
        if (!validId(next) || visited.has(next) || !result.data.list.length) break;
        visited.add(next); cursor = next;
      }
    }
    return json(res, 200, { errno: 0, data: { rooms: publicFollowRooms(parsed.data, following), next_cursor: '' } });
  }

  async function search(req, res, u) {
    const keyword = (u.searchParams.get('keyword') || u.searchParams.get('q') || '').trim().slice(0, 100);
    if (!keyword) throw new InputError('请输入搜索关键词。');
    const limit = Math.min(20, Math.max(1, Number(u.searchParams.get('limit') || 10) || 10));
    const parsed = await signedSearch({ keyword, limit: String(limit) }, request).catch(() => ({ errno: -1 }));
    if (parsed.errno === 0) {
      return json(res, 200, { errno: 0, data: { rooms: publicRooms(parsed.data).slice(0, limit), keyword, mode: 'official' } });
    }
    const fallback = await searchFallback({ keyword, limit: String(limit) }, request, publicRooms);
    if (fallback.errno === 0) {
      return json(res, 200, { errno: 0, data: { ...fallback.data,
        notice: accountNotice(parsed.errno, '当前仅在公开热门房间中筛选，非全站搜索。') } });
    }
    const msg = parsed.errno === -4
      ? '官方搜索验签未通过，公开热门接口也暂不可用；可粘贴分享链接。'
      : accountNotice(parsed.errno, '公开热门接口也暂不可用；可粘贴分享链接。');
    return json(res, 503, { errno: parsed.errno, errmsg: msg });
  }

  async function labels(req, res) {
    const parsed = await signedLabels(request).catch(() => ({ errno: -1 }));
    const list = Array.isArray(parsed.data?.list) ? parsed.data.list : [];
    const items = list.filter(item => Number.isSafeInteger(Number(item?.id)) && Number(item.id) > 0 && typeof item.label === 'string')
      .slice(0, 30).map(item => ({ id: String(item.id), label: clipped(item.label, 40) }));
    return json(res, 200, { errno: 0, data: { labels: items, available: parsed.errno === 0 } });
  }

  async function rooms(req, res, u) {
    const cursor = u.searchParams.get('cursor') || '';
    const label_id = u.searchParams.get('label_id') || '';
    if (cursor && !validId(cursor)) throw new InputError('房间列表游标无效。');
    if (label_id && !/^[1-9][0-9]{0,8}$/.test(label_id)) throw new InputError('房间分类无效。');
    const official = await signedRooms({ cursor, label_id }, request).catch(() => ({ errno: -1 }));
    if (official.errno === 0) {
      const next = !label_id && typeof official.data?.last_id === 'string' && validId(official.data.last_id) && official.data.last_id !== cursor
        ? official.data.last_id : '';
      const list = publicRooms(official.data);
      // A page can be all ended rooms after filtering; the cursor still leads on.
      const rawRows = official.data?.room_list ?? official.data?.list;
      return json(res, 200, { errno: 0, data: { rooms: list, mode: 'official', next_cursor: Array.isArray(rawRows) && rawRows.length ? next : '' } });
    }
    const unavailable = () => json(res, 502, { errno: -1, errmsg: '房间列表暂不可用。' });
    const upstream = await request({ hostname: API_HOST, path: `${LIST_PATH}?ddd=3` });
    if (upstream.status !== 200) return unavailable();
    let parsed;
    try { parsed = JSON.parse(upstream.body.toString('utf8')); } catch { return unavailable(); }
    if (parsed.errno !== 0 || !parsed.data || typeof parsed.data !== 'object') return unavailable();
    return json(res, 200, { errno: 0, data: { rooms: publicRooms(parsed.data), mode: 'hot', next_cursor: '', notice: accountNotice(official.errno, '当前展示公开热门房间。') } });
  }

  async function resolve(req, res, u) {
    const room = await resolveShareInput(u.searchParams.get('url') || u.searchParams.get('share'), request);
    const info = await fetchRoomInfo({ channel_id: room.channel_id, anchor_id: room.anchor_id }, request);
    return json(res, 200, { errno: 0, data: { ...room,
      title: String(info?.room_name || room.title || '').slice(0, 200),
      anchor_name: String(info?.anchor_name || '').slice(0, 100),
      count: Number.isFinite(Number(info?.count)) && info?.count != null ? Number(info.count) : null,
    } });
  }

  async function agoraToken(req, res, u) {
    const channel_id = u.searchParams.get('channel_id');
    if (!validId(channel_id)) throw new InputError('需要有效的房间 ID。');
    if (u.searchParams.has('role_type')) throw new InputError('账号接口仅提供只收听凭证，不接受角色指定。');
    const parsed = await signedAudienceToken({ channel_id }, request).catch(() => ({ errno: -1 }));
    if (parsed.errno !== 0) return json(res, 401, { errno: parsed.errno, errmsg: accountNotice(parsed.errno, '账号收听暂不可用，可手动选择匿名试听。') });
    const data = parsed.data;
    const uid = Number(data?.uid);
    const rtc = data?.rtc_token;
    const privileges = tokenPrivileges(rtc);
    // TLS official provenance + strict observed audience token schema. Never relay RTM/chat credentials.
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffffffff ||
        typeof rtc !== 'string' || rtc.slice(3, 35) !== APP_ID || !privileges.known ||
        privileges.declaresJoin !== true || privileges.declaresPublishAudio !== false) {
      return json(res, 502, { errno: -1, errmsg: '官方账号凭证不符合已验证的只收听格式；未连接，请用匿名试听。' });
    }
    return json(res, 200, { errno: 0, data: { rtc_token: rtc, user_id: uid, mode: 'account-audience', publishing_available: false } });
  }

  async function anonymousToken(req, res, u) {
    const channel_id = u.searchParams.get('channel_id'), anchor_id = u.searchParams.get('anchor_id');
    if (!validId(channel_id) || !validId(anchor_id)) throw new InputError('需要有效的房间/主播 ID。');
    const q = new URLSearchParams({ channel_id, anchor_id, ddd: '3' });
    const upstream = await request({ hostname: API_HOST, path: `${TOKEN_PATH}?${q}` });
    if (upstream.status !== 200) return json(res, 502, { errno: -1, errmsg: 'GRAVITY 凭证接口暂不可用。' });
    const j = JSON.parse(upstream.body.toString('utf8'));
    if (j.errno !== 0 || typeof j.data?.rtc_token !== 'string' || !j.data.rtc_token) {
      return json(res, 502, { errno: -1, errmsg: `没有取得匿名入房凭证（errno: ${Number.isSafeInteger(j.errno) ? j.errno : 'unknown'}）。` });
    }
    // Pass only the native anonymous join fields. Never store/log this token.
    return json(res, 200, { errno: 0, data: { rtc_token: j.data.rtc_token, user_id: j.data.user_id } });
  }

  // Read-only GET/HEAD endpoints.
  const readRoutes = new Map([
    ['/api/health', (req, res) => json(res, 200, { status: 'ok', mode: 'anonymous-audition' })],
    ['/api/status', (req, res) => json(res, 200, { errno: 0, data: status() })],
    ['/api/account/status', (req, res) => json(res, 200, { errno: 0, data: account() })],
    ['/api/relation/status', (req, res) => json(res, 200, { errno: 0, data: relation.status() })],
    ['/api/friends/rooms', friendRooms],
    ['/api/search', search],
    ['/api/labels', labels],
    ['/api/search/recommendations', (req, res) => json(res, 200, { errno: 0, data: { keywords: SEARCH_SHORTCUTS } })],
    ['/api/rooms', rooms],
    ['/api/resolve', resolve],
    ['/api/agora-token', agoraToken],
    ['/api/token', anonymousToken],
  ]);

  return async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname.startsWith('/api/feed/')) return await feedApi(req, res, u);
      if (u.pathname.startsWith('/api/im/')) return await imApi(req, res, u);
      if (u.pathname.startsWith('/api/profile/')) return await profileApi(req, res, u);
      if (req.method === 'POST' && u.pathname === '/api/translate') return await translateApi(req, res);
      if (u.pathname.startsWith('/api/tasks/')) return await tasksApi(req, res, u);
      if (u.pathname.startsWith('/api/member/')) return await memberApi(req, res, u);
      if (u.pathname.startsWith('/api/owner/')) return await ownerApi(req, res, u);
      if (req.method === 'POST' && u.pathname === '/api/rooms/create') {
        if (crossSite(req)) throw new OwnerError('请从本站页面访问。', 403);
        const body = await guardedJson(req, {action: 'room-control', maxChars: 2048,
          fail: (message, status) => status ? new OwnerError(message, status) : new InputError(message),
          denied: '开房只能由本站页面明确确认。', tooLong: '开房内容过长。', invalid: '开房内容无效。'});
        return json(res, 200, {errno: 0, data: await member.createRoom(body, request)});
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Allow', 'GET, HEAD');
        return json(res, 405, { errno: -3, errmsg: '此服务只提供读取，不接受登录或外发提交。' });
      }
      if (crossSite(req) && u.pathname.startsWith('/api/')) {
        return json(res, 403, { errno: -3, errmsg: '请从本站页面访问。' });
      }
      const route = readRoutes.get(u.pathname);
      if (route) return await route(req, res, u);
      return await serveStatic(req, res, u.pathname);
    } catch (error) {
      const known = error instanceof InputError || error instanceof OwnerError || error instanceof FeedError || error instanceof ImError || error instanceof ProfileError || error instanceof TranslateError || error instanceof TasksError;
      // No upstream body, token, request URL or exception text in logs/results.
      json(res, error instanceof OwnerError || error instanceof FeedError || error instanceof ImError || error instanceof ProfileError || error instanceof TranslateError || error instanceof TasksError ? error.status : error instanceof InputError ? 400 : 502, {
        errno: -1, errmsg: known ? error.message : '请求失败，请稍后手动重试。',
      });
    }
  };
}

/** Best-effort: remute / quit presence / leave seats this process obtained, so a restart doesn't strand them. */
async function drainAccount({ owner, member, im }, request = httpsRequest) {
  const results = await Promise.allSettled([owner.drain?.(request), member.drain?.(request), im?.drain?.()]);
  return results.every(result => result.status === 'fulfilled');
}

function start() {
  const host = process.env.GRAVITY_SERVE_HOST || '0.0.0.0';
  const port = Number(process.env.GRAVITY_SERVE_PORT || 8787);
  const tlsPort = Number(process.env.GRAVITY_TLS_PORT || 8788);
  const cert = process.env.GRAVITY_TLS_CERT || '/tls/cert.pem';
  const key = process.env.GRAVITY_TLS_KEY || '/tls/key.pem';
  if (!fs.existsSync(cert) || !fs.existsSync(key)) throw new Error('Application TLS certificate/key missing');
  const owner = createOwnerService(), relation = createRelationService();
  const im = createImService({ onBlocked: id => relation.noteBlocked(id) });
  const member = createMemberService({ onPeople: rows => relation.observe(rows), blocked: () => relation.blockedIds(), listedFollowRooms: trySignedFollowRooms });
  const profile = createProfileService({ onPeople: rows => relation.observe(rows), onBlocked: id => relation.noteBlocked(id) });
  const tasks = createTasksService({log: message => console.log('[tasks]', String(message).slice(0, 200))});
  const feed = createFeedService({ ledger: tasks.likeLedger });
  const rewards = createRewardsService({roomContext: () => member.rewardContext(), auto: () => tasks.status().auto,
    log: message => console.log('[rewards]', message)});
  const handler = makeHandler({ owner, member, im, relation, profile, tasks, rewards, feed });
  const servers = [
    http.createServer(handler),
    https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, handler),
  ];
  servers[0].listen(port, host, () => console.log(`GRAVITY HTTP ready on ${port}`));
  servers[1].listen(tlsPort, host, () => console.log(`GRAVITY HTTPS ready on ${tlsPort}; anonymous audition, not verified mic-seat access`));
  relation.start();
  tasks.start();
  rewards.start();

  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`${signal}: stopping; releasing account state`);
    relation.stop();
    tasks.stop();
    rewards.stop();
    for (const server of servers) { server.close(); server.closeIdleConnections?.(); }
    const timeout = new Promise(resolve => setTimeout(() => resolve(false), DRAIN_MS));
    const clean = await Promise.race([drainAccount({ owner, member, im }), timeout]);
    if (!clean) console.log('account cleanup not confirmed before exit');
    process.exit(0);
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void shutdown(signal); });
}

module.exports = { validId, parseRoomFromUrl, extractShortCode, resolveShareInput, publicRooms, publicFollowRooms, officialCdnImage, publicIPv4, officialLookup, httpsRequest, makeHandler, publicStatus, drainAccount };
if (require.main === module) start();

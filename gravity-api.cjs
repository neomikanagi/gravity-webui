'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {loadSessionToken, loadIosDevice, buildIosBaseParams, finalizeIosSign} = require('./gravity-sign-ios.cjs');

// Independently verified, read-only App endpoints. No arbitrary URLs, login or native harness on the hot path.
const {encryptRequest,decryptResponse}=require('./gravity-encrypt.cjs');
const {sniffImage}=require('./gravity-util.cjs');
// Native D7.w (UploadImageRequest): multipart POST gravity/common/newUploadV2 with
// source=voiceroom (public chat) or source=private (1:1 private images, F7/x case 2).
function multipartForm(fields, file) {
  const boundary = '----GravityUpload' + crypto.randomBytes(12).toString('hex');
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    if (!/^[A-Za-z0-9_]+$/.test(name) || typeof value !== 'string' || value.length > 4096) throw new TypeError('unsupported_private_image');
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  chunks.push(file.buffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks)};
}
const VOICE_READS = new Map([
  ['feedRecommended', '/gravity/feed/recommendFeedListV2'],
  ['feedLatest', '/gravity/feed/newFeedListV2'],
  ['feedFollowing', '/gravity/feed/palFeedListV3'],
  ['feedDetail', '/gravity/feed/getFeedById'],
  ['feedComments', '/gravity/feed/listCommentV3'],
  ['search', '/gravity/voice/search'],
  ['labels', '/gravity/voice/listLabels'],
  ['ranked', '/gravity/voice/listRoomForRank'],
  ['labelRooms', '/gravity/voice/listRoomForLabel'],
  ['recommendations', '/gravity/voice/searchRecommend'],
  ['followRooms', '/gravity/voice/listRoomForFollow'],
  ['following', '/gravity/relation/followerList'],
  ['friends', '/gravity/relation/friendsList'],
  // Native FetchFansListRequest / blackList / FriendListRequest (target_user_ids, comma-joined): read-only relation views.
  ['fans', '/gravity/relation/fansList'],
  ['blacklist', '/gravity/relation/blackList'],
  ['shieldList', '/gravity/relation/shieldList'],
  ['userList', '/gravity/user/userListInfo'],
  ['userDetail', '/gravity/user/detail'],
  ['personalFeed', '/gravity/feed/personalFeedList'],
  ['feedCollected', '/gravity/feed/collectListV2'],
  // Native IM credentials (App `p9.e` fetches the same pair at start-up); never exposed to browsers.
  ['imToken', '/gravity/implus/gettoken'],
  ['audienceToken', '/gravity/voice/getAgoraToken'],
  ['ownerToken', '/gravity/voice/getAgoraToken'],
  ['roomInfo', '/gravity/voice/getRoomInfo'],
  ['seats', '/gravity/voice/anchorUserList'],
  ['managers', '/gravity/voice/voiceManagerList'],
  ['memberToken', '/gravity/voice/getAgoraToken'],
  ['members', '/gravity/voice/roomMemberList'],
  ['memberCount', '/gravity/voice/roomMemberNumber'],
  // Daily silver / sign-in missions and the couple lottery (jadx-verified shapes).
  ['pointMissions', '/gravity/point/pointMissionListV2'],
  ['signMissions', '/gravity/point/signMissionList'],
  ['lotteryList', '/gravity/limitRelation/lotteryList'],
  ['lotteryCards', '/gravity/limitRelation/lotteryCardList'],
  ['lotteryInfo', '/gravity/user/lotteryInfo'],
  ['adPopup', '/gravity/point/adNotification'],
  // Official voice-task H5 (index-m1clKz69.js): discovery, personal/event tasks, stay sign and tiered room boxes.
  ['rewardTabs', '/gravity/h5/voiceTask/taskTab'],
  ['rewardTasks', '/gravity/h5/voiceTask/taskList'],
  ['rewardSign', '/gravity/h5/voiceTask/signMissionList'],
  ['rewardRoom', '/gravity/h5/taskPageForH5'],
  // Anyone's relation/gift/room reads (jadx-verified: target_id optional,
  // gift list_type is receive|send, preview needs only channel_id).
  ['giftRecords', '/gravity/voice/giftRecordList'],
  ['roomPreview', '/gravity/voice/getRoomPreviewInfo'],
  // Footprint tabs (verified live): 0 = people who visited me, 1 = people I visited.
  ['footprints', '/gravity/inbox/listFootprint'],
]);
const VOICE_WRITES = new Map([
  // Native BlockUserRequest is a mutating GET, not a POST. Never add it to VOICE_READS.
  ['blockUser', '/gravity/relation/black'],
  // Native FollowUserRequest: HiclubBasePostEncryptRequest, action=follow|unfollow, user_id_b.
  ['followUser', '/gravity/relation/followEncrypt'],
  // Native MuteRequest ("静音" of a person): mutating GET, action=shield|unshield. Only shield is ever sent.
  ['shieldUser', '/gravity/relation/shield'],
  ['luckyBox', '/gravity/voice/receiveLuckyBox'],
  ['feedComment', '/gravity/feed/addCommentEncrypt'],
  ['feedReply', '/gravity/feed/addCommentReplyEncrypt'],
  ['feedVote', '/gravity/feed/voteEncrypt'],
  ['feedCollect', '/gravity/feed/collect'],
  ['ownerMute', '/gravity/voice/updateAnchorStatus'],
  ['memberMute', '/gravity/voice/updateAnchorStatus'],
  ['applySeat', '/gravity/voice/applyForSeat'],
  ['leaveSeat', '/gravity/voice/leaveForSeat'],
  ['memberPresence', '/gravity/lcs/cover'],
  ['createRoom', '/gravity/voice/createRoomV2'],
  // Host-only field updates: native qa/d2 auto_pass, qa/g2 notice. Tags also work here (live-verified replace).
  ['updateRoom', '/gravity/voice/updateRoom'],
  // Private 1:1 image upload only (source=private). The public-chat variant
  // (source=voiceroom) stays disabled: this web UI does not send room images.
  ['privateImage', '/gravity/common/newUploadV2'],
  // Encrypted task/lottery writes (HttpEncryptRequest family, same as feed/follow writes).
  ['pointAward', '/gravity/point/pointAwardReceiveV2Encrypt'],
  ['signAward', '/gravity/point/signAwardReceiveEncrypt'],
  ['lotteryDraw', '/gravity/limitRelation/lottery'],
  ['adComplete', '/gravity/point/finishedADEncryptV2'],
  ['taskReward', '/gravity/h5/voiceTask/drawEncrypt'],
  ['weeklySignReward', '/gravity/h5/voiceTask/signAwardReceiveEncrypt'],
  ['roomTaskReward', '/gravity/h5/getAwardForH5'],
  // Group-call rooms (room_type 2) have their own enter call; a room's host can end it. Both take only channel_id.
  ['enterGroup', '/gravity/voice/enterGroupRoom'],
  ['destroyRoom', '/gravity/voice/destroyRoom'],
]);
// Native mutating GETs carry an explicit marker so the upstream guard can tell them from reads.
const GET_WRITES = new Map([['blockUser', 'block-user'], ['luckyBox', 'receive-lucky-box'], ['feedCollect', 'feed-collect'], ['shieldUser', 'shield-user']]);
const ENCRYPTED_WRITES = new Set(['feedComment', 'feedReply', 'feedVote', 'followUser', 'pointAward', 'signAward', 'lotteryDraw', 'adComplete', 'taskReward', 'weeklySignReward']);
const EXPIRED = new Set([40025, 40026]);
function sessionIdentity(token) {
  // A revoked token stays revoked even when device metadata changes. Never store the token itself here.
  return crypto.createHash('sha256').update(token).digest('hex');
}
function createVoiceApi({
  tokenLoader = loadSessionToken,
  deviceLoader = loadIosDevice,
  stateFile = process.env.GRAVITY_ACCOUNT_STATE_FILE || path.join(__dirname, '.session/account-state.json'),
} = {}) {
  let rejectedSession = null;
  let verifiedSession = null;
  let statePersisted = false;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (/^[a-f0-9]{64}$/.test(state.identity) && EXPIRED.has(state.errno)) {
      rejectedSession = {identity:state.identity, errno:state.errno};
      statePersisted = true;
    }
  } catch {}
  function recordSessionRejection(errno, token = tokenLoader()) {
    if (!EXPIRED.has(errno) || !token) throw new TypeError('invalid_session_rejection');
    rejectedSession = {identity:sessionIdentity(token), errno};
    verifiedSession = null;
    statePersisted = false;
    const temp = stateFile + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.mkdirSync(path.dirname(stateFile), {recursive:true, mode:0o700});
      fs.writeFileSync(temp, JSON.stringify(rejectedSession) + '\n', {mode:0o600, flag:'wx'});
      fs.renameSync(temp, stateFile);
      statePersisted = true;
    } catch {
      try { fs.unlinkSync(temp); } catch {}
      // Still block in memory if the state volume is unavailable; never log filesystem errors/credentials.
    }
    return statePersisted;
  }
  function accountStatus() {
    const token = tokenLoader();
    const device = deviceLoader();
    if (!token) return {state:'missing_session', configured:false, requires_app_login:true};
    const identity = sessionIdentity(token);
    if (rejectedSession?.identity === identity) return {state:'rejected_session', configured:true, requires_app_login:true, errno:rejectedSession.errno, rejection_persisted:statePersisted};
    if (!device?.idfa || !device?.uwd) return {state:'device_missing', configured:false, requires_app_login:false};
    const verified = verifiedSession === JSON.stringify([identity, device]);
    return {state:verified ? 'verified' : 'ready_unverified', configured:true, requires_app_login:false};
  }
  function signedQuery(extra, options = {}) {
    const token = options.token !== undefined ? options.token : tokenLoader();
    if (!token) return {error:'session_missing'};
    const identity = sessionIdentity(token);
    if (rejectedSession?.identity === identity) return {error:'session_expired', errno:rejectedSession.errno};
    const device = options.device !== undefined ? options.device : deviceLoader();
    if (!device?.idfa || !device?.uwd) return {error:'device_missing'};
    const base = buildIosBaseParams({token, device});
    return {params:finalizeIosSign({...base, ...extra}, options.ts), mode:'ios', identity, verificationIdentity:JSON.stringify([identity, device])};
  }
  let requestQueue = Promise.resolve();
  let pending = 0;
  async function signedVoice(kind, extra, request, options = {}, write = false) {
    const endpoints = write ? VOICE_WRITES : VOICE_READS;
    if (!endpoints.has(kind)) throw new TypeError('unsupported_voice_read');
    if (pending >= 32) return {errno:-1, errmsg:'account_request_busy'};
    ++pending;
    const previous = requestQueue;
    let release;
    requestQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      // A queued room reward must still belong to the live, entered member lease when it reaches the wire.
      if (typeof options.authorize === 'function' && !options.authorize()) return {errno:-5, errmsg:'account_authority_changed'};
      const signed = signedQuery(extra, options);
      if (signed.error === 'session_missing') return {errno:-3, errmsg:'account_session_missing'};
      if (signed.error === 'session_expired') return {errno:signed.errno, errmsg:'account_session_expired'};
      if (signed.error) return {errno:-4, errmsg:'ios_device_missing'};
      if (options.expectedIdentity !== undefined && signed.identity !== options.expectedIdentity) return {errno:-5, errmsg:'account_identity_changed'};
      const form = new URLSearchParams(signed.params).toString();
      const encrypted=write&&ENCRYPTED_WRITES.has(kind)?encryptRequest(signed.params):null;
      const marker=write?GET_WRITES.get(kind):undefined;
      // Block/unblock share one GET path; the marker says which direction this call is allowed to take.
      const getWrite=marker?{mutation:kind==='blockUser'&&extra.action==='unblock'?'unblock-user':marker}:null;
      let upstream;
      if (write && kind === 'privateImage') {
        if (extra?.source !== 'private' || Object.keys(extra).some(key => key !== 'source')) throw new TypeError('unsupported_private_image');
        const file = options.uploadFile;
        if (!file || !Buffer.isBuffer(file.buffer) || !/^[A-Za-z0-9._-]+$/.test(file.name || '') ||
            !['image/jpeg', 'image/png', 'image/gif'].includes(file.type)) throw new TypeError('unsupported_private_image');
        const part = multipartForm(signed.params, file);
        upstream = await request({hostname:'api.gravity.place', path:endpoints.get(kind), method:'POST', body:part.body,
          contentType:part.contentType, mutation:'private-image-upload'});
      } else {
        upstream = await request(getWrite
          ? {hostname:'api.gravity.place', path:endpoints.get(kind)+'?'+form, method:'GET', ...getWrite}
          : write ? {hostname:'api.gravity.place', path:endpoints.get(kind), method:'POST', body:encrypted?.body||form,
            ...(encrypted?{contentType:'application/raw; charset=utf-8'}:{})}
          : {hostname:'api.gravity.place', path:endpoints.get(kind)+'?'+form});
      }
      if (upstream.status !== 200) return {errno:-1, errmsg:'upstream_unavailable'};
      let parsed;
      try { parsed = JSON.parse(encrypted?decryptResponse(upstream.body,encrypted.responseKey):upstream.body.toString('utf8')); }
      catch { return {errno:-1, errmsg:'upstream_invalid'}; }
      if (!Number.isSafeInteger(parsed?.errno)) return {errno:-1, errmsg:'upstream_invalid'};
      if (EXPIRED.has(parsed.errno)) {
        // Persist only a fingerprint. Explicit synthetic/test credentials never modify production state.
        if (options.token === undefined) recordSessionRejection(parsed.errno, signed.params.token);
        else rejectedSession = {identity:signed.identity, errno:parsed.errno};
      }
      if (parsed.errno === 0) verifiedSession = signed.verificationIdentity;
      return parsed.errno === 0 ? {errno:0, data:parsed.data} : {errno:parsed.errno, errmsg:'official_request_rejected'};
    } finally { --pending; release(); }
  }
  const readSignedVoice = (kind, extra, request, options = {}) => signedVoice(kind, extra, request, options);
  // Internal owner service only: never expose arbitrary methods, endpoint names or role fields to browsers.
  const writeOwnerMute = (extra, request) => signedVoice('ownerMute', extra, request, {}, true);
  const writeMemberVoice = (kind, extra, request, options = {}) => {
    if (!['memberMute','applySeat','leaveSeat','memberPresence'].includes(kind)) throw new TypeError('unsupported_member_action');
    return signedVoice(kind, extra, request, options, true);
  };
  const writeFeed = (kind, extra, request, options = {}) => {
    if (kind==='feedVote') {
      if (extra?.vote!=='0'&&extra?.vote!=='1' || extra?.type!=='f' || typeof extra?.id!=='string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(extra.id) ||
          !/^[1-9][0-9]{0,19}$/.test(extra?.to_user_id||'') || !/^feed[0-9]{1,2}$/.test(extra?.feed_type||'') ||
          typeof extra?.route_path!=='string' || extra.route_path.length>80 || !/^[A-Za-z0-9]*$/.test(extra.route_path) ||
          Object.keys(extra).some(key=>!['id','vote','to_user_id','type','feed_type','route_path'].includes(key))) throw new TypeError('unsupported_feed_action');
    } else if (kind==='feedCollect') {
      if (!['collect','cancel'].includes(extra?.action)||typeof extra?.id!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(extra.id)||
          Object.keys(extra).some(key=>!['id','action'].includes(key))) throw new TypeError('unsupported_feed_action');
    } else if (!['feedComment','feedReply'].includes(kind)) throw new TypeError('unsupported_feed_action');
    return signedVoice(kind, extra, request, options, true);
  };
  const writeProfileBlock = (extra, request, options = {}) => {
    if (!['block', 'unblock'].includes(extra?.action) || !/^[1-9][0-9]{0,19}$/.test(extra?.target_user_id || '') ||
        Object.keys(extra).some(key => !['action', 'target_user_id'].includes(key))) throw new TypeError('unsupported_profile_action');
    return signedVoice('blockUser', extra, request, options, true);
  };
  const writeFollow = (extra, request, options = {}) => {
    if (!['follow', 'unfollow'].includes(extra?.action) || !/^[1-9][0-9]{0,19}$/.test(extra?.user_id_b || '') ||
        Object.keys(extra).some(key => !['action', 'user_id_b'].includes(key))) throw new TypeError('unsupported_follow_action');
    return signedVoice('followUser', extra, request, options, true);
  };
  const writeShield = (extra, request, options = {}) => {
    if (extra?.action !== 'shield' || !/^[1-9][0-9]{0,19}$/.test(extra?.target_user_id || '') ||
        Object.keys(extra).some(key => !['action', 'target_user_id'].includes(key))) throw new TypeError('unsupported_shield_action');
    return signedVoice('shieldUser', extra, request, options, true);
  };
  const channelOnly = kind => (extra, request, options = {}) => {
    if (!/^[1-9][0-9]{0,19}$/.test(extra?.channel_id || '') || Object.keys(extra).some(key => key !== 'channel_id')) throw new TypeError('unsupported_room_action');
    return signedVoice(kind, extra, request, options, true);
  };
  const writeGroupEnter = channelOnly('enterGroup'), writeDestroyRoom = channelOnly('destroyRoom');
  const writePointAward = (extra, request, options = {}) => {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra) ||
        !/^[1-9][0-9]{0,9}$/.test(extra.id || '') || ![0, 1, 2].includes(extra.award_type) ||
        Object.keys(extra).some(key => !['id', 'award_type'].includes(key))) throw new TypeError('unsupported_task_award');
    return signedVoice('pointAward', {id: String(extra.id), award_type: String(extra.award_type)}, request, options, true);
  };
  const writeSignAward = (extra, request, options = {}) => {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra) || extra.award_type !== 0 ||
        Object.keys(extra).some(key => key !== 'award_type')) throw new TypeError('unsupported_sign_award');
    return signedVoice('signAward', {award_type: '0'}, request, options, true);
  };
  const writeLotteryDraw = (extra, request, options = {}) => {
    // One couple-lottery draw. No id: the official call only carries source=cp.
    if (!extra || typeof extra !== 'object' || Array.isArray(extra) || Object.keys(extra).length !== 0) throw new TypeError('unsupported_lottery_draw');
    return signedVoice('lotteryDraw', {source: 'cp'}, request, options, true);
  };
  const writeAdComplete = (extra, request, options = {}) => {
    // Official rewarded-ad completion (AdTaskViewModel.reportAdTaskComplete). Only the two
    // verified scenes: ad_point (daily silver ads) and ad_draw (free gacha after an ad).
    if (!extra || typeof extra !== 'object' || Array.isArray(extra) || !['ad_point', 'ad_draw'].includes(extra.scene) ||
        Object.keys(extra).some(key => key !== 'scene')) throw new TypeError('unsupported_ad_complete');
    return signedVoice('adComplete', {scene: extra.scene}, request, options, true);
  };
  const rewardId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
  const rewardFields = (extra, keys) => extra && typeof extra === 'object' && !Array.isArray(extra) &&
    Object.keys(extra).length === keys.length && keys.every(k => Object.hasOwn(extra, k));
  const readReward = (kind, extra, request, options = {}) => {
    const keys = {rewardTabs:[], rewardSign:[], rewardTasks:['tab_id'], rewardRoom:['anchor_id','channel_id']}[kind];
    if (!keys || !rewardFields(extra, keys) || !keys.every(k => rewardId(extra[k]))) throw new TypeError('unsupported_reward_read');
    return signedVoice(kind, extra, request, options);
  };
  const writeReward = (kind, extra, request, options = {}) => {
    const keys = {taskReward:['task_id'], weeklySignReward:[], roomTaskReward:['anchor_id','channel_id','task_level']}[kind];
    if (!keys || !rewardFields(extra, keys) || !keys.every(k => rewardId(extra[k])) ||
        (kind === 'roomTaskReward' && Number(extra.task_level) > 100)) throw new TypeError('unsupported_reward_write');
    return signedVoice(kind, extra, request, options, true);
  };
  const readTaskList = (kind, extra, request, options = {}) => {
    if (kind === 'pointMissions') {
      if (!/^[1-9][0-9]{0,19}$/.test(extra?.user_id || '')) throw new TypeError('unsupported_task_list');
      return signedVoice(kind, {user_id: String(extra.user_id)}, request, options);
    }
    if (kind === 'signMissions') {
      if (extra && Object.keys(extra).length !== 0) throw new TypeError('unsupported_task_list');
      return signedVoice(kind, {}, request, options);
    }
    if (kind === 'lotteryList' || kind === 'lotteryCards') {
      const keys = Object.keys(extra || {});
      if (keys.some(key => !['last_id', 'source'].includes(key))) throw new TypeError('unsupported_lottery_list');
      if (extra?.last_id !== undefined && !/^[A-Za-z0-9_.:-]{1,200}$/.test(extra.last_id)) throw new TypeError('unsupported_lottery_list');
      if (extra?.source !== undefined && extra.source !== 'cp') throw new TypeError('unsupported_lottery_list');
      return signedVoice(kind, {source: 'cp', ...(extra?.last_id ? {last_id: extra.last_id} : {})}, request, options);
    }
    if (kind === 'lotteryInfo' || kind === 'adPopup') {
      if (extra && Object.keys(extra).length !== 0) throw new TypeError('unsupported_task_list');
      return signedVoice(kind, {}, request, options);
    }
    throw new TypeError('unsupported_task_list');
  };
  // Anyone's follower/following pages: same endpoint the App's profile tabs use.
  // target_id omitted means self. Only these two lists, nothing else.
  const readRelationList = (kind, extra, request, options = {}) => {
    if (!['following', 'fans'].includes(kind)) throw new TypeError('unsupported_relation_list');
    const keys = Object.keys(extra || {});
    if (keys.some(key => !['target_id', 'last_id'].includes(key))) throw new TypeError('unsupported_relation_list');
    if (extra?.target_id !== undefined && !/^[1-9][0-9]{0,19}$/.test(extra.target_id)) throw new TypeError('unsupported_relation_list');
    if (extra?.last_id !== undefined && !/^[A-Za-z0-9_.:-]{1,200}$/.test(extra.last_id)) throw new TypeError('unsupported_relation_list');
    return signedVoice(kind, {...(extra?.target_id ? {target_id: extra.target_id} : {}), ...(extra?.last_id ? {last_id: extra.last_id} : {})}, request, options);
  };
  // Anyone's gift wall: list_type is receive|send (native C4022i/C4024k), target omitted means self.
  const readGiftRecords = (extra, request, options = {}) => {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra) ||
        !['receive', 'send'].includes(extra.list_type) ||
        (extra.target_id !== undefined && !/^[1-9][0-9]{0,19}$/.test(extra.target_id)) ||
        Object.keys(extra).some(key => !['list_type', 'target_id'].includes(key))) throw new TypeError('unsupported_gift_records');
    return signedVoice('giftRecords', {list_type: extra.list_type, ...(extra.target_id ? {target_id: extra.target_id} : {})}, request, options);
  };
  // Footprint tabs: 0 visitors-of-me, 1 my-visits (verified live; 2 mirrors 0).
  // last_id is an opaque pipe-joined cursor (uid|uid|timestamp).
  const readFootprints = (extra, request, options = {}) => {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra) ||
        ![0, 1, 2].includes(extra.tab_type) ||
        (extra.last_id !== undefined && !/^[0-9|]{0,64}$/.test(extra.last_id)) ||
        Object.keys(extra).some(key => !['tab_type', 'last_id'].includes(key))) throw new TypeError('unsupported_footprints');
    return signedVoice('footprints', {tab_type: String(extra.tab_type), ...(extra.last_id ? {last_id: extra.last_id} : {})}, request, options);
  };
  const readRoomPreview = (extra, request, options = {}) => {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra) ||
        !/^[1-9][0-9]{0,19}$/.test(extra.channel_id || '') ||
        Object.keys(extra).some(key => key !== 'channel_id')) throw new TypeError('unsupported_room_preview');
    return signedVoice('roomPreview', {channel_id: String(extra.channel_id)}, request, options);
  };
  const writeLuckyBox = (extra, request, options = {}) => {
    const keys=['anchor_id','lucky_box_id','issue_user_id'];
    if (!keys.every(key=>/^[1-9][0-9]{0,19}$/.test(extra?.[key] || '')) ||
        Object.keys(extra||{}).some(key => !keys.includes(key))) throw new TypeError('unsupported_lucky_box');
    return signedVoice('luckyBox', extra, request, options, true);
  };
  const writeCreateRoom = (extra, request, options = {}) => {
    const allowed=['star_id','name','label_id','is_3D','tags','bg_id','game_id','room_permission','room_type','auto_pass','sync_feed','max_call_number'];
    if (!extra||typeof extra!=='object'||Array.isArray(extra)||Object.keys(extra).some(key=>!allowed.includes(key))) throw new TypeError('unsupported_create_room');
    if (typeof extra.name!=='string'||!extra.name.trim()||extra.name.length>40||!/^[1-9][0-9]{0,8}$/.test(extra.label_id||'')) throw new TypeError('unsupported_create_room');
    return signedVoice('createRoom', extra, request, options, true);
  };
  const writeUpdateRoom = (extra, request, options = {}) => {
    if (!extra||typeof extra!=='object'||Array.isArray(extra)||!/^[1-9][0-9]{0,19}$/.test(extra.channel_id||'')||
        Object.keys(extra).some(key=>!['channel_id','notice','auto_pass','tags'].includes(key))) throw new TypeError('unsupported_update_room');
    if (extra.notice!==undefined&&(typeof extra.notice!=='string'||extra.notice.length>200)) throw new TypeError('unsupported_update_room');
    if (extra.auto_pass!==undefined&&extra.auto_pass!=='0'&&extra.auto_pass!=='1') throw new TypeError('unsupported_update_room');
    if (extra.tags!==undefined&&(typeof extra.tags!=='string'||extra.tags.length>120)) throw new TypeError('unsupported_update_room');
    if (extra.notice===undefined&&extra.auto_pass===undefined&&extra.tags===undefined) throw new TypeError('unsupported_update_room');
    return signedVoice('updateRoom', extra, request, options, true);
  };
  // 1:1 private image upload (F7/x case 2: D7.w source=private). Sniffed jpg/png/gif only.
  const writePrivateImage = (buffer, request, options = {}) => {
    const kind = sniffImage(buffer);
    if (!kind) throw new TypeError('unsupported_private_image');
    return signedVoice('privateImage', {source:'private'}, request, {...options, uploadFile:{name:'image.'+kind.ext, type:kind.type, buffer}}, true);
  };
  function trySignedSearch(extra, request, options = {}) {
    if (typeof extra?.keyword !== 'string' || !extra.keyword.trim()) return Promise.resolve({errno:-1, errmsg:'keyword_required'});
    return readSignedVoice('search', {keyword:extra.keyword}, request, options);
  }
  function trySignedRooms(extra, request, options = {}) {
    const label = String(extra?.label_id || '');
    if (label) {
      if (!/^[1-9][0-9]{0,8}$/.test(label)) return Promise.resolve({errno:-1, errmsg:'label_invalid'});
      // Only the captured first page is known for categories; do not invent pagination fields.
      return readSignedVoice('labelRooms', {label_id:label, log_id:'1', session_id:crypto.randomUUID().toUpperCase()}, request, options);
    }
    const cursor = String(extra?.cursor || '');
    if (cursor && !/^[1-9][0-9]{0,19}$/.test(cursor)) return Promise.resolve({errno:-1, errmsg:'cursor_invalid'});
    return readSignedVoice('ranked', {list_type:'1', channel_id:cursor}, request, options);
  }
  function tryAccountAudienceToken(extra, request, options = {}) {
    const channel_id = String(extra?.channel_id || '');
    if (!/^[1-9][0-9]{0,19}$/.test(channel_id)) return Promise.resolve({errno:-1, errmsg:'channel_invalid'});
    // App requestToken(0) joins with SDK audience=2 and publishMicrophoneTrack=false.
    // Protocol role_type is not the SDK role enum; the browser cannot select or escalate it.
    return readSignedVoice('audienceToken', {channel_id, role_type:'0'}, request, options);
  }
  const trySignedFollowRooms = (request, options = {}) => readSignedVoice('followRooms', {}, request, options);
  const trySignedFollowing = (cursor, request, options = {}) => {
    if (cursor && !/^[1-9][0-9]{0,19}$/.test(cursor)) return Promise.resolve({errno:-1, errmsg:'cursor_invalid'});
    return readSignedVoice('following', cursor ? {last_id:cursor} : {}, request, options);
  };
  const trySignedLabels = (request, options = {}) => readSignedVoice('labels', {ab_group:'0', is_3D:'0', scene:'explore'}, request, options);
  const trySignedRecommendations = (request, options = {}) => readSignedVoice('recommendations', {}, request, options);
  return {accountStatus, signedQuery, readSignedVoice, trySignedSearch, trySignedIosSearch:trySignedSearch,
    trySignedRooms, trySignedLabels, trySignedRecommendations, trySignedFollowRooms, trySignedFollowing, tryAccountAudienceToken, writeOwnerMute, writeMemberVoice, writeFeed, writeProfileBlock, writeFollow, writeShield, writeGroupEnter, writeDestroyRoom, writeLuckyBox, writeCreateRoom, writeUpdateRoom, writePrivateImage, writePointAward, writeSignAward, writeLotteryDraw, writeAdComplete, readReward, writeReward, readTaskList, readRelationList, readGiftRecords, readRoomPreview, readFootprints, recordSessionRejection};
}
async function hotRoomKeywordSearch(extra, request, publicRooms) {
  const keyword = String(extra.keyword || '').trim().toLowerCase();
  const limit = Math.min(20, Math.max(1, Number(extra.limit) || 10));
  const upstream = await request({hostname:'api.gravity.place', path:'/gravity/voice/getHotRoomOrPlan?ddd=3'});
  if (upstream.status !== 200) return {errno:-1, errmsg:'fallback_unavailable'};
  let parsed;
  try { parsed = JSON.parse(upstream.body.toString('utf8')); }
  catch { return {errno:-1, errmsg:'fallback_unavailable'}; }
  if (parsed.errno !== 0 || !parsed.data) return {errno:-1, errmsg:'fallback_unavailable'};
  const rooms = publicRooms(parsed.data).filter(room =>
    [room.title,room.anchor_name,room.topic,...(room.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(keyword)
  ).slice(0,limit);
  return {errno:0, data:{rooms, keyword:extra.keyword, mode:'hot_filter'}};
}
module.exports = {...createVoiceApi(), createVoiceApi, sessionIdentity, hotRoomKeywordSearch};

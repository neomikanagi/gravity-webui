'use strict';
// Pure helpers for the App's chat message format (CustomMsgContent JSON inside an IMPlus text) and official-account rules.
const crypto = require('node:crypto');
const pb = require('./gravity-pb.cjs');

// RcCloudInfo.uidToRcId / rcIdToUid are the same byte swap (bytes 0 and 2 of the low 24 bits).
function rcId(uid) {
  const n = BigInt(uid);
  return String((n & 0xffffffffff000000n) + ((n & 0xffn) << 16n) + (n & 0xff00n) + ((n >> 16n) & 0xffn));
}

// p6.C3582b.a: user chats are "<smaller>:<larger>" by string comparison.
const chatId = (a, b) => (String(a) > String(b) ? `${b}:${a}` : `${a}:${b}`);
const peerOf = (conversationId, myId) => String(conversationId).split(':').find(part => part !== String(myId)) ?? String(myId);

// Server accounts that talk *to* users (official/system/activity push), not friends. Mirrors the App's SpecialImUsers/UserFromManager.
const OFFICIAL_IDS = new Set(['1000000000', '1000002002', '1000002003', '989907610', rcId('989907610'), rcId('1005374874')]);
function officialUser(id) {
  const n = String(id ?? '');
  if (!/^\d{1,19}$/.test(n)) return false;
  if (OFFICIAL_IDS.has(n)) return true;
  const v = BigInt(n);
  return v >= 1000001000n && v < 1000002000n;
}
// The App also carries the official assistant as an RC id (989907610) in some payloads.
const officialRcId = id => String(id ?? '') === '989907610';

// lc.f.s(): "<seconds with up to 3 decimals>_<MD5(userId) upper-case hex [8,24)>"
function messageId(userId, now = Date.now()) {
  const md5 = crypto.createHash('md5').update(String(userId)).digest('hex').toUpperCase();
  return `${Number((now / 1000).toFixed(3))}_${md5.slice(8, 24)}`;
}

// RcMsgUser as Gson writes it (@Keep, @SerializedName on the portrait_* fields).
function msgUser(me) {
  return {
    badgeUrl: '', chatType: 'USER', id: rcId(me.user_id), name: String(me.name ?? ''), portrait: String(me.portrait ?? ''),
    portrait_is_3d: String(me.portrait_is_3d ?? 0), portrait_bg_img: String(me.portrait_bg_img ?? ''),
    portrait_frame: String(me.portrait_frame ?? ''), transparent_portrait: String(me.transparent_portrait ?? ''),
  };
}

// CustomMsgContent.toString(): plain chat text is type 0 with hasGray "1" (lc.f.o).
function textContent({text, me, now = Date.now()}) {
  return JSON.stringify({
    content: text, type: 0, action: 0, format: 0, notification: true, mid: messageId(me.user_id, now), at_content: '', extInfo: '',
    hasGray: '1', source: 0, tid: '', showAi: false, isAi: false, platoMsgType: 0, ttsInfo: '', toName: '', lang: '', country: '',
    bubbleId: 0, toService: 0, unlockProgress: 0, topicId: '', topicFrom: 0, nickNameColor: '', categoryId: '0', groupStar: '',
    local: 0, animationInfo: '', aiAssistantInfo: '', scene: 0, user: msgUser(me),
  });
}

// Private image messages (lc/f.g, type 25): content is a short label, the payload
// is base64(JSON {url,width,height,mark?}) in detail, like the App sends it.
function imageContent({url, width, height, mark, me, now = Date.now()}) {
  const payload = {url, width, height};
  if (mark) payload.mark = mark;
  return JSON.stringify({
    content: '[\u56fe\u7247]', type: 25, action: 0, format: 0, notification: true, mid: messageId(me.user_id, now),
    at_content: '', extInfo: '', detail: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    hasGray: '1', source: 0, tid: '', showAi: false, isAi: false, platoMsgType: 0, ttsInfo: '', toName: '', lang: '', country: '',
    bubbleId: 0, toService: 0, unlockProgress: 0, topicId: '', topicFrom: 0, nickNameColor: '', categoryId: '0', groupStar: '',
    local: 0, animationInfo: '', aiAssistantInfo: '', scene: 0, user: msgUser(me),
  });
}

function imageUrl(json) {
  // Native image messages (lc/f.g, type 25) carry the payload as base64(detail)
  // = JSON {url,width,height,mark?}; older history may carry it in extInfo/extra.
  // Mirror lc/c.a: base64-looking detail decodes to JSON, otherwise use as-is.
  for (const blob of [json.extInfo, json.extra, json.detail]) {
    if (!blob) continue;
    if (typeof blob === 'string' && blob.startsWith('https://')) return blob;
    let extra = blob;
    if (typeof blob === 'string') {
      const decoded = decodeDetail(blob);
      try { extra = JSON.parse(decoded); } catch { continue; }
    }
    if (extra && typeof extra === 'object') {
      for (const key of ['url', 'imageUrl', 'image']) if (typeof extra[key] === 'string' && extra[key]) return extra[key];
    }
  }
  return typeof json.content === 'string' && json.content.startsWith('https://') ? json.content : '';
}

// lc/c.a: detail is base64(JSON) when it matches the base64 alphabet; otherwise plain JSON.
function decodeDetail(detail) {
  if (typeof detail !== 'string' || !detail) return '';
  if (!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/.test(detail)) return detail;
  try { return Buffer.from(detail, 'base64').toString('utf8'); }
  catch { return detail; }
}

// Friend-shared voice rooms (lc/f.r, type 44): detail decodes to
// MessageVoiceRoomV4 {channel_id,name,is_3D,label_info,room_type}.
function roomCard(json) {
  if (Number(json.type) !== 44) return null;
  let detail = json.detail;
  if (typeof detail !== 'string' || !detail) return null;
  try {
    const payload = JSON.parse(decodeDetail(detail));
    const channel_id = String(payload.channel_id ?? '');
    if (!/^[1-9][0-9]{0,19}$/.test(channel_id)) return null;
    return {
      channel_id,
      name: typeof payload.name === 'string' ? payload.name.slice(0, 200) : '',
      label_info: typeof payload.label_info === 'string' ? payload.label_info.slice(0, 40) : '',
      room_type: Number.isSafeInteger(payload.room_type) ? payload.room_type : 0,
    };
  } catch { return null; }
}

// Native ChatAid (type 98) and other AI-promo cards. Type 0/25/44 friend content stays visible even if the App tagged isAi.
function promotional(json) {
  if (!json || typeof json !== 'object') return false;
  const type = Number(json.type);
  if (type === 98) return true;
  if (type === 0 || type === 25 || type === 44) return false;
  if (json.isAi === true || json.showAi === true) return true;
  if (typeof json.aiAssistantInfo === 'string' && json.aiAssistantInfo.trim()) return true;
  if (Number(json.platoMsgType) > 0) return true;
  return false;
}

// Read the readable text out of an OneMsg (ObjOneMsg). Plain chat text is JSON {type:0,content}; other types are shown as a label.
function parseOneMsg(buffer) {
  const f = pb.decode(buffer);
  const content = pb.first(f, 6);
  let texts = [];
  if (Buffer.isBuffer(content)) texts = pb.all(pb.decode(content), 4).map(t => pb.str(pb.decode(t), 2));
  const raw = texts.join('');
  let body = {kind: 'text', text: raw}, meta = null;
  try {
    const json = JSON.parse(raw);
    if (json && typeof json === 'object' && 'type' in json) {
      meta = json;
      if (promotional(json)) body = {kind: 'ignore', text: '', type: Number(json.type)};
      else if (Number(json.type) === 0) body = {kind: 'text', text: String(json.content ?? '')};
      else if (Number(json.type) === 25) {
        body = {kind: 'image', text: String(json.content ?? '[图片]'), image: imageUrl(json), type: 25};
      } else if (Number(json.type) === 44) {
        const room = roomCard(json);
        body = room
          ? {kind: 'room', text: String(json.content ?? ''), room, type: 44}
          : {kind: 'other', text: String(json.content ?? ''), type: Number(json.type)};
      } else body = {kind: 'other', text: String(json.content ?? ''), type: Number(json.type)};
    }
  } catch {}
  return {
    from: pb.str(f, 2), to: pb.str(f, 4), seq: pb.id(f, 5), serverTime: pb.num(f, 8), sendTime: pb.num(f, 9),
    clientMsgId: pb.id(f, 13), template: pb.str(f, 12), chatType: pb.num(f, 1), ...body, userName: meta?.user?.name ?? '',
    userPortrait: typeof meta?.user?.portrait === 'string' ? meta.user.portrait : '',
    service: ['SERVICE', 'GROUP'].includes(meta?.user?.chatType) || meta?.user?.id &&
      /^\d{1,19}$/.test(String(meta.user.id)) && officialUser(rcId(meta.user.id)),

  };
}

module.exports = {rcId, chatId, peerOf, officialUser, officialRcId, messageId, msgUser, textContent, imageContent, imageUrl, decodeDetail, roomCard, promotional, parseOneMsg};

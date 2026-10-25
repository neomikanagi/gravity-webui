'use strict';
// Projections from official room payloads to the small allowlisted cards the browser may see.
const { validId, clipped, officialCdnImage, countryCode } = require('./gravity-util.cjs');

function tagList(raw) {
  if (typeof raw !== 'string' || !raw) return [];
  return raw.split(',').map(part => part.trim()).filter(Boolean).slice(0, 5).map(part => part.slice(0, 20));
}

function closedRoom(ext) {
  return ext?.is_close != null && ext.is_close !== '' && Number(ext.is_close) !== 0;
}

function publicRooms(raw) {
  const list = Array.isArray(raw?.room_list) ? raw.room_list : Array.isArray(raw?.list) ? raw.list : [];
  const rooms = [];
  // Native recommendation pages can exceed 20 rows even when last_id is empty.
  // Keep the bounded official page, not the old public-hot/search limit.
  for (const item of list.slice(0, 100)) {
    const channel_id = typeof item?.channel_id === 'string' ? item.channel_id : '';
    const hostId = item?.anchor_info?.user_id ?? item?.user_id;
    if (typeof hostId === 'number' && !Number.isSafeInteger(hostId)) continue;
    const anchor_id = hostId == null ? '' : String(hostId);
    if (!validId(channel_id) || !validId(anchor_id)) continue;
    const ext = item.ext && typeof item.ext === 'object' ? item.ext : {};
    // The rank list keeps today's ended rooms with ext.is_close=1 (the App greys
    // them out as "closed"; ItemVoiceRoomRank treats only 0 as open). Category and
    // search rows omit the flag. An ended room can be neither heard nor entered.
    if (closedRoom(ext)) continue;
    const host = item.anchor_info || (Array.isArray(ext.user_list) ? ext.user_list.find(user => String(user?.user_id) === anchor_id) : null);
    const rawCount = item.member_count ?? ext.user_count;
    const count = rawCount == null ? NaN : Number(rawCount);
    const room = {
      channel_id,
      anchor_id,
      title: clipped(item.voice_name ?? item.name, 200),
      anchor_name: clipped(host?.name, 100),
      count: Number.isFinite(count) && count >= 0 ? count : null,
    };
    const label = clipped(item.label ?? item.label_info?.label, 20);
    const tags = tagList(item.tags);
    const topic = clipped(item.topic, 80);
    const notice = clipped(item.notice, 200);
    const portrait = officialCdnImage(host?.portrait);
    const cover = officialCdnImage(item.cover_img ?? ext.cover_img);
    if (label) room.label = label;
    if (tags.length) room.tags = tags;
    if (topic) room.topic = topic;
    if (notice) room.notice = notice;
    if (portrait) room.portrait = portrait;
    if (cover) room.cover = cover;
    rooms.push(room);
  }
  return rooms;
}

// Native follow_type: 1 = followed creators, 2 = followed users joined elsewhere.
// Do not infer a follow relationship from the general attendee preview.
function publicFollowRooms(raw, following = []) {
  const followed = new Map(following.filter(p => validId(String(p?.user_id || ''))).map(p => [String(p.user_id), p]));
  const rooms = new Map();
  for (const group of (Array.isArray(raw?.list) ? raw.list : []).slice(0, 10)) {
    if (![1, 2].includes(group?.follow_type)) continue;
    for (const item of (Array.isArray(group.list) ? group.list : []).slice(0, 100)) {
      const room = publicRooms({ list: [item] })[0]; if (!room) continue;
      const people = group.follow_type === 1 ? [{ user_id: room.anchor_id, name: room.anchor_name, portrait: room.portrait }]
        : (Array.isArray(item.ext?.user_list) ? item.ext.user_list : []).filter(p => followed.has(String(p?.user_id))).map(p => followed.get(String(p.user_id)));
      const friends = [...new Map(people.map(p => [String(p.user_id), { user_id: String(p.user_id), name: clipped(p.name, 80), portrait: officialCdnImage(p.portrait), country: countryCode(p.user_country) || countryCode(p.ext?.user_country) }])).values()];
      rooms.set(`${group.follow_type}:${room.channel_id}`, { ...room, follow_type: group.follow_type,
        friends, friend_names: friends.map(p => p.name).filter(Boolean) });
    }
  }
  return [...rooms.values()].slice(0, 100);
}

module.exports = { tagList, closedRoom, publicRooms, publicFollowRooms };

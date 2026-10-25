'use strict';
// Share links / short codes -> {channel_id, anchor_id}. Canonical official HTTPS only; redirects are parsed, never followed.
const { InputError, validId } = require('./gravity-util.cjs');
const { API_HOST, httpsRequest } = require('./gravity-upstream.cjs');

const INFO_PATH = '/gravity/h5/voiceroom/getVoiceRoomInfo';
const SHARE_PATHS = new Map([
  ['www.gravity.place', '/share/shareVoiceRoomOnline'],
  ['h5.gravity.place', '/shareVoiceRoomOnline'],
]);

function officialUrl(input) {
  let u;
  try { u = new URL(input); } catch { throw new InputError('请输入 GRAVITY 分享链接或短码。'); }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || u.hash) {
    throw new InputError('仅支持官方 HTTPS 分享链接。');
  }
  return u;
}

function parseRoomFromUrl(input) {
  const u = officialUrl(input);
  if (SHARE_PATHS.get(u.hostname) !== u.pathname) throw new InputError('不是官方语音房分享页。');
  const channel_id = u.searchParams.get('channel_id') || u.searchParams.get('channelId');
  const anchor_id = u.searchParams.get('anchor_id') || u.searchParams.get('anchorId');
  if (!validId(channel_id) || !validId(anchor_id)) throw new InputError('分享页缺少有效的房间/主播 ID。');
  return { channel_id, anchor_id, title: (u.searchParams.get('title') || '').slice(0, 200) };
}

function extractShortCode(input) {
  if (/^[A-Za-z0-9]{4,12}$/.test(input)) return input;
  const u = officialUrl(input);
  if (u.hostname === API_HOST && !u.search && /^\/gravity\/url\/[A-Za-z0-9]{4,12}$/.test(u.pathname)) {
    return u.pathname.split('/').pop();
  }
  return null;
}

async function resolveShareInput(input, request = httpsRequest) {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 2048) throw new InputError('请输入有效的分享链接或短码。');
  const code = extractShortCode(raw);
  if (!code) return parseRoomFromUrl(raw);
  const response = await request({ hostname: API_HOST, path: `/gravity/url/${code}` });
  if (!response.headers.location) throw new InputError('短链无效、已失效，或未返回房间地址。');
  let location;
  try { location = new URL(response.headers.location, 'https://api.gravity.place').href; }
  catch { throw new InputError('短链未返回有效的官方房间地址。'); }
  return parseRoomFromUrl(location);
}

async function fetchRoomInfo(room, request) {
  const query = new URLSearchParams(room);
  try {
    const result = await request({ hostname: API_HOST, path: `${INFO_PATH}?${query}` });
    if (result.status !== 200) return null;
    const j = JSON.parse(result.body.toString('utf8'));
    return j.errno === 0 && j.data && typeof j.data === 'object' ? j.data : null;
  } catch { return null; } // Metadata is optional; resolving IDs is not.
}

module.exports = { parseRoomFromUrl, extractShortCode, resolveShareInput, fetchRoomInfo };

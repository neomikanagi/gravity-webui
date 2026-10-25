/* Footprints: who visited me (tab 0) / who I visited (tab 1). Read-only. */
(function(){
 'use strict';
 const ids = ['btnFootprints', 'footTab', 'footStatus', 'footList', 'btnMoreFoot'];
 const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
 if (!el.footList) return;
 let tab = 0, cursor = '', busy = false, loaded = false;
 async function api(url) {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 30000);
  try {
   const response = await fetch(url, {signal: abort.signal, cache: 'no-store'});
   const result = await response.json().catch(() => ({}));
   if (!response.ok || result.errno !== 0) throw new Error(result.errmsg || '足跡を取得できません。');
   return result.data;
  } catch (error) {
   if (error?.name === 'AbortError') throw new Error('読み込みがタイムアウトしました。やり直してください。');
   throw error;
  } finally { clearTimeout(timer); }
 }
 function row(item) {
  const li = document.createElement('li');
  const open = () => { void window.GravityProfileUI?.open({user_id: item.user_id, name: item.name, portrait: item.portrait}); };
  if (item.portrait) {
   const img = document.createElement('img');
   img.className = 'portrait'; img.alt = ''; img.width = img.height = 40; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.src = item.portrait;
   const photo = document.createElement('button');
   photo.type = 'button'; photo.className = 'person-avatar'; photo.setAttribute('aria-label', `プロフィールを見る：${item.name || item.user_id}`);
   photo.append(img); photo.addEventListener('click', open); li.append(photo);
  }
  const meta = document.createElement('div'); meta.className = 'meta';
  const title = document.createElement('button');
  title.type = 'button'; title.className = 'person-link title'; title.textContent = item.name || item.user_id;
  title.addEventListener('click', open);
  const sub = document.createElement('div'); sub.className = 'sub';
  sub.textContent = (tab === 0 ? '来訪 ' : '訪問 ') + item.visits + '回' + (item.last_visit ? ` · ${item.last_visit}` : '');
  meta.append(title, sub); li.append(meta);
  return li;
 }
 async function load(append = false, force = false) {
  if (busy || (append && !cursor) || (!append && loaded && !force)) return;
  busy = true; el.btnFootprints.disabled = el.btnMoreFoot.disabled = true;
  el.footStatus.textContent = '足跡を読み込み中…';
  try {
   const data = await api('/api/profile/footprints?' + new URLSearchParams({tab: String(tab), ...(append ? {cursor} : {})}));
   if (!append) el.footList.replaceChildren();
   for (const item of data.visitors || []) el.footList.append(row(item));
   cursor = data.next_cursor || '';
   el.btnMoreFoot.hidden = !cursor;
   loaded = true;
   el.footStatus.textContent = el.footList.children.length ? '' : '足跡はありません（相手が非表示なら見えません）';
  } catch (error) { el.footStatus.textContent = error.message; }
  finally { busy = false; el.btnFootprints.disabled = el.btnMoreFoot.disabled = false; }
 }
 el.btnFootprints.addEventListener('click', () => void load(false, true));
 el.btnMoreFoot.addEventListener('click', () => void load(true));
 el.footTab.addEventListener('change', () => { tab = Number(el.footTab.value) || 0; cursor = ''; void load(false, true); });
 window.GravityFootprintsUI = {load};
})();

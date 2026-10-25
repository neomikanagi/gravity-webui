/* RTC lifecycle. Explicit owner takeover only; no account login, recording or automatic microphone resume. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GravityWeb = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const APP_ID = 'c539f897e5154319beab0a367749b4fc'; // Public Agora application identifier, not a secret.
  class UserError extends Error {}
  function describe(error) {
    if (error instanceof UserError) return error.message;
    const code = String(error?.code || error?.name || 'Error');
    if (/NotAllowedError|PERMISSION_DENIED/i.test(code)) return 'マイクが拒否されました。ブラウザのサイト設定で許可してからやり直してください。';
    if (/NotFoundError|DEVICE_NOT_FOUND/i.test(code)) return 'マイクが見つかりません。機器や Bluetooth を確認してください。';
    if (/NotReadableError|TRACK_IS_DISABLED|DEVICE_IN_USE/i.test(code)) return 'マイクを使えません。使っている通話や App を閉じてやり直してください。';
    return /^[A-Za-z_0-9-]{1,80}$/.test(code) ? `操作できませんでした（${code}）。確認するかやり直してください。` : '操作できませんでした。確認するかやり直してください。';
  }
  function tokenPrivileges(token) {
    const unknown = { version: 'unknown', known: false, declaresPublishAudio: null, signatureVerified: false };
    if (typeof token !== 'string' || !token.startsWith('006') || token.length < 35) return unknown;
    try {
      const text = atob(token.slice(35));
      const bytes = Uint8Array.from(text, c => c.charCodeAt(0));
      const data = new DataView(bytes.buffer);
      let offset = 2 + data.getUint16(0, true) + 8;
      const length = data.getUint16(offset, true); offset += 2;
      if (length < 10 || offset + length !== bytes.length) return unknown;
      const count = data.getUint16(offset + 8, true);
      if (length !== 10 + count * 6) return unknown;
      const ids = [], expirations = [];
      for (let i = 0; i < count; i++) {
        ids.push(data.getUint16(offset + 10 + i * 6, true));
        expirations.push(data.getUint32(offset + 12 + i * 6, true) * 1000);
      }
      return { version: '006', known: true, declaresJoin: ids.includes(1), declaresPublishAudio: ids.includes(2),
        declaresRtmLogin: ids.includes(1000), expiresAt: count ? Math.min(...expirations) : null, signatureVerified: false };
    } catch { return unknown; }
  }
  class Controller {
    constructor({ getSdk, fetch = globalThis.fetch.bind(globalThis), onChange = () => {}, onLog = () => {}, timers = globalThis, now = Date.now, allowExperimentalPublish = false }) {
      this.getSdk = getSdk; this.fetch = fetch; this.onChange = onChange; this.onLog = onLog; this.timers = timers; this.now = now;
      // Disabled in the shipped UI. Synthetic lifecycle tests may opt in; this is not official seat permission.
      this.allowExperimentalPublish = allowExperimentalPublish === true;
      this.accountMode = 'anonymous'; this.accountUid = null;
      this.generation = 0; this.running = false; this.session = null; this.abort = null; this.timer = null;
      this.state = 'idle'; this.message = '未接続'; this.errorStatus = 0; this.room = null; this.connections = 0; this.retries = 0;
      this.volume = 150; this.mic = null; this.micClosing = null; this.micIntent = 0; this.micState = 'off'; this.privileges = null;
      // Per-person listening volumes (pure client side; the Agora SDK already reports each
      // remote track's level, so no extra detection module is needed). 100 = unchanged.
      this.userVolumes = new Map(); this.autoGains = new Map(); this.levelPeaks = new Map();
      this.autoBalance = true;
      try {
        const saved = JSON.parse(globalThis.localStorage?.getItem('gravity.volumes') || 'null');
        if (saved && typeof saved === 'object') for (const [uid, vol] of Object.entries(saved)) {
          const n = Number(uid), v = Number(vol);
          if (Number.isSafeInteger(n) && n > 0 && Number.isFinite(v)) this.userVolumes.set(n, Math.max(0, Math.min(200, v)));
        }
        // Auto-balance stays on with no UI. Tests may still call setAutoBalance(false).
      } catch {}
    }
    snapshot() {
      return { generation: this.generation, running: this.running, state: this.state, message: this.message, errorStatus: this.errorStatus,
        room: this.room, connections: this.connections, remoteAudioCount: this.session?.tracks.size || 0,
        volume: this.volume, micState: this.micState, micClosing: !!this.micClosing, tokenPrivileges: this.privileges,
        transmittingVerified: false, publishingAvailable: this.accountMode === 'owner'
          ? !!this.session?.ownerPermit && this.state === 'listening' && !this.micClosing
          : this.allowExperimentalPublish && this.accountMode === 'anonymous', accountMode: this.accountMode,
        ownerState: this.session?.ownerState || null };
    }
    emit() { this.onChange(this.snapshot()); }
    log(message) { this.onLog(message); }
    isCurrent(generation) { return this.running && this.generation === generation; }
    active(session) { return !!session && this.session === session && this.isCurrent(session.generation); }
    cancelWork() {
      this.abort?.abort(); this.abort = null;
      if (this.timer !== null) this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    async request(url, signal, options = {}) {
      let response;
      try {
        const deadline = AbortSignal.timeout(30_000);
        const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
        response = await this.fetch(url, { cache: 'no-store', ...options, signal: boundedSignal });
      } catch (error) {
        // Network-level failure (DNS, blocked route, aborted backbone): always retryable.
        const failed = new UserError('ネットワークを使えません。しばらくしてやり直してください。'); failed.status = 0; throw failed;
      }
      let result;
      try { result = await response.json(); } catch {
        const invalid = new UserError('API が有効な JSON を返しませんでした。'); invalid.status = response.status || 0; throw invalid;
      }
      if (!response.ok || result.errno !== 0) {
        // The proxy returns bounded, non-sensitive errors, never OAuth/login data.
        // Carrying the HTTP status lets the caller halt fast on rejections (4xx)
        // while riding out blips (0/5xx).
        const failed = new UserError(typeof result.errmsg === 'string' ? result.errmsg.slice(0, 160) : 'API を使えません。');
        failed.status = response.status || 0; throw failed;
      }
      return result.data;
    }
    ownerAction(action, session, extra = {}) {
      return this.request('/api/owner/' + action, undefined, {method:'POST', keepalive:true,
        headers:{'Content-Type':'application/json', 'X-Gravity-Action':'owner-control'},
        body:JSON.stringify({channel_id:String(session.room.channel_id), owner_permit:session.ownerPermit, ...extra})});
    }
    async start(input) {
      const accountMode = input.accountMode || 'anonymous';
      if (!['anonymous','account','owner','member'].includes(accountMode)) throw new UserError('この聴き方は使えません。');
      if (accountMode === 'owner' && input.ownerConfirmed !== true) throw new UserError('ホスト引き継ぎは App の接続を置き換えることがあります。マイクは自動ではオンにしません。先に確認してください。');
      if (accountMode === 'member' && input.memberConfirmed !== true) throw new UserError('このページがいまのアカウントで入室することを先に確認してください。');
      this.accountMode = accountMode; this.accountUid = null;
      const generation = ++this.generation;
      this.running = true; this.cancelWork();
      const old = this.session; this.session = null;
      const signal = new AbortController(); this.abort = signal;
      this.state = 'resolving'; this.message = 'ルームを解析中…'; this.errorStatus = 0; this.room = null; this.privileges = null;
      this.connections = 0; this.retries = 0; this.emit();
      try {
        await this.closeMic(); await this.dispose(old);
        if (!this.isCurrent(generation)) return false;
        let room;
        if (input.share) room = await this.request(`/api/resolve?url=${encodeURIComponent(input.share)}`, signal.signal);
        else {
          if (!/^[0-9]{1,20}$/.test(input.channel_id || '') || !/^[0-9]{1,20}$/.test(input.anchor_id || '')) {
            throw new UserError('共有リンクを貼ってください。古いリンクはルーム ID とホスト ID の両方が必要です。');
          }
          room = { channel_id: input.channel_id, anchor_id: input.anchor_id,
            title: typeof input.title === 'string' ? input.title.slice(0, 200) : '',
            anchor_name: typeof input.anchor_name === 'string' ? input.anchor_name.slice(0, 100) : '', count: input.count };
        }
        if (!this.isCurrent(generation)) return false;
        this.room = room; this.state = 'connecting'; this.message = this.accountMode === 'owner' ? 'ホストをミュートで引き継ぎ中…' : this.accountMode === 'member' ? 'アカウントで入室接続中…' : this.accountMode === 'account' ? 'アカウントの受信専用で接続中…' : '匿名接続中…'; this.emit();
        await this.join(room, generation, signal.signal);
        return this.isCurrent(generation);
      } catch (error) {
        if (!this.isCurrent(generation)) return false;
        this.running = false; this.cancelWork();
        const failed = this.session; this.session = null;
        await this.closeMic(); await this.dispose(failed);
        if (this.generation !== generation) return false;
        this.state = 'error'; this.message = describe(error); this.errorStatus = error?.status || 0; this.log(this.message); this.emit();
        return false;
      }
    }
    async join(room, generation, signal, previous = null) {
      const owner = this.accountMode === 'owner';
      const account = this.accountMode === 'account' || owner;
      const data = owner
        ? await this.ownerAction('connect', {room}, {confirmed:true})
        : await this.request(account
          ? `/api/agora-token?channel_id=${encodeURIComponent(room.channel_id)}`
          : `/api/token?channel_id=${encodeURIComponent(room.channel_id)}&anchor_id=${encodeURIComponent(room.anchor_id)}`, signal);
      const releaseUnused = async () => {
        if (owner && data.owner_permit) await this.ownerAction('release', {room, ownerPermit:data.owner_permit}).catch(() => {});
      };
      if (!this.isCurrent(generation)) { await releaseUnused(); return; }
      const uid = Number(data.user_id);
      if (!Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffffffff || typeof data.rtc_token !== 'string') {
        throw new UserError('入室トークンの形式が正しくありません。');
      }
      if (account) {
        const privileges = tokenPrivileges(data.rtc_token);
        const validOwner = data.mode === 'owner-test' && data.publishing_available === true &&
          data.eligible === true && data.muted === true && data.seat_id === 0 &&
          data.seat_provenance === 'official-tls' && data.reported_digest_rsa_verified === true &&
          typeof data.owner_permit === 'string' && privileges.declaresPublishAudio === true;
        const validAudience = data.mode === 'account-audience' && data.publishing_available === false && privileges.declaresPublishAudio === false;
        if (!privileges.known || privileges.declaresJoin !== true || (owner ? !validOwner : !validAudience)) {
          await releaseUnused();
          throw new UserError(owner ? 'ホスト引き継ぎのトークンまたはミュート席が一致しません。未接続です。' : 'アカウントのトークンは検証済みの受信専用権限ではありません。未接続です。');
        }
        if (this.accountUid !== null && this.accountUid !== uid) {
          const error = new UserError('アカウントが変わりました。停止しました。手動で再接続してください。アカウントは自動では切り替えません。');
          error.code = 'ACCOUNT_CHANGED'; throw error;
        }
        this.accountUid = uid;
      }
      let sdk;
      try { sdk = await this.getSdk(); } catch (error) { await releaseUnused(); throw error; }
      if (!this.isCurrent(generation)) { await releaseUnused(); return; }
      sdk.setLogLevel(4);
      const session = { generation, room, client: sdk.createClient({ mode: account ? 'live' : 'rtc', codec: 'vp8' }), tracks: new Map(), joined: false, joinPromise: null, disposing: null,
        ownerPermit:owner ? data.owner_permit : null, ownerState:owner ? {muted:true, seat_id:0} : null, ownerTimer:null,
        uid, previous, credentialTimer:null, handoverTimer:null };
      this.session = session; this.privileges = tokenPrivileges(data.rtc_token);
      if (account) {
        await session.client.setClientRole(owner ? 'host' : 'audience');
        if (!this.active(session)) { await this.dispose(session); return; }
      }
      this.attach(session);
      session.joinPromise = session.client.join(APP_ID, String(room.channel_id), data.rtc_token, uid);
      await session.joinPromise;
      session.joined = true;
      if (!this.active(session)) { await this.dispose(session); return; }
      this.connections += 1; this.retries = 0;
      this.state = 'listening'; this.message = owner ? '入室済み · ホスト引き継ぎ（マイクオフ）' : account ? '入室済み · アカウント受信専用' : '入室済み';
      this.log(owner ? 'ホスト RTC をミュートで引き継ぎました。管理は App 側です。独立キープアライブや相互聴取は未検証です。' : account ? 'アカウントの受信専用入室に成功。公式マイク席は申請していません。' : '匿名入室に成功'); this.emit();
      if (owner) this.scheduleOwnerCheck(session);
      else this.scheduleListeningCredentials(session, data);
      if (previous) {
        // Anonymous credentials bind a new UID on every issuance. Connect the
        // replacement BEFORE retiring the old audio, not after token expiry.
        if (session.tracks.size || !previous.tracks.size) this.finishHandover(session);
        else session.handoverTimer = this.timers.setTimeout(() => this.finishHandover(session), 3000);
      }
    }
    finishHandover(session) {
      if (session.handoverTimer != null) this.timers.clearTimeout(session.handoverTimer);
      session.handoverTimer = null;
      const previous = session.previous; session.previous = null;
      if (previous) void this.dispose(previous);
    }
    scheduleListeningCredentials(session, data) {
      if (!this.active(session)) return;
      if (session.credentialTimer != null) this.timers.clearTimeout(session.credentialTimer);
      const p = tokenPrivileges(data.rtc_token);
      session.tokenExpiresAt = p.expiresAt;
      session.credentialTimer = this.timers.setTimeout(() => {
        session.credentialTimer = null;
        if (!this.active(session)) return;
        if (session.renewCredentials) session.renewCredentials();
        else this.scheduleRejoin(session.room, session.generation, 0);
      }, Number.isFinite(p.expiresAt) ? Math.max(1000, p.expiresAt - this.now() - 60_000) : 60_000);
      if (this.accountMode === 'account') session.renewCredentials = () => {
        if (session.credentialWork) return;
        session.credentialWork = (async () => {
          const next = await this.request(`/api/agora-token?channel_id=${encodeURIComponent(session.room.channel_id)}`, this.abort?.signal);
          if (!this.active(session)) return;
          const rights = tokenPrivileges(next.rtc_token);
          if (Number(next.user_id) !== session.uid || !rights.declaresJoin || rights.declaresPublishAudio !== false || rights.expiresAt <= this.now() + 30_000)
            throw new UserError('アカウント受信の更新トークンが一致しません。');
          await session.client.renewToken(next.rtc_token);
          if (this.active(session)) this.scheduleListeningCredentials(session, next);
        })().catch(() => { if (this.active(session)) void this.halt('アカウント受信トークンの更新に失敗しました。手動で再接続してください。'); })
          .finally(() => { session.credentialWork = null; });
      };
    }
    scheduleOwnerCheck(session) {
      if (!this.active(session) || session.ownerTimer !== null) return;
      session.ownerTimer = this.timers.setTimeout(() => {
        session.ownerTimer = null;
        void this.checkOwner(session).then(() => this.scheduleOwnerCheck(session)).catch(() => {
          if (this.active(session)) void this.halt('ホスト席またはルーム状態を確認できません。停止しました。App でミュートを確認してください。');
        });
      }, 5000);
    }
    async checkOwner(session) {
      const status = await this.request(`/api/owner/status?channel_id=${encodeURIComponent(session.room.channel_id)}`, this.abort?.signal,
        {headers:{'X-Gravity-Owner-Permit':session.ownerPermit}});
      if (!this.active(session)) return null;
      if (status.eligible !== true || status.seat_id !== 0 || status.seat_provenance !== 'official-tls' || status.reported_digest_rsa_verified !== true) {
        throw new UserError('ホスト席の権限が変わりました。送信を止めました。');
      }
      if (status.muted === true && this.micState === 'sdk-published-unverified') {
        throw new UserError('公式席がミュートです。送信を止めました。');
      }
      session.ownerState = {muted:status.muted === true, seat_id:0}; this.emit();
      return status;
    }
    attach(session) {
      const client = session.client;
      client.on('user-published', async (user, mediaType) => {
        if (mediaType !== 'audio' || !this.active(session)) return;
        // Someone we block is never played, however often they come back on the mic.
        if (session.mutedUids?.has(Number(user.uid))) return;
        try {
          await client.subscribe(user, 'audio');
          if (!this.active(session) || session.mutedUids?.has(Number(user.uid))) { user.audioTrack?.stop(); return; }
          if (user.audioTrack) {
            session.tracks.set(String(user.uid), user.audioTrack);
            // Stop old playback before playing the replacement to avoid echoes.
            this.finishHandover(session);
            this.playRemote(user.audioTrack, user.uid, session);
            this.log('相手の音声を購読しました。'); this.emit();
          }
        } catch (error) { if (this.active(session)) this.log(describe(error)); }
      });
      const remove = user => {
        const id = String(user.uid); session.tracks.get(id)?.stop(); session.tracks.delete(id);
        if (this.active(session)) this.emit();
      };
      client.on('user-unpublished', (user, mediaType) => { if (mediaType === 'audio') remove(user); });
      client.on('user-left', remove);
      client.on('token-privilege-will-expire', () => {
        if (!this.active(session)) return;
        if (session.renewCredentials) session.renewCredentials();
        else if (!session.ownerPermit && !session.memberPermit && session.joined) this.scheduleRejoin(session.room, session.generation, 0);
      });
      client.on('token-privilege-did-expire', () => {
        if (!this.active(session)) return;
        if (session.renewCredentials) session.renewCredentials();
        else if (session.ownerPermit || session.memberPermit) void this.halt('アカウントのトークンが期限切れです。マイクを閉じて停止しました。手動で再接続してください。');
        else this.scheduleRejoin(session.room, session.generation, 300);
      });
      client.on('connection-state-change', (current, previous, reason) => {
        if (!this.active(session)) return;
        if (current === 'RECONNECTING' || current === 'DISCONNECTED') session.rtcInterrupted = true;
        else if (current === 'CONNECTED') session.rtcInterrupted = false;
        const banned = /UID_BANNED|UID_CONFLICT|REMOTE_LOGIN|DUPLICATE|KICK|BANNED|FORBIDDEN/i.test(String(reason));
        if (session.ownerPermit && ['DISCONNECTED','RECONNECTING'].includes(current)) {
          const detail = banned ? 'サーバーが切断または拒否しました' : '音声回線が切れました';
          void this.halt(`ホスト接続が停止：${detail}。マイクを閉じました。接続は自動では取り戻しません。`);
        } else if (session.memberPermit && banned) {
          void this.halt('アカウントの音声接続が停止：サーバーが切断または拒否しました。マイクを閉じました。接続は自動では取り戻しません。');
        } else if (session.memberPermit && current === 'RECONNECTING') {
          void this.closeMic(); this.log('音声が短時間切れました。自動再接続を待ちます…');
        } else if (session.memberPermit && current === 'CONNECTED' && previous === 'RECONNECTING') {
          this.log('音声が再接続しました。');
        } else if (session.memberPermit && current === 'DISCONNECTED' && !banned) {
          if (session.recoverRtc) session.recoverRtc();
          else void this.halt('音声接続が切れました。手動で入り直してください。');
        } else if (current === 'DISCONNECTED' && banned) {
          this.halt('サーバーがこの接続を拒否または切断しました。停止しました。別の身分では再試行しません。');
        } else if (current === 'DISCONNECTED' && session.joined && !session.memberPermit && !session.ownerPermit) {
          this.scheduleRejoin(session.room, session.generation, 1000);
        }
      });
    }
    /** Replace the set of RTC uids whose audio must stay silent; anything already playing from them stops now. */
    setMutedUids(session, uids) {
      if (!session) return;
      const next = new Set([...uids].map(Number).filter(Number.isSafeInteger));
      session.mutedUids = next;
      let changed = false;
      for (const [id, track] of [...session.tracks]) if (next.has(Number(id))) { track.stop(); session.tracks.delete(id); changed = true; }
      if (changed && this.active(session)) this.emit();
    }
    userVolume(uid){const v=this.userVolumes.get(Number(uid));return v===undefined?100:v;}
    autoGain(uid){return this.autoGains.get(Number(uid)) || 1;}
    effectiveVolume(uid){if(this.session?.listenerMuted?.has(Number(uid)))return 0;
      return Math.max(0, Math.min(400, Math.round(this.volume * (this.userVolume(uid) / 100) * (this.autoBalance ? this.autoGain(uid) : 1))));}
    applyUserVolume(uid){const track=this.session?.tracks.get(String(Number(uid)));if(track)track.setVolume(this.effectiveVolume(uid));}
    // iOS Safari ignores HTMLMediaElement.volume (always 1), so setVolume(0) does not
    // silence there. Keep the subscribed track and stop/play local playback instead.
    playRemote(track, uid, session = this.session) {
      if (!track) return;
      track.setVolume(this.effectiveVolume(uid));
      if (session?.listenerMuted?.has(Number(uid))) track.stop();
      else track.play();
    }
    setUserVolume(uid,value){const n=Number(uid),v=Math.max(0,Math.min(200,Number(value)||0));
      if(!Number.isSafeInteger(n)||n<1)return;this.userVolumes.set(n,v);this.applyUserVolume(n);
      try{globalThis.localStorage?.setItem('gravity.volumes',JSON.stringify(Object.fromEntries(this.userVolumes)));}catch{}this.emit();}
    setAutoBalance(enabled){this.autoBalance=enabled===true;
      try{globalThis.localStorage?.setItem('gravity.autobalance',this.autoBalance?'1':'0');}catch{}
      if(!this.autoBalance){this.autoGains.clear();for(const id of this.session?.tracks.keys()||[])this.applyUserVolume(id);}
      this.emit();}
    // Nudge each audible remote track toward the same apparent level. Only speech (not
    // silence) moves the gain, so quiet rooms are not amplified into noise. Returns true on change.
    balanceVolumes(){const session=this.session;if(!this.active(session)||!this.autoBalance)return false;
      let changed=false;
      for(const [id,track] of session.tracks){
        const uid=Number(id);let level=0;
        try{level=Number(track.getVolumeLevel?.())||0;}catch{level=0;}
        const peak=Math.max(level,(this.levelPeaks.get(uid)||0)*0.92);
        this.levelPeaks.set(uid,peak);
        if(peak<0.03)continue;
        const target=Math.max(0.4,Math.min(2.5,0.3/Math.max(peak,0.01)));
        const current=this.autoGain(uid),next=current+(target-current)*0.25;
        if(Math.abs(next-current)>0.01){this.autoGains.set(uid,next);track.setVolume(this.effectiveVolume(uid));changed=true;}
      }
      if(changed)this.emit();return changed;
    }
    setVolume(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return;
      this.volume = Math.max(0, Math.min(400, number));
      for (const id of this.session?.tracks.keys() || []) this.applyUserVolume(id);
      this.emit();
    }
    replay() {
      const session = this.session;
      for (const [id, track] of session?.tracks || []) this.playRemote(track, id, session);
    }
    async dispose(session) {
      if (!session) return;
      if (session.disposing) return session.disposing;
      session.disposing = (async () => {
        if (session.ownerTimer !== null) this.timers.clearTimeout(session.ownerTimer);
        session.ownerTimer = null;
        if (session.credentialTimer != null) this.timers.clearTimeout(session.credentialTimer);
        if (session.handoverTimer != null) this.timers.clearTimeout(session.handoverTimer);
        session.credentialTimer = session.handoverTimer = null;
        const previous = session.previous; session.previous = null;
        if (previous) await this.dispose(previous);
        if (this.mic?.session === session) await this.closeMic();
        for (const track of session.tracks.values()) { try { track.stop(); } catch {} }
        session.tracks.clear();
        // leave() interrupts a pending join where supported. Still await and leave
        // after it settles so a late successful join cannot leak a room session.
        try { await session.client.leave(); } catch {}
        if (session.joinPromise && !session.joined) {
          try { await session.joinPromise; await session.client.leave(); } catch {}
        }
        session.client.removeAllListeners?.();
        if (session.micClosing) await session.micClosing;
        if (session.ownerPermit) {
          await this.ownerAction('release', session).catch(() => this.log('引き継ぎ権限の掃除は確認できませんでした。App でホスト席のミュートを確認してください。'));
          session.ownerPermit = null;
        }
      })();
      return session.disposing;
    }
    scheduleRejoin(room, generation, delay, retry = false) {
      if (!this.isCurrent(generation) || this.timer !== null || (!retry && this.rejoiningGeneration === generation)) return;
      if (this.session?.credentialTimer != null) this.timers.clearTimeout(this.session.credentialTimer);
      if (this.session) this.session.credentialTimer = null;
      this.state = 'reconnecting'; this.message = '再接続中…'; this.emit();
      // Close capture immediately, not after the backoff timer.
      void this.closeMic();
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        void this.rejoin(room, generation);
      }, delay);
    }
    async rejoin(room, generation) {
      if (!this.isCurrent(generation) || this.rejoiningGeneration === generation) return;
      this.rejoiningGeneration = generation;
      const old = this.session;
      try {
        await this.closeMic();
        if (!this.isCurrent(generation)) return;
        await this.join(room, generation, this.abort?.signal, old);
      } catch (error) {
        if (!this.isCurrent(generation)) return;
        const failed = this.session;
        // A failed candidate must not dispose the still-playing old connection.
        if (failed && failed !== old) { failed.previous = null; this.session = old; await this.dispose(failed); }
        if (!this.isCurrent(generation)) return;
        this.retries += 1;
        if (this.retries >= 5 || /BANNED|KICK|FORBIDDEN|ACCOUNT_CHANGED/i.test(String(error?.code))) {
          await this.halt('試聴の再接続に失敗して停止しました。ルーム状態を確認して手動でやり直してください。');
        } else {
          this.log(`試聴の再接続に失敗（${this.retries}/5）。待ってから再試行します。`);
          this.scheduleRejoin(room, generation, Math.min(30_000, 1000 * 2 ** this.retries), true);
        }
      } finally {
        if (this.rejoiningGeneration === generation) this.rejoiningGeneration = null;
      }
    }
    async stop() {
      const generation = ++this.generation;
      this.running = false; this.cancelWork();
      const old = this.session; this.session = null;
      this.state = 'stopping'; this.message = '停止して接続を掃除中…'; this.emit();
      await Promise.all([this.closeMic(), this.dispose(old)]);
      if (generation === this.generation) {
        this.state = 'idle'; this.message = '停止しました'; this.privileges = null; this.emit();
      }
    }
    async halt(message) {
      const stopped = this.stop(); const generation = this.generation;
      await stopped;
      if (generation === this.generation) { this.state = 'error'; this.message = message; this.log(message); this.emit(); }
    }
    closeTrack(record) {
      if (record.track && !record.closed) { record.track.close(); record.closed = true; }
    }
    async checkMic() {
      const intent = this.micIntent;
      if (this.micClosing) await this.micClosing;
      if (intent !== this.micIntent) return null;
      if (this.mic) return this.mic.opening;
      const record = { intent: ++this.micIntent, track: null, opening: null, publishPromise: null, session: null, closed: false };
      this.mic = record; this.micState = 'checking'; this.emit();
      record.opening = (async () => {
        try {
          const sdk = await this.getSdk();
          if (this.mic !== record) return null;
          record.track = await sdk.createMicrophoneAudioTrack({ encoderConfig: 'speech_standard', ANS: true, AEC: true });
          if (this.mic !== record || record.intent !== this.micIntent) { this.closeTrack(record); return null; }
          this.micState = 'local-ready'; this.log('ローカル確認を開始しました'); this.emit();
          return record.track;
        } catch (error) {
          this.closeTrack(record);
          if (this.mic === record) { this.mic = null; this.micState = 'off'; this.emit(); }
          throw error;
        }
      })();
      return record.opening;
    }
    micLevel() { return this.mic?.track?.getVolumeLevel?.() || 0; }
    async publishOwnerMic(authorized) {
      if (authorized !== true) throw new UserError('先に「ルームへ送信」を確認してください。');
      const session = this.session;
      if (!this.active(session) || !session.ownerPermit || this.state !== 'listening') throw new UserError('ホスト引き継ぎを確認してから接続してください。');
      if (this.ownerPublishWork) return this.ownerPublishWork;
      if (this.micState === 'sdk-published-unverified') return true;
      const intent = this.micIntent;
      const work = (async () => {
        try {
          if (this.micClosing) await this.micClosing;
          if (!this.active(session) || intent !== this.micIntent) return false;
          await this.checkOwner(session);
          // Closing/revoking consent while status is pending must cancel before any device call.
          if (!this.active(session) || intent !== this.micIntent) return false;
          const track = await this.checkMic(), record = this.mic;
          if (!track || !record || !this.active(session)) return false;
          record.session = session; this.micState = 'publishing'; this.emit();
          record.ownerUnmute = this.ownerAction('mute', session, {muted:false, confirmed:true});
          await record.ownerUnmute;
          if (this.mic !== record || !this.active(session)) return false;
          record.publishPromise = session.client.publish([track]);
          await record.publishPromise;
          if (this.mic !== record || !this.active(session)) return false;
          session.ownerState = {muted:false, seat_id:0};
          this.micState = 'sdk-published-unverified';
          this.log('公式席のミュートを解除し、SDK は配信を受け付けました。相手が聞こえるかは別途確認が必要です。'); this.emit();
          return true;
        } catch (error) { await this.closeMic(); throw error; }
      })();
      this.ownerPublishWork = work;
      try { return await work; } finally { if (this.ownerPublishWork === work) this.ownerPublishWork = null; }
    }
    async publishMic(authorized = false) {
      if (this.accountMode === 'owner') return this.publishOwnerMic(authorized);
      if (this.accountMode === 'account') throw new UserError('いまは受信専用です。公式席が未確認のため送信できません。');
      if (!this.allowExperimentalPublish) throw new UserError('公式アカウントと席がつながっていないため、まだ送信できません。');
      if (authorized !== true) throw new UserError('先に「ルームへ送信」を確認してください。');
      const session = this.session;
      if (!this.active(session) || this.state !== 'listening') throw new UserError('先にルームへ接続してください。');
      if (this.micState === 'sdk-published-unverified') return;
      const track = await this.checkMic();
      const record = this.mic;
      if (!track || !record || !this.active(session)) return false;
      record.session = session; this.micState = 'publishing'; this.emit();
      try {
        record.publishPromise = session.client.publish([track]);
        await record.publishPromise;
        if (this.mic !== record || !this.active(session)) return false;
        this.micState = 'sdk-published-unverified';
        this.log('SDK は試験配信を受け付けました。席や相手が聞こえるかは未検証です。'); this.emit();
        return true;
      } catch (error) { await this.closeMic(); throw error; }
    }
    closeMic() {
      ++this.micIntent;
      const record = this.mic;
      if (!record) { this.micState = 'off'; this.emit(); return this.micClosing || Promise.resolve(); }
      let finish;
      const cleanup = new Promise(resolve => { finish = resolve; });
      this.micClosing = cleanup;
      // Expose the barrier before clearing this.mic so parallel dispose cannot release first.
      if (record.session) record.session.micClosing = cleanup;
      this.mic = null; this.micState = 'off'; this.emit();
      // Stop physical capture immediately even if publish/permission or a server unmute is pending.
      try { record.track?.getMediaStreamTrack?.().stop(); } catch {}
      void (async () => {
        try {
          try { await record.opening; } catch {}
          if (record.publishPromise) {
            try { await record.publishPromise; } catch {}
            try { await record.session.client.unpublish([record.track]); } catch {}
          }
          this.closeTrack(record);
          if (record.ownerUnmute || record.memberUnmute) {
            try { await (record.ownerUnmute || record.memberUnmute); } catch {}
            const remute = record.memberUnmute ? this.memberAction('mute', record.session, {muted:true})
              : this.ownerAction('mute', record.session, {muted:true});
            await remute.then(() => {
              if (record.session.ownerState) record.session.ownerState.muted = true;
              if (record.session.memberState) record.session.memberState.muted = true;
            }).catch(() => this.log('公式ミュートの復帰は確認できませんでした。こちらの録音は閉じています。App でミュートを確認してください。'));
          }
        } finally {
          if (this.micClosing === cleanup) this.micClosing = null;
          finish(); this.emit();
        }
      })();
      return cleanup;
    }
  }
  return { Controller, UserError, describe, tokenPrivileges, APP_ID };
});

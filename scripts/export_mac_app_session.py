#!/usr/bin/env python3
"""Read the existing macOS GRAVITY login. Never log in, launch the App or change its files.

--out writes a private local session file. --sync-server streams the token over SSH,
atomically updates the server session and checks the official directory, search and labels.
The already captured iOS device fields are reused; no proxy or new capture is needed.
Set GRAVITY_SSH_HOST (default: your-server-ssh-alias) and
GRAVITY_REMOTE_SESSION_DIR (the .session directory next to the server checkout).
"""
from __future__ import annotations

import argparse
import json
import os
import plistlib
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_CONTAINER = Path.home() / "Library/Containers"
BUNDLE_ID = "com.hiclub.gravity"


def find_user_json(root: Path = DEFAULT_CONTAINER) -> Path:
    matches = []
    for candidate in root.glob("*/Data/Documents/userInfo/user.json"):
        # candidate.parents[2] is Data, not Documents/userInfo.
        prefs = candidate.parents[2] / "Library/Preferences" / f"{BUNDLE_ID}.plist"
        if prefs.is_file():
            matches.append(candidate)
    if len(matches) != 1:
        raise ValueError("app_container_missing" if not matches else "app_container_ambiguous")
    return matches[0]


def read_session(user_json: Path) -> dict:
    data = plistlib.loads(user_json.read_bytes())
    if not isinstance(data, dict):
        raise ValueError("app_session_invalid")
    token = data.get("token")
    if not isinstance(token, str) or not 8 < len(token) < 16384:
        raise ValueError("app_token_missing")
    # Preserve the App's stored percent-escaped token exactly; never unquote or normalize it.
    user_id = str(data.get("user_id", ""))
    if not user_id.isascii() or not user_id.isdigit() or len(user_id) > 20 or user_id.startswith("0"):
        user_id = None  # Listening remains available; owner takeover fails closed without a verified App identity.
    return {"source": "macos-app", "token": token, "token_len": len(token), "user_id": user_id,
            "app_version": data.get("app_version"), "exported_at": datetime.now(timezone.utc).isoformat()}


def write_private(out: Path, payload: dict) -> None:
    out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=".session-", dir=out.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False)
            stream.write("\n")
        os.replace(name, out)
    finally:
        Path(name).unlink(missing_ok=True)


# SSH destination / remote dir come from the environment. No login endpoint or credential-bearing URL.
REMOTE_SYNC = r"""
const fs=require('node:fs'), crypto=require('node:crypto');
(async()=>{
 const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
 const incoming=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(typeof incoming.token!=='string'||incoming.token.length<=8||incoming.token.length>=16384)throw Error('invalid_session');
 const dir='__REMOTE_SESSION_DIR__', file=dir+'/www-token.json';
 fs.mkdirSync(dir,{recursive:true,mode:0o770});fs.chmodSync(dir,0o770);
 let old;try{old=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
 const changed=old?.token!==incoming.token||old?.user_id!==incoming.user_id;
 if(changed){
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(incoming)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}
  finally{try{fs.unlinkSync(temp);}catch{}}
 }
 const get=async path=>(await fetch('http://127.0.0.1:8787'+path,{signal:AbortSignal.timeout(20000)})).json();
 let account=await get('/api/account/status');
 if(account.data?.state==='rejected_session'){
  console.log(JSON.stringify({ok:false,changed,state:account.data.state,errno:account.data.errno,reason:'restore_app_login_first'}));process.exitCode=2;return;
 }
 const rooms=await get('/api/rooms');
 const title=rooms.data?.mode==='official'?rooms.data?.rooms?.[0]?.title:'';
 const search=title?await get('/api/search?keyword='+encodeURIComponent(title)):null;
 const labels=rooms.data?.mode==='official'?await get('/api/labels'):null;
 account=await get('/api/account/status');
 const ok=rooms.errno===0&&rooms.data?.mode==='official'&&account.data?.state==='verified'&&
   search?.errno===0&&search.data?.mode==='official'&&labels?.data?.available===true;
 console.log(JSON.stringify({ok,changed,state:account.data?.state||'unknown',errno:account.data?.errno,
   room_mode:rooms.data?.mode||'unavailable',room_count:rooms.data?.rooms?.length||0,
   search_mode:search?.data?.mode||'unchecked',search_count:search?.data?.rooms?.length||0,label_count:labels?.data?.labels?.length||0}));
 process.exitCode=ok?0:2;
})().catch(()=>{console.log(JSON.stringify({ok:false,reason:'session_sync_or_check_failed'}));process.exitCode=1;});
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-json", type=Path)
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument("--out", type=Path)
    destination.add_argument("--sync-server", action="store_true")
    args = parser.parse_args()
    try:
        payload = read_session(args.user_json or find_user_json())
        if args.out:
            write_private(args.out, payload)
            print(json.dumps({"ok": True, "out": str(args.out), "token_len": payload["token_len"]}))
            return 0
        # shlex.quote is important: the remote command is interpreted by SSH's remote shell.
        import shlex
        ssh_host = os.environ.get("GRAVITY_SSH_HOST", "your-server-ssh-alias")
        remote_dir = os.environ.get("GRAVITY_REMOTE_SESSION_DIR", "/path/to/gravity-webui/.session")
        result = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ssh_host,
                                 "node -e " + shlex.quote(REMOTE_SYNC.replace("__REMOTE_SESSION_DIR__", remote_dir))],
                                input=json.dumps(payload), text=True, capture_output=True, timeout=80)
        summary = json.loads(result.stdout)
        safe = {key: summary[key] for key in ("ok", "changed", "state", "errno", "room_mode", "room_count", "search_mode", "search_count", "label_count", "reason") if key in summary}
        print(json.dumps(safe, ensure_ascii=False))
        return result.returncode
    except (OSError, ValueError, plistlib.InvalidFileException, subprocess.SubprocessError):
        # No raw exceptions, paths into App storage, SSH stderr or tokens in output.
        print(json.dumps({"ok": False, "reason": "app_session_export_failed"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

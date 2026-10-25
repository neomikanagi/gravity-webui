#!/usr/bin/env bash
# macOS only: synchronize an existing App login; no proxy, App restart or automated login.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
[[ "$(uname -s)" == Darwin ]] || { echo 'Run this on the Mac with GRAVITY installed.' >&2; exit 1; }
command -v uv >/dev/null || { echo 'Missing uv.' >&2; exit 1; }
exec uv run --no-project python "$ROOT/export_mac_app_session.py" --sync-server "$@"

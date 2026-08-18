#!/usr/bin/env bash
# Refresh the Fyers token. Required every trading day — it expires overnight.
#
#   ./start.sh fyers
#   ./start.sh fyers --auth-code 'PASTE_FROM_BROWSER'
set -euo pipefail
source "$(dirname "$0")/_lib.sh"
ensure_venv

if [[ "${1:-}" == "--auth-code" ]]; then
  exec "$PY" -m engine.cli fyers-auth --auth-code "${2:?paste the auth code after --auth-code}"
fi

exec "$PY" -m engine.cli fyers-auth

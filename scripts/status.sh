#!/usr/bin/env bash
# Quick health check: market hours, Fyers token, archived data.
#
#   ./start.sh status
set -euo pipefail
source "$(dirname "$0")/_lib.sh"
ensure_venv

say "Market"
"$PY" -m engine.cli status

say "Fyers token"
if "$PY" -m engine.cli probe --source fyers >/dev/null 2>&1; then
  echo "  ok"
else
  echo "  missing or expired — run: ./start.sh fyers"
fi

say "Archived data"
"$PY" -m engine.cli inventory | tail -8

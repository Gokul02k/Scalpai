#!/usr/bin/env bash
# Pull the latest candles into the local archive.
#
#   ./start.sh sync              # NIFTY 5m + India VIX (what paper needs)
#   ./start.sh sync --full       # everything the engine archives by default
set -euo pipefail
source "$(dirname "$0")/_lib.sh"
ensure_venv

if [[ "${1:-}" == "--full" ]]; then
  exec "$PY" -m engine.cli sync
fi

say "Syncing NIFTY 5m + India VIX"
"$PY" -m engine.cli sync --source fyers --symbol NIFTY --interval 5m --days 30
"$PY" -m engine.cli sync --source fyers --symbol INDIAVIX --interval 1d --days 400
echo "  done"

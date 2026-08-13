#!/usr/bin/env bash
# Run the full v2 engine verification sequence in order.
#
# Usage (from anywhere):
#   /home/gokul/Scalpai/engine/run_checks.sh
#
# Or from the repo root:
#   ./engine/run_checks.sh
#
# Skips sync if you pass --no-sync (uses whatever is already archived).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VENV="$ROOT/.venv"
PY="$VENV/bin/python"
PIP="$VENV/bin/pip"

SYNC=1
if [[ "${1:-}" == "--no-sync" ]]; then
  SYNC=0
fi

hr() { echo; echo "============================================================"; echo "  $*"; echo "============================================================"; }

hr "1/7  Python environment"
if [[ ! -x "$PY" ]]; then
  echo "Creating .venv..."
  python3 -m venv "$VENV"
  "$PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
fi
"$PIP" install -q -r engine/requirements.txt pytest
echo "OK  $($PY --version)"

hr "2/7  Market status"
"$PY" -m engine.cli status

hr "3/7  Data providers"
"$PY" -m engine.cli probe

if [[ "$SYNC" == 1 ]]; then
  hr "4/7  Sync candles (archive latest from yfinance)"
  "$PY" -m engine.cli sync
else
  hr "4/7  Sync skipped (--no-sync)"
fi

hr "5/7  Archived history"
"$PY" -m engine.cli inventory

hr "6/7  Parity + harness tests (expect 78 passed)"
"$PY" -m pytest engine/tests -q

hr "7/7  Strategy backtest + edge research"
echo
echo "--- NIFTY 5m scalp (last 60 days of 5m data) ---"
"$PY" -m engine.cli backtest --symbol NIFTY --interval 5m --show 5
echo
echo "--- NIFTY daily swing (19 years) ---"
"$PY" -m engine.cli backtest --symbol NIFTY --interval 1d --mode swing --eval-hours 720
echo
echo "--- Edge research (50 hypotheses) ---"
"$PY" -m engine.cli research --symbol NIFTY

hr "Done"
echo "  Branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
echo "  Read:   engine/README.md for what the numbers mean"
echo
echo "  Fyers (optional, for deep 5m + options):"
echo "    1. Add FYERS_* keys to .env.local"
echo "    2. python -m engine.cli fyers-auth"
echo "    3. Re-run this script"

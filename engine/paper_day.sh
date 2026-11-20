#!/usr/bin/env bash
# Start a paper trading session. Run it once, a few minutes before the open.
#
#   ./engine/paper_day.sh
#
# Checks the things that can silently ruin a session, fixes what it can, and
# stops with an instruction for what it cannot:
#
#   1. the Fyers token, which expires overnight, every night
#   2. stale candles, which make the first signals of the day wrong
#   3. a missing model file (and a warning when it is over 30 days old)
#   4. market status; before 09:15 the session waits for the open
#
# Pass --dry-run to check everything and stop before the market loop. Any other
# arguments (--force, --gate N, ...) are passed through to `engine.cli paper`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="$ROOT/.venv/bin/python"

GATE="${GATE:-16}"
DRY=0
PASS=()
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then DRY=1; else PASS+=("$arg"); fi
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

[[ -x "$PY" ]] || die "No virtualenv. Run: ./engine/run_checks.sh"

say "1/4  Fyers token"
if ! "$PY" -m engine.cli probe --source fyers >/dev/null 2>&1; then
  echo "  Token missing or expired — they last one trading day."
  echo
  "$PY" -m engine.cli fyers-auth
  die "Log in, then re-run this script with the auth code applied:
    $PY -m engine.cli fyers-auth --auth-code <PASTE>
    ./engine/paper_day.sh"
fi
echo "  ok"

say "2/4  Market data"
"$PY" -m engine.cli sync --source fyers --symbol NIFTY --interval 5m --days 30
# VIX drives both the gate and three model features, so a stale series is not
# a cosmetic problem.
"$PY" -m engine.cli sync --source fyers --symbol INDIAVIX --interval 1d --days 400

say "3/4  Signal filter"
if [[ ! -f "$ROOT/engine/var/filter.txt" ]]; then
  echo "  No model found — training one."
  "$PY" -m engine.cli train
elif [[ -n "$(find "$ROOT/engine/var/filter.txt" -mtime +30)" ]]; then
  echo "  warning: the model is over 30 days old. Retrain with:"
  echo "    $PY -m engine.cli train"
else
  echo "  ok  ($(basename "$ROOT/engine/var/filter.txt"))"
fi

say "4/4  Market status"
# Informational. It exits 1 when the year has no holiday calendar, which must
# not abort the morning: `paper` warns about that itself and carries on.
"$PY" -m engine.cli status || true

if [[ "$DRY" == "1" ]]; then
  say "Dry run — everything is ready. Start with:"
  echo "    $PY -m engine.cli paper --gate $GATE ${PASS[*]:-}"
  echo
  exit 0
fi

say "Starting paper session (gate $GATE). Ctrl-C stops and prints the summary."
exec "$PY" -m engine.cli paper --gate "$GATE" "${PASS[@]}"

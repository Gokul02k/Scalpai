#!/usr/bin/env bash
# Paper trading session. Checks token, syncs data, then runs the live loop.
#
#   ./start.sh paper              # start (or resume) today's session
#   ./start.sh paper --check      # verify everything, don't trade yet
#   GATE=18 ./start.sh paper      # stand aside above VIX 18 instead of 16
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARGS=()
for arg in "$@"; do
  [[ "$arg" == "--check" ]] && arg="--dry-run"
  ARGS+=("$arg")
done
exec "$ROOT/engine/paper_day.sh" "${ARGS[@]}"

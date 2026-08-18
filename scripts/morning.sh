#!/usr/bin/env bash
# Typical trading-day startup: dashboard + paper session.
#
#   ./start.sh morning              # paper only (run ~9:05 AM)
#   ./start.sh morning --ui         # also start the v1 dashboard in background
#   ./start.sh morning --check      # prep only, no paper loop
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

WITH_UI=0
PAPER_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --ui) WITH_UI=1 ;;
    --check) PAPER_ARGS+=(--dry-run) ;;
    *) PAPER_ARGS+=("$arg") ;;
  esac
done

ensure_venv

if [[ "$WITH_UI" == "1" ]]; then
  say "Dashboard"
  "$ROOT/run.sh"
fi

say "Paper session"
exec "$ROOT/engine/paper_day.sh" "${PAPER_ARGS[@]}"

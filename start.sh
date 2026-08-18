#!/usr/bin/env bash
# ScalpAI launcher — run everything from the repo root.
#
#   ./start.sh morning          # before 9:15: sync + paper trading
#   ./start.sh morning --ui     # same, plus v1 dashboard in background
#   ./start.sh paper            # paper session only
#   ./start.sh dashboard        # v1 dashboard only
#   ./start.sh fyers            # refresh Fyers token (daily)
#   ./start.sh sync             # pull latest candles
#   ./start.sh status           # market + token + data check
#   ./start.sh setup            # first-time install
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
CMD="${1:-help}"
shift || true

run() {
  local script="$ROOT/scripts/$1.sh"
  [[ -x "$script" ]] || { echo "Unknown command: $1" >&2; exit 1; }
  exec "$script" "$@"
}

case "$CMD" in
  morning|paper|dashboard|fyers|sync|status|setup)
    run "$CMD" "$@"
    ;;
  help|-h|--help|"")
    cat <<EOF

  ScalpAI — quick start

    ./start.sh morning          Before 9:15: auth check, sync, paper trading
    ./start.sh morning --ui     Same + v1 dashboard in background
    ./start.sh morning --check  Prep only (no paper loop)

    ./start.sh paper            Paper session (checks token + sync first)
    ./start.sh paper --check    Verify ready, don't start loop

    ./start.sh dashboard        v1 UI  (http://localhost:3000)
    ./start.sh dashboard stop   Stop background dashboard
    ./start.sh dashboard logs   Tail dashboard logs

    ./start.sh fyers            Refresh Fyers token (expires overnight)
    ./start.sh sync             Pull NIFTY 5m + VIX into local archive
    ./start.sh sync --full      Pull full default archive set

    ./start.sh status           Market hours + token + data inventory
    ./start.sh setup            First-time Python + npm setup

EOF
    ;;
  *)
    echo "Unknown command: $CMD  (try: ./start.sh help)" >&2
    exit 1
    ;;
esac

#!/usr/bin/env bash
# v1 dashboard (Next.js). Runs in the background; open the URL it prints.
#
#   ./start.sh dashboard
#   ./start.sh dashboard stop
#   ./start.sh dashboard logs
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$ROOT/run.sh" "$@"

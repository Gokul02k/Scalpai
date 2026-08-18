#!/usr/bin/env bash
# One-time setup: Python venv + npm deps.
#
#   ./start.sh setup
set -euo pipefail
source "$(dirname "$0")/_lib.sh"

say "Python environment"
ensure_venv
"$PIP" install -q -r "$ROOT/engine/requirements.txt" pytest
echo "  $($PY --version)"

say "Node dependencies"
if [[ ! -d "$ROOT/node_modules" ]]; then
  (cd "$ROOT" && npm install)
else
  echo "  node_modules already present"
fi

say "Done"
echo "  Next: ./start.sh fyers     # log in to Fyers (token expires daily)"
echo "        ./start.sh morning   # before 9:15 — sync + paper trading"

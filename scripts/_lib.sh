# Shared setup for scripts/*.sh — source this, do not run directly.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PY="$ROOT/.venv/bin/python"
PIP="$ROOT/.venv/bin/pip"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

ensure_venv() {
  if [[ -x "$PY" ]]; then
    return 0
  fi
  say "Creating Python virtualenv (first run)"
  python3 -m venv "$ROOT/.venv"
  "$PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
  "$PIP" install -q -r "$ROOT/engine/requirements.txt"
  echo "  ok"
}

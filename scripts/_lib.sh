# Shared setup for scripts/*.sh — source this, do not run directly.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PY="$ROOT/.venv/bin/python"
PIP="$ROOT/.venv/bin/pip"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

ensure_venv() {
  # The stamp is written only after a complete install, and is older than
  # requirements.txt whenever that changes. Checking for the interpreter alone
  # left a venv whose pip install failed half way broken for good.
  local stamp="$ROOT/.venv/.requirements-installed"
  if [[ -x "$PY" && -f "$stamp" && "$stamp" -nt "$ROOT/engine/requirements.txt" ]]; then
    return 0
  fi
  if [[ ! -x "$PY" ]]; then
    say "Creating Python virtualenv (first run)"
    python3 -m venv "$ROOT/.venv"
    "$PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
  else
    say "Updating Python packages"
  fi
  "$PIP" install -q -r "$ROOT/engine/requirements.txt"
  touch "$stamp"
  echo "  ok"
}

#!/usr/bin/env bash
# Start ScalpAI (Next.js) in the background and print the local + network URLs.
#
# Usage:
#   ./run.sh              # start on port 3000 (default)
#   PORT=4000 ./run.sh    # start on a custom port
#   ./run.sh stop         # stop the background server
#   ./run.sh logs         # follow the server logs
set -euo pipefail

# Always run from the project root (the folder this script lives in).
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
LOG_FILE="dev-server.log"
PID_FILE="dev-server.pid"

stop_server() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "Stopping ScalpAI (PID $(cat "$PID_FILE"))..."
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "Stopped."
  else
    echo "No running instance found."
    rm -f "$PID_FILE"
  fi
}

# Best-effort LAN IP detection (for opening the app on your phone).
detect_lan_ip() {
  local ip=""
  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  fi
  if [ -z "$ip" ] && command -v ipconfig >/dev/null 2>&1; then
    ip="$(ipconfig 2>/dev/null | grep -a 'IPv4' | grep -oE '([0-9]+\.){3}[0-9]+' | grep -vE '^127\.' | head -n1)" || true
  fi
  if [ -z "$ip" ] && command -v ifconfig >/dev/null 2>&1; then
    ip="$(ifconfig 2>/dev/null | grep -oE 'inet (addr:)?([0-9]+\.){3}[0-9]+' | grep -oE '([0-9]+\.){3}[0-9]+' | grep -vE '^127\.' | head -n1)" || true
  fi
  echo "$ip"
}

# Subcommands.
case "${1:-start}" in
  stop)  stop_server; exit 0 ;;
  logs)  tail -f "$LOG_FILE"; exit 0 ;;
esac

# Install dependencies on first run.
if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run, this can take a minute)..."
  npm install
fi

# If an instance is already running, restart it cleanly.
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "ScalpAI is already running (PID $(cat "$PID_FILE")). Restarting..."
  stop_server
  sleep 1
fi

echo "Starting ScalpAI on port $PORT..."
# -H 0.0.0.0 lets other devices on your Wi-Fi (e.g. your phone) reach it too.
nohup npm run dev -- -p "$PORT" -H 0.0.0.0 > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

# Wait for the dev server to report it is ready (up to ~40s).
echo -n "Waiting for the server to be ready"
for ((i = 1; i <= 40; i++)); do
  if grep -qE "Ready in|started server|Local:" "$LOG_FILE" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo ""
    echo "Server failed to start. Recent logs:"
    tail -n 20 "$LOG_FILE"
    exit 1
  fi
  echo -n "."
  sleep 1
done
echo ""

LAN_IP="$(detect_lan_ip)"

echo ""
echo "======================================================"
echo "  ScalpAI is running in the background"
echo "  Port:     $PORT"
echo "  Local:    http://localhost:$PORT"
if [ -n "$LAN_IP" ]; then
  echo "  Network:  http://$LAN_IP:$PORT   (open this on your phone, same Wi-Fi)"
fi
echo "  PID:      $(cat "$PID_FILE")"
echo "  Logs:     $LOG_FILE   (view with: ./run.sh logs)"
echo "  Stop:     ./run.sh stop"
echo "======================================================"

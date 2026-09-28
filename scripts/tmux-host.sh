#!/usr/bin/env bash
# Host gsearch-renderer in a detached tmux session so it survives SSH logout.
set -euo pipefail

SESSION="${TMUX_SESSION:-gsearch}"
PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${LOG_DIR:-$ROOT/logs}"
LOG_FILE="$LOG_DIR/server.log"

usage() {
  cat <<EOF
Usage: $(basename "$0") [start|stop|restart|status|attach|logs]

  start    Create detached tmux session and run node server.js
  stop     Stop the API and kill the tmux session
  restart  stop then start
  status   Show session / listen port
  attach   Attach to the session (detach with Ctrl-b d)
  logs     Tail server.log

Env: PORT ($PORT) HOST ($HOST) TMUX_SESSION ($SESSION) PROXY_FETCH (default 1)
EOF
}

need_tmux() {
  if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux is not installed. Debian/Ubuntu: sudo apt-get install -y tmux" >&2
    exit 1
  fi
}

session_alive() {
  tmux has-session -t "$SESSION" 2>/dev/null
}

do_start() {
  need_tmux
  if session_alive; then
    echo "tmux session '$SESSION' already running"
    do_status
    return 0
  fi
  mkdir -p "$LOG_DIR"
  if [ ! -d "$ROOT/node_modules" ]; then
    (cd "$ROOT" && npm install)
  fi
  export PORT HOST
  export PROXY_FETCH="${PROXY_FETCH:-1}"
  export NODE_ENV="${NODE_ENV:-production}"
  unset PROXY_POOL
  tmux new-session -d -s "$SESSION" -c "$ROOT" \
    "exec node server.js 2>&1 | tee -a '$LOG_FILE'"
  sleep 1
  if ! session_alive; then
    echo "failed to start tmux session '$SESSION'" >&2
    exit 1
  fi
  echo "started tmux session '$SESSION' -> http://${HOST}:${PORT}"
  echo "detach later with Ctrl-b d; stop with: $0 stop"
}

do_stop() {
  need_tmux
  if ! session_alive; then
    echo "tmux session '$SESSION' is not running"
    return 0
  fi
  tmux send-keys -t "$SESSION" C-c 2>/dev/null || true
  sleep 1
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  echo "stopped tmux session '$SESSION'"
}

do_status() {
  need_tmux
  if session_alive; then
    echo "session: $SESSION (running)"
    tmux list-sessions | grep "^${SESSION}:" || true
  else
    echo "session: $SESSION (stopped)"
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp 2>/dev/null | grep ":${PORT} " || true
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -sS --max-time 5 "http://127.0.0.1:${PORT}/api/health" || true
    echo
  fi
}

do_attach() {
  need_tmux
  if ! session_alive; then
    echo "session '$SESSION' is not running; start first" >&2
    exit 1
  fi
  exec tmux attach -t "$SESSION"
}

do_logs() {
  mkdir -p "$LOG_DIR"
  touch "$LOG_FILE"
  exec tail -n 100 "$LOG_FILE"
}

cmd="${1:-start}"
case "$cmd" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status) do_status ;;
  attach) do_attach ;;
  logs) do_logs ;;
  -h|--help|help) usage ;;
  *) usage; exit 1 ;;
esac

#!/usr/bin/env bash
# Start agent-runtime from its own virtualenv, creating it on first run.
set -euo pipefail
cd "$(dirname "$0")/../apps/agent-runtime"

PORT="${AGENT_RUNTIME_PORT:-5055}"

# Fail before uvicorn. Its reload parent only prints "Will watch for changes"
# and then "[Errno 48] Address already in use", which hides the usual cause:
# `pnpm dev` already started this same process.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$PORT" <<'PY' && port_status=0 || port_status=$?
import errno, socket, sys
port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
# uvicorn binds with SO_REUSEADDR, so a port left in TIME_WAIT by the last run is free for it.
# Match that, or a quick restart is refused here. (On Windows the flag would allow stealing a live port.)
if sys.platform != "win32":
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    sock.bind(("127.0.0.1", port))
except OSError as exc:
    # 48 macOS, 98 Linux, 10048 Windows. errno.EADDRINUSE covers the host.
    if exc.errno in (errno.EADDRINUSE, 48, 98, 10048):
        sys.exit(2)
    raise
finally:
    sock.close()
PY
  if [ "$port_status" -eq 2 ]; then
    cat >&2 <<EOF
agent-runtime cannot start: 127.0.0.1:${PORT} is already in use.

pnpm dev already starts this process, together with the website (:3000)
and the API (:4000). A second pnpm dev:agent binds the same port and
exits with [Errno 48] Address already in use.

If this prints {"ok":true,"service":"agent-runtime"}, the agent is already running:
  curl -s http://127.0.0.1:${PORT}/health

To start a fresh one, stop pnpm dev (Ctrl+C). The Python reloader sometimes
keeps the port after that. On a Mac:
  lsof -nP -iTCP:${PORT} -sTCP:LISTEN
  kill <PID>
Then run either pnpm dev or pnpm dev:agent, not both.
EOF
    exit 1
  elif [ "$port_status" -ne 0 ]; then
    echo "agent-runtime could not check whether port ${PORT} is free (python exited ${port_status})." >&2
    exit "$port_status"
  fi
fi

if [ ! -x .venv/bin/python ]; then
  PY=""
  for candidate in python3.13 python3.12 python3.11 "$HOME/miniconda3/bin/python3" python3; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
      PY="$candidate"
      break
    fi
  done
  if [ -z "$PY" ]; then
    echo "agent-runtime needs Python 3.11 or newer. Install it (brew install python@3.12) and run again." >&2
    exit 1
  fi
  "$PY" -m venv .venv
  .venv/bin/pip install -q -e .
fi

exec .venv/bin/python -m ensemble_agent.main

#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH"
ok=0
fail=0
check() {
  if eval "$1" >/dev/null 2>&1; then
    echo "ok   $2"
    ok=$((ok + 1))
  else
    echo "fail $2"
    fail=$((fail + 1))
  fi
}
check "node -v | grep -q v22" "node 22"
check "pnpm -v" "pnpm"
check "python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'" "python >= 3.11"
check "docker info" "docker daemon"
check "docker compose version" "docker compose"
if [[ -f .env ]]; then echo "ok   .env"; ok=$((ok+1)); else echo "fail .env (copy .env.example)"; fail=$((fail+1)); fi
echo "$ok passed, $fail failed"
exit "$fail"

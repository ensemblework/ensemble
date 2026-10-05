#!/usr/bin/env bash
# Exit 0 only when hub-api answers 200 on /health/ready.
# The body has no connection strings. On failure it is printed.
set -euo pipefail

url="${ENSEMBLE_READY_URL:-http://127.0.0.1:4000/health/ready}"
tries="${ENSEMBLE_READY_TRIES:-90}"
body="$(mktemp)"
trap 'rm -f "$body"' EXIT

echo "Waiting for ${url}"
i=1
while [ "$i" -le "$tries" ]; do
  code="$(curl -sS -o "$body" -w '%{http_code}' --max-time 5 "$url" || true)"
  if [ "$code" = "200" ]; then
    echo "ready: 200"
    exit 0
  fi
  sleep 1
  i=$((i + 1))
done

echo "ready check failed (last HTTP status: ${code:-none})." >&2
if [ -s "$body" ]; then
  cat "$body" >&2
  echo >&2
fi
exit 1

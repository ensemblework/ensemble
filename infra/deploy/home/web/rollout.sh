#!/usr/bin/env bash
# Replace the Hub container on the home server.
#   rollout.sh ghcr.io/owner/repo/hub-web:sha
#   rollout.sh --rollback
# Reads ~/ensemble-host/ensemble.env for the cookie settings and HUB_WEB_PORT.
# A GitHub token for pulling the image stays in ~/ensemble-host/ghcr.token (mode 0600),
# with GHCR_USERNAME in the env file. The token is not passed to the container.
set -euo pipefail

ENSEMBLE_HOME_DIR="${ENSEMBLE_HOME_DIR:-$HOME/ensemble-host}"
ENV_FILE="${ENSEMBLE_ENV_FILE:-$ENSEMBLE_HOME_DIR/ensemble.env}"
LOG="$ENSEMBLE_HOME_DIR/logs/web-deploy.log"
LIVE_NAME=ensemble-hub-web
CANARY_NAME=ensemble-hub-web-canary
LIVE_PORT="${HUB_WEB_PORT:-3000}"
CANARY_PORT="${HUB_WEB_CANARY_PORT:-3001}"

mkdir -p "$ENSEMBLE_HOME_DIR/logs"
log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }

read_env() {
  python3 - "$1" "$ENV_FILE" <<'PY'
import sys
key, path = sys.argv[1], sys.argv[2]
value = ""
try:
    lines = open(path, encoding="utf-8")
except FileNotFoundError:
    sys.exit(0)
for raw in lines:
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    name, rest = line.split("=", 1)
    if name.strip() == key:
        value = rest.strip().strip('"').strip("'")
print(value, end="")
PY
}

file_port="$(read_env HUB_WEB_PORT)"
file_canary="$(read_env HUB_WEB_CANARY_PORT)"
if [ -n "$file_port" ]; then LIVE_PORT="$file_port"; fi
if [ -n "$file_canary" ]; then CANARY_PORT="$file_canary"; fi
COOKIE_DOMAIN="$(read_env ENSEMBLE_COOKIE_DOMAIN)"
COOKIE_NAMESPACE="$(read_env ENSEMBLE_COOKIE_NAMESPACE)"

run_container() {
  local name="$1" port="$2" restart="$3"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d \
    --name "$name" \
    --network host \
    --restart "$restart" \
    -e NODE_ENV=production \
    -e ENSEMBLE_PUBLIC_HOST=1 \
    -e PORT="$port" \
    -e ENSEMBLE_COOKIE_DOMAIN="$COOKIE_DOMAIN" \
    -e ENSEMBLE_COOKIE_NAMESPACE="$COOKIE_NAMESPACE" \
    ensemble-hub-web:live >/dev/null
}

wait_health() {
  local port="$1" i
  for i in $(seq 1 40); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${port}/healthz" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restore_previous() {
  if docker image inspect ensemble-hub-web:previous >/dev/null 2>&1; then
    docker tag ensemble-hub-web:previous ensemble-hub-web:live
    run_container "$LIVE_NAME" "$LIVE_PORT" unless-stopped || true
    if wait_health "$LIVE_PORT"; then
      log "previous image is serving port $LIVE_PORT"
      return 0
    fi
  fi
  log "rollback did not become healthy. docker logs $LIVE_NAME"
  return 1
}

if [ "${1:-}" = "--rollback" ]; then
  log "rollback requested"
  if ! docker image inspect ensemble-hub-web:previous >/dev/null 2>&1; then
    log "no previous image is tagged"
    exit 1
  fi
  restore_previous
  exit $?
fi

IMAGE="${1:?image reference, or --rollback}"
token_file="$ENSEMBLE_HOME_DIR/ghcr.token"
if [ -f "$token_file" ]; then
  ghcr_user="$(read_env GHCR_USERNAME)"
  if [ -z "$ghcr_user" ]; then
    log "GHCR_USERNAME is empty in $ENV_FILE"
    exit 1
  fi
  docker login ghcr.io -u "$ghcr_user" --password-stdin <"$token_file" >/dev/null
fi

if docker image inspect ensemble-hub-web:live >/dev/null 2>&1; then
  docker tag ensemble-hub-web:live ensemble-hub-web:previous
fi
log "pulling $IMAGE"
docker pull "$IMAGE" >>"$LOG"
docker tag "$IMAGE" ensemble-hub-web:live

log "canary on 127.0.0.1:$CANARY_PORT"
if ! run_container "$CANARY_NAME" "$CANARY_PORT" no || ! wait_health "$CANARY_PORT"; then
  log "canary failed. the Hub on port $LIVE_PORT was left running"
  docker logs "$CANARY_NAME" >>"$LOG" 2>&1 || true
  docker rm -f "$CANARY_NAME" >/dev/null 2>&1 || true
  if docker image inspect ensemble-hub-web:previous >/dev/null 2>&1; then
    docker tag ensemble-hub-web:previous ensemble-hub-web:live
  fi
  exit 1
fi

log "canary healthy. switching port $LIVE_PORT"
docker rm -f "$CANARY_NAME" >/dev/null 2>&1 || true
if ! run_container "$LIVE_NAME" "$LIVE_PORT" unless-stopped || ! wait_health "$LIVE_PORT"; then
  log "new container failed health on port $LIVE_PORT"
  docker logs "$LIVE_NAME" >>"$LOG" 2>&1 || true
  restore_previous || exit 1
  exit 1
fi
log "Hub is serving $IMAGE on 127.0.0.1:$LIVE_PORT"

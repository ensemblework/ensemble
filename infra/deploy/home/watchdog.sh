#!/usr/bin/env bash
# Brings back whatever part of the home-server API is down. Cron runs the copy in
# ~/ensemble-host/bin every 15 minutes, and once a minute after boot (setup.sh installs both lines):
#   1. Postgres, Redis and the tunnel: `docker compose up -d` starts any container that stopped.
#   2. The API, the agent and the two timers: started when they are not active.
#   3. Loopback /health/ready: when it is not 200 for a minute, the agent and the API restart.
#   4. HUB_API_PUBLIC_URL/health: when loopback is ready, the internet is reachable and the public
#      URL still fails, the tunnel container restarts.
# It waits for a running deploy to finish first. Log: ~/ensemble-host/logs/watchdog.log.
set -uo pipefail

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -f "$DIR/home-lib.sh" ]; then
  # shellcheck source=lib.sh
  . "$DIR/home-lib.sh"
else
  # shellcheck source=lib.sh
  . "$DIR/lib.sh"
fi
READY_CHECK="$DIR/ready-check.sh"
[ -f "$READY_CHECK" ] || READY_CHECK="$DIR/../ready-check.sh"

refuse_root
home_path
user_bus
mkdir -p "$ENSEMBLE_HOME_DIR/logs"
LOG="$ENSEMBLE_HOME_DIR/logs/watchdog.log"
log() { printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG"; }

exec 9>"$LOCK_FILE"
if ! flock -w 900 9; then
  log "a deploy held the lock for 15 minutes; skipped this check"
  exit 0
fi
if ! load_home_env >>"$LOG" 2>&1; then
  log "could not load $HOME_ENV_FILE"
  exit 1
fi
[ "${1:-}" = "--boot" ] && log "boot check"

if ! docker info >/dev/null 2>&1; then
  log "docker is not reachable; containers cannot be checked (sudo systemctl start docker)"
elif ! home_compose up -d >>"$LOG" 2>&1; then
  log "docker compose up failed"
elif observability_installed && ! obs_compose up -d >>"$LOG" 2>&1; then
  log "monitoring: docker compose up failed"
fi

units=(ensemble-agent.service ensemble-api.service ensemble-autodeploy.timer ensemble-pg-backup.timer)
observability_installed && units+=(ensemble-azure-metrics.timer)
for unit in "${units[@]}"; do
  if ! systemctl --user is-active --quiet "$unit"; then
    log "$unit was $(systemctl --user is-active "$unit" 2>/dev/null); starting it"
    systemctl --user start "$unit" >>"$LOG" 2>&1 || log "could not start $unit"
  fi
done

ready() { curl -fsS -o /dev/null --max-time 5 "$(ready_url)" 2>/dev/null; }
up=false
for _ in $(seq 1 12); do
  if ready; then up=true; break; fi
  sleep 5
done
if ! $up; then
  log "/health/ready was not 200 for a minute; restarting the agent and the API"
  systemctl --user restart ensemble-agent.service ensemble-api.service >>"$LOG" 2>&1
  if ENSEMBLE_READY_URL="$(ready_url)" ENSEMBLE_READY_TRIES=180 bash "$READY_CHECK" >>"$LOG" 2>&1; then
    log "ready after the restart"
    up=true
  else
    log "still not ready after the restart: journalctl --user -u ensemble-api -u ensemble-agent"
  fi
fi

public="${HUB_API_PUBLIC_URL%/}/health"
if $up && ! curl -fsS -o /dev/null --max-time 15 "$public" 2>/dev/null; then
  if curl -fsS -o /dev/null --max-time 10 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null; then
    log "$public failed while loopback is ready; restarting the tunnel"
    docker restart ensemble-home-cloudflared >>"$LOG" 2>&1 || log "could not restart the tunnel"
  else
    log "the internet is not reachable from this machine"
  fi
fi

if [ "$(wc -l <"$LOG")" -gt 5000 ]; then
  tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
exit 0

#!/usr/bin/env bash
# The operator's monitoring on the home server (docs/07 §1.3), after infra/deploy/home/setup.sh.
# Safe to run again. As the machine user, not root:
#
#   bash ~/ensemble-host/app/infra/deploy/home/observability/setup.sh
#
# It writes ~/ensemble-host/observability.env (Grafana's admin password and its read-only database
# password, mode 0600), turns on hub-api's loopback metrics (ENSEMBLE_METRICS_PORT=14090), creates the
# analytics views and the ensemble_grafana role, builds the dashboards, starts Prometheus, Grafana,
# node-exporter and postgres-exporter, and installs the Azure cost/storage timer. From then on
# update.sh refreshes the views and dashboards on every deploy and the watchdog keeps them running.
# Grafana: http://127.0.0.1:3300 here; on your Tailscale devices through `tailscale serve` (below).
set -euo pipefail

main() {
  local dir
  dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # shellcheck source=../lib.sh
  . "$dir/../lib.sh"
  refuse_root
  home_path
  user_bus
  load_home_env

  local secrets="$ENSEMBLE_HOME_DIR/observability.env"
  umask 077
  if [ ! -f "$secrets" ]; then
    printf 'GRAFANA_ADMIN_PASSWORD=%s\nGRAFANA_DB_PASSWORD=%s\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 24)" >"$secrets"
    echo "Wrote $secrets. Grafana's admin password is in it."
  fi
  umask 022
  if ! grep -q '^ENSEMBLE_METRICS_PORT=' "$HOME_ENV_FILE"; then
    printf '\n# Loopback Prometheus metrics for the operator (infra/deploy/home/observability).\nENSEMBLE_METRICS_PORT=14090\n' >>"$HOME_ENV_FILE"
    systemctl --user restart ensemble-api.service
  fi

  refresh_observability
  systemctl --user daemon-reload
  systemctl --user enable --now --quiet ensemble-azure-metrics.timer
  systemctl --user start --no-block ensemble-azure-metrics.service

  local name
  name="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
  if [ -n "$name" ] && tailscale serve --bg --https=443 http://127.0.0.1:3300 >/dev/null 2>&1; then
    echo "Grafana on your Tailscale devices: https://$name/"
  else
    echo "Grafana is on http://127.0.0.1:3300. For your other devices, turn on Tailscale Serve for the tailnet, then:"
    echo "  tailscale serve --bg --https=443 http://127.0.0.1:3300"
  fi
  echo "Sign in as admin with GRAFANA_ADMIN_PASSWORD from $secrets."
}

main "$@"
exit

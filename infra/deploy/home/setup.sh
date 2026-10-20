#!/usr/bin/env bash
# First install of the API on one home machine, as that machine's own user (no root):
#   ~/ensemble-host/app       checkout of ENSEMBLE_DEPLOY_BRANCH; cloned when missing
#   Postgres, Redis, tunnel   Docker containers from compose.yml in this folder
#   API, agent, timers        systemd user units; they start at boot because lingering is on
#   watchdog.sh               cron, every 15 minutes and once after boot
# The website stays on Vercel. The tunnel carries HUB_API_PUBLIC_URL's host to the API, so the
# machine needs no open port, router rule or fixed IP, and can change networks.
#
# Before running:
#   1. Docker usable without sudo, `loginctl show-user "$USER" -p Linger` says yes
#      (sudo loginctl enable-linger "$USER"), and uv (https://docs.astral.sh/uv/) on PATH.
#   2. ~/ensemble-host/ensemble.env, mode 0600, from infra/deploy/ensemble.env.example. The
#      "Home server" block at the end of that file lists the lines that differ from the VM.
#   3. A Cloudflare tunnel for the API host:
#        cloudflared tunnel login
#        cloudflared tunnel create ensemble-home
#        cp ~/.cloudflared/<tunnel id>.json ~/ensemble-host/cloudflared/
#        cloudflared tunnel route dns --overwrite-dns ensemble-home <the API host>
#      and ENSEMBLE_TUNNEL_ID=<tunnel id> in the env file.
#
#   bash infra/deploy/home/setup.sh     (safe to run again)
set -euo pipefail

main() {
  local dir
  dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # shellcheck source=lib.sh
  . "$dir/lib.sh"
  refuse_root
  home_path
  user_bus

  local tool
  for tool in docker git curl python3 flock crontab uv systemctl; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "$tool is not installed or not on PATH." >&2
      exit 1
    fi
  done
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not usable by $(id -un). Add the user to the docker group and log in again." >&2
    exit 1
  fi
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != "yes" ]; then
    echo "Lingering is off, so the user units would not start at boot: sudo loginctl enable-linger $(id -un)" >&2
    exit 1
  fi
  command -v az >/dev/null 2>&1 || echo "Note: the Azure CLI (az) is missing; nightly backups will stay on this machine."

  mkdir -p "$ENSEMBLE_HOME_DIR"/{state/workspace,state/remote,cache/matplotlib,backups,logs,cloudflared,bin}
  chmod 0700 "$ENSEMBLE_HOME_DIR" "$ENSEMBLE_HOME_DIR/cloudflared" "$ENSEMBLE_HOME_DIR/backups"
  if [ ! -f "$HOME_ENV_FILE" ]; then
    echo "Create $HOME_ENV_FILE from infra/deploy/ensemble.env.example first (its Home server block)." >&2
    exit 1
  fi
  chmod 0600 "$HOME_ENV_FILE"
  load_home_env
  if [ -z "${ENSEMBLE_TUNNEL_ID:-}" ] || [ ! -f "$ENSEMBLE_HOME_DIR/cloudflared/$ENSEMBLE_TUNNEL_ID.json" ]; then
    echo "Set ENSEMBLE_TUNNEL_ID and copy the tunnel's <id>.json into $ENSEMBLE_HOME_DIR/cloudflared/." >&2
    exit 1
  fi
  chmod 0600 "$ENSEMBLE_HOME_DIR/cloudflared/$ENSEMBLE_TUNNEL_ID.json"

  local branch
  branch="$(deploy_branch)"
  if [ ! -d "$APP/.git" ]; then
    git clone --quiet --branch "$branch" "${ENSEMBLE_REPO_URL:-https://github.com/ensemblework/ensemble.git}" "$APP"
  fi

  write_tunnel_config
  # A running tunnel reads config.yml only when it starts.
  docker restart ensemble-home-cloudflared >/dev/null 2>&1 || true
  ensure_node
  bash "$APP/infra/deploy/home/update.sh"
  install_crontab
  echo "Installed. Cron runs $ENSEMBLE_HOME_DIR/bin/watchdog.sh every 15 minutes and after boot."
  echo "Check: curl -s ${HUB_API_PUBLIC_URL%/}/health"
}

# One ingress rule per host: HUB_API_PUBLIC_URL's, then any in ENSEMBLE_TUNNEL_EXTRA_HOSTS
# (space-separated, for checking a new machine before the main record moves to it).
write_tunnel_config() {
  local api_host host config="$ENSEMBLE_HOME_DIR/cloudflared/config.yml"
  api_host="$(python3 -c 'import os, urllib.parse; print(urllib.parse.urlparse(os.environ["HUB_API_PUBLIC_URL"]).hostname)')"
  {
    printf 'tunnel: %s\n' "$ENSEMBLE_TUNNEL_ID"
    printf 'credentials-file: /etc/cloudflared/%s.json\n' "$ENSEMBLE_TUNNEL_ID"
    printf 'ingress:\n'
    for host in $api_host ${ENSEMBLE_TUNNEL_EXTRA_HOSTS:-}; do
      printf '  - hostname: %s\n    service: http://127.0.0.1:%s\n' "$host" "$HUB_API_PORT"
    done
    printf '  - service: http_status:404\n'
  } >"$config.tmp"
  chmod 0600 "$config.tmp"
  mv "$config.tmp" "$config"
}

main "$@"
exit

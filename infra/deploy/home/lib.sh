# Shared by the scripts in infra/deploy/home: the API on one home machine, run as that machine's
# own user. No root, nothing under /opt or /etc. Everything lives in ~/ensemble-host:
#   app/              git checkout of ENSEMBLE_DEPLOY_BRANCH (production)
#   ensemble.env      settings, mode 0600, from infra/deploy/ensemble.env.example (see its home block)
#   ensemble.commit   ENSEMBLE_COMMIT=<sha>; the API unit reads it so /health reports the commit
#   node/             Node 22 and pnpm for the services, apart from any Node used for development
#   cloudflared/      config.yml (written by setup.sh) and the tunnel's <id>.json credentials
#   state/, cache/    workspace, paired-computer state, matplotlib cache, autodeploy.failed
#   backups/          nightly dumps, seven kept here; copies go to the blob backup container
#   logs/             watchdog.log, backup.log
#   bin/              copies of watchdog.sh and the files it sources, so cron never runs half a deploy
# shellcheck shell=bash

HOME_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# load_env_file, deploy_branch, require_database_url. bin/ holds a copy named deploy-lib.sh.
if [ -f "$HOME_LIB_DIR/deploy-lib.sh" ]; then
  # shellcheck source=../lib.sh
  . "$HOME_LIB_DIR/deploy-lib.sh"
else
  # shellcheck source=../lib.sh
  . "$HOME_LIB_DIR/../lib.sh"
fi

ENSEMBLE_HOME_DIR="${ENSEMBLE_HOME_DIR:-$HOME/ensemble-host}"
APP="$ENSEMBLE_HOME_DIR/app"
HOME_ENV_FILE="${ENSEMBLE_ENV_FILE:-$ENSEMBLE_HOME_DIR/ensemble.env}"
COMPOSE_FILE="$APP/infra/deploy/home/compose.yml"
NODE_MAJOR=22

refuse_root() {
  if [ "$(id -u)" -eq 0 ]; then
    echo "Run this as the user that owns ~/ensemble-host, not as root." >&2
    exit 1
  fi
}

home_path() {
  export PATH="$ENSEMBLE_HOME_DIR/node/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
}

# systemctl --user from cron, timers and shells outside a login session.
user_bus() {
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
  # Held by autodeploy.sh, update.sh and watchdog.sh, so a check never restarts a deploy halfway.
  export LOCK_FILE="$XDG_RUNTIME_DIR/ensemble-deploy.lock"
}

app_git() {
  git -C "$APP" "$@"
}

# Loads the env file and exports what compose.yml reads. Prints no values.
load_home_env() {
  load_env_file "$HOME_ENV_FILE"
  require_database_url
  local name
  for name in HUB_API_PORT AGENT_RUNTIME_PORT HUB_API_PUBLIC_URL REDIS_URL; do
    if [ -z "${!name:-}" ]; then
      echo "$name is empty in $HOME_ENV_FILE." >&2
      return 1
    fi
  done
  local derived
  derived="$(python3 - <<'PY'
import os, shlex, sys
from urllib.parse import unquote, urlparse
db = urlparse(os.environ["DATABASE_URL"])
redis = urlparse(os.environ["REDIS_URL"])
if db.hostname not in ("127.0.0.1", "localhost") or redis.hostname not in ("127.0.0.1", "localhost"):
    sys.exit("DATABASE_URL and REDIS_URL must point at 127.0.0.1 on the home server. The values were not printed.")
if not redis.password:
    sys.exit("REDIS_URL needs a password (redis://:PASSWORD@127.0.0.1:PORT). The value was not printed.")
print(f"ENSEMBLE_HOME_PG_PORT={db.port or 5432}")
print(f"ENSEMBLE_HOME_REDIS_PORT={redis.port or 6379}")
print(f"ENSEMBLE_REDIS_PASSWORD={shlex.quote(unquote(redis.password))}")
PY
)" || return 1
  eval "$derived"
  ENSEMBLE_HOME_UID="$(id -u)"
  ENSEMBLE_HOME_GID="$(id -g)"
  export ENSEMBLE_HOME_DIR ENSEMBLE_HOME_PG_PORT ENSEMBLE_HOME_REDIS_PORT ENSEMBLE_REDIS_PASSWORD ENSEMBLE_HOME_UID ENSEMBLE_HOME_GID
}

home_compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

wait_postgres() {
  local _
  for _ in $(seq 1 60); do
    if docker exec ensemble-home-postgres pg_isready -U ensemble -d ensemble >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "Postgres (ensemble-home-postgres) did not become ready." >&2
  return 1
}

ready_url() {
  printf 'http://127.0.0.1:%s/health/ready\n' "$HUB_API_PORT"
}

home_commit_file() {
  printf 'ENSEMBLE_COMMIT=%s\n' "$(app_git rev-parse HEAD)" >"$ENSEMBLE_HOME_DIR/ensemble.commit"
}

# Node 22 from nodejs.org, checked against its SHASUMS256.txt, then the pnpm in package.json.
ensure_node() {
  local have="" arch tmp base name
  if [ -x "$ENSEMBLE_HOME_DIR/node/bin/node" ]; then
    have="$("$ENSEMBLE_HOME_DIR/node/bin/node" -p 'process.versions.node.split(".")[0]')"
  fi
  if [ "$have" != "$NODE_MAJOR" ]; then
    case "$(uname -m)" in
      x86_64) arch=x64 ;;
      aarch64 | arm64) arch=arm64 ;;
      *) echo "No Node build for $(uname -m)." >&2; return 1 ;;
    esac
    tmp="$(mktemp -d)"
    base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
    curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
    name="$(grep -oE "node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-linux-${arch}\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
    curl -fsSL "$base/$name" -o "$tmp/$name"
    (cd "$tmp" && grep "  $name\$" SHASUMS256.txt | sha256sum -c --quiet -)
    rm -rf "$ENSEMBLE_HOME_DIR/node.new"
    mkdir -p "$ENSEMBLE_HOME_DIR/node.new"
    tar -xJf "$tmp/$name" -C "$ENSEMBLE_HOME_DIR/node.new" --strip-components=1
    rm -rf "$ENSEMBLE_HOME_DIR/node" "$tmp"
    mv "$ENSEMBLE_HOME_DIR/node.new" "$ENSEMBLE_HOME_DIR/node"
    echo "Installed $("$ENSEMBLE_HOME_DIR/node/bin/node" -v) in $ENSEMBLE_HOME_DIR/node."
  fi
  local want
  want="$("$ENSEMBLE_HOME_DIR/node/bin/node" -p 'require(process.argv[1]).packageManager.split("@")[1]' "$APP/package.json")"
  if [ "$("$ENSEMBLE_HOME_DIR/node/bin/pnpm" -v 2>/dev/null || true)" != "$want" ]; then
    "$ENSEMBLE_HOME_DIR/node/bin/npm" install -g --silent --prefix "$ENSEMBLE_HOME_DIR/node" "pnpm@$want"
  fi
}

# The agent's Python 3.12 virtualenv, made with uv (it downloads 3.12 when the system has another).
ensure_agent_venv() {
  local venv="$APP/apps/agent-runtime/.venv"
  if ! "$venv/bin/python" -c 'import sys; sys.exit(sys.version_info[:2] != (3, 12))' 2>/dev/null; then
    rm -rf "$venv"
    uv venv --quiet --python 3.12 "$venv"
  fi
  uv pip install --quiet --python "$venv/bin/python" -e "$APP/apps/agent-runtime"
  "$venv/bin/python" -c 'import psycopg, cryptography, numpy, pandas, pyarrow, matplotlib, scipy; print("wheels ok")'
}

# User units, and the files cron runs, copied out of the checkout.
install_units() {
  local unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir" "$ENSEMBLE_HOME_DIR/bin"
  install -m 0644 "$APP"/infra/deploy/home/systemd/*.service "$APP"/infra/deploy/home/systemd/*.timer "$unit_dir/"
  install -m 0755 "$APP/infra/deploy/home/watchdog.sh" "$ENSEMBLE_HOME_DIR/bin/watchdog.sh"
  install -m 0644 "$APP/infra/deploy/home/lib.sh" "$ENSEMBLE_HOME_DIR/bin/home-lib.sh"
  install -m 0644 "$APP/infra/deploy/lib.sh" "$ENSEMBLE_HOME_DIR/bin/deploy-lib.sh"
  install -m 0755 "$APP/infra/deploy/ready-check.sh" "$ENSEMBLE_HOME_DIR/bin/ready-check.sh"
  systemctl --user daemon-reload
  systemctl --user enable --quiet ensemble-api.service ensemble-agent.service
  systemctl --user enable --now --quiet ensemble-autodeploy.timer ensemble-pg-backup.timer
}

# Every 15 minutes and once at boot. Replaces only the lines tagged "# ensemble-home".
install_crontab() {
  local watchdog="$ENSEMBLE_HOME_DIR/bin/watchdog.sh" current
  current="$(crontab -l 2>/dev/null | grep -v '# ensemble-home$' || true)"
  {
    if [ -n "$current" ]; then printf '%s\n' "$current"; fi
    printf '*/15 * * * * /bin/bash %s >/dev/null 2>&1 # ensemble-home\n' "$watchdog"
    printf '@reboot sleep 60 && /bin/bash %s --boot >/dev/null 2>&1 # ensemble-home\n' "$watchdog"
  } | crontab -
}

# ── Monitoring (observability/, docs/07 §1.3) ───────────────────────────────
OBS_SECRETS="$ENSEMBLE_HOME_DIR/observability.env"

observability_installed() {
  [ -f "$OBS_SECRETS" ]
}

obs_compose() {
  (
    set -a
    # shellcheck disable=SC1090
    . "$OBS_SECRETS"
    set +a
    export ENSEMBLE_OBS_DIR="$ENSEMBLE_HOME_DIR/observability"
    docker compose -f "$APP/infra/deploy/home/observability/compose.yml" "$@"
  )
}

# The analytics views would block a migration that changes a column they read: drop them first.
drop_analytics_views() {
  observability_installed || return 0
  docker exec ensemble-home-postgres psql -q -U ensemble -d ensemble -c 'DROP SCHEMA IF EXISTS analytics CASCADE' >/dev/null
}

# Views and read-only role, dashboards, units, then the containers. After migrations.
refresh_observability() {
  observability_installed || return 0
  local obs="$APP/infra/deploy/home/observability" password
  password="$(sed -n 's/^GRAFANA_DB_PASSWORD=//p' "$OBS_SECRETS")"
  local output
  # A broken view must not stop a deploy: the app is fine, only a dashboard panel is not.
  if ! output="$(docker exec -i ensemble-home-postgres psql -q -U ensemble -d ensemble -v reader_password="$password" <"$obs/analytics.sql" 2>&1)"; then
    echo "WARNING: the analytics views did not apply; dashboards that read the database are empty until fixed:" >&2
    printf '%s\n' "$output" | grep -v -e '^NOTICE' -e '^DETAIL' -e '^drop cascades' >&2
  fi
  mkdir -p "$ENSEMBLE_HOME_DIR/observability/textfile"
  "$ENSEMBLE_HOME_DIR/node/bin/node" "$obs/build-dashboards.mjs" "$ENSEMBLE_HOME_DIR/observability/dashboards" >/dev/null
  install -m 0644 "$obs"/systemd/*.service "$obs"/systemd/*.timer "$HOME/.config/systemd/user/"
  obs_compose up -d --remove-orphans
}

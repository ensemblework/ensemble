#!/usr/bin/env bash
# Install one personal Ensemble on Ubuntu 24.04 (arm64 or amd64).
# Root, non-interactive, safe to run twice. Does not print secrets. The only change it
# makes to the env file is filling in REDIS_URL for local Redis, and only when that
# value is blank or still the example placeholder.
#
#   sudo bash infra/deploy/setup.sh /etc/ensemble.env
#   sudo bash infra/deploy/setup.sh /etc/ensemble.env --no-local-postgres
#   sudo bash infra/deploy/setup.sh /etc/ensemble.env --no-local-redis
#   sudo ENSEMBLE_ENV_FILE=/etc/ensemble.env bash infra/deploy/setup.sh --skip-systemd
#   sudo bash infra/deploy/setup.sh --bootstrap
#
# --local-postgres is the default: Docker Postgres on 127.0.0.1:5432.
# --no-local-postgres skips Docker. Point DATABASE_URL at Supabase (or any Postgres).
# --local-redis is the default: Ubuntu redis-server on 127.0.0.1:6379.
# --no-local-redis skips that package. Point REDIS_URL at Upstash (rediss://).
# ENSEMBLE_LOCAL_REDIS=0 is the same as --no-local-redis.
# --skip-systemd skips systemd so the script can run in a container.
#   In that mode the API and the agent are started by hand, then /health/ready is checked.
# --bootstrap only creates the ensemble user and a read-only GitHub deploy key, then exits.
# --host-firewall writes iptables ACCEPT rules. The default changes no host firewall.
#
# The cloud firewall (Azure NSG, or an Oracle security list) is the primary one.
# This script does not enable ufw and does not call Azure, Oracle, or a metadata service.
# Oracle is detected from DMI (chassis_asset_tag), overridable with ENSEMBLE_CHASSIS_ASSET_TAG.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export APT_LISTCHANGES_FRONTEND=none
export NEEDRESTART_MODE=a
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ENV_FILE="${ENSEMBLE_ENV_FILE:-}"
SKIP_SYSTEMD=0
LOCAL_POSTGRES=1
LOCAL_REDIS=1
BOOTSTRAP=0
HOST_FIREWALL=0

if [ "${ENSEMBLE_SKIP_SYSTEMD:-}" = "1" ]; then
  SKIP_SYSTEMD=1
fi
if [ "${ENSEMBLE_LOCAL_POSTGRES:-1}" = "0" ]; then
  LOCAL_POSTGRES=0
fi
if [ "${ENSEMBLE_LOCAL_REDIS:-1}" = "0" ]; then
  LOCAL_REDIS=0
fi

usage() {
  echo "Usage: setup.sh [/path/to/env] [--local-postgres | --no-local-postgres] [--local-redis | --no-local-redis] [--skip-systemd] [--host-firewall] [--bootstrap]" >&2
  echo "Env file: argument or ENSEMBLE_ENV_FILE. Default is local Postgres and local Redis. --bootstrap does not need an env file." >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-systemd) SKIP_SYSTEMD=1 ;;
    --local-postgres) LOCAL_POSTGRES=1 ;;
    --no-local-postgres) LOCAL_POSTGRES=0 ;;
    --local-redis) LOCAL_REDIS=1 ;;
    --no-local-redis) LOCAL_REDIS=0 ;;
    --bootstrap) BOOTSTRAP=1 ;;
    --host-firewall) HOST_FIREWALL=1 ;;
    --help | -h)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      if [ -n "$ENV_FILE" ]; then
        echo "Unexpected argument. The value was not printed." >&2
        usage
        exit 2
      fi
      ENV_FILE=$1
      ;;
  esac
  shift
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run setup.sh as root." >&2
  exit 1
fi

if [ "$BOOTSTRAP" -eq 1 ]; then
  echo "Bootstrap: ensemble user and a read-only GitHub deploy key. Nothing else is installed."
  apt-get update
  apt-get install -y --no-install-recommends openssh-client ca-certificates
  ensure_ensemble_user
  ensure_deploy_key
  cat <<'EOF'
Next, after the key above is a read-only deploy key on ensemblework/ensemble:
  sudo install -d -o ensemble -g ensemble -m 0755 /opt/ensemble
  sudo -u ensemble -H git clone -b production git@github.com:ensemblework/ensemble.git /opt/ensemble
  sudo cp /opt/ensemble/infra/deploy/ensemble.env.example /etc/ensemble.env
  sudo chmod 600 /etc/ensemble.env
  # Fill in /etc/ensemble.env. Keep ENSEMBLE_SECRET_KEY in a password manager.
  sudo bash /opt/ensemble/infra/deploy/setup.sh /etc/ensemble.env
EOF
  exit 0
fi

if [ -z "$ENV_FILE" ]; then
  echo "Pass the env file path, or set ENSEMBLE_ENV_FILE." >&2
  usage
  exit 2
fi

load_env_file "$ENV_FILE"
caddy_site_host >/dev/null
require_database_url
export NODE_ENV=production
chmod 600 "$ENV_FILE"
if [ "$SKIP_SYSTEMD" -eq 0 ]; then
  env_real="$(readlink -f "$ENV_FILE")"
  if [ "$env_real" != "/etc/ensemble.env" ]; then
    echo "The systemd units read /etc/ensemble.env. Pass that path, or use --skip-systemd." >&2
    exit 1
  fi
  chown root:root /etc/ensemble.env
fi

if [ "$SKIP_SYSTEMD" -eq 1 ]; then
  printf '%s\n' '#!/bin/sh' '# ensemble-setup-skip-systemd' 'exit 101' >/usr/sbin/policy-rc.d
  chmod 755 /usr/sbin/policy-rc.d
  trap 'if [ -f /usr/sbin/policy-rc.d ] && grep -q ensemble-setup-skip-systemd /usr/sbin/policy-rc.d; then rm -f /usr/sbin/policy-rc.d; fi' EXIT
fi

apt_install() {
  apt-get install -y --no-install-recommends \
    -o Dpkg::Options::=--force-confdef \
    -o Dpkg::Options::=--force-confold \
    "$@"
}

install_pg_client() {
  if /usr/bin/pg_dump --version 2>/dev/null | grep -q ' 17\.'; then
    echo "pg_dump 17 is already installed."
    return 0
  fi
  echo "Installing postgresql-client 17 from PGDG (local PG16 and Supabase PG17)."
  if [ ! -f /usr/share/keyrings/postgresql.gpg ]; then
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg
    chmod 644 /usr/share/keyrings/postgresql.gpg
  fi
  if [ ! -f /etc/apt/sources.list.d/pgdg.list ]; then
    echo 'deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt noble-pgdg main' \
      >/etc/apt/sources.list.d/pgdg.list
  fi
  apt-get update
  apt_install postgresql-client-17
  if [ -x /usr/lib/postgresql/17/bin/pg_dump ]; then
    ln -sfn /usr/lib/postgresql/17/bin/pg_dump /usr/local/bin/pg_dump
  fi
  if ! pg_dump --version | grep -q ' 17\.'; then
    echo "pg_dump 17 is not on PATH." >&2
    return 1
  fi
}

echo "Installing base packages."
apt-get update
apt_install ca-certificates curl gnupg rsync git openssh-client python3 python3.12 python3.12-venv apt-transport-https
install_pg_client

if ! /usr/bin/node -v 2>/dev/null | grep -q '^v22\.'; then
  echo "Installing Node.js 22 from NodeSource."
  node_setup="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o "$node_setup"
  bash "$node_setup"
  rm -f "$node_setup"
  apt_install nodejs
fi
if [ ! -x /usr/bin/node ] || ! /usr/bin/node -v | grep -q '^v22\.'; then
  echo "Node 22 is not at /usr/bin/node." >&2
  exit 1
fi

echo "Activating pnpm 12.6.0 with corepack."
corepack enable
corepack prepare pnpm@12.6.0 --activate
if ! /usr/bin/pnpm -v | grep -q '^12\.6\.0$'; then
  echo "pnpm 12.6.0 is not on /usr/bin/pnpm." >&2
  exit 1
fi

if [ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg
fi
if [ ! -f /etc/apt/sources.list.d/caddy-stable.list ]; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update
fi
if ! command -v caddy >/dev/null 2>&1; then
  echo "Installing Caddy."
  apt_install caddy
fi

if [ "$LOCAL_POSTGRES" -eq 1 ]; then
  echo "Installing Docker for local Postgres."
  apt_install docker.io docker-compose-v2
  if docker info >/dev/null 2>&1; then
    echo "Docker is already running. Leaving the daemon alone."
    if [ "$SKIP_SYSTEMD" -eq 0 ]; then
      systemctl enable docker
    fi
  elif [ "$SKIP_SYSTEMD" -eq 0 ]; then
    systemctl enable --now docker
  else
    echo "Docker is installed but the daemon is not running." >&2
    echo "Start the daemon, or re-run with --no-local-postgres and a reachable DATABASE_URL." >&2
    exit 1
  fi
fi

if [ "$LOCAL_REDIS" -eq 1 ]; then
  echo "Installing redis-server."
  apt_install redis-server procps
fi

ensure_ensemble_user
ensure_deploy_key

repo_root=$(cd "$SCRIPT_DIR/../.." && pwd)
src="${ENSEMBLE_SRC:-$repo_root}"
if [ "$src" != "/opt/ensemble" ]; then
  echo "Copying the tree to /opt/ensemble."
  install -d -o root -g root -m 0755 /opt/ensemble
  rsync -a \
    --exclude node_modules \
    --exclude .venv \
    --exclude '.next' \
    --exclude '.env' \
    --exclude '.env.local' \
    --exclude '.env.production' \
    --exclude '.ensemble' \
    "$src"/ /opt/ensemble/
fi
if [ ! -f /opt/ensemble/package.json ]; then
  echo "/opt/ensemble has no package.json. Clone the repo there, or run this script from a checkout." >&2
  exit 1
fi
chown -R ensemble:ensemble /opt/ensemble

add_swap() {
  if swapon --show | grep -q .; then
    echo "Swap is already on. Leaving it."
    return 0
  fi
  if [ -f /swapfile ] && ! grep -q '/swapfile' /proc/swaps 2>/dev/null; then
    swapoff /swapfile 2>/dev/null || true
    rm -f /swapfile
  fi
  if ! fallocate -l 2G /swapfile 2>/dev/null; then
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  fi
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  if swapon /swapfile; then
    if ! grep -qE '^/swapfile[[:space:]]' /etc/fstab; then
      echo '/swapfile none swap sw 0 0' >>/etc/fstab
    fi
    echo "Added a 2 GB swapfile."
    return 0
  fi
  rm -f /swapfile
  if [ "$SKIP_SYSTEMD" -eq 1 ]; then
    echo "swapon failed. Continuing because --skip-systemd is set (typical in a container)." >&2
    return 0
  fi
  echo "Could not enable the 2 GB swapfile." >&2
  return 1
}
add_swap

configure_host_firewall "$HOST_FIREWALL"

run_as_ensemble() {
  local home_was="${HOME:-}"
  export HOME=/home/ensemble
  export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  runuser --preserve-environment -u ensemble -- "$@"
  if [ -n "$home_was" ]; then
    export HOME="$home_was"
  fi
}

if [ "$LOCAL_POSTGRES" -eq 1 ]; then
  echo "Starting Postgres on 127.0.0.1:5432."
  docker volume create ensemble_pg >/dev/null
  docker compose -f /opt/ensemble/infra/deploy/docker-compose.postgres.yml up -d
  ready=0
  for _ in $(seq 1 60); do
    if docker exec ensemble-postgres pg_isready -U ensemble -d ensemble >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 2
  done
  if [ "$ready" -ne 1 ]; then
    echo "Postgres did not become ready on 127.0.0.1." >&2
    exit 1
  fi
fi

# Local Redis. The password is a hex string so REDIS_URL needs no encoding.
# REDIS_URL in the env file is written only when it is empty or still a placeholder.
configure_local_redis() {
  local action password passfile
  if [ ! -f /etc/redis/redis.conf ]; then
    echo "redis-server did not install /etc/redis/redis.conf." >&2
    return 1
  fi
  action="$(
    REDIS_URL_VALUE="${REDIS_URL:-}" python3 - <<'PY'
import os
from urllib.parse import urlparse

url = os.environ.get("REDIS_URL_VALUE", "")
placeholders = {
    "",
    "rediss://default:TOKEN@HOST.upstash.io:6379",
    "redis://:PASSWORD@127.0.0.1:6379",
    "redis://127.0.0.1:6379",
    "redis://localhost:6379",
}
if url in placeholders:
    print("placeholder")
    raise SystemExit(0)
parsed = urlparse(url)
host = (parsed.hostname or "").lower()
local = parsed.scheme == "redis" and host in {"127.0.0.1", "localhost", "::1"}
password = parsed.password or ""
if local and password in {"", "PASSWORD"}:
    print("placeholder")
elif local:
    print("use-env")
else:
    print("keep-remote")
PY
  )"
  passfile=/etc/redis/ensemble.pass
  if [ "$action" = "use-env" ]; then
    password="$(
      REDIS_URL_VALUE="${REDIS_URL:-}" python3 - <<'PY'
import os
from urllib.parse import urlparse
print(urlparse(os.environ.get("REDIS_URL_VALUE", "")).password or "", end="")
PY
    )"
  elif [ -s "$passfile" ]; then
    password="$(tr -d '\n' <"$passfile")"
    echo "Reusing the local Redis password already stored for this machine."
  else
    password="$(openssl rand -hex 24)"
    echo "Generated a local Redis password. It was not printed."
  fi
  if [ -z "$password" ]; then
    echo "Local Redis has no password to configure." >&2
    return 1
  fi
  local old_umask
  old_umask="$(umask)"
  umask 077
  printf '%s\n' "$password" >"$passfile"
  umask "$old_umask"
  chmod 600 "$passfile"
  chown root:root "$passfile"
  REDIS_SETUP_PASS="$password" REDIS_SETUP_ACTION="$action" REDIS_SETUP_ENV="$ENV_FILE" python3 - <<'PY'
import grp
import os
import pathlib

password = os.environ["REDIS_SETUP_PASS"]
action = os.environ["REDIS_SETUP_ACTION"]
env_path = pathlib.Path(os.environ["REDIS_SETUP_ENV"])
gid = grp.getgrnam("redis").gr_gid
dropin = pathlib.Path("/etc/redis/ensemble.conf")
dropin.write_text(
    "\n".join(
        [
            "bind 127.0.0.1 -::1",
            "protected-mode yes",
            "port 6379",
            f"requirepass {password}",
            "maxmemory 256mb",
            "maxmemory-policy noeviction",
            "appendonly yes",
            "appendfsync everysec",
            "# Redis's arm64 MADV_FREE check false-fails under qemu. A current Ubuntu kernel passes it.",
            "ignore-warnings ARM64-COW-BUG",
            "",
        ]
    )
)
os.chown(dropin, 0, gid)
os.chmod(dropin, 0o640)
redis_conf = pathlib.Path("/etc/redis/redis.conf")
body = []
for line in redis_conf.read_text().splitlines():
    if line.strip() == "include /etc/redis/ensemble.conf":
        continue
    # bind is cumulative across includes. Keep only the drop-in's loopback bind.
    if line.startswith("bind ") or line.startswith("bind\t"):
        body.append("# " + line + "  # ensemble: bind is set in /etc/redis/ensemble.conf")
        continue
    body.append(line)
while body and body[-1] == "":
    body.pop()
body.append("include /etc/redis/ensemble.conf")
redis_conf.write_text("\n".join(body) + "\n")
os.chown(redis_conf, 0, gid)
os.chmod(redis_conf, 0o640)
if action == "placeholder":
    url = f"redis://:{password}@127.0.0.1:6379"
    lines = env_path.read_text().splitlines()
    found = False
    out = []
    for line in lines:
        stripped = line.lstrip()
        rest = stripped[len("export ") :] if stripped.startswith("export ") else stripped
        if rest.startswith("REDIS_URL="):
            if not found:
                out.append(f"REDIS_URL={url}")
                found = True
            continue
        out.append(line)
    if not found:
        if out and out[-1] != "":
            out.append("")
        out.append(f"REDIS_URL={url}")
    env_path.write_text("\n".join(out) + "\n")
    os.chmod(env_path, 0o600)
PY
  unset REDIS_SETUP_PASS REDIS_SETUP_ACTION REDIS_SETUP_ENV
  if [ "$action" = "placeholder" ]; then
    export REDIS_URL="redis://:${password}@127.0.0.1:6379"
    echo "Filled REDIS_URL with the local Redis URL. The password was not printed."
  elif [ "$action" = "use-env" ]; then
    echo "REDIS_URL already points at local Redis. Leaving that value."
  else
    echo "REDIS_URL is already set. Leaving that value. Local Redis has its own password."
  fi
  if [ "$SKIP_SYSTEMD" -eq 0 ]; then
    systemctl enable redis-server.service
    systemctl restart redis-server.service
  else
    install -d -o redis -g redis -m 0750 /run/redis /var/log/redis /var/lib/redis
    redis-cli shutdown nosave >/dev/null 2>&1 || true
    REDISCLI_AUTH="$password" redis-cli --no-auth-warning shutdown nosave >/dev/null 2>&1 || true
    if pgrep -x redis-server >/dev/null 2>&1; then
      pkill -x redis-server >/dev/null 2>&1 || true
      sleep 0.5
    fi
    redis-server /etc/redis/redis.conf --supervised no --daemonize yes
  fi
  if ! REDISCLI_AUTH="$password" redis-cli --no-auth-warning ping | grep -qx PONG; then
    echo "Local Redis did not answer an authenticated PING." >&2
    return 1
  fi
  if redis-cli ping 2>/dev/null | grep -qx PONG; then
    echo "Local Redis accepted a command without a password." >&2
    return 1
  fi
  echo "Local Redis is up on 127.0.0.1:6379 and requires a password."
}

if [ "$LOCAL_REDIS" -eq 1 ]; then
  configure_local_redis
else
  echo "Local Redis is off. Using REDIS_URL as set in the env file."
fi

echo "Installing JavaScript dependencies (including devDependencies; the API starts with tsx)."
run_as_ensemble bash -c 'cd /opt/ensemble && pnpm install --frozen-lockfile'
tsx_cli=/opt/ensemble/apps/hub-api/node_modules/tsx/dist/cli.mjs
if [ ! -f "$tsx_cli" ]; then
  echo "tsx CLI is missing at apps/hub-api/node_modules/tsx/dist/cli.mjs." >&2
  exit 1
fi

echo "Generating the Prisma client and applying migrations."
run_as_ensemble bash -c 'cd /opt/ensemble && pnpm --filter @ensemble/hub-api exec prisma generate'
run_as_ensemble bash -c 'cd /opt/ensemble && pnpm db:migrate'

venv=/opt/ensemble/apps/agent-runtime/.venv
echo "Installing the agent virtualenv and checking wheels."
if [ ! -x "$venv/bin/python" ]; then
  run_as_ensemble python3.12 -m venv "$venv"
fi
run_as_ensemble "$venv/bin/pip" install -e /opt/ensemble/apps/agent-runtime
run_as_ensemble "$venv/bin/python" -c 'import psycopg, cryptography, numpy, pandas, pyarrow, matplotlib, scipy; print("wheels ok")'

install -d -o ensemble -g ensemble -m 0750 /opt/ensemble/.ensemble
install -d -o ensemble -g ensemble -m 0750 /opt/ensemble/apps/hub-api/.theme-cache
install -d -o ensemble -g ensemble -m 0750 /var/lib/ensemble/workspace
install -d -o ensemble -g ensemble -m 0750 /var/lib/ensemble/remote
install -d -o ensemble -g ensemble -m 0750 /var/cache/ensemble/matplotlib
install -d -o ensemble -g ensemble -m 0700 /var/backups/ensemble
install -d -o ensemble -g ensemble -m 0750 /var/log/ensemble

install_caddyfile "$SCRIPT_DIR/Caddyfile"
if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
  echo "Caddyfile did not validate." >&2
  exit 1
fi

stop_hand() {
  local pidfile="$1"
  local pid
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile")"
    if [ -n "$pid" ]; then
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
}

start_hand() {
  echo "systemd was skipped. Starting hub-api and the agent by hand."
  install -d -m 0755 /run/ensemble
  stop_hand /run/ensemble/api.pid
  stop_hand /run/ensemble/agent.pid
  export HOME=/home/ensemble
  export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  export NODE_ENV=production
  export PYTHONDONTWRITEBYTECODE=1
  export TMPDIR=/tmp
  export ENSEMBLE_WORKSPACE_ROOT="${ENSEMBLE_WORKSPACE_ROOT:-/var/lib/ensemble/workspace}"
  export ENSEMBLE_MPLCONFIGDIR="${ENSEMBLE_MPLCONFIGDIR:-/var/cache/ensemble/matplotlib}"
  export MPLCONFIGDIR="$ENSEMBLE_MPLCONFIGDIR"
  export ENSEMBLE_REMOTE_STATE_DIR="${ENSEMBLE_REMOTE_STATE_DIR:-/var/lib/ensemble/remote}"
  setsid runuser --preserve-environment -u ensemble -- \
    bash -c 'cd /opt/ensemble/apps/agent-runtime && exec .venv/bin/uvicorn ensemble_agent.main:app --host 127.0.0.1 --port 5055' \
    >/var/log/ensemble/agent.log 2>&1 &
  echo "$!" >/run/ensemble/agent.pid
  setsid runuser --preserve-environment -u ensemble -- \
    bash -c 'cd /opt/ensemble/apps/hub-api && exec /usr/bin/node /opt/ensemble/apps/hub-api/node_modules/tsx/dist/cli.mjs src/index.ts' \
    >/var/log/ensemble/api.log 2>&1 &
  echo "$!" >/run/ensemble/api.pid
}

if [ "$SKIP_SYSTEMD" -eq 0 ]; then
  echo "Installing systemd units."
  write_commit_file
  install -m 0644 "$SCRIPT_DIR/ensemble-api.service" /etc/systemd/system/ensemble-api.service
  install -m 0644 "$SCRIPT_DIR/ensemble-agent.service" /etc/systemd/system/ensemble-agent.service
  install -m 0644 "$SCRIPT_DIR/ensemble-pg-backup.service" /etc/systemd/system/ensemble-pg-backup.service
  install -m 0644 "$SCRIPT_DIR/ensemble-pg-backup.timer" /etc/systemd/system/ensemble-pg-backup.timer
  install -m 0644 "$SCRIPT_DIR/ensemble-autodeploy.service" /etc/systemd/system/ensemble-autodeploy.service
  install -m 0644 "$SCRIPT_DIR/ensemble-autodeploy.timer" /etc/systemd/system/ensemble-autodeploy.timer
  systemctl daemon-reload
  systemctl enable --now ensemble-agent.service
  systemctl enable --now ensemble-api.service
  systemctl enable --now ensemble-pg-backup.timer
  # Does nothing unless ENSEMBLE_AUTODEPLOY=on in /etc/ensemble.env.
  systemctl enable --now ensemble-autodeploy.timer
  systemctl enable caddy
  if ! systemctl restart caddy; then
    echo "Caddy did not start. Certificate issuance needs DNS and a reachable port 80 or 443. The API check still runs." >&2
  fi
else
  start_hand
fi

if ! "$SCRIPT_DIR/ready-check.sh"; then
  if [ "$SKIP_SYSTEMD" -eq 1 ]; then
    echo "Logs (may contain a connection error; not copied here): /var/log/ensemble/api.log and /var/log/ensemble/agent.log" >&2
  else
    echo "journalctl -u ensemble-api -u ensemble-agent --no-pager" >&2
  fi
  exit 1
fi

echo "Ensemble is answering on http://127.0.0.1:4000/health/ready"

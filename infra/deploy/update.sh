#!/usr/bin/env bash
# Update an installed Ensemble: fast-forward to origin/$ENSEMBLE_DEPLOY_BRANCH (default main),
# install, migrate, restart. Does not run next build. Does not print secrets. Does not force-push.
# ensemble-autodeploy.timer runs this through autodeploy.sh when that branch moves.
#
#   sudo bash /opt/ensemble/infra/deploy/update.sh /etc/ensemble.env
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ENV_FILE="${ENSEMBLE_ENV_FILE:-}"
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: update.sh [/path/to/env]" >&2
  exit 0
fi
if [ -n "${1:-}" ]; then
  ENV_FILE=$1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Run update.sh as root." >&2
  exit 1
fi
if [ -z "$ENV_FILE" ]; then
  echo "Pass the env file path, or set ENSEMBLE_ENV_FILE." >&2
  exit 2
fi
if [ ! -d /opt/ensemble/.git ]; then
  echo "/opt/ensemble is not a git checkout. Clone the repo there before updating." >&2
  exit 1
fi

load_env_file "$ENV_FILE"
require_database_url
caddy_site_host >/dev/null
export NODE_ENV=production

ensure_ensemble_user
ensure_deploy_key
branch="$(deploy_branch)"

echo "Updating /opt/ensemble as ensemble to origin/${branch} (fast-forward only)."
chown -R ensemble:ensemble /opt/ensemble
origin="$(runuser -u ensemble -- git -C /opt/ensemble remote get-url origin || true)"
case "$origin" in
  https://github.com/ensemblework/ensemble | https://github.com/ensemblework/ensemble.git | git@github.com:ensemblework/ensemble.git)
    runuser -u ensemble -- git -C /opt/ensemble remote set-url origin git@github.com:ensemblework/ensemble.git
    ;;
esac
echo "git running as $(runuser -u ensemble -- id -un)."
ensemble_git fetch origin "$branch"
if [ "$(ensemble_git rev-parse --abbrev-ref HEAD)" != "$branch" ]; then
  ensemble_git checkout "$branch"
fi
ensemble_git merge --ff-only "origin/$branch"
write_commit_file

export HOME=/home/ensemble
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
echo "Installing dependencies as $(runuser -u ensemble -- id -un)."
runuser --preserve-environment -u ensemble -- bash -c 'cd /opt/ensemble && pnpm install --frozen-lockfile'
runuser --preserve-environment -u ensemble -- bash -c 'cd /opt/ensemble && pnpm --filter @ensemble/hub-api exec prisma generate'
runuser --preserve-environment -u ensemble -- bash -c 'cd /opt/ensemble && pnpm db:migrate'
runuser --preserve-environment -u ensemble -- /opt/ensemble/apps/agent-runtime/.venv/bin/pip install -e /opt/ensemble/apps/agent-runtime
runuser --preserve-environment -u ensemble -- /opt/ensemble/apps/agent-runtime/.venv/bin/python -c 'import psycopg, cryptography, numpy, pandas, pyarrow, matplotlib, scipy; print("wheels ok")'

install -m 0644 /opt/ensemble/infra/deploy/ensemble-api.service /etc/systemd/system/ensemble-api.service
install -m 0644 /opt/ensemble/infra/deploy/ensemble-agent.service /etc/systemd/system/ensemble-agent.service
install -m 0644 /opt/ensemble/infra/deploy/ensemble-pg-backup.service /etc/systemd/system/ensemble-pg-backup.service
install -m 0644 /opt/ensemble/infra/deploy/ensemble-pg-backup.timer /etc/systemd/system/ensemble-pg-backup.timer
install -m 0644 /opt/ensemble/infra/deploy/ensemble-autodeploy.service /etc/systemd/system/ensemble-autodeploy.service
install -m 0644 /opt/ensemble/infra/deploy/ensemble-autodeploy.timer /etc/systemd/system/ensemble-autodeploy.timer
install_caddyfile /opt/ensemble/infra/deploy/Caddyfile
systemctl daemon-reload
systemctl enable --now ensemble-pg-backup.timer
systemctl enable --now ensemble-autodeploy.timer
systemctl restart ensemble-agent.service
systemctl restart ensemble-api.service
if ! systemctl reload caddy; then
  echo "Caddy did not reload. The API check still runs." >&2
fi

if ! /opt/ensemble/infra/deploy/ready-check.sh; then
  echo "journalctl -u ensemble-api -u ensemble-agent --no-pager" >&2
  exit 1
fi
echo "Update finished. /health/ready returned 200."

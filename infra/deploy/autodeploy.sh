#!/usr/bin/env bash
# Pull-based deploy. ensemble-autodeploy.timer runs this every minute.
# When origin/$ENSEMBLE_DEPLOY_BRANCH has a commit this checkout does not, it runs update.sh.
# Nothing connects in to deploy: the VM only fetches from GitHub, so SSH can stay
# limited to your own IP. Off unless ENSEMBLE_AUTODEPLOY=on in the env file.
#
#   sudo bash /opt/ensemble/infra/deploy/autodeploy.sh /etc/ensemble.env
#
# A commit whose update fails is recorded in /var/lib/ensemble/autodeploy.failed and is
# not retried every minute. Push a fix (a new commit), or run update.sh by hand.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

ENV_FILE="${1:-${ENSEMBLE_ENV_FILE:-/etc/ensemble.env}}"
FAILED=/var/lib/ensemble/autodeploy.failed

if [ "$(id -u)" -ne 0 ]; then
  echo "Run autodeploy.sh as root." >&2
  exit 1
fi
if [ ! -d /opt/ensemble/.git ]; then
  echo "/opt/ensemble is not a git checkout." >&2
  exit 1
fi

load_env_file "$ENV_FILE"
if [ "${ENSEMBLE_AUTODEPLOY:-off}" != "on" ]; then
  exit 0
fi
branch="$(deploy_branch)"

exec 9>/run/ensemble-autodeploy.lock
if ! flock -n 9; then
  echo "Another deploy is running."
  exit 0
fi

ensemble_git fetch --quiet origin "$branch"
head="$(ensemble_git rev-parse HEAD)"
target="$(ensemble_git rev-parse "origin/$branch")"
current="$(ensemble_git rev-parse --abbrev-ref HEAD)"
if [ "$head" = "$target" ] && [ "$current" = "$branch" ]; then
  exit 0
fi
if [ -f "$FAILED" ] && [ "$(cat "$FAILED")" = "$target" ]; then
  exit 0
fi

echo "Deploying ${target} from origin/${branch} (running ${head})."
if bash "$SCRIPT_DIR/update.sh" "$ENV_FILE"; then
  rm -f "$FAILED"
  echo "Deployed ${target}."
else
  install -d -m 0755 "$(dirname "$FAILED")"
  printf '%s\n' "$target" >"$FAILED"
  echo "Deploy of ${target} failed. It will not be retried until a new commit arrives." >&2
  exit 1
fi

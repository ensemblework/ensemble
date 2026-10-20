#!/usr/bin/env bash
# Pull-based deploy for the home server. ensemble-autodeploy.timer (a user unit) runs this every
# minute; when origin/$ENSEMBLE_DEPLOY_BRANCH has a commit the checkout does not, it runs update.sh.
# Nothing connects in. Off unless ENSEMBLE_AUTODEPLOY=on in ~/ensemble-host/ensemble.env.
#
# A commit whose update fails is recorded in ~/ensemble-host/state/autodeploy.failed and is not
# retried every minute. Push a fix (a new commit), or run update.sh by hand.
set -euo pipefail

main() {
  local dir
  dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # shellcheck source=lib.sh
  . "$dir/lib.sh"
  refuse_root
  home_path
  user_bus
  load_env_file "$HOME_ENV_FILE"
  if [ "${ENSEMBLE_AUTODEPLOY:-off}" != "on" ]; then
    exit 0
  fi
  local branch failed head target current
  branch="$(deploy_branch)"
  failed="$ENSEMBLE_HOME_DIR/state/autodeploy.failed"

  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    exit 0
  fi
  app_git fetch --quiet origin "$branch"
  head="$(app_git rev-parse HEAD)"
  target="$(app_git rev-parse "origin/$branch")"
  current="$(app_git rev-parse --abbrev-ref HEAD)"
  if [ "$head" = "$target" ] && [ "$current" = "$branch" ]; then
    exit 0
  fi
  if [ -f "$failed" ] && [ "$(cat "$failed")" = "$target" ]; then
    exit 0
  fi

  echo "Deploying ${target} from origin/${branch} (running ${head})."
  if ENSEMBLE_DEPLOY_LOCKED=1 bash "$APP/infra/deploy/home/update.sh"; then
    rm -f "$failed"
    echo "Deployed ${target}."
  else
    mkdir -p "$(dirname "$failed")"
    printf '%s\n' "$target" >"$failed"
    echo "Deploy of ${target} failed. It will not be retried until a new commit arrives." >&2
    exit 1
  fi
}

main "$@"
exit

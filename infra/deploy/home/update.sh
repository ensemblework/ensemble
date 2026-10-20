#!/usr/bin/env bash
# Update the home-server install: fast-forward ~/ensemble-host/app to origin/$ENSEMBLE_DEPLOY_BRANCH,
# install, migrate, refresh the user units, restart, and wait for /health/ready. Run as the
# machine's user, never root. ensemble-autodeploy.timer runs it through autodeploy.sh.
#
#   bash ~/ensemble-host/app/infra/deploy/home/update.sh
#
# The body is one function so a fast-forward that rewrites this file cannot change it mid-run.
set -euo pipefail

main() {
  local dir
  dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # shellcheck source=lib.sh
  . "$dir/lib.sh"
  refuse_root
  home_path
  user_bus
  if [ ! -d "$APP/.git" ]; then
    echo "$APP is not a git checkout. Run setup.sh first." >&2
    exit 1
  fi
  load_home_env
  local branch
  branch="$(deploy_branch)"
  if [ -z "${ENSEMBLE_DEPLOY_LOCKED:-}" ]; then
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
      echo "Another deploy is running." >&2
      exit 1
    fi
  fi

  echo "Updating $APP to origin/${branch} (fast-forward only)."
  app_git fetch --quiet origin "$branch"
  if [ "$(app_git rev-parse --abbrev-ref HEAD)" != "$branch" ]; then
    app_git checkout --quiet "$branch"
  fi
  app_git merge --quiet --ff-only "origin/$branch"
  home_commit_file

  ensure_node
  cd "$APP"
  # NODE_ENV=production in the env file would make pnpm skip tsx and prisma, which the units use.
  env -u NODE_ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --reporter=silent
  pnpm --filter @ensemble/hub-api exec prisma generate >/dev/null
  home_compose up -d --remove-orphans
  wait_postgres
  # A dump before any migration runs; a deploy whose dump fails stops here.
  bash "$APP/infra/deploy/home/pg-backup.sh" --local
  pnpm db:migrate
  ensure_agent_venv
  install_units

  systemctl --user restart ensemble-agent.service
  systemctl --user restart ensemble-api.service
  if ! ENSEMBLE_READY_URL="$(ready_url)" bash "$APP/infra/deploy/ready-check.sh"; then
    echo "journalctl --user -u ensemble-api -u ensemble-agent --no-pager -n 100" >&2
    exit 1
  fi
  echo "Update finished at $(app_git rev-parse --short HEAD). /health/ready returned 200."
}

main "$@"
exit

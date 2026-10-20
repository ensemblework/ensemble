#!/usr/bin/env bash
# Nightly backup for the home server (ensemble-pg-backup.timer): a pg_dump of the database and a
# tarball of the small state on disk (workspace, paired-computer state, and plot datasets on a server
# that keeps them on disk). Seven days stay in ~/ensemble-host/backups. With
# AZURE_STORAGE_CONNECTION_STRING set, each copy also goes to the ENSEMBLE_BACKUP_CONTAINER container
# (default ensemble-backups) under db/ and state/; a lifecycle rule on that container can expire them.
# What is already in the blob store (file originals, plot tables) is not copied again.
#
# update.sh runs it with --local before every migration: the same dump, kept here only.
#
# ENSEMBLE_SECRET_KEY is not in any of these. Without the same key, saved model keys and connector
# tokens in a restored dump do not decrypt. Keep the key in a password manager.
#
# Restore into a throwaway database first:
#   docker exec -i ensemble-home-postgres createdb -U ensemble ensemble_restore
#   docker exec -i ensemble-home-postgres pg_restore -U ensemble --no-owner -d ensemble_restore < ensemble-STAMP.dump
set -euo pipefail

main() {
  local dir
  dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # shellcheck source=lib.sh
  . "$dir/lib.sh"
  refuse_root
  home_path
  load_home_env
  local local_only=false
  [ "${1:-}" = "--local" ] && local_only=true
  umask 077
  local dest="$ENSEMBLE_HOME_DIR/backups" stamp dump state
  mkdir -p "$dest"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dump="$dest/ensemble-$stamp.dump"
  state="$dest/state-$stamp.tar.gz"

  if ! docker exec ensemble-home-postgres pg_dump -U ensemble -d ensemble -Fc --no-owner >"$dump.part" 2>"$dest/last-error.log"; then
    rm -f "$dump.part"
    echo "pg_dump failed; see $dest/last-error.log." >&2
    exit 1
  fi
  mv "$dump.part" "$dump"
  rm -f "$dest/last-error.log"
  local parts=()
  [ -d "$ENSEMBLE_HOME_DIR/state" ] && parts+=(state)
  [ -d "$APP/.ensemble" ] && parts+=(app/.ensemble)
  tar -czf "$state" -C "$ENSEMBLE_HOME_DIR" --exclude=secret.key --exclude=autodeploy.failed "${parts[@]}"
  find "$dest" -maxdepth 1 -type f \( -name 'ensemble-*.dump' -o -name 'state-*.tar.gz' \) -mtime +6 -delete
  echo "Wrote $(basename "$dump") and $(basename "$state")."

  if ! $local_only && [ -n "${AZURE_STORAGE_CONNECTION_STRING:-}" ]; then
    if ! command -v az >/dev/null 2>&1; then
      echo "The Azure CLI (az) is not installed, so the backup stayed on this machine." >&2
      exit 1
    fi
    local container="${ENSEMBLE_BACKUP_CONTAINER:-ensemble-backups}"
    # az reads AZURE_STORAGE_CONNECTION_STRING from the environment; it is not put on the command line.
    az storage blob upload --only-show-errors --no-progress --container-name "$container" --name "db/$(basename "$dump")" --file "$dump" >/dev/null
    az storage blob upload --only-show-errors --no-progress --container-name "$container" --name "state/$(basename "$state")" --file "$state" >/dev/null
    echo "Copied both to the $container blob container."
  fi
}

main "$@"
exit

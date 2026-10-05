#!/usr/bin/env bash
# Daily pg_dump of DATABASE_URL. Keeps dumps under /var/backups/ensemble for 7 days.
# Does not print the URL, the password, or pg_dump's stderr.
#
# Restore into a throwaway database first. Do not pass --clean at the live database.
#   createdb ensemble_restore
#   pg_restore --no-owner -d ensemble_restore /var/backups/ensemble/ensemble-STAMP.dump
# Read it back, stop hub-api, then rename the databases.
# ENSEMBLE_SECRET_KEY is not inside the dump. Without the same key, v1: rows do not decrypt.
# A dump that only exists on this disk is not a backup. Copy it off the VM.
set -euo pipefail

umask 077
dest=/var/backups/ensemble
mkdir -p "$dest"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set. The value was not printed." >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="${dest}/ensemble-${stamp}.dump"
err="${dest}/last-error.log"

python3 - "$out" "$err" <<'PY'
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlparse

out = Path(sys.argv[1])
err_path = Path(sys.argv[2])
raw = os.environ.get("DATABASE_URL", "")
parsed = urlparse(raw)
if parsed.scheme not in {"postgresql", "postgres"} or not parsed.hostname:
    print("DATABASE_URL is not a postgres URL. The value was not printed.", file=sys.stderr)
    sys.exit(1)
database = unquote((parsed.path or "").lstrip("/"))
if not database:
    print("DATABASE_URL has no database name. The value was not printed.", file=sys.stderr)
    sys.exit(1)

# Prisma-only parameters. libpq rejects connection_limit.
drop = {"connection_limit", "pool_timeout", "pgbouncer", "schema", "socket_timeout"}
libpq = {
    "sslmode": "PGSSLMODE",
    "sslrootcert": "PGSSLROOTCERT",
    "sslcert": "PGSSLCERT",
    "sslkey": "PGSSLKEY",
    "target_session_attrs": "PGTARGETSESSIONATTRS",
}
env = os.environ.copy()
env["PGHOST"] = parsed.hostname
env["PGPORT"] = str(parsed.port or 5432)
env["PGUSER"] = unquote(parsed.username or "")
env["PGPASSWORD"] = unquote(parsed.password or "")
env["PGDATABASE"] = database
unknown = []
for key, value in parse_qsl(parsed.query, keep_blank_values=True):
    if key in drop:
        continue
    mapped = libpq.get(key)
    if mapped:
        env[mapped] = value
    else:
        unknown.append(key)
if unknown:
    names = ", ".join(sorted(set(unknown)))
    print(f"DATABASE_URL has query parameters this backup does not pass through: {names}", file=sys.stderr)
    sys.exit(1)

with err_path.open("w") as handle:
    result = subprocess.run(
        ["pg_dump", "-Fc", "--no-owner", f"--file={out}"],
        env=env,
        stderr=handle,
    )
if result.returncode != 0:
    out.unlink(missing_ok=True)
    print(
        "pg_dump failed. Details are in /var/backups/ensemble/last-error.log and were not printed here.",
        file=sys.stderr,
    )
    sys.exit(result.returncode or 1)
err_path.unlink(missing_ok=True)
PY

# -mtime +6 deletes a dump once it is more than 6 days old, so seven daily dumps remain.
# -mtime +7 would keep an eighth day.
find "$dest" -type f -name 'ensemble-*.dump' -mtime +6 -delete
echo "pg_dump wrote a dump under /var/backups/ensemble and kept seven daily dumps."

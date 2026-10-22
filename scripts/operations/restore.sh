#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${PGSERVICE:?Set the isolated restore PostgreSQL service}"
: "${PGSERVICEFILE:?Set private pg_service.conf path}"
: "${1:?Usage: restore.sh verified-backup.dump}"
[[ "$PGSERVICE" =~ ^[A-Za-z0-9_-]+$ ]] || exit 2
[[ "${RESTORE_CONFIRMATION:-}" = restore-into-empty-database ]] || { echo 'Explicit empty-database restore confirmation is required' >&2; exit 2; }
(cd -- "$(dirname -- "$1")" && sha256sum -c -- "$(basename -- "$1").sha256")
database=$(psql --no-psqlrc --tuples-only --no-align --dbname="service=$PGSERVICE" --command='SELECT current_database()')
[[ "$database" =~ _restore_([0-9]{8}|test)$ ]] || { echo 'Target must end in _restore_YYYYMMDD or _restore_test' >&2; exit 2; }
tables=$(psql --no-psqlrc --tuples-only --no-align --dbname="service=$PGSERVICE" --command="SELECT count(*) FROM pg_tables WHERE schemaname='public'")
[[ "$tables" = 0 ]] || { echo 'Restore target is not empty; no data was changed' >&2; exit 2; }
pg_restore --dbname="service=$PGSERVICE" --single-transaction --exit-on-error --no-owner --no-acl "$1"
echo 'Restore finished. Validate checksums/financial inventory and reapply runtime grants before any separately authorised cutover.'

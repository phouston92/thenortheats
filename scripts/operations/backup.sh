#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${PGSERVICE:?Set a private PostgreSQL backup service}"
: "${PGSERVICEFILE:?Set the private pg_service.conf path}"
: "${1:?Usage: backup.sh private-backup-path.dump}"
[[ "$PGSERVICE" =~ ^[A-Za-z0-9_-]+$ ]] || exit 2
[[ ! -e "$1" && ! -e "$1.sha256" ]] || { echo 'Backup target already exists' >&2; exit 2; }
temporary=$(mktemp "$1.partial.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
pg_dump --dbname="service=$PGSERVICE" --format=custom --no-owner --no-acl --file="$temporary"
pg_restore --list "$temporary" >/dev/null
ln -- "$temporary" "$1"
(cd -- "$(dirname -- "$1")" && sha256sum -- "$(basename -- "$1")" > "$(basename -- "$1").sha256")
echo 'Private backup and checksum created; encrypt and transfer off-host before retention cleanup.'

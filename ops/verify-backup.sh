#!/usr/bin/env bash
#
# The restore drill. An untested restore is not a backup.
#
# Runs the whole round trip — dump, encrypt, decrypt, restore into a fresh database, compare row
# counts table by table — and fails loudly on any difference. Weekly on the box and in CI, because
# a restore path that quietly rots should be caught by a machine rather than by an outage.
#
# It generates a **throwaway** age keypair for the drill. The real private key is deliberately not
# on this machine, so the drill proves the pipeline rather than the archive. Verifying an actual
# nightly archive is a separate, human, off-box act.
#
# Usage:  ./ops/verify-backup.sh [source-database]
set -euo pipefail

SRC="${1:-trisula}"
WORK="$(mktemp -d)"
TARGET="verify_${SRC}_$$"
trap 'rm -rf "$WORK"; dropdb --if-exists "$TARGET" 2>/dev/null || true' EXIT

for tool in pg_dump pg_restore psql age age-keygen createdb dropdb; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

echo "==> throwaway keypair for the drill"
KEY="$WORK/age.key"
age-keygen -o "$KEY" 2>/dev/null
RECIPIENT="$(age-keygen -y "$KEY")"

echo "==> dump and encrypt"
# S3 is cleared explicitly. Under systemd this script inherits the shared env file, and
# backup.sh uploads whenever BACKUP_S3_BUCKET is set — so without this the weekly drill
# puts a throwaway-key archive in the real bucket beside the ones you can actually decrypt.
BACKUP_AGE_RECIPIENT="$RECIPIENT" BACKUP_DIR="$WORK" \
  BACKUP_S3_BUCKET= BACKUP_S3_ENDPOINT= \
  "$(dirname "${BASH_SOURCE[0]}")/backup.sh" "$SRC" >/dev/null
ARCHIVE="$(find "$WORK" -name "${SRC}-*.dump.age" | head -1)"
[ -n "$ARCHIVE" ] || { echo "no archive produced" >&2; exit 1; }

echo "==> confirm the archive is not readable as plaintext"
if pg_restore -l "$ARCHIVE" >/dev/null 2>&1; then
  echo "FAIL: the archive is a readable dump; encryption did not happen" >&2
  exit 1
fi

echo "==> decrypt and restore into $TARGET"
"$(dirname "${BASH_SOURCE[0]}")/restore.sh" "$ARCHIVE" "$TARGET" "$KEY" >/dev/null

echo "==> compare row counts, table by table"
counts() {
  psql -d "$1" -tAF' ' -c "
    SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname" 2>/dev/null
}
# pg_stat is an estimate; count for real, which matters because a silently truncated table is
# exactly what this drill exists to catch.
real_counts() {
  psql -d "$1" -tAF' ' -c "
    SELECT c.relname,
           (xpath('/row/c/text()',
                  query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                               false, true, '')))[1]::text::bigint
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname"
}

SRC_COUNTS="$WORK/src.txt"; real_counts "$SRC"    > "$SRC_COUNTS"
DST_COUNTS="$WORK/dst.txt"; real_counts "$TARGET" > "$DST_COUNTS"

if ! diff -u "$SRC_COUNTS" "$DST_COUNTS"; then
  echo "FAIL: restored database does not match the source" >&2
  exit 1
fi

TABLES="$(wc -l < "$SRC_COUNTS" | tr -d ' ')"
ROWS="$(awk '{s+=$2} END {print s+0}' "$SRC_COUNTS")"
echo "OK: $TABLES tables, $ROWS rows, identical after a full round trip"

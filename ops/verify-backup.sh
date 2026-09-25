#!/usr/bin/env bash
#
# The restore drill. An untested restore is not a backup.
#
# Runs the whole round trip — dump, encrypt, decrypt, restore into a fresh database, compare row
# counts and row *content* table by table — and fails loudly on any difference. Weekly on the box
# (`trisula-backup-verify.timer`), because a restore path that quietly rots should be caught by a
# machine rather than by an outage. There is no CI; this header said there was until 25-Sep-2026.
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
# --replace because restore.sh refuses an existing database by default, and rightly: it is the
# script people run under pressure. Here the target is a throwaway this drill named after its own
# pid and drops on the way out, so replacing it is the drill recovering from a run that was killed
# before its trap fired, not an operator overwriting something.
"$(dirname "${BASH_SOURCE[0]}")/restore.sh" --replace "$ARCHIVE" "$TARGET" "$KEY" >/dev/null

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
[ "$TABLES" -gt 0 ] || {
  echo "FAIL: the source database $SRC has no tables in public — this drill compared nothing" >&2
  exit 1
}

echo "==> compare content, table by table"
# Counts alone pass a backup that restored the right number of wrong rows, which is the failure
# worth catching: a truncated table shows up in the count, a corrupted one does not. So: cast each
# row to text, hash it, and hash the sorted hashes. Sorted, because a restore is free to hand rows
# back in a different physical order and that is not a difference; hashing each row first keeps
# the aggregate at 32 bytes per row rather than the whole row, which matters on `chunks`: 38,227
# rows in the development database on 21-Sep-2026, each carrying a 384-dimension vector, so the
# whole-row form would build a string of hundreds of megabytes to hash one table.
#
# The four session settings are pinned because this compares *rendered* text: TimeZone decides how
# a timestamptz prints, extra_float_digits whether a float round-trips exactly, DateStyle the order
# of a date's fields, bytea_output hex against escape. They are identical on both sides today —
# same cluster, same defaults — and saying so is what keeps this a content check rather than a
# check of whether anyone has touched postgresql.conf between the dump and the restore. The sort is
# COLLATE "C" for the same reason: byte order, not the database's collation.
#
# Set through PGOPTIONS rather than as `SET` statements in the query: psql -tA prints a bare `SET`
# line per statement, and those four lines land in the hash file ahead of the hash. The guard
# below caught exactly that, which is the argument for having it.
PGOPTS="-c TimeZone=UTC -c DateStyle=ISO,YMD -c extra_float_digits=3 -c bytea_output=hex"

tables() {
  psql -d "$1" -tAX -c "
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname"
}

table_hashes() {
  local db="$1" t
  while read -r t; do
    [ -n "$t" ] || continue
    printf '%s %s\n' "$t" "$(PGOPTIONS="$PGOPTS" psql -d "$db" -tAX -v ON_ERROR_STOP=1 -c "
      SELECT md5(coalesce(string_agg(h, chr(10) ORDER BY h COLLATE \"C\"), ''))
        FROM (SELECT md5(r::text) AS h FROM public.\"$t\" r) s")"
  done < <(tables "$db")
}

SRC_HASHES="$WORK/src.hashes"; table_hashes "$SRC"    > "$SRC_HASHES"
DST_HASHES="$WORK/dst.hashes"; table_hashes "$TARGET" > "$DST_HASHES"

# A psql that failed leaves an empty hash on *both* sides, and the diff below would then pass on
# two blanks — a clean round trip reported because neither database could be read. Two guards,
# because each catches what the other cannot: the line count catches a run that produced no rows
# at all (where an awk over nothing has nothing to object to), the pattern catches a row whose
# hash came back empty or as an error string.
for f in "$SRC_HASHES" "$DST_HASHES"; do
  got="$(wc -l < "$f" | tr -d ' ')"
  [ "$got" -eq "$TABLES" ] || {
    echo "FAIL: hashed $got tables, expected $TABLES — psql did not answer for all of them" >&2
    exit 1
  }
  awk 'NF != 2 || $2 !~ /^[0-9a-f]{32}$/ { print "  " $0; bad = 1 } END { exit bad + 0 }' "$f" || {
    echo "FAIL: a table hash did not come back (above) — the comparison proved nothing" >&2
    exit 1
  }
done

if ! diff -u "$SRC_HASHES" "$DST_HASHES"; then
  echo "FAIL: restored database holds different rows from the source" >&2
  exit 1
fi

ROWS="$(awk '{s+=$2} END {print s+0}' "$SRC_COUNTS")"
echo "OK: $TABLES tables, $ROWS rows, content identical after a full round trip"

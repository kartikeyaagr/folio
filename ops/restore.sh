#!/usr/bin/env bash
#
# Restore an encrypted dump into a database.
#
# Needs the age *private* key, which by design is not on the server that made the backup. Run this
# from wherever that key lives.
#
# Usage:  ./ops/restore.sh [--replace] <archive.dump.age> <target-database> <age-identity-file>
#
# **Refuses a database that already exists** unless you pass --replace, which drops it first. A
# restore is the operation people run under pressure, at the one moment a wrong target database
# name costs the most, and the default has to be the one that cannot destroy anything. Restoring
# on top of a live database was never going to work anyway — pg_restore --single-transaction dies
# on the first duplicate type — but it dies partway through with a constraint error, which reads
# as a corrupt archive rather than as "you named the wrong database".
set -euo pipefail

REPLACE=no
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --replace) REPLACE=yes ;;
    *) ARGS+=("$arg") ;;
  esac
done
# `${ARGS[@]+"${ARGS[@]}"}` rather than `"${ARGS[@]}"`: under `set -u`, the bash 3.2 that ships
# with macOS treats an empty array as unset and aborts with "unbound variable" — on the no-arguments
# path, where the point is to reach the usage message below.
set -- ${ARGS[@]+"${ARGS[@]}"}

ARCHIVE="${1:?usage: restore.sh [--replace] <archive.dump.age> <target-db> <age-identity-file>}"
TARGET="${2:?usage: restore.sh [--replace] <archive.dump.age> <target-db> <age-identity-file>}"
IDENTITY="${3:?usage: restore.sh [--replace] <archive.dump.age> <target-db> <age-identity-file>}"

for tool in pg_restore age createdb dropdb psql; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

# Asked of pg_database rather than by letting createdb fail: `createdb || true` cannot tell "it is
# already there" from "the server is not running", and swallowed both.
#
# The name goes in as a psql variable so psql quotes it, rather than pasted into the SQL. Fed on
# stdin, not with -c: -c hands the string straight to the server, so `:'db'` arrives literally and
# the server answers `syntax error at or near ":"`.
exists() {
  [ -n "$(psql -d postgres -tAX -v db="$1" <<<"SELECT 1 FROM pg_database WHERE datname = :'db'")" ]
}

if exists "$TARGET"; then
  [ "$REPLACE" = yes ] || {
    cat >&2 <<MSG
refusing: database "$TARGET" already exists.

A restore into a database that is already there is either the wrong target name or a deliberate
overwrite, and this script will not guess which. If you meant it:

  $0 --replace $ARCHIVE $TARGET $IDENTITY

which drops "$TARGET" and everything in it. If you did not, restore into a new name instead.
MSG
    exit 1
  }
  echo "--replace: dropping existing database $TARGET"
  dropdb "$TARGET"
fi

# From template1, which carries pgvector on the VM (ops/SETUP.md §4): the archive does not, because
# the restoring role could not create it (ops/backup.sh says why). IF NOT EXISTS returns before any
# permission check, so this is a no-op there, creates it on a laptop where the role is a superuser,
# and anywhere else fails here — naming the missing extension — rather than halfway into a restore.
createdb "$TARGET"
psql -q -d "$TARGET" -c 'CREATE EXTENSION IF NOT EXISTS vector'

# Decrypted straight into pg_restore: the plaintext dump never lands on disk here either.
age -d -i "$IDENTITY" "$ARCHIVE" \
  | pg_restore -d "$TARGET" --no-owner --no-privileges --single-transaction

# A database-level setting is not in a pg_dump archive, so a restored database comes back in the
# cluster's zone — UTC on the VM — and current_date answers yesterday before 05:30 IST (lesson
# L19). Reapplied here so a restore is a whole database, not most of one.
psql -q -d "$TARGET" -c "ALTER DATABASE \"$TARGET\" SET timezone = 'Asia/Kolkata'"

echo "restored $ARCHIVE into $TARGET"

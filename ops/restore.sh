#!/usr/bin/env bash
#
# Restore an encrypted dump into a database.
#
# Needs the age *private* key, which by design is not on the server that made the backup. Run this
# from wherever that key lives.
#
# Usage:  ./ops/restore.sh <archive.dump.age> <target-database> <age-identity-file>
set -euo pipefail

ARCHIVE="${1:?usage: restore.sh <archive.dump.age> <target-db> <age-identity-file>}"
TARGET="${2:?usage: restore.sh <archive.dump.age> <target-db> <age-identity-file>}"
IDENTITY="${3:?usage: restore.sh <archive.dump.age> <target-db> <age-identity-file>}"

for tool in pg_restore age createdb; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

createdb "$TARGET" 2>/dev/null || true

# Decrypted straight into pg_restore: the plaintext dump never lands on disk here either.
age -d -i "$IDENTITY" "$ARCHIVE" \
  | pg_restore -d "$TARGET" --no-owner --no-privileges --single-transaction

echo "restored $ARCHIVE into $TARGET"

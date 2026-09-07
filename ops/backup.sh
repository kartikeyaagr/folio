#!/usr/bin/env bash
#
# Nightly encrypted backup.
#
# Two properties, and both are the reason this script exists rather than a cron line calling
# pg_dump:
#
#   * The dump is encrypted **on this machine**, before anything leaves it. The storage provider
#     only ever holds ciphertext, which is what makes off-site storage compatible with keeping the
#     fund's data on our own box rather than a breach of it.
#   * Encryption is asymmetric on purpose. This machine holds only the age *public* key, so a
#     compromised box cannot decrypt its own history. The private half lives somewhere else
#     entirely — a password manager, not a server.
#
# pg_dump is piped straight into age, so the plaintext dump never touches the disk.
#
# Usage:  ./ops/backup.sh [database]
# Env:    BACKUP_AGE_RECIPIENT (required)  BACKUP_DIR  BACKUP_S3_BUCKET  BACKUP_S3_ENDPOINT
set -euo pipefail

DB="${1:-trisula}"
DIR="${BACKUP_DIR:-/var/lib/trisula/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="${DB}-${STAMP}.dump.age"

: "${BACKUP_AGE_RECIPIENT:?set BACKUP_AGE_RECIPIENT to the age public key}"

for tool in pg_dump age; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

mkdir -p "$DIR"

# -Fc is the custom format: compressed, and pg_restore can read a single table out of it.
pg_dump -d "$DB" -Fc --no-owner --no-privileges \
  | age -r "$BACKUP_AGE_RECIPIENT" -o "$DIR/$NAME"

SIZE="$(wc -c < "$DIR/$NAME" | tr -d ' ')"
echo "wrote $DIR/$NAME  (${SIZE} bytes, ciphertext)"

if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  ARGS=(s3 cp "$DIR/$NAME" "s3://${BACKUP_S3_BUCKET}/${NAME}")
  [ -n "${BACKUP_S3_ENDPOINT:-}" ] && ARGS+=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  aws "${ARGS[@]}" >/dev/null
  echo "uploaded to s3://${BACKUP_S3_BUCKET}/${NAME}"
fi

# Local copies are a convenience, not the backup. Keep a fortnight and let the object store hold
# the rest, so a full disk cannot take the box down.
find "$DIR" -name "${DB}-*.dump.age" -mtime +14 -delete

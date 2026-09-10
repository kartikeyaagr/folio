#!/usr/bin/env bash
#
# Mint the AWS-signed JWT that the Anthropic SDK exchanges for an access token (SETUP.md §10).
#
#   ./ops/refresh-identity-token.sh [path]     # default /run/trisula/identity-token
#
# This is the whole reason no model secret lives on this box. The instance role signs a token
# addressed to Anthropic; the SDK trades it at /v1/oauth/token and refreshes the *access* token by
# itself. What it cannot do is re-mint the *identity* token, which is what this script is for.
#
# /run, not /etc: tmpfs, so the token never reaches the disk and is gone on reboot. It is short
# lived and re-mintable, which is a different kind of thing from the age key or a password.
set -euo pipefail

OUT="${1:-/run/trisula/identity-token}"
AUD="https://api.anthropic.com"

# ES384 rather than RS256: same claims, roughly a fifth shorter on the wire, and both are minted
# from the same account issuer. Measured 09-Sep-2026 — 794 bytes against 1005.
TOKEN="$(aws sts get-web-identity-token \
  --audience "$AUD" --signing-algorithm ES384 \
  --query WebIdentityToken --output text)"

# Zero items is a failure, not a quiet day — the same rule the feeds are held to. An empty or
# malformed token written over a good one would present later as an auth error from Anthropic,
# one layer away from the cause.
case "$TOKEN" in
  *.*.*) : ;;
  *) echo "refresh-identity-token: not a JWT (got ${#TOKEN} chars)" >&2; exit 1 ;;
esac

install -d -m 0750 -o root -g trisula "$(dirname "$OUT")"
TMP="$(mktemp "${OUT}.XXXXXX")"
printf '%s' "$TOKEN" > "$TMP"
chown root:trisula "$TMP"
chmod 0640 "$TMP"
# Atomic. A reader that opens the file mid-write would otherwise get half a token, and half a
# token is indistinguishable at the far end from a revoked one.
mv -f "$TMP" "$OUT"

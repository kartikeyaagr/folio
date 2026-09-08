#!/usr/bin/env bash
#
# Can this AWS account create anything yet?
#
#   ./ops/check-activation.sh [profile]     # profile defaults to "trisula"
#
# Exit 0 = ready, provision.sh will get past preflight. 1 = not yet. 2 = cannot tell.
#
# Two checks, not one. `account get-account-information` is the cheap signal but not the gate:
# on 08-Sep-2026 this account answered IAM, STS and `account` normally — which is why the console
# looked healthy — while every EC2 call, read and write alike, returned OptInRequired. The gate is
# an actual EC2 read in the region we would build in. Both are reported, because the pair tells you
# WHICH failure you have: PENDING+OptInRequired is a waiting account, ACTIVE+OptInRequired is a
# service subscription that never completed, and those need different things from a support case.
set -uo pipefail

PROFILE="${1:-trisula}"
REGION="ap-south-1"

# A scheduled task or a systemd unit does not get the login shell's PATH.
AWS="$(command -v aws || true)"
[ -x "$AWS" ] || AWS="$HOME/.local/bin/aws"
[ -x "$AWS" ] || { echo "UNKNOWN  no aws cli on PATH"; exit 2; }

state="$("$AWS" --profile "$PROFILE" account get-account-information \
  --query 'AccountState' --output text 2>&1)" ||
  state="unreadable: $(printf '%s' "$state" | tr '\n' ' ' | sed 's/  */ /g; s/^ *//' | cut -c1-90)"

# The narrowest EC2 read there is. Costs nothing and needs no permissions beyond being subscribed.
if ec2out="$("$AWS" --profile "$PROFILE" ec2 describe-availability-zones --region "$REGION" \
      --query 'AvailabilityZones[0].ZoneName' --output text 2>&1)"; then
  ec2="ok ($ec2out)"
  ready=yes
else
  # "(OptInRequired) when calling the ..." -> "OptInRequired"
  ec2="$(printf '%s' "$ec2out" | sed -n 's/.*(\([A-Za-z]*\)).*/\1/p')"
  [ -n "$ec2" ] || ec2="$(printf '%s' "$ec2out" | tr '\n' ' ' | cut -c1-80)"
  ready=no
fi

if [ "$ready" = yes ]; then
  echo "READY    account=$state  ec2=$ec2  --  run: ./ops/provision.sh $PROFILE"
  exit 0
fi

case "$state" in
  unreadable*) echo "UNKNOWN  account=$state  ec2=$ec2"; exit 2 ;;
  *)           echo "WAITING  account=$state  ec2=$ec2"; exit 1 ;;
esac

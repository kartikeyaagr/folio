#!/usr/bin/env bash
#
# Provision the EC2 instance described in SETUP.md §1, plus the backup bucket and instance role
# from §7. Everything up to the point where you can SSH in; §2 onward is done on the box.
#
#   ./ops/provision.sh [profile]        # profile defaults to "trisula"
#
# Safe to re-run. Every step checks for what it would create and reuses it, so a half-finished run
# is resumed rather than duplicated. It will not reshape something that already exists into what
# the constants below describe — a key pair under this name that is not this laptop's key, or an
# instance launched with a different type, disk or role, is reported and the run stops, because
# quietly adopting a box somebody else built is how a file ends up describing a machine that does
# not exist.
#
# One deliberate exception, and it goes the safe way: ingress to port 22 is narrowed to the
# address this script is running from, and anything else that could reach 22 is revoked and
# named. The group's own description is "SSH from one operator address only", and leaving last
# month's address in place beside this month's was how that stopped being true.
set -euo pipefail

PROFILE="${1:-trisula}"
REGION="ap-south-1"           # §1. India, because the fund's data sits in India.
INSTANCE_TYPE="t4g.small"     # Graviton. Burstable suits a workload idle until 18:45.
VOLUME_GB=40
KEY_NAME="trisula"
PUBKEY="$HOME/.ssh/trisula.pub"
SG_NAME="trisula-vm"
ROLE_NAME="trisula-backup"
TAG="trisula"

aws() { command aws --profile "$PROFILE" "$@"; }
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

# --- Preflight ---------------------------------------------------------------------------------
# The whole of 08-Sep-2026 was lost to an account that looked fine in the console and was not
# subscribed to any service. Every EC2 call — read and write alike — returned OptInRequired. Check
# it once, here, rather than discovering it halfway through creating things.
say "preflight"
STATE="$(aws account get-account-information --query 'AccountState' --output text 2>/dev/null || echo UNKNOWN)"
[ "$STATE" = "ACTIVE" ] || die "account is $STATE, not ACTIVE. Nothing can be created until AWS finishes
activating it. Check the payment method, then open an account-activation support case."

# ACTIVE is necessary and not sufficient, and the gap between the two is hours wide. At 02:01 on
# 09-Sep-2026 this account was PENDING_ACTIVATION; by 09:00 it was ACTIVE with a PAID plan and
# every one of ec2, s3 and ssm still refusing — OptInRequired, NotSignedUp,
# SubscriptionRequiredException. Service subscriptions complete some time after the state flips.
# Probe the two services this script actually uses, because the alternative is dying at the AMI
# lookup with "AMI lookup returned ''", which reads as a broken parameter name and is not.
for probe in "ec2 describe-availability-zones --region $REGION" "s3api list-buckets"; do
  # shellcheck disable=SC2086
  err="$(aws $probe --query 'nonesuch' --output text 2>&1)" && continue
  die "account is ACTIVE but not subscribed to ${probe%% *} yet:
  $(printf '%s' "$err" | tr '\n' ' ' | sed 's/  */ /g')
This usually clears within a few hours of activation, with nothing to do but wait. Re-check with:
  ./ops/check-activation.sh $PROFILE"
done
echo "account state $STATE; ec2 and s3 both answering"

ACCOUNT="$(aws sts get-caller-identity --query 'Account' --output text)" || die "no credentials; run: aws login --profile $PROFILE"
[ -f "$PUBKEY" ] || die "no public key at $PUBKEY. Generate one with:
  ssh-keygen -t ed25519 -f ${PUBKEY%.pub} -C 'trisula-vm'"

# The SSH rule is written against wherever this script runs from, not a value pasted in weeks ago.
MYIP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
[[ "$MYIP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not determine this machine's public IP"
echo "account $ACCOUNT · region $REGION · ssh will be opened to $MYIP/32 only"

# --- AMI ---------------------------------------------------------------------------------------
# Canonical's published SSM parameter rather than a hard-coded ami-id: those are region-specific
# and go stale, and a stale AMI is a box that boots without the security updates of the last year.
say "resolving Ubuntu 24.04 arm64 AMI"
AMI="$(aws ssm get-parameter --region "$REGION" \
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id \
  --query 'Parameter.Value' --output text)"
[[ "$AMI" == ami-* ]] || die "AMI lookup returned '$AMI'"
echo "$AMI"

# --- Key pair ----------------------------------------------------------------------------------
# Imported, never created. `create-key-pair` has AWS generate the private half and hand it back
# over the wire; importing means the private key never leaves the laptop it was made on.
say "key pair"
# Compared by fingerprint, because a name is not an identity. `describe-key-pairs` succeeding says
# only that something called "trisula" exists in this region — not that it is the key on this
# laptop. Launching against somebody else's key pair produces an instance that boots, passes every
# status check, and cannot be logged into, and the error you get at that point is "Permission
# denied (publickey)", which reads as a problem with the local key rather than with the remote one.
#
# Every spelling, accepted on any, because AWS records the fingerprint differently per key type
# and its own two documents disagree for RSA: `aws ec2 describe-key-pairs help` says an imported
# RSA key is "the MD5 public key fingerprint as specified in section 4 of RFC4716" — the MD5 of
# the SSH wire blob, which `ssh-keygen -E md5` prints — while the console's verify-a-fingerprint
# page gives the MD5 of the DER public key. For ed25519, the key the die above tells you to make,
# both say the base64 SHA-256 that `ssh-keygen -l` prints. Matching on any of the three is a match
# on the same key material; picking one and being wrong is a false alarm on the right key.
fingerprints() {
  ssh-keygen -l -f "$1"        | awk '{print $2}' | sed 's/^SHA256://'
  ssh-keygen -l -E md5 -f "$1" | awk '{print $2}' | sed 's/^MD5://'
  # Converted to a file first, and hashed only if the conversion produced anything. ssh-keygen
  # cannot convert ed25519 to PKCS8 at all — "unsupported key type ED25519" — and piping that
  # failure straight into openssl hashes an empty stream, which yields
  # d4:1d:8c:d9:8f:00:b2:04:e9:80:09:98:ec:f8:42:7e for every ed25519 key on earth — the md5 of
  # the empty string, wearing the shape of a fingerprint. The first draft of this check printed
  # exactly that in its mismatch message, 21-Sep-2026.
  local der; der="$(mktemp)"
  ssh-keygen -e -m PKCS8 -f "$1" 2>/dev/null | openssl pkey -pubin -outform DER >"$der" 2>/dev/null || true
  if [ -s "$der" ]; then openssl md5 -c <"$der" | awk '{print $NF}'; fi
  rm -f "$der"
}
LOCAL_FPS="$(fingerprints "$PUBKEY")"
REMOTE_FP="$(aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" \
  --query 'KeyPairs[0].KeyFingerprint' --output text 2>/dev/null || true)"

if [ -z "$REMOTE_FP" ] || [ "$REMOTE_FP" = "None" ]; then
  aws ec2 import-key-pair --region "$REGION" --key-name "$KEY_NAME" \
    --public-key-material "fileb://$PUBKEY" >/dev/null
  echo "imported $KEY_NAME from $PUBKEY"
elif printf '%s\n' "$LOCAL_FPS" | grep -qxF "$REMOTE_FP"; then
  echo "$KEY_NAME already imported, and its fingerprint is $PUBKEY's"
else
  die "key pair $KEY_NAME exists in $REGION and is NOT $PUBKEY:
  AWS holds  $REMOTE_FP
  $PUBKEY is $(printf '%s' "$LOCAL_FPS" | tr '\n' ' ')
Somebody imported a different key under this name, or this is not the laptop that imported it.
Nothing was changed. Either import the local key under a different KEY_NAME, or — after checking
that no running instance depends on it — delete the AWS key pair and re-run."
fi

# --- Security group ----------------------------------------------------------------------------
# SSH from one address. Nothing else: the web app binds to loopback and is reached over Tailscale,
# so there is deliberately no 443 here. Adding one is a decision, not a default.
#
# No apostrophe in the description. EC2 accepts only [a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*] and rejects
# the rest with InvalidParameterValue; "the operator's address" failed here on the first real run,
# 09-Sep-2026, after the key pair had already been imported.
say "security group"
SG="$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=group-name,Values=$SG_NAME" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [ "$SG" = "None" ] || [ -z "$SG" ]; then
  SG="$(aws ec2 create-security-group --region "$REGION" --group-name "$SG_NAME" \
    --description "Trisula VM: SSH from one operator address only" \
    --query 'GroupId' --output text)"
  echo "created $SG"
else
  echo "reusing $SG"
fi

sg_rules() {  # one JMESPath filter, applied to this group's rules
  aws ec2 describe-security-group-rules --region "$REGION" \
    --filters "Name=group-id,Values=$SG" --query "$1" --output text
}

# Replaced, not added to. The old version authorized the new address and printed a NOTE that
# earlier rules were left in place — advice nobody had to act on, so every address this laptop has
# ever had stayed on port 22. A home connection renumbers on a router reboot; a year of those is a
# list of strangers' addresses with SSH open, and the group's own description one screen up
# promises "SSH from one operator address only".
#
# Authorize first, revoke second. The other order shuts the door before opening it, and a failure
# between the two leaves a box nobody can reach.
WANTED="SecurityGroupRules[?!IsEgress && CidrIpv4=='$MYIP/32' && IpProtocol=='tcp' && FromPort==\`22\` && ToPort==\`22\`]"
if sg_rules "$WANTED.SecurityGroupRuleId" | grep -q .; then
  echo "ssh from $MYIP/32 already allowed"
else
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" \
    --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$MYIP/32,Description=operator}]" >/dev/null
  echo "allowed ssh from $MYIP/32"
fi

# Everything else that can reach 22: another CIDR, an IPv6 range, a referenced group, a port range
# that spans 22 without naming it. The `-1` arm is the all-protocols rule, which carries FromPort
# -1 and so is invisible to any numeric range test — the one an audit misses.
STALE="SecurityGroupRules[?!IsEgress && CidrIpv4!='$MYIP/32' && (IpProtocol=='-1' || (FromPort<=\`22\` && ToPort>=\`22\`))]"
STALE_IDS="$(sg_rules "$STALE.SecurityGroupRuleId")"
if [ -n "$STALE_IDS" ]; then
  echo "revoking ingress to port 22 from anywhere that is not $MYIP/32:"
  sg_rules "$STALE.[SecurityGroupRuleId,IpProtocol,FromPort,ToPort,CidrIpv4,CidrIpv6]"
  # Unquoted on purpose: --security-group-rule-ids takes a list, and --output text separates them.
  # shellcheck disable=SC2086
  aws ec2 revoke-security-group-ingress --region "$REGION" --group-id "$SG" \
    --security-group-rule-ids $STALE_IDS >/dev/null
fi

# --- Backup bucket -----------------------------------------------------------------------------
# §7: versioned, no public access. The account id makes the name globally unique without leaking
# anything a bucket name does not already reveal to whoever can list it.
BUCKET="trisula-backups-${ACCOUNT}"
say "backup bucket s3://$BUCKET"
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "already exists"
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  echo "created"
fi
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" >/dev/null
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled >/dev/null
echo "public access blocked, versioning on"

# --- Instance role -----------------------------------------------------------------------------
# PutObject on this bucket and nothing else. No keys on disk, and a compromised box can add
# archives it cannot read back — which is the whole point of encrypting to a key it does not hold.
say "instance role $ROLE_NAME"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" --description "Trisula VM: write backups to $BUCKET" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  echo "created role"
else
  echo "role exists"
fi
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name backup-put-only \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:PutObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\"}]}" >/dev/null
aws iam get-instance-profile --instance-profile-name "$ROLE_NAME" >/dev/null 2>&1 || {
  aws iam create-instance-profile --instance-profile-name "$ROLE_NAME" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE_NAME" --role-name "$ROLE_NAME" >/dev/null
  echo "created instance profile; waiting for IAM to propagate"
  sleep 10
}
echo "scoped to s3:PutObject on $BUCKET only"

# --- Instance ----------------------------------------------------------------------------------
say "instance"
EXISTING="$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=$TAG" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[0].InstanceId' --output text 2>/dev/null || true)"
if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
  ID="$EXISTING"
  echo "reusing $ID — this script will not launch a second one. Terminate it first if you want a rebuild."

  # Reusing means inheriting whatever the box actually is, which is not necessarily what the
  # constants at the top of this file say. The settings compared here are each load-bearing
  # somewhere else in the setup: §7's backup story assumes the instance profile is attached, §1
  # assumes the root volume is encrypted, and IMDSv2 is what keeps a request-forgery bug on the
  # web app from reading the role's credentials. An instance that predates any of those decisions
  # would be adopted silently and then relied on, so compare, report every difference at once
  # rather than one per re-run, and stop without changing anything.
  IFS=$'\t' read -r CUR_TYPE CUR_PROFILE CUR_SGS CUR_TOKENS CUR_ROOTDEV <<<"$(
    aws ec2 describe-instances --region "$REGION" --instance-ids "$ID" --output text \
      --query 'Reservations[0].Instances[0].[InstanceType, IamInstanceProfile.Arn,
                 join(`,`, SecurityGroups[].GroupId), MetadataOptions.HttpTokens, RootDeviceName]')"
  ROOT_VOL="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$ID" --output text \
    --query "Reservations[0].Instances[0].BlockDeviceMappings[?DeviceName=='$CUR_ROOTDEV'].Ebs.VolumeId | [0]")"
  IFS=$'\t' read -r CUR_GB CUR_VTYPE CUR_ENC <<<"$(
    aws ec2 describe-volumes --region "$REGION" --volume-ids "$ROOT_VOL" --output text \
      --query 'Volumes[0].[Size,VolumeType,Encrypted]')"

  DIFFS=()
  [ "$CUR_TYPE" = "$INSTANCE_TYPE" ]      || DIFFS+=("instance type is $CUR_TYPE, wanted $INSTANCE_TYPE")
  [ "${CUR_PROFILE##*/}" = "$ROLE_NAME" ] || DIFFS+=("instance profile is ${CUR_PROFILE##*/}, wanted $ROLE_NAME")
  [ "$CUR_SGS" = "$SG" ]                  || DIFFS+=("security groups are $CUR_SGS, wanted $SG and nothing else")
  [ "$CUR_GB" = "$VOLUME_GB" ]            || DIFFS+=("root volume is ${CUR_GB}GB, wanted ${VOLUME_GB}GB")
  [ "$CUR_VTYPE" = gp3 ]                  || DIFFS+=("root volume is $CUR_VTYPE, wanted gp3")
  [ "$CUR_ENC" = True ]                   || DIFFS+=("root volume is not encrypted")
  [ "$CUR_TOKENS" = required ]            || DIFFS+=("IMDS HttpTokens is $CUR_TOKENS, wanted required (IMDSv2)")
  [ ${#DIFFS[@]} -eq 0 ] || die "instance $ID is not the instance this script would have launched:
$(printf '  - %s\n' "${DIFFS[@]}")
Nothing was changed. Bring it into line by hand, or terminate it and re-run to get the instance
described at the top of this file."
  echo "matches: $INSTANCE_TYPE, ${VOLUME_GB}GB encrypted gp3, $SG, $ROLE_NAME, IMDSv2 required"
else
  ID="$(aws ec2 run-instances --region "$REGION" \
    --image-id "$AMI" --instance-type "$INSTANCE_TYPE" --key-name "$KEY_NAME" \
    --security-group-ids "$SG" \
    --iam-instance-profile "Name=$ROLE_NAME" \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$VOLUME_GB,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}" \
    --metadata-options "HttpTokens=required,HttpEndpoint=enabled" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$TAG}]" \
    --query 'Instances[0].InstanceId' --output text)"
  echo "launched $ID"
fi

aws ec2 wait instance-running --region "$REGION" --instance-ids "$ID"
IP="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
[ -n "$IP" ] && [ "$IP" != "None" ] || die "instance $ID is running but has no public IP"

cat <<EOF

Done.

  instance   $ID  ($INSTANCE_TYPE, $VOLUME_GB GB gp3, encrypted)
  address    $IP
  bucket     s3://$BUCKET
  role       $ROLE_NAME  (s3:PutObject on that bucket only)

  ssh -i ${PUBKEY%.pub} ubuntu@$IP

Next: SETUP.md §2 onward, on the box. Put $BUCKET — the bare name, no s3:// — in
BACKUP_S3_BUCKET at §6, because backup.sh builds "s3://\${BACKUP_S3_BUCKET}/\${NAME}". Generate the
age keypair at §7 on your laptop — the server only ever gets the public half.
EOF

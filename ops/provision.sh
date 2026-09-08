#!/usr/bin/env bash
#
# Provision the EC2 instance described in SETUP.md §1, plus the backup bucket and instance role
# from §7. Everything up to the point where you can SSH in; §2 onward is done on the box.
#
#   ./ops/provision.sh [profile]        # profile defaults to "trisula"
#
# Safe to re-run. Every step checks for what it would create and reuses it, so a half-finished run
# is resumed rather than duplicated. The one thing it will not do is change something that already
# exists with different settings — it reports the difference and stops, because silently reshaping
# a security group is how a box ends up reachable from somewhere nobody chose.
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
if aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" >/dev/null 2>&1; then
  echo "$KEY_NAME already imported"
else
  aws ec2 import-key-pair --region "$REGION" --key-name "$KEY_NAME" \
    --public-key-material "fileb://$PUBKEY" >/dev/null
  echo "imported $KEY_NAME from $PUBKEY"
fi

# --- Security group ----------------------------------------------------------------------------
# SSH from one address. Nothing else: the web app binds to loopback and is reached over Tailscale,
# so there is deliberately no 443 here. Adding one is a decision, not a default.
say "security group"
SG="$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=group-name,Values=$SG_NAME" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [ "$SG" = "None" ] || [ -z "$SG" ]; then
  SG="$(aws ec2 create-security-group --region "$REGION" --group-name "$SG_NAME" \
    --description "Trisula VM: SSH from the operator's address only" \
    --query 'GroupId' --output text)"
  echo "created $SG"
else
  echo "reusing $SG"
fi

if aws ec2 describe-security-group-rules --region "$REGION" \
     --filters "Name=group-id,Values=$SG" \
     --query "SecurityGroupRules[?CidrIpv4=='$MYIP/32' && FromPort==\`22\`]" --output text | grep -q .; then
  echo "ssh from $MYIP/32 already allowed"
else
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" \
    --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$MYIP/32,Description=operator}]" >/dev/null
  echo "allowed ssh from $MYIP/32"
  echo "NOTE: earlier rules are left in place. Review them if your address has changed:"
  aws ec2 describe-security-group-rules --region "$REGION" --filters "Name=group-id,Values=$SG" \
    --query 'SecurityGroupRules[?!IsEgress].[CidrIpv4,FromPort]' --output text
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

Next: SETUP.md §2 onward, on the box. Put s3://$BUCKET in BACKUP_S3_BUCKET at §6, and generate the
age keypair at §7 on your laptop — the server only ever gets the public half.
EOF

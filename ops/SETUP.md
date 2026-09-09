# Setting up the VM

Everything Trisula needs on one box: Postgres, the web app, seven scheduled jobs, and encrypted
backups going off-site. Written to be followed top to bottom in one sitting; expect about an hour,
most of it waiting for installs.

**Two separate things are called "AWS" here.** The EC2 instance the system runs on (§1–§8), and the
Claude Platform on AWS credentials the agents use (§9). They are unrelated and you can do §9 later.

Before you start you need: an AWS account, a domain or Tailscale, and a password manager you trust
with one secret that must never touch the server.

---

## 1. The instance

Graviton (ARM) in **Mumbai**, because the fund's data should sit in India and the exchange is
milliseconds away.

| | |
|---|---|
| Region | `ap-south-1` (Mumbai) |
| Type | `t4g.small` — 2 vCPU, 2 GB. Enough for 3 users, 40 names, end-of-day |
| AMI | Ubuntu 24.04 LTS, **arm64** |
| Storage | 40 GB gp3 |
| Key pair | **Import your own.** `ssh-keygen -t ed25519 -f ~/.ssh/trisula`, then import the `.pub` |

**Import rather than download.** Creating the key pair in the console has AWS generate your private
key and hand it back over a browser download. Generating it on the laptop and importing only the
public half means the private key never exists anywhere but your own disk — the same property §7
insists on for the backup key, for the same reason.

`t4g` is burstable and this workload is bursty by nature — idle most of the day, busy at 18:45.
If the ingest ever feels slow, `t4g.medium` is a stop-and-restart away, not a rebuild.

**Security group.** Inbound: SSH (22) from your IP only. Nothing else, if you use Tailscale.
If you want the web app on the public internet instead, add 443 and put a reverse proxy in front —
but Tailscale is fewer moving parts and no certificate to renew.

```bash
ssh -i ~/.ssh/trisula ubuntu@<public-ip>
```

## 2. System packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential age unzip

# backup.sh calls `aws s3 cp`. apt ships v1; this is v2, for Graviton.
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp && sudo /tmp/aws/install && aws --version
```

`age` is the backup encryption. It must be present before §7, and the AWS CLI before the first
nightly upload — without it `backup.sh` writes the local copy and then fails at the `aws` call.

## 3. Node 22+ and pnpm

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable && corepack prepare pnpm@latest --activate
node --version && pnpm --version
```

Node 22 is the floor. The code runs TypeScript natively with no build step, which is why the
version matters more than it usually would.

## 4. Postgres 18

```bash
sudo sh -c 'echo "deb https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list'
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor \
  -o /etc/apt/trusted.gpg.d/postgresql.gpg
sudo apt update && sudo apt install -y postgresql-18
sudo systemctl enable --now postgresql
psql --version
```

**Leave it on the unix socket.** Nothing external connects to this database, so it needs no TCP
listener and therefore has no network surface to defend.

```bash
sudo -u postgres createuser --createdb trisula
sudo -u postgres createdb --owner=trisula trisula
```

## 5. The application user and code

```bash
# NOT --create-home: it fills /srv/trisula from /etc/skel, and `git clone` into a
# non-empty directory is a fatal error. The clone needs the directory empty.
sudo useradd --system --home-dir /srv/trisula --shell /bin/bash trisula
sudo mkdir -p /srv/trisula /var/lib/trisula/{backups,attachments} /etc/trisula
sudo chown -R trisula:trisula /srv/trisula /var/lib/trisula
```

The repo is **private**, so the box needs its own credential. Use a **read-only deploy key**: it
reaches this one repo and cannot write to it. Keep it outside the repo directory, or the clone has
the same non-empty-target problem.

```bash
sudo ssh-keygen -t ed25519 -f /etc/trisula/deploy_key -N "" -C "trisula-vm"
sudo chown trisula:trisula /etc/trisula/deploy_key /etc/trisula/deploy_key.pub
cat /etc/trisula/deploy_key.pub
```

Add that public key to the repo under **Settings → Deploy keys → Add deploy key**, with *Allow
write access* left unchecked. A personal access token in the clone URL also works and is worse: it
grants everything the token can reach, and it persists in `git remote -v` and in shell history.

```bash
export GSC='ssh -i /etc/trisula/deploy_key -o IdentitiesOnly=yes'
sudo -u trisula GIT_SSH_COMMAND="$GSC" \
  git clone git@github.com:kartikeyaagr/trisula-v3.git /srv/trisula

# Persist it, so `git pull` on later deploys uses the same key.
sudo -u trisula git -C /srv/trisula config core.sshCommand "$GSC"

cd /srv/trisula
sudo -u trisula pnpm install --frozen-lockfile
```

## 6. Environment

```bash
sudo tee /etc/trisula/trisula.env >/dev/null <<'EOF'
DATABASE_URL=postgres:///trisula
TZ=Asia/Kolkata

# Backups — the PUBLIC half only. See §7.
BACKUP_AGE_RECIPIENT=
BACKUP_DIR=/var/lib/trisula/backups
BACKUP_S3_BUCKET=
BACKUP_S3_ENDPOINT=

# Mail. Without SMTP_HOST and SMTP_FROM, `lib/notify.ts` returns null and the outbox fills without
# draining — every alert, reminder and finished backfill becomes a row nobody is told about. That is
# a valid state and no job fails over it, but it is the difference between the system telling you
# something happened and you going to look. SMTP_USER and SMTP_PASSWORD are optional; a relay on
# the same private network usually needs neither.
SMTP_HOST=
SMTP_PORT=587
SMTP_FROM=trisula@yourdomain
SMTP_USER=
SMTP_PASSWORD=

# Set to 1 ONLY if a reverse proxy on this box rewrites x-forwarded-for. Under Tailscale with no
# proxy, leave it unset: the header would then be whatever the client typed, and a rate-limit key
# the caller chooses lets them both evade the limit and lock somebody else out of the login page.
TRUST_PROXY_HEADER=

# Agents — see §9. Leave blank until then; agent runs will queue and retry.
ANTHROPIC_AWS_WORKSPACE_ID=
AWS_REGION=ap-south-1
EOF
sudo chown root:trisula /etc/trisula/trisula.env
sudo chmod 640 /etc/trisula/trisula.env
```

`640 root:trisula` means the app can read it and cannot rewrite it.

## 7. Backup keys — the one step to get right

Encryption is **asymmetric on purpose**. The server holds only the public half, so a compromised
server cannot decrypt its own history. That property is the whole reason off-site backups are
compatible with keeping the fund's data on your own box.

**Generate the keypair on your laptop, not on the server.**

```bash
# On your laptop:
age-keygen -o trisula-backup.key
age-keygen -y trisula-backup.key      # prints the public key, age1...
```

Then:

1. Put `trisula-backup.key` (the **private** half) in your password manager. Not on the server, not
   in the repo, not in a note. Without it every backup is unreadable ciphertext forever.
2. Put the **public** key in `BACKUP_AGE_RECIPIENT` in `/etc/trisula/trisula.env`.
3. Delete the private key file from your laptop's disk once it is in the password manager.

> A backup you cannot decrypt is not a backup. Test the restore path from wherever that key lives,
> at least once, before you rely on it. See §11.

**S3 for off-site copies.** Create a bucket in `ap-south-1`, block all public access, enable
versioning. Attach an instance role to the EC2 instance with `s3:PutObject` on that bucket and
nothing else — no keys on disk. Set `BACKUP_S3_BUCKET` in the env file.

## 8. The web app

```bash
cd /srv/trisula
pnpm install --frozen-lockfile
pnpm build

sudo cp ops/systemd/trisula-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trisula-web
curl -sS localhost:3100/api/health
```

It binds to `127.0.0.1:3100` and nothing else. Reaching it is Tailscale's job, or a reverse proxy
on this same box — never a public listener with a firewall in front, because that is one
misconfiguration away from the fund's positions being on the internet.

`pnpm build` runs on the VM rather than being shipped as an artefact: the tree is small, the build
is under a minute, and a box that can rebuild itself is a box that can be recovered from git alone.

Accounts are created in §11, **after** the migrations run. Seeding here would fail: there is no
`users` table yet.

## 9. Schedules

```bash
cd /srv/trisula
sudo cp ops/systemd/*.service ops/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload

sudo systemctl enable --now \
  trisula-refresh-securities.timer \
  trisula-ingest-intraday.timer \
  trisula-ingest-eod.timer \
  trisula-ingest-fundamentals.timer \
  trisula-ingest-calendar.timer \
  trisula-ingest-insider.timer \
  trisula-ingest-shareholding.timer \
  trisula-ingest-corporate-actions.timer \
  trisula-news-poll.timer \
  trisula-news-gate.timer \
  trisula-agents.timer \
  trisula-alerts.timer \
  trisula-backup.timer \
  trisula-backup-verify.timer

systemctl list-timers 'trisula-*'
```

Every unit carries `TZ=Asia/Kolkata`. Every time in this system is IST and every date it computes
is an Indian trading date; inheriting the box's timezone is how a reporting period silently moves
a day.

## 10. Claude Platform on AWS (the agents)

Separate from everything above, and skippable until you want agents running.

1. Subscribe to Claude on the AWS Marketplace and note the **workspace id**.
2. Put it in `ANTHROPIC_AWS_WORKSPACE_ID`, with `AWS_REGION=ap-south-1`.
3. Credentials come from the ordinary AWS chain, so the instance role is enough — no secret on disk.

**The presence of the workspace id is what selects the backend.** There is deliberately no second
"which backend" setting, because a setting can disagree with the credentials actually present, and
that failure reads as an auth error at the far end rather than as the misconfiguration it is.

**This is not Amazon Bedrock**, which is a different product: prefixed model ids, and no structured
outputs on Opus 5 or Sonnet 5. Every agent here passes a schema, so Bedrock would not work.

The alternative is a plain `ANTHROPIC_API_KEY`, used when no workspace id is set. One or the other,
never both.

## 11. First run

Order matters — each step needs the one before it.

```bash
cd /srv/trisula
sudo -u trisula bash -c 'set -a; . /etc/trisula/trisula.env; set +a; pnpm migrate'

# The security master. Nothing can add a company before this.
sudo -u trisula bash -c 'set -a; . /etc/trisula/trisula.env; set +a; \
  pnpm exec tsx jobs/refresh-securities.ts'

# Three accounts. There is no signup route; this is the only way one exists.
# Prints a TEMPORARY PASSWORD and eight recovery codes, ONCE. Put them in the password manager.
# Note: nothing in the app can change that password yet, and no route redeems a recovery code —
# both functions exist in lib/auth.ts with no caller. Until that is wired, the seeded password
# IS the password. Audited 08-Sep-2026.
sudo -u trisula bash -c 'set -a; . /etc/trisula/trisula.env; set +a; \
  pnpm exec tsx jobs/seed-user.ts --email you@trisulacapital.com --name "Your Name"'
```

Then add the names you follow, and let the timers fill in filings, prices and results.

## 12. Prove it works

```bash
# The restore drill: dump, encrypt, decrypt, restore to a scratch database, compare row by row.
sudo -u trisula /srv/trisula/ops/verify-backup.sh trisula
```

Expect `OK: N tables, M rows, identical after a full round trip`. **If this does not pass, stop and
fix it before putting real data in.** An untested restore is not a backup.

Then, separately and by hand, from wherever the private key lives:

```bash
# On your laptop, with the real key. Proves the actual archive is readable, which the on-box
# drill deliberately cannot: it uses a throwaway key precisely because the real one is not there.
aws s3 cp s3://<bucket>/<latest>.dump.age .
./ops/restore.sh <latest>.dump.age scratch_check ~/trisula-backup.key
```

## 13. Day-to-day

```bash
systemctl list-timers 'trisula-*'              # what runs when
journalctl -u trisula-job@ingest-eod -n 50     # what one job did
sudo -u trisula psql -d trisula -c \
  "SELECT source, status, items, detail FROM ingestion_runs ORDER BY id DESC LIMIT 10"
pnpm exec tsx jobs/requeue.ts                  # what failed, and put it back
```

A failed unit records itself via `OnFailure=`, so a failure is noticed by the machine rather than
by someone happening to read the journal.

---

## Still to decide

- **Where the age private key lives.** §7 says a password manager; write down which one, so the
  next person to need it does not have to guess.
- **A heartbeat recipient.** The design calls for an outward ping every five minutes whose *absence*
  alerts. Nothing is named yet, so nothing would notice a dead box. healthchecks.io or Better Stack;
  a free tier covers it.
- **Whether the web app is on Tailscale or the public internet.** Tailscale needs no certificate and
  no port 443. Recommended until there is a reason otherwise.

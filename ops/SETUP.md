# Setting up the VM

Everything Folio needs on one box: Postgres, the web app, 19 scheduled jobs, and encrypted
backups going off-site. Written to be followed top to bottom in one sitting; expect about an hour,
most of it waiting for installs.

**Two separate things are called "AWS" here.** The EC2 instance the system runs on (§1–§8), and the
AWS identity the agents federate with to reach Claude (§10). §10 can be left until later, but they
are **not** independent: §10 works by pinning an Anthropic-side rule to this instance's exact IAM
role ARN and attaching a token-minting policy to that same role. Rebuild the box under a different
role, or rename the one it has, and the agents stop authenticating — with a `401` that says nothing
about roles. §10 is the only place that dependency is written down.

**AWS still says `trisula`.** The system was called Trisula until 28-Sep-2026. The key pair,
security group, bucket, instance role and its policies kept that name, because IAM roles and
buckets cannot be renamed and the role is the one §10 pins. Everything on the box says `folio`. A
box set up before the rename is moved across once, by §15.

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

## 3. Node 22.18+ and pnpm

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
node --version && pnpm --version
```

Node 22.18 is the floor — the release that made type stripping default. The code runs TypeScript
natively with no build step, which is why the version matters more than it usually would.

pnpm is pinned by `packageManager` in `package.json` and corepack reads it, so `corepack enable` is
the whole step. Do not `corepack prepare pnpm@latest --activate`: it pins the provisioning date
rather than a version, so two VMs built six months apart resolve different pnpm majors.

## 4. Postgres 18

```bash
sudo sh -c 'echo "deb https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list'
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor \
  -o /etc/apt/trusted.gpg.d/postgresql.gpg
sudo apt update && sudo apt install -y postgresql-18 postgresql-18-pgvector
sudo systemctl enable --now postgresql
psql --version
```

**`postgresql-18-pgvector` is not optional.** Migration
`0040_the_system_can_be_asked_what_it_holds.sql` runs `CREATE EXTENSION IF NOT EXISTS vector`, and
`chunks.embedding` is `vector(384)`. Without the package that migration fails, so `pnpm migrate` in
§11 — the first command of first run — dies at 40 of 62 with a half-built schema. It is on the same
PGDG repo the line above just added, so it costs nothing to install now and an afternoon to discover
later.

**Installing the package is not enough: the extension has to be created by `postgres`, in
`template1`.** pgvector is not a *trusted* extension — its control file has no `trusted = true` —
so only a superuser can `CREATE EXTENSION vector`, and `folio` is deliberately not one. Created in
`template1`, every database made after it inherits the extension: `folio` itself, so migration
0040's `CREATE EXTENSION IF NOT EXISTS` finds it and moves on, and every database `ops/restore.sh`
and the weekly drill create, which is the only way a backup can be restored at all (`ops/backup.sh`
leaves the extension out of the dump for this reason). Until 25-Sep-2026 this check ran in the
`postgres` database, which proved the package was installed and created nothing the app could use.
Run it before `createdb` below — and on a box built before that date, run it now:

```bash
sudo -u postgres psql -d template1 -c 'CREATE EXTENSION IF NOT EXISTS vector' -c '\dx vector'
```

**Leave it on the unix socket.** Nothing external connects to this database, and the app reaches it
through `/var/run/postgresql`. The package's default `listen_addresses = 'localhost'` also opens
`127.0.0.1:5432`, which is loopback and unreachable from off the box; never widen it.

```bash
sudo -u postgres createuser --createdb folio
sudo -u postgres createdb --owner=folio folio
sudo -u postgres psql -c "ALTER DATABASE folio SET timezone = 'Asia/Kolkata'"
```

**The database's timezone is not optional either, and `TZ` on the units does not set it.** `initdb`
copies the box's zone, which on an EC2 image is UTC, and the date arithmetic is in SQL
(`current_date`), so a UTC database answers with yesterday's date for every Indian clock time before
05:30 — a reminder not yet due, a window a day early (lesson L19). This line was applied by hand on
the first box on 09-Sep-2026 and was missing from here until 25-Sep; `pnpm preflight` now checks it.

## 5. The application user and code

```bash
# NOT --create-home: it fills /srv/folio from /etc/skel, and `git clone` into a
# non-empty directory is a fatal error. The clone needs the directory empty.
sudo useradd --system --home-dir /srv/folio --shell /bin/bash folio
sudo mkdir -p /srv/folio /var/lib/folio/{backups,attachments} /etc/folio
sudo chown -R folio:folio /srv/folio /var/lib/folio
```

### The embedding model

The agents' retrieval runs a local model; nothing is sent to a vendor. Two files, ~130MB:

```bash
sudo mkdir -p /var/lib/folio/models/bge-small-en-v1.5
cd /var/lib/folio/models/bge-small-en-v1.5

# Pinned to a commit, not to `main`. `/resolve/main` is a moving reference — the repo owner can
# push to it whenever — and a model that moves is every vector in `chunks` needing a rebuild.
# `ops/fetch-model.sh` pins the same revision; change one and you change both.
rev=5c38ec7c405ec4b44b94cc5a9bb96e735b38267a
base="https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/$rev"

# -f and -S, not the bare -s this used to have. Without -f, curl writes an HTTP error page into
# the output file and still exits 0, so a proxy's 403 becomes a 400-byte file called model.onnx
# and the next thing to notice is ONNX failing deep inside a matmul.
sudo curl -fsSL -o model.onnx     "$base/onnx/model.onnx" || echo "model.onnx DID NOT DOWNLOAD"
sudo curl -fsSL -o tokenizer.json "$base/tokenizer.json"  || echo "tokenizer.json DID NOT DOWNLOAD"

# Then check what arrived, because a download that finished is not a download that is right.
# Both lines must say OK. If either does not, delete that file and run its curl again.
[ "$(wc -c <model.onnx)" = 133093490 ] && echo "model.onnx: OK" || echo "model.onnx: FAILED (wrong size)"
echo 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66  tokenizer.json' | sha256sum -c -

sudo chown -R folio:folio /var/lib/folio/models
```

Not vendored in the repo: 130MB of binary in git costs every clone forever, and this file never
changes — if it did, every vector in `chunks` would need rebuilding, which is a migration and not
a download.

The repo is **private**, so the box needs its own credential. Use a **read-only deploy key**: it
reaches this one repo and cannot write to it. Keep it outside the repo directory, or the clone has
the same non-empty-target problem.

```bash
sudo ssh-keygen -t ed25519 -f /etc/folio/deploy_key -N "" -C "folio-vm"
sudo chown folio:folio /etc/folio/deploy_key /etc/folio/deploy_key.pub
cat /etc/folio/deploy_key.pub
```

Add that public key to the repo under **Settings → Deploy keys → Add deploy key**, with *Allow
write access* left unchecked. A personal access token in the clone URL also works and is worse: it
grants everything the token can reach, and it persists in `git remote -v` and in shell history.

```bash
export GSC='ssh -i /etc/folio/deploy_key -o IdentitiesOnly=yes'
sudo -u folio GIT_SSH_COMMAND="$GSC" \
  git clone git@github.com:kartikeyaagr/folio.git /srv/folio

# Persist it, so `git pull` on later deploys uses the same key.
sudo -u folio git -C /srv/folio config core.sshCommand "$GSC"

cd /srv/folio
sudo -u folio pnpm install --frozen-lockfile
```

## 6. Environment

```bash
sudo tee /etc/folio/folio.env >/dev/null <<'EOF'
DATABASE_URL=postgres:///folio
TZ=Asia/Kolkata

# Where this box is reached. `app/logout/route.ts` redirects here after signing out and falls back
# to http://localhost:3100 when it is unset — which is correct on a laptop and sends everybody to a
# dead tab on the VM. Under Tailscale (§8a) this is the MagicDNS name.
APP_URL=https://folio.<your-tailnet>.ts.net

# Backups — the PUBLIC half only. See §7.
BACKUP_AGE_RECIPIENT=
BACKUP_DIR=/var/lib/folio/backups
BACKUP_S3_BUCKET=
BACKUP_S3_ENDPOINT=

# Mail. Without SMTP_HOST and SMTP_FROM, `lib/notify.ts` returns null and the outbox fills without
# draining — every alert, reminder and finished backfill becomes a row nobody is told about. That is
# a valid state and no job fails over it, but it is the difference between the system telling you
# something happened and you going to look. SMTP_USER and SMTP_PASSWORD are optional; a relay on
# the same private network usually needs neither.
SMTP_HOST=
SMTP_PORT=587
SMTP_FROM=folio@yourdomain

# The dead man's switch. `jobs/heartbeat.ts` POSTs here every fifteen minutes, and ONLY when
# Postgres answers — so a database outage stops the ping rather than reporting through it. The
# alarm is the monitor noticing the silence, which is why this is the one signal that survives the
# box being off. Unset is valid and the job says so instead of failing; it is also the state in
# which nothing would notice a dead box. healthchecks.io or Better Stack; a free tier covers it.
HEARTBEAT_URL=
SMTP_USER=
SMTP_PASSWORD=

# Set to 1 ONLY if a reverse proxy on this box rewrites x-forwarded-for. Under Tailscale with no
# proxy, leave it unset: the header would then be whatever the client typed, and a rate-limit key
# the caller chooses lets them both evade the limit and lock somebody else out of the login page.
TRUST_PROXY_HEADER=

# Per-person mailboxes (§9b). 32 bytes, base64: `openssl rand -base64 32`. Without it, linking a
# personal mailbox refuses outright — there is no path that stores an SMTP password in the clear,
# and that is the correct failure. Everything else still works and digests go out over the shared
# relay above. This value is NOT in a database backup, so it belongs wherever
# BACKUP_AGE_RECIPIENT's private half lives.
MAILBOX_KEY=

# Agents — the model credential.
#
# `lib/agents/client.ts` selects a backend by which variable is PRESENT, in this order:
# ANTHROPIC_FEDERATION_RULE_ID, then ANTHROPIC_AWS_WORKSPACE_ID, then ANTHROPIC_API_KEY. With none
# of them it throws NoModelCredentials naming what is missing, rather than failing as a 401 from
# the far end.
#
# A plain key is what this box ships with, because federation (§10) cannot be completed until an
# Anthropic organization with a payment method exists, and until one does the agents do not run at
# all. It is a secret on disk — so is SMTP_PASSWORD above, and so is MAILBOX_KEY — and
# this file is 640 root:folio precisely so that it can hold them. §10 is the upgrade path and
# moving to it is one line here plus one timer.
#
# Left blank rather than commented, unlike the federation block below, and the difference is not
# an oversight: `chosenBackend` tests this one for truthiness, so an empty string is exactly as
# absent as no line at all, and the SDK is never constructed from it unless that test passed. It
# can therefore sit here as a slot to fill. The federation variables cannot — they are read
# straight into the SDK's config.
ANTHROPIC_API_KEY=

# Federation, once §10 is done. Setting ANTHROPIC_FEDERATION_RULE_ID is what switches the backend,
# and `client.ts` passes apiKey: null explicitly in that branch so the line above cannot shadow it.
# Delete the ANTHROPIC_API_KEY line anyway once federation works, so there is one credential and
# not two.
#
# Commented rather than left blank, deliberately. For a credential variable, empty is not the same
# as absent: an exported empty string still occupies its slot in the SDK's precedence chain, so a
# blank line here would select a credential path with nothing in it and fail as a 401 instead of
# falling through.
#ANTHROPIC_FEDERATION_RULE_ID=
#ANTHROPIC_ORGANIZATION_ID=
#ANTHROPIC_SERVICE_ACCOUNT_ID=
#ANTHROPIC_IDENTITY_TOKEN_FILE=/run/folio/identity-token
#ANTHROPIC_WORKSPACE_ID=
EOF
sudo chown root:folio /etc/folio/folio.env
sudo chmod 640 /etc/folio/folio.env
```

`640 root:folio` means the app can read it and cannot rewrite it.

## 7. Backup keys — the one step to get right

Encryption is **asymmetric on purpose**. The server holds only the public half, so a compromised
server cannot decrypt its own history. That property is the whole reason off-site backups are
compatible with keeping the fund's data on your own box.

**Generate the keypair on your laptop, not on the server.**

```bash
# On your laptop:
age-keygen -o folio-backup.key
age-keygen -y folio-backup.key      # prints the public key, age1...
```

Then:

1. Put `folio-backup.key` (the **private** half) in your password manager. Not on the server, not
   in the repo, not in a note. Without it every backup is unreadable ciphertext forever.
2. Put the **public** key in `BACKUP_AGE_RECIPIENT` in `/etc/folio/folio.env`.
3. Delete the private key file from your laptop's disk once it is in the password manager.

> A backup you cannot decrypt is not a backup. Test the restore path from wherever that key lives,
> at least once, before you rely on it. See §12, "Prove it works".

**S3 for off-site copies.** Create a bucket in `ap-south-1`, block all public access, enable
versioning. Attach an instance role to the EC2 instance with `s3:PutObject` on that bucket and
nothing else — no keys on disk. Set `BACKUP_S3_BUCKET` in the env file.

## 8. The web app

```bash
cd /srv/folio
pnpm install --frozen-lockfile
pnpm build

sudo cp ops/systemd/folio-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now folio-web
curl -sS localhost:3100/api/health
```

It binds to `127.0.0.1:3100` and nothing else. Reaching it is Tailscale's job, or a reverse proxy
on this same box — never a public listener with a firewall in front, because that is one
misconfiguration away from the fund's positions being on the internet.

`pnpm build` runs on the VM rather than being shipped as an artefact: the tree is small, the build
is under a minute, and a box that can rebuild itself is a box that can be recovered from git alone.

`pnpm build` needs **outbound network**, which is easy to miss on a box whose whole premise is that
it does not accept any: `app/layout.tsx` loads Geist through `next/font/google`, which downloads the
files at build time and self-hosts them afterwards. Egress is enough — the box never needs an
inbound port for this.

Accounts are created in §11, **after** the migrations run. Seeding here would fail: there is no
`users` table yet.

## 8a. Tailscale — how anybody reaches it

The app binds `127.0.0.1:3100` and nothing else, so on its own it is reachable from the box and
nowhere. Tailscale is named throughout this runbook as the answer and was never actually installed
here; this is that step. It is recommended over a public listener with a certificate for three
reasons: no port 443, no certificate to renew, and no day on which a firewall rule is the only thing
between the fund's positions and the internet.

```bash
curl -fsSL https://tailscale.com/install.sh | sh

# --ssh lets you reach this box without the EC2 key pair, which means §1's security-group rule for
# port 22 can later be removed entirely. Do that only once you have signed in over Tailscale once.
sudo tailscale up --ssh --hostname=folio
```

Then put the app on the tailnet, with a certificate Tailscale issues and renews itself:

```bash
# MagicDNS and HTTPS certificates both have to be on for the tailnet, in the admin console under
# DNS. `tailscale serve` fails with a clear message if they are not.
sudo tailscale serve --bg 3100
tailscale serve status        # prints the https://folio.<tailnet>.ts.net URL
```

That URL is what goes in `APP_URL` in §6. It is also what the three of you open — no VPN client
beyond Tailscale itself, no port forwarding, and the box stays unreachable from the internet.

**`TRUST_PROXY_HEADER` stays unset under this topology**, and §6 says why: `tailscale serve` is a
reverse proxy but Next sets `x-forwarded-for` with `??=`, so trusting the header hands the
rate-limit key to whoever is calling — which lets them both evade the limit on `/login` and lock
somebody else out of it.

Confirm from a second machine on the tailnet, not from the box:

```bash
curl -sS https://folio.<tailnet>.ts.net/api/health      # {"ok":true}
```

## 9. Schedules

```bash
cd /srv/folio
sudo cp ops/systemd/*.service ops/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload

sudo systemctl enable --now \
  folio-refresh-securities.timer \
  folio-ingest-intraday.timer \
  folio-ingest-eod.timer \
  folio-ingest-fundamentals.timer \
  folio-ingest-calendar.timer \
  folio-ingest-insider.timer \
  folio-ingest-shareholding.timer \
  folio-ingest-corporate-actions.timer \
  folio-news-poll.timer \
  folio-news-gate.timer \
  folio-agents.timer \
  folio-index-content.timer \
  folio-backfill-company.timer \
  folio-distil-rules.timer \
  folio-alerts.timer \
  folio-backup.timer \
  folio-backup-verify.timer \
  folio-heartbeat.timer

# Not a timer: a long-running watcher. `addCompany` announces on `folio_backfill` inside the
# transaction that inserts the row, so a name followed at 10:02 starts fetching at 10:02 rather
# than at 10:10. The timer above stays enabled and is still the guarantee — a NOTIFY with nobody
# listening is discarded, and this unit being down is exactly when that happens.
sudo systemctl enable --now folio-backfill-watch.service

systemctl list-timers 'folio-*'
systemctl status folio-backfill-watch
```

One unit is not a timer and is enabled separately, because it stays up:

```bash
sudo systemctl enable --now folio-index-watch.service
systemctl status folio-index-watch
```

It listens on the `trisula_content` channel that migration `0052` makes `documents`,
`document_versions` and `attachments` announce on, and indexes within seconds of a save rather than
within ten minutes of one. **It does not replace `folio-index-content.timer` and enabling it is
not a reason to disable that.** A `NOTIFY` with no listener attached is dropped and nothing replays
it, so the watcher is a latency improvement and never the guarantee; the durable queue is
`sources.indexed_at IS NULL` and the timer is what promises it drains. Skipping the watcher costs
ten minutes of staleness. Skipping the timer eventually costs a document.

**Three of those were unit files nobody enabled**, found on 11-Sep-2026 while adding the third.
`index-content` shipped with R1 and `backfill-company` with `676b375` — the commit that *fixed*
`v4.md`'s opening audit finding, which was a queue with a correct drainer and no timer. The timer
was written and this list was not updated, so the queue still drained only when somebody typed the
command. Count this list against `ls ops/systemd/*.timer` before believing it; a unit file is not a
schedule.

Every unit carries `TZ=Asia/Kolkata`. Every time in this system is IST and every date it computes
is an Indian trading date; inheriting the box's timezone is how a reporting period silently moves
a day.

## 9a. Mail (the daily digest)

Everybody signed in gets **one email a morning** at their own address — alerts, reminders, job
failures and what is waiting in the review queue, gathered into one envelope by `lib/digest.ts` and
sent by agent 4 shortly after 07:00 IST. Per-event mail was dropped on 17-Sep-2026 (`0054`): a
person gets one envelope a day and never more.

The fund's mail is on **Hostinger**, which speaks SMTP with STARTTLS on 587 and AUTH LOGIN — which
is exactly what `smtpSender` in `lib/notify.ts` already does, so there is nothing to build. Five
variables in `/etc/folio/folio.env`:

```bash
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=587
SMTP_USER=desk@trisulacapital.com      # a real mailbox, not an alias
SMTP_PASSWORD=…                        # that mailbox's password
SMTP_FROM=desk@trisulacapital.com      # Hostinger rejects a From: that is not the authenticated box
```

`SMTP_FROM` must be the authenticated mailbox. Hostinger refuses to relay for any other sender, and
the refusal arrives as a 5xx on `MAIL FROM` — which lands in `notification_outbox.last_error`
rather than anywhere obvious, so check there first if nothing arrives.

**No relay configured is a valid state and not a failure — for the digest.** `smtpFromEnv()` returns
null without `SMTP_HOST` and `SMTP_FROM`, the outbox keeps queueing, and the run says how many
digests are waiting. Nothing is lost by leaving this unset; mail simply starts flowing the day it is
set.

**The daily news brief needs this same relay, and is not as forgiving** (`0067`). From 08:00 IST,
`jobs/agents.ts` writes the brief, queues it for every active user, and sends it there and then
through the shared relay — never a linked personal mailbox, which was linked on the promise that it
carries only its own owner's digest. With `SMTP_HOST`/`SMTP_FROM` unset, or a send the relay refuses,
`jobs/agents.ts` itself fails, visibly, rather than leaving the brief to queue quietly the way the
digest does: a brief nobody could be sent must not look like a quiet morning.

Check it end to end without waiting for 07:00:

```bash
sudo -u folio bash -c 'set -a; . /etc/folio/folio.env; set +a; \
  pnpm exec tsx jobs/agents.ts 1'
psql -d folio -c "select kind, recipient, sent_at, attempts, last_error from notification_outbox
                     order by queued_at desc limit 10"
```

A row with `sent_at` set went out. A row with `attempts` climbing and a `last_error` did not, and
the error is the relay's own words.

### 9b. `MAILBOX_KEY` — a person's own mailbox

A person can link their own mailbox from the account menu, and their daily update then leaves from
their own company address instead of the shared relay. It passes their domain's SPF and DKIM, and
there is no shared `desk@` box whose password three people know.

That means storing an SMTP password that can be turned back into what was typed — **the first
reversible secret in this system**, against `password_hash` (Argon2id) and session tokens (sha256),
neither of which can be. `lib/mailbox.ts` keeps the exception narrow, and the key is the part that
lives here:

```bash
MAILBOX_KEY=$(openssl rand -base64 32)    # 32 bytes, base64. Put the value in folio.env.
```

Four things worth knowing before you set it:

- **Without it, linking refuses.** There is no path that stores a mailbox password in the clear.
  The feature is simply unavailable until the key exists, which is the correct failure.
- **It is not in a database backup.** `ops/backup.sh` dumps Postgres; the key is in
  `/etc/folio/folio.env`. Restoring a dump onto a box with a different key leaves every stored
  mailbox unopenable — which is the point, and why the env file belongs in whatever holds
  `BACKUP_AGE_RECIPIENT`.
- **Rotating it orphans every linked mailbox.** They are not lost silently: `open()` raises,
  `lib/digest.ts` records the reason against the mailbox, falls back to the shared relay, and each
  person sees "the last send through it failed" in their account menu with a re-link button. Plan a
  rotation as "everybody re-links", not as a migration.
- **Nothing reads mail.** There is no IMAP here. The credential is used for exactly one thing —
  sending that person their own digest — and `lib/digest.ts` is its only reader.

A person links it themselves at **account menu → Link your mailbox**. Saving sends a real test
message to the address and stores nothing unless it arrives, so a mailbox that is listed as linked
has carried something at least once.

## 10. The model credential (the agents)

Separate from everything above. Steps 1–3 are account-wide and done once; 4 onward is per-box.

**Read this first: the box ships on a key, and this section is the upgrade.**

`lib/agents/client.ts` supports three backends and picks by which variable is present —
`ANTHROPIC_FEDERATION_RULE_ID`, then `ANTHROPIC_AWS_WORKSPACE_ID`, then `ANTHROPIC_API_KEY`. §6
sets the last of those, and it is what the agents run on today, because **everything from step 2
onward here is blocked on an Anthropic organization with a payment method, which does not exist**.
Until one does, this section cannot be completed by anybody, and a box that waits for it has six
agents that queue, fail and retry forever.

So the order is: ship on the key, come back here. What the upgrade buys is real and worth coming
back for — no model secret on the box, so a copy of the disk is not a copy of the credential — but
it buys nothing on a box that is not running.

**The key is not a new class of secret on this box.** `/etc/folio/folio.env` is `640
root:folio` and already holds `SMTP_PASSWORD`, `MAILBOX_KEY` and `BACKUP_AGE_RECIPIENT`; the
difference federation makes is narrower than "secrets on disk or not" — it is one fewer, and the
one that bills. Moving is one line in §6 plus one timer in step 4, and `client.ts` passes
`apiKey: null` explicitly in the federation branch so the old line cannot shadow the new one while
you switch.

### 0. Why not Claude Platform on AWS, and why not Bedrock

Both were tried and both are shut, for one reason. Claude Platform on AWS bills through **AWS
Marketplace**, and this account signed up via *Sign up for AWS (new)*, where Marketplace is
documented as **"Bedrock and Free only"** — a paid third-party listing is neither. The Console
reports the refusal as:

> Setup failed. AWS account registration is incomplete or revoked.

which reads like something the operator left unfinished. It is not: CERT-In customer verification
passed on 09-Sep-2026 and the message did not change.

Amazon Bedrock is closed by the same gate, which was not obvious — modern Bedrock model access is
itself a Marketplace agreement. Measured in `ap-south-1`:

| model | agreement | authorization | entitlement | region |
|---|---|---|---|---|
| `anthropic.claude-opus-5` | **NOT_AVAILABLE** | AUTHORIZED | AVAILABLE | AVAILABLE |
| `anthropic.claude-sonnet-5` | **NOT_AVAILABLE** | AUTHORIZED | AVAILABLE | AVAILABLE |
| `anthropic.claude-3-5-sonnet-20240620-v1:0` | **NOT_AVAILABLE** | AUTHORIZED | AVAILABLE | AVAILABLE |

Everything is available except the agreement. **Do not reach for "Activate advanced features" to
open this** — it does lift the Marketplace bar, and it is irreversible, permanently removes the
ability to set a spend limit, and hands you the organization's policies to maintain.

Workload identity federation reaches the ordinary first-party API, needs no Marketplace, and keeps
the no-secret-on-disk property. Same per-token rates ($5/$25 Opus 5, $2/$10 Sonnet 5, $1/$5 Haiku
4.5 — the figures already in `PRICING`), same structured outputs, same bare model ids. What changes
is the invoice: Anthropic bills in USD by card rather than AWS India in INR, and inference calls
stop appearing in CloudTrail.

### 1. Turn on outbound web identity federation (once per account)

`sts:GetWebIdentityToken` is **off by default on every AWS account**.

```bash
aws iam enable-outbound-web-identity-federation
aws iam get-outbound-web-identity-federation-info   # expect "JwtVendingEnabled": true
```

Done for 577483323158 on 09-Sep-2026. Note the `IssuerIdentifier` it prints — step 2 needs it:

```
https://a1a35b2f-51f2-4502-b771-abda46039a49.tokens.sts.global.api.aws
```

Confirm the account can actually mint one before going further. This returns a JWT whose `sub` is
whatever principal called it and whose `aud` is Anthropic:

```bash
aws sts get-web-identity-token --audience https://api.anthropic.com --signing-algorithm ES384
```

### 2. Three things in the Anthropic Console (once, Console only)

There is no CLI for these — federation issuers and rules are OAuth-only endpoints and the first
rule has to be created by a person. In the Claude Console, under the organization's settings:

1. A **service account** — the identity the agents run as. Note its `svac_…` id.
2. A **federation issuer** trusting the AWS issuer URL from step 1.
3. A **federation rule** binding that issuer to that service account. Note its `fdrl_…` id.
   Match on `sub` = the **instance role ARN**, not a prefix:
   `arn:aws:iam::577483323158:role/trisula-backup`. A trailing `*` would match every role in the
   account. Audience is `https://api.anthropic.com`.

   Set the rule's **OAuth scope to `workspace:inference`**. The wizard offers `workspace:developer`,
   which is the same access a workspace API key has: Messages, but also Files and Skills.
   `workspace:inference` is Messages, token counting and Models — which is the whole of what this
   system does, since every agent goes through `askModel` and `askModel` only ever calls
   `messages.create`. The cost of the narrower scope is that adding Files or Skills later means
   widening the rule, and the symptom of forgetting is a 403 from an endpoint that worked in
   development. Set `token_lifetime_seconds` to `600`; an agent run is minutes.

Also note the organization's UUID. That organization needs a payment method — this is where the
usage is billed, and it is the one thing this route adds that the AWS route did not.

### 3. Let the instance role mint tokens

```bash
aws iam put-role-policy --role-name trisula-backup \
  --policy-name trisula-identity-token \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "sts:GetWebIdentityToken",
      "Resource": "*"
    }]
  }'
```

`trisula-backup` is the instance profile already attached to `i-055f70b1b15723f9b`. It keeps its
`backup-put-only` policy; this is a second, separate one, so each says what it is for.

### 4. Keep the token fresh

The SDK refreshes the *access* token itself. It cannot re-mint the *identity* token, which is what
the timer is for. `/run`, not `/etc` — tmpfs, so the token never reaches the disk.

```bash
sudo cp ops/systemd/folio-identity-token.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now folio-identity-token.timer
sudo systemctl start folio-identity-token.service     # do not wait for the first tick
sudo ls -l /run/folio/identity-token                  # expect 0640 root:folio
```

### 5. Tell the box

In `/etc/folio/folio.env`:

```
ANTHROPIC_FEDERATION_RULE_ID=fdrl_…
ANTHROPIC_ORGANIZATION_ID=…                       # the org UUID
ANTHROPIC_SERVICE_ACCOUNT_ID=svac_…
ANTHROPIC_IDENTITY_TOKEN_FILE=/run/folio/identity-token
ANTHROPIC_WORKSPACE_ID=wrkspc_…                   # see below
```

`ANTHROPIC_WORKSPACE_ID` is only *required* when the rule from step 2 is enabled in more than one
workspace — with a single-workspace rule the server picks that one. Set it regardless. It is what
the minted token is scoped to, so it decides which workspace's rate limits apply and which one the
spend is attributed to, and leaving it implicit means that answer lives in a Console setting
instead of in this file. The failure when a multi-workspace rule meets a request with no workspace
id is the same opaque `401 Authentication failed` as everything else, logged as
`workspace_id_required` on the History page.

**Leave `ANTHROPIC_API_KEY` unset, here and in every shell that runs a job.** `apiKey` defaults to
`process.env['ANTHROPIC_API_KEY']` and outranks the federation config, so a stray key does not
fail — it silently authenticates as itself and bills whoever owns it.
`lib/agents/client.ts` passes `apiKey: null` explicitly to close that, and a test asserts it, but
do not rely on that being the only path a key could take.

Presence of `ANTHROPIC_FEDERATION_RULE_ID` is what selects the backend. There is deliberately no
second "which backend" setting: a setting can disagree with the credentials actually present, and
that failure arrives as a 401 from the far end rather than as the misconfiguration it is.

### 6. What is not yet proven

Honest state as of 10-Sep-2026. The code path is tested (`lib/agents/client.test.ts`, including
that a stray key cannot shadow federation). **Nothing from step 2 onward has been run**: there is
no Anthropic organization yet, so no rule id exists, and the policy in step 3 is unapplied. In
particular the refresh timer's ten-minute interval is a guess sitting inside any plausible token
lifetime, not a measurement — mint a token on the box, read its `exp`, and set the interval to a
third of what is left.

While that token is decoded, **check whether it carries a `jti`**, because that decides whether the
interval has a second constraint on it. An identity token with a `jti` may be exchanged exactly
once per issuer; presenting the same assertion twice is refused, and the refusal arrives as the
same opaque `401 Authentication failed` as everything else, with the reason `jti_reused` visible
only on the Console's **Workload identity → History** page. The SDK re-reads
`ANTHROPIC_IDENTITY_TOKEN_FILE` on every refresh, so if the token carries a `jti` and the file has
not changed since the last exchange, the refresh fails — and so does a process restart, which
re-presents a token it already spent. In that case the timer has to rotate the file faster than the
SDK refreshes, not merely faster than the token expires, and the two are not the same number.
Anthropic's own AWS guidance takes the other route for exactly this reason: it hands the SDK a
function that calls STS on each refresh rather than a path to read. If the timer turns out to be
racing the refresh, that is the fix, and it is a change to `lib/agents/client.ts` rather than to
this runbook.

## 11. First run

Order matters — each step needs the one before it.

```bash
cd /srv/folio
sudo -u folio bash -c 'set -a; . /etc/folio/folio.env; set +a; pnpm migrate'

# The security master. Nothing can add a company before this.
sudo -u folio bash -c 'set -a; . /etc/folio/folio.env; set +a; \
  pnpm exec tsx jobs/refresh-securities.ts'

# The FIRST account. /signup only records a request, and --email/--name is the bootstrap: it has to
# exist before anybody can request one. Every account after this is created from an approved
# request instead, with `--request <id>` off the row on /admin, so that no applicant's own text
# is ever assembled into a command anybody pastes into this shell.
# Prints a TEMPORARY PASSWORD and eight recovery codes, ONCE. Put them in the password manager.
# The holder changes that password from the avatar menu, and redeems a code at /reset if they lose
# it — the code plus the address sets a new password and signs out every session. Somebody who has
# lost the password AND all eight codes still needs a person with shell access to re-issue them.
sudo -u folio bash -c 'set -a; . /etc/folio/folio.env; set +a; \
  pnpm exec tsx jobs/seed-user.ts --email you@trisulacapital.com --name "Your Name"'

# Make that first account an admin. NOT optional, and it is a separate step because `seed-user.ts`
# creates ordinary accounts — `users.is_admin` defaults false and nothing in the sign-up path ever
# sets it. Skipped, the box is bricked in a way that looks like a design: /admin and /agents both
# redirect to /, so the only account cannot approve an access request, which means NO SECOND USER
# CAN EVER BE CREATED THROUGH THE UI. It also cannot toggle an agent or a feed, or requeue a failed
# run. Nothing hints at it either: components/Rail.tsx relabels the hub "Review" for non-admins,
# so the panel does not appear to exist rather than appearing to be locked.
sudo -u folio bash -c 'set -a; . /etc/folio/folio.env; set +a; \
  pnpm exec tsx jobs/set-admin.ts --email you@trisulacapital.com'

# Confirm. `admin` in the left column is the thing to see.
sudo -u folio bash -c 'set -a; . /etc/folio/folio.env; set +a; \
  pnpm exec tsx jobs/set-admin.ts --list'
```

Then check the box against this runbook before you trust it:

```bash
sudo -u folio bash -c 'set -a; . /etc/folio/folio.env; set +a; pnpm preflight'
```

It reads and changes nothing, exits non-zero on anything wrong, and separates what it checked and
found wrong from what it *could not check* — so a check that could not run never reads as a pass.
Everything §4 through §11 asked for is in it.

Then add the names you follow, and let the timers fill in filings, prices and results.

## 12. Prove it works

```bash
# The restore drill: dump, encrypt, decrypt, restore to a scratch database, compare row counts
# and per-table content hashes.
sudo -u folio /srv/folio/ops/verify-backup.sh folio
```

Expect `OK: N tables, M rows, content identical after a full round trip`. **If this does not pass,
stop and fix it before putting real data in.** An untested restore is not a backup.

Then, separately and by hand, from wherever the private key lives:

```bash
# On your laptop, with the real key. Proves the actual archive is readable, which the on-box
# drill deliberately cannot: it uses a throwaway key precisely because the real one is not there.
aws s3 cp s3://<bucket>/<latest>.dump.age .
./ops/restore.sh <latest>.dump.age scratch_check ~/folio-backup.key
```

`restore.sh` refuses a database that already exists — a wrong target name costs the most at exactly
the moment you are least able to afford it. If `scratch_check` is left over from the last time you
did this, either drop it or pass `--replace` before the archive name, which drops it for you.

Then sign in, from a second machine on the tailnet, at the `https://folio.<tailnet>.ts.net` URL.
Nothing short of this proves the path a person takes, and three things can fail only here:

- **The session cookie is `__Host-` and `Secure` in production.** Over anything but HTTPS the
  browser drops it, and sign-in silently loops back to `/login`.
- **Login is a server action, and Next refuses every server action whose `Origin` does not match
  the `Host` or `X-Forwarded-Host` it receives.** `tailscale serve` is the proxy in between. If
  sign-in fails with "Invalid Server Actions request" in `journalctl -u folio-web`, the proxy
  is not passing the host through. Nothing on a laptop can check this.
- **Import a PDF over 10 MB** from any company page, and see it land as a document. Next refuses
  an action body over 1 MB and truncates any body over 10 MB that passes through the middleware,
  and `next.config.ts` raises both. A build missing either fails here with the error page, and the
  journal says `Body exceeded` or `Request body exceeded 10MB`.

```bash
curl -sI https://folio.<tailnet>.ts.net/login | grep -i -E 'strict-transport|content-security'
```

Both headers should be present. `Strict-Transport-Security` is sent only by a production build.

## 13. Day-to-day

```bash
systemctl list-timers 'folio-*'              # what runs when
journalctl -u folio-job@ingest-eod -n 50     # what one job did
sudo -u folio psql -d folio -c \
  "SELECT source, status, items, detail FROM ingestion_runs ORDER BY id DESC LIMIT 10"
pnpm exec tsx jobs/requeue.ts                  # what failed, and put it back
```

A failed unit records itself via `OnFailure=` and queues a notice to the admins, so a failure is
noticed by the machine rather than by someone happening to read the journal. The notice only
*leaves* the box once `SMTP_HOST` and `SMTP_FROM` are set in §6.

---

## 14. Deploying a change

Every step is safe to repeat, so run all of them; skipping the one that mattered is how a box ends
up serving old code against a new schema.

```bash
cd /srv/folio
sudo -u folio git pull

# Only if package.json changed, but harmless otherwise.
sudo -u folio pnpm install --frozen-lockfile

# Migrations first, then the build. They are one transaction each and checksummed, so a re-run
# applies nothing and a tampered file refuses rather than running twice.
sudo -u folio bash -c 'set -a; . /etc/folio/folio.env; set +a; pnpm migrate'
sudo -u folio pnpm build

# New or changed units. Copying is cheap; working out which changed is not.
sudo cp ops/systemd/*.service ops/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload

sudo systemctl restart folio-web
curl -sS localhost:3100/api/health

# Everything §4-§11 asked for, checked rather than remembered. Exits 1 on anything wrong, 2 on
# anything it could not check.
sudo -u folio bash -c 'set -a; . /etc/folio/folio.env; set +a; pnpm preflight'
```

**A new timer is not enabled by copying it.** `systemctl enable --now <name>.timer` for anything
added since the last deploy — §9 lists the full set, and `systemctl list-timers 'folio-*'`
against that list is the check. `pnpm preflight` reads `ops/systemd/` and reports any timer in it
that is not enabled, which is the same check without the list to keep in step.

**A changed `OnCalendar=` on an already-enabled timer is not picked up by copying it either.**
`daemon-reload` reparses the unit file, but a timer already running keeps the next elapse it last
computed from the old one; the new schedule takes effect only after `systemctl restart <name>.timer`.
`folio-news-poll.timer` is exactly this case as of 28-Sep-2026 — hourly, around the clock, in place
of the old two-hourly daytime window — so this deploy needs `sudo systemctl restart
folio-news-poll.timer` after the `cp` and `daemon-reload` above, and `systemctl list-timers
folio-news-poll.timer` afterward should show the next elapse inside the hour, not the old window.

Order matters in one direction only: migrations before the restart. The app reads columns the
migration adds, so a restart first serves a build that queries a schema it does not have yet.

### When a deploy goes wrong

There is no `down` migration and there deliberately never will be: the runner refuses an edited
file and applies each one exactly once, and a reverse migration is a second, less-tested schema
change written under time pressure. **So rolling back code and rolling back schema are different
operations, and only one of them is cheap.**

```bash
# Code only. Safe whenever the schema did not move — which is most deploys.
cd /srv/folio
sudo -u folio git log --oneline -5          # find the last good commit
sudo -u folio git checkout <sha>
sudo -u folio pnpm install --frozen-lockfile && sudo -u folio pnpm build
sudo systemctl restart folio-web
```

An older build against a newer schema is usually the safe direction — extra columns are simply
unread. Not always: a newer migration that added a `NOT NULL` column with no default, a trigger or
a `CHECK` will refuse the older code's inserts, so read what the migrations since `<sha>` did before
relying on it. The checkout leaves the repo on a detached HEAD; `sudo -u folio git checkout main`
before the next §14 deploy, or its `git pull` fails.

**If a migration is the thing that is wrong, restore; do not improvise.** §12's drill is the
rehearsal for exactly this. Restore *beside* production, look at it, then swap names. Never
`--replace` the live database: `restore.sh` drops the target before it decrypts, so any failure
after that — a key the `folio` user cannot read, a missing extension — leaves an empty database
where production was.

```bash
# 1. Beside production. Nothing is dropped, so a failure here costs nothing. The private key comes
#    onto the box for this and leaves straight after (§7): `folio` cannot read your home directory.
sudo install -o folio -m 400 ~/folio-backup.key /tmp/restore.key
sudo -u folio /srv/folio/ops/restore.sh <archive>.dump.age folio_restored /tmp/restore.key
sudo shred -u /tmp/restore.key

# 2. Look before trusting it: the last migration it carries, and a table you know.
sudo -u folio psql -d folio_restored -c 'SELECT max(filename) FROM schema_migrations'

# 3. Swap, with everything that writes stopped. The broken database is renamed, not dropped.
sudo systemctl stop folio-web 'folio-*.timer' folio-index-watch folio-backfill-watch \
  'folio-job@*'
sudo -u folio psql -d postgres -c 'ALTER DATABASE folio RENAME TO folio_broken' \
  -c 'ALTER DATABASE folio_restored RENAME TO folio'
sudo systemctl start folio-web folio-index-watch folio-backfill-watch 'folio-*.timer'
```

Stop the timers *and* any job already running (`folio-job@*`): a job that runs mid-swap writes
into the wrong database, and the `ingestion_runs` row it leaves makes the gap look like a quiet day
rather than an outage. `restore.sh` reapplies the database's timezone, which a dump does not carry
and a rename keeps. `pnpm preflight` afterwards checks it, with everything else. Drop
`folio_broken` once the restored database has run a day.

## 15. Once: a box set up before the rename

The first deploy that carries the rename replaces §14 with this. §14's `cp` would put the `folio-*`
units in beside the enabled `trisula-*` ones, and both would run.

```bash
sudo systemctl stop 'trisula-*'          # timers, web, both watchers, any job mid-run
sudo -u trisula git -C /srv/trisula pull
sudo bash /srv/trisula/ops/rename-box.sh
```

It renames the user, the directories, the env file, the database and its role, the Tailscale node
and `APP_URL`, and the units. Then it installs, migrates, builds, and re-enables exactly the units
that were enabled before. The header of `ops/rename-box.sh` lists what it leaves alone. It is safe
to re-run if it stops partway. Afterwards the app answers at `https://folio.<tailnet>.ts.net`, and
everyone signs in once more, because the session cookie's name changed with the system's.

---

## Still to decide

Two settled on 23-Sep-2026 and moved into the runbook rather than deleted, so that a decision is
not mistaken for something nobody thought about:

- ~~**Whether the web app is on Tailscale or the public internet.**~~ **Tailscale**, and §8a is now
  the step rather than a recommendation — install, `tailscale serve`, and the MagicDNS name goes in
  `APP_URL`.
- ~~**Which Anthropic organization the agents bill to.**~~ Still true that §10 cannot be completed
  without one — but it no longer blocks the deploy. §6 ships `ANTHROPIC_API_KEY` and §10 is the
  documented upgrade to take when the organization exists.

Genuinely open:

- **Where the age private key lives.** §7 says a password manager; write down which one, so the
  next person to need it does not have to guess. `pnpm preflight` checks the recipient is
  well-formed and cannot check that it is the right one — only §12's laptop-side restore can, and
  only if somebody can find the key.
- **A heartbeat URL.** `jobs/heartbeat.ts` and `folio-heartbeat.timer` exist and ping every
  fifteen minutes; `HEARTBEAT_URL` in §6 is empty, so nothing is listening and nothing would notice
  a dead box. Create a check on healthchecks.io or Better Stack — a free tier covers it — and paste
  its URL in. Set the monitor's grace period above fifteen minutes. `pnpm preflight` reports this
  as a note every time it runs, so it stays visible rather than being forgotten.
- **An Anthropic organization and its payment method**, to finish §10. The usage then lands on an
  Anthropic invoice in USD rather than on the AWS India INR bill, and the key leaves the disk.
- **Three `OnCalendar=` expressions have never been validated on Linux** —
  `folio-ingest-fundamentals`, `folio-news-poll` and `folio-distil-rules` were rewritten from
  `systemd.time(7)` and macOS has no `systemd-analyze` to check them with. First thing to run on
  the box: `systemd-analyze calendar '<expression>'` for each, and compare the next elapse against
  what §9 says it should be.

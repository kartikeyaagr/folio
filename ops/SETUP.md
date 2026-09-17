# Setting up the VM

Everything Trisula needs on one box: Postgres, the web app, 19 scheduled jobs, and encrypted
backups going off-site. Written to be followed top to bottom in one sitting; expect about an hour,
most of it waiting for installs.

**Two separate things are called "AWS" here.** The EC2 instance the system runs on (§1–§8), and the
AWS identity the agents federate with to reach Claude (§10). §10 can be left until later, but they
are **not** independent: §10 works by pinning an Anthropic-side rule to this instance's exact IAM
role ARN and attaching a token-minting policy to that same role. Rebuild the box under a different
role, or rename the one it has, and the agents stop authenticating — with a `401` that says nothing
about roles. §10 is the only place that dependency is written down.

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

### The embedding model

The agents' retrieval runs a local model; nothing is sent to a vendor. Two files, ~130MB:

```bash
sudo mkdir -p /var/lib/trisula/models/bge-small-en-v1.5
cd /var/lib/trisula/models/bge-small-en-v1.5
sudo curl -sL -o model.onnx     https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/onnx/model.onnx
sudo curl -sL -o tokenizer.json https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/tokenizer.json
sudo chown -R trisula:trisula /var/lib/trisula/models
```

Not vendored in the repo: 130MB of binary in git costs every clone forever, and this file never
changes — if it did, every vector in `chunks` would need rebuilding, which is a migration and not
a download.

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

# Agents — see §10, which fills these in. Until then agent runs queue and retry.
#
# Commented rather than left blank, deliberately. For a credential variable, empty is not the same
# as absent: an exported empty string still occupies its slot in the SDK's precedence chain, so a
# blank line here would select a credential path with nothing in it and fail as a 401 instead of
# falling through. The same trap is why ANTHROPIC_API_KEY has no line at all on this box.
#ANTHROPIC_FEDERATION_RULE_ID=
#ANTHROPIC_ORGANIZATION_ID=
#ANTHROPIC_SERVICE_ACCOUNT_ID=
#ANTHROPIC_IDENTITY_TOKEN_FILE=/run/trisula/identity-token
#ANTHROPIC_WORKSPACE_ID=
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
> at least once, before you rely on it. See §12, "Prove it works".

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
  trisula-index-content.timer \
  trisula-backfill-company.timer \
  trisula-distil-rules.timer \
  trisula-alerts.timer \
  trisula-backup.timer \
  trisula-backup-verify.timer \
  trisula-heartbeat.timer

# Not a timer: a long-running watcher. `addCompany` announces on `trisula_backfill` inside the
# transaction that inserts the row, so a name followed at 10:02 starts fetching at 10:02 rather
# than at 10:10. The timer above stays enabled and is still the guarantee — a NOTIFY with nobody
# listening is discarded, and this unit being down is exactly when that happens.
sudo systemctl enable --now trisula-backfill-watch.service

systemctl list-timers 'trisula-*'
systemctl status trisula-backfill-watch
```

**Three of those were unit files nobody enabled**, found on 11-Sep-2026 while adding the third.
`index-content` shipped with R1 and `backfill-company` with `676b375` — the commit that *fixed*
`v4.md`'s opening audit finding, which was a queue with a correct drainer and no timer. The timer
was written and this list was not updated, so the queue still drained only when somebody typed the
command. Count this list against `ls ops/systemd/*.timer` before believing it; a unit file is not a
schedule.

Every unit carries `TZ=Asia/Kolkata`. Every time in this system is IST and every date it computes
is an Indian trading date; inheriting the box's timezone is how a reporting period silently moves
a day.

## 10. The model credential (the agents)

Separate from everything above, and skippable until you want agents running. Steps 1–3 are
account-wide and done once; 4 onward is per-box.

**The agents authenticate with the instance role, not a key.** That is the point of this section:
no model secret is written to this box, so a copy of the disk is not a copy of the credential.

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
sudo cp ops/systemd/trisula-identity-token.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trisula-identity-token.timer
sudo systemctl start trisula-identity-token.service     # do not wait for the first tick
sudo ls -l /run/trisula/identity-token                  # expect 0640 root:trisula
```

### 5. Tell the box

In `/etc/trisula/trisula.env`:

```
ANTHROPIC_FEDERATION_RULE_ID=fdrl_…
ANTHROPIC_ORGANIZATION_ID=…                       # the org UUID
ANTHROPIC_SERVICE_ACCOUNT_ID=svac_…
ANTHROPIC_IDENTITY_TOKEN_FILE=/run/trisula/identity-token
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
cd /srv/trisula
sudo -u trisula bash -c 'set -a; . /etc/trisula/trisula.env; set +a; pnpm migrate'

# The security master. Nothing can add a company before this.
sudo -u trisula bash -c 'set -a; . /etc/trisula/trisula.env; set +a; \
  pnpm exec tsx jobs/refresh-securities.ts'

# The FIRST account. There is no signup route, and --email/--name is the bootstrap: it has to
# exist before anybody can request one. Every account after this is created from an approved
# request instead, with `--request <id>` off the row on /admin, so that no applicant's own text
# is ever assembled into a command anybody pastes into this shell.
# Prints a TEMPORARY PASSWORD and eight recovery codes, ONCE. Put them in the password manager.
# The holder changes that password from the avatar menu, and redeems a code at /reset if they lose
# it — the code plus the address sets a new password and signs out every session. Somebody who has
# lost the password AND all eight codes still needs a person with shell access to re-issue them.
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

A failed unit records itself via `OnFailure=` and queues a notice to the admins, so a failure is
noticed by the machine rather than by someone happening to read the journal. The notice only
*leaves* the box once `SMTP_HOST` and `SMTP_FROM` are set in §6.

---

## 14. Deploying a change

Every step is safe to repeat, so run all of them; skipping the one that mattered is how a box ends
up serving old code against a new schema.

```bash
cd /srv/trisula
sudo -u trisula git pull

# Only if package.json changed, but harmless otherwise.
sudo -u trisula pnpm install --frozen-lockfile

# Migrations first, then the build. They are one transaction each and checksummed, so a re-run
# applies nothing and a tampered file refuses rather than running twice.
sudo -u trisula bash -c 'set -a; . /etc/trisula/trisula.env; set +a; pnpm migrate'
sudo -u trisula pnpm build

# New or changed units. Copying is cheap; working out which changed is not.
sudo cp ops/systemd/*.service ops/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload

sudo systemctl restart trisula-web
curl -sS localhost:3100/api/health
```

**A new timer is not enabled by copying it.** `systemctl enable --now <name>.timer` for anything
added since the last deploy — §9 lists the full set, and `systemctl list-timers 'trisula-*'`
against that list is the check.

Order matters in one direction only: migrations before the restart. The app reads columns the
migration adds, so a restart first serves a build that queries a schema it does not have yet.

---

## Still to decide

- **Where the age private key lives.** §7 says a password manager; write down which one, so the
  next person to need it does not have to guess.
- **A heartbeat URL.** `jobs/heartbeat.ts` and `trisula-heartbeat.timer` exist and ping every
  fifteen minutes; `HEARTBEAT_URL` in §6 is empty, so nothing is listening and nothing would notice
  a dead box. Create a check on healthchecks.io or Better Stack — a free tier covers it — and paste
  its URL in. Set the monitor's grace period above fifteen minutes.
- **Which Anthropic organization the agents bill to, and its payment method.** §10.2 needs an
  organization to create the service account and federation rule in, and that organization needs a
  card. This is the one thing the federation route adds that the AWS route did not: the usage lands
  on an Anthropic invoice in USD rather than on the AWS India INR bill, and inference calls stop
  appearing in CloudTrail. Nothing in §10 can be completed until this exists.
- **Whether the web app is on Tailscale or the public internet.** Tailscale needs no certificate and
  no port 443. Recommended until there is a reason otherwise.

# Deploying Folio

For whoever is putting this on a server. **`ops/SETUP.md` is the runbook and holds every command.**
This page is its front door: what you are deploying, what to collect first, which path through the
runbook is yours, and how to know you have finished. Where the two disagree, `ops/SETUP.md` is right
and this page is the bug.

State at handoff, 30-Sep-2026: `pnpm check` clean — lint, typecheck, 946 of 946 tests — and
`pnpm build` clean, with all 68 migrations applying to an empty database. One standing lint warning:
`lib/retrieval/register.ts` is 305 lines against the 300-line cap on `lib/`, which is a size limit
and not a defect.

## What you are deploying

One VM. Nothing is containerised and nothing ships as an artefact: the box clones the repository and
builds itself, so it can always be rebuilt from git plus a backup. Later deploys are `git pull`
(SETUP §14), so the box needs the repository, not an archive of it.

| Piece | What it is |
|---|---|
| Web app | Next.js 15 under `folio-web.service`, bound to `127.0.0.1:3100` and nothing else |
| Jobs | 18 systemd timers (a 19th once SETUP §10 is done) and 2 long-running watchers — `tsx` scripts over the same `lib/` the app uses |
| Database | Postgres 18 with `pgvector`, unix socket only, database timezone `Asia/Kolkata` |
| Embeddings | `bge-small-en-v1.5`, a ~130 MB ONNX model run in-process. No text leaves the box to be embedded |
| Model calls | The Anthropic API, outbound, from the jobs only. The web process never calls the model |
| Backups | `pg_dump` nightly at 01:30, `age`-encrypted to a public key and copied to S3; a restore drill every Sunday at 03:00 |
| Access | Tailscale only. No public port and no certificate to manage |

Target: `t4g.small` (arm64), Ubuntu 24.04, 40 GB gp3, in `ap-south-1` (Mumbai). Node 22.18 or later.

## Collect these before you start

None of these is in the repository. The fund holds each one or has to create it.

| You need | For | Notes |
|---|---|---|
| Access to the fund's AWS account in `ap-south-1` | SETUP §1, §7 | EC2, one S3 bucket, one instance role |
| Read access to `github.com/kartikeyaagr/folio` | §5 | The box then uses its own read-only deploy key. If the repository moves, change §5's clone URL and `ops/rename-box.sh` |
| Admin on the fund's Tailscale tailnet, with MagicDNS and HTTPS certificates on | §8a | |
| An Anthropic API key | §6 | Without one every agent run fails and is retried, indefinitely |
| The `desk@trisulacapital.com` mailbox password | §6, §9a | Hostinger SMTP. The daily news brief **fails its job** with no mail relay; the digest only waits |
| The **public** half of the fund's `age` backup key (`age1…`) | §6, §7 | The private half never touches the server. With no keypair yet, the fund generates one on a laptop per §7 |
| A heartbeat URL from healthchecks.io or Better Stack | §6 | Optional, but without it nothing notices a dead box |
| The first user's email address and name | §11 | That person is made admin |

Two secrets are generated on the box rather than collected: the deploy key (§5) and `MAILBOX_KEY`
(§9b). `MAILBOX_KEY` is not in a database backup, so give it to the fund to keep beside the backup
private key.

## Which path is yours

A VM was set up on 09-Sep-2026 (`i-055f70b1b15723f9b`), while the system was still called Trisula.
Before anything else, look at what it runs:

```bash
systemctl list-unit-files 'trisula-*' 'folio-*' --no-legend
```

- **`trisula-*` units** → path A.
- **`folio-*` units** → the rename has already run, and this is an ordinary update: SETUP §14.
- **Neither, or a new instance** → path B.

### Path A — the existing box, first deploy after the rename

SETUP §15, which stands in for §14 exactly once. `ops/rename-box.sh` renames the unix user, the
directories, the env file, the database and its role, the Tailscale node, `APP_URL` and the units,
then migrates, builds and re-enables exactly what was enabled before. It is safe to re-run if it
stops partway. Everybody signs in once more afterwards, because the session cookie's name changed.

This deploy also changes a schedule, and copying a timer does not reschedule it (§14 says why):

```bash
sudo systemctl restart folio-news-poll.timer
systemctl list-timers folio-news-poll.timer     # next elapse within the hour
```

Then **Accept it**, below.

### Path B — a new box

SETUP §1 to §12, in order and in one sitting: about an hour, most of it installs. These are the
steps that have gone wrong before:

| § | Step | Where it goes wrong |
|---|---|---|
| 1 | Instance | Import your own SSH public key rather than letting AWS generate the private one |
| 4 | Postgres 18 | `CREATE EXTENSION vector` must run **as `postgres`, in `template1`**, and the database timezone must be set. Skip the first and migration 0040 fails; skip the second and every date before 05:30 IST is a day early |
| 5 | User, model, clone | `useradd` **without** `--create-home`, or the clone into `/srv/folio` fails. `model.onnx` must be exactly 133,093,490 bytes |
| 6 | `/etc/folio/folio.env` | `640 root:folio`. Leave the `ANTHROPIC_FEDERATION_*` lines **commented out**, not blank — an empty value selects that backend and fails as a 401 |
| 7 | Backup keys | The `age` keypair is made on a laptop. The instance role gets `s3:PutObject` on the bucket and nothing more |
| 8 | Build, web unit | `pnpm build` needs outbound internet: fonts are fetched at build time |
| 8a | Tailscale | Leave `TRUST_PROXY_HEADER` unset under `tailscale serve` |
| 9 | Schedules | Enable all 18 timers listed **and** both watchers. A unit file copied but not enabled is not a schedule |
| 10 | Federation | **Skip for now.** It needs an Anthropic organization that does not exist yet; the box runs on the API key from §6 |
| 11 | First run | Migrate → securities → first user → **make that user admin**. Without an admin, no second account can ever be created from the UI |

## Accept it

Not finished until every line passes. Each is described in SETUP; this is the list in one place.

- [ ] `pnpm preflight` exits 0. Exit 1 means something is wrong; exit 2 means something could not
      be checked — read which, because a check that did not run is not a pass.
- [ ] `ops/verify-backup.sh folio` prints `OK: … content identical after a full round trip` (§12).
- [ ] The fund restores the latest S3 archive **on a laptop, with the real private key** (§12). Only
      this proves the backups are readable; the on-box drill uses a throwaway key.
- [ ] From a second machine on the tailnet, `https://folio.<tailnet>.ts.net/api/health` answers
      `{"ok":true}` and a person can sign in. A redirect loop back to `/login` means the cookie is
      not arriving over HTTPS; "Invalid Server Actions request" in `journalctl -u folio-web` means
      the proxy is not passing the host through.
- [ ] A PDF over 10 MB imports from a company page and appears as a document.
- [ ] `curl -sI https://folio.<tailnet>.ts.net/login` shows both `Strict-Transport-Security` and
      `Content-Security-Policy`.
- [ ] `jobs/agents.ts 1`, run as in §9a, leaves `notification_outbox` rows with `sent_at` set.
- [ ] `systemd-analyze calendar` on the `OnCalendar=` lines of `folio-ingest-fundamentals`,
      `folio-news-poll` and `folio-distil-rules` gives the times §9 expects. These three have never
      been validated on Linux.
- [ ] `systemctl list-timers 'folio-*'` lists 18 timers, and both watchers are `active`.

## After handoff

- **Every later deploy is SETUP §14**: pull, install, migrate, build, copy units, restart, preflight.
  Each step is safe to repeat, so run all of them.
- **Rolling back code** is `git checkout <sha>`, build, restart. **Rolling back schema** has no
  down-migration, by design: restore beside production, inspect it, then swap names — §14, "When a
  deploy goes wrong". Never `restore.sh --replace` the live database.
- **Day-to-day** is SETUP §13. A failed unit queues a notice for the admins through `OnFailure=`,
  and it reaches them in the next morning's digest once SMTP is set.

## Things that look wrong and are not

- **`trisula` in AWS resource names, in migrations and in the `trisula_content` channel.** IAM roles
  and buckets cannot be renamed, and migration files are checksummed including their comments —
  edit one and the runner refuses to start. Leave them.
- **A job that fetches nothing fails**, as does a news feed whose newest item is over 21 days old.
  A dead feed must never look like a quiet day. The few legitimate exceptions (a non-trading day, an
  empty queue) are each stated in their own job.
- **The daily news brief publishes and mails itself without review.** That is the fund's decision of
  28-Sep-2026, held by a database constraint (migration 0067). Everything else an agent writes waits
  for a person to accept it.
- **The app listens on `127.0.0.1` only.** Reaching it is Tailscale's job. Do not add a public
  listener.
- **Code comments cite files under `docs/` and `tasks/`** that are not in the repository. They are
  the fund's private design notes, and each comment carries the evidence it needs on its own.

## Still the fund's to decide

From the end of SETUP, and none of them blocks the deploy:

- **Where the `age` private key lives.** Write it down, so the next person who needs it does not
  guess.
- **A heartbeat URL**, until which a dead box goes unnoticed. `pnpm preflight` notes its absence on
  every run.
- **An Anthropic organization with a payment method**, to finish §10 and take the API key off the
  disk.

## Where everything else is

| | |
|---|---|
| `ops/SETUP.md` | The runbook |
| `.env.example` | Every variable the code reads |
| `ARCHITECTURE.md` | How the system is put together |
| `SECURITY.md`, `DATABASE.md`, `API.md`, `CODE_STYLE.md` | The rules for changing it |

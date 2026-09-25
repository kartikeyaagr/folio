# API.md

How the parts of Trisula talk to each other and to the outside world. **There is no REST API and
no public API.** The browser talks to server components and server actions, jobs talk to Postgres,
and a handful of outbound integrations feed both. Security rules for everything below are in
SECURITY.md.

```
browser ──(RSC pages, server actions, 4 route handlers)──▶ Next.js on 127.0.0.1:3100
                                                              │
systemd timers ──▶ jobs/*.ts (tsx) ──────────────────────────▶ Postgres ◀── lib/ (shared)
                     │                                           │
                     └──▶ NSE · RSS feeds · Anthropic · SMTP     └── NOTIFY ──▶ watcher units
```

## 1. Pages

- **Reads are server components.** They call `lib/` directly inside `readTxn`, with no fetch layer
  in between.
- **State lives in the URL** (`?tab=`, `?filter=`, `?scope=`), so a refresh lands where you were.
- **No page is a client component.** The two `'use client'` files in `app/` are the error
  boundaries Next requires, and interactive pieces live in `components/`.

## 2. Server actions: the write surface

All writes from the browser are server actions: `app/_lib/actions/*.ts`, one module per area,
plus the three inline actions on the public pages. Each follows the same contract:

```ts
export async function doThingAction(form: FormData): Promise<void> {
  const user = await requireUser();          // or requireAdmin(); first, and OUTSIDE any try
  try {
    await doThing(user.userId, String(form.get('x') ?? ''));   // lib/ validates and writes
    await flash('Done, in a sentence.');
  } catch (err) {
    if (err instanceof KnownFailure) await flash(err.message); // a sentence the person can act on
    else throw err;                                            // anything else → app/error.tsx
  }
  revalidatePath('/where');                  // or redirect(); state comes back through the page
}
```

- **Input is `FormData`, and the return is `void`.** Nothing uses `useActionState`. The outcome
  reaches the person through `flash()`, a 30-second cookie that `components/Toast.tsx` shows once.
  The actions that client components call take typed arguments instead: `saveTextAction`,
  `saveSheetAction`, `renameTitleAction`, `searchCompanies`, `searchSecurities` and `setTheme`.
  Some of them return data (the sheet's lookups, search hits).
- **Every validation happens in `lib/`,** which throws an `Error` subclass named for the condition
  (`TitleRequired`, `WeakPassword`, `MailboxRefused`). The action decides which of those are
  sayable.
- **Public pages have no Toast,** so they signal with the query string instead: `/login?error=1`
  or `?error=rate`, `/signup?sent=1`, `/reset?error=weak`.
- **Request bodies are limited to 33 MB,** just above the 32 MiB upload cap. That takes two settings
  in `next.config.ts`: the action body limit and the middleware's copy of the body, whose defaults
  are 1 MB and 10 MB. `lib/import/limits.test.ts` keeps both above the cap.

## 3. Route handlers

Four in total. An error is `{ "error": string }` with a status code, never a stack. Health is the
one exception: it answers `{"ok":false}` with a 503.

| Route | Auth | Success | Errors |
|---|---|---|---|
| `GET /api/health` | none | `200 {"ok":true}`, after a real `SELECT 1` | `503 {"ok":false}` |
| `GET /api/attachment/[sha]` | session | the stored file; PDF inline, else attachment; `private, immutable` | 401, 400 not a 64-hex hash, 404 no row or not on disk |
| `GET /api/export/[id]` | session | the document as `.docx`, `no-store` | 401, 404, 400 for a sheet |
| `POST /logout` | none | revokes the presented token, then `303 → $APP_URL/login` | — |

The heartbeat monitor polls `/api/health`, and so does anybody checking the box. It deliberately
reveals nothing beyond reachable or not.

## 4. Jobs

- **Jobs are `tsx` scripts in `jobs/`.** Most run on a systemd timer through
  `trisula-job@<name>.service` (`ops/systemd/`). `report-failure` is run by `OnFailure=`. The
  operator tools (`seed-user`, `set-admin`, `reset-password`, `requeue`) and the catch-up jobs
  (`ingest-attachments`, `backfill-filings`, `backfill-prices`) are run by hand. Jobs import the
  same `lib/` as the app and never import `app/`.
- **Every job that ingests leaves an `ingestion_runs` row.** Most get it from `runJob()`
  (`jobs/_run.ts`), which opens the row, closes it `ok` or `failed`, and exits non-zero on failure.
  The rest write their own: `agents`, `alerts`, `distil-rules`, `index-content`,
  `backfill-company`, `ingest-fundamentals`, `news-gate` and `refresh-securities`. `heartbeat`
  writes none, because it must survive the database being what failed.
- **A failure is reported by the machine.** `OnFailure=trisula-alert@%n` runs
  `jobs/report-failure.ts`, which queues a notice for the morning digest.
- **Readers gate on `ingestion_runs`, not on the clock.** `jobs/alerts.ts` evaluates price alerts
  only after today's EOD ingest succeeded. Filing and insider alerts do not depend on prices, so
  they always run.
- **Zero items is a failure unless the job's own file argues otherwise** (CLAUDE.md, House
  standards).
- **`NOTIFY` is a nudge, never the record.** Saving a document fires `trisula_content`, and
  following a company fires the backfill channel. The watcher units react within seconds, while
  the timers remain what *guarantees* the work.

## 5. Outbound integrations

| Service | Purpose | Configuration | When it fails |
|---|---|---|---|
| **Anthropic** (`lib/agents/client.ts`) | Agent runs and the news gate. Only jobs call it, never the web process. | The first present of `ANTHROPIC_FEDERATION_RULE_ID` (with `_ORGANIZATION_ID`, `_IDENTITY_TOKEN_FILE`), `ANTHROPIC_AWS_WORKSPACE_ID` (with `AWS_REGION`), or `ANTHROPIC_API_KEY`. None of them throws `NoModelCredentials`. | A run records the error and is retried with backoff. A transport or credential failure (`failure_kind='error'`) is requeued after 6h; a refusal, truncation or schema mismatch stays failed. The news gate spends one of 3 attempts per item, then marks it `ungated`. |
| **NSE** (`lib/ingest/nse.ts`) | Bhavcopy, filings, corporate actions, insider, shareholding, calendar, XBRL. | None: it primes a cookie from the homepage, sends a browser User-Agent, and times out after 30s. | The job fails, `ingestion_runs` records it, and `OnFailure` fires. There is no BSE feed. |
| **NSE attachments** (`lib/ingest/attachments.ts`) | Filed PDFs, stored by sha256. | `ATTACHMENT_DIR`, 64 MiB cap. | Fetched by `backfill-company` when a name is followed, and by `ingest-attachments` run by hand. Not-yet-fetched is a `NOT EXISTS` question, so a rerun picks up whatever the last one missed. |
| **News RSS** (`lib/news/poll.ts`) | The wide net that the news gate narrows. | The `news_sources` table, seeded by migration. `/admin` turns a source on or off; adding one is a migration. | Each feed's outcome is kept on its row. The job fails only if every feed fails. |
| **SMTP** (`lib/notify.ts`, `lib/mailbox.ts`) | One digest a morning per person. | `SMTP_HOST` and `SMTP_FROM` are needed together, plus `SMTP_PORT`, `SMTP_USER` and `SMTP_PASSWORD`. A person's own mailbox is sealed with `MAILBOX_KEY`. | With no relay, the outbox queues and nothing fails. Linking a mailbox sends a real test message first and stores nothing if that fails. |
| **Heartbeat** (`jobs/heartbeat.ts`) | A dead-man's switch: it POSTs every 15 min, only once Postgres has answered. | `HEARTBEAT_URL` | The monitor alarms on silence. With the variable unset, nothing notices a dead box. |
| **S3** (`ops/backup.sh`) | An off-box copy of the encrypted nightly dump. | `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT` | The backup unit fails and `OnFailure` fires. |
| **Hugging Face** (`ops/fetch-model.sh`) | Downloads the embedding model once, at setup. Nothing calls it at runtime. | The script takes a target directory as its argument; the app finds the model through `EMBED_MODEL_DIR`. | Setup stops. The model's byte count and the tokenizer's sha256 are validated. |

## 6. Cost and limits on model calls

- **Every draft records `cost_usd`,** priced from `PRICING` in `lib/agents/model.ts`. An unknown
  model prices as `null`, never `0`.
- **Output defaults to 16,000 tokens,** with one retry on truncation.
- **Each agent's effort is set per agent in `/admin`.**
- **A drain claims 10 runs per invocation.** Each run gets 3 attempts and a 30-minute lease.
- **The news gate runs at `low` effort** and judges at most 100 items per run.
- **There is no spend ceiling.** Admins see draft cost on `/agents`. News-gate spend is recorded
  only in its `ingestion_runs.detail`.

## 7. Adding a new surface

- **A write is a server action in `app/_lib/actions/`,** following §2, with its logic and
  validation in `lib/`. Add a route handler only when the response is a file or a probe.
- **A new outbound integration** gets a row in §5, its variables in `.env.example` and
  `ops/SETUP.md` §6, and a failure that is recorded rather than swallowed.
- **Update this file when a new pattern appears,** not for every new action.

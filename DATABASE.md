# DATABASE.md

How Trisula's data is held, related and changed safely. The table-by-table map lives in
`ARCHITECTURE.md` §2 and is not repeated here. This file covers the rules that map does not state.

## 1. Stack

- **PostgreSQL 18 with `pgvector`**, the only extension (`0040`). pgvector is not a *trusted*
  extension, so only a superuser can create it. It is created once in `template1` by `postgres`,
  and every database inherits it (SETUP §4), including the app's, every restore and the drill's.
- **Raw `pg`, no ORM.** An ORM was refused on a count (`docs/specs/capabilities.md` E2).
- **Reached over the unix socket.** Production is `postgres:///trisula`, development
  `postgres:///trisula_v3_dev`. `DATABASE_URL` always comes from the environment (SECURITY.md §6).
- **One lazy pool per process, `max: 10`** (`lib/db.ts`). The web app and every job import that
  same file.
- **Postgres `date` arrives in JS as the string `YYYY-MM-DD`,** never a `Date`: a trading date has
  no time zone to shift it by. `numeric` arrives as a string too, which is `pg`'s default.

## 2. Reading and writing

There is deliberately no bare `query()`. Every statement runs inside one of three transactions:

| Helper | For | Sets |
|---|---|---|
| `readTxn(fn)` | any read | `BEGIN READ ONLY`, no actor |
| `writeTxn(actorId, fn)` | a person, the id from their session | `app.actor_id` = the person |
| `serviceTxn(principal, fn)` | a job or the system | `app.actor_id` = a `ServicePrincipal` |

**An unattributed write raises.** The `audit` trigger (`audit_fn()` in `0001`) runs on every
audited table. It raises `unattributed write` when `app.actor_id` is unset and `unknown actor` when
the id has no `actors` row. Otherwise it records `before` and `after` as jsonb in `audit_log`.

**The service principals are a closed set.** They are `system:ingest`, `system:index`,
`system:agents`, `system:alerts`, `system:auth`, `system:migration`, `system:news` and
`system:news-gate`: the `ServicePrincipal` type in `lib/db.ts`, and the same eight rows seeded in
`actors` by migrations. Adding one takes both halves in the same change.

**`db/schema.test.ts` asserts that every table carries the trigger, except 11 exemptions.** Each
exemption is argued in the migration that created the table:
- `actors`, `audit_log` and `schema_migrations`, which would be circular or are the runner's own;
- `prices`, `index_levels`, `ingestion_runs`, `news_items` and `news_matched_items`, which are
  high-volume copies of somebody else's facts whose provenance is `ingestion_runs`;
- `chunks`, `exemplars` and `rule_observations`, which are derived rows.

The test's list also still names `chat_tool_calls`, which `0053` dropped.

A new table is audited unless you add it to that list *and* say why.

**`LISTEN` never uses the pool.** `listen()` in `lib/db.ts` holds its own client and reconnects on
its own. A pooled client's `LISTEN` goes to whoever borrows it next.

## 3. Conventions

- **Names:** `snake_case`, and tables are mostly plural. A constraint is named for what it forbids:
  `decided_together`, `rejection_needs_a_reason`.
- **Ids:** `text`. A row id is `rowId()`, 16 random bytes as 32 hex characters. That includes
  people: the "uuid" in `0001`'s comment is wrong and cannot be fixed (§4). A service actor's id is
  its name (`system:ingest`).
  - Natural keys where the world has one: `securities.symbol`, `attachments.sha256`, `agents.key`,
    and `(symbol, on_date)` on `prices`.
  - `bigserial` only for append-only logs and derived rows: `audit_log`, `ingestion_runs`,
    `sources`, `chunks`, `document_versions`, `company_aliases`.
- **Time:** `timestamptz NOT NULL DEFAULT now()`, named for the event (`created_at`, `fetched_at`,
  `decided_at`). A trading date is a `date`.
- **The database's own timezone must be `Asia/Kolkata`.** The date arithmetic is in SQL
  (`current_date`), and `TZ=Asia/Kolkata` on the units does not reach Postgres. `initdb` copies the
  box's zone, which is UTC on EC2, so it is set with `ALTER DATABASE … SET timezone` (SETUP §4)
  and asserted by `pnpm preflight` (lesson L19).
- **Numbers are exact, never `real` or `double`:**
  - the book: `numeric(20,4)`, and `(20,6)` for `avg_cost` and ratios;
  - filed financials as filed: `numeric(20,2)`;
  - prices: `numeric(18,4)`;
  - percentages: `numeric(8,4)`.
- **Absence is `NULL`, never `0`.** A filer's zero is a figure, and a missing figure stays missing
  (lesson L9; `<Blank>` in the UI).
- **Enums are `text` plus a `CHECK (x IN (…))`,** never `CREATE TYPE`. Rules about state are
  `CHECK` constraints too, so they hold however the row is reached.
- **Nothing is soft-deleted as a policy.** A table that needs history carries a marker for it:
  `archived_at` (documents), `disabled_at` (users), `delisted_at` (securities), `reversed_at` plus
  `reversed_by` plus a reason (transactions, never deleted), and `superseded_by` (fundamentals).
- **Generated columns** (`chunks.fts`, `news_items.url_key` and `title_key`) cannot appear in a
  `COPY` column list.

## 4. Migrations

```bash
pnpm migrate            # apply what is pending
pnpm migrate --status   # list applied and pending, change nothing
```

- **Plain SQL in `db/migrations/NNNN_a_sentence_in_snake_case.sql`,** applied in filename order.
  Each file runs in one transaction, with `app.actor_id = 'system:migration'` and its ledger row
  in `schema_migrations`.
- **Migrations run as `trisula`, which is not a superuser.** Anything that needs one, such as an
  untrusted extension, belongs in SETUP §4 and not in a migration.
- **Forward only. There are no down migrations.** To undo something, write a new migration, as
  `0053` did when it dropped chat's three tables.
- **Never edit an applied migration, not even a comment.** Every applied file is re-hashed with
  sha256 on each run, and a changed hash is a hard stop. On the VM that is an outage.
- **Seed data a table needs to exist belongs in the migration:** actors, agents, alert rules, news
  sources, sector terms, the forensics template.
- **Test a migration against a fresh database before it ships.** `trisula_v3_dev` is not a
  rehearsal for the VM, and it carries an orphan `0052` row from a merge.
- **On deploy, migrate before restarting the web unit** (`ops/SETUP.md` §14). Otherwise the new
  build queries a schema it does not have yet.

## 5. Accounts and seed data

- **Accounts:** `jobs/seed-user.ts` is the only path that creates one, run on the box.
- **Admin:** `jobs/set-admin.ts` grants it, and `--list` shows who exists.
- **Passwords:** `jobs/reset-password.ts` sets a new one.
- **Never put real people or real credentials in a seed or a fixture.** Tests invent their
  addresses (`t@example.com`, `someone@x.com`).

## 6. Backups and restore

| What | When | How |
|---|---|---|
| `ops/backup.sh` | nightly 01:30 IST | `pg_dump -Fc --exclude-extension=vector` piped straight into `age -r $BACKUP_AGE_RECIPIENT`, so the plaintext never touches disk. The extension is left out because the restoring role cannot create it or comment on it; the target inherits it from `template1`. It is kept 14 days in `/var/lib/trisula/backups`, and copied to S3 when `BACKUP_S3_BUCKET` is set. |
| `ops/verify-backup.sh` | Sundays 03:00 | The whole round trip with a throwaway key. It compares row counts, then per-table content hashes, and fails loudly on any difference. |
| `ops/restore.sh` | by hand | `age -d` into `pg_restore --single-transaction`, then it reapplies the database's timezone, which a dump does not carry. It refuses a database that exists unless given `--replace`. To roll production back, restore *beside* it and swap names (SETUP §14); never `--replace` the live database. |

The age private key lives off the box (`ops/SETUP.md` §7). `MAILBOX_KEY` lives in
`/etc/trisula/trisula.env`, not in the database, so a restore brings back sealed mailbox passwords
without the key that opens them. Keep a copy of it beside the age private key.

## 7. Production safety

- **`ops/restore.sh --replace` is the only `dropdb` that can reach a real database.** The others
  are the test helper and the drill's own scratch database. Outside tests, nothing runs
  `DROP DATABASE`, `DROP SCHEMA` or `TRUNCATE`.
- **Every app `DELETE` is scoped by a key** (an id, a company, a user, a date window), never
  unqualified. It is audited unless the table is one of the exemptions in §2.
- **Never hand-edit production to skip a migration.**
- **Tests create and drop their own database per file** (`db/testing.ts`, database name
  `trisula_<name>_<pid>`) against a real Postgres, so they need `createdb` and `dropdb` on PATH.
  They cannot catch a dev database that has drifted from the tree.
- **No `statement_timeout` or `lock_timeout` is set anywhere.** A long query holds its pool slot
  for as long as it runs.

# Architecture

How Trisula is put together, and why it is put together that way. Accurate against the tree at the
time of writing: **62 migrations, 50 tables, 6 agents, 24 job entry points, 19 systemd timers, two
long-running watchers, 18 pages and 4 route handlers, 814 tests.** Every number here was counted,
not remembered; if you change the shape, count again rather than editing around it.

For the product argument — what was built, what was deliberately cut, and on whose authority — see
the private `docs/specs/`. This file describes the machine.

---

## 1. Shape

One package, one VM, no monorepo. Postgres is the only datastore and the only queue.

```
app/            Next.js App Router — every screen, server components by default
components/     the design system
lib/            domain logic, server-only, imported by BOTH app/ and jobs/
jobs/           standalone tsx entry points, run by systemd timers
db/             migrations/*.sql from 0001, and the runner
ops/            provision · backup · systemd units · measurement scripts
```

The load-bearing property is that **`lib/` is shared between the web app and the jobs**. A job is a
`tsx` script that imports the same module the page imports, so there is exactly one implementation
of "what a holding is" or "what counts as a confirmed news match". The cost is that `lib/` may never
import `next/*` — that compiles for the web and dies in a job — and an eslint rule enforces it
rather than leaving it to discipline.

Four boundaries are enforced by lint, not by convention:

| Rule | Why |
|---|---|
| `lib/` never imports `next/*` | it runs under `tsx` in jobs, where `next/*` does not exist |
| `lib/`, `jobs/`, `db/` never import `app/` | the backend stays provable without the frontend |
| web-only helpers live in `app/_lib/` | cookies, sessions, server actions are not domain logic |
| 300-line cap on `lib/` files (warning) | v2's `pipeline.ts` reached 2,007 lines with no seam between fetching and rendering |

### Runtime constraint

Node runs this TypeScript natively in **strip-only** mode: type annotations are deleted and nothing
is generated. Three TypeScript features are therefore runtime syntax errors even though `tsc`
accepts them — **parameter properties**, **enums**, and **namespaces**. Use a `const` object with
`as const` in place of an enum. Relative imports inside `lib/` carry the `.ts` extension. There is
no build step, and that is the trade.

---

## 2. The data model

50 tables. None was ever dropped until `0053` took the three that were chat's and nothing else's;
the rule it replaces — "none ever dropped" — held for fifty migrations and is worth keeping as the
default. Forty-seven are grouped below by what they are for. The other three are outside the
grouping because none of them holds fund data: `annual_report_attempts` records the *ask* rather
than the result, so a year we requested and did not get is distinguishable from one we never
requested without a watermark (`0046`); `index_levels` is a benchmark series and an index is not a
security, argued after the grouping; and `schema_migrations` is `db/migrate.ts`'s own bookkeeping,
created by the migrator rather than by a migration.

```
IDENTITY & AUDIT   actors · users · sessions · recovery_codes · audit_log
                   access_requests · ingestion_runs · mailboxes
COMPANIES          securities · companies · company_aliases · sector_terms
                   documents · document_versions · attachments
FORENSICS          forensics_templates · forensics_template_items
                   forensics_checklists · forensics_answers
MARKET DATA        prices · filings · fundamentals
                   insider_transactions · shareholding_patterns · shareholders
THE BOOK           transactions · holdings · cash_ledger · corporate_actions
WHAT HAPPENED      alerts · alert_rules · calendar_events · engagement
                   news_sources · news_items · news_matches · news_matched_items
AGENTS             agents · agent_runs · ai_drafts
NOTIFY             reminders · notification_outbox
RETRIEVAL          sources · chunks
LEARNING           exemplars · prompt_rules · rule_observations
```

`CREATE EXTENSION vector` is the only extension.

**Migrations are one transaction each and checksummed.** `db/migrate.ts` refuses to run when an
applied file's bytes have changed, and `db/schema.test.ts` asserts that refusal. This means you
never edit an applied migration — you write a new one. A count assertion inside a migration is
point-in-time, evaluated when that file applies, so a later migration adding a row does not
falsify it.

### Every write is attributed

`writeTxn(actorId, …)` for a person, `serviceTxn(principal, …)` for a job. Postgres **raises** on an
unattributed write and on an unknown actor. Service principals are seeded in migrations, and
`ServicePrincipal` in `lib/db.ts` is the same closed set. There is no path that writes without
saying who did it, which is why `audit_log` can be trusted rather than hoped at.

---

## 3. Ingestion

Fourteen sources behind nine ingest jobs, all writing through `lib/ingest/*`:

securities master · exchange filings and announcements · attachments and their extracted PDF text ·
bhavcopy EOD prices · **index closes** · XBRL fundamentals · shareholding patterns and holders ·
insider transactions · corporate actions · the calendar · annual reports.

**Index closes ride with the bhavcopy**, in the same loop of the same job from the same archive
host. NSE's per-index history endpoint answers 503 — measured 17-Sep-2026, the same answer every
per-symbol historical endpoint gives — but `ind_close_all_DDMMYYYY.csv` carries all 166 indices for
one trading day, so the walk that fetches a day's prices fetches its index levels in one more
request. Four are kept (`lib/ingest/indices.ts`): Smallcap 250, Midcap 150, Nifty 500, Nifty 50.
`index_levels` is its own table because an index is not a security — no ISIN, no symbol, and not
filtered against `companies` — and carries no audit trigger for the reason `prices` carries none.

Two rules govern all of them.

**A feed or job that returns zero items is a failure, not a quiet day.** A dead feed must never look
like a quiet one. Six exemptions are documented, each stated in the file it applies to and counted
in `CLAUDE.md` so the roster lives in one place: no bhavcopy on a non-trading day, the news gate's
empty queue, the content indexer's two empty queues, a distillation run that raised no rule, an
agent sweep that queued nothing, and a company backfill with nothing left to claim. The last three
are not "the queue was empty" — the queue is full and the right answer is still nothing, which is
why each file argues its own case.

**Ask "what has no run yet", never "what is new since I last looked."** Sweeps and evaluators use
`NOT EXISTS`, not a watermark or a rolling window. A window can only lose things, and it already
cost this system two real alerts.

`companies` is the universe. Nearly every ingest job filters to followed names, so adding a company
is what makes the machine fetch its history — `companies.backfilled_at` is a queue drained by
`jobs/backfill-company.ts`. **Eight steps, all per-symbol**: the announcement history, the annual
reports, the documents those filings point at and the text inside them, the results (both the old
feed and Integrated Filing), the corporate actions, the shareholding pattern, the insider and pledge
disclosures back to 2015, and the price series.

`addCompany` announces on `trisula_backfill` inside the transaction that inserts the row, so
`trisula-backfill-watch.service` starts the fetch in about a second. The ten-minute timer stays
enabled and remains the guarantee: a `NOTIFY` with nobody listening is discarded, and the watcher
being down is exactly when that matters. The watcher drains the whole queue on every wake and never
trusts the symbol in the payload.

**A step ends three ways, not two** (`lib/ingest/backfill.ts`). `gap` is the exchange having nothing
for this name — a company listed in 2021 has no sixteen years of annual reports — and does not hold
the queue. `error` is the box or the feed, and the name stays queued: it is the same line
`lib/agents/queue.ts` draws between a model refusing a subject and a machine with no credential. An
exception is always `error`, because a step that threw does not know what the exchange holds. Only
when nothing broke is `backfilled_at` written, which is what the column says it means. Three
attempts, then the name leaves the queue by that bound rather than by being called finished, and
`/companies` shows where every name has got to. `backfill_started_at` is the lease, so two passes
never run over one name.

**The offer document is the one thing no feed serves.** NSE has no endpoint for an RHP or DRHP and
SEBI's draft index holds 2.3% of NSE Emerge names; both were probed live, in Sep 2026, twice. They
arrive through the import dialog, which takes 32MB PDFs and keeps the bytes.

**A filed document is read as the PDF it is.** `lib/files.ts` lists what the company published —
one row per document, named for its period and its type (`Sept 2026 Transcript`, `Aug 2026 PPT`),
with the exchange's own date beside it — and the link opens the original through
`app/api/attachment/[sha]`. The name is composed at render, not stored: `to_char(…, 'Mon')` gives
`Sep` where `Intl` under `en-IN` gives `Sept`, so a title written by SQL and one written by
TypeScript would disagree for one month a year. The extracted text is not a second document: it is what the
agents read and what retrieval searches, and nothing else. Until 17-Sep-2026 a transcript existed
twice, as the PDF and as a `documents` row holding its text, and the page showed the second while
the first was unreachable from any screen.

Three layers of deduplication, because bytes, text and rows fail differently. The store is
content-addressed, so identical bytes are one file. `register.ts` collapses the filing fan-out by
sha and then again by the hash of the text, so a corrected re-filing — new signature, same words —
is indexed once, keeping the earliest. And a document promoted from an attachment is not indexed at
all, because the attachment already carries those words: 35 transcripts, 2,063 duplicate chunks.

### News

Feeds are polled wide — 56 configured, 34 active — then narrowed by a **deterministic** matcher
(`lib/news/match.ts`:
symbol → ISIN → name → alias → sector term, with word-boundary regexes and a stoplist; no model).
Candidates then pass a **model gate** (`lib/news/gate.ts`) that must produce a *mechanism sentence* —
not a score — explaining how the story touches the company. `related: true` with an empty mechanism
is forced to rejected. Only `confirmed` matches reach a reader, or the content store.

---

## 4. Retrieval — the content store

Two tables, because *what was indexed* and *what a chunk is* have different lifetimes. A document is
re-saved constantly; its chunks are disposable and rebuilt.

- **`sources`** — one row per indexable thing, keyed `(kind, ref_id)`, carrying `content_hash`,
  `company_id`, `occurred_at`, `indexed_at`, `index_error`.
- **`chunks`** — the pieces, with `char_from`/`char_to` offsets, an `embedding vector(384)`, a
  generated `fts tsvector`, and denormalised copies of `company_id` and `occurred_at`.

Five source kinds are registered: `document_version` (current version only), `attachment` (stored
filing PDFs with a text layer), `filing`, `news_item` (confirmed matches only), and
`fundamentals_period` (current, non-superseded, rendered as prose).

**The embedder is local.** `BAAI/bge-small-en-v1.5` at 384 dimensions under `onnxruntime-node`,
fetched by `pnpm fetch-model`, never vendored. Nothing leaves the VM. `embed_model` is written on
every row and filtered at retrieval: vectors from two models occupy different spaces and comparing
them returns plausible numbers with meaningless neighbours, which is the worst available failure
because it has no symptom.

**Chunking** is 1000 characters target, 150 overlap, 100 minimum, breaking at paragraph → sentence →
whitespace → hard cut. A spreadsheet chunks by **row block**, never mid-row and never across two
tabs: a grid cut mid-row retrieves as noise — a number with no idea which line it belonged to — and
a block ending in one tab and opening in the next is a passage nobody wrote. A workbook of more than
one tab names each tab on a line of its own, so a retrieved block says what it is a block of. The
invariant that makes a citation work is `source.slice(char_from, char_to) === chunk.text`, where
`source` means exactly what `textFor` returns.

**Search is hybrid** — vector and full-text, merged by reciprocal rank fusion at k=60, then collapsed
to at most three chunks per source. Full-text terms are OR-ed, not AND-ed: *"what has management said
about the auditor"* should surface a page mentioning the auditor and never the word "management".

**There is no relevance floor, and that is a finding rather than an omission.** Twenty questions
against the live corpus produced no cosine value separating relevant from irrelevant. Relevance
judgement moved into the chat tool loop instead.

`jobs/index-content.ts` drains two queues in one run — unindexed sources and unembedded exemplars —
because both are the same operation against the same loaded 130 MB model.

**Re-indexing is driven by content, not by a clock.** `registerAll` recomputes each source's
`content_hash`; the upsert clears `indexed_at` *only* when that hash moved, and `indexOne` deletes a
source's chunks before writing the new ones. A memo saved six times in an afternoon costs one embed;
a memo actually edited costs one re-embed and its stale vectors are gone in the same transaction.
`reap.ts` retracts a source that no longer qualifies, and `chunks` cascade from `sources.id`.

What tells it to look is a statement-level trigger (`0052`) on `documents`, `document_versions` and
`attachments`, which `pg_notify`s a constant payload on `trisula_content` — constant so an
eleven-tab import is one notification rather than twenty-two. `jobs/index-content.ts --watch`
listens and indexes seconds after a save; `trisula-index-watch.service` runs it. **The notification
is a nudge and never the record**: one sent with no listener attached is gone, so the durable queue
is still `indexed_at IS NULL` and the ten-minute timer is still what guarantees it drains. Indexing
deliberately does not happen on the write path — saving a memo must not block on a 130 MB model
load, the same rule the accept gate follows for exemplars.

---

## 5. Agents

Six, as rows in `agents`. An agent absent from that table cannot be invoked.

| key | trigger | what it does |
|---|---|---|
| `results-figures` | event | reads a filed results period, with a deterministic verifier |
| `concall-insights` | event | reads a transcript against the previous one |
| `forensics-review` | event | works the fund's own 14-item forensic checklist |
| `news-brief` | prompt | the week's confirmed news, per company |
| `email-workflow` | schedule | drains `notification_outbox` |
| `reminders` | schedule | what is due |

Everything funnels through the `agent_runs` queue, drained by one timer every five minutes. Claiming
uses `FOR UPDATE SKIP LOCKED` with a 30-minute lease. "Event" agents are not push-driven: they are
`NOT EXISTS` sweeps against `agent_runs`, per the house rule.

**Four of the six can be asked for work by hand** — every agent that calls a model — and
`lib/agents/invocable.ts` is the single list of which, read by `/agents`' form, by chat's
`run_agent`, and by the server action behind the form. Membership is a property of the handler, not
of the `trigger` column: an agent belongs there iff everything it reads off the run can be picked.
It was two while a form could offer a company and nothing else; `/chat` now has real subject
pickers (`subjects.ts`), so the two that need a specific filed period or a specific transcript are
askable too, the picker supplying the same `subject_ref` their sweeps supply from the same tables.
`email-workflow` and `reminders` are the two outside, and not by oversight: they call no model and
drain their own queues on their own schedule, so there is nothing to ask them for.
`invocable.test.ts` runs the claim rather than asserting the list — every member must produce a
draft when given the subject it declares and fail when denied it, and the last test holds that
every seeded agent is accounted for by exactly one of those arguments.

Failures are typed — `refusal`, `truncated`, `unparseable`, `schema_mismatch`, `too_large`, `error` —
and the distinction is load-bearing. The first five are properties of *this content* and fail the
same way every time, so the subject is correctly retired. `error` is the catch-all a box with no
credential produces, and those are requeued after six hours: without that, an hour of the timer
running without an API key would have permanently retired every eligible subject.

`failRun` only retires a run on its **last** attempt; below `MAX_ATTEMPTS` it puts the row back as
`queued` with the kind and the error still on it. So "what has failed" is `failure_kind IS NOT NULL
AND status IN ('failed','queued')`, never `status = 'failed'` alone, and `/agents` shows the two
apart — *out of attempts* needs a person, *will be tried again* needs whatever broke the box fixed.
`running` is excluded because a claim does not clear the previous attempt's kind.

**Nothing an agent writes enters the record without a person accepting it.** A run produces an
`ai_drafts` row; `/review` shows its sources *before* its content, the deterministic checks, and
Accept or Reject-with-a-required-reason. Accepting lands it in `documents`/`document_versions` (or
`forensics_answers`). Every draft shows where it came from, before and after that decision.

`costUsd` returns **null** for an unknown model, never zero. v2's dashboard confidently reported
`$0.00` because nothing seeded its price table.

---

## 6. Ask — the request desk

`/chat` is where a person asks an agent for work. It is **not** the chat that used to be there:
agent 8 and its tool loop were cut on 17-Sep-2026 (`0053`), and there is no model to converse with.
You pick a company, you pick an agent, you pick what it should read, and it queues. The draft lands
in `/review` like every other agent's.

All four model-calling agents are askable, which needed `lib/agents/subjects.ts`: agents 1 and 2
take a `subject_ref` — one filed period, one transcript — that no plain form could supply, so the
desk offers the same rows their sweeps read, filtered the same way. A superseded period or a
transcript under `MIN_TRANSCRIPT_CHARS` is never offered, because the handler would refuse it
*after* the run had been claimed. A subject already read is offered and labelled rather than hidden:
the sweeps skip those because they must not spend twice unasked, but a person asking again has asked
on purpose.

`askAgent` re-checks all of it server-side — the agent is invocable, the subject it declares is
present, and the `subject_ref` is one this agent could be pointed at — because a `<select>` is a
suggestion and the value posted back is whatever the browser sent.

The page is a card per agent; `?agent=` opens one into its form and **its history**. A person sees
what they asked that agent for; an admin sees everybody's. That rule is a `WHERE` clause in
`lib/agents/history.ts`, not a filter in the page — a page that fetched everything and rendered some
of it has still sent the rest to the browser — and the card counts obey the same clause, so a card
cannot say "2 requests" over a page that shows none. **Sweep runs are not history**: 79 of 88 rows
were enqueued unattended when this was written, and those are the registry's subject, not a record
of somebody asking. The history closes the loop rather than stopping at a status — a row links to
the draft waiting in `/review`, or to the document an accepted one became.

**`/agents` is admin-only** from the same day: what runs unattended, on what model, at what cost, and
what failed is operating detail, the argument `0030` made for spend applied to the page it was on.
The rail's fifth hub therefore changes destination by role — admins get the registry, everybody else
gets `/review`, which is a prefix of that hub and is the one screen an analyst's job actually is.

## 7. Learning

Two sources, one store, and the loop actually closes.

**Exemplars.** When a person accepts an agent draft, the edit distance between what the agent wrote
and what they accepted is computed and stored, and an `exemplars` row is written with a *situation
string* — one line describing the **inputs**, never naming the company. Embedding happens on a
worker, never on the accept transaction: an analyst clicking accept must not wait on a model load,
and a failure there must not cost them the acceptance. **Rejections are not exemplars** — a rejection
says what was wrong without ever saying what right would have looked like.

**Rules.** Repeated corrections to the same field distil into a proposed `prompt_rules` row at
3 observations and 0.25 mean distance. Distillation is **mechanical, never a model summary**: a
generated paragraph reads better and cannot be checked. A rule enters a prompt only after a person
approves it on `/rules`, enforced by both code and schema check constraints, and can be retired but
never deleted.

The assembled system prompt is, in order: **purpose → approved rules → examples**. Three agents learn
(`concall-insights`, `news-brief`, `forensics-review`); the column is what gates it.

Mean edit distance per agent per week is rendered on `/agents`, which is the measurement that decides
whether this loop survives.

---

## 8. Jobs and scheduling

24 entry points, 19 on a systemd timer. The rest are operator tools (`requeue`, `seed-user`,
`set-admin`, `reset-password`) or hand-run backfills.

Each job writes an `ingestion_runs` row — started, finished, status, items, detail — and downstream
readers gate on **that row rather than on the clock**. `jobs/alerts.ts` runs only after a successful
EOD ingest for today, not at a time of day. `report-failure` is named by `OnFailure=` on every unit,
so a job that dies tells somebody.

`jobs/heartbeat.ts` is a dead-man's switch: it reports health by *arriving*.

**Mail is one envelope a person a morning.** Producers write a `notification_outbox` row per person
per event as they always did; `lib/digest.ts` gathers each person's unsent rows into one mail after
07:00 IST and marks them sent together (`0054`). Per-event sending is gone — a person gets one mail
a day and never more, and an urgent alert waits until morning, which was chosen over an inbox that
interrupts. One instant governs a pass: the hour gate, the "already sent today" check and the
`sent_at` stamp all read the same `now`, because two clocks deciding one thing answers "still today"
and "already tomorrow" in the same run. No relay configured is a valid state — the outbox keeps
queueing and the run says how many are waiting.

**A person may link their own mailbox** (account menu → Link your mailbox, `0055`), and their digest
then leaves from their own address rather than the shared relay. This is the schema's **first
reversible secret**: everything else stored is one-way, and an SMTP password cannot be, because AUTH
sends it. `lib/mailbox.ts` narrows the exception — AES-256-GCM under `MAILBOX_KEY` from the box's
environment (never pgcrypto: a key beside the ciphertext is filing, not encryption), **no plaintext
fallback** when the key is absent, and the web process seals but never opens. Credentials are proved
by sending a real message before anything is stored, so a linked mailbox has carried something at
least once. A mailbox that later stops working records why, falls back to the shared relay, and says
so in that person's account menu — the failure it exists to prevent is one that still delivers.

Linking is **prompted once and never required** (`0056`): a modal on first sign-in, answered by
linking or by declining, and `users.mailbox_prompted_at` records that it was asked either way.
Somebody who declines still gets their digest, through the shared relay. Gating it was considered
and rejected — the two mail agents are shared by the whole desk, so a global gate would let one
unlinked person stop everybody's mail.

---

## 9. The interface

Six hubs, in the order of the working day: **Desk · News · Portfolio · Companies · Agents · Ask**.
`components/Rail.tsx` is the single source of navigation. Ask is last for the reason the cut chat
box was — you read first and ask second — and carries no badge: what you asked for waits on a model,
not on you. The Agents hub reads "Review" and points there for anybody who is not an admin.

Three standing rules, all of which have cost something to learn:

- **State lives in the URL.** `?tab=`, `?filter=`, `?scope=`, plain links. Pages stay server
  components and a refresh lands where you were.

  **One exception, argued in `components/PriceChart.tsx`:** the price chart's range is component
  state. It was `?range=` until 17-Sep-2026, so looking at five years and then at one month
  re-rendered the whole company page twice — the documents panel, the shareholding, the coverage
  form, none of which change — to redraw a line over closes the browser could already have had. The
  page now loads the whole history once (`priceHistory`, ~270 closes a name today) and `windowOf`
  slices it in the browser. What the rule protects is a deliberately-chosen filter surviving a
  refresh; a chart zoom is a lens on data already on the page, costs one click to restore, and falls
  back to the whole history rather than an arbitrary slice. `?archived=` on the same page still
  lives in the URL and still should.
- **Where the system declines to answer, render `<Blank why="…" />`.** Never a zero: an empty cell
  reads as broken, a dash reads as not-applicable, and a zero reads as a measured fact — the most
  dangerous of the three.
- **Styling is by class, never inline `style` objects.** An inline style cannot express `:hover`,
  `:focus-visible`, `:active` or `:disabled`, and a control with no hover state is the fastest way to
  look unfinished.

**Tailwind v4 is present and on a short leash.** `app/tailwind.css` imports `theme` and `utilities`
only — the preflight would be a second reset competing with the one `globals.css` already has — and
clears three token namespaces before declaring ours. Clearing `--color-*` is the load-bearing one:
Tailwind's default palette is ~300 colours, the design system allows one accent and three meanings,
and `bg-red-500` now fails to compile rather than relying on somebody remembering the rule. The
`v4.md` constraint that forbade this is reversed there, with the reasoning, rather than edited away.

`components/ui.tsx` is the kit, and it is hand-written. Nothing is vendored: the `shadcn` CLI is a
devDependency for pulling a component down to read, but no Radix or Base UI package is a dependency
and there is no `components/primitives/`. Four shadcn components were refused on purpose — `Tabs`,
`ToggleGroup` and `Select` hold client state and would convert a server page into a client one, and
`Form` would do the same to every form in the tree. There are zero `'use client'` files in `app/`
and that is the property being protected; the 18 components that do carry the directive all live in
`components/`, where the boundary is explicit.

`ops/measure-css.ts` is the census: it reports dead selectors, and fails on a class a component
names that no stylesheet defines. `styles/unbuilt/` holds stylesheets for cut or unbuilt screens and
is imported by nothing.

Read `.interface-design/system.md` before adding any screen.

---

## 10. Running it

```bash
export DATABASE_URL=postgres:///trisula_v3_dev
pnpm install
pnpm fetch-model                 # ~130 MB, bge-small-en-v1.5, validated on download
pnpm exec tsx db/migrate.ts      # one transaction each, checksummed
pnpm check                       # lint + typecheck + 814 tests
pnpm dev                         # port 3100
```

Tests create and drop their own databases and need `createdb`/`dropdb` on PATH. The retrieval tests
need the embedding model present; `pnpm fetch-model` is idempotent and leaves a good copy alone.

**Stop `pnpm dev` before running `pnpm check`.** Node's test runner spawns one process per file and
several of them load the 130 MB ONNX session; with a dev server holding one too, onnxruntime aborts
the process — `libc++abi: recursive_mutex lock failed` — and three model-loading files fail with no
assertion error to explain themselves. Measured 15-Sep-2026: 3 failures with the server up, 616/616
with it stopped — the suite was 616 tests then — and those same three files pass in isolation
either way. It looks like a broken test and it is a resource conflict.

Measured again 21-Sep-2026, which narrows it: a dev server belonging to a *different* worktree, on
the same port, did **not** reproduce it — 814/814 passed with one running. The conflict is over the
ONNX session in this checkout, not over the port, so it is your own `pnpm dev` that has to stop.

Jobs run as `pnpm exec tsx jobs/<name>.ts`. Deployment, backup, and the systemd units are in
`ops/SETUP.md`.

# Architecture

How Trisula is put together, and why it is put together that way. Accurate against the tree at the
time of writing: **51 migrations, 50 tables, 7 agents, 24 job entry points, 19 systemd timers, 18
routes, 619 tests.** Every number here was counted, not remembered; if you change the shape, count
again rather than editing around it.

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

50 tables, none ever dropped. Grouped by what they are for:

```
IDENTITY & AUDIT   actors · users · sessions · recovery_codes · audit_log
                   access_requests · ingestion_runs
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
CHAT               chat_threads · chat_messages · chat_tool_calls
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
bhavcopy EOD prices · XBRL fundamentals · shareholding patterns and holders · insider transactions ·
corporate actions · the calendar · annual reports.

Two rules govern all of them.

**A feed or job that returns zero items is a failure, not a quiet day.** A dead feed must never look
like a quiet one. Five exemptions are documented, each stated in the file it applies to and counted
in `CLAUDE.md` so the roster lives in one place: no bhavcopy on a non-trading day, the news gate's
empty queue, the content indexer's two empty queues, a distillation run that raised no rule, and an
agent sweep that queued nothing. The last two are not "the queue was empty" — the queue is full and
the right answer is still nothing, which is why each file argues its own case.

**Ask "what has no run yet", never "what is new since I last looked."** Sweeps and evaluators use
`NOT EXISTS`, not a watermark or a rolling window. A window can only lose things, and it already
cost this system two real alerts.

`companies` is the universe. Nearly every ingest job filters to followed names, so adding a company
is what makes the machine fetch its history — `companies.backfilled_at` is a queue drained by
`jobs/backfill-company.ts` on a timer.

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
whitespace → hard cut. A spreadsheet chunks by **row block**, never mid-row: a grid cut mid-row
retrieves as noise — a number with no idea which line it belonged to. The invariant that makes a
citation work is `source.slice(char_from, char_to) === chunk.text`, where `source` means exactly what
`textFor` returns.

**Search is hybrid** — vector and full-text, merged by reciprocal rank fusion at k=60, then collapsed
to at most three chunks per source. Full-text terms are OR-ed, not AND-ed: *"what has management said
about the auditor"* should surface a page mentioning the auditor and never the word "management".

**There is no relevance floor, and that is a finding rather than an omission.** Twenty questions
against the live corpus produced no cosine value separating relevant from irrelevant. Relevance
judgement moved into the chat tool loop instead.

`jobs/index-content.ts` drains two queues in one run — unindexed sources and unembedded exemplars —
because both are the same operation against the same loaded 130 MB model.

---

## 5. Agents

Seven, as rows in `agents`. An agent absent from that table cannot be invoked.

| key | trigger | what it does |
|---|---|---|
| `results-figures` | event | reads a filed results period, with a deterministic verifier |
| `concall-insights` | event | reads a transcript against the previous one |
| `forensics-review` | event | works the fund's own 14-item forensic checklist |
| `news-brief` | prompt | the week's confirmed news, per company |
| `desk-analyst` | prompt (chat) | the whole-company read, with tools |
| `email-workflow` | schedule | drains `notification_outbox` |
| `reminders` | schedule | what is due |

Everything funnels through the `agent_runs` queue, drained by one timer every five minutes. Claiming
uses `FOR UPDATE SKIP LOCKED` with a 30-minute lease. "Event" agents are not push-driven: they are
`NOT EXISTS` sweeps against `agent_runs`, per the house rule.

Failures are typed — `refusal`, `truncated`, `unparseable`, `schema_mismatch`, `too_large`, `error` —
and the distinction is load-bearing. The first five are properties of *this content* and fail the
same way every time, so the subject is correctly retired. `error` is the catch-all a box with no
credential produces, and those are requeued after six hours: without that, an hour of the timer
running without an API key would have permanently retired every eligible subject.

**Nothing an agent writes enters the record without a person accepting it.** A run produces an
`ai_drafts` row; `/review` shows its sources *before* its content, the deterministic checks, and
Accept or Reject-with-a-required-reason. Accepting lands it in `documents`/`document_versions` (or
`forensics_answers`). Every draft shows where it came from, before and after that decision.

`costUsd` returns **null** for an unknown model, never zero. v2's dashboard confidently reported
`$0.00` because nothing seeded its price table.

---

## 6. Chat

`/chat` is the sixth rail hub and the only free-text way into the system. A thread is
`chat_threads` → `chat_messages` → `chat_tool_calls`.

`chat_messages.role` is `person`, `agent` or `system` — **never `assistant`**. A model's answer is a
draft in the review queue, not a message in a conversation, and blurring that is how AI text ends up
read as settled.

The desk analyst runs a tool loop bounded at **8 API round trips** with six tools:

`search_corpus` · `get_financials` · `get_position` · `list_filings` · `run_agent` · `draft_document`

Only two of those write, and both write to the same accept gate: `run_agent` enqueues an
`agent_runs` row, `draft_document` writes a `pending` `ai_drafts` row. **Nothing in chat can write to
the ledger.** A test asserts exactly that by enumerating the tools' write targets.

History is bounded at 10 turns / 40,000 characters, oldest dropped first. When the cap is reached
the turn closes on the history the runner already holds, with `tool_choice: none` and a plain
instruction that the budget is spent — the model answers with what it has, or says what it could not
find out.

Delivery is server render plus a 3-second poll. The turn is a queued `agent_runs` row worked after
the response, so closing the tab does not lose the answer.

---

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

The assembled system prompt is, in order: **purpose → approved rules → examples**. Four agents learn
(`concall-insights`, `news-brief`, `forensics-review`, `desk-analyst`); the column is what gates it.

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

---

## 9. The interface

Six hubs, in the order of the working day: **Desk · News · Portfolio · Companies · Agents · Chat**.
`components/Rail.tsx` is the single source of navigation. Chat is sixth and last on purpose — a chat
box at the top of a research tool trains you to ask it things the screens answer better.

Three standing rules, all of which have cost something to learn:

- **State lives in the URL.** `?tab=`, `?filter=`, `?scope=`, plain links. Pages stay server
  components and a refresh lands where you were.
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

`components/primitives/` holds vendored shadcn/Base UI components; `components/ui.tsx` composes them
into the kit. Three shadcn components are refused on purpose — `Tabs`, `ToggleGroup` and `Select`
are client-state and would convert server pages into client ones, and `Form` would do the same to
all 41 forms. There are zero `'use client'` files in `app/` and that is the property being
protected.

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
pnpm check                       # lint + typecheck + 619 tests
pnpm dev                         # port 3100
```

Tests create and drop their own databases and need `createdb`/`dropdb` on PATH. The retrieval tests
need the embedding model present; `pnpm fetch-model` is idempotent and leaves a good copy alone.

**Stop `pnpm dev` before running `pnpm check`.** Node's test runner spawns one process per file and
several of them load the 130 MB ONNX session; with a dev server holding one too, onnxruntime aborts
the process — `libc++abi: recursive_mutex lock failed` — and three model-loading files fail with no
assertion error to explain themselves. Measured 15-Sep-2026: 3 failures with the server up, 616/616
with it stopped, and those same three files pass in isolation either way. It looks like a broken
test and it is a resource conflict.

Jobs run as `pnpm exec tsx jobs/<name>.ts`. Deployment, backup, and the systemd units are in
`ops/SETUP.md`.

# Trisula

An all-in-one desk for a three-person fund: research a name, see the book, know what happened, and
ask agents to do the reading.

Long-only Indian small/mid-cap, ~40 names, end-of-day only, three users, one VM in Mumbai.

## This is v3, extended by v4

v2 lives at `../trisula` and is not being extended. It is 62,000 lines across 85 tables, two
languages and eleven agents, and it was never deployed. Almost every mechanism in it is argued for
well; it answered a question (provability for a regulator) that turned out not to be the question.

v3 keeps the UI and the design system, ports the code that already works, and drops the rest — and
it is what runs today. **v4 adds the layer v3 deliberately cut**: a content store over everything
the fund holds, retrieval across it, chat, and the learning loop. It extends v3 rather than
replacing it.

The design, capabilities and phase plans live in `docs/specs/` and `docs/plans/` — private,
gitignored. Start with `docs/specs/v4.md`: §2 describes the built system, the rest describes what is
being added.

## Ground rules

1. A capability is done when one of the three of us uses it in a normal week.
2. Nothing is built for a hypothetical: no regulator, administrator, LP, or absent future user.
3. If a stage cannot show a measurement that it helps, it does not ship.
4. Simpler beats provable, until there is someone to prove it to.

## Layout

```
app/            Next.js App Router — the UI
components/     the design system
lib/            db · auth · agents · retrieval · ingest adapters · domain logic  (server-only)
jobs/           24 entry points, 19 of them on a systemd timer
db/             migrations/*.sql from 0001, and the runner
ops/            provision · backup · systemd units · measurement scripts
```

One package, no workspace. The jobs are `tsx` scripts importing the same `lib/` the app imports,
so `lib/` must never import from `next/*` — the lint rule in `eslint.config.js` enforces it.

**`ARCHITECTURE.md` describes how the system is put together** — the data model, ingestion,
retrieval, the agents, chat, and the learning loop, with the constants and invariants that matter.
Read it before changing anything structural, and `.interface-design/system.md` before adding any
screen.

## A constraint worth knowing

Node runs the TypeScript here natively, in **strip-only** mode: it deletes type annotations and
generates nothing. So three TypeScript features are syntax errors at runtime even though `tsc`
accepts them — **parameter properties** (`constructor(readonly x: T)`), **enums**, and
**namespaces**. Declare and assign instead; use a `const` object with `as const` in place of an
enum. There is no build step and that is the trade.

## Getting started

Requires Node 22.18+ — the release that made the type stripping above default — and Postgres 18
with the `vector` extension available. pnpm is pinned by `packageManager` in `package.json`, so
`corepack enable` gets you the right one.

```bash
export DATABASE_URL=postgres:///trisula_v3_dev
pnpm install
pnpm fetch-model                 # ~130 MB embedding model, validated on download
pnpm exec tsx db/migrate.ts      # migrations are one transaction each, checksummed
pnpm check                       # lint + typecheck + 619 tests
pnpm dev                         # port 3100
```

Tests create and drop their own databases, so they need `createdb`/`dropdb` on PATH. The retrieval
tests need the embedding model present — `pnpm fetch-model` is idempotent and leaves a good copy
alone. Jobs run as `pnpm exec tsx jobs/<name>.ts`; deployment lives in `ops/SETUP.md`.

**Stop `pnpm dev` before `pnpm check`.** Both load the ONNX embedding session, the test runner loads
several at once, and onnxruntime aborts the process rather than queueing — three model-loading files
fail with no assertion error to explain them. See `ARCHITECTURE.md` §10.

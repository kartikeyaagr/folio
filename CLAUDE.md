# Trisula

Investment research and portfolio management for a three-person SEBI Category III AIF running a
long-only Indian small/mid-cap book. Internal tool, behind a private network, no public signup, no
guest access. The people using it open it before the market opens and after it closes; the work is
reading and judgement, not reacting.

**This is v3, a rebuild.** The previous system lives at `../trisula` and is being replaced. Read
nothing from it as evidence about this one — several of its subsystems were deliberately not
carried forward. Its `docs/` holds the design documents this tree was built from; copies are in
`docs/specs/` here.

## The design documents

`docs/specs/` (gitignored, private):

| File | What it settles |
|---|---|
| `capabilities.md` | The *what*: capability list A1–A8, B, C1–C8, D1–D6, E, and what was explicitly cut |
| `design.md` | The *how*: schema, the seven agents, error handling, build order P0–P7 |
| `design-system.md` | The UI's standing rules — read before adding any screen |
| `forensic-checklist.md` | The fund's own 14-item checklist, worked by agent 7 |
| `v2-system-map.md` | What the old system did, for reference only |

**A gap against something the specs deliberately cut is not a gap.** Check before "fixing" it.
D2 cut `/returns`, `/attribution`, `/thesis`, `/memo` and `/pipeline`. C7 declines clustering.
C8 declines a news vendor. The investor-letter agent was cut and its number not reused.

## Running it

```bash
export DATABASE_URL=postgres:///trisula_v3_dev
pnpm exec tsx db/migrate.ts      # migrations are one transaction each, checksummed
pnpm check                       # lint + typecheck + 222 tests
pnpm dev                         # port 3100
```

Tests create and drop their own databases; they need `createdb`/`dropdb` on PATH. Jobs run under
`pnpm exec tsx jobs/<name>.ts` and each writes an `ingestion_runs` row.

## Boundaries that are enforced, not suggested

1. **`lib/` never imports Next.** It is imported by both the app and the standalone `tsx` jobs; a
   `next/*` import compiles for the web and dies in a job. An eslint rule replaces the guarantee
   that v2 got for free by having its services in Python.
2. **`app/` may import `lib/`; `lib/`, `jobs/` and `db/` may never import `app/`.** The backend has
   to stay provable without the frontend.
3. **Web-only helpers live in `app/_lib/`**, never in `lib/`. Cookies, sessions, server actions.
4. **300-line cap on files in `lib/`** (a warning). v2's `pipeline.ts` reached 2,007 lines because
   nothing separated fetching from rendering.

## House standards

- **Every write is attributed.** `writeTxn(actorId, …)` for a person, `serviceTxn(principal, …)`
  for a job. Postgres RAISES on an unattributed write and on an unknown actor — service principals
  are seeded in migrations, and `ServicePrincipal` in `lib/db.ts` is the same closed set.
- **A feed or job that returns zero items is a failure, not a quiet day.** A dead feed must never
  look like a quiet one. Two documented exemptions: no bhavcopy on a non-trading day, and the news
  gate's empty queue. Both say so in their own file.
- **Ask "what has no run yet", never "what is new since I last looked."** Sweeps and evaluators use
  `NOT EXISTS`, not a watermark or a rolling window. A window can only lose things — it already
  cost this system two real alerts.
- **Where the system declines to answer, render `<Blank why="…" />`.** Never a zero: an empty cell
  reads as broken, a dash reads as not-applicable, and a zero reads as a measured fact, which is
  the most dangerous of the three.
- **Nothing an agent writes enters the record without a person accepting it**, and every draft
  shows where it came from before and after that decision.
- **Cost is visible and true.** `costUsd` returns null for an unknown model, never zero. v2's
  dashboard confidently reported `$0.00` because nothing seeded its price table.
- **State lives in the URL** — `?tab=`, `?filter=`, `?scope=` and plain links. Pages stay server
  components; a refresh lands where you were.

## Writing code here

Node runs TypeScript in **strip-only mode**: no parameter properties, no enums, no namespaces —
they are runtime syntax errors, not just style. Relative imports inside `lib/` carry the `.ts`
extension.

Comments explain **why**, and record what was measured. The valuable comments in this tree name a
trap and the evidence for it — "NSE's year-to-date context declares the quarter's dates while
carrying nine months of figures; verified on 24 live filings, all 24 disagreed". Do not restate
what the code does.

Before adding a UI control, check `components/ui.tsx` and the classes in `app/globals.css`. Styling
is by class, never inline `style` objects — an inline style cannot express `:hover`, `:focus-visible`,
`:active` or `:disabled`, and a control with no hover state is the fastest way to look unfinished.

## Skill routing

When the user's request matches an available skill, invoke it. When in doubt, invoke the skill.

- Product ideas or brainstorming → `/office-hours`
- Strategy and scope → `/plan-ceo-review`
- Architecture → `/plan-eng-review`
- Design system or plan review → `/design-consultation`, `/plan-design-review`
- Bugs and errors → `/investigate`
- QA of site behaviour → `/qa` or `/qa-only`
- Code review of a diff → `/review`
- Visual polish → `/design-review`
- Ship or deploy → `/ship`, `/land-and-deploy`

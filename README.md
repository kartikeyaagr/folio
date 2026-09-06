# Trisula

An all-in-one desk for a three-person fund: research a name, see the book, know what happened, and
ask agents to do the reading.

Long-only Indian small/mid-cap, ~40 names, end-of-day only, three users, one VM in Mumbai.

## This is v3

v2 lives at `../trisula` and is not being extended. It is 62,000 lines across 85 tables, two
languages and eleven agents, and it was never deployed. Almost every mechanism in it is argued for
well; it answered a question (provability for a regulator) that turned out not to be the question.

v3 keeps the UI and the design system, ports the code that already works, and drops the rest.
The design, capabilities and phase plan live in `docs/superpowers/specs/` — private, gitignored.

## Ground rules

1. A capability is done when one of the three of us uses it in a normal week.
2. Nothing is built for a hypothetical: no regulator, administrator, LP, or absent future user.
3. If a stage cannot show a measurement that it helps, it does not ship.
4. Simpler beats provable, until there is someone to prove it to.

## Layout

```
app/            Next.js App Router — the UI
components/     the design system
lib/            db · auth · agents · ingest adapters · domain logic  (server-only)
jobs/           the seven scheduled entry points
db/             migrations/*.sql from 0001, and the runner
ops/            provision · backup · systemd units
```

One package, no workspace. The jobs are `tsx` scripts importing the same `lib/` the app imports,
so `lib/` must never import from `next/*` — the lint rule in `eslint.config.js` enforces it.

Read `.interface-design/system.md` before adding any screen.

## Getting started

Requires Node 22+, pnpm 9, and Postgres 18.

```bash
pnpm install
pnpm check      # lint + typecheck + test
```

# CODE_STYLE.md

What code in this repository looks like. **Match the file you are in first.** This page states the
conventions that hold across all of them. The UI's rules live in `.interface-design/system.md`;
read that before adding a screen or a control.

## 1. Stack

- **TypeScript**, `strict` plus `noUncheckedIndexedAccess`.
- **Next.js 15 App Router**, server components throughout.
- **Plain CSS by class** in `app/globals.css` and `styles/*.css`, with Tailwind v4 admitted on the
  terms in system.md.
- **`pg` and plain SQL.**
- **`node:test`**, and ESLint with typescript-eslint.
- **No Prettier, and no build step for `lib/` or `jobs/`.**

## 2. TypeScript that Node can run

The test runner is `node --test`, which runs TypeScript with Node's **strip-only** type stripping:
it deletes annotations and generates nothing. The tests import `lib/`, `jobs/` and `db/`, so three
things `tsc` accepts are runtime syntax errors there. Jobs run under `tsx` on the box and Next
compiles the app, and both would forgive them, which is exactly how one slips in:

- **parameter properties** (`constructor(readonly x: T)`): declare and assign instead;
- **`enum`**: use a `const` object `as const`, or a string-literal union;
- **`namespace`**: use a module.

Relative imports in `lib/`, `jobs/` and `db/` carry the `.ts` extension. `app/` and `components/`
import `lib/` through `@/`, and `lib/` never uses `@/`.

## 3. Boundaries

Enforced by `eslint.config.js`:

- **`lib/` never imports `next`, `next/*` or `server-only`.** Jobs import `lib/`, and a Next import
  compiles for the web and dies in a job.
- **`lib/`, `jobs/` and `db/` never import `app/`.**
- **A `lib/` file is capped at 300 lines, blank and comment lines excluded (a warning).** Split by
  responsibility before you reach it.

By convention, with nothing enforcing it: **web-only helpers (cookies, sessions, actions) live in
`app/_lib/`.**

## 4. Formatting

There is no formatter, so match what is there:

- 2-space indent, single quotes and semicolons;
- trailing commas in multi-line literals;
- about 100 columns.

Never reformat a file you are not otherwise changing.

## 5. Naming

| Thing | Convention | Example |
|---|---|---|
| Component file | `PascalCase.tsx`, named exports only | `components/FiledDocument.tsx` |
| `lib/` and `jobs/` file | `kebab-case.ts`; `_`-prefixed for job-runner internals | `lib/access-requests.ts`, `jobs/_run.ts` |
| Server action | In `app/_lib/actions/<area>.ts`. New ones end in `Action`; about a third of the existing ones predate that (`accept`, `markNews`) | `importFileAction` |
| Error class | Named for the condition, extends `Error` | `TitleRequired`, `TooManyAttempts` |
| Migration | `NNNN_a_sentence_in_snake_case.sql` | `0032_a_way_to_ask_for_an_account.sql` |
| SQL | `snake_case` everywhere | `decided_at` |
| Test | `<file>.test.ts` beside the file it tests, each test named as a sentence | `'a code works once, and the second attempt is refused'` |

ESLint's naming rule allows camelCase, `UPPER_CASE` or PascalCase for variables, camelCase or
PascalCase for functions, and PascalCase for types. Object properties are exempt, because they carry
`snake_case` columns.

## 6. Patterns to reuse

- **Writes:** `writeTxn(actorId, …)` or `serviceTxn(principal, …)` (DATABASE.md §2).
- **Server actions:** the contract in API.md §2. `requireUser()` goes first and outside any `try`.
- **Absence:** render `<Blank why="…" />` where the system declines to answer. Never render `0`, a
  dash, or an empty cell for a missing value.
- **Sweeps:** ask "what has no run yet" (`NOT EXISTS`), never "what is new since" (a watermark or
  window).
- **Jobs:** wrap the work in `runJob()`. Zero items throws unless the file argues an exemption.
- **Cost:** `costUsd` returns `null` for an unknown model, never `0`.
- **UI:** check `components/ui.tsx` and `app/globals.css` before adding a control. Style by class,
  never an inline `style` object, which cannot express `:hover`, `:focus-visible` or `:disabled`.
- **State in the URL:** `?tab=`, `?filter=` and plain links. Pages stay server components.

## 7. Comments

Comments explain **why**, and record what was measured. The valuable ones name a trap and the
evidence for it:

```ts
// NSE's year-to-date context declares the quarter's dates while carrying nine months of figures;
// verified on 24 live filings, all 24 disagreed.
```

Do not restate what the code does. When a comment's claim stops being true, fix the comment in
the same change. A stale comment is how the next reader gets misled.

## 8. Tests

- **`node --test '**/*.test.ts'`, with `node:assert/strict`.**
- **A test that touches the database creates its own**, against a real Postgres, with
  `createTestDatabase(name)` from `db/testing.ts`. Some older files still call `createdb`
  directly; new ones use the helper. There is no mocking of `pg`.
- **The model is stubbed with `scriptedModel`** (`lib/agents/model.ts`). No test calls the API.
- **Mutation-check every guard you add.** Revert the fix, watch the test fail, then restore it. A
  test that passes with the fix deleted is decorative.

## 9. Before you call it done

1. Stop `pnpm dev`. The test runner and the dev server both load the ONNX model, and onnxruntime
   aborts rather than queueing.
2. `pnpm check`: lint, typecheck and every test.
3. For anything a person sees, `pnpm build && pnpm start` and look at it. `curl` against the built
   server finds what the checks cannot, such as a middleware matcher redirecting `/icon.svg`.
4. Update the documents the change falsifies: ARCHITECTURE.md's counts, and this file,
   SECURITY.md, DATABASE.md or API.md if a rule moved.

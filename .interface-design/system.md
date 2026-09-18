# Trisula — design system (v4)

The standing rules. Read this before adding any screen; if a decision here is wrong, change it here
first and then change the code, so the two never drift.

## Who this is for

Three people running an Indian small/mid-cap fund. They open the app at 8am before the open and at
6pm after the close. They hold twenty to forty names for years. The work is **reading and
judgement**, not reacting — this is not a trading terminal and must never borrow one's visual
language. The product's real subject is a written record that has to survive being reread in three
years and audited in five.

## Feel

**A ledger, not a dashboard.** Warm paper, an ink rail, and no shadows anywhere: a card is a ruled
region, not a floating panel. Hierarchy comes from the rule, the ground step and the weight — in
that order — and never from depth. Corners are softened rather than sharp, because a hairline
already does the separating and a hard corner on top of it reads as two statements of the same
thing. Dense where the work is dense, calm everywhere else.

## Direction

|             |                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ground**  | `--bg` #f6f3ee, a warm paper. Cards are `--surface` #fffdfa; inset areas (tiles, table heads, segmented controls) are `--surface-2` #efebe3. Dark swaps the whole set; the rail stays ink.       |
| **Ink**     | Four levels: `--ink` `--ink-2` `--muted` `--ghost`. Fewer than four and hierarchy goes flat. `--ghost` is for non-text only.                                                                     |
| **Accent**  | One: `--navy` #2a3a52, for the primary action and the active state. Three meanings — `--teal` good, `--red` bad, `--amber` pending — each with a `-soft` wash. **Never a fourth**, and since v4 that is enforced by the build rather than by memory: see *Tailwind* below. |
| **Depth**   | **None.** `--shadow-sm` is `none`. Separation is a 1px `--line`; a thing that has left the page (dialog, popover, toast) gets a `--line-2` ring, not a drop shadow. Boxes inside a card use a rule. |
| **Type**    | `Manrope` for chrome; `Lora` for anything that is a record — document bodies, the editor, `.prose`, **and the figures in `Stat`**. A number this fund will reread in three years is part of the record, not part of the UI. Both self-hosted via `next/font/google` — no runtime CDN, because the app runs behind Tailscale. |
| **Scale**   | 14px base. Titles 18/600, detail headlines 26/600, stats 22/800, facts 18–20/800, eyebrows 12/700 uppercase. Hierarchy comes from **weight and colour first**, size last.                        |
| **Numbers** | `tabular-nums` globally on `td`, `th`, `.num`, `[data-num]`. Indian grouping (`inr()`), crore where the fund thinks in crore (`crore()`).                                                        |
| **Spacing** | Base 4. Table cells `9px 13px`. Card body `16px 18px`. Pane body `26px 30px`. Page gap 16. The rail is 72px; the header 60px.                                                                    |
| **Radius**  | `--r-sm` 7 (inputs, seg options) · `--r-md` 10 (buttons, fields) · `--r-lg` 14 (cards, panes) · `--r-xl` 18 (dialogs, login card). The hatch keeps 3: it is a mark, not a container.             |
| **Motion**  | ≤350ms, `--ease` (ease-out) only. `rise` for anything that appears. Press is `scale(0.97)`. Never animate anything but transform and opacity. `prefers-reduced-motion` drops movement.           |

## Structure

**Six hubs, not twenty pages.** The rail in `components/Rail.tsx` is the single source: Desk · News ·
Portfolio · Companies · Agents · Chat. It is six and not the five this document claimed through v3 —
Chat was added and the count was never updated here, so every reader of this file was told
something the rail disproved. Chat is last on purpose: a chat box at the top of a research tool
trains you to ask it things the screens answer better. Inside a hub, pages are tabs (`Tabs`,
URL-driven) or segmented views (`Seg`).

**The page header is the page's.** Every page renders `<AppHeader title subtitle>` from its own
data: the title is one or two plain words, the subtitle one line of figures. ⌘K and the date live
there on every page.

**Two shapes of page.** A `.split` (list pane beside a detail pane, the panes scroll) for anything
that is a queue — the desk, news, review. A `.page` (the document scrolls, cards stack) for
everything else. On a phone both stack and the rail becomes a bottom bar.

> `.split` is prescribed for four screens and used by one — `/chat`, which is itself being removed.
> Either the desk, news and review move into it or this rule stops claiming they will. It is
> recorded here rather than quietly dropped, because a design system that describes a layout
> nothing uses is how three people invent three layouts.

## Rules that came from the user, and hold everywhere

1. **No explanatory subheadings.** A page states its name and shows its content. If a screen needs
   a paragraph to be understood, the screen is wrong.
2. **Headings are one or two plain words.** "Killed", not "Names we passed on".
3. **A figure buried in a sentence is a figure nobody reads.** Summary numbers go in a `StatRow` or
   a `Facts` grid at the top, leading by weight.
4. **Copy says what actually happened.** A toast names what was recorded and as whom. A button
   that trains a classifier says so only if it does.

## The signature — `<Blank why="…" />`

The hatched cell, used everywhere the system **declines** to answer rather than failing to. The
three alternatives are all worse: an empty cell reads as broken; a dash reads as "not applicable";
**a zero reads as a measured fact and is the most dangerous of the three.** The hatch says
_deliberately blank_ and `why` says on what grounds. Never use it for a value that is still loading.
Retrieval returning nothing is a `<Blank>`, not an empty list.

## Two states that are not `Blank`

- **Loading** — a skeleton row matching the shape of the content it replaces. Never a spinner,
  never `Blank`. **Still unimplemented:** no route has a loading boundary.
- **Quiet day** — a plain sentence naming what was checked and when. Never "No items". With forty
  names most days are quiet, and a desk that reads as broken on a working morning stops being
  opened. An empty list and a failed fetch must never look the same. **Implemented on one screen of
  eleven** (`/news`); everywhere else the empty state names no check and no time.

## Components

Everything visual comes from `components/ui.tsx` and the classes in `globals.css`. Before adding a
bespoke control, check it isn't there. Styling is by **class**, not inline `style` objects.

`AppHeader` · `Button` / `LinkButton` (default · primary · quiet · danger · link) · `Card` ·
`Eyebrow` · `Chip` · `Seg` · `Tabs` · `Stat` / `StatRow` · `Fact` / `Facts` · `Blank` · `Empty` ·
`inr()` / `crore()` / `signedPct()` · `DialogButton` (client) · `Toast` (client, fed by `flash()`) ·
`CompanySearch` (client).

`Pill`, `Segs` and `StaleBanner` were on this list and rendered on no screen. They are deleted.
`StaleBanner` told the reader to run `uv run python -m trisula_portfolio.materialise` — a v2 module
that does not exist here — which is why a roster entry with no call site is not a harmless one.

Layout classes: `.split-2` / `.split-3` + `.pane` / `.pane-head` / `.pane-list` / `.pane-body`;
`.item` (a list row: dot, kind line, title); `.detail-*` (a detail heading); `.page`; `.box`;
`.form-grid` / `.form-row` / `.lbl` / `.field`; `.alert` / `.notice`.

Measurements worth remembering:

- `Button` — 36px · `0 14px` · `--r-md` · 13px/600. `.btn-sm` is 30px · `0 10px` · 12px.
- `.tbl` — head 11px/600 uppercase `0.03em` on `--surface-2`, sticky; cells `9px 13px`; row hover
  `--surface-2`. **Always wrap in `.tbl-scroll`.**
- `Chip` — 22px pill, 11px/700, soft wash.
- `Stat` — its own card; label 11px uppercase, value 22px/800 in Lora, sub 11.5px.
- `Fact` — tinted tile; label 11px uppercase, value 18px/800.

## Tailwind, and what it is allowed to do

`docs/specs/v4.md` carried **No CSS framework** as a runtime constraint. It was a premise, never a
measurement — unlike the refusals beside it, each of which was settled by counting something — and
it was reversed in v4 so the component layer could sit on shadcn/Base UI.

Tailwind is admitted on terms, all of them in `app/tailwind.css`:

- **No preflight.** `theme` and `utilities` are imported; the 398-line reset is not. `globals.css`
  already has a reset written for this app.
- **The default palette is cleared, not extended.** `--color-*: initial` empties the namespace
  before ours is declared, so `bg-red-500` and its ~300 siblings do not exist. *"Never a fourth"*
  stopped being a rule someone has to remember and became a class that fails to compile.
- **`--font-*` and `--shadow-*` are cleared too**, because `next/font` and this file already own
  those names. The two faces are `font-chrome` and `font-document`, which is what they mean.

`components/primitives/` holds vendored shadcn components; `components/ui.tsx` composes them into
the kit above. A primitive is never used directly in a page.

**What shadcn is not allowed to bring.** `Tabs`, `ToggleGroup` and `Select` are client-state
components, and adopting them would convert server pages into client ones — see *State lives in the
URL*. `Form` assumes react-hook-form and would do the same to all 41 forms. `Sonner` replaces a
server-set flash cookie with client state. The native `<dialog>` in `DialogButton` and the native
`<details>` in `AvatarMenu` are deliberately script-free and stay that way.

## State lives in the URL

`?tab=`, `?filter=`, `?sel=`, `?sort=` and plain `<a>`s, never client state. Pages stay server
components, every view is linkable, and a refresh lands where you were. There are **zero
`'use client'` files in `app/`** and that is the property to protect. Client components exist for
exactly: the rail's active hub, ⌘K, the theme toggle, the toast, dialogs, the two editors, and a
poll while an agent run is in flight.

Writes go through server actions that end with `flash()` and a redirect or revalidation, so the
reader is told what was recorded.

## Checks before shipping a screen

- Squint: is hierarchy still readable, and is nothing jumping out harshly?
- Every interactive element has hover, focus-visible, active and disabled.
- Every data view has an empty state that says something true, not "No data".
- Verify in the browser at desktop **and** 375px, in light **and** dark.
  `document.documentElement.scrollWidth` must equal `window.innerWidth`.
- `pnpm exec tsx ops/measure-css.ts` — it fails on a class a component names and no stylesheet
  defines. A class with no rule is not a warning, it is a span that inherits.

## Outstanding against this document

Recorded so a gap is not mistaken for a decision:

1. **The phone layout.** A 44px minimum touch target on coarse pointers is required and
   unimplemented — `.btn` is 36px at every width and `.rail-hub` *shrinks* to 52×50 on a phone.
   `styles/shell.css` hides `.rail-icon` below 720px, which is what `ThemeToggle` renders, so there
   is no theme control on a phone at all.
2. **Skeletons and quiet-day empty states**, above.
3. **`.split`**, above.
4. **Three classes a component names and no stylesheet defines:** `.item-sub`, `.doc-edit`,
   `.sheet`.

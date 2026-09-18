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

**Achromatic and quiet, after shadcn.** The palette is shadcn's own, read off ui.shadcn.com rather
than remembered: a neutral scale at literally zero chroma, black as the accent in light and
near-white in dark, and separation carried by a single-step border rather than by shadow. In dark a
card sits *above* the ground — `#171717` on `#0a0a0a` — so elevation is lightness, not a drop
shadow. Dense where the work is dense, calm everywhere else.

**The one thing here that is not shadcn is the colour that means something.** shadcn ships a single
non-neutral token, `destructive`, because a documentation site has one thing to warn about. This is
a book of holdings: `+66.8%` and `−17.6%` sit in the same column and have to be separable before
the sign is read. So teal, red and amber stay. The rule is unchanged — one accent, three meanings,
never a fourth — and the accent is simply black now instead of navy.

## Direction

|             |                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ground**  | `--bg` #ffffff. In light the card is white too and the `--line` #e5e5e5 border does the separating; in dark `--bg` #0a0a0a and `--surface` #171717, so the card lifts. Inset areas are `--surface-2` #f5f5f5 / #262626. Borders in dark are white at 10%, not a solid grey. |
| **Ink**     | Four levels: `--ink` `--ink-2` `--muted` `--ghost`. Fewer than four and hierarchy goes flat. `--ghost` is for non-text only.                                                                     |
| **Accent**  | One: `--navy`, now **black** (#0a0a0a) inverting to #fafafa in dark, exactly as shadcn's `primary` does. The token keeps its name because renaming it touches every stylesheet; it no longer means the colour navy. Three meanings — `--teal` good, `--red` bad, `--amber` pending — each with a `-soft` wash **mixed from the meaning and the surface**, so a wash cannot drift out of step with its colour or its theme. **Never a fourth**, enforced by the build: see *Tailwind*. |
| **Depth**   | **None on a card.** `--shadow-sm` is `none` and a hairline separates, which is what shadcn does. Only a thing that has genuinely left the page — dialog, popover, toast — takes `--shadow-lg`: a 1px ring plus a soft drop. |
| **Type**    | `Geist` for everything written; `Geist Mono` for every figure. The split is no longer serif-versus-sans, it is prose-versus-number: a holdings table is read down its columns, and in a proportional face `1,42,000` and `96,400` are different widths for the same digit count, so the eye re-finds the decimal on every row. The mono face is hung on `.num` / `[data-num]`, which is the app's own marker for a numeric cell — 79 call sites — plus `.stat-v` and `.fact-v`. A company name never becomes monospace. Both faces self-hosted via `next/font/google`; both happen to be on Google Fonts, which is what makes this direction available at all, because a CDN-only face could not be used behind Tailscale however good it looked. |
| **Scale**   | 14px base, not shadcn's 16px — this is a dense book of holdings, not a docs site, and that is the one density decision not taken from them. Titles 18/600, detail headlines 26/600, stats 22/600, facts 18–20/800, eyebrows 12/700 uppercase. Hierarchy comes from **weight and colour first**, size last. |
| **Numbers** | `tabular-nums` globally on `td`, `th`, `.num`, `[data-num]`. Indian grouping (`inr()`), crore where the fund thinks in crore (`crore()`).                                                        |
| **Spacing** | Base 4. Table cells `9px 13px`. Card body `16px 18px`. Pane body `26px 30px`. Page gap 16. The rail is 72px; the header 60px. |
| **Radius**  | shadcn ships one radius, `0.625rem`, and derives the rest. Here: `--r-sm` 6 (inputs, seg options) · `--r-md` 8 (buttons, fields) · `--r-lg` 10 (cards, panes) · `--r-xl` 12 (dialogs, login card). The hatch keeps 3: it is a mark, not a container. |
| **Motion**  | ≤350ms, `--ease` (ease-out) only. `rise` for anything that appears. Press is `scale(0.97)`. Never animate anything but transform and opacity. `prefers-reduced-motion` drops movement.           |

## Structure

**The rail follows the theme now.** Through v3 it was "the one fixed point on the screen" — navy,
then ink, dark in both themes. shadcn's sidebar is a near-white panel held by a border, and taking
its philosophy means taking that: `--rail` is #fafafa in light and #171717 in dark, with a
`--rail-line` border doing the separating. Everything in the rail that used to be white-at-alpha is
a token, because white-at-alpha assumed a dark slab and disappears on a light one.

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
- `Stat` — its own card; label 11px uppercase, value 22px/600 in Geist Mono, sub 11.5px.
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

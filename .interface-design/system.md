# Trisula — design system (v2)

The standing rules. Read this before adding any screen; if a decision here is wrong, change it here
first and then change the code, so the two never drift.

## Who this is for

Three people running an Indian small/mid-cap fund. They open the app at 8am before the open and at
6pm after the close. They hold twenty to forty names for years. The work is **reading and
judgement**, not reacting — this is not a trading terminal and must never borrow one's visual
language. The product's real subject is a written record that has to survive being reread in three
years and audited in five.

## Feel

**A quiet research desk.** A navy rail, white cards on a cool grey ground, one line of context under
every title, and a hatched cell wherever the system declines to answer. Dense where the work is
dense, calm everywhere else.

## Direction

|             |                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ground**  | `--bg` #f4f6f9. Cards are `--surface` white; inset areas (tiles, table heads, segmented controls) are `--surface-2`. Dark theme swaps the whole set; the rail stays navy.                          |
| **Ink**     | Four levels: `--ink` `--ink-2` `--muted` `--ghost`. Fewer than four and hierarchy goes flat.                                                                                                       |
| **Accent**  | One: `--navy`, for the primary action and the active state. Three meanings — `--teal` good, `--red` bad, `--amber` pending — each with a `-soft` wash. **Never a fourth.**                         |
| **Depth**   | `--shadow-sm` on cards, `--shadow-lg` on anything that leaves the page (dialogs, popovers, toasts). Boxes inside a card use a rule, not a shadow.                                                  |
| **Type**    | `Manrope` for chrome; `Lora` for anything that is a document (memo bodies, the editor, `.prose`). Both self-hosted via `next/font/google` — no runtime CDN, because the app runs behind Tailscale. |
| **Scale**   | 14px base. Titles 18/700, detail headlines 26/700, stats 22/800, facts 18–20/800, eyebrows 12/700 uppercase. Hierarchy comes from **weight and colour first**, size last.                          |
| **Numbers** | `tabular-nums` globally on `td`, `th`, `.num`, `[data-num]`. Indian grouping (`inr()`), crore where the fund thinks in crore (`crore()`).                                                          |
| **Spacing** | Base 4. Table cells `10px 12px`. Card body `16px 18px`. Pane body `26px 30px`. Page gap 16. The rail is 72px; the header 60px.                                                                     |
| **Radius**  | `--r-sm` 6 (inputs, seg options) · `--r-md` 8 (buttons, fields) · `--r-lg` 12 (cards, panes) · `--r-xl` 14 (dialogs, login card). Tiles 10.                                                        |
| **Motion**  | ≤350ms, `--ease` (ease-out) only. `rise` for anything that appears. Press is `scale(0.97)`. Never animate anything but transform and opacity. `prefers-reduced-motion` drops movement.             |

## Structure

**Five hubs, not twenty pages.** The rail in `components/Rail.tsx` is the single source: Desk ·
News · Portfolio · Companies · Agents. Inside a hub, pages are tabs (`Tabs`, URL-driven) or
segmented views (`Seg`). Routes are unchanged; every old URL still works and lights the right hub.

**The page header is the page's.** Every page renders `<AppHeader title subtitle>` from its own
data: the title is one or two plain words, the subtitle one line of figures. ⌘K and the date live
there on every page.

**Two shapes of page.** A `.split` (list pane beside a detail pane, the panes scroll) for anything
that is a queue — the desk, news, review, chat. A `.page` (the document scrolls, cards stack) for
everything else. On a phone both stack and the rail becomes a bottom bar.

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

## Components

Everything visual comes from `components/ui.tsx` and the classes in `globals.css`. Before adding a
bespoke control, check it isn't there. Styling is by **class**, not inline `style` objects.

`AppHeader` · `Button` / `LinkButton` (default · primary · quiet · danger · link) · `Card` · `Eyebrow`
· `Chip` · `Pill` · `Seg` · `Tabs` · `Stat` / `StatRow` · `Fact` / `Facts` · `Blank` · `Segs` ·
`Empty` · `StaleBanner` · `inr()` / `crore()` / `signedPct()` · `DialogButton` (client) ·
`Toast` (client, fed by `flash()`) · `CompanySearch` (client).

Layout classes: `.split-2` / `.split-3` + `.pane` / `.pane-head` / `.pane-list` / `.pane-body`;
`.item` (a list row: dot, kind line, title); `.detail-*` (a detail heading); `.page`; `.box`;
`.form-grid` / `.form-row` / `.lbl` / `.field`; `.alert` / `.notice`.

Measurements worth remembering:

- `Button` — 36px · `0 14px` · `--r-md` · 13px/600. `.btn-sm` is 30px · `0 10px` · 12px.
- `.tbl` — head 11px/600 uppercase `0.03em` on `--surface-2`, sticky; cells `10px 12px`; row hover
  `--surface-2`. **Always wrap in `.tbl-scroll`.**
- `Chip` — 22px pill, 11px/700, soft wash.
- `Stat` — its own card; label 11px uppercase, value 22px/800, sub 11.5px.
- `Fact` — tinted tile; label 11px uppercase, value 18px/800.

## State lives in the URL

`?tab=`, `?filter=`, `?sel=`, `?sort=` and plain `<a>`s, never client state. Pages stay server
components, every view is linkable, and a refresh lands where you were. Client components exist
for exactly: the rail's active hub, ⌘K, the theme toggle, the toast, dialogs, the two editors,
push, and a poll while an agent run is in flight.

Writes go through server actions that end with `flash()` and a redirect or revalidation, so the
reader is told what was recorded.

## Checks before shipping a screen

- Squint: is hierarchy still readable, and is nothing jumping out harshly?
- Every interactive element has hover, focus-visible, active and disabled.
- Every data view has an empty state that says something true, not "No data".
- Verify in the browser at desktop **and** 375px, in light **and** dark.
  `document.documentElement.scrollWidth` must equal `window.innerWidth`.

---

## v3 amendments (06-Sep-2026)

Carried from v2 verbatim above. Three things changed and are recorded here rather than edited into
the text, so the original still reads as what v2 promised.

**1. The routes rule is no longer true.** "Routes are unchanged; every old URL still works" held in
v2. v3 cuts five screens and their capabilities: `/returns`, `/attribution`, `/thesis`, `/memo`,
`/pipeline`. The pipeline board is replaced by a hand-set `status` column on the companies list; the
other four are gone with the fund-accounting and IC-memo capabilities that fed them. The rail keeps
five hubs, but Companies must land somewhere other than `/pipeline` and Portfolio drops three
prefixes.

**2. Two states join `<Blank why="…" />` as system patterns.**

- **Loading** — a skeleton row matching the shape of the content it replaces. Never a spinner,
  never `Blank`. The existing rule ("Never use it for a value that is still loading") pointed at
  nothing; this is what it points at.
- **Quiet day** — a plain sentence naming what was checked and when. Never "No items". With forty
  names most days are quiet, and a desk that reads as broken on a working morning stops being
  opened. An empty list and a failed fetch must never look the same.

**3. The phone layout is a requirement, not a description.** The bottom-bar rail below phone width,
and a 44px minimum touch target — `Button` at 36px is correct on desktop and too small on a coarse
pointer, so it grows. The two shipping checks (375px and dark, `scrollWidth === innerWidth`) are
spec requirements in v3, not folklore.

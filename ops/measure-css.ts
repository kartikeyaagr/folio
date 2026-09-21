/**
 * Which CSS classes are defined, which are used, and which are neither.
 *
 * `tasks/open-items.md` ran this census once by hand and found 285 of 459 class selectors
 * referenced by no `.tsx` — 62% of the stylesheet — including whole files for capabilities the
 * specs had cut. Its prescription was explicit: *"Then re-run the census as a check, not a
 * one-off."* This is that check.
 *
 * It reports two directions, and the second one is the one that bites:
 *
 *   DEAD      — defined in CSS, referenced by no component. Costs bytes and, worse, reads to the
 *               next person as evidence that a cut capability was not cut.
 *   UNDEFINED — referenced by a component, defined in no stylesheet. Lesson L12: a class with no
 *               rule is not a warning, it is a span that inherits. `.cell-sub` was missing on five
 *               screens and read as slightly odd typography rather than as a defect, which is why
 *               nobody found it by looking.
 *
 *   pnpm exec tsx ops/measure-css.ts
 *
 * Classes are also built at runtime — `chip chip-${tone}`, `btn btn-${tone}`. A template literal
 * with an interpolation is recorded as a *prefix*, and any class starting with it counts as used.
 * That is deliberately generous: this census must never report a live class as dead, because
 * somebody would then delete it. It will under-report instead, and that is the safe direction.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CSS_DIRS = ['app', 'styles'];
const TSX_DIRS = ['app', 'components'];

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    // `styles/unbuilt/` is imported by nothing on purpose. Counting it would mean this census can
    // never come down, and a number that cannot improve stops being read.
    if (dir === 'styles' && entry === 'unbuilt') continue;
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, ext, out);
    else if (entry.endsWith(ext)) out.push(rel);
  }
  return out;
}

/** Selectors only: everything before a `{`, with at-rules and declaration bodies removed. */
function definedClasses(css: string): Set<string> {
  const found = new Set<string>();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{/g)) {
    const selector = match[1] ?? '';
    if (selector.trimStart().startsWith('@')) continue;
    for (const cls of selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) found.add(cls[1]!);
  }
  return found;
}

/**
 * Literal classes, plus the prefixes of any class built by interpolation.
 *
 * Only `className` values are read, never every string in the file. Scanning all string literals
 * looks equivalent and is not: an apostrophe inside a prose comment — and the comments here are
 * prose — opens a "string" that runs to the next apostrophe, swallowing the real classNames in
 * between and emitting the surrounding English as class names. The first run of this census
 * reported 1,277 undefined classes, among them `AND`, `AS` and `Acknowledge`.
 *
 * Within a className the two things that are not classes are comparison operands and interpolation
 * expressions. `` `chip-link${category === null ? ' is-on' : ''}` `` contains one prefix
 * (`chip-link`), one class (`is-on`) and one red herring (`null`).
 */
function harvest(source: string, literal: Set<string>, prefixes: string[]): void {
  // `x === 'fixed'`, `x === null`, `x !== props.kind` — the operand is a value, never a class.
  const cleaned = source
    .replace(/[!=]==?\s*(['"`])(?:\\.|(?!\1)[^\\])*\1/g, ' ')
    .replace(/[!=]==?\s*[A-Za-z_$][\w$.]*/g, ' ');

  for (const quoted of cleaned.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const body = quoted[2] ?? '';

    // `chip-${tone}` contributes the prefix `chip-`, so every `.chip-*` rule counts as reachable.
    for (const open of body.matchAll(/([\w-]+)\$\{/g)) prefixes.push(open[1]!);

    // Static text between interpolations is class names; the interpolations are code. The
    // interpolation collapses to a sentinel rather than a space, so that the stem of `chip-${tone}`
    // is left as `chip-\0` and rejected here — it is already recorded above as a prefix, and
    // recording it as a class too reported `chip-` as a class no stylesheet defines.
    for (const piece of body.replace(/\$\{[^}]*\}/g, '\0').split(/\s+/)) {
      if (piece.includes('\0')) continue;
      if (/^-?[A-Za-z_][\w-]*$/.test(piece)) literal.add(piece);
    }

    // …but code can hold classes of its own: `${active ? 'is-on' : ''}`.
    for (const inner of body.matchAll(/\$\{([^}]*)\}/g)) harvest(inner[1] ?? '', literal, prefixes);
  }
}

function usedClasses(tsx: string): { literal: Set<string>; prefixes: string[] } {
  const literal = new Set<string>();
  const prefixes: string[] = [];

  for (const attr of tsx.matchAll(/\bclassName\s*=\s*(?:"([^"]*)"|'([^']*)'|\{((?:[^{}]|\{[^{}]*\})*)\})/g)) {
    const direct = attr[1] ?? attr[2];
    if (direct !== undefined) {
      for (const piece of direct.split(/\s+/)) {
        if (/^-?[A-Za-z_][\w-]*$/.test(piece)) literal.add(piece);
      }
    }
    if (attr[3] !== undefined) harvest(attr[3], literal, prefixes);
  }

  // `btnClass(tone, small, 'extra')` composes `btn` and `btn-*` outside any className attribute.
  for (const call of tsx.matchAll(/\bbtnClass\s*\(([^)]*)\)/g)) {
    harvest(call[1] ?? '', literal, prefixes);
    literal.add('btn');
    prefixes.push('btn-');
  }
  return { literal, prefixes };
}

const cssFiles = CSS_DIRS.flatMap((d) => walk(d, '.css'));
const tsxFiles = TSX_DIRS.flatMap((d) => walk(d, '.tsx'));

const definedIn = new Map<string, string>();
for (const file of cssFiles) {
  for (const cls of definedClasses(readFileSync(join(ROOT, file), 'utf8'))) {
    if (!definedIn.has(cls)) definedIn.set(cls, file);
  }
}

const used = new Set<string>();
const prefixes = new Set<string>();
const usedIn = new Map<string, string>();
for (const file of tsxFiles) {
  const { literal, prefixes: p } = usedClasses(readFileSync(join(ROOT, file), 'utf8'));
  for (const cls of literal) {
    used.add(cls);
    if (!usedIn.has(cls)) usedIn.set(cls, file);
  }
  for (const prefix of p) prefixes.add(prefix);
}

const coveredByPrefix = (cls: string) => [...prefixes].some((p) => p.length > 0 && cls.startsWith(p));

const dead = [...definedIn.keys()].filter((c) => !used.has(c) && !coveredByPrefix(c)).sort();
const undefinedClasses = [...used].filter((c) => !definedIn.has(c)).sort();

const byFile = new Map<string, string[]>();
for (const cls of dead) {
  const file = definedIn.get(cls)!;
  byFile.set(file, [...(byFile.get(file) ?? []), cls]);
}

console.log(`${cssFiles.length} stylesheets · ${definedIn.size} class selectors · ${tsxFiles.length} components\n`);
console.log(`DEAD — defined, referenced by nothing: ${dead.length} of ${definedIn.size} (${Math.round((dead.length / definedIn.size) * 100)}%)`);
for (const [file, classes] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
  const total = [...definedIn].filter(([, f]) => f === file).length;
  console.log(`  ${relative('.', file).padEnd(24)} ${String(classes.length).padStart(3)}/${String(total).padEnd(3)} ${classes.slice(0, 6).join(' ')}${classes.length > 6 ? ' …' : ''}`);
}

console.log(`\nUNDEFINED — referenced, defined in no stylesheet: ${undefinedClasses.length}`);
for (const cls of undefinedClasses) console.log(`  ${cls.padEnd(28)} ${usedIn.get(cls)}`);

/*
 * The same census for custom properties, added 21-Sep-2026 because the class version would never
 * have caught what happened to `--serif`.
 *
 * It was referenced by four rules — `--font-document` in `tailwind.css`, the sheet's face
 * dropdown, `.cf-face-serif` — and declared nowhere. An undefined custom property does not fall
 * back; it makes the whole declaration invalid, so `font-family: var(--serif)` was dropped and
 * the text kept what it inherited. Choosing Serif in a spreadsheet did nothing, silently, and
 * neither the type checker nor the class census had anything to say about it. L12's argument
 * exactly, one level down.
 *
 * `--font-sans` and `--font-mono` are injected at runtime by `next/font` in `layout.tsx` and are
 * declared in no stylesheet by design, so they are the allowed exceptions rather than a reason to
 * weaken the check.
 */
const INJECTED = new Set(['--font-sans', '--font-mono']);

const tokenDefinedIn = new Map<string, string>();
const tokenUsedIn = new Map<string, string>();
for (const file of cssFiles) {
  const css = readFileSync(join(ROOT, file), 'utf8');
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/gi)) {
    if (!tokenDefinedIn.has(m[1]!)) tokenDefinedIn.set(m[1]!, file);
  }
  for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
    if (!tokenUsedIn.has(m[1]!)) tokenUsedIn.set(m[1]!, file);
  }
}
for (const file of tsxFiles) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
    if (!tokenUsedIn.has(m[1]!)) tokenUsedIn.set(m[1]!, file);
  }
  // A component may declare one too, per element and at runtime: the sheet writes its dragged
  // column width as `setProperty('--w', …)` and its row height the same way, which is the whole
  // reason those are custom properties rather than a `style={{width}}` that could not carry a
  // hover. Both forms count as a declaration or this census reports its own design as a defect —
  // and a check with false positives is one somebody switches off.
  for (const m of src.matchAll(/setProperty\(\s*[^,]*?'(--[a-z0-9-]+)'/gi)) {
    if (!tokenDefinedIn.has(m[1]!)) tokenDefinedIn.set(m[1]!, file);
  }
  for (const m of src.matchAll(/['"](--[a-z0-9-]+)['"]\s*:/gi)) {
    if (!tokenDefinedIn.has(m[1]!)) tokenDefinedIn.set(m[1]!, file);
  }
}
const undefinedTokens = [...tokenUsedIn.keys()]
  .filter((v) => !tokenDefinedIn.has(v) && !INJECTED.has(v))
  .sort();

console.log(`\nUNDEFINED TOKENS — var() with no declaration: ${undefinedTokens.length}`);
for (const v of undefinedTokens) console.log(`  ${v.padEnd(28)} ${tokenUsedIn.get(v)}`);

// An undefined class is a real defect (L12); a dead one is only debt. Only the first fails.
// An undefined token is the same defect and fails for the same reason.
if (undefinedClasses.length > 0 || undefinedTokens.length > 0) process.exitCode = 1;

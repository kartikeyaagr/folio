/**
 * Where a value sits inside a draft, as a string a form field can carry.
 *
 * `/review` could correct only top-level string fields, which meant two agents could not be
 * corrected at all — a brief's judgement lives at `by_company[0].why_it_matters` and a forensic
 * verdict at `answers[3].verdict`. `v4.md §7` stakes the learning loop on the distance between what
 * the model said and what was signed off, so a field nobody can correct scores 0 however wrong it
 * is, and a 0 that means *uncorrectable* is read as a 0 that means *right*.
 *
 * **Array steps are bracketed, object steps are dotted.** `by_company[0].what_happened[1]`, never
 * `by_company.0.what_happened.1`. `distil.ts` already went out of its way over exactly this hazard
 * — *"a separator a key can contain is a separator that can collide two different fields into one
 * candidate"* — and dotted indices reintroduce it one level down: nothing would separate an object
 * key that happens to be a year from an array index. Bracketing also lets `shape()` collapse
 * positions without ever touching an object key.
 *
 * **This is the grammar, and it is the only one.** The form field name, the harvest in
 * `app/_lib/actions/review.ts`, the merge in `acceptDraft`, the keys of `ai_drafts.edits`, and
 * `rule_observations.field` are all this string. Two spellings of one path would be a bug with no
 * symptom, which is the failure class this file exists inside.
 */

/** A step: an object key, or an array index. */
export type Segment = string | number;

export class UnwritablePath extends Error {}

/**
 * Keys a path may never step through.
 *
 * `'constructor' in {}` is true and so is `'prototype' in (() => {})`, so a membership test is not
 * a safe predicate on its own — `Object.hasOwn` handles most of it and this handles the rest. A
 * form field named `f.constructor.prototype.toString` must not reach an object, and `__proto__`
 * must not reach one even though `Object.hasOwn` already refuses it, because the assignment is the
 * dangerous half and defence here is cheaper than defence at the write.
 */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse a path, or null if it is not one.
 *
 * Sticky and exhaustive: the regex has to consume the whole string, so `a..b`, `a.`, `a[0]b`,
 * `a[]` and `a[01]` are all refused rather than silently reinterpreted.
 */
export function segments(path: string): Segment[] | null {
  // The first step is a bare key and every later one carries its own punctuation, so `.a` is not a
  // path — a leading dot would otherwise parse as the same thing `a` does, which is two spellings
  // of one path arriving at a table keyed on the string.
  const first = /^([^.[\]]+)/y;
  const rest = /\[(0|[1-9]\d*)\]|\.([^.[\]]+)/y;

  const head = first.exec(path);
  if (!head) return null;

  const out: Segment[] = [head[1]!];
  let i = first.lastIndex;
  while (i < path.length) {
    rest.lastIndex = i;
    const m = rest.exec(path);
    if (!m) return null;
    out.push(m[1] !== undefined ? Number(m[1]) : m[2]!);
    i = rest.lastIndex;
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Where a step may go. An array takes a real index and never `length`; an object takes an own key. */
function step(node: unknown, seg: Segment): unknown | undefined {
  if (Array.isArray(node)) {
    // `Object.hasOwn([1,2,3], 'length')` is true, which is why the test is the index and not the
    // property. A form field ending `…what_happened[3]` on a three-element array is refused here
    // rather than growing the array by assignment.
    return typeof seg === 'number' && seg < node.length ? node[seg] : undefined;
  }
  if (isObject(node)) {
    if (typeof seg !== 'string' || FORBIDDEN.has(seg) || !Object.hasOwn(node, seg)) return undefined;
    return node[seg];
  }
  return undefined;
}

/** The value at a path, or undefined if nothing is there. */
export function getPath(root: unknown, path: string): unknown {
  const segs = segments(path);
  if (!segs) return undefined;
  let node: unknown = root;
  for (const s of segs) {
    node = step(node, s);
    if (node === undefined) return undefined;
  }
  return node;
}

export interface Leaf {
  path: string;
  value: unknown;
}

/**
 * Every scalar position in a value, as `{path, value}`.
 *
 * Scalars only — an empty array or object contributes no leaf, which is why `draftDistance` needs a
 * fallback for a key that has none. A key whose name contains `.`, `[` or `]` still gets a leaf so
 * that a change to it is *diffed*; `segments()` will refuse that path, so it simply cannot be
 * edited. Diffing reads the collected value, editing re-parses the string — only the second needs
 * the path to be unambiguous.
 */
export function leaves(value: unknown, prefix = ''): Leaf[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => leaves(v, `${prefix}[${i}]`));
  }
  if (isObject(value)) {
    return Object.keys(value).flatMap((k) =>
      leaves(value[k], prefix === '' ? k : `${prefix}.${k}`),
    );
  }
  // A scalar at the root is not a position in a draft; content is always an object.
  return prefix === '' ? [] : [{ path: prefix, value }];
}

/**
 * The same path with its positions removed: `by_company[0].why_it_matters` becomes
 * `by_company[].why_it_matters`.
 *
 * This is what a rule is written about. Three corrections to the third company in three different
 * briefs are three corrections to the same *thing*; three corrections at `[0]`, `[1]` and `[2]`
 * that never group are three patterns of one, and nothing is ever learned. `edit_field()` in
 * migration 0051 is the same function in SQL, and `distil` reads the SQL one so there is one
 * definition rather than two that agree today.
 */
export const shape = (path: string): string => path.replace(/\[\d+\]/g, '[]');

/**
 * Write a string into an existing position, and return a new root.
 *
 * **Position-preserving and type-preserving.** FormData values are always strings, so without the
 * second half a POST of `f.figures.revenue_cr=693.4` would turn a number into `"693.4"` in
 * `ai_drafts.content`, in `document_versions.body` and in `exemplars.output` — and would silently
 * falsify `/review`'s own promise that the model does not get to overwrite a filed figure.
 *
 * **It refuses loudly.** A correction that silently does not happen is the worst outcome available
 * on the one screen whose entire purpose is that corrections happen.
 */
export function setPath(root: Record<string, unknown>, path: string, value: string): Record<string, unknown> {
  const segs = segments(path);
  if (!segs) throw new UnwritablePath(`"${path}" is not a field of this draft`);

  const write = (node: unknown, i: number): unknown => {
    const seg = segs[i]!;
    const current = step(node, seg);
    if (current === undefined) {
      throw new UnwritablePath(`"${path}" is not a field of this draft`);
    }
    if (i === segs.length - 1) {
      if (typeof current !== 'string') {
        throw new UnwritablePath(`"${path}" is not text, and only text can be corrected here`);
      }
      // The container with the leaf replaced, never the leaf itself: every frame returns the node
      // it was handed, rebuilt, so the root comes back a root.
      return replace(node, seg, value);
    }
    return replace(node, seg, write(current, i + 1));
  };

  const out = write(root, 0);
  return out as Record<string, unknown>;
}

/** A shallow copy of `node` with one position replaced. Structural sharing everywhere else. */
function replace(node: unknown, seg: Segment, value: unknown): unknown {
  if (Array.isArray(node)) {
    const copy = [...node];
    copy[seg as number] = value;
    return copy;
  }
  const copy = { ...(node as Record<string, unknown>) };
  copy[seg as string] = value;
  return copy;
}

/**
 * Drop positions from an array, and return a new root.
 *
 * Deleting is a separate gesture from correcting because blanking a textarea is not deleting:
 * `Brief` renders every element of `what_happened` unconditionally, so a blanked bullet becomes an
 * empty `<li>` in the permanent document — *"an empty cell reads as broken"*. And
 * `fieldDistance(s, '')` is 1.0, so three blankings would clear `MIN_DISTANCE` and raise a rule
 * about prose nobody was making a point about.
 */
export function removeAt(
  root: Record<string, unknown>,
  arrayPath: string,
  indices: readonly number[],
): Record<string, unknown> {
  const drop = new Set(indices);
  const held = getPath(root, arrayPath);
  if (!Array.isArray(held)) throw new UnwritablePath(`"${arrayPath}" is not a list`);

  const kept = held.filter((_, i) => !drop.has(i));
  const segs = segments(arrayPath)!;

  const write = (node: unknown, i: number): unknown => {
    const seg = segs[i]!;
    if (i === segs.length - 1) return replace(node, seg, kept);
    return replace(node, seg, write(step(node, seg), i + 1));
  };
  return write(root, 0) as Record<string, unknown>;
}

/** `by_company[0].what_happened[2]` → `{ array: 'by_company[0].what_happened', index: 2 }`. */
export function positionOf(path: string): { array: string; index: number } | null {
  const m = /^(.*)\[(\d+)\]$/.exec(path);
  return m ? { array: m[1]!, index: Number(m[2]) } : null;
}

/**
 * A path as a person reads it, resolved against the draft it came from.
 *
 * `by_company[0].why_it_matters` is precise and unreadable; against the content it becomes
 * "AERON · why it matters", which is what somebody scanning a list of corrections needs. An array
 * step resolves to whatever the element calls itself — a `symbol`, or an `item` number — and falls
 * back to its position, one-based, because a reader counts from one.
 *
 * A shape keeps its `[]`. That is the one visible difference between "this happened here" and
 * "this keeps happening", and `/agents` shows the second while `/rules` shows the first.
 */
export function label(path: string, content?: unknown): string {
  // A shape has no positions to resolve, so it is just its keys — with the brackets kept, because
  // they are what says this is a field rather than one place it went wrong.
  if (path.includes('[]')) return path.split('.').map((k) => k.replace(/_/g, ' ')).join(' · ');

  const segs = segments(path);
  if (!segs) return path;

  const out: string[] = [];
  let node: unknown = content;
  for (const seg of segs) {
    if (typeof seg === 'number') {
      const at = Array.isArray(node) ? node[seg] : undefined;
      const name = named(at);
      // Replace the key just pushed — "by company · AERON" says the same thing twice.
      out[out.length - 1] = name ?? `${out.at(-1)} ${seg + 1}`;
      node = at;
    } else {
      out.push(seg.replace(/\[\]$/, '[]').replace(/_/g, ' '));
      node = isRecord(node) ? node[seg] : undefined;
    }
  }
  return out.join(' · ');
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** What an element of a list calls itself, if it calls itself anything. */
function named(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value['symbol'] === 'string') return value['symbol'];
  if (typeof value['item'] === 'number') return `item ${value['item']}`;
  return null;
}

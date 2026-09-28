/**
 * What each agent's draft content actually looks like, and therefore what a reviewer may do to it.
 *
 * `/review` needs to know, for every position in a draft, whether it is prose to correct, a choice
 * to pick from, or a figure nobody may retype. The runtime type is not enough: `answers[].verdict`
 * and `answers[].note` are both strings, but `verdict` is constrained by
 * `forensics_answers_verdict_check` and a free-text "Concern" aborts the acceptance transaction —
 * on the one screen where losing a page of corrections is least acceptable.
 *
 * **This is not the model's output schema, and it must not import one.** Two reasons, both real.
 * The stored content differs: `forensics.ts` writes `{version, answers}` and the model never emits
 * `version`. And every handler module calls `registerHandler` at import and reaches
 * `prompt.ts` → `exemplars.ts` → the 130MB ONNX embedder, so importing one from a page would drag
 * the embedder into the web build — the shape of `v4.md §15` finding 15, which cost a `next build`.
 *
 * `shapes.test.ts` asserts this file against each agent's real schema, so the declaration is
 * checked rather than trusted.
 */

import { segments } from './paths.ts';

export type Field =
  /** Prose. A textarea, and the only thing a correction may overwrite. */
  | { kind: 'text' }
  /**
   * A constrained string. A select, because nothing revalidates a typo before Postgres does.
   *
   * `enforced` says whether a value outside the list is refused at acceptance. It is true wherever
   * the database is the next thing to see the value — `forensics_answers_verdict_check` raises
   * 23514 *inside* the acceptance transaction — and false where the code downstream already copes
   * and says so.
   *
   * **Nothing declares a loose choice today.** The only one was agent 8's `kind`, cut on
   * 19-Sep-2026 with the agent; the flag and `review.ts`'s check on it are kept because the next
   * agent whose downstream copes should say so here rather than rediscover the argument.
   */
  | { kind: 'choice'; options: readonly string[]; enforced: boolean }
  /** A figure, a flag, or an identity. Shown, never edited. */
  | { kind: 'fixed' }
  | { kind: 'list'; of: Field; removable: boolean }
  | { kind: 'group'; fields: readonly (readonly [string, Field])[] };

const text: Field = { kind: 'text' };
const fixed: Field = { kind: 'fixed' };
const choice = (...options: string[]): Field => ({ kind: 'choice', options, enforced: true });
const list = (of: Field, removable = true): Field => ({ kind: 'list', of, removable });
const group = (...fields: (readonly [string, Field])[]): Field => ({ kind: 'group', fields });

/**
 * The four, in the order each agent declares its fields.
 *
 * Nested order has to come from here: `ai_drafts.field_order` is written as
 * `Object.keys(d.content)` and is top-level only, so without this a forensic answer renders
 * `item, note, verdict` — jsonb's length-then-alphabetical order, which puts the note above the
 * verdict it justifies.
 */
export const CONTENT: Record<string, Field> = {
  'results-figures': group(
    ['headline', text],
    // Not editable, and this is the screen's own principle rather than a limitation: "the model
    // does not get to overwrite a filed figure, and the filed figure does not get to hide that the
    // model read something else." A reviewer retyping one would falsify the verification beside it.
    ['figures', group(['revenue_cr', fixed], ['profit_after_tax_cr', fixed])],
    ['moved', list(text)],
    ['one_offs', list(text)],
    ['watch_items', list(text)],
  ),

  'concall-insights': group(
    ['summary', text],
    ['comparison_available', fixed],
    ['guidance_changes', list(group(
      ['topic', text],
      ['previously', text],
      ['now', text],
      ['direction', choice('raised', 'lowered', 'reaffirmed', 'withdrawn', 'new')],
    ))],
    ['commitments', list(group(['commitment', text], ['quote', text]))],
    ['unanswered', list(text)],
  ),

  'news-brief': group(
    ['period', text],
    ['headline', text],
    ['by_company', list(group(
      // The symbol is a join key, not prose: `Brief` links `/company/{symbol}` from it. Correcting
      // one would mean the agent covered the wrong company, which is a rejection.
      ['symbol', fixed],
      ['what_happened', list(text)],
      ['why_it_matters', text],
    ))],
    // Symbols again. Removable, because "this name was not actually quiet" is a real correction;
    // not editable, because retyping one is not.
    ['nothing_to_report', list(fixed)],
    ['major_updates', list(group(
      ['what_happened', text],
      ['why_it_matters', text],
      // Names checked against the stream the brief read (`checkOutlets`). Removable, because "this
      // outlet did not run it" is a correction; not editable, because a retyped name is one
      // nothing checked.
      ['outlets', list(fixed)],
    ))],
    ['coming_up', list(text)],
  ),

  'forensics-review': group(
    ['version', fixed],
    // Not removable: `verifyStructure` reads a missing item as the agent having skipped it, and a
    // reviewer deleting one would make those two indistinguishable.
    ['answers', list(
      group(
        ['item', fixed],
        // The highest-value correction on the whole screen, and the one that must not be free
        // text: `forensics_answers_verdict_check` (migration 0011) raises 23514 on anything else,
        // inside the acceptance transaction, and the app has no error boundary to catch it.
        ['verdict', choice('clear', 'concern', 'red_flag', 'unanswerable')],
        ['note', text],
      ),
      false,
    )],
  ),
};

/**
 * What to do about an agent this file has never heard of.
 *
 * The same default `DOCUMENT_KIND` takes — *"anything not named here is a note, which is the right
 * default for an agent added later"*. Strings are correctable, everything else is shown, and
 * whoever adds the agent can come here when a select would be better.
 */
export function infer(value: unknown): Field {
  if (typeof value === 'string') return text;
  if (Array.isArray(value)) return list(infer(value[0]));
  if (typeof value === 'object' && value !== null) {
    return group(...Object.keys(value).map((k) => [k, infer((value as Record<string, unknown>)[k])] as const));
  }
  return fixed;
}

/** The declared shape for this agent, or one read off the draft itself. */
export function shapeFor(agentKey: string, content: Record<string, unknown>): Field {
  return CONTENT[agentKey] ?? infer(content);
}

/**
 * The declared field at a path, or null where the declaration and the draft disagree.
 *
 * Null is the honest answer rather than a guess: a path the declaration does not describe is a
 * draft whose agent changed shape without `shapes.ts` following, and `shapes.test.ts` is what
 * catches that. Callers treat null as "not correctable", which fails closed.
 */
export function fieldAt(root: Field, path: string): Field | null {
  const segs = segments(path);
  if (!segs) return null;
  let field: Field | null = root;
  for (const s of segs) {
    if (field === null) return null;
    field = within(field, s);
  }
  return field;
}

/** The field at one step inside another, or null where the declaration and the draft disagree. */
export function within(field: Field, key: string | number): Field | null {
  if (field.kind === 'list') return typeof key === 'number' ? field.of : null;
  if (field.kind === 'group') {
    return field.fields.find(([k]) => k === key)?.[1] ?? null;
  }
  return null;
}

/**
 * The fields of a group, in declared order, with anything the draft carries and the declaration
 * does not following after.
 *
 * A field the agent emitted and this file has not heard of is rendered rather than dropped: a
 * reviewer deciding whether to sign something off must see all of it, and a schema that changed
 * without this file changing is exactly when that matters most.
 */
export function fieldsOf(field: Field, value: Record<string, unknown>): [string, Field][] {
  if (field.kind !== 'group') return [];
  const declared = field.fields.filter(([k]) => k in value).map(([k, f]): [string, Field] => [k, f]);
  const named = new Set(declared.map(([k]) => k));
  const rest = Object.keys(value)
    .filter((k) => !named.has(k))
    .map((k): [string, Field] => [k, infer(value[k])]);
  return [...declared, ...rest];
}

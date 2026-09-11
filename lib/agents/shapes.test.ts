/**
 * `shapes.ts` against the schemas the agents actually ask the model for.
 *
 * That file cannot import these — every handler registers itself at import and reaches the ONNX
 * embedder, and `/review` imports `shapes.ts` — so the declaration is duplicated on purpose. This
 * is what stops the duplicate drifting: a field added to an agent's schema, an enum given a new
 * value, or a key renamed fails here rather than showing up on the review screen as a control that
 * cannot be corrected, months later, with no error.
 *
 * A test file has no such constraint, so it imports both sides and compares them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA as CONCALL } from './concall.ts';
import { SCHEMA as FORENSICS } from './forensics.ts';
import { SCHEMA as NEWSBRIEF } from './newsbrief.ts';
import { SCHEMA as RESULTS } from './results.ts';
import { CONTENT, fieldsOf, infer, shapeFor, within, type Field } from './shapes.ts';

interface Node {
  // Readonly throughout: every agent declares its schema `as const`, so a mutable shape here would
  // refuse the very objects this test exists to read.
  type?: string | readonly string[];
  enum?: readonly string[];
  properties?: Readonly<Record<string, Node>>;
  items?: Node;
}

const types = (n: Node): readonly string[] =>
  Array.isArray(n.type) ? n.type : n.type ? [n.type as string] : [];

/** The declared fields of a group, for the two places below that assert an order. */
const namesOf = (f: Field): string[] =>
  f.kind === 'group' ? f.fields.map(([k]) => k) : [];

/**
 * Walk a JSON Schema node beside a declared field and complain where they disagree.
 *
 * A schema string may be declared `text`, `choice` or `fixed` — `symbol` and `item` are strings a
 * reviewer must not retype, and that is a judgement this file cannot make for itself. What it can
 * check is that nothing is *missing*, that the order matches, and that an enum's values are the
 * enum's values.
 */
function agree(schema: Node, field: Field, where: string, out: string[]): void {
  const t = types(schema);

  if (schema.enum) {
    if (field.kind !== 'choice') out.push(`${where}: schema has an enum, shapes.ts has "${field.kind}"`);
    else if (JSON.stringify([...field.options].sort()) !== JSON.stringify([...schema.enum].sort())) {
      out.push(`${where}: enum is [${schema.enum}], shapes.ts offers [${field.options}]`);
    }
    return;
  }

  if (t.includes('array')) {
    if (field.kind !== 'list') out.push(`${where}: schema is an array, shapes.ts has "${field.kind}"`);
    else if (schema.items) agree(schema.items, field.of, `${where}[]`, out);
    return;
  }

  if (t.includes('object')) {
    if (field.kind !== 'group') {
      out.push(`${where}: schema is an object, shapes.ts has "${field.kind}"`);
      return;
    }
    const declared = field.fields.map(([k]) => k);
    const wanted = Object.keys(schema.properties ?? {});
    for (const k of wanted) {
      if (!declared.includes(k)) out.push(`${where}.${k}: in the schema, missing from shapes.ts`);
    }
    // Order, not just membership: nested order comes from shapes.ts because `field_order` is
    // top-level only, so a declaration in the wrong order renders a note above the verdict it
    // justifies and nothing fails.
    const shared = declared.filter((k) => wanted.includes(k));
    if (JSON.stringify(shared) !== JSON.stringify(wanted.filter((k) => declared.includes(k)))) {
      out.push(`${where}: declared order ${shared} does not match the schema's ${wanted}`);
    }
    for (const [k, f] of field.fields) {
      const child = schema.properties?.[k];
      if (child) agree(child, f, `${where}.${k}`, out);
    }
    return;
  }

  if (t.includes('string') && field.kind === 'fixed') return; // a deliberate identity leaf
  if (t.includes('string') && field.kind !== 'text') {
    out.push(`${where}: schema is a string, shapes.ts has "${field.kind}"`);
  }
  if ((t.includes('number') || t.includes('integer') || t.includes('boolean')) && field.kind !== 'fixed') {
    out.push(`${where}: schema is ${t}, shapes.ts has "${field.kind}" — only text is correctable`);
  }
}

const check = (key: string, schema: Node): void => {
  const out: string[] = [];
  agree(schema, CONTENT[key]!, key, out);
  assert.deepEqual(out, [], out.join('\n'));
};

test('every agent schema is declared, in its own order, with its own enums', () => {
  check('concall-insights', CONCALL as Node);
  check('news-brief', NEWSBRIEF as Node);
  check('results-figures', RESULTS as Node);
});

test('forensics carries a field its model never emits, and shapes.ts knows', () => {
  // `forensics.ts` writes `{ version, answers }` — `version` comes from `activeChecklist()`, not
  // from the model. Anything built off the schema alone would miss it, which is the reason this
  // registry exists as its own declaration rather than as a re-export.
  check('forensics-review', FORENSICS as Node);

  assert.deepEqual(namesOf(CONTENT['forensics-review']!), ['version', 'answers']);
  assert.equal(Object.keys((FORENSICS as Node).properties ?? {}).includes('version'), false);
});

test('agent 8 has no output schema at all, so its shape is declared here or nowhere', () => {
  // Its content is assembled in `tools/draft.ts` as `{headline, kind, body}` from a tool input
  // whose `title` is renamed and whose `symbol` is dropped.
  assert.deepEqual(namesOf(CONTENT['desk-analyst']!), ['headline', 'kind', 'body']);
});

// ---- the fallback -------------------------------------------------------------------------------

test('an agent nobody has declared still gets a usable screen', () => {
  const content = { headline: 'x', rows: [{ note: 'a', n: 1 }] };
  const f = shapeFor('an-agent-added-later', content);

  assert.equal(within(f, 'headline')?.kind, 'text');
  assert.equal(within(within(within(f, 'rows')!, 0)!, 'note')?.kind, 'text');
  assert.equal(within(within(within(f, 'rows')!, 0)!, 'n')?.kind, 'fixed', 'a figure is still not retypeable');
});

test('a field the agent emitted and this file has not heard of is rendered, not dropped', () => {
  // A reviewer deciding whether to sign something off has to see all of it, and a schema that
  // changed without shapes.ts changing is exactly when that matters most.
  const content = { headline: 'x', kind: 'memo', body: 'y', surprise: 'the agent added a field' };
  const fields = fieldsOf(CONTENT['desk-analyst']!, content);

  assert.deepEqual(fields.map(([k]) => k), ['headline', 'kind', 'body', 'surprise']);
  assert.equal(fields.at(-1)![1].kind, 'text');
});

test('a field this file declares and the draft does not carry is not rendered as empty', () => {
  assert.deepEqual(fieldsOf(CONTENT['desk-analyst']!, { body: 'only this' }).map(([k]) => k), ['body']);
});

test('an empty list infers a shape rather than throwing', () => {
  assert.deepEqual(infer([]), { kind: 'list', of: { kind: 'fixed' }, removable: true });
});

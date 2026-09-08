/**
 * The transport, not any agent's meaning: what gets sent to the API and what a call costs.
 *
 * These are pure, so unlike the rest of `lib/agents` they need no database. `liveModel` itself
 * still has no test — it needs an injected client, which it does not currently take.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealObjects, costUsd, PRICING } from './model.ts';

type Node = Record<string, unknown>;

/** Navigate a sealed schema, failing the test rather than the type checker at each step. */
function at(value: unknown, ...path: string[]): Node {
  let node = value;
  for (const key of path) {
    assert.ok(node !== null && typeof node === 'object', `not an object before .${key}`);
    node = (node as Node)[key];
  }
  assert.ok(node !== null && typeof node === 'object', `not an object at .${path.join('.')}`);
  return node as Node;
}

// Verbatim from lib/agents/results.ts:21 as it stood on 08-Sep-2026 — no additionalProperties
// anywhere. Ten of the eleven object schemas in the tree looked like this.
const RESULTS_SCHEMA = {
  type: 'object',
  required: ['headline', 'figures'],
  properties: {
    headline: { type: 'string', description: 'One sentence a reader could repeat.' },
    figures: {
      type: 'object',
      required: ['revenue_cr'],
      properties: { revenue_cr: { type: ['number', 'null'] } },
    },
    moved: { type: 'array', items: { type: 'string' } },
  },
} as const;

test('every object is sealed, at every depth', () => {
  const sealed = sealObjects(RESULTS_SCHEMA);
  // Measured 08-Sep-2026: sealing only the root fails identically to sealing nothing. The API
  // rejects the request before the model sees it, so a nested miss is not a partial success.
  assert.equal(at(sealed)['additionalProperties'], false, 'root');
  assert.equal(at(sealed, 'properties', 'figures')['additionalProperties'], false, 'nested');
});

test('an object inside array items is sealed too', () => {
  const sealed = sealObjects({
    type: 'object',
    properties: {
      answers: { type: 'array', items: { type: 'object', properties: { item: { type: 'integer' } } } },
    },
  });
  assert.equal(at(sealed, 'properties', 'answers', 'items')['additionalProperties'], false);
});

test('non-objects are left alone', () => {
  const sealed = sealObjects({
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'kept' },
      moved: { type: 'array', items: { type: 'string' } },
    },
  });
  const headline = at(sealed, 'properties', 'headline');
  assert.equal(headline['additionalProperties'], undefined);
  assert.equal(headline['description'], 'kept');
  assert.equal(at(sealed, 'properties', 'moved', 'items')['additionalProperties'], undefined);
});

test('the caller’s schema is not mutated', () => {
  // The agents hold their schemas as module-level `as const`. Sealing in place would edit a shared
  // constant, and a frozen one would throw on the first live call rather than the first test.
  const before = JSON.stringify(RESULTS_SCHEMA);
  sealObjects(RESULTS_SCHEMA);
  assert.equal(JSON.stringify(RESULTS_SCHEMA), before);
});

test('a schema that already seals itself is unchanged', () => {
  // lib/news/gate.ts was the one that had it. Sealing must be idempotent, not additive.
  const gateish = { type: 'object', properties: {}, required: [], additionalProperties: false };
  assert.deepEqual(sealObjects(gateish), gateish);
});

test('cost is null for an unknown model, never zero', () => {
  // v2's dashboard reported $0.00 because nothing seeded its price table. Zero is a claim; null
  // is an admission, and only one of them is true.
  assert.equal(costUsd('some-model-nobody-priced', 1000, 1000), null);
});

test('cost is a real number for the models actually in use', () => {
  for (const model of ['claude-opus-5', 'claude-sonnet-5']) {
    assert.ok(model in PRICING, `${model} is used by an agent but is not priced`);
    const cost = costUsd(model, 1_000_000, 1_000_000);
    assert.equal(typeof cost, 'number');
    assert.ok((cost ?? 0) > 0);
  }
});

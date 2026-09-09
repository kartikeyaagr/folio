/**
 * The transport, not any agent's meaning: what gets sent to the API, what comes back, and what a
 * call costs. No database — a scripted client stands in for the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askModel, sealObjects, costUsd, PRICING, type MessagesClient } from './model.ts';

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

// ---- the call itself, against a scripted client -------------------------------------------------

type Reply = { stop?: string; text?: string; input?: number; output?: number; category?: string };

/** Answers from a script and records the max_tokens of every call it received. */
function scripted(replies: Reply[]): MessagesClient & { rooms: number[] } {
  const rooms: number[] = [];
  let i = 0;
  return {
    rooms,
    messages: {
      create: async (params) => {
        rooms.push(params.max_tokens);
        const r = replies[Math.min(i++, replies.length - 1)]!;
        return {
          id: 'msg_1',
          model: 'claude-opus-5',
          role: 'assistant',
          type: 'message',
          content: r.text === undefined ? [] : [{ type: 'text', text: r.text, citations: null }],
          stop_reason: r.stop ?? 'end_turn',
          stop_sequence: null,
          stop_details: r.category ? { category: r.category } : undefined,
          usage: { input_tokens: r.input ?? 0, output_tokens: r.output ?? 0 },
        } as never;
      },
    },
  };
}

const ASK = {
  model: 'claude-opus-5',
  system: 's',
  task: 't',
  schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
  maxTokens: 1000,
};

test('a plain answer comes back parsed, with its own tokens and cost', async () => {
  const c = scripted([{ text: '{"a":"x"}', input: 1_000_000, output: 1_000_000 }]);
  const r = await askModel(c, ASK);
  assert.ok(r.ok);
  assert.deepEqual(r.content, { a: 'x' });
  assert.equal(r.costUsd, 30, '1M in at $5 plus 1M out at $25');
});

test('a refusal on the FIRST attempt is a refusal', async () => {
  const r = await askModel(scripted([{ stop: 'refusal', category: 'harmful' }]), ASK);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.kind, 'refusal');
});

test('a refusal on the RETRY is a refusal too, not malformed JSON', async () => {
  // The bug. The stop-reason checks sat outside the retry, so only the first response met them: a
  // retry that came back refused fell through to JSON.parse('') and was filed as `unparseable`,
  // which defeats the terminal shortcut in lib/news/gate.ts.
  const c = scripted([{ stop: 'max_tokens' }, { stop: 'refusal', category: 'harmful' }]);
  const r = await askModel(c, ASK);
  assert.equal(!r.ok && r.kind, 'refusal');
  assert.equal(c.rooms.length, 2, 'it did retry');
});

test('tokens are added across attempts, not read off the last one', async () => {
  // A retried run used to report only the retry's usage and so under-report its own cost by a
  // whole attempt — the first call is charged for whether or not its answer was usable.
  const c = scripted([
    { stop: 'max_tokens', input: 500_000, output: 100_000 },
    { text: '{"a":"x"}', input: 500_000, output: 100_000 },
  ]);
  const r = await askModel(c, ASK);
  assert.ok(r.ok);
  assert.equal(r.inputTokens, 1_000_000, 'both attempts');
  assert.equal(r.outputTokens, 200_000);
  assert.equal(r.costUsd, 10, 'and the cost is of both, not of the second');
});

test('running out of room twice is truncated, and it is asked twice at most', async () => {
  const c = scripted([{ stop: 'max_tokens' }, { stop: 'max_tokens' }, { text: '{"a":"x"}' }]);
  const r = await askModel(c, ASK);
  assert.equal(!r.ok && r.kind, 'truncated');
  assert.deepEqual(c.rooms, [1000, 4000], 'the caller’s budget, then room, then it stops');
});

test('a prompt that did not fit says so, and is not retried', async () => {
  // `model_context_window_exceeded` is a real StopReason and was unhandled, so it reached
  // JSON.parse('') and was recorded as `unparseable`. Its remedy is the opposite of a retry's.
  const c = scripted([{ stop: 'model_context_window_exceeded' }]);
  const r = await askModel(c, ASK);
  assert.equal(!r.ok && r.kind, 'too_large');
  assert.equal(c.rooms.length, 1, 'allowing more OUTPUT would only make it worse');
});

test('an answer that is not JSON, and one that is the wrong shape, are told apart', async () => {
  assert.equal(!(await askModel(scripted([{ text: 'sorry' }]), ASK)).ok && 'unparseable', 'unparseable');
  const wrong = await askModel(scripted([{ text: '{"b":1}' }]), ASK);
  assert.equal(!wrong.ok && wrong.kind, 'schema_mismatch');
  assert.match((!wrong.ok && wrong.detail) || '', /missing required: a/);
});

test('a transport error is an error, not a refusal', async () => {
  const c: MessagesClient = { messages: { create: async () => { throw new Error('ECONNRESET'); } } };
  const r = await askModel(c, ASK);
  assert.equal(!r.ok && r.kind, 'error');
  assert.match((!r.ok && r.detail) || '', /ECONNRESET/);
});

test('the schema reaching the API is the sealed one', async () => {
  const c = scripted([{ text: '{"a":"x"}' }]);
  let sent: unknown;
  const spy: MessagesClient = {
    messages: {
      create: async (p) => {
        sent = (p as { output_config?: { format?: { schema?: unknown } } }).output_config?.format?.schema;
        return c.messages.create(p);
      },
    },
  };
  await askModel(spy, ASK);
  assert.equal((sent as Record<string, unknown>)['additionalProperties'], false);
});

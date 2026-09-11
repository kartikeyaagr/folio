/**
 * The tool loop's transport: what it sums, what it names, and how a capped turn still ends in an
 * answer. No database and no network — a scripted runner stands in for both.
 *
 * The cases here are the ones `model.ts` paid for once already in the single-shot path: a refusal
 * arriving as malformed JSON, and usage read off the last response rather than summed. A loop
 * makes both worse, because the turns it would discard are most of the spend.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';

import { askWithTools, MAX_ITERATIONS, type ToolLoopClient } from './loop.ts';

const SCHEMA = {
  type: 'object',
  required: ['answer'],
  properties: { answer: { type: 'string' } },
} as const;

interface Turn {
  text?: string;
  stop?: string;
  input?: number;
  output?: number;
  /** Ids of `tool_use` blocks this turn asks for. */
  calls?: string[];
  category?: string;
  model?: string;
}

function message(t: Turn): Anthropic.Beta.BetaMessage {
  const content: unknown[] = [];
  if (t.text !== undefined) content.push({ type: 'text', text: t.text, citations: null });
  for (const id of t.calls ?? []) {
    content.push({ type: 'tool_use', id, name: 'search_corpus', input: { query: 'x' } });
  }
  return {
    id: 'msg_1',
    model: t.model ?? 'claude-opus-5',
    role: 'assistant',
    type: 'message',
    content,
    stop_reason: t.stop ?? 'end_turn',
    stop_sequence: null,
    stop_details: t.category ? { category: t.category } : undefined,
    usage: { input_tokens: t.input ?? 0, output_tokens: t.output ?? 0 },
  } as never;
}

/** A runner that yields the turns it was given, and records any closing call made after it. */
function scripted(turns: Turn[], closing?: Turn) {
  const creates: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  let yielded = 0;
  const client: ToolLoopClient = {
    beta: {
      messages: {
        toolRunner: (body) =>
          ({
            params: body,
            async *[Symbol.asyncIterator]() {
              for (const t of turns) {
                yielded++;
                yield message(t);
              }
            },
          }) as never,
        create: async (params) => {
          creates.push(params);
          return message(closing ?? { text: '{"answer":"closed"}' });
        },
      },
    },
  };
  return { client, creates, yielded: () => yielded };
}

const ask = (client: ToolLoopClient, over: Record<string, unknown> = {}) =>
  askWithTools(client, {
    model: 'claude-opus-5', system: 'be exact', task: 'what happened',
    schema: SCHEMA as unknown as Record<string, unknown>, tools: [], ...over,
  });

test('usage is summed across every turn, not read off the last', async () => {
  // The turns that called tools are most of the spend. Reading usage off the final message would
  // report a loop that made four calls as if it had made one — the same bug model.ts records
  // having fixed once for the single-call retry, where it cost one call instead of three.
  const { client } = scripted([
    { calls: ['t1'], stop: 'tool_use', input: 1000, output: 100 },
    { calls: ['t2'], stop: 'tool_use', input: 2000, output: 200 },
    { text: '{"answer":"done"}', input: 3000, output: 300 },
  ]);
  const a = await ask(client);
  assert.equal(a.ok, true);
  assert.ok(a.ok);
  assert.equal(a.inputTokens, 6000);
  assert.equal(a.outputTokens, 600);
  // 6000 * $5/MTok + 600 * $25/MTok
  assert.equal(a.costUsd, (6000 * 5 + 600 * 25) / 1_000_000);
});

test('a refusal part-way through is named, not filed as malformed JSON', async () => {
  const { client } = scripted([
    { calls: ['t1'], stop: 'tool_use', input: 10, output: 1 },
    { stop: 'refusal', category: 'cyber' },
  ]);
  const a = await ask(client);
  assert.equal(a.ok, false);
  assert.ok(!a.ok);
  assert.equal(a.kind, 'refusal');
  assert.match(a.detail, /cyber/);
});

test('running out of output room is terminal, because a loop cannot retry for free', async () => {
  // askModel retries once with a raised ceiling. Here that would re-run every tool call in the
  // conversation and pay for all of them again, so the answer is to say so instead.
  const { client, creates } = scripted([{ stop: 'max_tokens', text: '{"answ' }]);
  const a = await ask(client);
  assert.ok(!a.ok);
  assert.equal(a.kind, 'truncated');
  assert.equal(creates.length, 0, 'no second attempt was made');
});

test('a turn that hits the cap still ends in an answer', async () => {
  // v4.md §6.2: "then the model answers with what it has or says it could not find out."
  const { client, creates } = scripted(
    [{ calls: ['t9'], stop: 'tool_use', input: 50, output: 5 }],
    { text: '{"answer":"what I could find"}', input: 60, output: 6 },
  );
  const a = await ask(client);
  assert.ok(a.ok);
  assert.deepEqual(a.content, { answer: 'what I could find' });
  assert.equal(creates.length, 1, 'exactly one closing call');
  assert.equal(a.inputTokens, 110, "the closing call's usage counts too");
});

test('the closing call refuses the outstanding calls rather than running them', async () => {
  // An assistant tool_use block with no tool_result after it is rejected by the API, so the turn
  // has to be closed somehow. Closing it by *running* the tools would make the cap a suggestion.
  const { client, creates } = scripted(
    [{ calls: ['t9', 't10'], stop: 'tool_use' }],
    { text: '{"answer":"ok"}' },
  );
  await ask(client);
  const sent = creates[0]!;
  const lastMessage = sent.messages[sent.messages.length - 1]!;
  assert.equal(lastMessage.role, 'user');
  const results = lastMessage.content as { type: string; tool_use_id: string; is_error: boolean }[];
  assert.deepEqual(results.map((r) => r.tool_use_id), ['t9', 't10'], 'every one is answered');
  assert.ok(results.every((r) => r.type === 'tool_result' && r.is_error));
  assert.deepEqual(sent.tool_choice, { type: 'none' }, 'and it cannot ask for more');
});

test('a final message that is not JSON is unparseable, and keeps what it said', async () => {
  const { client } = scripted([{ text: 'I had a look and found nothing.' }]);
  const a = await ask(client);
  assert.ok(!a.ok);
  assert.equal(a.kind, 'unparseable');
  assert.match(a.raw ?? '', /had a look/);
});

test('JSON that does not fit the schema is a mismatch, and names the field', async () => {
  const { client } = scripted([{ text: '{"reply":"wrong key"}' }]);
  const a = await ask(client);
  assert.ok(!a.ok);
  assert.equal(a.kind, 'schema_mismatch');
  assert.match(a.detail, /answer/);
});

test('an unknown model costs null, never zero', async () => {
  // A zero is a claim about the bill. costUsd's rule, carried into the loop unchanged.
  const { client } = scripted([{ text: '{"answer":"x"}', model: 'claude-something-new', input: 9, output: 9 }]);
  const a = await ask(client);
  assert.ok(a.ok);
  assert.equal(a.costUsd, null);
});

test('the cap is the spec figure, and reaches the runner', async () => {
  assert.equal(MAX_ITERATIONS, 8);
  const { client } = scripted([{ text: '{"answer":"x"}' }]);
  let seen: number | undefined;
  const spy: ToolLoopClient = {
    beta: {
      messages: {
        toolRunner: (body, opts) => {
          seen = (body as { max_iterations?: number }).max_iterations;
          return client.beta.messages.toolRunner(body, opts);
        },
        create: client.beta.messages.create,
      },
    },
  };
  await ask(spy);
  assert.equal(seen, MAX_ITERATIONS);
});

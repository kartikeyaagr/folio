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

/**
 * A runner that yields the turns it was given, and records any closing call made after it.
 *
 * **`params.messages` accumulates, because the real runner's does.** `BetaToolRunner` pushes the
 * assistant message onto `state.params.messages` and then, when the model asked for tools, pushes
 * the tool results too — and its `max_iterations` check sits at the *top* of the next pass, so
 * both are already there by the time the loop breaks. A fake that leaves `params` as it was handed
 * in reports a shorter history than the SDK would, and anything `askWithTools` appends to it looks
 * correct against the fake while duplicating against the real thing. That is §15 finding 16's
 * shape, and the reason this fake mutates rather than holding `body`.
 */
function scripted(turns: Turn[], closing?: Turn) {
  const creates: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming[] = [];
  let yielded = 0;
  const client: ToolLoopClient = {
    beta: {
      messages: {
        toolRunner: (body) => {
          const params = { ...body, messages: [...(body.messages ?? [])] };
          return {
            params,
            async *[Symbol.asyncIterator]() {
              for (const t of turns) {
                yielded++;
                const m = message(t) as Anthropic.Beta.BetaMessage;
                yield m;
                params.messages.push({ role: 'assistant', content: m.content });
                const calls = m.content.filter((b) => b.type === 'tool_use');
                if (calls.length > 0) {
                  params.messages.push({
                    role: 'user',
                    content: calls.map((b) => ({
                      type: 'tool_result' as const,
                      tool_use_id: (b as Anthropic.Beta.BetaToolUseBlock).id,
                      content: 'ran',
                    })),
                  });
                }
              }
            },
          } as never;
        },
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

test('the closing call answers every outstanding call, and cannot ask for more', async () => {
  // An assistant tool_use block with no tool_result after it is rejected by the API, so the turn
  // has to close on a balanced history. The runner's own history already is one — it ran those
  // tools before the cap broke it — so the close re-sends that, and `tool_choice: none` is what
  // stops the cap being a suggestion.
  const { client, creates } = scripted(
    [{ calls: ['t9', 't10'], stop: 'tool_use' }],
    { text: '{"answer":"ok"}' },
  );
  await ask(client);
  const sent = creates[0]!;
  // Found by shape, not by position: BUDGET_SPENT is appended after this one.
  const results = sent.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => (b as { type: string }).type === 'tool_result') as { tool_use_id: string }[];
  assert.deepEqual(results.map((r) => r.tool_use_id), ['t9', 't10'], 'every one is answered');
  assert.deepEqual(sent.tool_choice, { type: 'none' }, 'and it cannot ask for more');
});

test('the closing call sends each outstanding tool call once, not twice', async () => {
  // The runner has already pushed the capped assistant turn and its tool results onto
  // params.messages by the time it breaks. Appending that same turn again puts two copies of every
  // tool_use id in the request, each answered twice, and the API rejects a duplicate id — so the
  // one path §6.2 promises ends in an answer would instead end in `error`, after paying for the
  // whole loop. The bug is invisible to a fake whose params never grow, which is why `scripted`
  // mutates its own.
  const { client, creates } = scripted([{ calls: ['t9'], stop: 'tool_use' }], { text: '{"answer":"ok"}' });
  await ask(client);
  const ids = creates[0]!.messages.flatMap((m) =>
    (Array.isArray(m.content) ? m.content : [])
      .filter((b) => (b as { type: string }).type === 'tool_use')
      .map((b) => (b as Anthropic.Beta.BetaToolUseBlock).id),
  );
  assert.deepEqual(ids, ['t9'], 'the outstanding call appears exactly once');
});

test('the closing call tells the model why it cannot call anything else', async () => {
  // `tool_choice: none` stops the model asking for another tool; it does not tell it why, and a
  // model that does not know the budget is gone writes "let me now check X" — a promise the turn
  // cannot keep. The instruction rides as a trailing user text message rather than as synthetic
  // tool_results, which is what duplicated ids before; consecutive same-role messages are combined
  // into one turn by the API, so this is a legal thing to append to a history already balanced.
  const { client, creates } = scripted([{ calls: ['t9'], stop: 'tool_use' }], { text: '{"answer":"ok"}' });
  await ask(client);
  const sent = creates[0]!;
  const tail = sent.messages[sent.messages.length - 1]!;
  assert.equal(tail.role, 'user');
  assert.match(String(tail.content), /budget/i, 'the model is told the budget is spent');
  assert.match(String(tail.content), /not able to find out/i, 'and told to say what it could not learn');
});

test('the SDK leaves a balanced history behind when max_iterations stops it', async () => {
  // Every test above this one drives a hand-written `scripted` fake, and the fake reimplements the
  // very SDK ordering that `askWithTools` depends on — so a change in `@anthropic-ai/sdk` would
  // break production and leave the suite green. That is the same trap the capped-turn bug was:
  // *"this read as correct against a fake whose params never grew."* Writing a more faithful fake
  // cannot fix it, because the fake is the thing under suspicion.
  //
  // So this one drives the REAL `BetaToolRunner` with only `messages.create` stubbed, and asserts
  // the single property the closing call rests on: when `max_iterations` ends the loop, the history
  // the runner hands back is already balanced — every `tool_use` answered — so appending anything
  // that re-answers those ids is a duplicate. No network and no key.
  const anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new anthropic({ apiKey: 'not-used' });

  let calls = 0;
  const stub = async (): Promise<unknown> =>
    message({ calls: [`t${++calls}`], stop: 'tool_use', input: 1, output: 1 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client.beta.messages as any).create = stub;

  const runner = client.beta.messages.toolRunner({
    model: 'claude-opus-5',
    max_tokens: 64,
    max_iterations: 2,
    messages: [{ role: 'user', content: 'go' }],
    tools: [
      {
        name: 'search_corpus',
        description: 'stand-in',
        input_schema: { type: 'object', properties: {} },
        run: async () => 'ran',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  for await (const m of runner) void m; // drain to the cap

  const sent = runner.params.messages;
  const ids = (blocks: unknown, type: string): string[] =>
    (Array.isArray(blocks) ? blocks : [])
      .filter((b) => (b as { type: string }).type === type)
      .map((b) => (b as { id?: string; tool_use_id?: string }).id ?? (b as { tool_use_id: string }).tool_use_id);

  const asked = sent.flatMap((m) => ids(m.content, 'tool_use'));
  const answered = sent.flatMap((m) => ids(m.content, 'tool_result'));
  assert.ok(asked.length > 0, 'the runner must have recorded the tool calls it made');
  assert.deepEqual(
    answered,
    asked,
    'params.messages must already answer every tool_use when the cap stops the loop — if this ' +
      'fails, loop.ts must synthesise results for the unanswered ids instead of re-sending as-is',
  );
  assert.equal(sent[sent.length - 1]!.role, 'user', 'and it must end on the tool results');
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

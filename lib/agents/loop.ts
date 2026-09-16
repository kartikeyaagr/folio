/**
 * The one door out to a model that is allowed to go and look things up.
 *
 * `model.ts` owns the single-shot call every agent made before R3: one prompt, one schema, one
 * answer. This file owns the other shape — the model chooses what to read, reads it, and then
 * answers under the same schema. Agent 8 is the only caller; agents 1, 2, 6 and 7 keep `askModel`,
 * because `v4.md §8` argues they should and because a loop buys them nothing.
 *
 * **The structured-output contract is unchanged.** `output_config.format` survives alongside
 * `tools` — `BetaToolRunnerParams` is `Omit<MessageCreateParams,'tools'> & { tools: … }`, so
 * everything `askModel` sends still applies. That is what makes a loop's result land in
 * `ai_drafts` through exactly the path a one-shot's does, review gate and all.
 *
 * Three things this file does differently from `model.ts`, each for a reason:
 *
 *   * **`truncated` is terminal here.** `askModel` retries once with a raised ceiling. A loop
 *     cannot: the retry would re-run every tool call in the conversation and re-bill all of it.
 *     The ceiling has to be generous from the start instead.
 *   * **Usage is summed across every message the runner yields**, not read off the last one. The
 *     same bug is recorded as already-fixed once in `model.ts` for the single-call retry; a loop
 *     makes it much more expensive, because the discarded turns are most of the spend.
 *   * **Hitting the cap still produces an answer.** `v4.md §6.2`: *"then the model answers with
 *     what it has or says it could not find out."* Closing the turn is done by re-sending the
 *     history the runner already holds with `tool_choice: none` — no further round trip is allowed,
 *     so the cap is a real ceiling and not a suggestion.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
// Both live on the helper module rather than in the `Messages` namespace, which re-imports them
// from here. Reaching for `Anthropic.Beta.Messages.BetaToolRunnerRequestOptions` does not compile.
import type {
  BetaToolRunnerParams, BetaToolRunnerRequestOptions,
} from '@anthropic-ai/sdk/lib/tools/BetaToolRunner';

import { modelClient } from './client.ts';
import { costUsd, sealObjects, type Answer, type Effort } from './model.ts';

/**
 * `v4.md §6.2`'s cap. Counts API requests, which is one per assistant turn — the model may call
 * several tools in one turn, so this bounds round trips rather than tool rows. `chat_tool_calls`
 * is where the actual reads are counted, and it is the number a person checks.
 *
 * An uncapped agentic loop inside a 30-minute lease is a double-billed run waiting to happen.
 */
export const MAX_ITERATIONS = 8;

/**
 * What the model is told when the cap closes the turn.
 *
 * `tool_choice: none` stops it asking for another tool; it does not tell it why, and a model that
 * does not know the budget is gone writes "let me now check X" — a promise the turn cannot keep.
 * This rides as a trailing `user` text message rather than as the synthetic tool_results an earlier
 * version used: the history the runner hands over is already balanced, every `tool_use` answered,
 * and re-answering those ids is exactly the duplication that made this call fail. Consecutive
 * same-role messages are combined into one turn by the API, so a second `user` message is legal
 * here — and unlike a mid-conversation `system` message it is accepted on every model, which
 * matters because the model on this path comes from the agent row rather than from this file.
 */
const BUDGET_SPENT =
  'The tool budget for this turn is spent, so no further tool calls will run. Answer with what ' +
  'you already have, and say plainly what you were not able to find out.';

/**
 * As generous as a non-streaming request is allowed to be.
 *
 * Measured 11-Sep-2026 on the first turn this screen ever took: at 32,000 the SDK refuses the
 * request *client-side*, before any network call — *"Streaming is required for operations that may
 * take longer than 10 minutes"* — because it estimates the duration from `max_tokens`. Every turn
 * failed identically, with or without a credential, and no test caught it: a scripted client
 * validates nothing.
 *
 * 16,000 is the documented non-streaming ceiling and is ample here — the answer is one JSON object
 * with prose and citations, not a document. The long part of a turn is the reading, and that is
 * spread across iterations that each get this budget.
 *
 * The alternative is the streaming tool runner, which would let this go higher. `v4.md §6.4`
 * refuses streaming *to the reader*, which is a rendering decision and does not forbid it as a
 * transport — v2 streamed the API call for exactly this reason. Worth doing if a turn ever needs
 * more room; it is not worth the shape change today.
 */
const DEFAULT_MAX_TOKENS = 16_000;

export interface ToolLoopInput {
  model: string;
  effort?: Effort;
  system: string;
  task: string;
  /** JSON Schema the final answer must satisfy. Passed to the API and checked again on the way back. */
  schema: Record<string, unknown>;
  tools: BetaRunnableTool[];
  maxIterations?: number;
  maxTokens?: number;
  /** Fired by the runner at `LEASE_MINUTES - 5`, so a runaway loop dies inside its own lease. */
  signal?: AbortSignal;
}

/** Just enough of the SDK to be replaceable in a test. Mirrors `MessagesClient` in `model.ts`. */
export interface ToolLoopClient {
  beta: {
    messages: {
      toolRunner(
        body: BetaToolRunnerParams,
        options?: BetaToolRunnerRequestOptions,
      ): AsyncIterable<Anthropic.Beta.BetaMessage> & {
        readonly params: Readonly<BetaToolRunnerParams>;
      };
      create(
        params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
      ): Promise<Anthropic.Beta.BetaMessage>;
    };
  };
}

/** A model call that may read first. Swappable so agent 8 can be tested without a network or a key. */
export type ToolModel = (input: ToolLoopInput) => Promise<Answer>;

/**
 * The live door, mirroring `liveModel` in `model.ts`: one place constructs a client.
 *
 * `modelClient()` raises `NoModelCredentials` at construction when none is configured, so a turn
 * taken before `ops/SETUP.md` §10 is applied fails with the reason rather than a 401 from the far
 * end. Deferred to call time — importing this module opens no socket and needs no credential.
 */
export const liveToolModel: ToolModel = (input) => askWithTools(modelClient(), input);

/** The text blocks of a message, joined. Non-text blocks are not answers. */
function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Shallow structural check against the schema's required top-level keys.
 *
 * The same check `model.ts` makes, and for the same reason: the API already constrained the shape,
 * so this catches the case where it did not.
 */
function fitsSchema(value: unknown, schema: Record<string, unknown>): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'expected a JSON object';
  }
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  const missing = required.filter((k) => !(k in (value as Record<string, unknown>)));
  return missing.length > 0 ? `missing required: ${missing.join(', ')}` : null;
}

/**
 * A stop reason that ends the run without an answer, or null if the turn was ordinary.
 *
 * `tool_use` is not a failure — it is the loop working. Every other non-`end_turn` reason is read
 * after **every** message, because `model.ts` records the bug where these checks sat outside the
 * loop and only the first response ever met them.
 */
function failureFor(message: Anthropic.Beta.BetaMessage): Extract<Answer, { ok: false }> | null {
  if (message.stop_reason === 'refusal') {
    const category = (message as { stop_details?: { category?: string } }).stop_details?.category ?? 'unknown';
    return { ok: false, kind: 'refusal', detail: `declined (${category})` };
  }
  if (message.stop_reason === 'model_context_window_exceeded') {
    return { ok: false, kind: 'too_large', detail: "the conversation exceeded the model's context window" };
  }
  if (message.stop_reason === 'max_tokens') {
    return {
      ok: false, kind: 'truncated',
      detail: 'ran out of output room; a loop cannot retry without re-running and re-billing every tool call',
    };
  }
  return null;
}

export async function askWithTools(client: ToolLoopClient, input: ToolLoopInput): Promise<Answer> {
  const schema = sealObjects(input.schema) as Record<string, unknown>;
  const base = {
    model: input.model,
    max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: input.system,
    thinking: { type: 'adaptive' as const },
    output_config: {
      effort: input.effort ?? 'high',
      format: { type: 'json_schema' as const, schema },
    },
  };

  let inputTokens = 0;
  let outputTokens = 0;
  let last: Anthropic.Beta.BetaMessage | undefined;
  let runner;

  try {
    runner = client.beta.messages.toolRunner(
      {
        ...base,
        messages: [{ role: 'user', content: input.task }],
        tools: input.tools,
        max_iterations: input.maxIterations ?? MAX_ITERATIONS,
      } as BetaToolRunnerParams,
      input.signal ? { signal: input.signal } : undefined,
    );

    for await (const message of runner) {
      inputTokens += message.usage.input_tokens;
      outputTokens += message.usage.output_tokens;
      last = message;
      const failed = failureFor(message);
      if (failed) return failed;
    }
  } catch (err) {
    return { ok: false, kind: 'error', detail: String(err instanceof Error ? err.message : err) };
  }

  if (!last) return { ok: false, kind: 'error', detail: 'the runner yielded no message' };

  // The cap was reached with the model still asking for tools. One more call over the history the
  // runner has already accumulated, with `tool_choice: none`, so the turn ends in an answer rather
  // than in silence.
  //
  // That history is taken as it stands and only `BUDGET_SPENT` is appended, which is worth stating
  // because the obvious code is wrong. `BetaToolRunner` pushes the assistant message onto
  // `params.messages` and then pushes the tool results, and only *then* does the next pass hit
  // `max_iterations` and break — so by the time control arrives here the last turn is already
  // recorded, tools already run, every `tool_use` already answered. Re-appending it sends each
  // `tool_use` id twice, answered twice, which the API rejects: the one path §6.2 promises ends in
  // an answer would end in `error` instead, after paying for the whole loop. This read as correct
  // against a fake whose `params` never grew; `loop.test.ts`'s `scripted` now mutates its own.
  if (last.stop_reason === 'tool_use') {
    try {
      const closing = await client.beta.messages.create({
        ...base,
        messages: [...runner.params.messages, { role: 'user', content: BUDGET_SPENT }],
        // Still declared: the history references these tools by name, and a request whose history
        // names a tool the request does not is rejected.
        tools: input.tools as unknown as Anthropic.Beta.BetaToolUnion[],
        tool_choice: { type: 'none' },
      } as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);
      inputTokens += closing.usage.input_tokens;
      outputTokens += closing.usage.output_tokens;
      last = closing;
      const failed = failureFor(closing);
      if (failed) return failed;
    } catch (err) {
      return { ok: false, kind: 'error', detail: String(err instanceof Error ? err.message : err) };
    }
  }

  const text = textOf(last);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false, kind: 'unparseable',
      detail: 'the final message was not JSON',
      raw: text.slice(0, 2000),
    };
  }

  const mismatch = fitsSchema(parsed, schema);
  if (mismatch) {
    return { ok: false, kind: 'schema_mismatch', detail: mismatch, raw: text.slice(0, 2000) };
  }

  return {
    ok: true,
    content: parsed as Record<string, unknown>,
    model: last.model,
    inputTokens,
    outputTokens,
    costUsd: costUsd(last.model, inputTokens, outputTokens),
  };
}

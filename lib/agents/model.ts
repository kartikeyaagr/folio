/**
 * The one door out to a model.
 *
 * Every agent calls `ask()`. Nothing else in the system constructs a client, which is what makes
 * "which model, at what effort, costing what" answerable from one file.
 *
 * The whole point of this module is that **there is no such thing as an unexplained failure**.
 * Four named states, and a draft is written for none of them:
 *
 *   refusal          the model declined. stop_reason says so; the category is kept.
 *   truncated        it ran out of output room. Retried ONCE with a raised ceiling, never with
 *                    identical parameters, because identical parameters fail identically.
 *   unparseable      the body is not JSON at all.
 *   schema_mismatch  it is JSON and does not fit. Usually means *our* schema is wrong, which is
 *                    the case that most needs an alert rather than a silent failed row.
 *
 * `stop_reason` is inspected BEFORE the body is parsed. v2 called `json.loads(text)` unguarded and
 * read stop_reason nowhere, so a refusal and a truncation both arrived looking like malformed JSON
 * and both burned a retry going nowhere.
 */

import Anthropic from '@anthropic-ai/sdk';
import Ajv, { type ValidateFunction } from 'ajv';

import { modelClient } from './client.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Anthropic first-party rates, dollars per million tokens, as of 06-Sep-2026.
 *
 * A constant rather than a table. v2 kept prices in Postgres, nothing ever seeded it, and the
 * spend column read $0.00 for every run — a dashboard confidently reporting a number it had no way
 * to know. A constant cannot be empty. Review the date above when a model is added.
 */
export const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICING[model];
  if (!p) return null; // Unknown model: null, never zero. Zero is a claim; null is an admission.
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export type FailureKind =
  | 'refusal'
  | 'truncated'
  | 'unparseable'
  | 'schema_mismatch'
  /** The prompt did not fit. Distinct from `truncated`, whose remedy is the opposite one. */
  | 'too_large'
  | 'error';

export type Answer =
  | {
      ok: true;
      content: Record<string, unknown>;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number | null;
    }
  | { ok: false; kind: FailureKind; detail: string; raw?: string };

export interface AskInput {
  model: string;
  effort?: Effort;
  system: string;
  task: string;
  /** JSON Schema the answer must satisfy. Passed to the API and checked again on the way back. */
  schema: Record<string, unknown>;
  maxTokens?: number;
}

/** A model call. Swappable so agents can be tested without a network or a key. */
export type Model = (input: AskInput) => Promise<Answer>;

const DEFAULT_MAX_TOKENS = 16_000;

/**
 * Does the model's reply match the schema it was given?
 *
 * This checked the required *top-level* keys and nothing else until 18-Sep-2026, under a comment
 * that set its own expiry: *"a full validator would be a dependency earning its place on one
 * check. If schemas grow beyond this, reach for one then."* It was two checks by then — agent 8's
 * `loop.ts`, since cut, carried a verbatim copy — with the handlers making up the difference by hand, and what the
 * shallow form could not see was the case that matters. A declared number arriving as a string,
 * or a required key missing from a nested object, passed here and landed in `ai_drafts.content`,
 * to surface later as a 23514 from a check constraint *inside the acceptance transaction*, which
 * `shapes.ts` records the app as having no error boundary for.
 *
 * `schema_mismatch` exists to say "our schema is wrong" loudly and early. A validator is what
 * makes that true.
 *
 * Ajv rather than Zod because these schemas are already JSON Schema objects and have to stay that
 * way — they are what the API is handed. `strict: false` because they are written for Anthropic's
 * structured outputs rather than for Ajv, and an unknown keyword there is not our bug.
 */
const ajv = new Ajv({ strict: false, allErrors: true });

/** Compiled once per schema. The schemas are module constants, so identity is stable. */
const compiled = new WeakMap<object, ValidateFunction | Error>();

export function fitsSchema(value: unknown, schema: Record<string, unknown>): string | null {
  let validate = compiled.get(schema);
  if (validate === undefined) {
    try {
      validate = ajv.compile(schema);
    } catch (err) {
      validate = err instanceof Error ? err : new Error(String(err));
    }
    compiled.set(schema, validate);
  }
  // A schema that will not compile is our mistake rather than the model's, which is exactly what
  // this failure kind means — so it is reported here and not thrown past the caller.
  if (validate instanceof Error) return `schema will not compile: ${validate.message}`;
  return validate(value) ? null : ajv.errorsText(validate.errors, { dataVar: 'answer' });
}

/**
 * Set `additionalProperties: false` on every object in a schema, at every depth.
 *
 * Structured outputs reject a schema without it: *"For 'object' type, 'additionalProperties' must
 * be explicitly set to false"* — a 400 before the model is ever reached. Measured 08-Sep-2026 on
 * the first live call this system ever made: setting it only on the root object fails identically,
 * so it is genuinely every object and not just the top one.
 *
 * Done here rather than in each agent's schema because it is a property of the transport, not of
 * anything an agent means. Ten of the eleven object schemas in this tree lacked it, which is what
 * a rule every caller has to remember gets you — and only the news gate's happened to have it.
 */
export function sealObjects(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sealObjects);
  if (typeof node !== 'object' || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = sealObjects(v);
  if (out['type'] === 'object') out['additionalProperties'] = false;
  return out;
}

/** Just enough of the SDK to be replaceable in a test. */
export interface MessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/**
 * One model call, against a client the caller supplies.
 *
 * Split out from `liveModel` so the retry and the stop-reason handling are testable without a
 * network or a key — this file's own test said "liveModel itself still has no test — it needs an
 * injected client, which it does not currently take", and all three bugs fixed below lived in the
 * part that had none.
 */
export async function askModel(client: MessagesClient, input: AskInput): Promise<Answer> {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const schema = sealObjects(input.schema);

  const call = (max: number) =>
    client.messages.create({
      model: input.model,
      max_tokens: max,
      system: input.system,
      messages: [{ role: 'user', content: input.task }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: input.effort ?? 'high',
        format: { type: 'json_schema', schema },
      },
    } as Anthropic.MessageCreateParamsNonStreaming);

  let response: Anthropic.Message;
  // **Added up across attempts, not read off the last one.** `response` used to be reassigned by
  // the retry and the usage read from it afterwards, so a run that retried threw away the first
  // attempt's tokens and under-reported its own cost by a whole call. The first attempt was
  // charged for whether or not its answer was usable.
  let inputTokens = 0;
  let outputTokens = 0;

  // At most two: the caller's budget, then room. Every stop reason is read after **every** attempt,
  // because the checks used to sit outside this loop and only the first response ever met them — a
  // retry that came back refused fell through to the text join, hit `JSON.parse('')`, and was
  // recorded as `unparseable`. That defeats the terminal shortcut in `lib/news/gate.ts`, whose own
  // comment says it exists so a refusal does not burn two more calls.
  for (let attempt = 0; ; attempt++) {
    try {
      response = await call(attempt === 0 ? maxTokens : Math.min(maxTokens * 4, 64_000));
    } catch (err) {
      return { ok: false, kind: 'error', detail: String(err instanceof Error ? err.message : err) };
    }
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    if (response.stop_reason === 'refusal') {
      const category =
        (response as { stop_details?: { category?: string } }).stop_details?.category ?? 'unknown';
      return { ok: false, kind: 'refusal', detail: `declined (${category})` };
    }

    // The prompt did not fit. A real StopReason in the installed SDK and previously unhandled, so
    // it reached `JSON.parse('')` and was filed as malformed JSON. Terminal, and deliberately not
    // `truncated`: that one is fixed by allowing more output, and this one is made *worse* by it.
    // The remedy is to send less.
    if (response.stop_reason === 'model_context_window_exceeded') {
      return { ok: false, kind: 'too_large', detail: "the prompt exceeded the model's context window" };
    }

    if (response.stop_reason !== 'max_tokens') break;
    if (attempt > 0) {
      return { ok: false, kind: 'truncated', detail: 'ran out of output room twice' };
    }
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, kind: 'unparseable', detail: 'response was not JSON', raw: text.slice(0, 2000) };
  }

  const problem = fitsSchema(parsed, input.schema);
  if (problem) {
    return { ok: false, kind: 'schema_mismatch', detail: problem, raw: text.slice(0, 2000) };
  }

  return {
    ok: true,
    content: parsed as Record<string, unknown>,
    model: response.model,
    inputTokens,
    outputTokens,
    costUsd: costUsd(response.model, inputTokens, outputTokens),
  };
}

export const liveModel: Model = (input) => askModel(modelClient(), input);

/**
 * A model that answers from a script, recording every call.
 *
 * The assembled prompt is the thing worth asserting on — an agent's real output is the prompt it
 * builds, and the model's reply is downstream of that. Ported in spirit from v2's
 * `scripted_model()`, which existed for the same reason and which the spec's carry-forward list
 * names so it did not get rebuilt from scratch.
 */
export function scriptedModel(
  answers: (Answer | ((input: AskInput) => Answer))[],
): Model & { calls: AskInput[] } {
  const calls: AskInput[] = [];
  let i = 0;
  const model = ((input: AskInput) => {
    calls.push(input);
    const next = answers[Math.min(i, answers.length - 1)];
    i++;
    if (next === undefined) {
      return Promise.resolve<Answer>({ ok: false, kind: 'error', detail: 'script exhausted' });
    }
    return Promise.resolve(typeof next === 'function' ? next(input) : next);
  }) as Model & { calls: AskInput[] };
  model.calls = calls;
  return model;
}

/** A convenience for scripts: a successful answer with plausible token counts. */
export function scriptedOk(content: Record<string, unknown>, model = 'claude-opus-5'): Answer {
  return {
    ok: true,
    content,
    model,
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: costUsd(model, 1000, 500),
  };
}

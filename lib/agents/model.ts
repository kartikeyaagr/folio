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

export type FailureKind = 'refusal' | 'truncated' | 'unparseable' | 'schema_mismatch' | 'error';

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

let client: Anthropic | undefined;
function anthropic(): Anthropic {
  // The presence of a workspace id selects Claude Platform on AWS. A second setting saying which
  // backend to use would be a thing that can disagree with the credentials actually present, and
  // that failure reads as an auth error at the far end rather than as the misconfiguration it is.
  //
  // Deliberately NOT Amazon Bedrock, which is a different product: prefixed model ids, and no
  // structured outputs on Opus 5 or Sonnet 5. Every agent here passes a schema.
  client ??= new Anthropic();
  return client;
}

/**
 * Shallow structural check against the schema's required top-level keys.
 *
 * Not a full JSON Schema validator: the API already constrained the shape, so this catches the
 * case where it did not, and a full validator would be a dependency earning its place on one
 * check. If schemas grow beyond this, reach for one then.
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

export const liveModel: Model = async (input) => {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  const schema = sealObjects(input.schema);

  const call = (max: number) =>
    anthropic().messages.create({
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
  try {
    response = await call(maxTokens);
  } catch (err) {
    return { ok: false, kind: 'error', detail: String(err instanceof Error ? err.message : err) };
  }

  // Before the body, always.
  if (response.stop_reason === 'refusal') {
    const category =
      (response as { stop_details?: { category?: string } }).stop_details?.category ?? 'unknown';
    return { ok: false, kind: 'refusal', detail: `declined (${category})` };
  }

  if (response.stop_reason === 'max_tokens') {
    // Once, with room, never with the same parameters.
    try {
      response = await call(Math.min(maxTokens * 4, 64_000));
    } catch (err) {
      return { ok: false, kind: 'error', detail: String(err instanceof Error ? err.message : err) };
    }
    if (response.stop_reason === 'max_tokens') {
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

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  return {
    ok: true,
    content: parsed as Record<string, unknown>,
    model: response.model,
    inputTokens,
    outputTokens,
    costUsd: costUsd(response.model, inputTokens, outputTokens),
  };
};

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

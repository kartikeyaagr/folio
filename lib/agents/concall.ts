/**
 * Agent 2 — concall insights.
 *
 * **The delta is the product.** A summary of one call restates what a reader could have read; what
 * they cannot get without work is what management said differently this time. So the prior call is
 * loaded and passed alongside, and where there is no prior call the prompt says so explicitly —
 * a model given no comparison and no note about it invents one.
 *
 * The trigger is a transcript document, not a transcript *fetch*. That is what lets this agent work
 * today: a person pasting a transcript in is an arrival, and automatic fetching becomes just
 * another way documents appear rather than a precondition for the agent existing.
 */

import { assertInScope, raise, registerHandler, type HandlerResult, type RunContext } from './runner.ts';
import { systemFor } from './prompt.ts';
import { enqueue } from './queue.ts';
import { serviceTxn, type Client } from '../db.ts';

export const KEY = 'concall-insights';

const READS = ['companies', 'documents', 'document_versions', 'fundamentals'];

/**
 * Below this a "transcript" is a stub, a placeholder or a paste that went wrong, and running a
 * `xhigh` Opus call over it costs real money to say nothing.
 */
export const MIN_TRANSCRIPT_CHARS = 4000;

const SCHEMA = {
  type: 'object',
  required: ['summary', 'guidance_changes', 'commitments', 'unanswered', 'comparison_available'],
  properties: {
    summary: { type: 'string', description: 'What the call was about, in a short paragraph.' },
    comparison_available: {
      type: 'boolean',
      description: 'False when no prior call is held. Everything below is then about this call alone.',
    },
    guidance_changes: {
      type: 'array',
      description: 'How guidance moved since the prior call. Empty when no prior call is held.',
      items: {
        type: 'object',
        required: ['topic', 'previously', 'now', 'direction'],
        properties: {
          topic: { type: 'string' },
          previously: { type: 'string' },
          now: { type: 'string' },
          direction: { type: 'string', enum: ['raised', 'lowered', 'reaffirmed', 'withdrawn', 'new'] },
        },
      },
    },
    commitments: {
      type: 'array',
      description: 'Things management committed to, each with their own words quoted.',
      items: {
        type: 'object',
        required: ['commitment', 'quote'],
        properties: { commitment: { type: 'string' }, quote: { type: 'string' } },
      },
    },
    unanswered: {
      type: 'array',
      description: 'Questions asked on the call that were deflected or left unanswered.',
      items: { type: 'string' },
    },
  },
} as const;

interface Transcript {
  id: string; title: string; companyId: string; symbol: string; name: string;
  writtenAt: string; text: string;
}

/** A version's body is jsonb; a transcript is stored as `{ text }`. */
const bodyText = (body: unknown): string => {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object' && typeof (body as { text?: unknown }).text === 'string') {
    return (body as { text: string }).text;
  }
  return '';
};

async function load(c: Client, documentId: string): Promise<Transcript | null> {
  const { rows } = await c.query<{
    id: string; title: string; companyId: string; symbol: string; name: string;
    writtenAt: string; body: unknown;
  }>(
    `SELECT d.id, d.title, d.company_id AS "companyId", co.symbol, co.name,
            v.written_at AS "writtenAt", v.body
       FROM documents d
       JOIN companies co ON co.id = d.company_id
       JOIN LATERAL (
         SELECT body, written_at FROM document_versions
          WHERE document_id = d.id ORDER BY written_at DESC LIMIT 1
       ) v ON true
      WHERE d.id = $1 AND d.kind = 'transcript'`,
    [documentId],
  );
  const r = rows[0];
  return r ? { ...r, text: bodyText(r.body) } : null;
}

/** The call before this one, for the same company. */
async function priorCall(c: Client, t: Transcript): Promise<Transcript | null> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT d.id
       FROM documents d
       JOIN LATERAL (
         SELECT written_at FROM document_versions
          WHERE document_id = d.id ORDER BY written_at DESC LIMIT 1
       ) v ON true
      WHERE d.company_id = $1 AND d.kind = 'transcript' AND d.id <> $2
        AND d.archived_at IS NULL AND v.written_at < $3
      ORDER BY v.written_at DESC LIMIT 1`,
    [t.companyId, t.id, t.writtenAt],
  );
  return rows[0] ? load(c, rows[0].id) : null;
}

/** Transcripts long enough to be real, with no run yet. */
export async function pending(limit = 20): Promise<{ subjectRef: string; companyId: string }[]> {
  return serviceTxn('system:agents', async (c) => {
    const { rows } = await c.query<{ subjectRef: string; companyId: string }>(
      `SELECT d.id AS "subjectRef", d.company_id AS "companyId"
         FROM documents d
         JOIN LATERAL (
           SELECT body FROM document_versions
            WHERE document_id = d.id ORDER BY written_at DESC LIMIT 1
         ) v ON true
        WHERE d.kind = 'transcript' AND d.archived_at IS NULL AND d.company_id IS NOT NULL
          AND length(COALESCE(v.body->>'text', '')) >= $2
          AND NOT EXISTS (
            SELECT 1 FROM agent_runs r WHERE r.agent_key = $1 AND r.subject_ref = d.id)
        ORDER BY d.created_at DESC
        LIMIT $3`,
      [KEY, MIN_TRANSCRIPT_CHARS, limit],
    );
    return rows;
  });
}

export async function sweep(limit = 20): Promise<number> {
  const work = await pending(limit);
  for (const w of work) await enqueue({ agentKey: KEY, subjectRef: w.subjectRef, companyId: w.companyId });
  return work.length;
}

registerHandler(KEY, async (ctx: RunContext): Promise<HandlerResult> => {
  assertInScope(ctx.agent, READS);

  // One read transaction for both calls: the delta is the product, so the two must come from the
  // same snapshot. The length check stays ahead of `priorCall` so a transcript about to be refused
  // does not pay for the lookup.
  const { call, prior } = await ctx.reads(async (c) => {
    const call = ctx.subjectRef ? await load(c, ctx.subjectRef) : null;
    if (!call) throw new Error(`no transcript document ${ctx.subjectRef}`);
    if (call.text.length < MIN_TRANSCRIPT_CHARS) {
      throw new Error(`transcript ${call.id} is ${call.text.length} chars, below the floor`);
    }
    return { call, prior: await priorCall(c, call) };
  });

  const task = [
    `${call.name} (${call.symbol}) — ${call.title}, recorded ${call.writtenAt}.`,
    '',
    'THIS CALL:',
    call.text,
    '',
    prior
      ? `THE PREVIOUS CALL (${prior.title}, ${prior.writtenAt}):\n${prior.text}`
      : 'No previous call is held for this company. Set comparison_available to false, leave ' +
        'guidance_changes empty, and do not describe anything in this call as a change.',
  ].join('\n');

  // Before the model call: the same line retrieval matches against and the draft stores.
  const situation =
    `Earnings call transcript, ${Math.round(call.text.length / 1000)}k characters, ` +
    `${prior ? 'previous call held for comparison' : 'no previous call held'}`;

  const answer = await ctx.ask({
    model: ctx.agent.model,
    effort: (ctx.agent.effort ?? 'xhigh') as 'xhigh',
    system: await systemFor(ctx.agent, situation),
    task,
    schema: SCHEMA as unknown as Record<string, unknown>,
  });
  if (!answer.ok) raise(answer);

  return {
    draft: {
      content: answer.content,
      // Length matters here in a way it does not elsewhere: a 40,000-character transcript and a
      // 6,000-character one are different jobs, and whether a prior call exists decides whether
      // the delta — the product of this agent — can be computed at all.
      situation,
      sources: [
        { kind: 'document', ref: call.id, role: 'transcript', at: call.writtenAt },
        ...(prior ? [{ kind: 'document', ref: prior.id, role: 'prior_call', at: prior.writtenAt }] : []),
      ],
      // No verifier exists for a summary. Recorded rather than left implied, so a reviewer knows
      // nothing checked this before they did.
      verification: {
        agreed: null,
        note: prior
          ? 'No deterministic check applies. The prior call was supplied for comparison.'
          : 'No deterministic check applies, and no prior call was held to compare against.',
      },
      model: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      costUsd: answer.costUsd,
    },
  };
});

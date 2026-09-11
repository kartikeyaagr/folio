/**
 * Agent 7 — forensic review.
 *
 * Works Trisula's fourteen-item checklist against an annual filing. The checklist is the fund's own
 * content, not a generic template, which is why it is versioned and why answers point at the
 * version they were answered under.
 *
 * **The rule that matters more than any answer:** roughly half these items ask about judgement and
 * scuttlebutt that no filing contains — management credibility, culture, whether an independent
 * director has ever visibly dissented. Returning "clear" for one of those is worse than returning
 * nothing, because it launders an absence of evidence into a clean bill of health. So
 * `unanswerable` is a first-class verdict and the structural check enforces that it is used.
 */

import { assertInScope, raise, registerHandler, type HandlerResult, type RunContext } from './runner.ts';
import { enqueue } from './queue.ts';
import { serviceTxn, type Client } from '../db.ts';

export const KEY = 'forensics-review';

const READS = [
  'companies', 'filings', 'fundamentals', 'attachments',
  'forensics_templates', 'forensics_template_items',
];

/**
 * Items that no filing can answer. Named here rather than inferred, because the whole failure mode
 * is a model that would rather guess than admit a gap.
 */
const NOT_IN_A_FILING = new Set([8, 10, 11]); // attrition, culture and reputation, walk the talk

const SCHEMA = {
  type: 'object',
  required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'verdict', 'note'],
        properties: {
          item: { type: 'integer' },
          verdict: { type: 'string', enum: ['clear', 'concern', 'red_flag', 'unanswerable'] },
          note: { type: 'string' },
        },
      },
    },
  },
} as const;

export interface Item { item: number; section: string; prompt: string; guidance: string }
export interface AnswerRow { item: number; verdict: string; note: string }

/**
 * Annual filings with no forensic review yet.
 *
 * Filtered to periods longer than 300 days, with the reason inline: the checklist asks about
 * five- and ten-year series and about the annual report's own disclosures. Running it on a quarter
 * would answer half of it wrongly and the rest not at all.
 */
export async function pending(limit = 10): Promise<{ subjectRef: string; companyId: string }[]> {
  return serviceTxn('system:agents', async (c) => {
    const { rows } = await c.query<{ subjectRef: string; companyId: string }>(
      `SELECT f.id AS "subjectRef", f.company_id AS "companyId"
         FROM fundamentals f
         JOIN companies co ON co.id = f.company_id
        WHERE f.superseded_by IS NULL
          AND (f.period_end - f.period_start) > 300
          AND co.status <> 'passed'
          AND NOT EXISTS (
            SELECT 1 FROM agent_runs r
             WHERE r.agent_key = $1 AND r.subject_ref = f.id)
        ORDER BY f.period_end DESC
        LIMIT $2`,
      [KEY, limit],
    );
    return rows;
  });
}

export async function sweep(limit = 10): Promise<number> {
  const work = await pending(limit);
  for (const w of work) {
    await enqueue({ agentKey: KEY, subjectRef: w.subjectRef, companyId: w.companyId });
  }
  return work.length;
}

export async function activeChecklist(c: Client): Promise<{ version: number; items: Item[] }> {
  const { rows: v } = await c.query<{ version: number }>(
    'SELECT version FROM forensics_templates WHERE active LIMIT 1',
  );
  const version = v[0]?.version;
  if (version === undefined) throw new Error('no active forensic checklist');
  const { rows: items } = await c.query<Item>(
    'SELECT item, section, prompt, guidance FROM forensics_template_items WHERE version = $1 ORDER BY item',
    [version],
  );
  return { version, items };
}

/**
 * The structural check. Not a judgement on the answers — a judgement on whether the shape is honest.
 *
 * Two failures it catches, and they are the two that matter:
 *   * an item left out entirely, which reads as if it were fine;
 *   * a confident verdict on something a filing cannot possibly show.
 */
export function verifyStructure(
  items: Item[],
  answers: AnswerRow[],
): { agreed: boolean; missing: number[]; overconfident: number[] } {
  const byItem = new Map(answers.map((a) => [a.item, a]));
  const missing = items.filter((i) => !byItem.has(i.item)).map((i) => i.item);
  const overconfident = [...NOT_IN_A_FILING].filter((n) => {
    const a = byItem.get(n);
    return a !== undefined && a.verdict === 'clear';
  });
  return { agreed: missing.length === 0 && overconfident.length === 0, missing, overconfident };
}

registerHandler(KEY, async (ctx: RunContext): Promise<HandlerResult> => {
  assertInScope(ctx.agent, READS);

  // One read transaction for the whole gather: the answers cite the checklist version they were
  // answered under, so the version and the history it was applied to must be the same snapshot.
  const { company, version, items, history } = await ctx.reads(async (c) => {
    const { rows: co } = await c.query<{ symbol: string; name: string }>(
      'SELECT symbol, name FROM companies WHERE id = $1',
      [ctx.companyId],
    );
    const company = co[0];
    if (!company) throw new Error(`no company ${ctx.companyId}`);

    const { version, items } = await activeChecklist(c);

    // Ten years of history, because the checklist asks for it explicitly.
    const { rows: history } = await c.query<{
      period_end: string; revenue: string | null; profit_after_tax: string | null; facts: Record<string, string>;
    }>(
      `SELECT period_end, revenue::text, profit_after_tax::text, facts
         FROM fundamentals
        WHERE company_id = $1 AND superseded_by IS NULL AND (period_end - period_start) > 300
        ORDER BY period_end DESC LIMIT 10`,
      [ctx.companyId],
    );
    return { company, version, items, history };
  });

  const task = [
    `${company.name} (${company.symbol}) — forensic review, checklist version ${version}.`,
    '',
    'Annual history held (most recent first):',
    ...(history.length > 0
      ? history.map(
          (h) =>
            `  ${h.period_end}  revenue ${h.revenue ?? 'n/a'}  PAT ${h.profit_after_tax ?? 'n/a'}`,
        )
      : ['  none']),
    '',
    'Work each item. For every one, give a verdict and a note that says what you read to reach it.',
    '',
    'Several of these ask about things no filing contains — attrition, culture, whether management',
    'delivered what it promised. Answer those `unanswerable` and say what would answer them.',
    'A verdict of `clear` on something the filings cannot show is worse than no answer at all.',
    '',
    ...items.map((i) => `${i.item}. [${i.section}] ${i.prompt}\n    ${i.guidance}`),
  ].join('\n');

  const answer = await ctx.ask({
    model: ctx.agent.model,
    effort: (ctx.agent.effort ?? 'high') as 'high',
    system: ctx.agent.purpose,
    task,
    schema: SCHEMA as unknown as Record<string, unknown>,
  });
  if (!answer.ok) raise(answer);

  const answers = (answer.content['answers'] ?? []) as AnswerRow[];
  const structure = verifyStructure(items, answers);

  return {
    draft: {
      content: { version, answers },
      sources: [
        { kind: 'forensics_template', ref: String(version) },
        ...history.map((h) => ({ kind: 'fundamentals', period_end: h.period_end })),
      ],
      verification: {
        ...structure,
        note:
          structure.agreed
            ? 'Every item answered, and nothing a filing cannot show was marked clear.'
            : 'Shape problems above. The answers are unchanged; a reviewer decides what to do.',
      },
      model: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      costUsd: answer.costUsd,
    },
  };
});

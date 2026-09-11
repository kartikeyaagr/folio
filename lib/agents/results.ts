/**
 * Agent 1 — quarterly results figures.
 *
 * Reads a results filing, reports what the quarter said, and is then **checked against the XBRL
 * the system already parsed**. Where the two disagree, both readings are attached and neither is
 * corrected. The model does not get to overwrite a filed figure, and the filed figure does not get
 * to hide that the model read something else — a reviewer sees the disagreement and decides.
 *
 * The verifier is why this agent runs at effort `high` rather than `xhigh`: there is a safety net
 * under its numbers. The commentary has none, which is what the reviewer is actually for.
 */

import { assertInScope, raise, registerHandler, type RunContext, type HandlerResult } from './runner.ts';
import { serviceTxn, type Client } from '../db.ts';
import { enqueue } from './queue.ts';

export const KEY = 'results-figures';

const READS = ['filings', 'fundamentals', 'attachments'];

const SCHEMA = {
  type: 'object',
  required: ['headline', 'moved', 'one_offs', 'watch_items', 'figures'],
  properties: {
    headline: { type: 'string', description: 'One sentence a reader could repeat.' },
    figures: {
      type: 'object',
      required: ['revenue_cr', 'profit_after_tax_cr'],
      properties: {
        revenue_cr: { type: ['number', 'null'] },
        profit_after_tax_cr: { type: ['number', 'null'] },
      },
    },
    moved: { type: 'array', items: { type: 'string' } },
    one_offs: { type: 'array', items: { type: 'string' } },
    watch_items: { type: 'array', items: { type: 'string' } },
  },
} as const;

const CRORE = 10_000_000;

interface Row {
  id: string; symbol: string; name: string;
  basis: string; period_start: string; period_end: string; period_kind: string;
  revenue: string | null; profit_after_tax: string | null; total_expenses: string | null;
  context_dates_disagreed: boolean; facts: Record<string, string>;
}

/**
 * Work with no run yet.
 *
 * Keyed on the parsed `fundamentals` row rather than on the exchange filing, because that row
 * exists exactly when a results filing has been parsed — and because a restatement creates a new
 * row, which is a new thing to say something about.
 */
export async function pending(limit = 20): Promise<{ subjectRef: string; companyId: string }[]> {
  return serviceTxn('system:agents', async (c) => {
    const { rows } = await c.query<{ subjectRef: string; companyId: string }>(
      `SELECT f.id AS "subjectRef", f.company_id AS "companyId"
         FROM fundamentals f
        WHERE f.superseded_by IS NULL
          AND f.period_kind IN ('quarter', 'half_year')
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

export async function sweep(limit = 20): Promise<number> {
  const work = await pending(limit);
  for (const w of work) {
    await enqueue({ agentKey: KEY, subjectRef: w.subjectRef, companyId: w.companyId });
  }
  return work.length;
}

async function load(c: Client, id: string): Promise<Row | null> {
  const { rows } = await c.query<Row>(
    `SELECT f.id, c.symbol, c.name, f.basis, f.period_start, f.period_end, f.period_kind,
            f.revenue::text, f.profit_after_tax::text, f.total_expenses::text,
            f.context_dates_disagreed, f.facts
       FROM fundamentals f JOIN companies c ON c.id = f.company_id
      WHERE f.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** The most recent comparable period: same basis, same kind, ending more than nine months earlier. */
async function priorPeriod(c: Client, row: Row): Promise<Row | null> {
  const { rows } = await c.query<Row>(
    `SELECT f.id, c.symbol, c.name, f.basis, f.period_start, f.period_end, f.period_kind,
            f.revenue::text, f.profit_after_tax::text, f.total_expenses::text,
            f.context_dates_disagreed, f.facts
       FROM fundamentals f JOIN companies c ON c.id = f.company_id
      WHERE f.company_id = (SELECT company_id FROM fundamentals WHERE id = $1)
        AND f.basis = $2 AND f.period_kind = $3 AND f.superseded_by IS NULL
        AND f.period_end < ($4::date - interval '9 months')
      ORDER BY f.period_end DESC LIMIT 1`,
    [row.id, row.basis, row.period_kind, row.period_end],
  );
  return rows[0] ?? null;
}

const cr = (v: string | null): string => (v === null ? 'not reported' : `${(Number(v) / CRORE).toFixed(1)} cr`);

registerHandler(KEY, async (ctx: RunContext): Promise<HandlerResult> => {
  assertInScope(ctx.agent, READS);

  // One read transaction for the whole gather, so both periods are read from the same snapshot —
  // a re-filing landing between the two queries would otherwise be compared against itself.
  const { row, prior } = await ctx.reads(async (c) => {
    const row = ctx.subjectRef ? await load(c, ctx.subjectRef) : null;
    if (!row) throw new Error(`no fundamentals row ${ctx.subjectRef}`);
    return { row, prior: await priorPeriod(c, row) };
  });

  const task = [
    `${row.name} (${row.symbol}) — ${row.period_kind} ${row.period_start} to ${row.period_end}, ${row.basis}.`,
    '',
    'Filed figures:',
    `  revenue        ${cr(row.revenue)}`,
    `  profit after tax ${cr(row.profit_after_tax)}`,
    `  total expenses ${cr(row.total_expenses)}`,
    '',
    prior
      ? `Comparable prior period (${prior.period_start} to ${prior.period_end}):\n` +
        `  revenue        ${cr(prior.revenue)}\n  profit after tax ${cr(prior.profit_after_tax)}`
      : // Said explicitly. A model given no comparison and no note about it tends to invent one.
        'No comparable prior period is held. Do not infer one; say the comparison is unavailable.',
    '',
    'Report figures in crore. Where a figure was not reported, say so rather than estimating it.',
  ].join('\n');

  const answer = await ctx.ask({
    model: ctx.agent.model,
    effort: (ctx.agent.effort ?? 'high') as 'high',
    system: ctx.agent.purpose,
    task,
    schema: SCHEMA as unknown as Record<string, unknown>,
  });
  if (!answer.ok) raise(answer);

  // ---- verification: the model's figures against the filed ones -------------------------------
  const figures = (answer.content['figures'] ?? {}) as Record<string, number | null>;
  const checks: { field: string; filed: number | null; model: number | null; agreed: boolean }[] = [];
  for (const [field, filedRaw] of [
    ['revenue_cr', row.revenue],
    ['profit_after_tax_cr', row.profit_after_tax],
  ] as const) {
    const filed = filedRaw === null ? null : Number(filedRaw) / CRORE;
    const said = typeof figures[field] === 'number' ? (figures[field] as number) : null;
    // A gap larger than one percent of the filed figure, or a figure the model did not report.
    const agreed =
      filed !== null && said !== null && Math.abs(said - filed) <= Math.abs(filed) * 0.01;
    checks.push({ field, filed, model: said, agreed });
  }

  return {
    draft: {
      content: answer.content,
      sources: [
        { kind: 'fundamentals', ref: row.id, period: `${row.period_start}..${row.period_end}` },
        ...(prior ? [{ kind: 'fundamentals', ref: prior.id, role: 'comparison' }] : []),
      ],
      verification: {
        agreed: checks.every((c) => c.agreed),
        checks,
        // Carried onto the draft so a reviewer sees it without opening the filing: this period's
        // dates came from the reported facts because the context disagreed with them.
        contextDatesDisagreed: row.context_dates_disagreed,
        note: 'Both readings are kept. Neither figure has been corrected.',
      },
      model: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      costUsd: answer.costUsd,
    },
  };
});

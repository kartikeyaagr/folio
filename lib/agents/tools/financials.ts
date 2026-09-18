/**
 * `get_financials` — the reported figures for one company, newest period first.
 *
 * The SQL is here rather than delegated, and that is a deliberate exception to reusing what exists.
 * The three candidates all fit badly: `lib/company-view.ts`'s `companyPage()` has no `basis` filter
 * and drags in five unrelated queries; `lib/sheet/data.ts`'s `answer()` is the only query in the
 * tree taking symbol, period and basis together but is private to the spreadsheet engine and
 * returns one line item at a time; and `lib/agents/results.ts` and `forensics.ts` each hold their
 * own inline copy. **That makes four copies of "multi-period fundamentals for a company" in this
 * tree, and this is the fourth.** Consolidating them is worth doing and is not worth doing in the
 * middle of R3, where it would change what agents 1 and 7 read.
 *
 * `superseded_by IS NULL` is not optional: a restatement is a new row, not an edit, so without it
 * a company that re-filed a quarter returns both readings and the model picks one at random.
 */

import type { Client } from '../../db.ts';
import { betaTool, resolveSubject, served, type ToolContext, type ToolSpec } from './spec.ts';
import { croreText } from '../../money.ts';

/** One crore. Figures are reported in crore because that is how the desk says them out loud. */

const DEFAULT_PERIODS = 8;
const MAX_PERIODS = 20;

interface Row {
  period_kind: string;
  basis: string;
  period_start: string;
  period_end: string;
  revenue: string | null;
  other_income: string | null;
  total_expenses: string | null;
  profit_before_tax: string | null;
  profit_after_tax: string | null;
  eps_basic: string | null;
  audited: boolean | null;
  context_dates_disagreed: boolean;
  period_inferred: boolean;
}

export const spec: ToolSpec = {
  name: 'get_financials',
  reads: ['fundamentals', 'companies'],
  build: (ctx: ToolContext) =>
    betaTool({
      name: 'get_financials',
      description:
        'Reported figures for one company, newest period first: revenue, other income, total ' +
        'expenses, profit before and after tax, and basic EPS, in crore. These are the filed ' +
        'numbers as this system holds them, not a calculation. A figure that was not reported is ' +
        'said to be not reported and is never shown as zero.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          symbol: { type: 'string', description: 'Exchange symbol. Required unless the run already names a company.' },
          basis: {
            type: 'string', enum: ['standalone', 'consolidated'],
            description: 'Omit to get both, which is usually what you want when comparing periods.',
          },
          periods: {
            type: 'integer', minimum: 1, maximum: MAX_PERIODS,
            description: `How many periods back. Default ${DEFAULT_PERIODS}.`,
          },
        },
      },
      run: (args) =>
        served(ctx, 'get_financials', args as unknown as Record<string, unknown>, async () => {
          const found = await resolveSubject(ctx, args.symbol);
          if (!found.ok) return { text: found.why };
          const limit = Math.min(args.periods ?? DEFAULT_PERIODS, MAX_PERIODS);

          const rows = await ctx.reads(async (c: Client) => {
            const { rows } = await c.query<Row>(
              `SELECT period_kind, basis, period_start, period_end,
                      revenue::text, other_income::text, total_expenses::text,
                      profit_before_tax::text, profit_after_tax::text, eps_basic::text,
                      audited, context_dates_disagreed, period_inferred
                 FROM fundamentals
                WHERE company_id = $1 AND superseded_by IS NULL
                  AND ($2::text IS NULL OR basis = $2)
                ORDER BY period_end DESC
                LIMIT $3`,
              [found.company.id, args.basis ?? null, limit],
            );
            return rows;
          });

          if (rows.length === 0) {
            return {
              text:
                `No figures are held for ${found.company.symbol}` +
                `${args.basis ? ` on a ${args.basis} basis` : ''}. This says nothing about the ` +
                'company; it says this system has not ingested any.',
            };
          }

          const lines = rows.map((r) => {
            // Surfaced because it is measured, not theoretical: NSE's year-to-date context declares
            // the quarter's dates while carrying nine months of figures, and on 24 live filings all
            // 24 disagreed. A period flagged here should not be quoted as a quarter without saying so.
            const doubt = [
              r.context_dates_disagreed ? 'the filing\'s own dates and figures disagreed' : null,
              r.period_inferred ? 'the period was inferred rather than reported' : null,
              r.audited === false ? 'unaudited' : null,
            ].filter((x): x is string => x !== null);
            return [
              `${r.period_kind} ${r.period_start} to ${r.period_end} (${r.basis})`,
              `  revenue          ${croreText(r.revenue)}`,
              `  other income     ${croreText(r.other_income)}`,
              `  total expenses   ${croreText(r.total_expenses)}`,
              `  profit before tax ${croreText(r.profit_before_tax)}`,
              `  profit after tax  ${croreText(r.profit_after_tax)}`,
              `  basic EPS        ${r.eps_basic ?? 'not reported'}`,
              doubt.length > 0 ? `  caution: ${doubt.join('; ')}` : null,
            ].filter((x): x is string => x !== null).join('\n');
          });

          return {
            text: `${found.company.name} (${found.company.symbol}) — ${rows.length} periods held.\n\n${lines.join('\n\n')}`,
          };
        }),
    }),
};

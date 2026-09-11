/**
 * `list_filings` — what a company has announced, most recent first.
 *
 * Delegates to `lib/filings.ts`'s `filings()`, whose SQL reads `filings`, `companies` and `alerts`
 * (the last for the severity of any alert a filing already raised, which is worth the model seeing:
 * it is what this system already thought was worth interrupting somebody over).
 *
 * `filings()` takes a window in **days**; `v4.md §6.2` gives this tool a `since` date. Converted
 * here rather than by widening `filings()`, which four screens already call. The conversion rounds
 * up, so a `since` never silently excludes the day it names.
 *
 * This tool lists *what was announced*, not what the announcements say. A filing's own text lives
 * in the corpus — `search_corpus` is how you read one. The description says so, because the
 * summaries here are NSE's category blurbs and several of them name no content at all; Task 10
 * found exactly that failure (questions A2, A4 and A7 all returned a blurb as their best hit).
 */

import { filings } from '../../filings.ts';
import { betaTool, resolveSubject, served, type ToolContext, type ToolSpec } from './spec.ts';

const DEFAULT_DAYS = 90;
const MAX_ROWS = 60;
const DAY_MS = 86_400_000;

export const spec: ToolSpec = {
  name: 'list_filings',
  reads: ['filings', 'companies', 'alerts'],
  build: (ctx: ToolContext) =>
    betaTool({
      name: 'list_filings',
      description:
        'Exchange announcements for one company, most recent first, with the category and the ' +
        "exchange's own summary line. Use it to find out what was announced and when. Many " +
        'summaries name no content — "General Updates", "Press Release" — so to read what an ' +
        'announcement actually said, search the corpus for it instead.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          symbol: { type: 'string', description: 'Exchange symbol. Required unless the run already names a company.' },
          category: { type: 'string', description: "One of NSE's categories, exactly as it spells it." },
          since: { type: 'string', description: `ISO date. Default is the last ${DEFAULT_DAYS} days.` },
        },
      },
      run: (args) =>
        served(ctx, 'list_filings', args as unknown as Record<string, unknown>, async () => {
          const found = await resolveSubject(ctx, args.symbol);
          if (!found.ok) return { text: found.why };

          let days = DEFAULT_DAYS;
          if (args.since) {
            const at = Date.parse(args.since);
            if (Number.isNaN(at)) return { text: `${args.since} is not a date I can read; use YYYY-MM-DD.` };
            days = Math.max(1, Math.ceil((Date.now() - at) / DAY_MS));
          }

          const rows = await filings({
            companyId: found.company.id, category: args.category ?? null, days, limit: MAX_ROWS,
          });

          if (rows.length === 0) {
            return {
              text:
                `${found.company.symbol} has no filings held in that window` +
                `${args.category ? ` under ${args.category}` : ''}. The window is ${days} days.`,
            };
          }

          const lines = rows.map((r) => {
            const when = r.announcedAt.toISOString().slice(0, 10);
            const alert = r.alertSeverity ? ` · raised a ${r.alertSeverity} alert` : '';
            return `${when} · ${r.category ?? 'uncategorised'} · ${r.summary ?? 'no summary given'}${alert}`;
          });

          return {
            text: `${found.company.symbol} — ${rows.length} filings in the last ${days} days.\n\n${lines.join('\n')}`,
          };
        }),
    }),
};

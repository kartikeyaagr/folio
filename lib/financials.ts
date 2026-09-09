/**
 * The three statements, fetched.
 *
 * The *shape* of a statement — which lines, in what order, which are subtotals, which are computed
 * — lives in `./statements.ts`. This file is the query around it: which periods exist, on which
 * basis, and which of them carry a balance sheet or a cash flow at all.
 *
 * **Nothing is estimated.** A line the filing did not carry is null and renders as a Blank, never
 * as a zero.
 */

import { readTxn } from './db.ts';
import {
  BALANCE_SHEET, CASH_FLOW, PNL, statement,
  type Facts, type Period, type PeriodKind, type Statement,
} from './statements.ts';

export type { Period, PeriodKind, Statement, StatementRow } from './statements.ts';

export type Basis = 'standalone' | 'consolidated';

export interface Financials {
  /** Both, always, so the toggle can show a basis the company does not file rather than hide it. */
  bases: Basis[];
  /** The ones it actually files. The rest are offered disabled. */
  filed: Basis[];
  basis: Basis;
  pnl: { kind: PeriodKind; label: string; statement: Statement }[];
  balanceSheet: Statement;
  cashFlow: Statement;
}

const KIND_LABEL: Record<PeriodKind, string> = {
  year: 'Yearly',
  half_year: 'Half-yearly',
  quarter: 'Quarterly',
  year_to_date: 'Year to date',
};

interface Row {
  period_start: string;
  period_end: string;
  period_kind: PeriodKind;
  basis: Basis;
  context_dates_disagreed: boolean;
  facts: Facts;
}

const periodsOf = (rows: Row[]): Period[] =>
  rows.map((r) => ({
    end: r.period_end,
    start: r.period_start,
    kind: r.period_kind,
    suspectDates: r.context_dates_disagreed,
  }));

const factsOf = (rows: Row[]): Facts[] => rows.map((r) => r.facts);

export async function financials(companyId: string, want?: Basis): Promise<Financials> {
  return readTxn(async (c) => {
    const { rows: available } = await c.query<{ basis: Basis }>(
      `SELECT DISTINCT basis FROM fundamentals
        WHERE company_id = $1 AND superseded_by IS NULL ORDER BY basis`,
      [companyId],
    );
    const filed = available.map((b) => b.basis);
    // Both, always. The toggle used to be hidden when a company filed one basis, so a reader saw no
    // control and could not tell whether the choice was missing or the data was — which is what
    // sent somebody looking for it. It is shown and the unfiled side is disabled.
    const bases: Basis[] = ['consolidated', 'standalone'];
    // Consolidated first where both exist: it is the group, which is what a reader means by "the
    // company". A company that files only standalone gets standalone, and the toggle does not
    // offer a basis with no rows behind it.
    const basis: Basis =
      want && filed.includes(want) ? want : filed.includes('consolidated') ? 'consolidated' : 'standalone';

    const { rows } = await c.query<Row>(
      `SELECT period_start::text, period_end::text, period_kind, basis,
              context_dates_disagreed, facts
         FROM fundamentals
        WHERE company_id = $1 AND superseded_by IS NULL AND basis = $2
        ORDER BY period_end`,
      [companyId, basis],
    );

    const of = (kind: PeriodKind): Row[] => rows.filter((r) => r.period_kind === kind).slice(-12);

    // Only the period kinds this company actually files. An SME half-yearly filer has no quarters,
    // and an empty "Quarterly" tab is an invitation to wonder what went wrong.
    const pnl = (['year', 'half_year', 'quarter', 'year_to_date'] as PeriodKind[])
      .map((kind) => {
        const rows = of(kind);
        return {
          kind,
          label: KIND_LABEL[kind],
          statement: statement(periodsOf(rows), factsOf(rows), PNL),
        };
      })
      .filter((p) => p.statement.periods.length > 0);

    // The balance sheet and cash flow come from whichever periods carry them — in practice the
    // annual filing, since a quarterly one has neither.
    //
    // **Deduplicated by the date they are as at.** A balance sheet is a position at an instant, not
    // over a period, so a half-year ending 31-Mar and the year ending 31-Mar report the *same*
    // sheet. Keyed by the period they were filed under, that draws two identical columns under two
    // different headings, which reads as a company that did not move rather than as one figure
    // shown twice. The cash flow is a flow and needs no such treatment, but the same key is
    // harmless there because two periods ending together would genuinely be the same statement.
    const byInstant = (kept: Row[]): Row[] => {
      const at = new Map<string, Row>();
      for (const r of kept) at.set(r.period_end, r);
      return [...at.values()].sort((a, b) => a.period_end.localeCompare(b.period_end));
    };

    // Which periods carry one at all. Asked of the leaf keys, because a parent row like Borrowings
    // is a sum of two columns and neither is named `borrowings`.
    const carries = (defs: { key: string; children?: { key: string }[] }[], f: Facts): boolean =>
      defs.some((d) => f[d.key] !== undefined || (d.children ?? []).some((c) => f[c.key] !== undefined));

    const withBalance = byInstant(rows.filter((r) => carries(BALANCE_SHEET, r.facts))).slice(-12);
    const withCash = byInstant(rows.filter((r) => carries(CASH_FLOW, r.facts))).slice(-12);

    return {
      bases,
      filed,
      basis,
      pnl,
      balanceSheet: statement(periodsOf(withBalance), factsOf(withBalance), BALANCE_SHEET),
      cashFlow: statement(periodsOf(withCash), factsOf(withCash), CASH_FLOW),
    };
  });
}

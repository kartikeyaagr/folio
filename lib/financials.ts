/**
 * The three statements, as tables a reader can scan across.
 *
 * Periods are columns and line items are rows, which is how every filing and every screener lays
 * them out, and how a person reads a trend. The page rendered a flat list of twelve rows carrying
 * revenue and PAT and nothing else — every other figure was ingested, stored, and never shown.
 *
 * Everything here comes from `fundamentals.facts`, which holds the canonicalised names for both the
 * P&L columns and the balance-sheet and cash-flow items that have no column. One source, so a
 * figure cannot differ between two places on the same page.
 *
 * **Nothing is estimated.** A line the filing did not carry is null and renders as a Blank, never
 * as a zero. The one computed row is operating profit, whose formula is stated where it is defined
 * and which is null whenever any of its inputs is.
 */

import { readTxn } from './db.ts';

export type Basis = 'standalone' | 'consolidated';
export type PeriodKind = 'quarter' | 'half_year' | 'year_to_date' | 'year';

export interface Period {
  end: string;
  start: string;
  kind: PeriodKind;
  /** Whether the filing's own context disagreed with its facts about the dates. */
  suspectDates: boolean;
}

export interface StatementRow {
  key: string;
  label: string;
  values: (string | null)[];
  /** A subtotal or a headline, shown heavier. */
  strong?: boolean;
  /** Computed here rather than reported. Said in the UI, not left for a reader to assume. */
  derived?: boolean;
}

export interface Statement {
  periods: Period[];
  rows: StatementRow[];
}

export interface Financials {
  /** Only the bases this company actually files. A toggle should not offer an empty table. */
  bases: Basis[];
  basis: Basis;
  pnl: { kind: PeriodKind; label: string; statement: Statement }[];
  balanceSheet: Statement;
  cashFlow: Statement;
}

/** In the order a P&L is read, which is the order it is filed. */
const PNL: [string, string][] = [
  ['revenue', 'Revenue from operations'],
  ['other_income', 'Other income'],
  ['total_income', 'Total income'],
  ['cost_of_materials', 'Cost of materials'],
  ['purchases_stock_in_trade', 'Purchases of stock in trade'],
  ['changes_in_inventories', 'Changes in inventories'],
  ['employee_cost', 'Employee cost'],
  ['finance_costs', 'Finance costs'],
  ['depreciation', 'Depreciation'],
  ['other_expenses', 'Other expenses'],
  ['total_expenses', 'Total expenses'],
  ['profit_before_tax', 'Profit before tax'],
  ['tax_expense', 'Tax expense'],
  ['profit_after_tax', 'Profit after tax'],
  ['comprehensive_income', 'Comprehensive income'],
  ['eps_basic', 'EPS, basic'],
  ['eps_diluted', 'EPS, diluted'],
];

const STRONG = new Set(['total_income', 'total_expenses', 'profit_before_tax', 'profit_after_tax']);

const BALANCE_SHEET: [string, string][] = [
  ['total_assets', 'Total assets'],
  ['current_assets', 'Current assets'],
  ['inventories', 'Inventories'],
  ['trade_receivables', 'Trade receivables'],
  ['cash_and_equivalents', 'Cash and equivalents'],
  ['total_equity', 'Total equity'],
  ['current_liabilities', 'Current liabilities'],
  ['trade_payables', 'Trade payables'],
  ['borrowings_current', 'Borrowings, current'],
  ['borrowings_noncurrent', 'Borrowings, non-current'],
];

const CASH_FLOW: [string, string][] = [
  ['cash_from_operations', 'Cash from operations'],
  ['cash_from_investing', 'Cash from investing'],
  ['cash_from_financing', 'Cash from financing'],
];

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
  facts: Record<string, string>;
}

const num = (v: string | undefined): string | null =>
  v !== undefined && v !== '' && Number.isFinite(Number(v)) ? v : null;

/**
 * Operating profit: revenue, less the expenses of operating.
 *
 * `total_expenses` includes interest and depreciation, so both are added back — the same
 * definition a screener uses, and the reason it is marked `derived` in the table rather than
 * sitting among the reported lines as though the company had filed it.
 *
 * Null if any input is missing. A subtraction with an absent term is not a smaller number, it is
 * an unknown one, and printing it would be the most confident wrong figure on the page.
 */
function operatingProfit(f: Record<string, string>): string | null {
  const revenue = num(f['revenue']);
  const expenses = num(f['total_expenses']);
  if (revenue === null || expenses === null) return null;
  const finance = num(f['finance_costs']) ?? '0';
  const depreciation = num(f['depreciation']) ?? '0';
  // Interest and depreciation are added back only when the filing reported them; where it did not,
  // they are genuinely absent from total_expenses too, so treating them as zero is correct here
  // and is not the same as treating a missing revenue as zero.
  return String(Number(revenue) - Number(expenses) + Number(finance) + Number(depreciation));
}

function build(rows: Row[], items: [string, string][], withDerived: boolean): Statement {
  const periods: Period[] = rows.map((r) => ({
    end: r.period_end,
    start: r.period_start,
    kind: r.period_kind,
    suspectDates: r.context_dates_disagreed,
  }));

  const out: StatementRow[] = [];
  for (const [key, label] of items) {
    const values = rows.map((r) => num(r.facts[key]));
    // A line no period reported is left out entirely rather than drawn as a row of blanks. A
    // quarterly filing carries no balance sheet, and ten empty rows say nothing ten times.
    if (values.every((v) => v === null)) continue;
    out.push({ key, label, values, strong: STRONG.has(key) });

    if (withDerived && key === 'total_expenses') {
      const op = rows.map((r) => operatingProfit(r.facts));
      if (op.some((v) => v !== null)) {
        out.push({ key: 'operating_profit', label: 'Operating profit', values: op, derived: true });
      }
    }
  }
  return { periods, rows: out };
}

/**
 * Everything the company has filed, on one basis.
 *
 * Ordered oldest to newest left to right, because a trend reads forwards. Capped at twelve periods
 * per statement: wider than a screen and a reader is scrolling a table rather than seeing a shape.
 */
export async function financials(companyId: string, want?: Basis): Promise<Financials> {
  return readTxn(async (c) => {
    const { rows: available } = await c.query<{ basis: Basis }>(
      `SELECT DISTINCT basis FROM fundamentals
        WHERE company_id = $1 AND superseded_by IS NULL ORDER BY basis`,
      [companyId],
    );
    const bases = available.map((b) => b.basis);
    // Consolidated first where both exist: it is the group, which is what a reader means by "the
    // company". A company that files only standalone gets standalone, and the toggle does not
    // offer a basis with no rows behind it.
    const basis: Basis =
      want && bases.includes(want) ? want : bases.includes('consolidated') ? 'consolidated' : 'standalone';

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
      .map((kind) => ({ kind, label: KIND_LABEL[kind], statement: build(of(kind), PNL, true) }))
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

    const withBalance = byInstant(rows.filter((r) => BALANCE_SHEET.some(([k]) => r.facts[k] !== undefined)));
    const withCash = byInstant(rows.filter((r) => CASH_FLOW.some(([k]) => r.facts[k] !== undefined)));

    return {
      bases,
      basis,
      pnl,
      balanceSheet: build(withBalance.slice(-12), BALANCE_SHEET, false),
      cashFlow: build(withCash.slice(-12), CASH_FLOW, false),
    };
  });
}

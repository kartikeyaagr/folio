/**
 * The three statements, in the shape the desk already reads them in.
 *
 * Laid out to match Screener: a compact set of lines with the detail folded into the ones that
 * have detail, subtotals in bold, and the ratios that everyone computes anyway computed here.
 * That is not imitation for its own sake — it is the layout this desk reads every day, and a
 * second layout for the same numbers is a second thing to learn and a place for the two to
 * disagree.
 *
 * **Every derived figure is arithmetic on reported lines and is marked as derived.** Nothing here
 * estimates: a ratio whose numerator or denominator was not filed is null and renders as a Blank,
 * because a margin computed against a missing revenue is not a smaller margin, it is an unknown
 * one.
 */

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
  /** Rendered as a percentage rather than converted to crore. */
  percent?: boolean;
  /** Per share and in rupees, not crore. */
  perShare?: boolean;
  /** Folded away behind this row's expander. */
  children?: StatementRow[];
}

export interface Statement {
  periods: Period[];
  rows: StatementRow[];
}

export type Facts = Record<string, string>;

const n = (f: Facts, key: string): number | null => {
  const v = f[key];
  if (v === undefined || v === '' || !Number.isFinite(Number(v))) return null;
  return Number(v);
};

/** A figure straight off the filing. */
const raw = (key: string) => (f: Facts): string | null => {
  const v = n(f, key);
  return v === null ? null : String(v);
};

/**
 * Operating profit: revenue, less the expenses of operating.
 *
 * `total_expenses` includes interest and depreciation, so both are added back — the same
 * definition a screener uses. Null if revenue or total expenses is missing; where finance costs or
 * depreciation were not reported they are genuinely absent from `total_expenses` too, so treating
 * *those* as zero is correct and is not the same as treating a missing revenue as zero.
 */
function operatingProfit(f: Facts): string | null {
  const revenue = n(f, 'revenue');
  const expenses = n(f, 'total_expenses');
  if (revenue === null || expenses === null) return null;
  return String(revenue - expenses + (n(f, 'finance_costs') ?? 0) + (n(f, 'depreciation') ?? 0));
}

/** A ratio of two reported lines, as a percentage. Null unless both were filed and the base is non-zero. */
const ratio = (top: (f: Facts) => string | null, bottomKey: string) => (f: Facts): string | null => {
  const a = top(f);
  const b = n(f, bottomKey);
  if (a === null || b === null || b === 0) return null;
  return String((Number(a) / b) * 100);
};

const sum = (...keys: string[]) => (f: Facts): string | null => {
  const parts: (number | null)[] = keys.map((k) => n(f, k));
  // Every term or nothing. A total missing one of its components is not a smaller total.
  let total = 0;
  for (const p of parts) {
    if (p === null) return null;
    total += p;
  }
  return String(total);
};

type Def = {
  key: string;
  label: string;
  of: (f: Facts) => string | null;
  strong?: boolean;
  derived?: boolean;
  percent?: boolean;
  perShare?: boolean;
  children?: Def[];
};

/**
 * The P&L, in Screener's order and its words.
 *
 * The expense breakdown sits behind the Expenses row as a share of sales, which is how it is read:
 * "material cost is 50% of sales" is a sentence about a business, where "material cost is 506
 * crore" is a sentence about a quarter.
 */
export const PNL: Def[] = [
  { key: 'revenue', label: 'Sales', of: raw('revenue') },
  {
    key: 'total_expenses',
    label: 'Expenses',
    of: raw('total_expenses'),
    children: [
      { key: 'material_pct', label: 'Material Cost %', of: ratio(raw('cost_of_materials'), 'revenue'), derived: true, percent: true },
      { key: 'purchases_pct', label: 'Purchases %', of: ratio(raw('purchases_stock_in_trade'), 'revenue'), derived: true, percent: true },
      { key: 'inventory_pct', label: 'Inventory change %', of: ratio(raw('changes_in_inventories'), 'revenue'), derived: true, percent: true },
      { key: 'employee_pct', label: 'Employee Cost %', of: ratio(raw('employee_cost'), 'revenue'), derived: true, percent: true },
      { key: 'other_pct', label: 'Other Cost %', of: ratio(raw('other_expenses'), 'revenue'), derived: true, percent: true },
    ],
  },
  { key: 'operating_profit', label: 'Operating Profit', of: operatingProfit, strong: true, derived: true },
  { key: 'opm', label: 'OPM %', of: ratio(operatingProfit, 'revenue'), derived: true, percent: true },
  { key: 'other_income', label: 'Other Income', of: raw('other_income') },
  { key: 'finance_costs', label: 'Interest', of: raw('finance_costs') },
  { key: 'depreciation', label: 'Depreciation', of: raw('depreciation') },
  { key: 'profit_before_tax', label: 'Profit before tax', of: raw('profit_before_tax'), strong: true },
  { key: 'tax_pct', label: 'Tax %', of: ratio(raw('tax_expense'), 'profit_before_tax'), derived: true, percent: true },
  { key: 'profit_after_tax', label: 'Net Profit', of: raw('profit_after_tax'), strong: true },
  { key: 'comprehensive_income', label: 'Comprehensive income', of: raw('comprehensive_income') },
  { key: 'eps_basic', label: 'EPS in Rs', of: raw('eps_basic'), perShare: true },
  { key: 'eps_diluted', label: 'EPS, diluted', of: raw('eps_diluted'), perShare: true },
];

export const BALANCE_SHEET: Def[] = [
  { key: 'total_equity', label: 'Equity', of: raw('total_equity') },
  {
    key: 'borrowings',
    label: 'Borrowings',
    of: sum('borrowings_current', 'borrowings_noncurrent'),
    derived: true,
    children: [
      { key: 'borrowings_current', label: 'Current', of: raw('borrowings_current') },
      { key: 'borrowings_noncurrent', label: 'Non-current', of: raw('borrowings_noncurrent') },
    ],
  },
  {
    key: 'current_liabilities',
    label: 'Current liabilities',
    of: raw('current_liabilities'),
    children: [{ key: 'trade_payables', label: 'Trade payables', of: raw('trade_payables') }],
  },
  {
    key: 'current_assets',
    label: 'Current assets',
    of: raw('current_assets'),
    children: [
      { key: 'inventories', label: 'Inventories', of: raw('inventories') },
      { key: 'trade_receivables', label: 'Trade receivables', of: raw('trade_receivables') },
      { key: 'cash_and_equivalents', label: 'Cash and equivalents', of: raw('cash_and_equivalents') },
    ],
  },
  { key: 'total_assets', label: 'Total Assets', of: raw('total_assets'), strong: true },
];

export const CASH_FLOW: Def[] = [
  { key: 'cash_from_operations', label: 'Cash from Operating Activity', of: raw('cash_from_operations') },
  { key: 'cash_from_investing', label: 'Cash from Investing Activity', of: raw('cash_from_investing') },
  { key: 'cash_from_financing', label: 'Cash from Financing Activity', of: raw('cash_from_financing') },
  {
    key: 'net_cash_flow',
    label: 'Net Cash Flow',
    of: sum('cash_from_operations', 'cash_from_investing', 'cash_from_financing'),
    strong: true,
    derived: true,
  },
];

/** A line no period reported is left out entirely rather than drawn as a row of blanks. */
function hasAny(r: StatementRow): boolean {
  return r.values.some((v) => v !== null) || (r.children?.length ?? 0) > 0;
}

// A declaration rather than a `const` arrow, because it recurses into itself for the children and
// a hoisted binding has no window in which it is not yet there.
function build(def: Def, facts: Facts[]): StatementRow {
  return {
    key: def.key,
    label: def.label,
    values: facts.map(def.of),
    ...(def.strong ? { strong: true } : {}),
    ...(def.derived ? { derived: true } : {}),
    ...(def.percent ? { percent: true } : {}),
    ...(def.perShare ? { perShare: true } : {}),
    ...(def.children ? { children: def.children.map((c) => build(c, facts)).filter(hasAny) } : {}),
  };
}

export function statement(periods: Period[], facts: Facts[], defs: Def[]): Statement {
  return { periods, rows: defs.map((d) => build(d, facts)).filter(hasAny) };
}

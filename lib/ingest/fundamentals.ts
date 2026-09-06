/**
 * Financial results: from NSE's XBRL instance to a row a page can read.
 *
 * The parser (`./xbrl.ts`) does the hard part — deciding which period a set of facts actually
 * covers, given that the contexts lie about it. This module is the plumbing around it: find the
 * filings that belong to followed companies, fetch the instance, map its elements onto columns,
 * and store one row per period per basis.
 *
 * Results come from `corporates-financial-results`, which returns the instance URL directly. They
 * are deliberately not found by filtering announcements on `hasXbrl`, because NSE sets that flag
 * on everything, a Copy of Newspaper Publication included.
 */

import { createHash } from 'node:crypto';
import { serviceTxn } from '../db.ts';
import { NseSession } from './nse.ts';
import { parse, UnparseableXbrl, type Report } from './xbrl.ts';

/**
 * Taxonomy element to column. Deliberately a plain mapping rather than anything clever: these
 * names are the contract with the exchange, they change rarely, and when one does the right
 * response is for the figure to go null and be noticed — not for a fuzzy matcher to quietly pick
 * a different line item.
 */
const CANONICAL: Record<string, string> = {
  RevenueFromOperations: 'revenue',
  OtherIncome: 'other_income',
  Income: 'total_income',
  CostOfMaterialsConsumed: 'cost_of_materials',
  PurchasesOfStockInTrade: 'purchases_stock_in_trade',
  ChangesInInventoriesOfFinishedGoodsWorkInProgressAndStockInTrade: 'changes_in_inventories',
  EmployeeBenefitExpense: 'employee_cost',
  FinanceCosts: 'finance_costs',
  DepreciationDepletionAndAmortisationExpense: 'depreciation',
  OtherExpenses: 'other_expenses',
  Expenses: 'total_expenses',
  ProfitBeforeTax: 'profit_before_tax',
  TaxExpense: 'tax_expense',
  ProfitLossForPeriod: 'profit_after_tax',
  ComprehensiveIncomeForThePeriod: 'comprehensive_income',
  BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations: 'eps_basic',
  DilutedEarningsLossPerShareFromContinuingAndDiscontinuedOperations: 'eps_diluted',
};

/**
 * Balance sheet, read from the instant context. Absent from ordinary quarterly filings.
 *
 * Contingent liabilities are not here because the taxonomy has no element for them. It has
 * ProvisionsCurrent and ProvisionsNoncurrent, which are *recognised* obligations; a contingent
 * liability is by definition unrecognised and disclosed in the notes as prose. Mapping provisions
 * to a contingent-liability field would be wrong in the dangerous direction, making a company with
 * large undisclosed exposures look clean.
 */
const BALANCE_SHEET: Record<string, string> = {
  TradeReceivablesCurrent: 'trade_receivables',
  Inventories: 'inventories',
  CashAndCashEquivalents: 'cash_and_equivalents',
  TradePayablesCurrent: 'trade_payables',
  BorrowingsCurrent: 'borrowings_current',
  BorrowingsNoncurrent: 'borrowings_noncurrent',
  CurrentAssets: 'current_assets',
  CurrentLiabilities: 'current_liabilities',
  Assets: 'total_assets',
  Equity: 'total_equity',
};

/** A value that will not parse as a number is left out rather than defaulted to zero. */
function numeric(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === '') return null;
  return Number.isFinite(Number(t)) ? t : null;
}

/** Every element we understand, flattened. Absent means absent from the filing. */
export function canonicalFigures(report: Report): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [element, column] of Object.entries(CANONICAL)) {
    const v = numeric(report.facts[element]);
    if (v !== null) out[column] = v;
  }
  for (const [element, column] of Object.entries(BALANCE_SHEET)) {
    const v = numeric(report.instantFacts[element]);
    if (v !== null) out[column] = v;
  }
  return out;
}

export interface ResultsFiling {
  symbol: string;
  isin: string | null;
  xbrlUrl: string;
  periodEnd: string | null;
}

/** The results feed, filtered to instances that actually exist. */
export async function fetchResultsIndex(session?: NseSession): Promise<ResultsFiling[]> {
  const s = session ?? (await NseSession.open());
  const rows = await s.rows<Record<string, unknown>>('corporates-financial-results', {
    index: 'equities',
    period: 'Quarterly',
  });
  const out: ResultsFiling[] = [];
  for (const r of rows) {
    const url = String(r['xbrl'] ?? '').trim();
    // NSE writes a bare "-" where there is no instance.
    if (!url.startsWith('http')) continue;
    out.push({
      symbol: String(r['symbol'] ?? '').trim().toUpperCase(),
      isin: String(r['isin'] ?? '').trim() || null,
      xbrlUrl: url,
      periodEnd: String(r['toDate'] ?? '').trim() || null,
    });
  }
  return out;
}

export interface IngestResult {
  candidates: number;
  parsed: number;
  stored: number;
  failed: number;
  disagreed: number;
}

/**
 * Fetch and store results for every followed company.
 *
 * A restatement is a new row rather than an edit: the unique index covers only rows with no
 * `superseded_by`, so re-filing a period supersedes the old figures instead of overwriting what
 * was believed at the time.
 */
export async function ingestFundamentals(
  index?: ResultsFiling[],
  session?: NseSession,
): Promise<IngestResult> {
  const s = session ?? (await NseSession.open());
  const all = index ?? (await fetchResultsIndex(s));

  const followed = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string; isin: string | null; symbol: string }>(
      'SELECT id, isin, symbol FROM companies',
    );
    return rows;
  });
  const byIsin = new Map(followed.filter((f) => f.isin).map((f) => [f.isin!, f.id]));
  const bySymbol = new Map(followed.map((f) => [f.symbol, f.id]));

  const mine = all.filter(
    (r) => (r.isin && byIsin.has(r.isin)) || bySymbol.has(r.symbol),
  );

  let parsed = 0;
  let stored = 0;
  let failed = 0;
  let disagreed = 0;

  for (const r of mine) {
    const companyId = (r.isin ? byIsin.get(r.isin) : undefined) ?? bySymbol.get(r.symbol);
    if (!companyId) continue;

    let raw: Buffer;
    try {
      raw = await s.bytes(r.xbrlUrl);
    } catch {
      failed++;
      continue;
    }

    let reports: Report[];
    try {
      reports = parse(raw).reports;
      parsed++;
    } catch (err) {
      if (!(err instanceof UnparseableXbrl)) throw err;
      failed++;
      continue;
    }

    const sha = createHash('sha256').update(raw).digest('hex');
    for (const report of reports) {
      if (report.contextDatesDisagree) disagreed++;
      const figures = canonicalFigures(report);
      const id = createHash('sha256')
        .update(`${companyId}|${report.basis}|${report.period.start}|${report.period.end}|${sha}`)
        .digest('hex')
        .slice(0, 32);

      await serviceTxn('system:ingest', async (c) => {
        // Any existing row for this period on this basis is superseded, not replaced. What was
        // believed at the time stays readable.
        await c.query(
          `UPDATE fundamentals SET superseded_by = $1
            WHERE company_id = $2 AND basis = $3 AND period_start = $4 AND period_end = $5
              AND superseded_by IS NULL AND id <> $1`,
          [id, companyId, report.basis, report.period.start, report.period.end],
        );
        await c.query(
          `INSERT INTO fundamentals (
             id, company_id, basis, period_start, period_end, period_kind, audited,
             revenue, other_income, total_income, cost_of_materials, purchases_stock_in_trade,
             changes_in_inventories, employee_cost, finance_costs, depreciation, other_expenses,
             total_expenses, profit_before_tax, tax_expense, profit_after_tax,
             comprehensive_income, eps_basic, eps_diluted,
             context_dates_disagreed, period_inferred, xbrl_url, xbrl_sha256, facts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,
                   $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
                   $25,$26,$27,$28,$29)
           ON CONFLICT (id) DO NOTHING`,
          [
            id, companyId, report.basis, report.period.start, report.period.end,
            report.period.kind, report.audited,
            figures['revenue'] ?? null, figures['other_income'] ?? null,
            figures['total_income'] ?? null, figures['cost_of_materials'] ?? null,
            figures['purchases_stock_in_trade'] ?? null, figures['changes_in_inventories'] ?? null,
            figures['employee_cost'] ?? null, figures['finance_costs'] ?? null,
            figures['depreciation'] ?? null, figures['other_expenses'] ?? null,
            figures['total_expenses'] ?? null, figures['profit_before_tax'] ?? null,
            figures['tax_expense'] ?? null, figures['profit_after_tax'] ?? null,
            figures['comprehensive_income'] ?? null, figures['eps_basic'] ?? null,
            figures['eps_diluted'] ?? null,
            report.contextDatesDisagree, report.periodInferred, r.xbrlUrl, sha,
            JSON.stringify(figures),
          ],
        );
      });
      stored++;
    }
  }

  return { candidates: mine.length, parsed, stored, failed, disagreed };
}

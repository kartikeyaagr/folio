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
import { NseError, NseSession } from './nse.ts';
import { fetchIntegratedFilings, type Board } from './integrated-filing.ts';
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

  // --- Non-Ind-AS aliases. Later entries win, and the two taxonomies are mutually exclusive: a
  // filing declares one or the other in the feed's `indAs` field, so no instance carries both.
  //
  // The SME board files under the older taxonomy, which renames most of the P&L. Measured on
  // AERON's FY24 annual instance (NONINDAS_112687_1250294): 108 facts, of which the Ind-AS names
  // above recognised almost none. Every SME name would have stored a row with a null profit.
  //
  // `ProfitLossForPeriodBeforeMinorityInterest` is deliberately NOT mapped. AERON reports it as
  // 1010.81 against a ProfitLossForThePeriod of 101,081,000 — the same figure in lakhs. Mapping it
  // would put a number 100,000x too small into a profit column, which is the dangerous direction.
  ProfitLossForThePeriod: 'profit_after_tax',
  DepreciationAndAmortisationExpense: 'depreciation',

  // --- Cash flow. Item 1 of the fund's forensic checklist is CFO/EBITDA conversion, and agent 7
  // reads `facts`. The statement is present in annual instances and was being thrown away, because
  // canonicalFigures keeps only what is named here. Absent from most quarterlies, which is fine:
  // absent means absent, and the checklist says so rather than guessing.
  CashFlowsFromUsedInOperatingActivities: 'cash_from_operations',
  CashFlowsFromUsedInInvestingActivities: 'cash_from_investing',
  CashFlowsFromUsedInFinancingActivities: 'cash_from_financing',
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

/**
 * Every element we understand, flattened. Absent means absent from the filing.
 *
 * **A P&L that is entirely zero is treated as absent, not as measured.** Some filers attach the
 * balance sheet to a duration context and write `0.00` into every profit-and-loss element rather
 * than omitting them. Measured on AERON's FY24 annual instance: the Oct-2023..Mar-2024 duration
 * carries revenue, every expense line, tax, PAT and both EPS figures all at exactly 0.00, while
 * the instant facts beside them — inventories, total assets, cash — are real and non-zero.
 *
 * Storing that verbatim puts "revenue ₹0.0 crore" on a company page as a fact somebody could act
 * on, and hands agent 7 a zero EBITDA to divide into. A dormant shell would reach the same branch,
 * and absent is the honest answer there too: the filing did not say.
 *
 * The balance sheet is kept either way — it is real, and it comes from a different context.
 */
export function canonicalFigures(report: Report): Record<string, string> {
  const out: Record<string, string> = {};

  const pnl: Record<string, string> = {};
  for (const [element, column] of Object.entries(CANONICAL)) {
    const v = numeric(report.facts[element]);
    if (v !== null) pnl[column] = v;
  }
  const values = Object.values(pnl);
  const allZero = values.length > 0 && values.every((v) => Number(v) === 0);
  if (!allZero) Object.assign(out, pnl);

  for (const [element, column] of Object.entries(BALANCE_SHEET)) {
    const v = numeric(report.instantFacts[element]);
    if (v !== null) out[column] = v;
  }
  return out;
}

export type { Board } from './integrated-filing.ts';

export interface ResultsFiling {
  symbol: string;
  isin: string | null;
  xbrlUrl: string;
  periodEnd: string | null;
}

/**
 * Every board and period the feed actually serves.
 *
 * Measured against the live endpoint 08-Sep-2026, one call per combination:
 *
 *   equities · Quarterly     3816 rows      sme · Quarterly      680 rows
 *   equities · Annual          29 rows      sme · Half-Yearly   3135 rows
 *   equities · Half-Yearly      0 rows      sme · Annual        1715 rows
 *
 * `equities · Half-Yearly` is absent by design, not by accident: LODR has mainboard companies file
 * quarterly, and half-yearly is the SME concession. It is not fetched, so its emptiness can never
 * be mistaken for a dead feed.
 *
 * **The spelling is `Half-Yearly`, hyphenated.** `Half Yearly` with a space returns zero rows at
 * HTTP 200 — no error, no warning. The trap is that the rows NSE sends back carry
 * `relatingTo: "Half Yearly"` *with the space*, so copying the spelling out of the response into
 * the query is the natural thing to do and yields nothing forever. This is L1's sixth instance
 * waiting to happen, which is why the pairs are a named constant rather than inline strings.
 */
/**
 * How far back to ask. Older than any Indian listed company's XBRL, so it is a floor rather than a
 * judgement about when anything started; the endpoints answer with what they hold.
 */
const EARLIEST = '2001-01-01';

const RESULT_FEEDS: ReadonlyArray<{ index: string; period: string }> = [
  { index: 'equities', period: 'Quarterly' },
  { index: 'equities', period: 'Annual' },
  { index: 'sme', period: 'Quarterly' },
  { index: 'sme', period: 'Half-Yearly' },
  { index: 'sme', period: 'Annual' },
];

/**
 * The results feed, filtered to instances that actually exist.
 *
 * Until 08-Sep-2026 this asked for `equities`/`Quarterly` alone, which is why AERON — an
 * `nse_emerge` half-yearly filer — could never have financial history at all, why `fundamentals`
 * held nothing longer than 274 days, and why agent 7, which fires on annual filings, had never
 * once had a subject to work on.
 */
export async function fetchResultsIndex(session?: NseSession): Promise<ResultsFiling[]> {
  const s = session ?? (await NseSession.open());
  const out: ResultsFiling[] = [];
  const seen = new Set<string>();

  for (const { index, period } of RESULT_FEEDS) {
    const rows = await s.rows<Record<string, unknown>>('corporates-financial-results', {
      index,
      period,
    });
    for (const r of rows) {
      const url = String(r['xbrl'] ?? '').trim();
      // NSE writes a bare "-" where there is no instance.
      if (!url.startsWith('http')) continue;
      // One instance can be served by more than one feed; the URL is the identity.
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        symbol: String(r['symbol'] ?? '').trim().toUpperCase(),
        // Null for the entire SME board, so downstream links by symbol. See filings.linked_by.
        isin: String(r['isin'] ?? '').trim() || null,
        xbrlUrl: url,
        // equities returns 01-Oct-2024, sme returns 01-APR-2024. Case differs by board.
        periodEnd: String(r['toDate'] ?? '').trim() || null,
      });
    }
  }

  // And the current regime. A month back is generous for a job that runs daily and cheap enough
  // that a few days of the box being off does not lose a quarter.
  //
  // Market-wide, which is what this function is for — but the cap makes that unreliable on its own
  // during a results season, when far more than twenty companies file in a day. `backfillDue()`
  // below is the reliable half: it asks per symbol for the names actually followed, where the cap
  // is never close. This is the cheap sweep, and it is not the only one.
  const to = new Date();
  const from = new Date(to.getTime() - 35 * 86_400_000);
  for (const board of ['equities', 'sme'] as Board[]) {
    for (const r of await fetchIntegratedFilings(
      board,
      { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      s,
    )) {
      if (seen.has(r.xbrlUrl)) continue;
      seen.add(r.xbrlUrl);
      out.push(r);
    }
  }
  return out;
}

/**
 * How many rows the endpoint will return for one question, measured 09-Sep-2026.
 *
 * PRAJIND over 2015-2026 answers 20; over 2024-2026 it answers 20; over 2025 alone it answers 10
 * and over 2026 alone 12 — the same eighteen filings, and the wide questions were both truncated
 * to the same number. There is no page parameter and no total in the response, so a full answer
 * and a clipped one look identical.
 */
/**
 * One company's whole results history.
 *
 * The feed above, asked without a symbol, serves **only the most recent period**: 3,816 rows on
 * 09-Sep-2026 and every one of them dated 31-Dec-2024. So the daily sweep can only ever add the
 * quarter just filed, and a company followed today gets exactly one — which is why PRAJIND, a
 * mainboard filer since 2005, had a single quarter of P&L behind a screen built to show a trend.
 *
 * Adding `symbol` changes what the endpoint means: PRAJIND answers with 130 quarterly rows going
 * back to 31-Mar-2005. Measured 09-Sep-2026. That is the same shape as the announcements and
 * corporate-actions endpoints, and the same reason `backfill-company.ts` asks all three by name.
 */
export async function fetchResultsForSymbol(
  symbol: string,
  board: Board,
  session?: NseSession,
): Promise<ResultsFiling[]> {
  const s = session ?? (await NseSession.open());
  const out: ResultsFiling[] = [];
  const seen = new Set<string>();

  // **Both sources, whole range, take whatever is there.** The old feed holds a company's history
  // up to the changeover and the integrated one holds it since, but which side a given filing
  // falls on is the exchange's business and not something this file should claim to know. Asking
  // both and merging on the instance URL means a regime that moves again, or a board that moved on
  // a different date, costs nothing — where a boundary date would lose a quarter and say nothing.
  for (const r of await fetchIntegratedFilings(
    board,
    { from: EARLIEST, to: new Date().toISOString().slice(0, 10), symbol },
    s,
  )) {
    if (!seen.has(r.xbrlUrl)) {
      seen.add(r.xbrlUrl);
      out.push(r);
    }
  }

  for (const { index, period } of RESULT_FEEDS) {
    if (index !== board) continue;
    const rows = await s.rows<Record<string, unknown>>('corporates-financial-results', {
      index,
      period,
      symbol: symbol.trim().toUpperCase(),
    });
    for (const r of rows) {
      const url = String(r['xbrl'] ?? '').trim();
      if (!url.startsWith('http')) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        symbol: String(r['symbol'] ?? '').trim().toUpperCase(),
        isin: String(r['isin'] ?? '').trim() || null,
        xbrlUrl: url,
        periodEnd: String(r['toDate'] ?? '').trim() || null,
      });
    }
  }
  return out;
}

export interface IngestResult {
  /** Rows the feed served, before filtering to followed names. Zero here is a dead feed. */
  indexRows: number;
  candidates: number;
  parsed: number;
  stored: number;
  /**
   * An instance the index promised and no reading of it can produce: the archive answers 4xx, or
   * the bytes arrive and this parser refuses them.
   *
   * Apart from `failed` because the two want opposite responses and were one number until
   * 17-Sep-2026. Both halves of this are the document, permanently — a 404 is the archive's answer
   * and a malformed XBRL will be malformed tomorrow — so an on-add backfill that held a company in
   * its queue over either would never release it. PRAJIND has two of the first and TCL two of the
   * second. `failed` is a fetch that did not answer at all, which is this run and worth another go.
   */
  unreadable: number;
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
  let unreadable = 0;
  let failed = 0;
  let disagreed = 0;

  for (const r of mine) {
    const companyId = (r.isin ? byIsin.get(r.isin) : undefined) ?? bySymbol.get(r.symbol);
    if (!companyId) continue;

    let raw: Buffer;
    try {
      raw = await s.bytes(r.xbrlUrl);
    } catch (err) {
      // 4xx is the archive saying it does not have this instance, whatever the index claims.
      // Anything else — a refused connection, a timeout, a truncated body — is this run.
      if (err instanceof NseError && (err.status ?? 0) >= 400 && (err.status ?? 0) < 500) unreadable++;
      else failed++;
      continue;
    }

    let reports: Report[];
    try {
      reports = parse(raw).reports;
      parsed++;
    } catch (err) {
      if (!(err instanceof UnparseableXbrl)) throw err;
      unreadable++;
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

  return { indexRows: all.length, candidates: mine.length, parsed, stored, unreadable, failed, disagreed };
}

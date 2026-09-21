/**
 * Quarterly shareholding: who owns the company, and how much of the promoter's stake is tied up.
 *
 * Two sources, and the split matters. NSE's `corporate-share-holdings-master` is an index of
 * *recent submissions* — it says who filed, for which quarter, and where the XBRL is. It also
 * carries promoter and public percentages, and nothing else. The institutional split and every
 * encumbrance figure exist only inside the XBRL, which is 150–500 KB per company, so it is fetched
 * for followed names only.
 *
 * Three things about this feed were measured on 07-Sep-2026 and none are guessable:
 *
 *   1. **The encumbrance percentage is of the promoter's holding, not of the company**, despite the
 *      element being named `...AsPercentageOfTotalNumberOfShares`. ZEEL's promoter holds 3.99% of
 *      the company and the pledge element reads 5.38%. You cannot pledge more than you own; it is
 *      5.38% *of the stake*. That is also how the market quotes a pledge.
 *   2. **Absent is not zero.** Encumbrance elements are simply not written when the corresponding
 *      `Whether...Encumbered...` flag is false. The flag is what distinguishes "none" from "not
 *      disclosed", so the flag is read first and the number second.
 *   3. **Pledge is not all encumbrance.** Vedanta's June 2026 filing pledges nothing and has 99.99%
 *      of the promoter holding encumbered through non-disposal undertakings and other means.
 *      Reading only the pledge element would call that promoter unencumbered.
 *
 * Linking is by symbol. The master feed reports PRAJIND's ISIN as INE074A01017 while the company's
 * own XBRL says INE074A01025 — the feed carries a stale identifier, so an ISIN join drops the name.
 */

import { createHash } from 'node:crypto';
import { rowId, serviceTxn } from '../db.ts';
import { readFacts, type Facts } from './facts.ts';
import { NseSession } from './nse.ts';
import { nseDate } from './dates.ts';

/** XBRL contexts, one per shareholder category. These names are the taxonomy's, not ours. */
const PROMOTER = 'ShareholdingOfPromoterAndPromoterGroup_ContextI';
const PUBLIC = 'PublicShareholding_ContextI';
const FOREIGN = 'InstitutionsForeign_ContextI';
const DOMESTIC = 'InstitutionsDomestic_ContextI';

export interface Submission {
  symbol: string;
  asOf: string;
  xbrlUrl: string;
}

/**
 * One quarter's pattern, in two different denominators.
 *
 * `promoterPct`, `publicPct`, `fiiPct` and `diiPct` are percentages of the company. `pledgePct`
 * and `encumberedPct` are percentages of the *promoter's holding* — ZEEL's promoter owns 3.99% of
 * the company and the pledge element reads 5.38% — so the six do not share a base, and the last
 * two can be neither added to nor compared against the first four. The header above holds the
 * measurement.
 *
 * Zero and null say different things here. Zero is the filing's own flag declaring nothing
 * encumbered; null is a company that has encumbered something and did not break the promoter line
 * down, which is a prompt to go and read the filing. And `pledgePct` is not all of
 * `encumberedPct`: Vedanta's June 2026 filing pledges nothing and has 99.99% of the promoter stake
 * encumbered by other means.
 */
export interface Shareholding {
  asOf: string;
  promoterPct: number | null;
  publicPct: number | null;
  fiiPct: number | null;
  diiPct: number | null;
  pledgePct: number | null;
  encumberedPct: number | null;
}

/** The index writes DD-MMM-YYYY, in caps. */
export function shpDate(value: unknown): string | null {
  return nseDate(value);
}

export function parseIndex(rows: Record<string, unknown>[]): Submission[] {
  const out: Submission[] = [];
  for (const r of rows) {
    const symbol = String(r['symbol'] ?? '').trim().toUpperCase();
    const asOf = shpDate(r['date']);
    const xbrlUrl = String(r['xbrl'] ?? '').trim();
    if (!symbol || !asOf || !xbrlUrl) continue;
    out.push({ symbol, asOf, xbrlUrl });
  }
  return out;
}

/** Both boards. A company appears when it files, so one run's coverage is partial by design. */
export async function fetchIndex(session?: NseSession): Promise<Submission[]> {
  const s = session ?? (await NseSession.open());
  const rows = [
    ...(await s.rows<Record<string, unknown>>('corporate-share-holdings-master', { index: 'equities' })),
    ...(await s.rows<Record<string, unknown>>('corporate-share-holdings-master', { index: 'sme' })),
  ];
  return parseIndex(rows);
}

/** Percentages are written as fractions: 0.3281 is 32.81%. */
function pct(f: Facts, name: string, context: string): number | null {
  const v = f.get(name, context);
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1_000_000) / 10_000 : null;
}

const flag = (f: Facts, name: string): boolean | null => {
  const v = f.get(name, 'MainI');
  return v === null ? null : v.toLowerCase() === 'true';
};

export interface Holder {
  name: string;
  category: 'promoter' | 'mutual_fund' | 'fpi' | 'insurance' | 'other';
  shares: number | null;
  pct: number | null;
}

/**
 * Which part of the pattern a context belongs to.
 *
 * Read from the context name, never from the shareholder's own name: a fund called
 * "… Individual …" is still a fund, and a person whose name contains "Trust" is still a person.
 */
function categoryOf(context: string, isPromoter: boolean): Holder['category'] {
  if (isPromoter) return 'promoter';
  if (context.includes('MutualFundsOrUTI')) return 'mutual_fund';
  if (context.includes('ForeignPortfolioInvestor')) return 'fpi';
  if (context.includes('InsuranceCompanies')) return 'insurance';
  return 'other';
}

/**
 * Every shareholder the filing names.
 *
 * LODR Reg 31 requires each holder above 1% to be named and promoters to be named individually, so
 * this is the first-party source for something usually taken from a screener — which parses this
 * same file. Eleven names in PRAJIND's June quarter.
 *
 * The names sit in a `D_<Category>_ContextN` and the numbers in the `<Category>_ContextN` beside
 * it: two contexts per holder, paired by everything after the prefix. Measured 08-Sep-2026 —
 * nothing in the taxonomy says so, and reading the name context alone gets you eleven people and
 * no holdings.
 *
 * A promoter is identified by `TypeOfPromoterShareholding` being present in the name context,
 * because `IndividualsOrHUF` is also where large public individuals appear.
 */
export function parseHolders(xml: string): Holder[] {
  const out: Holder[] = [];
  const f = readFacts(xml);

  for (const context of f.contexts('NameOfTheShareholder')) {
    if (!context.startsWith('D_')) continue;
    const name = (f.get('NameOfTheShareholder', context) ?? '').trim();
    if (!name) continue;

    const paired = context.slice(2);
    const isPromoter = f.has('TypeOfPromoterShareholding', context);

    const shares = f.get('NumberOfShares', paired);
    out.push({
      name,
      category: categoryOf(paired, isPromoter),
      shares: shares !== null && Number.isFinite(Number(shares)) ? Number(shares) : null,
      // The same helper the totals use, so the fraction-to-percentage conversion lives in one place
      // rather than being repeated with a chance of being repeated differently.
      pct: pct(f, 'ShareholdingAsAPercentageOfTotalNumberOfShares', paired),
    });
  }

  // Largest first. A holder list read top-down should start with whoever matters most, and the
  // filing's own order is by category rather than by size.
  return out.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
}

/**
 * Read one filing.
 *
 * An encumbrance the company says it does not have is 0, not unknown. An encumbrance it says it
 * has but does not break down for the promoter line is unknown, and is stored as such: a null on a
 * company that has pledged something is a prompt to go and read the filing, and a fabricated zero
 * is not.
 */
export function parseShareholding(xml: string): Shareholding | null {
  const f = readFacts(xml);
  const asOf = f.get('DateOfReport', 'MainI') ?? f.get('DateOfReport', 'MainD');
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return null;

  const anyPledge = flag(f, 'WhetherAnySharesHeldByPromotersAreEncumberedUnderPledged');
  const anyEncumbrance =
    anyPledge === true ||
    flag(f, 'WhetherAnySharesHeldByPromotersAreEncumberedUnderNonDisposalUndertaking') === true ||
    flag(f, 'WhetherAnySharesHeldByPromotersAreEncumberedOtherThanByWayOfPledgeOrNDU') === true;

  const read = (declared: boolean, name: string): number | null =>
    declared ? pct(f, name, PROMOTER) : 0;

  return {
    asOf,
    promoterPct: pct(f, 'ShareholdingAsAPercentageOfTotalNumberOfShares', PROMOTER),
    publicPct: pct(f, 'ShareholdingAsAPercentageOfTotalNumberOfShares', PUBLIC),
    fiiPct: pct(f, 'ShareholdingAsAPercentageOfTotalNumberOfShares', FOREIGN),
    diiPct: pct(f, 'ShareholdingAsAPercentageOfTotalNumberOfShares', DOMESTIC),
    pledgePct: read(anyPledge === true, 'EncumberedShareUnderPledgedAsPercentageOfTotalNumberOfShares'),
    encumberedPct: read(anyEncumbrance, 'EncumberedSharesHeldAsPercentageOfTotalNumberOfShares'),
  };
}

const patternId = (companyId: string, asOf: string): string =>
  createHash('sha256').update(`shp:${companyId}:${asOf}`).digest('hex').slice(0, 32);

export async function storeShareholding(companyId: string, s: Shareholding): Promise<void> {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO shareholding_patterns
         (id, company_id, as_of, promoter_pct, promoter_pledge_pct, promoter_encumbered_pct,
          public_pct, fii_pct, dii_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (company_id, as_of) DO UPDATE SET
         promoter_pct = EXCLUDED.promoter_pct,
         promoter_pledge_pct = EXCLUDED.promoter_pledge_pct,
         promoter_encumbered_pct = EXCLUDED.promoter_encumbered_pct,
         public_pct = EXCLUDED.public_pct,
         fii_pct = EXCLUDED.fii_pct,
         dii_pct = EXCLUDED.dii_pct,
         fetched_at = now()`,
      [
        patternId(companyId, s.asOf), companyId, s.asOf, s.promoterPct, s.pledgePct,
        s.encumberedPct, s.publicPct, s.fiiPct, s.diiPct,
      ],
    );
  });
}

export interface ShareholdingResult {
  /** Named holders stored. Zero on a filing that names nobody is possible and not a failure. */
  named: number;
  /**
   * Rows in NSE's exchange-wide submissions index, which is not a fact about any one company.
   *
   * It cannot be zero while the exchange is up, so a caller that reads it as "did this work" has
   * written a step that cannot fail. The backfill's shareholding step did exactly that until
   * 17-Sep-2026 and marked AERON and TCL complete with no row in `shareholding_patterns` between
   * them. Zero here is a dead feed; what this name actually got is `stored` and `named`.
   */
  submissions: number;
  ours: number;
  stored: number;
  /** Filings that could not be read. Counted rather than thrown, and never silently zero. */
  failed: number;
}

/**
 * Replace the named holders for one quarter.
 *
 * Deleted and re-inserted rather than upserted: a holder who fell below 1% since the last filing
 * is absent from the new one, and an upsert would leave them standing as though they were still
 * there. The set is the fact, not each row.
 */
export async function storeHolders(companyId: string, asOf: string, holders: Holder[]): Promise<number> {
  if (holders.length === 0) return 0;
  return serviceTxn('system:ingest', async (c) => {
    await c.query('DELETE FROM shareholders WHERE company_id = $1 AND as_of = $2', [companyId, asOf]);
    for (const h of holders) {
      await c.query(
        `INSERT INTO shareholders (id, company_id, as_of, name, category, shares, pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (company_id, as_of, name) DO UPDATE
            SET category = EXCLUDED.category, shares = EXCLUDED.shares, pct = EXCLUDED.pct`,
        [rowId(), companyId, asOf, h.name, h.category, h.shares, h.pct],
      );
    }
    return holders.length;
  });
}

/** Fetch the index, then one XBRL per followed name that filed. */
export async function ingestShareholding(): Promise<ShareholdingResult> {
  const session = await NseSession.open();
  const index = await fetchIndex(session);

  const companies = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string; symbol: string }>('SELECT id, symbol FROM companies');
    return rows;
  });
  const bySymbol = new Map(companies.map((c) => [c.symbol, c.id]));

  const mine = index.filter((s) => bySymbol.has(s.symbol));
  let stored = 0;
  let named = 0;
  let failed = 0;
  for (const sub of mine) {
    // One unreadable filing costs that filing, not the rest of the run. It is counted rather than
    // swallowed: the caller fails the run on a non-zero count, so a corrupt download is loud
    // without letting every company after it in the index go unfetched.
    try {
      const xml = await session.text(sub.xbrlUrl);
      const parsed = parseShareholding(xml);
      if (!parsed) continue;
      const companyId = bySymbol.get(sub.symbol)!;
      await storeShareholding(companyId, parsed);
      // The names in the same pass, from the same bytes. Fetching this file twice to read two
      // halves of it would be two chances for them to disagree about which quarter they describe.
      named += await storeHolders(companyId, parsed.asOf, parseHolders(xml));
      stored++;
    } catch (err) {
      failed++;
      console.error(`${sub.symbol} ${sub.asOf}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { submissions: index.length, ours: mine.length, stored, named, failed };
}

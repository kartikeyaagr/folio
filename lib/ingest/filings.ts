/**
 * Exchange announcements.
 *
 * For the SME names in this book the filings *are* the news — press barely covers them — which is
 * why this is the spine of "what changed since yesterday" rather than a supplement to it. v2
 * ingested this feed every two hours for four days and never built a screen for it; that is the
 * single largest gap between what it collected and what anyone could see.
 *
 * Two calls, not one: NSE serves mainboard and Emerge from the same endpoint under different
 * `index` values, and a book of small caps that fetched only `equities` would miss most of itself.
 *
 * Keyed on NSE's `seq_id`, which is stable. Re-ingesting an overlapping window is an upsert on the
 * primary key, so the job can run every two hours without tracking what it saw last time.
 *
 * Two things measured against the live feed on 06-Sep-2026:
 *
 *   * **SME announcements carry no ISIN.** `sm_isin` is null on every Emerge row, so the
 *     join-on-the-instrument rule that prices follow is simply unavailable on the board this book
 *     mostly lives on. Symbol is the only key there, and `linked_by` records which was used so a
 *     weaker match is visible rather than silent.
 *   * **`hasXbrl` is set on everything**, including a "Copy of Newspaper Publication". It is
 *     stored because it is what the feed said, and it is not used to find results filings —
 *     those come from the corporates-financial-results endpoint, which returns the instance URL.
 */

import { NseSession } from './nse.ts';
import { serviceTxn, type Client } from '../db.ts';

export type Board = 'nse_equities' | 'nse_sme';

export interface Filing {
  id: string;
  symbol: string;
  isin: string | null;
  companyName: string | null;
  category: string | null;
  summary: string | null;
  attachmentUrl: string | null;
  hasXbrl: boolean;
  announcedAt: Date;
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** NSE writes announcement timestamps as `DD-MMM-YYYY HH:MM:SS`. */
function asTimestamp(value: string): Date | null {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const months = 'janfebmaraprmayjunjulaugsepoctnovdec';
  const mon = months.indexOf(m[2]!.toLowerCase()) / 3;
  if (!Number.isInteger(mon) || mon < 0) return null;
  // NSE publishes in IST and says so nowhere, so the offset is applied here rather than assumed
  // by whatever timezone the box happens to run in.
  return new Date(
    `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`,
  );
}

const ddmmyyyy = (d: Date): string =>
  `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;

/**
 * Rows without a `seq_id` are dropped, because it is the primary key and there is nothing else
 * stable to store them under.
 *
 * Measured on PRAJIND's full history 08-Sep-2026: 1,031 rows served, 186 without a `seq_id`, and
 * **every one of those 186 is dated 2004-2013** — NSE did not assign the field before about 2013.
 * All 845 that have one are distinct, and every date parses. Of the dropped rows only 24 carry an
 * attachment, all `.zip`. So the loss is a decade-old tail rather than a parser fault, but the
 * caller is told the number rather than left to infer it from a total that looks complete.
 */
export function parseAnnouncements(board: Board, rows: Record<string, unknown>[]): Filing[] {
  const out: Filing[] = [];
  for (const r of rows) {
    const uid = clean(r['seq_id']);
    const announcedAt = asTimestamp(clean(r['an_dt']));
    if (!uid || !announcedAt) continue;
    out.push({
      id: `${board}:${uid}`,
      symbol: clean(r['symbol']).toUpperCase(),
      isin: clean(r['sm_isin']) || null,
      companyName: clean(r['sm_name']) || null,
      category: clean(r['desc']) || null,
      // The announcement text runs long and is stored rather than re-fetched.
      summary: clean(r['attchmntText']).slice(0, 4000) || null,
      // A bare "-" is how NSE says "no attachment". Stored as null rather than as a hyphen: the
      // column means a URL, and a reader who sees a value should be able to follow it.
      attachmentUrl: clean(r['attchmntFile']).startsWith('http') ? clean(r['attchmntFile']) : null,
      hasXbrl: ['true', 'yes', '1'].includes(String(r['hasXbrl']).toLowerCase()),
      announcedAt,
    });
  }
  return out;
}

export async function fetchAnnouncements(days = 14, session?: NseSession): Promise<Filing[]> {
  const s = session ?? (await NseSession.open());
  const until = new Date();
  const since = new Date(Date.now() - days * 86_400_000);
  const window = { from_date: ddmmyyyy(since), to_date: ddmmyyyy(until) };

  const out: Filing[] = [];
  for (const [board, index] of [
    ['nse_equities', 'equities'],
    ['nse_sme', 'sme'],
  ] as const) {
    const rows = await s.rows('corporate-announcements', { index, ...window });
    out.push(...parseAnnouncements(board, rows));
  }
  return out;
}

/**
 * Every announcement one company has ever filed.
 *
 * The endpoint takes a `symbol` and, given one, serves the company's whole history rather than the
 * date window `fetchAnnouncements` is bounded by. Measured 08-Sep-2026: `symbol=PRAJIND` returns
 * 1,031 rows and `symbol=AERON` 135, each entirely that company. A 30-day window 36 months back
 * still answers with 13,376 rows, so the archive genuinely goes back years.
 *
 * **This is the opposite of `corporates-pit`**, where a symbol with no window is capped at 20 rows
 * and only a symbol *with* a wide window returns everything. Same exchange, same shape of query,
 * contradictory behaviour — which is why both are measured and written down rather than assumed
 * from one another.
 *
 * Without this a followed name arrives holding only whatever the rolling window happened to catch:
 * two names, two weeks, seven filings between them. Transcripts and investor presentations are
 * filed as announcements, so the document corpus is bounded by exactly this call.
 */
export async function fetchAnnouncementsForSymbol(
  symbol: string,
  board: Board,
  session?: NseSession,
): Promise<{ filings: Filing[]; served: number; skipped: number }> {
  const s = session ?? (await NseSession.open());
  const index = board === 'nse_sme' ? 'sme' : 'equities';
  const rows = await s.rows('corporate-announcements', { index, symbol: symbol.toUpperCase() });
  const filings = parseAnnouncements(board, rows);
  // Reported, not swallowed: 18% of PRAJIND's history has no seq_id and a caller that only saw
  // the parsed count would read a complete-looking number and never know.
  return { filings, served: rows.length, skipped: rows.length - filings.length };
}

export interface StoreResult {
  seen: number;
  stored: number;
  ours: number;
}

/**
 * Store every announcement, linking the ones that belong to a followed name.
 *
 * All of them are kept rather than only ours: a company added next month should arrive with its
 * filing history already present, and the volume is a few hundred a day.
 */
export async function storeFilings(filings: Filing[]): Promise<StoreResult> {
  return serviceTxn('system:ingest', async (c) => {
    // Resolved once rather than per row. ISIN is the instrument and wins; symbol is the fallback
    // the SME board forces, and which key was used is stored on the row.
    const { rows: cos } = await c.query<{ id: string; isin: string | null; symbol: string }>(
      'SELECT id, isin, symbol FROM companies',
    );
    const byIsin = new Map(cos.filter((x) => x.isin).map((x) => [x.isin!, x.id]));
    const bySymbol = new Map(cos.map((x) => [x.symbol, x.id]));

    let stored = 0;
    let ours = 0;
    for (const f of filings) {
      const isinHit = f.isin ? byIsin.get(f.isin) : undefined;
      const symbolHit = isinHit ? undefined : bySymbol.get(f.symbol);
      const companyId = isinHit ?? symbolHit ?? null;
      const linkedBy = isinHit ? 'isin' : symbolHit ? 'symbol' : null;
      const { rows } = await c.query<{ company_id: string | null }>(
        `INSERT INTO filings (id, company_id, symbol, isin, category, summary,
                              attachment_url, has_xbrl, announced_at, linked_by)
         VALUES ($1, $9, $3, $2, $4, $5, $6, $7, $8, $10)
         ON CONFLICT (id) DO UPDATE
            SET company_id = COALESCE(EXCLUDED.company_id, filings.company_id),
                linked_by = COALESCE(EXCLUDED.linked_by, filings.linked_by),
                category = EXCLUDED.category,
                summary = EXCLUDED.summary,
                attachment_url = EXCLUDED.attachment_url,
                has_xbrl = EXCLUDED.has_xbrl
         RETURNING company_id`,
        [
          f.id,
          f.isin,
          f.symbol,
          f.category,
          f.summary,
          f.attachmentUrl,
          f.hasXbrl,
          f.announcedAt,
          companyId,
          linkedBy,
        ],
      );
      stored++;
      if (rows[0]?.company_id) ours++;
    }
    return { seen: filings.length, stored, ours };
  });
}

/**
 * The linking itself, against a caller's client.
 *
 * Takes a `Client` so `addCompany` can link inside the transaction that creates the company,
 * attributed to the person who added it, rather than opening a second one underneath.
 */
export async function linkFilingsIn(c: Client, companyId: string): Promise<number> {
  const { rowCount } = await c.query(
    `UPDATE filings f
        SET company_id = c.id,
            linked_by  = CASE WHEN f.isin IS NOT NULL AND f.isin = c.isin THEN 'isin' ELSE 'symbol' END
       FROM companies c
      WHERE c.id = $1
        AND f.company_id IS NULL
        AND ((f.isin IS NOT NULL AND f.isin = c.isin) OR (f.isin IS NULL AND f.symbol = c.symbol))`,
    [companyId],
  );
  return rowCount ?? 0;
}

/**
 * Attach filings that arrived before their company was followed.
 *
 * Adding a name should bring its history with it, and the announcement rows are already stored
 * with an ISIN.
 */
export async function linkFilingsForCompany(companyId: string): Promise<number> {
  return serviceTxn('system:ingest', (c) => linkFilingsIn(c, companyId));
}

/**
 * Link every unlinked filing that belongs to a followed name.
 *
 * This ran nowhere until 08-Sep-2026, and the cost was exact: `filings` held 11,053 rows of which
 * **7** carried a `company_id`. `storeFilings`' ON CONFLICT can only attach a link to a row the
 * feed happens to re-serve, so a filing that arrived before its company was followed stayed
 * orphaned for good — and everything downstream reads through `company_id`. The filings screen,
 * the alert evaluator's haystack, agent 3's sources and the attachment download all saw almost
 * nothing.
 *
 * Asks "what has no link yet" — `company_id IS NULL` — rather than "what arrived since I last
 * looked", so it is idempotent, self-healing, and cannot lose a row to a window. Cheap enough to
 * run on every announcement ingest: the predicate is indexed and the working set is one UPDATE.
 */
export async function linkAllFollowed(): Promise<number> {
  return serviceTxn('system:ingest', async (c) => {
    const { rowCount } = await c.query(
      `UPDATE filings f
          SET company_id = c.id,
              linked_by  = CASE WHEN f.isin IS NOT NULL AND f.isin = c.isin THEN 'isin' ELSE 'symbol' END
         FROM companies c
        WHERE f.company_id IS NULL
          AND ((f.isin IS NOT NULL AND f.isin = c.isin) OR (f.isin IS NULL AND f.symbol = c.symbol))`,
    );
    return rowCount ?? 0;
  });
}

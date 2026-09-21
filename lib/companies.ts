/**
 * The fund's list of names.
 *
 * Adding a company is the one place the exchange master and the fund's own list meet: you type a
 * symbol, `securities` answers with the ISIN and the registered name, and a `companies` row is
 * created from that rather than from what you typed. A name entered by hand drifts from the
 * exchange's, and every later match on that name drifts with it.
 */

import { readTxn, rowId, type Client, writeTxn } from './db.ts';
import { announce } from './ingest/backfill.ts';
import { linkFilingsIn } from './ingest/filings.ts';

export const STATUSES = ['watching', 'working', 'holding', 'exited', 'passed'] as const;
export type Status = (typeof STATUSES)[number];

/** Closed statuses must state why. Mirrors the CHECK constraint so the error arrives early. */
const CLOSED: ReadonlySet<Status> = new Set<Status>(['exited', 'passed']);

export class UnknownSymbol extends Error {}
export class AlreadyFollowed extends Error {}
export class ReasonRequired extends Error {}
export class UnknownSector extends Error {}

export interface Company {
  id: string;
  symbol: string;
  isin: string | null;
  name: string;
  status: Status;
  closedReason: string | null;
  coveredBy: string | null;
  coveredByName: string | null;
}

const SELECT_COMPANY = `
  SELECT c.id, c.symbol, c.isin, c.name, c.status, c.closed_reason, c.covered_by, u.name AS covered_name
    FROM companies c
    LEFT JOIN users u ON u.id = c.covered_by`;

interface Row {
  id: string;
  symbol: string;
  isin: string | null;
  name: string;
  status: Status;
  closed_reason: string | null;
  covered_by: string | null;
  covered_name: string | null;
}

const toCompany = (r: Row): Company => ({
  id: r.id,
  symbol: r.symbol,
  isin: r.isin,
  name: r.name,
  status: r.status,
  closedReason: r.closed_reason,
  coveredBy: r.covered_by,
  coveredByName: r.covered_name,
});

export interface SecurityHit {
  symbol: string;
  name: string;
  /** `mainboard` or `nse_emerge`. Which board a name is on changes what arrives for it. */
  platform: string;
  followed: boolean;
}

/**
 * Names to follow, out of the exchange's security master.
 *
 * The other direction from `searchCompanies`, which is for reaching a name the fund already has.
 * This one exists to find one it does not.
 *
 * **Already-followed names are returned, flagged, not filtered out.** Someone who types a symbol
 * and sees an empty list concludes it does not exist; the true answer is that it exists and is
 * already on the list, and that is a different thing to be told.
 */
export async function searchSecurities(query: string): Promise<SecurityHit[]> {
  const q = query.trim().slice(0, 60);
  if (q.length < 1) return [];
  return readTxn(async (c: Client) => {
    const { rows } = await c.query<SecurityHit>(
      `SELECT s.symbol, s.name, s.platform, (co.id IS NOT NULL) AS followed
         FROM securities s
         LEFT JOIN companies co ON co.symbol = s.symbol
        WHERE s.delisted_at IS NULL
          AND (s.symbol ILIKE $1 OR s.name ILIKE $1)
        ORDER BY (s.symbol ILIKE $2) DESC, length(s.symbol), s.symbol
        LIMIT 8`,
      [`%${q}%`, `${q}%`],
    );
    return rows;
  });
}

/**
 * Follow a name.
 *
 * Identity comes from `securities`, never from the caller: the symbol is the only thing typed,
 * and the ISIN and registered name are read from the exchange's own list. A symbol that is not
 * listed is a typo far more often than it is a gap in the master, so it raises.
 *
 * One transaction covers all four writes — the row, its registered-name alias, its filings, and
 * the doorbell — so there is no state where a followed company exists without the history that
 * makes following it useful.
 */
export async function addCompany(symbol: string, actorId: string): Promise<Company> {
  const upper = symbol.trim().toUpperCase();
  return writeTxn(actorId, async (c: Client) => {
    const { rows: sec } = await c.query<{ symbol: string; isin: string | null; name: string }>(
      'SELECT symbol, isin, name FROM securities WHERE symbol = $1 AND delisted_at IS NULL',
      [upper],
    );
    const s = sec[0];
    if (!s) {
      throw new UnknownSymbol(
        `${upper} is not in the security master. Check the symbol, or refresh the master.`,
      );
    }

    const { rows: existing } = await c.query('SELECT 1 FROM companies WHERE symbol = $1', [upper]);
    if (existing.length > 0) throw new AlreadyFollowed(`${upper} is already followed`);

    const id = rowId();
    // `added_by` is recorded here and nowhere else: it is who the finished-backfill notice goes to,
    // and by the time the job runs, minutes later, there is nobody in the request to ask.
    // `backfilled_at` stays null, which is what puts the name in the backfill queue.
    await c.query(
      'INSERT INTO companies (id, symbol, isin, name, status, added_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, s.symbol, s.isin, s.name, 'watching', actorId],
    );
    // The registered name is an alias too, so the news matcher has it without a special case.
    await c.query(
      "INSERT INTO company_aliases (company_id, alias, kind) VALUES ($1, $2, 'name')",
      [id, s.name],
    );

    // Adding a name brings its filings with it. In the same transaction, so a company that exists
    // is a company whose history is attached — attributed to the person who added it, because they
    // are what caused the write.
    await linkFilingsIn(c, id);

    // The row is the queue entry; this is only the doorbell. `jobs/backfill-company.ts --watch`
    // starts the fetch in under a second instead of at the next ten-minute tick, and if nothing is
    // listening the notification is discarded and the timer picks the name up exactly as before —
    // which is the whole reason the queue is a column and not a message.
    await announce(c, s.symbol);

    const { rows } = await c.query<Row>(`${SELECT_COMPANY} WHERE c.id = $1`, [id]);
    return toCompany(rows[0]!);
  });
}

/**
 * Move a name to a new status.
 *
 * Closing one requires a reason. The database enforces it as well, but raising here means the
 * caller gets a sentence rather than a constraint name.
 */
export async function setStatus(
  companyId: string,
  status: Status,
  reason: string | null,
  actorId: string,
): Promise<void> {
  const closing = CLOSED.has(status);
  if (closing && !reason?.trim()) {
    throw new ReasonRequired(
      `Moving a name to ${status} needs a reason. A graveyard without reasons teaches nothing.`,
    );
  }
  await writeTxn(actorId, async (c) => {
    await c.query(
      `UPDATE companies
          SET status = $1,
              closed_reason = $2,
              closed_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
        WHERE id = $4`,
      [status, closing ? reason!.trim() : null, closing, companyId],
    );
  });
}

/**
 * The sectors that have vocabulary behind them.
 *
 * Offered instead of a free-text box, because a sector is only worth setting if the news matcher
 * can do something with it. `lib/news/match.ts` reaches the sector tier, checks `co.sector`, and
 * then looks for one of that sector's terms — so a company tagged with a sector nobody has written
 * terms for is in exactly the state it was in before it was tagged, while looking answered.
 *
 * The count comes with it so the screen can say how many terms are behind each one. A sector with
 * five terms and one with ten are different promises and should not look identical.
 */
export async function sectorsWithTerms(): Promise<{ sector: string; terms: number }[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ sector: string; terms: string }>(
      'SELECT sector, count(*)::text AS terms FROM sector_terms GROUP BY sector ORDER BY sector',
    );
    return rows.map((r) => ({ sector: r.sector, terms: Number(r.terms) }));
  });
}

/**
 * Which sector a name belongs to, in the fund's own vocabulary.
 *
 * The security master does not carry one — NSE's file has symbol, ISIN, name, series, listing date
 * and face value, and nothing about what the business does — so this is a judgement and there was
 * no way to record it. `addCompany` never set the column and nothing else updated it, so every
 * name added through the picker was excluded from the sector tier permanently, and the Companies
 * table rendered that honestly as a Blank that could never be filled.
 *
 * Null is a real answer: a holding company or a conglomerate belongs to no one sector, and saying
 * so is better than filing it under the nearest.
 */
export async function setSector(
  companyId: string,
  sector: string | null,
  actorId: string,
): Promise<void> {
  const clean = sector?.trim() || null;
  if (clean !== null) {
    const known = await readTxn(async (c) => {
      const { rows } = await c.query('SELECT 1 FROM sector_terms WHERE sector = $1 LIMIT 1', [clean]);
      return rows.length > 0;
    });
    // Refused rather than stored. A sector with no terms matches nothing, so accepting it would
    // record an answer that behaves exactly like the blank it replaced.
    if (!known) {
      throw new UnknownSector(
        `No vocabulary is written for "${clean}", so tagging a name with it would match nothing.`,
      );
    }
  }
  await writeTxn(actorId, async (c) => {
    await c.query('UPDATE companies SET sector = $1 WHERE id = $2', [clean, companyId]);
  });
}

/**
 * The people a name can be assigned to.
 *
 * Here rather than in `lib/admin.ts` because assigning coverage is not an administrative act — any
 * of the three can pick up a name — and a page that only needed a list of colleagues should not
 * have to import the module that grants and revokes admin.
 */
export async function coverers(): Promise<{ id: string; name: string }[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ id: string; name: string }>(
      'SELECT id, name FROM users WHERE disabled_at IS NULL ORDER BY name',
    );
    return rows;
  });
}

/** Null means nobody covers it, which alert routing reads as "tell everyone". */
export async function setCoverage(
  companyId: string,
  userId: string | null,
  actorId: string,
): Promise<void> {
  await writeTxn(actorId, async (c) => {
    await c.query('UPDATE companies SET covered_by = $1 WHERE id = $2', [userId, companyId]);
  });
}

export async function listCompanies(filter?: { status?: Status }): Promise<Company[]> {
  return readTxn(async (c) => {
    const { rows } = filter?.status
      ? await c.query<Row>(`${SELECT_COMPANY} WHERE c.status = $1 ORDER BY c.symbol`, [
          filter.status,
        ])
      : await c.query<Row>(`${SELECT_COMPANY} ORDER BY c.symbol`);
    return rows.map(toCompany);
  });
}

export async function getCompany(symbol: string): Promise<Company | null> {
  return readTxn(async (c) => {
    const { rows } = await c.query<Row>(`${SELECT_COMPANY} WHERE c.symbol = $1`, [
      symbol.trim().toUpperCase(),
    ]);
    return rows[0] ? toCompany(rows[0]) : null;
  });
}

export type AliasKind = 'name' | 'former_name' | 'brand' | 'subsidiary' | 'abbreviation';

/** Idempotent: the same alias added twice is one row, not an error a caller has to catch. */
export async function addAlias(
  companyId: string,
  alias: string,
  kind: AliasKind,
  actorId: string,
): Promise<void> {
  await writeTxn(actorId, async (c) => {
    await c.query(
      `INSERT INTO company_aliases (company_id, alias, kind) VALUES ($1, $2, $3)
       ON CONFLICT (company_id, alias) DO NOTHING`,
      [companyId, alias.trim(), kind],
    );
  });
}

export async function listAliases(
  companyId: string,
): Promise<{ alias: string; kind: AliasKind }[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ alias: string; kind: AliasKind }>(
      'SELECT alias, kind FROM company_aliases WHERE company_id = $1 ORDER BY kind, alias',
      [companyId],
    );
    return rows;
  });
}

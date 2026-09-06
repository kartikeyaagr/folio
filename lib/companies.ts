/**
 * The fund's list of names.
 *
 * Adding a company is the one place the exchange master and the fund's own list meet: you type a
 * symbol, `securities` answers with the ISIN and the registered name, and a `companies` row is
 * created from that rather than from what you typed. A name entered by hand drifts from the
 * exchange's, and every later match on that name drifts with it.
 */

import { randomBytes } from 'node:crypto';
import { readTxn, writeTxn, type Client } from './db.ts';

export const STATUSES = ['watching', 'working', 'holding', 'exited', 'passed'] as const;
export type Status = (typeof STATUSES)[number];

/** Closed statuses must state why. Mirrors the CHECK constraint so the error arrives early. */
const CLOSED: ReadonlySet<Status> = new Set<Status>(['exited', 'passed']);

export class UnknownSymbol extends Error {}
export class AlreadyFollowed extends Error {}
export class ReasonRequired extends Error {}

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

/**
 * Follow a name.
 *
 * Identity comes from `securities`, never from the caller: the symbol is the only thing typed,
 * and the ISIN and registered name are read from the exchange's own list. A symbol that is not
 * listed is a typo far more often than it is a gap in the master, so it raises.
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

    const id = randomBytes(16).toString('hex');
    await c.query(
      'INSERT INTO companies (id, symbol, isin, name, status) VALUES ($1, $2, $3, $4, $5)',
      [id, s.symbol, s.isin, s.name, 'watching'],
    );
    // The registered name is an alias too, so the news matcher has it without a special case.
    await c.query(
      "INSERT INTO company_aliases (company_id, alias, kind) VALUES ($1, $2, 'name')",
      [id, s.name],
    );

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

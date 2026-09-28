'use server';

import { readTxn } from '@/lib/db.ts';

import { currentUser } from '../session.ts';

/**
 * ⌘K: jump to a company the fund already follows.
 *
 * Over `companies`, not the exchange's security master — the header search is for getting to a
 * name, not for adding one. Adding lives on the Companies page, where picking a name creates it.
 */
export interface CompanyHit {
  symbol: string;
  name: string;
  stage: string;
}

const LABEL: Record<string, string> = {
  watching: 'Watching', working: 'Working', holding: 'Holding',
  exited: 'Exited', passed: 'Passed',
};

export async function searchCompanies(query: string): Promise<CompanyHit[]> {
  // Checked here and not only in the layout: a server action is its own entry point, reachable
  // without ever rendering the page that hosts it.
  if (!(await currentUser())) return [];
  const q = query.trim().slice(0, 60);
  if (q.length < 1) return [];

  return readTxn(async (c) => {
    const { rows } = await c.query<{ symbol: string; name: string; status: string }>(
      `SELECT symbol, name, status FROM companies
        WHERE (symbol ILIKE $1 OR name ILIKE $1) AND removed_at IS NULL
        ORDER BY (symbol ILIKE $2) DESC, symbol
        LIMIT 8`,
      [`%${q}%`, `${q}%`],
    );
    return rows.map((r) => ({ symbol: r.symbol, name: r.name, stage: LABEL[r.status] ?? r.status }));
  });
}

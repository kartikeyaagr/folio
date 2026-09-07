/**
 * The book, as the screens read it.
 *
 * Holdings are a materialised table rebuilt by full replay, so what is shown here is what `replay()`
 * produced from the transactions — never a running total maintained alongside them. That is the
 * whole reason a position on this screen can be trusted: it is derived, and it is derived the same
 * way every time.
 */

import { readTxn } from './db.ts';

export interface HoldingRow {
  companyId: string;
  symbol: string;
  name: string;
  quantity: string;
  avgCost: string;
  realisedGain: string;
  lastClose: string | null;
  replayedAt: Date;
}

export interface TransactionRow {
  id: string;
  tradeDate: string;
  symbol: string;
  side: string;
  quantity: string;
  price: string;
  fees: string;
  enteredBy: string | null;
  reversedAt: Date | null;
  reversalReason: string | null;
}

export interface CashRow {
  id: string;
  onDate: string;
  kind: string;
  amount: string;
  symbol: string | null;
  note: string | null;
}

export async function holdings(): Promise<HoldingRow[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<HoldingRow>(
      `SELECT h.company_id AS "companyId", co.symbol, co.name,
              h.quantity::text, h.avg_cost::text AS "avgCost",
              h.realised_gain::text AS "realisedGain", h.replayed_at AS "replayedAt",
              (SELECT p.close::text FROM prices p
                WHERE (p.isin IS NOT NULL AND p.isin = co.isin) OR p.symbol = co.symbol
                ORDER BY p.on_date DESC LIMIT 1) AS "lastClose"
         FROM holdings h JOIN companies co ON co.id = h.company_id
        WHERE h.quantity > 0
        ORDER BY co.symbol`,
    );
    return rows;
  });
}

/**
 * Every trade, reversals included and marked.
 *
 * A reversed trade stays on the screen struck through rather than disappearing. An entry that
 * vanishes when corrected leaves a book that cannot be reconciled against a broker note, and the
 * reason for the reversal is the part somebody will want in three years.
 */
export async function transactions(limit = 200): Promise<TransactionRow[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<TransactionRow>(
      `SELECT t.id, t.trade_date::text AS "tradeDate", co.symbol, t.side,
              t.quantity::text, t.price::text, t.fees::text,
              u.name AS "enteredBy", t.reversed_at AS "reversedAt",
              t.reversal_reason AS "reversalReason"
         FROM transactions t
         JOIN companies co ON co.id = t.company_id
         LEFT JOIN users u ON u.id = t.entered_by
        ORDER BY t.trade_date DESC, t.seq DESC NULLS LAST
        LIMIT $1`,
      [limit],
    );
    return rows;
  });
}

export async function cash(limit = 100): Promise<{ rows: CashRow[]; balance: string }> {
  return readTxn(async (c) => {
    const { rows } = await c.query<CashRow>(
      `SELECT l.id, l.on_date::text AS "onDate", l.kind, l.amount::text, co.symbol, l.note
         FROM cash_ledger l LEFT JOIN companies co ON co.id = l.company_id
        ORDER BY l.on_date DESC, l.created_at DESC
        LIMIT $1`,
      [limit],
    );
    const { rows: total } = await c.query<{ balance: string }>(
      'SELECT COALESCE(sum(amount), 0)::text AS balance FROM cash_ledger',
    );
    return { rows, balance: total[0]!.balance };
  });
}

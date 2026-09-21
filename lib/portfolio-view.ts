/**
 * The book, as the screens read it.
 *
 * Holdings are a materialised table rebuilt by full replay, so what is shown here is what `replay()`
 * produced from the transactions — never a running total maintained alongside them. That is the
 * whole reason a position on this screen can be trusted: it is derived, and it is derived the same
 * way every time.
 */

import { positionAsOf } from './book.ts';
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

/**
 * The book as this screen reads it: quantity, weighted-average cost, realised gain, last close.
 *
 * **There is a second exported `holdings()` one import away, in `lib/book.ts`, returning a
 * different `HoldingRow`.** That one marks to market — `cost`, `close`, `pricedOn`, `marketValue`
 * — and has no caller outside `lib/book.test.ts`; `/portfolio` reads this one. Two exports sharing
 * a name and two row types sharing a name is how `lib/portfolio-view.test.ts` comes to import
 * `holdings` from `./book.ts` while testing this module. Check which file an import resolved to
 * before trusting a column to be there.
 *
 * `quantity > 0` hides a name replayed down to nothing. The row itself survives — `replayCompany`
 * deletes a holding only when the realised gain is zero as well — so an exited name's realised
 * gain is kept and simply is not on this screen.
 */
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

/**
 * The most recent ledger lines, and the balance of the whole ledger.
 *
 * **`balance` is not the sum of `rows`.** The rows stop at `limit`; the balance counts every row
 * there has ever been, because that is the cash position the screen states. Past a hundred lines
 * the two visibly disagree, and it is the rows that cannot be added up, not the balance.
 *
 * It is also not the same string `cashBalance()` in `lib/book.ts` returns for the same money.
 * `cash_ledger.amount` is `numeric(20,4)` and this hands back the sum as it comes, so a balance of
 * minus ten thousand reads `-10000.0000` here and `-10000.00` there, which casts to
 * `numeric(20,2)` first. Compare the two as numbers; never as text.
 */
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

export interface PendingAction {
  id: string;
  symbol: string;
  name: string;
  kind: string;
  recordDate: string;
  ratioFrom: string | null;
  ratioTo: string | null;
  amountPerShare: string | null;
  /** The exchange's own line. Shown beside the parse so a person can check one against the other. */
  subject: string | null;
  companyId: string;
  /** The position on the record date. What the action will actually act on, shown before it does. */
  quantityAtRecord: number;
}

/**
 * Corporate actions the feed has announced and nobody has confirmed.
 *
 * B5's confirm step exists because an exchange announcing a bonus is not the same as the bonus
 * having happened to us. Nothing an ingest writes touches a position until a person says so.
 *
 * The quantity shown is the position **as of the record date**, which is what the action will act
 * on — so a reader can see the number before agreeing to it rather than afterwards in the ledger.
 *
 * It is replayed rather than counted. Summing the fills up to the record date looks equivalent and
 * is not: on a name that has already taken a bonus, the sum of its fills is the quantity from
 * before that bonus, while `confirmAction` applies the new one to the quantity after it. The
 * screen would then state one number and the ledger record another, with nothing to say which was
 * meant. One replay each, at most fifty of them, which is cheaper than that disagreement.
 */
export async function pendingActions(): Promise<PendingAction[]> {
  const rows = await readTxn(async (c) => {
    const { rows } = await c.query<Omit<PendingAction, 'quantityAtRecord'>>(
      `SELECT a.id, a.company_id AS "companyId", co.symbol, co.name, a.kind,
              a.record_date::text AS "recordDate",
              a.ratio_from::text AS "ratioFrom",
              a.ratio_to::text AS "ratioTo",
              a.amount_per_share::text AS "amountPerShare",
              a.subject
         FROM corporate_actions a
         JOIN companies co ON co.id = a.company_id
        WHERE a.applied_at IS NULL
        ORDER BY a.record_date DESC
        LIMIT 50`,
    );
    return rows;
  });

  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      quantityAtRecord: (await positionAsOf(r.companyId, r.recordDate)).quantity,
    })),
  );
}

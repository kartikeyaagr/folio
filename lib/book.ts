/**
 * The book: what the fund owns, what it paid, and what the cash did.
 *
 * Holdings are stored but never patched. Every change — a trade, a reversal, a corporate action
 * confirmed weeks late — triggers a **full replay** from `transactions` and confirmed
 * `corporate_actions`. That is the whole design: there is no incremental state to go stale, no
 * watermark to be wrong, and a back-dated trade produces a different replay rather than a
 * position that quietly disagrees with its own history.
 *
 * Weighted-average cost. The fund administrator produces tax-correct FIFO lots when an accountant
 * asks; this answers "what did this position cost us".
 *
 * Precision: quantities and prices are carried as doubles during the replay and written back at
 * the column's scale. At this book's size — tens of names, hundreds of fills, quantities under a
 * million — every intermediate stays far inside the 2^53 range where doubles are exact for the
 * scaled integers involved. Postgres stores what it is given exactly.
 */

import { randomBytes } from 'node:crypto';
import { readTxn, writeTxn, type Client } from './db.ts';

export class DuplicateTrade extends Error {}
export class ReasonRequired extends Error {}

export type Side = 'buy' | 'sell';
export type ActionKind = 'bonus' | 'split' | 'dividend';

const id = (): string => randomBytes(16).toString('hex');
const n = (v: string | number | null): number => (v === null ? 0 : Number(v));

// ------------------------------------------------------------------------------------------------
// Replay
// ------------------------------------------------------------------------------------------------

interface Trade {
  trade_date: string;
  side: Side;
  quantity: string;
  price: string;
  fees: string;
  created_at: Date;
}

interface Action {
  kind: ActionKind;
  record_date: string;
  ratio_from: string | null;
  ratio_to: string | null;
  amount_per_share: string | null;
}

export interface Position {
  quantity: number;
  avgCost: number;
  realisedGain: number;
}

/**
 * Fold trades and confirmed actions into a position.
 *
 * Exported and pure so the arithmetic can be tested without a database — this is the function that
 * decides what the fund thinks it owns, and it is the one place a wrong number would be believed.
 *
 * An action applies to the quantity held **as of its record date**, so on a shared date the trades
 * settle first and the action then acts on the resulting position.
 */
export function replay(trades: Trade[], actions: Action[], asOf?: string): Position {
  type Event =
    | { on: string; order: 0; kind: 'trade'; t: Trade }
    | { on: string; order: 1; kind: 'action'; a: Action };

  const events: Event[] = [
    ...trades.map((t): Event => ({ on: t.trade_date, order: 0, kind: 'trade', t })),
    ...actions.map((a): Event => ({ on: a.record_date, order: 1, kind: 'action', a })),
  ]
    // `asOf` stops the fold at a date. A dividend is paid on the quantity held on its **record
    // date**, not on the quantity held whenever somebody got round to confirming it: hold 10,000,
    // buy 5,000 more, confirm a Rs 2.50 dividend late, and folding to today pays Rs 37,500 against
    // a receipt for Rs 25,000. The comparison is on ISO dates, which sort as strings.
    .filter((e) => asOf === undefined || e.on <= asOf)
    .sort((x, y) => (x.on === y.on ? x.order - y.order : x.on < y.on ? -1 : 1));

  let quantity = 0;
  let costTotal = 0;
  let realised = 0;

  for (const e of events) {
    if (e.kind === 'trade') {
      const q = n(e.t.quantity);
      const price = n(e.t.price);
      const fees = n(e.t.fees);
      if (e.t.side === 'buy') {
        quantity += q;
        costTotal += q * price + fees;
      } else {
        // Selling more than is held would mean the record is wrong; clamp rather than go negative,
        // and let the holdings CHECK constraint be the thing that refuses to store nonsense.
        const sold = Math.min(q, quantity);
        const avg = quantity === 0 ? 0 : costTotal / quantity;
        realised += sold * (price - avg) - fees;
        quantity -= sold;
        costTotal = quantity * avg;
      }
    } else if (e.a.kind !== 'dividend') {
      // A 1:1 bonus is from 1 to 2, so the factor is 2. It multiplies quantity and **divides
      // average cost by the same factor** — total cost basis is unchanged, because a bonus issue
      // costs nothing. Leaving average cost alone would double the basis and print a fabricated
      // ~50% unrealised loss.
      const from = n(e.a.ratio_from);
      const to = n(e.a.ratio_to);
      if (from > 0 && to > 0) quantity = quantity * (to / from);
      // costTotal is deliberately untouched: quantity rose, so the average falls out of the division.
    }
    // A dividend moves cash, not quantity or cost. Its ledger row is written when it is confirmed.
  }

  return {
    quantity,
    avgCost: quantity === 0 ? 0 : costTotal / quantity,
    realisedGain: realised,
  };
}

async function loadAndReplay(c: Client, companyId: string, asOf?: string): Promise<Position> {
  const { rows: trades } = await c.query<Trade>(
    `SELECT trade_date, side, quantity::text, price::text, fees::text, created_at
       FROM transactions
      WHERE company_id = $1 AND reversed_at IS NULL
      ORDER BY trade_date, created_at`,
    [companyId],
  );
  const { rows: actions } = await c.query<Action>(
    `SELECT kind, record_date, ratio_from::text, ratio_to::text, amount_per_share::text
       FROM corporate_actions
      WHERE company_id = $1 AND applied_at IS NOT NULL
      ORDER BY record_date`,
    [companyId],
  );
  return replay(trades, actions, asOf);
}

/**
 * The position as it stood on a date.
 *
 * Exported so a screen can show what an action is about to act on, and show it by running the
 * same replay the confirm will run. A screen that counted the trades itself would be right until
 * the first company that had already taken a bonus: the sum of its fills is the quantity before
 * that bonus, and the confirm applies the dividend to the quantity after it. One code path, so
 * the number a person reads and the number the book uses cannot drift apart.
 */
export async function positionAsOf(companyId: string, on: string): Promise<Position> {
  return readTxn((c) => loadAndReplay(c, companyId, on));
}

/** Rebuild one company's holding from its whole history. Called after every change. */
export async function replayCompany(companyId: string, actorId: string): Promise<Position> {
  return writeTxn(actorId, async (c) => {
    const p = await loadAndReplay(c, companyId);
    if (p.quantity === 0 && p.realisedGain === 0) {
      await c.query('DELETE FROM holdings WHERE company_id = $1', [companyId]);
      return p;
    }
    await c.query(
      `INSERT INTO holdings (company_id, quantity, avg_cost, realised_gain, replayed_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (company_id) DO UPDATE
          SET quantity = EXCLUDED.quantity, avg_cost = EXCLUDED.avg_cost,
              realised_gain = EXCLUDED.realised_gain, replayed_at = now()`,
      [companyId, p.quantity.toFixed(4), p.avgCost.toFixed(6), p.realisedGain.toFixed(4)],
    );
    return p;
  });
}

// ------------------------------------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------------------------------------

export interface TradeInput {
  companyId: string;
  tradeDate: string;
  side: Side;
  quantity: number;
  price: number;
  fees?: number;
  /** Set only to record a genuine second identical fill on the same day. */
  seq?: number;
}

/**
 * Record a trade, and rebuild the position.
 *
 * The unique index refuses a second identical fill unless `seq` says it is deliberate, which is
 * what turns a double-submitted form into an error rather than a doubled position. The error names
 * the escape hatch, because a genuine repeat fill is routine.
 */
export async function recordTrade(t: TradeInput, actorId: string): Promise<string> {
  const tradeId = id();
  try {
    await writeTxn(actorId, async (c) => {
      await c.query(
        `INSERT INTO transactions (id, company_id, trade_date, side, quantity, price, fees, seq, entered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          tradeId, t.companyId, t.tradeDate, t.side, t.quantity, t.price,
          t.fees ?? 0, t.seq ?? null, actorId,
        ],
      );
      const cash = t.side === 'buy'
        ? -(t.quantity * t.price + (t.fees ?? 0))
        : t.quantity * t.price - (t.fees ?? 0);
      await c.query(
        `INSERT INTO cash_ledger (id, on_date, kind, amount, company_id, transaction_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id(), t.tradeDate, t.side, cash.toFixed(4), t.companyId, tradeId],
      );
    });
  } catch (err) {
    if (String(err).includes('transactions_unique_fill')) {
      throw new DuplicateTrade(
        'An identical fill is already recorded for that name, date, side, quantity and price. ' +
          'If this is a genuine second fill, pass seq: 2.',
      );
    }
    throw err;
  }
  await replayCompany(t.companyId, actorId);
  return tradeId;
}

/** Reverse rather than delete. What was recorded stays recorded. */
export async function reverseTrade(
  tradeId: string,
  reason: string,
  actorId: string,
): Promise<void> {
  if (!reason.trim()) throw new ReasonRequired('Reversing a trade needs a reason.');
  const companyId = await writeTxn(actorId, async (c) => {
    const { rows } = await c.query<{ company_id: string }>(
      `UPDATE transactions SET reversed_at = now(), reversed_by = $1, reversal_reason = $2
        WHERE id = $3 AND reversed_at IS NULL
        RETURNING company_id`,
      [actorId, reason.trim(), tradeId],
    );
    if (!rows[0]) return null;
    await c.query('DELETE FROM cash_ledger WHERE transaction_id = $1', [tradeId]);
    return rows[0].company_id;
  });
  if (companyId) await replayCompany(companyId, actorId);
}

/**
 * Confirm a corporate action, which is what makes it real to the book.
 *
 * An exchange feed announcing a bonus is not the same as the bonus having happened to us, so
 * nothing an ingest writes affects a position until a person says so.
 */
export async function confirmAction(actionId: string, actorId: string): Promise<void> {
  const companyId = await writeTxn(actorId, async (c) => {
    const { rows } = await c.query<{
      company_id: string; kind: ActionKind; record_date: string; amount_per_share: string | null;
    }>(
      `UPDATE corporate_actions SET applied_at = now(), applied_by = $1
        WHERE id = $2 AND applied_at IS NULL
        RETURNING company_id, kind, record_date, amount_per_share::text`,
      [actorId, actionId],
    );
    const a = rows[0];
    if (!a) return null;
    if (a.kind === 'dividend') {
      // Paid on the quantity held as of the record date. The replay knows how — it sorts by date
      // already — but it had to be *asked*: this folded the whole history and paid on today's
      // position, under a comment claiming it did not.
      const p = await loadAndReplay(c, a.company_id, a.record_date);
      const amount = p.quantity * n(a.amount_per_share);
      await c.query(
        `INSERT INTO cash_ledger (id, on_date, kind, amount, company_id, action_id, note)
         VALUES ($1,$2,'dividend',$3,$4,$5,$6)`,
        [id(), a.record_date, amount.toFixed(4), a.company_id, actionId,
         `${p.quantity} shares at ${n(a.amount_per_share)}`],
      );
    }
    return a.company_id;
  });
  if (companyId) await replayCompany(companyId, actorId);
}

export async function recordCapital(
  kind: 'capital_in' | 'capital_out',
  amount: number,
  onDate: string,
  note: string,
  actorId: string,
): Promise<void> {
  await writeTxn(actorId, async (c) => {
    await c.query(
      'INSERT INTO cash_ledger (id, on_date, kind, amount, note) VALUES ($1,$2,$3,$4,$5)',
      [id(), onDate, kind, (kind === 'capital_in' ? Math.abs(amount) : -Math.abs(amount)).toFixed(4), note],
    );
  });
}

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

export interface HoldingRow {
  companyId: string;
  symbol: string;
  name: string;
  quantity: string;
  avgCost: string;
  cost: string;
  /** Null when no price is held. The UI renders "no mark" rather than dropping the row. */
  close: string | null;
  pricedOn: string | null;
  marketValue: string | null;
}

/**
 * The book, marked to the latest close held.
 *
 * LEFT JOIN on purpose. A holding with no price row — newly added, illiquid, a missed ingest —
 * must appear with no mark rather than vanish from a SUM and understate the portfolio.
 */
export async function holdings(): Promise<HoldingRow[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<HoldingRow>(
      `SELECT h.company_id AS "companyId", c.symbol, c.name,
              h.quantity::text, h.avg_cost::text AS "avgCost",
              (h.quantity * h.avg_cost)::numeric(20,2)::text AS cost,
              p.close::text, p.on_date AS "pricedOn",
              CASE WHEN p.close IS NULL THEN NULL
                   ELSE (h.quantity * p.close)::numeric(20,2)::text END AS "marketValue"
         FROM holdings h
         JOIN companies c ON c.id = h.company_id
         LEFT JOIN LATERAL (
              SELECT close, on_date FROM prices
               WHERE (isin IS NOT NULL AND isin = c.isin) OR symbol = c.symbol
               ORDER BY on_date DESC LIMIT 1
         ) p ON true
        WHERE h.quantity > 0
        ORDER BY c.symbol`,
    );
    return rows;
  });
}

export async function cashBalance(): Promise<string> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ balance: string }>(
      'SELECT coalesce(sum(amount), 0)::numeric(20,2)::text AS balance FROM cash_ledger',
    );
    return rows[0]!.balance;
  });
}

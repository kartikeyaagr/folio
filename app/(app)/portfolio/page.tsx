import Link from 'next/link';

import {
  cash, holdings, pendingActions, transactions, type PendingAction,
} from '@/lib/portfolio-view.ts';
import { listCompanies } from '@/lib/companies.ts';
import { DialogButton } from '@/components/DialogButton.tsx';
import { TradeForm } from '@/components/TradeForm.tsx';
import {
  AppHeader, Blank, Card, Empty, Seg, Stat, StatRow, crore, inr, signedPct,
} from '@/components/ui.tsx';

import {
  confirmActionAction,
  recordCapitalAction,
  recordTradeAction,
  reverseTradeAction,
} from '../../_lib/actions/book.ts';
import { requireUser } from '../../_lib/session.ts';

/**
 * The book.
 *
 * Every figure here is derived from the transactions by full replay — nothing on this page is a
 * running total kept alongside them. Where a position has no close to mark against, the cell says
 * so rather than falling back to cost, because a position marked at cost and one marked at market
 * are different claims and must never look alike.
 */

export const dynamic = 'force-dynamic';

/**
 * What the action will do, said as the fund would say it.
 *
 * The feed states a ratio as from:to, and `replay()` multiplies the position by `to / from` — so a
 * bonus arriving as 1 → 2 doubles the holding. Written out here rather than printed as "1:2",
 * which reads to half the desk as the opposite trade.
 */
function describeAction(a: PendingAction): string {
  if (a.kind === 'dividend') {
    return a.amountPerShare ? `dividend of ${inr(a.amountPerShare)} a share` : 'dividend';
  }
  // Read as numbers rather than printed as filed. The column is numeric(20,6), so a 1:2 bonus
  // arrives as "1.000000" and "2.000000", which is not how anybody on the desk says it.
  if (a.ratioFrom && a.ratioTo) {
    return `${a.kind}: every ${Number(a.ratioFrom)} becomes ${Number(a.ratioTo)}`;
  }
  return a.kind;
}

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  await requireUser();
  const view = (await searchParams).view ?? 'holdings';

  const [book, trades, ledger, actions, names] = await Promise.all([
    holdings(),
    transactions(),
    cash(),
    pendingActions(),
    listCompanies(),
  ]);

  // The date the form opens on. Not a default the action would apply — the field is required and
  // checked server-side — just the day somebody recording a trade almost always means.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

  const tradeForm = <TradeForm names={names} today={today} action={recordTradeAction} />;

  const capitalForm = (
    <form action={recordCapitalAction} className="form-grid">
      <div className="form-row">
        <label className="lbl">
          Direction
          <select className="field" name="kind" defaultValue="capital_in" required>
            <option value="capital_in">Money in</option>
            <option value="capital_out">Money out</option>
          </select>
        </label>
        <label className="lbl">
          Amount
          <input className="field" name="amount" inputMode="decimal" required />
        </label>
        <label className="lbl">
          Date
          <input className="field" type="date" name="onDate" defaultValue={today} required />
        </label>
      </div>
      <label className="lbl">
        What it was for
        <input className="field" name="note" required />
      </label>
      {/* The sign comes from the direction, never from the number: a negative in the "money out"
          box would otherwise be money in, which is the wrong way to find a typo. */}
      <p className="picker-none">Enter a positive amount; the direction above decides the sign.</p>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary">
          Record it
        </button>
      </div>
    </form>
  );

  const invested = book.reduce((n, h) => n + Number(h.quantity) * Number(h.avgCost), 0);
  const marked = book.reduce(
    (n, h) => n + (h.lastClose ? Number(h.quantity) * Number(h.lastClose) : 0), 0,
  );
  const unpriced = book.filter((h) => !h.lastClose).length;

  return (
    <>
      <AppHeader
        title="Portfolio"
        subtitle={`${book.length} positions · ${crore(invested)} at cost`}
      />

      <div className="page">
        <StatRow>
          <Stat label="Positions" value={String(book.length)} />
          <Stat label="At cost" value={crore(invested)} />
          <Stat
            label="At market"
            value={unpriced === book.length ? '—' : crore(marked)}
            sub={unpriced > 0 ? `${unpriced} unpriced, excluded` : 'every position priced'}
            tone={unpriced > 0 ? 'warn' : undefined}
          />
          <Stat label="Cash" value={crore(ledger.balance)} />
        </StatRow>

        {/* B5. An announcement is not an event until somebody says it happened to us, so nothing an
            ingest writes moves a position on its own. Above the book because it changes what the
            book says, and it names the holding on the record date before acting on it — a bonus on
            a name sold in March has to be visibly a bonus on nothing. */}
        <Card title="Corporate actions to confirm" padded={actions.length === 0}>
          {actions.length === 0 ? (
            <Empty>
              Nothing is waiting. Bonuses, splits and dividends announced for names in the book
              appear here, and none of them touches a position until somebody confirms it.
            </Empty>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Record date</th><th>Company</th><th>Action</th>
                    <th className="num">Held on that date</th><th />
                  </tr>
                </thead>
                <tbody>
                  {actions.map((a) => {
                    const held = a.quantityAtRecord;
                    const what = describeAction(a);
                    return (
                      <tr key={a.id}>
                        <td className="num">{a.recordDate}</td>
                        <td>
                          <Link href={`/company/${a.symbol}`}><b>{a.symbol}</b></Link>
                          <span className="cell-sub">{a.name}</span>
                        </td>
                        <td className="cell-wrap">
                          {what}
                          {/* The exchange's own line, under our reading of it. Confirming applies
                              our parse to a real position, and a person cannot check a parse they
                              cannot see next to what produced it. */}
                          {a.subject && <span className="cell-sub">{a.subject}</span>}
                        </td>
                        <td className="num">
                          {held === 0
                            ? <Blank why="Nothing was held on the record date" />
                            : inr(held, 0)}
                        </td>
                        <td className="num">
                          <DialogButton
                            label="Confirm"
                            title={`${a.symbol} — ${what}`}
                            className="btn btn-sm"
                          >
                            <form action={confirmActionAction} className="form-grid">
                              <input type="hidden" name="id" value={a.id} />
                              <p className="picker-none">
                                {held === 0
                                  ? `Nothing was held in ${a.symbol} on ${a.recordDate}, so confirming this changes no position and pays no cash. Confirm it to clear it from the list.`
                                  : `${inr(held, 0)} ${a.symbol} were held on ${a.recordDate}. Confirming applies the ${a.kind} to that quantity — not to the position today — and replays the book.`}
                              </p>
                              <div className="form-actions">
                                <button type="submit" className="btn btn-primary">
                                  Confirm it
                                </button>
                              </div>
                            </form>
                          </DialogButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title={view === 'trades' ? 'Transactions' : view === 'cash' ? 'Cash' : 'Holdings'}
          action={
            <div className="form-actions">
              <Seg
                current={`/portfolio?view=${view}`}
                options={[
                  { label: 'Holdings', href: '/portfolio?view=holdings' },
                  { label: 'Transactions', href: '/portfolio?view=trades' },
                  { label: 'Cash', href: '/portfolio?view=cash' },
                ]}
              />
              {/* B2 calls this the only manual write to the ledger, so it is one button and it is
                  where the ledger is, rather than scattered across the screens that show its
                  consequences. Cash gets its own on the cash view for the same reason. */}
              {view === 'cash' ? (
                <DialogButton label="Money in or out" title="Record a cash movement" className="btn btn-primary btn-sm">
                  {capitalForm}
                </DialogButton>
              ) : (
                <DialogButton label="Record a trade" title="Record a trade" className="btn btn-primary btn-sm">
                  {tradeForm}
                </DialogButton>
              )}
            </div>
          }
          padded={false}
        >
          {view === 'holdings' && (
            book.length === 0 ? (
              <Empty>
                Nothing is held. Holdings are rebuilt from the transactions on every change, so a
                position appears here the moment its first trade is recorded.
              </Empty>
            ) : (
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Company</th><th className="num">Quantity</th><th className="num">Average cost</th>
                      <th className="num">Last close</th><th className="num">Value</th>
                      <th className="num">Unrealised</th><th className="num">Realised</th>
                    </tr>
                  </thead>
                  <tbody>
                    {book.map((h) => {
                      const cost = Number(h.quantity) * Number(h.avgCost);
                      const value = h.lastClose ? Number(h.quantity) * Number(h.lastClose) : null;
                      return (
                        <tr key={h.companyId}>
                          <td>
                            <Link href={`/company/${h.symbol}`}><b>{h.symbol}</b></Link>
                            <span className="cell-sub">{h.name}</span>
                          </td>
                          <td className="num">{inr(h.quantity, 0)}</td>
                          <td className="num">{inr(h.avgCost)}</td>
                          <td className="num">
                            {h.lastClose ? inr(h.lastClose) : <Blank why="No price row joins this name" />}
                          </td>
                          <td className="num">{value !== null ? crore(value) : <Blank why="Not marked: no close held" />}</td>
                          <td className="num">
                            {value !== null ? signedPct(((value - cost) / cost) * 100) : <Blank why="Not marked: no close held" />}
                          </td>
                          <td className="num">{crore(h.realisedGain)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}

          {view === 'trades' && (
            trades.length === 0 ? (
              <Empty>No trades recorded.</Empty>
            ) : (
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Date</th><th>Company</th><th>Side</th><th className="num">Quantity</th>
                      <th className="num">Price</th><th className="num">Fees</th><th>Entered by</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t) => (
                      <tr key={t.id} className={t.reversedAt ? 'pf-void' : undefined}>
                        <td className="num">{t.tradeDate}</td>
                        <td><Link href={`/company/${t.symbol}`}>{t.symbol}</Link></td>
                        <td>{t.side}</td>
                        <td className="num">{inr(t.quantity, 0)}</td>
                        <td className="num">{inr(t.price)}</td>
                        <td className="num">{inr(t.fees)}</td>
                        <td>{t.enteredBy ?? <Blank />}</td>
                        {/* The reason lives here rather than beside the name, because a struck-out
                            row cannot un-strike a span inside it: text-decoration set on an
                            ancestor is drawn over every descendant and `none` on the child does
                            not remove it. Its own cell can opt out; a nested span cannot. */}
                        <td className="cell-note">
                          {t.reversedAt ? (
                            // Faded and kept. A corrected entry that vanished would leave a book
                            // nobody could reconcile against a broker note — so the row stays,
                            // and its reason stays at full strength, being the explanation rather
                            // than the mistake.
                            <span className="cell-sub">
                              reversed — {t.reversalReason ?? 'no reason recorded'}
                            </span>
                          ) : (
                            <DialogButton
                              label="Reverse"
                              title={`Reverse ${t.side} ${inr(t.quantity, 0)} ${t.symbol}`}
                              className="btn btn-link"
                            >
                              <form action={reverseTradeAction} className="form-grid">
                                <input type="hidden" name="id" value={t.id} />
                                <p className="picker-none">
                                  {t.tradeDate} · {t.side} {inr(t.quantity, 0)} at {inr(t.price)}.
                                  The row stays on the book, faded, with this reason beside it,
                                  and the position is replayed without it.
                                </p>
                                {/* Required by the library too, and asked for here rather than
                                    only refused there: a reversal with no reason leaves a book
                                    that is right and nobody able to say why it changed. */}
                                <label className="lbl">
                                  Why
                                  <input className="field" name="reason" required />
                                </label>
                                <div className="form-actions">
                                  <button type="submit" className="btn btn-danger">
                                    Reverse it
                                  </button>
                                </div>
                              </form>
                            </DialogButton>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}

          {view === 'cash' && (
            ledger.rows.length === 0 ? (
              <Empty>No cash movements recorded.</Empty>
            ) : (
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr><th>Date</th><th>Kind</th><th>Company</th><th className="num">Amount</th><th>Note</th></tr>
                  </thead>
                  <tbody>
                    {ledger.rows.map((r) => (
                      <tr key={r.id}>
                        <td className="num">{r.onDate}</td>
                        <td>{r.kind}</td>
                        <td>{r.symbol ? <Link href={`/company/${r.symbol}`}>{r.symbol}</Link> : ''}</td>
                        <td className="num">{inr(r.amount)}</td>
                        <td className="cell-wrap">{r.note ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </Card>
      </div>
    </>
  );
}

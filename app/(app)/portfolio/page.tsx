import Link from 'next/link';

import { cash, holdings, transactions } from '@/lib/portfolio-view.ts';
import {
  AppHeader, Blank, Card, Empty, Seg, Stat, StatRow, crore, inr, signedPct,
} from '@/components/ui.tsx';

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

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  await requireUser();
  const view = (await searchParams).view ?? 'holdings';

  const [book, trades, ledger] = await Promise.all([holdings(), transactions(), cash()]);

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

        <Card
          title={view === 'trades' ? 'Transactions' : view === 'cash' ? 'Cash' : 'Holdings'}
          action={
            <Seg
              current={`/portfolio?view=${view}`}
              options={[
                { label: 'Holdings', href: '/portfolio?view=holdings' },
                { label: 'Transactions', href: '/portfolio?view=trades' },
                { label: 'Cash', href: '/portfolio?view=cash' },
              ]}
            />
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
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t) => (
                      <tr key={t.id} className={t.reversedAt ? 'is-reversed' : undefined}>
                        <td className="num">{t.tradeDate}</td>
                        <td><Link href={`/company/${t.symbol}`}>{t.symbol}</Link></td>
                        <td>{t.side}</td>
                        <td className="num">{inr(t.quantity, 0)}</td>
                        <td className="num">{inr(t.price)}</td>
                        <td className="num">{inr(t.fees)}</td>
                        <td>
                          {t.enteredBy ?? <Blank />}
                          {t.reversedAt && (
                            // Struck through and kept. A corrected entry that vanished would leave
                            // a book nobody could reconcile against a broker note.
                            <span className="cell-sub">reversed — {t.reversalReason ?? 'no reason recorded'}</span>
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

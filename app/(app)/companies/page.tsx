import Link from 'next/link';

import { companyList } from '@/lib/company-view.ts';
import { AppHeader, Blank, Card, Chip, Empty, inr, type Tone } from '@/components/ui.tsx';

import { requireUser } from '../../_lib/session.ts';

/**
 * Every name the fund follows, in the order it has a claim on attention.
 *
 * Five statuses, hand-set. v2 enforced twelve stages and a name had to be dragged through them;
 * these are words a person chooses, and `exited` and `passed` are kept apart on purpose — a name
 * sold and a name never bought are different facts and get confused when they share a bucket.
 */

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, Tone> = {
  holding: 'good', working: 'navy', watching: 'neutral', exited: 'warn', passed: 'neutral',
};

const STATUS_LABEL: Record<string, string> = {
  holding: 'Holding', working: 'Working', watching: 'Watching', exited: 'Exited', passed: 'Passed',
};

export default async function CompaniesPage() {
  await requireUser();
  const rows = await companyList();
  const held = rows.filter((r) => r.status === 'holding').length;

  return (
    <>
      <AppHeader
        title="Companies"
        subtitle={`${rows.length} followed · ${held} held`}
      />

      <div className="page">
        <Card title="Followed names" padded={false}>
          {rows.length === 0 ? (
            <Empty>
              No names yet. Following a company is what starts everything else: its filings, its
              results and its calendar arrive from the next run onwards.
            </Empty>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Status</th>
                    <th>Sector</th>
                    <th>Covered by</th>
                    <th className="num">Held</th>
                    <th className="num">Avg cost</th>
                    <th className="num">Last close</th>
                    <th className="num">Filings 30d</th>
                    <th className="num">News 30d</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/company/${r.symbol}`}>
                          <b>{r.symbol}</b>
                        </Link>
                        <span className="cell-sub">{r.name}</span>
                      </td>
                      <td>
                        <Chip tone={STATUS_TONE[r.status] ?? 'neutral'}>
                          {STATUS_LABEL[r.status] ?? r.status}
                        </Chip>
                      </td>
                      <td>
                        {r.sector ?? <Blank why="No sector set. Without one this name matches no trade press." />}
                      </td>
                      <td>
                        {r.coveredByName ?? (
                          <span title="Uncovered names are not neglected by the alerting: their alerts go to everyone rather than to nobody.">
                            everyone
                          </span>
                        )}
                      </td>
                      <td className="num">
                        {r.quantity && Number(r.quantity) > 0 ? inr(r.quantity, 0) : ''}
                      </td>
                      <td className="num">{r.avgCost ? inr(r.avgCost) : ''}</td>
                      <td className="num">
                        {r.lastClose ? inr(r.lastClose) : <Blank why="No price row joins this name yet" />}
                      </td>
                      <td className="num">{r.filings30 || ''}</td>
                      <td className="num">{r.news30 || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

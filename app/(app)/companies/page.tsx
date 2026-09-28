import Link from 'next/link';

import { companyList, type CompanyListRow } from '@/lib/company-view.ts';
import {
  AppHeader, Blank, Card, Chip, dayMonthYear, Empty, Seg, inr, type Tone,
} from '@/components/ui.tsx';
import { DialogButton } from '@/components/DialogButton.tsx';
import { FollowPicker } from '@/components/FollowPicker.tsx';

import {
  followCompany, restoreCompanyAction, searchSecurities,
} from '../../_lib/actions/companies.ts';
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

/** `not filled in` is the one a person has to act on: nothing will retry it. */
const BACKFILL_TONE: Record<string, Tone> = {
  'filling in': 'navy', waiting: 'neutral',
  'filled in, with gaps': 'warn', 'not filled in': 'bad',
};

function priceWhy(backfill: string | null): string {
  if (backfill === 'waiting') return 'Queued for its history; prices arrive with it';
  if (backfill === 'filling in') return 'Its history is being fetched now';
  if (backfill === 'not filled in') return 'Its backfill gave up; re-run it by symbol';
  return 'No price row joins this name yet';
}

/**
 * The names a person took off the list, with the way back.
 *
 * Its own table rather than the followed one filtered: what a removed name is owed is who removed
 * it and when, and the holding, price and thirty-day columns would be blanks for a name every feed
 * now skips.
 */
function RemovedTable({ rows }: { rows: CompanyListRow[] }) {
  return (
    <div className="tbl-scroll">
      <table className="tbl">
        <thead>
          <tr>
            <th>Company</th>
            <th>Status</th>
            <th>Removed</th>
            <th />
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
                {r.removedAt ? dayMonthYear(r.removedAt) : <Blank why="No removal date held" />}
                <span className="cell-sub">
                  {r.removedByName ?? <Blank why="Nobody recorded as removing it" />}
                </span>
              </td>
              <td className="cell-note">
                <form action={restoreCompanyAction}>
                  <input type="hidden" name="symbol" value={r.symbol} />
                  <button type="submit" className="btn btn-sm">Restore</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function CompaniesPage({
  searchParams,
}: {
  // In the URL so a refresh, and a link somebody sends, lands on the same list.
  searchParams: Promise<{ filter?: string }>;
}) {
  await requireUser();
  const showRemoved = (await searchParams).filter === 'removed';
  // Both, always: the header counts the followed names whichever list is showing, and the switch
  // says how many were removed before anybody opens it.
  const [rows, removed] = await Promise.all([companyList(), companyList({ removed: true })]);
  // The count is of positions actually on the book, not of names somebody has marked `holding`.
  // Status is a judgement and the quantity is a fact; a header reading "0 held" above two rows
  // showing 5,000 each is the header disagreeing with its own table.
  const onTheBook = rows.filter((r) => Number(r.quantity ?? 0) > 0).length;
  const marked = rows.filter((r) => r.status === 'holding').length;

  return (
    <>
      <AppHeader
        title="Companies"
        subtitle={
          `${rows.length} followed · ${onTheBook} on the book` +
          (marked !== onTheBook ? ` · ${marked} marked holding` : '')
        }
      />

      <div className="co-bar">
        <div className="form-actions">
          <DialogButton
            label="Add"
            title="Add a name"
            className="btn btn-primary"
            buttonTitle="Search the exchange's security master and start following a company"
          >
            <FollowPicker search={searchSecurities} follow={followCompany} />
          </DialogButton>
          <span className="co-note">
            {rows.length === 0
              ? 'Nothing is followed yet, so every screen is empty by fact rather than by fault.'
              : `Following a name attaches the filings already held for it and starts its results, prices and calendar from the next run.`}
          </span>
        </div>
      </div>

      <div className="page">
        <Card
          title={showRemoved ? 'Removed names' : 'Followed names'}
          action={
            <Seg
              current={showRemoved ? '/companies?filter=removed' : '/companies'}
              options={[
                { label: 'Followed', href: '/companies', count: rows.length },
                {
                  label: 'Removed',
                  href: '/companies?filter=removed',
                  count: removed.length,
                  disabled: removed.length === 0 && !showRemoved,
                  why: 'No name has been removed',
                },
              ]}
              small
            />
          }
          padded={false}
        >
          {showRemoved ? (
            removed.length === 0 ? (
              <Empty>No name has been removed. Remove is on each company's own page.</Empty>
            ) : (
              <RemovedTable rows={removed} />
            )
          ) : rows.length === 0 ? (
            <Empty>
              No names yet. Following a company starts its filings, results and calendar from the
              next run.
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
                        {/* Where the name is in the backfill queue, beside where a person has put
                            it. Absent once its history has arrived clean, which is most names most
                            of the time — this is the row that would otherwise look identical to a
                            company with nothing to say. */}
                        {r.backfill && (
                          <span title={r.backfillNote ?? undefined}>
                            <Chip tone={BACKFILL_TONE[r.backfill] ?? 'neutral'}>{r.backfill}</Chip>
                          </span>
                        )}
                      </td>
                      <td>
                        {r.sector ?? <Blank why="No sector set" />}
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
                        {/* The `why` has to name the cause, not the symptom. "No price row joins
                            this name yet" is true of a name queued an hour ago and of one whose
                            backfill gave up, and those want different things from the reader. */}
                        {r.lastClose ? inr(r.lastClose) : <Blank why={priceWhy(r.backfill)} />}
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

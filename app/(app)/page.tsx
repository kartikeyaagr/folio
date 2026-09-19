import Link from 'next/link';

import { desk, upcoming, type DeskItem } from '@/lib/alerts.ts';
import { AppHeader, Blank, Card, Empty, Stat, StatRow } from '@/components/ui.tsx';

import { acknowledgeAlert, completeReminderAction } from '../_lib/actions/desk.ts';
import { requireUser } from '../_lib/session.ts';

/**
 * C2 — what changed since yesterday.
 *
 * One screen, one question. v2 aggregated four sources onto a page and made you read all of them
 * to find out whether anything needed you; this orders by severity and stops.
 *
 * Nothing here is scoped to the reader. Coverage decides who gets *told*, not who may look — an
 * analyst on leave still has a book, and a desk that hid another person's alerts would make two
 * people's screens disagree about what the fund is dealing with.
 */

export const dynamic = 'force-dynamic';

/**
 * Severity, as the row's dot.
 *
 * The dot is the design system's list marker and carries the only colour on the row — three
 * meanings and never a fourth. `low` gets no colour at all rather than a fifth: something the
 * system rated low should not be competing for attention with something it rated critical.
 */
const DOT: Record<string, string> = {
  critical: 'is-bad', high: 'is-warn', normal: 'is-navy', low: 'is-none',
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical', high: 'High', normal: 'Normal', low: 'Low',
};

function when(at: Date): string {
  const hours = (Date.now() - at.getTime()) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

function DeskRow({ item }: { item: DeskItem }) {
  const action = item.kind === 'alert' ? acknowledgeAlert : completeReminderAction;
  return (
    <li className="item has-act">
      <span className={`item-dot ${DOT[item.severity] ?? 'is-none'}`} />
      <div className="item-main">
        <p className={`item-kind ${item.severity === 'critical' ? 'is-bad' : ''}`}>
          <span>{item.kind === 'reminder' ? 'Reminder' : SEVERITY_LABEL[item.severity] ?? item.severity}</span>
          {item.symbol ? (
            <Link href={`/company/${item.symbol}`}>{item.symbol}</Link>
          ) : (
            <span>the fund</span>
          )}
          <span>{when(item.at)}</span>
        </p>
        <p className="item-title">{item.title}</p>
        {item.detail && <p className="item-sub">{item.detail}</p>}
      </div>
      <form action={action}>
        <input type="hidden" name="id" value={item.id} />
        <button type="submit" className="btn btn-quiet btn-sm">
          {item.kind === 'alert' ? 'Acknowledge' : 'Done'}
        </button>
      </form>
    </li>
  );
}

export default async function DeskPage() {
  await requireUser();
  const [items, soon] = await Promise.all([desk(), upcoming(14)]);

  const counts = {
    critical: items.filter((i) => i.severity === 'critical').length,
    open: items.length,
    reminders: items.filter((i) => i.kind === 'reminder').length,
  };

  return (
    <>
      <AppHeader
        title="Desk"
        subtitle={
          counts.open === 0
            ? 'Nothing waiting'
            : `${counts.open} waiting · ${counts.critical} critical · ${counts.reminders} reminders`
        }
      />

      <div className="page desk">
        <StatRow>
          <Stat label="Waiting" value={String(counts.open)} />
          <Stat
            label="Critical"
            value={String(counts.critical)}
            tone={counts.critical > 0 ? 'bad' : undefined}
          />
          <Stat label="Next 14 days" value={String(soon.length)} sub="scheduled events" />
        </StatRow>

        <Card
          title="What changed"
          action={<Link href="/filings">All filings →</Link>}
        >
          {items.length === 0 ? (
            <Empty>
              Nothing is waiting. Alerts are raised when a filing, disclosure or price move
              matches a rule.
            </Empty>
          ) : (
            <ul className="desk-items">
              {items.map((item) => (
                <DeskRow key={`${item.kind}-${item.id}`} item={item} />
              ))}
            </ul>
          )}
        </Card>

        <Card title="Coming up">
          {soon.length === 0 ? (
            <Empty>
              No board meetings or results dates scheduled in the next fortnight.
            </Empty>
          ) : (
            <ul className="desk-soon">
              {soon.map((e) => (
                <li key={e.id}>
                  <span className="desk-soon-when">{e.onDate}</span>
                  <b>{e.symbol ?? <Blank why="This event is not linked to a followed company" />}</b>
                  <span className="desk-soon-detail">{e.title}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

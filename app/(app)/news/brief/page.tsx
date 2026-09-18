import Link from 'next/link';

import { brief, briefInFlight, briefs, pendingBrief } from '@/lib/briefs.ts';
import { Brief } from '@/components/Brief.tsx';
import { AppHeader, Card, Empty, Eyebrow } from '@/components/ui.tsx';

import { askForBrief } from '../../../_lib/actions/brief.ts';
import { requireUser } from '../../../_lib/session.ts';

/**
 * Agent 6's output, where somebody reads it.
 *
 * Prompted rather than scheduled, and this is the screen that makes that decision work: v2 mailed a
 * brief at 06:30 whether or not anybody wanted one, and it became something to dismiss. A brief you
 * asked for ten seconds ago is a brief you are about to read.
 *
 * The page always says which of four states it is in — one is being written, one is waiting on a
 * person, here is the last one, or nobody has ever asked. A page that showed yesterday's brief while
 * today's sat unaccepted in a queue would be quietly wrong at the moment it mattered.
 */

export const dynamic = 'force-dynamic';

function ist(at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(at);
}

export default async function BriefsPage() {
  await requireUser();
  const [list, waiting, inFlight] = await Promise.all([
    briefs(), pendingBrief(), briefInFlight(),
  ]);
  const latest = list[0] ? await brief(list[0].id) : null;

  return (
    <>
      <AppHeader
        title="Brief"
        subtitle={
          latest ? `Last written ${ist(latest.writtenAt)}` : 'No brief has been written yet'
        }
        back="/news"
        backTitle="News"
      />

      <div className="page">
        <Card title="Ask for a brief">
          <form action={askForBrief} className="ask-form">
            <span className="ask-label">Cover the last</span>
            <select className="field" name="days" defaultValue="7" aria-label="Period to cover">
              <option value="3">3 days</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </select>
            <button type="submit" className="btn btn-primary" disabled={inFlight || waiting !== null}>
              Ask
            </button>
          </form>
          <p className="hint">
            Every followed name, filings first, using only confirmed news. The brief waits in
            Review until someone accepts it.
          </p>
        </Card>

        {inFlight && (
          <p className="notice">
            A brief is being written. It runs on the next agent sweep and then waits in{' '}
            <Link href="/review">Review</Link>.
          </p>
        )}

        {waiting && (
          <p className="notice">
            A brief was written {ist(waiting.createdAt)} and is waiting for somebody to accept it in{' '}
            <Link href="/review">Review</Link>. It is not shown here until then.
          </p>
        )}

        {latest ? (
          <Card
            title={latest.title}
            action={
              <span className="draft-meta">
                accepted by {latest.acceptedBy ?? 'somebody'} · {ist(latest.writtenAt)}
              </span>
            }
          >
            <Brief content={latest.content} />
          </Card>
        ) : (
          <Card title="No brief yet">
            <Empty>
              Nobody has asked for one. A brief covers what each followed name filed, what news was
              confirmed, and what is scheduled, including the names that had nothing.
            </Empty>
          </Card>
        )}

        {list.length > 1 && (
          <Card title="Earlier">
            <Eyebrow>{list.length - 1} before this one</Eyebrow>
            <ul className="item-plain">
              {list.slice(1).map((b) => (
                <li key={b.id}>
                  <span className="num">{ist(b.writtenAt)}</span>
                  <b>
                    <Link href={`/news/brief/${b.id}`}>{b.title}</Link>
                  </b>
                  <span>
                    {b.covered} {b.covered === 1 ? 'name' : 'names'}
                    {b.quiet > 0 && `, ${b.quiet} quiet`}
                  </span>
                  <span>{b.acceptedBy ?? ''}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}

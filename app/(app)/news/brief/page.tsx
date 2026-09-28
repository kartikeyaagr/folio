import Link from 'next/link';

import { ASKABLE_DAYS, brief, briefInFlight, briefs, provenance } from '@/lib/briefs.ts';
import { Brief } from '@/components/Brief.tsx';
import { AppHeader, Card, Empty, Eyebrow } from '@/components/ui.tsx';

import { askForBrief } from '../../../_lib/actions/brief.ts';
import { requireUser } from '../../../_lib/session.ts';
import { weekdayTime } from '@/components/ui';

/**
 * Agent 6's output, where somebody reads it.
 *
 * The brief writes itself at 08:00 IST, is published without review and is mailed to everybody,
 * by the fund's decision of 28-Sep-2026 (migration 0067). So this page leads with the latest brief
 * and says where it came from. Nobody read it before it went out, and the page must not let it
 * pass for something somebody accepted. Asking for another, over a longer window, still works.
 *
 * The page always says which of three states it is in: one is being written, here is the last
 * one, or none has been written yet.
 */

export const dynamic = 'force-dynamic';

export default async function BriefsPage() {
  await requireUser();
  const [list, inFlight] = await Promise.all([briefs(), briefInFlight()]);
  const latest = list[0] ? await brief(list[0].id) : null;

  return (
    <>
      <AppHeader
        title="Brief"
        subtitle={
          latest ? `Last written ${weekdayTime(latest.writtenAt)}` : 'No brief has been written yet'
        }
        back="/news"
        backTitle="News"
      />

      <div className="page">
        {inFlight && (
          <p className="notice">
            A brief is being written. It runs on the next agent sweep, then appears here and is
            mailed to everybody.
          </p>
        )}

        {latest ? (
          <Card
            title={latest.title}
            action={
              <span className="draft-meta">{provenance(latest, weekdayTime(latest.writtenAt))}</span>
            }
          >
            <Brief content={latest.content} />
          </Card>
        ) : (
          <Card title="No brief yet">
            <Empty>
              The first arrives at 08:00 IST, or ask for one below. A brief covers what each
              followed name filed, what news was confirmed, and what is scheduled, including the
              names that had nothing.
            </Empty>
          </Card>
        )}

        <Card title="Ask for another">
          <form action={askForBrief} className="ask-form">
            <span className="ask-label">Cover the last</span>
            <select className="field" name="days" defaultValue="7" aria-label="Period to cover">
              {ASKABLE_DAYS.map((d) => (
                <option key={d} value={d}>{d} days</option>
              ))}
            </select>
            <button type="submit" className="btn btn-primary" disabled={inFlight}>
              Ask
            </button>
          </form>
          <p className="hint">
            A brief arrives by itself every morning at 08:00 IST, covering the last 24 hours. Ask
            here for one over a longer window. Every followed name, filings first, using only
            confirmed news. It is published as soon as it is written, without review, and mailed
            to everybody.
          </p>
        </Card>

        {list.length > 1 && (
          <Card title="Earlier">
            <Eyebrow>{list.length - 1} before this one</Eyebrow>
            <ul className="item-plain">
              {list.slice(1).map((b) => (
                <li key={b.id}>
                  <span className="num">{weekdayTime(b.writtenAt)}</span>
                  <b>
                    <Link href={`/news/brief/${b.id}`}>{b.title}</Link>
                  </b>
                  <span>
                    {b.covered} {b.covered === 1 ? 'name' : 'names'}
                    {b.quiet > 0 && `, ${b.quiet} quiet`}
                  </span>
                  <span>{b.published ? 'not reviewed' : (b.acceptedBy ?? '')}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}

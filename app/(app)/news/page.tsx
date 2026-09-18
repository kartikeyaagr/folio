import Link from 'next/link';

import { newsFor } from '@/lib/engagement.ts';
import { ungated } from '@/lib/news/gate.ts';
import { ailingSources } from '@/lib/news/poll.ts';
import { AppHeader, Card, Empty, Seg, Stat, StatRow } from '@/components/ui.tsx';

import { markNews } from '../../_lib/actions/news.ts';
import { requireUser } from '../../_lib/session.ts';

/**
 * C4 — news on our names, with the reason it matched.
 *
 * **The mechanism is the feature, not a tooltip.** It sits under every headline in the reader's
 * line of sight, because an unexplained match trains you to distrust the next one — and the whole
 * reason a gate exists rather than a confidence score is that a sentence can be disagreed with.
 *
 * Nothing ungated is rendered here at any price. A candidate the gate has not judged, or could not,
 * is not a weaker story; it is a story nobody has given a reason for.
 */

export const dynamic = 'force-dynamic';

function when(at: Date | null): string {
  if (!at) return 'undated';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short',
  }).format(at);
}

export default async function NewsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const showDismissed = params.show === 'dismissed';

  const [items, ailing, stuck] = await Promise.all([
    newsFor(user.userId, { days: 30, includeDismissed: showDismissed }),
    ailingSources(),
    ungated(),
  ]);

  const visible = showDismissed ? items.filter((i) => i.state === 'dismissed') : items;
  const unread = items.filter((i) => i.state === null).length;

  return (
    <>
      <AppHeader
        title="News"
        subtitle={`${visible.length} in 30 days · ${unread} unread`}
      />

      <div className="page">
        <StatRow>
          <Stat label="Confirmed" value={String(items.length)} sub="last 30 days" />
          <Stat label="Unread" value={String(unread)} />
          <Stat
            label="Feeds failing"
            value={String(ailing.length)}
            sub={ailing.length ? ailing.map((a) => a.key).join(', ') : 'all polling'}
            tone={ailing.length > 0 ? 'warn' : undefined}
          />
          <Stat label="Brief" value={<Link href="/news/brief">Ask for one →</Link>} sub="every followed name" />
        </StatRow>

        {/*
          A quiet page has two causes and they look identical: nothing happened, or the feeds are
          down. Saying which is the whole point of recording the outcome on each source's row.
        */}
        {ailing.length > 0 && (
          <p className="notice">
            {ailing.length} {ailing.length === 1 ? 'feed is' : 'feeds are'} failing to poll
            {' — '}
            {ailing.map((a) => `${a.label} (${a.lastError ?? 'unknown'})`).join('; ')}. A quiet page
            may be a quiet week or may be this.
          </p>
        )}

        {stuck.length > 0 && (
          <p className="notice">
            {stuck.length} {stuck.length === 1 ? 'story' : 'stories'} could not be judged and are
            not shown. The gate stopped retrying them: {stuck[0]?.lastError ?? 'no reason recorded'}.
          </p>
        )}

        <Card
          title="Matched"
          action={
            <Seg
              current={showDismissed ? '/news?show=dismissed' : '/news'}
              options={[
                { label: 'Current', href: '/news' },
                { label: 'Dismissed', href: '/news?show=dismissed' },
              ]}
            />
          }
          padded={false}
        >
          {visible.length === 0 ? (
            <Empty>
              {showDismissed
                ? 'Nothing has been dismissed. Dismissed items are kept.'
                : 'No news has been matched to a followed name in the last 30 days. Only stories the gate could state a mechanism for appear here.'}
            </Empty>
          ) : (
            <ul className="news-list">
              {visible.map((n) => (
                <li key={n.id} className={`news-item${n.state === 'read' ? ' is-read' : ''}`}>
                  <div className="news-main">
                    <p className="item-kind">
                      <Link href={`/company/${n.symbol}`}>{n.symbol}</Link>
                      <span>{n.source}</span>
                      {/*
                        The other outlets that ran the same article. One story, one row — but three
                        outlets running it is not the same event as one trade title running it.
                      */}
                      {n.alsoIn.length > 0 && (
                        <span title={`The same article also ran in: ${n.alsoIn.join(', ')}`}>
                          +{n.alsoIn.length} more
                        </span>
                      )}
                      <span>{when(n.publishedAt)}</span>
                    </p>
                    <a className="news-title" href={n.url} target="_blank" rel="noreferrer">
                      {n.title}
                    </a>
                    {/*
                      Never collapsed, never a tooltip. C4's whole point is that the reason travels
                      with the story.
                    */}
                    <p className="news-why">{n.mechanism}</p>
                  </div>
                  <div className="news-acts">
                    {n.state === null && (
                      <form action={markNews}>
                        <input type="hidden" name="id" value={n.id} />
                        <input type="hidden" name="state" value="read" />
                        <button type="submit" className="btn btn-quiet btn-sm">Read</button>
                      </form>
                    )}
                    <form action={markNews}>
                      <input type="hidden" name="id" value={n.id} />
                      <input type="hidden" name="state" value={n.state === 'dismissed' ? 'clear' : 'dismissed'} />
                      <button type="submit" className="btn btn-quiet btn-sm">
                        {n.state === 'dismissed' ? 'Restore' : 'Dismiss'}
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

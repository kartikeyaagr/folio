import Link from 'next/link';

import { newsFor } from '@/lib/engagement.ts';
import { ungated } from '@/lib/news/gate.ts';
import { ailingSources } from '@/lib/news/poll.ts';
import { isSection, stream, streamFacets, type Section, type Story } from '@/lib/news/stream.ts';
import {
  AppHeader, Blank, Card, Empty, LinkButton, Seg, Stat, StatRow, Tabs, dayMonth, dayMonthTime,
} from '@/components/ui.tsx';

import { markNews } from '../../_lib/actions/news.ts';
import { requireUser } from '../../_lib/session.ts';

/**
 * News: every story the major outlets ran, and the ones on our names.
 *
 * **Until 28-Sep-2026 this page showed confirmed company matches and nothing else**, on 0018's rule
 * that a candidate is never shown, only a stated mechanism is. The user reversed that on
 * 28-Sep-2026. The default tab is now every story from the outlets in the stream (0065, 0066): one
 * row per story however many outlets carry it, merged on exact keys (`lib/news/stories.ts`), and
 * never scored or ranked by a model. The confirmed view is the Ours tab, unchanged, and the rule
 * below still holds there.
 *
 * C4, on Ours — **the mechanism is the feature, not a tooltip.** It sits under every headline in
 * the reader's line of sight, because an unexplained match trains you to distrust the next one —
 * and the whole reason a gate exists rather than a confidence score is that a sentence can be
 * disagreed with. Nothing ungated is rendered there at any price.
 */

export const dynamic = 'force-dynamic';

/** "undated" rather than a dash: a feed item with no date is a fact about the feed. */
const when = (at: Date | null): string => (at ? dayMonth(at) : 'undated');

const SECTION_LABEL: Record<Section, string> = {
  india: 'India', world: 'World', politics: 'Politics', business: 'Business',
  companies: 'Companies', markets: 'Markets', economy: 'Economy', industry: 'Industry',
  tech: 'Tech', official: 'Official',
};

const WINDOWS = [[6, '6 hours'], [24, '24 hours'], [72, '3 days']] as const;

/** A page of stories. 1,675 stories fell in the 24 hours to 16:00 on 28-Sep-2026. */
const PAGE = 200;

interface AllState {
  hours: number;
  section: Section | null;
  outlet: string | null;
  page: number;
}

/** Every filter is a plain link. Changing one goes back to the first page. */
function allHref(s: AllState): string {
  const q = new URLSearchParams();
  if (s.hours !== 24) q.set('hours', String(s.hours));
  if (s.section) q.set('section', s.section);
  if (s.outlet) q.set('outlet', s.outlet);
  if (s.page > 1) q.set('page', String(s.page));
  const query = q.toString();
  return query ? `/news?${query}` : '/news';
}

export default async function NewsPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string; show?: string; hours?: string; section?: string; outlet?: string; page?: string;
  }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  // ?show=dismissed predates the tabs and only ever meant Ours, so a link to it still lands there.
  const tab = params.tab === 'ours' || params.show === 'dismissed' ? 'ours' : 'all';
  const ailing = await ailingSources();

  const tabs = (
    <Tabs
      bar
      current={tab === 'ours' ? '/news?tab=ours' : '/news'}
      tabs={[['/news', 'All'], ['/news?tab=ours', 'Ours']]}
    />
  );

  /*
    A quiet page has two causes and they look identical: nothing happened, or the feeds are down.
    Saying which is the whole point of recording the outcome on each source's row.
  */
  const ailingNotice = ailing.length > 0 && (
    <p className="notice">
      {ailing.length} {ailing.length === 1 ? 'feed is' : 'feeds are'} failing to poll
      {' — '}
      {ailing.map((a) => `${a.label} (${a.lastError ?? 'unknown'})`).join('; ')}. A quiet page
      may be a quiet week or may be this.
    </p>
  );

  if (tab === 'all') {
    const hoursParam = Number(params.hours);
    const state: AllState = {
      hours: WINDOWS.some(([h]) => h === hoursParam) ? hoursParam : 24,
      section: isSection(params.section) ? params.section : null,
      outlet: params.outlet?.trim() || null,
      page: Math.max(1, Math.floor(Number(params.page)) || 1),
    };
    const windowLabel = WINDOWS.find(([h]) => h === state.hours)?.[1] ?? '24 hours';
    const [facets, { stories, total }] = await Promise.all([
      streamFacets(),
      stream({
        hours: state.hours, section: state.section, outlet: state.outlet,
        limit: PAGE, offset: (state.page - 1) * PAGE,
      }),
    ]);
    const first = (state.page - 1) * PAGE + 1;
    const filtered = state.section !== null || state.outlet !== null;

    return (
      <>
        <AppHeader
          title="News"
          subtitle={`${total} stories in ${windowLabel} · ${facets.outlets.length} outlets`}
        />
        {tabs}

        <div className="page">
          <StatRow>
            <Stat label="Stories" value={String(total)} sub={`last ${windowLabel}`} />
            <Stat label="Outlets" value={String(facets.outlets.length)} sub="in the stream" />
            <Stat
              label="Feeds failing"
              value={String(ailing.length)}
              sub={ailing.length ? ailing.map((a) => a.key).join(', ') : 'all polling'}
              tone={ailing.length > 0 ? 'warn' : undefined}
            />
            <Stat
              label="Last polled"
              value={facets.lastPolledAt
                ? dayMonthTime(facets.lastPolledAt)
                : <Blank why="never polled" />}
            />
          </StatRow>

          {ailingNotice}

          <Card
            title="Stories"
            padded={false}
            action={
              <Seg
                small
                current={allHref({ ...state, page: 1 })}
                options={WINDOWS.map(([h, label]) => ({
                  label, href: allHref({ ...state, hours: h, page: 1 }),
                }))}
              />
            }
          >
            <div className="stream-filters">
              <nav className="stream-filter" aria-label="Section">
                <a
                  href={allHref({ ...state, section: null, page: 1 })}
                  aria-current={state.section === null ? 'true' : undefined}
                >
                  Every section
                </a>
                {facets.sections.map((s) => (
                  <a
                    key={s}
                    href={allHref({ ...state, section: s, page: 1 })}
                    aria-current={state.section === s ? 'true' : undefined}
                  >
                    {SECTION_LABEL[s]}
                  </a>
                ))}
              </nav>
              <nav className="stream-filter" aria-label="Outlet">
                <a
                  href={allHref({ ...state, outlet: null, page: 1 })}
                  aria-current={state.outlet === null ? 'true' : undefined}
                >
                  Every outlet
                </a>
                {facets.outlets.map((o) => (
                  <a
                    key={o}
                    href={allHref({ ...state, outlet: o, page: 1 })}
                    aria-current={state.outlet === o ? 'true' : undefined}
                  >
                    {o}
                  </a>
                ))}
              </nav>
            </div>

            {stories.length === 0 ? (
              <Empty>
                {filtered
                  ? `No story in the last ${windowLabel} matches these filters.`
                  : facets.lastPolledAt
                    ? `No story from ${facets.outlets.length} outlets in the last ` +
                      `${windowLabel}. The feeds were last polled ` +
                      `${dayMonthTime(facets.lastPolledAt)}.`
                    : 'The feeds have not been polled yet.'}
              </Empty>
            ) : (
              <ul className="news-list">
                {stories.map((s) => <StoryRow key={s.id} story={s} state={state} />)}
              </ul>
            )}

            {total > PAGE && (
              <nav className="stream-pager" aria-label="Pages">
                <span>
                  {first}–{first + stories.length - 1} of {total}
                </span>
                {state.page > 1 && (
                  <LinkButton small tone="quiet" href={allHref({ ...state, page: state.page - 1 })}>
                    Newer
                  </LinkButton>
                )}
                {first + stories.length - 1 < total && (
                  <LinkButton small tone="quiet" href={allHref({ ...state, page: state.page + 1 })}>
                    Older
                  </LinkButton>
                )}
              </nav>
            )}
          </Card>
        </div>
      </>
    );
  }

  // Ours: the confirmed-match view as it was before 28-Sep-2026, links aside.
  const showDismissed = params.show === 'dismissed';
  const [items, stuck] = await Promise.all([
    newsFor(user.userId, { days: 30, includeDismissed: showDismissed }),
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
      {tabs}

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

        {ailingNotice}

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
              current={showDismissed ? '/news?tab=ours&show=dismissed' : '/news?tab=ours'}
              options={[
                { label: 'Current', href: '/news?tab=ours' },
                { label: 'Dismissed', href: '/news?tab=ours&show=dismissed' },
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

/**
 * One story: who ran it, where it sits, when, and the headline out to the publisher.
 *
 * Two outlet names and a count, not all of them: the reader wants to know a story got pickup, and
 * the full list is in the title for anyone who wants it. Each name filters the stream to that
 * outlet. A followed company leads the line, as the symbol does on Ours, because a confirmed match
 * is the one thing on this row the desk has already judged.
 */
function StoryRow({ story: s, state }: { story: Story; state: AllState }) {
  const shown = s.outlets.slice(0, 2);
  const more = s.outlets.slice(2);
  return (
    <li className="news-item is-story">
      <div className="news-main">
        <p className="item-kind">
          {s.companies.map((sym) => (
            <Link key={sym} className="story-co" href={`/company/${sym}`}>{sym}</Link>
          ))}
          <span className="story-outlets">
            {shown.map((o) => (
              <a key={o} href={allHref({ ...state, outlet: o, page: 1 })}>{o}</a>
            ))}
            {more.length > 0 && (
              <span title={`Also carried by ${more.join(', ')}`}>+{more.length} more</span>
            )}
          </span>
          <span>{s.section ? SECTION_LABEL[s.section] : <Blank why="no section" />}</span>
          <span>{s.publishedAt ? dayMonthTime(s.publishedAt) : 'undated'}</span>
        </p>
        <a className="news-title" href={s.url} target="_blank" rel="noreferrer">
          {s.title}
        </a>
      </div>
    </li>
  );
}

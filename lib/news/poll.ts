/**
 * Polling the feeds.
 *
 * Every feed's outcome is recorded **on its own row** — when it was last polled, whether that
 * worked, and the error if it did not. A run that fetches 96 feeds and reports one number cannot
 * tell you that Business Standard has been 403ing for a week while the total stayed healthy, and
 * that is exactly the failure this system keeps having: a dead source that looks like a quiet one.
 *
 * The job as a whole fails only when *every* feed fails, which is a network or DNS problem rather
 * than a publisher problem. One dead feed is a fact about that feed.
 */

import { createHash } from 'node:crypto';
import { serviceTxn } from '../db.ts';
import { NotAFeed, parseFeed, type FeedItem } from './rss.ts';
import { assignStories } from './stories.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/** Politeness, and a bound on how long the job can take: 96 feeds, eight at a time. */
const CONCURRENCY = 8;
const TIMEOUT_MS = 30_000;

/**
 * A feed whose newest item is older than this is dead, however well-formed it is.
 *
 * Lesson L23's failure, which nothing caught until 28-Sep-2026: a feed that answers 200 with a
 * full, frozen history. Five seeded Moneycontrol feeds had been doing it since 23-Apr-2024 and were
 * recorded 'ok' on every poll in between. The youngest frozen feed found that day was 452 days old
 * (MarketWatch's market pulse); the slowest live one publishes weekly and skips a week at the
 * year's end. Twenty-one days clears a skipped week with room, and names a dead feed in three weeks
 * rather than in five hundred days.
 *
 * Undated items cannot be judged and do not count; a feed with no dates at all is never stale.
 */
export const STALE_DAYS = 21;

export interface Source {
  key: string;
  url: string;
}

export interface FeedOutcome {
  key: string;
  ok: boolean;
  items: number;
  stored: number;
  /** Items given a story while this feed was stored, and how many joined one already running. */
  assigned: number;
  joined: number;
  error: string | null;
}

/**
 * How the bytes are got, injected so the tests can drive a whole poll without a network.
 *
 * **It must throw on anything that is not a 200, and that is the contract rather than a detail of
 * `httpFetch`.** `pollOne` decides a feed is healthy by whether this resolved; a fetcher that
 * handed back a 403 page's body as a string would produce a feed recorded as serving a document
 * that is not RSS — the right row, marked failed, carrying the wrong diagnosis, and a reader sent
 * to inspect the publisher's XML rather than a blocked request.
 */
export type Fetcher = (url: string) => Promise<string>;

const httpFetch: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

const itemId = (sourceKey: string, guid: string): string =>
  createHash('sha256').update(`${sourceKey} ${guid}`).digest('hex').slice(0, 32);

export interface Stored {
  stored: number;
  assigned: number;
  joined: number;
}

/**
 * Store what one feed returned, and give every new item its story in the same transaction.
 *
 * Re-polling an overlapping window is an upsert, not a duplicate. The story sweep runs even when
 * nothing new was stored, because it asks what has no story yet rather than what this feed brought.
 */
export async function storeItems(sourceKey: string, items: FeedItem[]): Promise<Stored> {
  if (items.length === 0) return { stored: 0, assigned: 0, joined: 0 };
  return serviceTxn('system:news', async (c) => {
    let stored = 0;
    for (const it of items) {
      const { rowCount } = await c.query(
        `INSERT INTO news_items (id, source_key, guid, url, title, summary, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (source_key, guid) DO NOTHING`,
        [itemId(sourceKey, it.guid), sourceKey, it.guid, it.url, it.title, it.summary, it.publishedAt],
      );
      // Only new headlines are counted. A feed that returns the same fifteen stories every hour has
      // not brought fifteen stories every hour.
      stored += rowCount ?? 0;
    }
    return { stored, ...(await assignStories(c)) };
  });
}

/** How old the newest dated item is, in whole days, or null when nothing carries a date. */
function newestAgeDays(items: FeedItem[], now = Date.now()): number | null {
  const dated = items.flatMap((i) => (i.publishedAt ? [Date.parse(i.publishedAt)] : []));
  return dated.length === 0 ? null : Math.floor((now - Math.max(...dated)) / 86_400_000);
}

async function pollOne(source: Source, fetcher: Fetcher): Promise<FeedOutcome> {
  const failed = (items: number, error: string): FeedOutcome =>
    ({ key: source.key, ok: false, items, stored: 0, assigned: 0, joined: 0, error });
  try {
    const items = parseFeed(await fetcher(source.url));
    // Zero items from a document that *is* a feed is still a failure. A publisher's feed is never
    // legitimately empty; an empty one means the URL now points somewhere else.
    if (items.length === 0) return failed(0, 'feed returned zero items');
    // Nothing is stored from a frozen feed: its items are years old and it is failing, not quiet.
    const age = newestAgeDays(items);
    if (age !== null && age > STALE_DAYS) {
      return failed(items.length, `newest item is ${age} days old`);
    }
    const stored = await storeItems(source.key, items);
    return { key: source.key, ok: true, items: items.length, ...stored, error: null };
  } catch (err) {
    const message = err instanceof NotAFeed
      ? 'response is not an RSS or Atom document'
      : String(err instanceof Error ? err.message : err).slice(0, 300);
    return failed(0, message);
  }
}

/** Run a bounded number of promises at a time. */
async function inBatches<T, R>(xs: T[], size: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += size) {
    out.push(...(await Promise.all(xs.slice(i, i + size).map(f))));
  }
  return out;
}

export interface PollResult {
  feeds: number;
  ok: number;
  stored: number;
  /** Items given a story this run, and how many joined one already running. `assigned - joined`
   *  is the number of new stories; the first run after 0065 also assigns every older item. */
  assigned: number;
  joined: number;
  failures: FeedOutcome[];
}

/**
 * Poll every active source once, eight at a time, and record each outcome on its own row.
 *
 * **It does not throw for a feed that failed.** A dead publisher is data, not an exception: the
 * outcome goes into `failures` and onto `news_sources.last_status`/`last_error`, and the caller
 * decides what is fatal. `jobs/news-poll.ts` raises only when `ok === 0`, which is a network or
 * DNS problem rather than a publisher problem. The return value is what the run reports; the row
 * is what answers "why has this source shown nothing for a week" a month later, and that is the
 * whole reason both exist.
 *
 * `stored` counts rows that did not already exist, never items served. A feed republishing the
 * same fifteen stories every hour contributes `items: 15, stored: 0` and is perfectly healthy, so
 * a run whose `stored` is zero is not by itself a failing run — `ok` against `feeds` is the figure
 * that says whether the poll worked.
 *
 * Only `active` sources are polled, and switching a source off has to mean off — `matchNewItems`
 * applies the same `s.active` test to the backlog a retired feed already fetched. PIB is seeded
 * inactive on purpose: its RSS is Hindi whatever `Lang` claims, and it carries no dates and no
 * guids (`tasks/measured-traps.md`, News).
 */
export async function pollFeeds(fetcher: Fetcher = httpFetch): Promise<PollResult> {
  const sources = await serviceTxn('system:news', async (c) => {
    const { rows } = await c.query<Source>(
      'SELECT key, url FROM news_sources WHERE active ORDER BY key',
    );
    return rows;
  });

  const outcomes = await inBatches<Source, FeedOutcome>(
    sources, CONCURRENCY, (s) => pollOne(s, fetcher),
  );

  await serviceTxn('system:news', async (c) => {
    for (const o of outcomes) {
      await c.query(
        `UPDATE news_sources
            SET last_polled_at = now(), last_status = $2, last_error = $3
          WHERE key = $1`,
        [o.key, o.ok ? 'ok' : 'failed', o.error],
      );
    }
  });

  return {
    feeds: sources.length,
    ok: outcomes.filter((o) => o.ok).length,
    stored: outcomes.reduce((n, o) => n + o.stored, 0),
    assigned: outcomes.reduce((n, o) => n + o.assigned, 0),
    joined: outcomes.reduce((n, o) => n + o.joined, 0),
    failures: outcomes.filter((o) => !o.ok),
  };
}

/** Feeds that have been failing, for anyone asking why the page looks quiet. */
export async function ailingSources(): Promise<
  { key: string; label: string; lastPolledAt: Date | null; lastError: string | null }[]
> {
  return serviceTxn('system:news', async (c) => {
    const { rows } = await c.query<{
      key: string; label: string; lastPolledAt: Date | null; lastError: string | null;
    }>(
      `SELECT key, label, last_polled_at AS "lastPolledAt", last_error AS "lastError"
         FROM news_sources
        WHERE active AND last_status = 'failed'
        ORDER BY key`,
    );
    return rows;
  });
}

/**
 * Polling the feeds.
 *
 * Every feed's outcome is recorded **on its own row** — when it was last polled, whether that
 * worked, and the error if it did not. A run that fetches 56 feeds and reports one number cannot
 * tell you that Business Standard has been 403ing for a week while the total stayed healthy, and
 * that is exactly the failure this system keeps having: a dead source that looks like a quiet one.
 *
 * The job as a whole fails only when *every* feed fails, which is a network or DNS problem rather
 * than a publisher problem. One dead feed is a fact about that feed.
 */

import { createHash } from 'node:crypto';
import { serviceTxn } from '../db.ts';
import { NotAFeed, parseFeed, type FeedItem } from './rss.ts';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/** Politeness, and a bound on how long the job can take: 56 feeds, eight at a time. */
const CONCURRENCY = 8;
const TIMEOUT_MS = 30_000;

export interface Source {
  key: string;
  url: string;
}

export interface FeedOutcome {
  key: string;
  ok: boolean;
  items: number;
  stored: number;
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

/** Store what one feed returned. Re-polling an overlapping window is an upsert, not a duplicate. */
export async function storeItems(sourceKey: string, items: FeedItem[]): Promise<number> {
  if (items.length === 0) return 0;
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
    return stored;
  });
}

async function pollOne(source: Source, fetcher: Fetcher): Promise<FeedOutcome> {
  try {
    const items = parseFeed(await fetcher(source.url));
    // Zero items from a document that *is* a feed is still a failure. A publisher's feed is never
    // legitimately empty; an empty one means the URL now points somewhere else.
    if (items.length === 0) {
      return { key: source.key, ok: false, items: 0, stored: 0, error: 'feed returned zero items' };
    }
    const stored = await storeItems(source.key, items);
    return { key: source.key, ok: true, items: items.length, stored, error: null };
  } catch (err) {
    const message = err instanceof NotAFeed
      ? 'response is not an RSS or Atom document'
      : String(err instanceof Error ? err.message : err).slice(0, 300);
    return { key: source.key, ok: false, items: 0, stored: 0, error: message };
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

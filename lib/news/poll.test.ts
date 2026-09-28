import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readTxn, serviceTxn } from '../db.ts';
import { pollFeeds, STALE_DAYS, storeItems, type Fetcher } from './poll.ts';
import type { FeedItem } from './rss.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `folio_poll_${process.pid}`;

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:news', async (c) => {
    // The seeded feeds are real URLs; a test polls only its own.
    await c.query('UPDATE news_sources SET active = false');
    for (const key of ['a', 'b']) {
      await c.query(
        `INSERT INTO news_sources (key,label,url,tier,market,section,in_stream)
         VALUES ($1,$1,'https://feeds.example/' || $1,2,'india','business',true)`,
        [key],
      );
    }
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:news', async (c) => {
    await c.query('DELETE FROM news_items');
    await c.query(
      `UPDATE news_sources SET active = key IN ('a', 'b'),
              last_polled_at = NULL, last_status = NULL, last_error = NULL`,
    );
  });
});

const daysAgo = (d: number): Date => new Date(Date.now() - d * 86_400_000);

const rss = (...items: { title: string; link: string; at?: Date }[]): string => {
  const entries = items.map((i) =>
    `<item><title>${i.title}</title><link>${i.link}</link>` +
    (i.at ? `<pubDate>${i.at.toUTCString()}</pubDate>` : '') + '</item>');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>${entries.join('')}` +
    '</channel></rss>';
};

/** Serves each URL its body, and anything not listed as a failed request. */
const serving = (bodies: Record<string, string>): Fetcher => async (url) => {
  const body = bodies[url];
  if (body === undefined) throw new Error('HTTP 403');
  return body;
};

const sourceRow = (key: string) => readTxn(async (c) => {
  const { rows } = await c.query<{ status: string | null; error: string | null }>(
    'SELECT last_status AS status, last_error AS error FROM news_sources WHERE key = $1',
    [key],
  );
  return rows[0];
});

const itemCount = () => readTxn(async (c) =>
  (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM news_items')).rows[0]!.n);

// ---- storing ------------------------------------------------------------------------------------

test('storing an overlapping window again counts only what is new', async () => {
  const at = daysAgo(0).toISOString();
  const one: FeedItem = {
    guid: 'g1', url: 'https://x/1', title: 'One', summary: null, publishedAt: at,
  };
  const two: FeedItem = { ...one, guid: 'g2', url: 'https://x/2', title: 'Two' };
  assert.deepEqual(await storeItems('a', [one]), { stored: 1, assigned: 1, joined: 0 });
  assert.deepEqual(await storeItems('a', [one, two]), { stored: 1, assigned: 1, joined: 0 });
  assert.equal(await itemCount(), 2);
});

test('one guid from two publishers is two rows, not one', async () => {
  // A wire story can arrive under the same guid in three outlets (rss.ts). Keyed on guid alone,
  // the second publisher's row would be lost; as a story they are still one.
  const it: FeedItem = {
    guid: 'pti-123', url: 'https://x/wire', title: 'Wire', summary: null, publishedAt: null,
  };
  await storeItems('a', [it]);
  assert.deepEqual(await storeItems('b', [it]), { stored: 1, assigned: 1, joined: 1 });
  assert.equal(await itemCount(), 2);
});

// ---- polling ------------------------------------------------------------------------------------

test('a feed returning zero items is a failure, recorded on its own row', async () => {
  const result = await pollFeeds(serving({
    'https://feeds.example/a': rss(),
    'https://feeds.example/b': rss({ title: 'Story', link: 'https://x/s', at: daysAgo(0) }),
  }));
  assert.equal(result.feeds, 2);
  assert.equal(result.ok, 1, 'the empty feed is not counted as working');
  assert.deepEqual(
    result.failures.map((f) => [f.key, f.error]), [['a', 'feed returned zero items']],
  );
  assert.deepEqual(await sourceRow('a'), { status: 'failed', error: 'feed returned zero items' });
  assert.deepEqual(await sourceRow('b'), { status: 'ok', error: null });
});

test('a refused request and a page that is not a feed fail with their own reasons', async () => {
  const result = await pollFeeds(serving({
    'https://feeds.example/a': '<!doctype html><html><body>Moved</body></html>',
  }));
  assert.equal(result.ok, 0);
  assert.deepEqual(
    Object.fromEntries(result.failures.map((f) => [f.key, f.error])),
    { a: 'response is not an RSS or Atom document', b: 'HTTP 403' },
  );
});

test('a feed serving a frozen history is a failure, and nothing from it is stored', async () => {
  // Five Moneycontrol feeds answered 200 with April 2024 until 28-Sep-2026, 'ok' every time.
  const result = await pollFeeds(serving({
    'https://feeds.example/a': rss(
      { title: 'Old', link: 'https://x/old', at: daysAgo(STALE_DAYS + 9) },
      { title: 'Older', link: 'https://x/older', at: daysAgo(STALE_DAYS + 40) },
    ),
    'https://feeds.example/b':
      rss({ title: 'Slow but alive', link: 'https://x/w', at: daysAgo(STALE_DAYS - 1) }),
  }));
  assert.deepEqual(result.failures.map((f) => [f.key, f.error]),
    [['a', `newest item is ${STALE_DAYS + 9} days old`]]);
  assert.equal(result.stored, 1, 'only the weekly feed stored anything');
});

test('a feed with no dates at all cannot be judged stale', async () => {
  // PIB carries neither dates nor guids; an undated feed is not a frozen one.
  const result = await pollFeeds(serving({
    'https://feeds.example/a': rss({ title: 'Undated', link: 'https://x/u' }),
    'https://feeds.example/b': rss({ title: 'Also undated', link: 'https://x/v' }),
  }));
  assert.equal(result.ok, 2);
});

test('only active sources are polled', async () => {
  await serviceTxn('system:news', (c) =>
    c.query("UPDATE news_sources SET active = false WHERE key = 'b'"));
  const asked: string[] = [];
  await pollFeeds(async (url) => {
    asked.push(url);
    return rss({ title: 'S', link: 'https://x/s', at: daysAgo(0) });
  });
  assert.deepEqual(asked, ['https://feeds.example/a']);
});

test('a poll reports stories beside items: one article at two outlets is one story', async () => {
  const body = rss(
    { title: 'RBI holds repo rate', link: 'https://wire.example/rbi', at: daysAgo(0) },
    { title: 'Sensex falls 1,000 points', link: 'https://x/sensex', at: daysAgo(0) },
  );
  const result = await pollFeeds(serving({
    'https://feeds.example/a': body,
    'https://feeds.example/b':
      rss({ title: 'RBI holds repo rate', link: 'https://y/rbi', at: daysAgo(0) }),
  }));
  assert.equal(result.stored, 3);
  assert.equal(result.assigned - result.joined, 2, 'three items, two stories');
});

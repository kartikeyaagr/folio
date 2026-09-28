import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readTxn, serviceTxn } from '../db.ts';
import { storeItems } from './poll.ts';
import { assignStories } from './stories.ts';
import type { FeedItem } from './rss.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `folio_stories_${process.pid}`;

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:news', async (c) => {
    for (const key of ['et', 'mint', 'bs']) {
      await c.query(
        `INSERT INTO news_sources (key,label,url,tier,market,section,in_stream)
         VALUES ($1,$1,'https://feeds/' || $1,2,'india','business',true)`,
        [key],
      );
    }
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:news', (c) => c.query('DELETE FROM news_items'));
});

const daysAgo = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();

const item = (guid: string, url: string, title: string, published = daysAgo(0)): FeedItem =>
  ({ guid, url, title, summary: null, publishedAt: published });

/** Every stored item's story, keyed by guid — which story is which is the whole assertion. */
const storyOf = () => readTxn(async (c) => {
  const { rows } = await c.query<{ guid: string; story: string | null; id: string }>(
    'SELECT guid, story_id AS story, id FROM news_items ORDER BY guid',
  );
  return Object.fromEntries(rows.map((r) => [r.guid, r]));
});

test('the same URL at two outlets is one story, pointing at the first item stored', async () => {
  await storeItems('et', [item('e1', 'https://pub.example/a/praj-order', 'Praj wins order')]);
  // A different headline and a tracking tag: url_key drops the query string, and the headline is
  // not what joined them.
  await storeItems('mint', [
    item('m1', 'https://pub.example/a/praj-order?utm_source=rss', 'Praj bags ethanol order'),
  ]);
  const s = await storyOf();
  assert.equal(s['e1']?.story, s['e1']?.id, 'the first item is its own story');
  assert.equal(s['m1']?.story, s['e1']?.id, 'the second carrier joins it');
});

test('the same headline at different URLs is one story', async () => {
  const headline = 'Sugar output rises 3% in Maharashtra';
  await storeItems('et', [item('e1', 'https://et.example/1', headline)]);
  await storeItems('bs', [item('b1', 'https://bs.example/9', `${headline}.`)]);
  const s = await storyOf();
  assert.equal(s['b1']?.story, s['e1']?.id);
});

test('one feed linking every item to one page is not one story', async () => {
  // RBI's releases differ only in ?prid=, which url_key drops: ten releases were one story.
  const page = 'https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx';
  await storeItems('et', [
    item('r1', `${page}?prid=61234`, 'Money Market Operations as on September 26, 2026'),
    item('r2', `${page}?prid=61235`, 'Auction of State Government Securities'),
  ]);
  const s = await storyOf();
  assert.equal(s['r2']?.story, s['r2']?.id);
});

test('the same headline 8 days apart is two stories, and 6 days apart is one', async () => {
  await storeItems('et', [item('e1', 'https://et.example/1', 'Markets this week', daysAgo(8))]);
  await storeItems('mint', [item('m1', 'https://mint.example/1', 'Markets this week', daysAgo(0))]);
  await storeItems('bs', [item('b1', 'https://bs.example/1', 'Markets this week', daysAgo(2))]);
  const s = await storyOf();
  assert.equal(s['m1']?.story, s['m1']?.id, 'eight days is outside the window: a story of its own');
  assert.equal(s['b1']?.story, s['e1']?.id, 'six days is inside it');
});

test('the window runs from a story’s first item: a recurring headline cannot chain', async () => {
  // Measured pairwise, day 10 would join day 5, which joined day 0, and one story would run for
  // as long as the column does.
  await storeItems('et', [item('e0', 'https://et.example/0', 'Gold rate today', daysAgo(10))]);
  await storeItems('et', [item('e5', 'https://et.example/5', 'Gold rate today', daysAgo(5))]);
  await storeItems('et', [item('e10', 'https://et.example/10', 'Gold rate today', daysAgo(0))]);
  const s = await storyOf();
  assert.equal(s['e5']?.story, s['e0']?.id);
  assert.equal(s['e10']?.story, s['e10']?.id, 'ten days from the first item is a new story');
});

test('non-Latin headlines are not merged unless they are the same headline', async () => {
  // 0027's trap: an ASCII-only fold turns every Hindi headline into the same empty key. These two
  // differ in their consonants, so they stay apart on any platform's idea of [:alnum:].
  const wheat = 'सरकार ने गेहूं निर्यात पर रोक लगाई';
  await storeItems('et', [item('e1', 'https://et.example/1', wheat)]);
  await storeItems('mint', [item('m1', 'https://mint.example/1', 'बजट में रक्षा खर्च बढ़ा')]);
  await storeItems('bs', [item('b1', 'https://bs.example/1', wheat)]);
  const s = await storyOf();
  assert.equal(s['m1']?.story, s['m1']?.id, 'a different Hindi headline is a different story');
  assert.equal(s['b1']?.story, s['e1']?.id, 'the same Hindi headline is the same story');
});

test('a headline that folds to nothing matches nothing, not every other one', async () => {
  await storeItems('et', [item('e1', 'https://et.example/1', '—')]);
  await storeItems('mint', [item('m1', 'https://mint.example/1', '…')]);
  const s = await storyOf();
  assert.equal(s['m1']?.story, s['m1']?.id);
});

test('two feeds carrying one article in the same poll still make one story', async () => {
  // pollFeeds stores eight feeds at once, each in its own transaction. The first is held open after
  // its sweep, the way a slower feed's would be, while the second carrier is stored: without the
  // lock the second sees nothing committed to join and starts a story of its own.
  let swept!: () => void;
  const firstSwept = new Promise<void>((resolve) => { swept = resolve; });
  const first = serviceTxn('system:news', async (c) => {
    await c.query(
      `INSERT INTO news_items (id, source_key, guid, url, title, published_at)
       VALUES ('e1', 'et', 'e1', 'https://wire.example/pti-story', 'RBI holds repo rate', now())`,
    );
    await assignStories(c);
    swept();
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  await firstSwept;
  const second = storeItems('mint', [
    item('m1', 'https://wire.example/pti-story', 'RBI keeps the repo rate unchanged'),
  ]);
  await Promise.all([first, second]);
  const s = await storyOf();
  assert.equal(s['m1']?.story, 'e1');
});

test('an item stored before stories existed is given one by the next feed stored', async () => {
  // Every row already in news_items when 0065 ran is NULL; nothing backfills it but the sweep.
  await serviceTxn('system:news', (c) => c.query(
    `INSERT INTO news_items (id, source_key, guid, url, title, published_at)
     VALUES ('old', 'et', 'old', 'https://et.example/old', 'Tega to acquire a rival', $1)`,
    [daysAgo(1)],
  ));
  await storeItems('mint', [item('m1', 'https://mint.example/2', 'Tega to acquire a rival')]);
  const s = await storyOf();
  assert.equal(s['old']?.story, 'old', 'the older item is swept and becomes the first item');
  assert.equal(s['m1']?.story, 'old');
});

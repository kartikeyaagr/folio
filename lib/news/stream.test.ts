import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { serviceTxn } from '../db.ts';
import { storeItems } from './poll.ts';
import { mostCarried, stream, streamFacets } from './stream.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `folio_stream_${process.pid}`;

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:news', async (c) => {
    await c.query('UPDATE news_sources SET active = false');
    const sources: [string, string, string, boolean, boolean][] = [
      ['et-mk', 'Economic Times — markets', 'markets', true, true],
      ['et-co', 'Economic Times — companies', 'companies', true, true],
      ['mint', 'Mint — markets', 'markets', true, true],
      ['ft', 'Financial Times — world', 'world', true, true],
      ['trade', 'A trade title', 'industry', false, true],
      ['retired', 'Retired — business', 'business', true, false],
    ];
    for (const [key, label, section, inStream, active] of sources) {
      await c.query(
        `INSERT INTO news_sources (key,label,url,tier,market,section,in_stream,active)
         VALUES ($1,$2,'https://feeds/' || $1,2,'india',$3,$4,$5)`,
        [key, label, section, inStream, active],
      );
    }
  });
  await serviceTxn('system:auth', (c) => c.query(
    `INSERT INTO companies (id,symbol,name,sector)
     VALUES ('c_praj','PRAJIND','Praj Industries Limited','bioenergy')`,
  ));
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:news', async (c) => {
    await c.query('DELETE FROM news_matches');
    await c.query('DELETE FROM news_items');
  });
});

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

/** One item from one source, stored the way the poller stores it, so it is given its story. */
const put = (source: string, guid: string, url: string, title: string, hours: number) =>
  storeItems(source, [{ guid, url, title, summary: null, publishedAt: hoursAgo(hours) }]);

const titles = (rows: { title: string }[]) => rows.map((r) => r.title);

test('one row per story, carrying every outlet that ran it and their count', async () => {
  await put('et-mk', 'e1', 'https://wire/rbi', 'RBI holds repo rate', 5);
  await put('mint', 'm1', 'https://wire/rbi', 'RBI keeps rates unchanged', 4);
  await put('ft', 'f1', 'https://wire/rbi', 'India’s central bank holds', 3);
  // Two feeds of one outlet are one outlet: ET running it in markets and companies is not pickup.
  await put('et-co', 'e2', 'https://wire/rbi?from=companies', 'RBI holds repo rate', 5);
  await put('et-mk', 'e3', 'https://et/sensex', 'Sensex falls 1,000 points', 1);

  const { stories, total } = await stream();
  assert.equal(total, 2);
  const rbi = stories.find((s) => s.url === 'https://wire/rbi');
  assert.equal(rbi?.title, 'RBI holds repo rate', 'the outlet that ran it first is the one shown');
  assert.deepEqual(rbi?.outlets, ['Economic Times', 'Mint', 'Financial Times']);
  assert.equal(rbi?.outletCount, 3);
});

test('stories come newest first', async () => {
  await put('et-mk', 'a', 'https://x/a', 'Older', 6);
  await put('mint', 'b', 'https://x/b', 'Newest', 1);
  await put('ft', 'c', 'https://x/c', 'Middle', 3);
  assert.deepEqual(titles((await stream()).stories), ['Newest', 'Middle', 'Older']);
});

test('a section filter admits a story any carrier files there, and shows it', async () => {
  await put('ft', 'f1', 'https://wire/oil', 'Oil rises above $108', 4);
  await put('mint', 'm1', 'https://wire/oil', 'Crude crosses $108 a barrel', 2);
  await put('ft', 'f2', 'https://ft/other', 'A world story nobody else ran', 1);

  const { stories } = await stream({ section: 'markets' });
  assert.equal(stories.length, 1);
  assert.equal(stories[0]?.title, 'Crude crosses $108 a barrel');
  assert.equal(stories[0]?.section, 'markets');
  assert.deepEqual(stories[0]?.outlets, ['Mint', 'Financial Times'], 'whole story, shown first');
});

test('an outlet filter shows that outlet’s own headline and link', async () => {
  await put('et-mk', 'e1', 'https://et/tega', 'Tega to buy a rival', 5);
  await put('ft', 'f1', 'https://et/tega', 'Tega to buy a rival', 2);
  await put('et-mk', 'e2', 'https://et/only', 'Only in ET', 1);

  const { stories } = await stream({ outlet: 'Financial Times' });
  assert.deepEqual(
    stories.map((s) => [s.outlet, s.title]), [['Financial Times', 'Tega to buy a rival']],
  );
  assert.equal(stories[0]?.outletCount, 2);
});

test('the window holds stories that began in it, not old ones picked up again', async () => {
  await put('et-mk', 'e1', 'https://x/old', 'Began yesterday', 30);
  await put('mint', 'm1', 'https://x/old', 'Began yesterday', 2);
  await put('et-mk', 'e2', 'https://x/new', 'Began today', 3);

  assert.deepEqual(titles((await stream({ hours: 24 })).stories), ['Began today']);
  assert.deepEqual(
    titles((await stream({ hours: 48 })).stories), ['Began today', 'Began yesterday'],
  );
  // Mint's own carrier did begin inside the window, and filtered to Mint that is the story's start.
  assert.deepEqual(
    titles((await stream({ hours: 24, outlet: 'Mint' })).stories), ['Began yesterday'],
  );
});

test('a source outside the stream, or switched off, adds nothing and counts nothing', async () => {
  await put('et-mk', 'e1', 'https://x/a', 'In the press and the trade', 2);
  await put('trade', 't1', 'https://x/a', 'In the press and the trade', 1);
  await put('trade', 't2', 'https://x/b', 'Only in the trade', 1);
  await put('retired', 'r1', 'https://x/c', 'Only in a retired feed', 1);

  const { stories } = await stream();
  assert.deepEqual(titles(stories), ['In the press and the trade']);
  assert.deepEqual(stories[0]?.outlets, ['Economic Times']);
});

test('a confirmed match tags the story with the company; a candidate does not', async () => {
  // The match is on the trade title's copy, which is outside the stream: it is the same story.
  await put('et-mk', 'e1', 'https://x/praj', 'Ethanol blending target raised', 3);
  await put('trade', 't1', 'https://x/praj', 'Ethanol blending target raised', 2);
  await put('et-mk', 'e2', 'https://x/cbg', 'CBG prices revised', 1);
  await serviceTxn('system:news', async (c) => {
    const id = async (guid: string) => (await c.query<{ id: string }>(
      'SELECT id FROM news_items WHERE guid = $1', [guid],
    )).rows[0]!.id;
    await c.query(
      `INSERT INTO news_matches (id,item_id,company_id,tier,evidence,state,mechanism)
       VALUES ('m1',$1,'c_praj','sector_term','ethanol','confirmed','Praj builds ethanol plants.'),
              ('m2',$2,'c_praj','sector_term','CBG','candidate',NULL)`,
      [await id('t1'), await id('e2')],
    );
  });

  const tags = Object.fromEntries((await stream()).stories.map((s) => [s.title, s.companies]));
  assert.deepEqual(tags, {
    'Ethanol blending target raised': ['PRAJIND'], 'CBG prices revised': [],
  });
});

test('mostCarried orders by how many outlets ran a story, then by how recent it is', async () => {
  await put('et-mk', 'a1', 'https://x/a', 'Carried by two', 10);
  await put('mint', 'a2', 'https://x/a', 'Carried by two', 9);
  await put('et-mk', 'b1', 'https://x/b', 'Carried by three', 20);
  await put('mint', 'b2', 'https://x/b', 'Carried by three', 19);
  await put('ft', 'b3', 'https://x/b', 'Carried by three', 18);
  await put('ft', 'c1', 'https://x/c', 'Carried by one, newest', 1);
  await put('mint', 'd1', 'https://x/d', 'Carried by one, older', 2);
  await put('et-mk', 'e1', 'https://x/e', 'Outside the window', 30);
  await put('ft', 'e2', 'https://x/e', 'Outside the window', 29);
  await put('mint', 'e3', 'https://x/e', 'Outside the window', 28);

  assert.deepEqual(titles(await mostCarried(24)), [
    'Carried by three', 'Carried by two', 'Carried by one, newest', 'Carried by one, older',
  ]);
});

test('the total counts every story in the window past the limit, and pages go on', async () => {
  for (let i = 0; i < 5; i++) await put('mint', `s${i}`, `https://x/${i}`, `Story ${i}`, i + 1);
  const { stories, total } = await stream({ limit: 2 });
  assert.deepEqual(titles(stories), ['Story 0', 'Story 1']);
  assert.equal(total, 5);
  assert.deepEqual(titles((await stream({ limit: 2, offset: 2 })).stories), ['Story 2', 'Story 3']);
});

test('the facets are the sections in reading order, the outlets, and the last poll', async () => {
  await serviceTxn('system:news', (c) => c.query(
    "UPDATE news_sources SET last_polled_at = now() - interval '5 minutes' WHERE key = 'ft'",
  ));
  const facets = await streamFacets();
  assert.deepEqual(facets.sections, ['world', 'companies', 'markets']);
  assert.deepEqual(facets.outlets, ['Economic Times', 'Financial Times', 'Mint']);
  assert.ok(facets.lastPolledAt && Date.now() - facets.lastPolledAt.getTime() < 6 * 60_000);
});

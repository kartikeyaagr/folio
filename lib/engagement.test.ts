import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { serviceTxn } from './db.ts';
import { clear, dismissalsByTier, mark, newsFor } from './engagement.ts';
import { createTestDatabase, dropTestDatabase } from '../db/testing.ts';

const DB = `trisula_eng_${process.pid}`;
const ANA = 'u_a';
const BO = 'u_b';
const CO = 'c1';

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    for (const [id, name] of [[ANA, 'Ana'], [BO, 'Bo']]) {
      await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person',$2)", [id, name]);
      await c.query('INSERT INTO users (id,email,name) VALUES ($1,$2,$3)', [id, `${id}@x.com`, name]);
    }
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'PRAJIND','Praj')", [CO]);
  });
  await serviceTxn('system:news', async (c) => {
    await c.query(
      `INSERT INTO news_sources (key,label,url,tier,market)
       VALUES ('trade','A trade title','https://x/f',2,'india')`,
    );
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:news', async (c) => {
    await c.query('DELETE FROM engagement');
    await c.query('DELETE FROM news_matches');
    await c.query('DELETE FROM news_items');
  });
});

async function story(id: string, title: string, tier = 'sector_term') {
  await serviceTxn('system:news', async (c) => {
    await c.query(
      `INSERT INTO news_items (id,source_key,guid,url,title,published_at)
       VALUES ($1,'trade',$1,'https://x/' || $1,$2, now())`, [id, title]);
    await c.query(
      `INSERT INTO news_matches (id,item_id,company_id,tier,evidence,state,mechanism)
       VALUES ($1,$1,$2,$3,'ethanol','confirmed','It supplies them.')`, [id, CO, tier]);
  });
}

test('what one person has read is not what another has read', async () => {
  // The reason this is not a column on the story: three people share this desk, and a shared flag
  // means the second person to open the app never sees what the first one cleared.
  await story('n1', 'A story');
  await mark('news', 'n1', 'read', ANA);
  assert.equal((await newsFor(ANA))[0]?.state, 'read');
  assert.equal((await newsFor(BO))[0]?.state, null);
});

test('reading marks a story, dismissing removes it', async () => {
  await story('n1', 'Read this');
  await story('n2', 'Dismiss this');
  await mark('news', 'n1', 'read', ANA);
  await mark('news', 'n2', 'dismissed', ANA);

  const mine = await newsFor(ANA);
  assert.deepEqual(mine.map((n) => n.title), ['Read this'], 'a read story is still what happened');
  assert.equal(mine[0]?.state, 'read');
  assert.equal((await newsFor(ANA, { includeDismissed: true })).length, 2);
});

test('a dismissal can be taken back', async () => {
  await story('n1', 'A story');
  await mark('news', 'n1', 'dismissed', ANA);
  assert.equal((await newsFor(ANA)).length, 0);
  await clear('news', 'n1', ANA);
  assert.equal((await newsFor(ANA)).length, 1);
});

test('marking twice is one row, not two', async () => {
  await story('n1', 'A story');
  await mark('news', 'n1', 'read', ANA);
  await mark('news', 'n1', 'dismissed', ANA);
  assert.equal((await newsFor(ANA, { includeDismissed: true }))[0]?.state, 'dismissed');
});

test('dismissals are kept, because they say which tier is not working', async () => {
  // The only reason to store a dismissal rather than delete the row: a tier people dismiss most of
  // the time is a tier that is not earning its place, and nothing else would show it.
  await story('n1', 'Vocabulary match', 'sector_term');
  await story('n2', 'Another vocabulary match', 'sector_term');
  await story('n3', 'Named the company', 'name');
  await mark('news', 'n1', 'dismissed', ANA);
  await mark('news', 'n2', 'dismissed', BO);

  const byTier = await dismissalsByTier();
  assert.deepEqual(byTier.find((t) => t.tier === 'sector_term'), {
    tier: 'sector_term', confirmed: 2, dismissed: 2,
  });
  assert.deepEqual(byTier.find((t) => t.tier === 'name'), {
    tier: 'name', confirmed: 1, dismissed: 0,
  });
});

test('a story several outlets ran says so', async () => {
  // Deduplicated to one row, but three outlets running a piece is not the same event as one trade
  // title running it, and the row would otherwise lose that entirely.
  await serviceTxn('system:news', async (c) => {
    await c.query(
      `INSERT INTO news_sources (key,label,url,tier,market)
       VALUES ('other','Another title','https://y/f',2,'india')
       ON CONFLICT (key) DO NOTHING`);
  });
  await story('n1', 'One story');
  await serviceTxn('system:news', async (c) => {
    await c.query(
      `INSERT INTO news_items (id,source_key,guid,url,title,published_at)
       VALUES ('n1b','other','n1b','https://x/n1','One story', now())`);
  });
  assert.deepEqual((await newsFor(ANA))[0]?.alsoIn, ['Another title']);
});

test('a story only one outlet ran claims nothing', async () => {
  await story('n2', 'Only here');
  assert.deepEqual((await newsFor(ANA))[0]?.alsoIn, []);
});

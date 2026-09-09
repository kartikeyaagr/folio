import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../../db/migrate.ts';
import { closePool, readTxn, serviceTxn } from '../db.ts';
import {
  candidatesFor, distinctive, matchNewItems, mentions, mentionsTerm, nameTerm,
  type CompanyVocabulary, type Item,
} from './match.ts';


const DB = `trisula_match_${process.pid}`;
const CO = 'c_praj';

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  await serviceTxn('system:auth', async (c) => {
    await c.query(
      "INSERT INTO companies (id,symbol,name,sector) VALUES ($1,'PRAJIND','Praj Industries Limited','bioenergy')",
      [CO],
    );
  });
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

beforeEach(async () => {
  await serviceTxn('system:news', async (c) => {
    await c.query('DELETE FROM news_matches');
    await c.query('DELETE FROM news_matched_items');
    await c.query('DELETE FROM news_items');
    await c.query('DELETE FROM news_sources');
  });
});

/** Two feeds of one publisher, both Indian and both in this company's sector. */
async function twoFeeds(): Promise<void> {
  await serviceTxn('system:news', async (c) => {
    for (const key of ['agri', 'economy']) {
      await c.query(
        `INSERT INTO news_sources (key,label,url,tier,sector,market)
         VALUES ($1,$1,'https://x/' || $1, 2,'bioenergy','india')`,
        [key],
      );
    }
  });
}

/** A row in the database, as against `item()` above, which builds one in memory. */
async function storeItem(
  id: string, source: string, title: string, url: string, daysAgo: number,
): Promise<void> {
  await serviceTxn('system:news', async (c) => {
    await c.query(
      `INSERT INTO news_items (id,source_key,guid,url,title,published_at)
       VALUES ($1,$2,$1,$3,$4, now() - ($5 || ' days')::interval)`,
      [id, source, url, title, String(daysAgo)],
    );
  });
}

const candidateCount = () => readTxn(async (c) =>
  Number((await c.query<{ n: string }>('SELECT count(*)::text AS n FROM news_matches')).rows[0]!.n));

const PRAJ: CompanyVocabulary = {
  id: 'c_praj', symbol: 'PRAJIND', isin: 'INE074A01025', name: 'Praj Industries Limited',
  sector: 'bioenergy',
  aliases: [{ alias: 'Praj Hipurity', kind: 'subsidiary' }, { alias: 'BioSyrup', kind: 'brand' }],
  sectorTerms: ['ethanol', 'distillery', 'sugar mill', 'biogas'],
};

const item = (title: string, over: Partial<Item> = {}): Item => ({
  id: 'i1', title, summary: null, sourceSector: null, sourceMarket: 'india', ...over,
});

const tiers = (i: Item) => candidatesFor(i, [PRAJ]).map((c) => `${c.tier}:${c.evidence}`);

// ---- the identifier tiers ----------------------------------------------------------------------

test('a name is stripped down to the part that identifies it', () => {
  assert.equal(distinctive('Praj Industries Limited'), 'Praj');
  assert.equal(distinctive('Tega Industries Limited'), 'Tega');
  // v2's docstring claimed this reduced to "Mobility Hospitality". It does not and never did:
  // "Ecos" is not furniture. Carried forward as measured behaviour rather than as documented.
  assert.equal(distinctive('Ecos (India) Mobility & Hospitality Limited'), 'Ecos Mobility Hospitality');
});

test('a multi-word name matches on its first two words, adjacent', () => {
  // Matching on the first word alone filed a Sterling Wilson story under Sterling Tools.
  assert.equal(nameTerm('Sterling Tools Limited')?.term, 'Sterling Tools');
  assert.ok(nameTerm('Sterling Tools Limited')!.pattern.test('Sterling Tools wins an order'));
  assert.ok(!nameTerm('Sterling Tools Limited')!.pattern.test('Sterling Wilson wins an order'));
  assert.equal(nameTerm('Praj Industries Limited')?.term, 'Praj', 'one distinctive word stands alone');
});

test('vocabulary is bounded at the front only, so plurals are caught', () => {
  // Stories are written in the plural more often than the singular. A closing boundary means
  // "sugar mill" misses "sugar mills" and "distillery" misses "distilleries".
  assert.ok(mentionsTerm('Sugar mills asked to file data', 'sugar mill'));
  assert.ok(mentionsTerm('Two distilleries commissioned', 'distillery') === false
    || mentionsTerm('Two distilleries commissioned', 'distiller'));
  assert.ok(!mentionsTerm('The bioethanol debate', 'ethanol'), 'the leading boundary still holds');
});

test('a match is word-bounded, always', () => {
  // The four-character floor plus boundaries. A five-character floor silently dropped Praj and
  // Tega — two names on an eleven-name book — which is why the floor is not the mechanism.
  assert.ok(mentions('Praj wins an order', 'Praj'));
  assert.ok(!mentions('The ecosystem is growing', 'Ecos'));
  assert.ok(!mentions('Sagarmala port project', 'Sagar'));
  assert.ok(!mentions('a praj', 'prj'), 'below the floor');
});

test('the symbol is matched as written, in capitals', () => {
  assert.deepEqual(tiers(item('PRAJIND hits a 52-week high')), ['symbol:PRAJIND']);
  assert.deepEqual(tiers(item('the prajind of the matter')), [], 'lower case is a word, not a ticker');
});

test('an ISIN counts', () => {
  assert.deepEqual(tiers(item('Allotment under INE074A01025')), ['isin:INE074A01025']);
});

test('subsidiaries and brands come back as themselves', () => {
  // A subsidiary carrying the parent's name is caught by the name tier first, which is not wrong —
  // the company's own name is in the story. The tiers matter for subsidiaries named differently.
  assert.deepEqual(tiers(item('BioSyrup expands its range')), ['brand:BioSyrup']);
  const co = { ...PRAJ, aliases: [{ alias: 'Hipurity Systems', kind: 'subsidiary' }] };
  assert.deepEqual(
    candidatesFor(item('Hipurity Systems commissions a plant'), [co]).map((c) => c.tier),
    ['subsidiary'],
  );
});

test('a story is caught at the narrowest tier that catches it', () => {
  // Both the name and a sector term are present. Telling the gate "sector term" would make it work
  // harder for a worse answer.
  const t = tiers(item('Praj commissions a new ethanol distillery', { sourceSector: 'bioenergy' }));
  assert.deepEqual(t, ['name:Praj']);
});

// ---- the vocabulary tier -----------------------------------------------------------------------

test('a sector term from a matching trade title is a candidate', () => {
  assert.deepEqual(
    tiers(item('Revised CBG pricing to support biogas producers', { sourceSector: 'bioenergy' })),
    ['sector_term:biogas'],
  );
});

test('a sector term from another industry’s title is a coincidence', () => {
  assert.deepEqual(
    tiers(item('Ethanol used in mineral processing', { sourceSector: 'mining' })), [],
  );
});

test('general press carries every industry, so it is not filtered by sector', () => {
  assert.deepEqual(
    tiers(item('Government raises ethanol blending target', { sourceSector: null })),
    ['sector_term:ethanol'],
  );
});

test('a global title’s vocabulary is not about an Indian company', () => {
  // The anchor, asked of the source rather than of the headline. v2 asked the story whether it
  // said "India"; 71 of 135 items from Indian trade titles never do, and it cost two real PRAJIND
  // stories from ChiniMandi.
  assert.deepEqual(
    tiers(item('Brazil expands ethanol capacity', { sourceSector: 'bioenergy', sourceMarket: 'global' })),
    [],
  );
  assert.deepEqual(
    tiers(item('Sugar mills asked to file sales data', { sourceSector: 'bioenergy', sourceMarket: 'india' })),
    ['sector_term:sugar mill'],
    'and the domestic trade title gets through without saying the word India',
  );
});

test('policy with no company in it is still a candidate', () => {
  // A version of this filtered these out on the theory that they gave the gate nothing to reason
  // about. Against 2,084 real items it removed five of six candidates, and the five were CBG
  // pricing and ethanol policy — what this tier is for.
  assert.deepEqual(
    tiers(item('Supreme Court dismisses PIL on ethanol content at petrol pumps')),
    ['sector_term:ethanol'],
  );
});

test('a company with no sector picks up no vocabulary', () => {
  const noSector = { ...PRAJ, sector: null, sectorTerms: [] };
  assert.deepEqual(candidatesFor(item('ethanol blending rises'), [noSector]), []);
});

test('a name that is an ordinary word does not match on its own', () => {
  const supreme: CompanyVocabulary = {
    id: 'c_sup', symbol: 'SUPREME', isin: null, name: 'Supreme Limited', sector: null,
    aliases: [], sectorTerms: [],
  };
  assert.deepEqual(candidatesFor(item('The Supreme Court ruled today'), [supreme]), []);
});

// ---- one story, one candidate -----------------------------------------------------------------

test('two feeds carrying one article produce one candidate', async () => {
  // The Hindu BusinessLine publishes a single article to both its agri-business and economy feeds,
  // at the same URL. Judging it twice costs two model calls to reach one answer and then shows the
  // reader the same story twice.
  await twoFeeds();
  await storeItem('a1', 'agri', 'Sugar mills asked to file data', 'https://x/story/1', 0);
  await storeItem('a2', 'economy', 'Sugar mills asked to file data', 'https://x/story/1', 0);

  const r = await matchNewItems();
  assert.equal(r.candidates, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(await candidateCount(), 1);
});

test('a retired source contributes nothing, its backlog included', async () => {
  // Switching a feed off has to reach what it already fetched. The sweep asks which items have no
  // match row, which has no window to fall out of, so without the active test a retired title's
  // stories would go on being matched and gated for as long as the rows exist. This is what the
  // 21 sector-tagged trade titles were retired by.
  await twoFeeds();
  await storeItem('e1', 'agri', 'Sugar mills asked to file data', 'https://x/story/8', 0);
  await storeItem('e2', 'economy', 'Ethanol blending target raised', 'https://x/story/9', 0);
  await serviceTxn('system:news', async (c) => {
    await c.query("UPDATE news_sources SET active = false WHERE key = 'economy'");
  });

  const r = await matchNewItems();
  assert.equal(r.candidates, 1, 'only the live feed is read');
  assert.equal(await candidateCount(), 1);
});

test('a query string is not part of the article’s identity', async () => {
  await twoFeeds();
  await storeItem('b1', 'agri', 'Sugar mills asked to file data', 'https://x/story/2', 0);
  await storeItem('b2', 'economy', 'Sugar mills asked to file data', 'https://x/story/2?utm_source=rss', 0);
  const r = await matchNewItems();
  assert.equal(r.candidates, 1, 'feed and campaign tags do not make a second article');
});

test('one headline at two addresses is still one story', async () => {
  // Recycling Today and Waste Today run the same piece; so do Manufacturing Dive and Supply Chain
  // Dive. Different URLs, identical headline.
  await twoFeeds();
  await storeItem('c1', 'agri', 'Casella to acquire an ethanol distillery', 'https://a/1', 0);
  await storeItem('c2', 'economy', 'Casella to acquire an ethanol distillery', 'https://b/9', 2);
  const r = await matchNewItems();
  assert.equal(r.candidates, 1);
  assert.equal(r.duplicates, 1);
});

test('the same headline months apart is two stories', async () => {
  // A column that runs under one headline every week is not one story forever, which is the whole
  // reason the match is bounded in time rather than being global.
  await twoFeeds();
  await storeItem('d1', 'agri', 'Daily ethanol market update', 'https://a/2', 0);
  await storeItem('d2', 'agri', 'Daily ethanol market update', 'https://a/3', 40);
  const r = await matchNewItems();
  assert.equal(r.candidates, 2);
});

test('two genuinely different stories both stand', async () => {
  await twoFeeds();
  await storeItem('e1', 'agri', 'Sugar mills asked to file data', 'https://a/4', 0);
  await storeItem('e2', 'agri', 'Ethanol blending target raised', 'https://a/5', 0);
  assert.equal((await matchNewItems()).candidates, 2);
});

test('a headline in another script is not deduplicated against every other one', async () => {
  // The trap this guards: an ASCII-only normalisation folds every Gujarati and Hindi headline to
  // the empty string, and ChiniMandi — which now publishes mostly in those scripts — collapses
  // into a single story. Caught by writing the measuring query that way first.
  await twoFeeds();
  await storeItem('f1', 'agri', 'ખાંડ મિલોને વેચાણ ડેટા ફાઇલ કરવા કહ્યું', 'https://a/6', 0);
  await storeItem('f2', 'agri', 'चीनी मिलों को बिक्री डेटा दाखिल करने को कहा', 'https://a/7', 0);
  const r = await matchNewItems();
  assert.equal(r.duplicates, 0, 'two different headlines, in two different scripts');
});

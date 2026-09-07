import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../../db/migrate.ts';
import { closePool, readTxn, serviceTxn } from '../db.ts';
import { parseIndex, parseShareholding, shpDate, storeShareholding } from './shareholding.ts';

const DB = `trisula_shp_${process.pid}`;
const CO = 'c_praj';

/**
 * A filing, cut down to the elements that are read. Percentages are fractions in the real
 * documents and are fractions here.
 *
 * `encumbrance` is passed as raw XML because the point of most of these tests is what happens when
 * those elements are *absent*, which is what NSE actually does when the flag is false.
 */
function filing(opts: {
  promoter?: string; public?: string; fii?: string; dii?: string;
  pledged?: boolean; ndu?: boolean; other?: boolean;
  encumbrance?: string; asOf?: string;
}): string {
  const P = 'ShareholdingOfPromoterAndPromoterGroup_ContextI';
  const b = (name: string, v: boolean) =>
    `<in-bse-shp:WhetherAnySharesHeldByPromotersAreEncumbered${name} contextRef="MainI">${v}</in-bse-shp:WhetherAnySharesHeldByPromotersAreEncumbered${name}>`;
  const share = (v: string | undefined, ctx: string) =>
    v === undefined ? '' :
      `<in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares contextRef="${ctx}" decimals="4">${v}</in-bse-shp:ShareholdingAsAPercentageOfTotalNumberOfShares>`;
  return [
    '<?xml version="1.0"?><xbrli:xbrl xmlns:in-bse-shp="x">',
    `<in-bse-shp:DateOfReport contextRef="MainI">${opts.asOf ?? '2026-06-30'}</in-bse-shp:DateOfReport>`,
    b('UnderPledged', opts.pledged ?? false),
    b('UnderNonDisposalUndertaking', opts.ndu ?? false),
    b('OtherThanByWayOfPledgeOrNDU', opts.other ?? false),
    share(opts.promoter, P),
    share(opts.public, 'PublicShareholding_ContextI'),
    share(opts.fii, 'InstitutionsForeign_ContextI'),
    share(opts.dii, 'InstitutionsDomestic_ContextI'),
    opts.encumbrance ?? '',
    '</xbrli:xbrl>',
  ].join('');
}

const encumbrance = (pledge?: string, total?: string) => {
  const P = 'ShareholdingOfPromoterAndPromoterGroup_ContextI';
  return [
    pledge === undefined ? '' :
      `<in-bse-shp:EncumberedShareUnderPledgedAsPercentageOfTotalNumberOfShares contextRef="${P}">${pledge}</in-bse-shp:EncumberedShareUnderPledgedAsPercentageOfTotalNumberOfShares>`,
    total === undefined ? '' :
      `<in-bse-shp:EncumberedSharesHeldAsPercentageOfTotalNumberOfShares contextRef="${P}">${total}</in-bse-shp:EncumberedSharesHeldAsPercentageOfTotalNumberOfShares>`,
  ].join('');
};

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'PRAJIND','Praj')", [CO]);
  });
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

beforeEach(async () => {
  await serviceTxn('system:ingest', (c) => c.query('DELETE FROM shareholding_patterns'));
});

// ---- the index --------------------------------------------------------------------------------

test('the index keeps only submissions that name a company, a quarter and a document', () => {
  const rows = parseIndex([
    { symbol: 'PRAJIND', date: '30-JUN-2026', xbrl: 'https://x/a.xml' },
    { symbol: 'NODATE', date: '', xbrl: 'https://x/b.xml' },
    { symbol: 'NODOC', date: '30-JUN-2026', xbrl: '' },
  ]);
  assert.deepEqual(rows.map((r) => r.symbol), ['PRAJIND']);
  assert.equal(rows[0]?.asOf, '2026-06-30');
});

test('the quarter is read from NSE’s shouting date format', () => {
  assert.equal(shpDate('30-JUN-2026'), '2026-06-30');
  assert.equal(shpDate('31-Mar-2026'), '2026-03-31');
  assert.equal(shpDate('Q1 2026'), null);
});

// ---- reading a filing -------------------------------------------------------------------------

test('the four holdings come back as percentages, not fractions', () => {
  // Praj's real June 2026 numbers.
  const s = parseShareholding(filing({
    promoter: '0.3281', public: '0.6719', fii: '0.1775', dii: '0.141',
  }))!;
  assert.equal(s.promoterPct, 32.81);
  assert.equal(s.publicPct, 67.19);
  assert.equal(s.fiiPct, 17.75);
  assert.equal(s.diiPct, 14.1);
});

test('a company that says it has pledged nothing has pledged nothing', () => {
  // The elements are absent entirely. Absent plus a false flag is zero, not unknown.
  const s = parseShareholding(filing({ promoter: '0.3281', pledged: false }))!;
  assert.equal(s.pledgePct, 0);
  assert.equal(s.encumberedPct, 0);
});

test('a pledge is a share of the promoter holding, not of the company', () => {
  // ZEEL's real filing: the promoter owns 3.99% of the company and the element reads 5.38%. Taken
  // as a share of the company that is impossible, which is how the misnaming was caught.
  const s = parseShareholding(filing({
    promoter: '0.0399', pledged: true, encumbrance: encumbrance('0.0538', '0.0538'),
  }))!;
  assert.equal(s.promoterPct, 3.99);
  assert.equal(s.pledgePct, 5.38);
  assert.ok(s.pledgePct! > s.promoterPct!, 'and so it can exceed the holding itself');
});

test('a promoter who has pledged nothing can still be almost entirely encumbered', () => {
  // Vedanta, June 2026: no pledge, 99.99% encumbered through undertakings and other means. Reading
  // only the pledge element reports this promoter as free and clear.
  const s = parseShareholding(filing({
    promoter: '0.5472', pledged: false, ndu: true, other: true,
    encumbrance: encumbrance(undefined, '0.9999'),
  }))!;
  assert.equal(s.pledgePct, 0);
  assert.equal(s.encumberedPct, 99.99);
});

test('an encumbrance declared but not broken down is unknown, not zero', () => {
  // A null here sends someone to read the filing. A fabricated zero does not.
  const s = parseShareholding(filing({ promoter: '0.5', pledged: true, encumbrance: '' }))!;
  assert.equal(s.pledgePct, null);
  assert.equal(s.encumberedPct, null);
});

test('a document with no reporting date is not a filing', () => {
  assert.equal(parseShareholding('<?xml version="1.0"?><xbrli:xbrl/>'), null);
  assert.equal(parseShareholding(filing({ asOf: 'the second quarter' })), null);
});

// ---- storing ----------------------------------------------------------------------------------

const patterns = () => readTxn(async (c) => {
  const { rows } = await c.query<Record<string, string>>(
    'SELECT as_of, promoter_pct, promoter_pledge_pct FROM shareholding_patterns ORDER BY as_of',
  );
  return rows;
});

test('one quarter is one row, however often it is fetched', async () => {
  const s = parseShareholding(filing({ promoter: '0.3281' }))!;
  await storeShareholding(CO, s);
  await storeShareholding(CO, s);
  assert.equal((await patterns()).length, 1);
});

test('a revised filing overwrites the quarter rather than adding to it', async () => {
  await storeShareholding(CO, parseShareholding(filing({ promoter: '0.3281' }))!);
  await storeShareholding(CO, parseShareholding(filing({ promoter: '0.3500' }))!);
  const rows = await patterns();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.promoter_pct, '35.0000', 'the exchange revises these and the later one wins');
});

test('quarters accumulate', async () => {
  await storeShareholding(CO, parseShareholding(filing({ asOf: '2026-03-31', promoter: '0.33' }))!);
  await storeShareholding(CO, parseShareholding(filing({ asOf: '2026-06-30', promoter: '0.3281' }))!);
  assert.deepEqual((await patterns()).map((r) => r.as_of), ['2026-03-31', '2026-06-30']);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readTxn } from '../db.ts';
import { parseMaster, refreshSecurities } from './securities.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `folio_sec_${process.pid}`;

// The two masters really do spell their columns differently. That is the whole reason field()
// exists, so the fixtures keep the difference rather than tidying it away.
const MAINBOARD = [
  'SYMBOL,NAME OF COMPANY,SERIES,DATE OF LISTING,PAID UP VALUE,MARKET LOT,ISIN NUMBER,FACE VALUE',
  'TEGA,Tega Industries Limited,EQ,13-DEC-2021,10,1,INE011A01019,10',
  'PRAJIND,Praj Industries Limited,EQ,20-AUG-1997,2,1,INE074A01025,2',
].join('\n');

const SME = [
  'SYMBOL,NAME_OF_COMPANY,SERIES,DATE_OF_LISTING,PAID_UP_VALUE,MARKET_LOT,ISIN_NUMBER,FACE_VALUE',
  'AERON,Aeron Composite Limited,SM,10-SEP-2024,10,1600,INE0S6T01011,10',
].join('\n');

const feed = (mainboard: string, sme: string) => () => Promise.resolve({ mainboard, sme });

before(async () => {
  await createTestDatabase(DB);
});

after(async () => {
  await dropTestDatabase(DB);
});

test('parses both spellings of the same columns', () => {
  const main = parseMaster(MAINBOARD, 'mainboard');
  const sme = parseMaster(SME, 'nse_emerge');
  assert.equal(main.length, 2);
  assert.equal(main[0]?.name, 'Tega Industries Limited');
  assert.equal(main[0]?.isin, 'INE011A01019');
  assert.equal(main[0]?.listedOn, '2021-12-13', 'DD-MMM-YYYY must become a real date');
  assert.equal(sme[0]?.name, 'Aeron Composite Limited', 'the SME file uses NAME_OF_COMPANY');
  assert.equal(sme[0]?.platform, 'nse_emerge');
});

test('a first refresh loads both platforms', async () => {
  const r = await refreshSecurities(feed(MAINBOARD, SME));
  assert.equal(r.fetched, 3);
  assert.equal(r.changed, 3);
  assert.equal(r.delisted, 0);
  const platforms = await readTxn(async (c) => {
    const { rows } = await c.query<{ platform: string; n: string }>(
      'SELECT platform, count(*)::text AS n FROM securities GROUP BY platform ORDER BY platform',
    );
    return rows;
  });
  assert.deepEqual(platforms, [
    { platform: 'mainboard', n: '2' },
    { platform: 'nse_emerge', n: '1' },
  ]);
});

test('an unchanged refresh writes nothing, so the audit log stays quiet', async () => {
  const before = await readTxn(async (c) =>
    Number((await c.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_log')).rows[0]!.n),
  );
  const r = await refreshSecurities(feed(MAINBOARD, SME));
  assert.equal(r.changed, 0, 'nothing changed, so nothing should be written');
  const after = await readTxn(async (c) =>
    Number((await c.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_log')).rows[0]!.n),
  );
  assert.equal(after, before, 'a no-op refresh must not grow the audit log');
});

test('a renamed company is one changed row', async () => {
  const renamed = MAINBOARD.replace('Tega Industries Limited', 'Tega Industries Ltd');
  const r = await refreshSecurities(feed(renamed, SME));
  assert.equal(r.changed, 1);
});

test('a symbol that stops being listed is marked, not deleted', async () => {
  const withoutPraj = MAINBOARD.split('\n').filter((l) => !l.startsWith('PRAJIND,')).join('\n');
  const r = await refreshSecurities(feed(withoutPraj, SME));
  assert.equal(r.delisted, 1);
  const row = await readTxn(async (c) => {
    const { rows } = await c.query<{ delisted_at: Date | null }>(
      "SELECT delisted_at FROM securities WHERE symbol = 'PRAJIND'",
    );
    return rows[0];
  });
  assert.ok(row, 'the row must still exist — old filings and trades reference it');
  assert.ok(row.delisted_at, 'and it must be marked');
});

test('a relisted symbol clears its delisting', async () => {
  const r = await refreshSecurities(feed(MAINBOARD, SME));
  assert.ok(r.changed >= 1);
  const row = await readTxn(async (c) => {
    const { rows } = await c.query<{ delisted_at: Date | null }>(
      "SELECT delisted_at FROM securities WHERE symbol = 'PRAJIND'",
    );
    return rows[0];
  });
  assert.equal(row?.delisted_at, null);
});

test('an empty master is refused rather than delisting the exchange', async () => {
  await assert.rejects(
    () => refreshSecurities(feed('SYMBOL,NAME OF COMPANY\n', 'SYMBOL,NAME_OF_COMPANY\n')),
    /refusing to treat that as an empty NSE/,
  );
});

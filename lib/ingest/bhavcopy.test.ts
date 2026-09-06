import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { migrate } from '../../db/migrate.ts';
import { closePool, readTxn, serviceTxn } from '../db.ts';
import { parseBhavcopy, storePrices, unzipSingle } from './bhavcopy.ts';

const DB = `trisula_bhav_${process.pid}`;

// Shaped like the real UDiFF file, including a Sovereign Gold Bond row and an SME row, because
// both are in the live file and neither is a followed equity.
const CSV = [
  'TradDt,TckrSymb,SctySrs,OpnPric,HghPric,LwPric,ClsPric,TtlTradgVol,ISIN',
  '2026-09-04,PRAJIND,EQ,330.00,338.90,329.10,335.55,425298,INE074A01025',
  '2026-09-04,AERON,SM,82.50,84.00,82.00,83.00,25000,INE0WL801011',
  '2026-09-04,SGBJUN28,GB,15186.73,15270.00,15155.02,15233.75,40,IN0020200104',
  '2026-09-04,BROKEN,EQ,1.00,1.00,1.00,,0,INE000000001',
].join('\n');

/** Build a real zip around a payload, so unzipSingle is tested against the format not a mock. */
function zip(name: string, content: string): Buffer {
  const body = deflateRawSync(Buffer.from(content, 'utf8'));
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(4);
  central.writeUInt32LE(0x02014b50, 0);
  return Buffer.concat([local, nameBuf, body, central]);
}

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO companies (id, symbol, isin, name) VALUES
         ('c1', 'PRAJIND', 'INE074A01025', 'Praj Industries Limited'),
         ('c2', 'AERON',   'INE0WL801011', 'Aeron Composite Limited')`,
    );
  });
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

test('reads the deflated CSV out of a zip', () => {
  assert.equal(unzipSingle(zip('BhavCopy.csv', CSV)), CSV);
});

test('a row with no close price is dropped rather than stored as zero', () => {
  const rows = parseBhavcopy(CSV);
  assert.equal(rows.length, 3, 'BROKEN has no close and must not appear');
  assert.ok(!rows.some((r) => r.symbol === 'BROKEN'));
});

test('both boards arrive in the same file, and every row carries an ISIN', () => {
  const rows = parseBhavcopy(CSV);
  assert.ok(rows.some((r) => r.series === 'SM'), 'SME rows are in the same file');
  assert.ok(rows.every((r) => r.isin !== null), 'the ISIN is what prices join on');
});

test('only followed instruments are stored', async () => {
  const { stored } = await storePrices(new Date('2026-09-04T00:00:00Z'), parseBhavcopy(CSV));
  assert.equal(stored, 2, 'the gold bond is listed and not followed');
  const rows = await readTxn(async (c) => {
    const { rows } = await c.query<{ symbol: string; close: string }>(
      'SELECT symbol, close::text FROM prices ORDER BY symbol',
    );
    return rows;
  });
  assert.deepEqual(rows, [
    { symbol: 'AERON', close: '83.0000' },
    { symbol: 'PRAJIND', close: '335.5500' },
  ]);
});

test('prices join to companies on the instrument, not the symbol', async () => {
  const joined = await readTxn(async (c) => {
    const { rows } = await c.query<{ name: string }>(
      'SELECT c.name FROM companies c JOIN prices p ON p.isin = c.isin ORDER BY c.name',
    );
    return rows.map((r) => r.name);
  });
  assert.deepEqual(joined, ['Aeron Composite Limited', 'Praj Industries Limited']);
});

test('re-running the same day updates rather than duplicating', async () => {
  const revised = CSV.replace('335.55', '340.00');
  await storePrices(new Date('2026-09-04T00:00:00Z'), parseBhavcopy(revised));
  const rows = await readTxn(async (c) => {
    const { rows } = await c.query<{ n: string; close: string }>(
      "SELECT count(*)::text AS n, max(close)::text AS close FROM prices WHERE symbol = 'PRAJIND'",
    );
    return rows[0]!;
  });
  assert.equal(rows.n, '1', 'one row per symbol per day');
  assert.equal(rows.close, '340.0000', 'and the revision won');
});

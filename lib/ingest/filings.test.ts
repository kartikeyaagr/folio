import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../../db/migrate.ts';
import { closePool, readTxn, serviceTxn } from '../db.ts';
import { linkFilingsForCompany, parseAnnouncements, storeFilings } from './filings.ts';

const DB = `trisula_fil_${process.pid}`;

/**
 * Shaped like the live feed. The SME row deliberately carries `sm_isin: null`, because that is
 * what NSE actually returns for Emerge and it is what broke the first version of this code.
 */
const EQUITIES = [
  {
    seq_id: '1001',
    symbol: 'PRAJIND',
    sm_isin: 'INE074A01025',
    sm_name: 'Praj Industries Limited',
    desc: 'Analysts/Institutional Investor Meet',
    attchmntText: 'Con call scheduled',
    attchmntFile: 'https://nsearchives.nseindia.com/x.pdf',
    hasXbrl: true,
    an_dt: '04-Sep-2026 17:25:18',
  },
];

const SME = [
  {
    seq_id: '2001',
    symbol: 'AERON',
    sm_isin: null,
    sm_name: 'Aeron Composite Limited',
    desc: 'Resignation of Director/KMP/SMP',
    attchmntText: 'CFO has resigned',
    attchmntFile: 'https://nsearchives.nseindia.com/y.pdf',
    hasXbrl: true,
    an_dt: '05-Sep-2026 11:02:00',
  },
  {
    seq_id: '2002',
    symbol: 'NOTOURS',
    sm_isin: null,
    sm_name: 'Some Other Limited',
    desc: 'Copy of Newspaper Publication',
    attchmntText: '',
    attchmntFile: '',
    hasXbrl: true,
    an_dt: '05-Sep-2026 12:00:00',
  },
];

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO companies (id, symbol, isin, name) VALUES
         ('c1', 'PRAJIND', 'INE074A01025', 'Praj Industries Limited')`,
    );
  });
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

test('the announcement timestamp is read as IST, not as whatever the box is set to', () => {
  const [f] = parseAnnouncements('nse_equities', EQUITIES);
  // 17:25:18 IST is 11:55:18 UTC.
  assert.equal(f?.announcedAt.toISOString(), '2026-09-04T11:55:18.000Z');
});

test('the id is source plus seq_id, so a re-fetch is an upsert', () => {
  assert.equal(parseAnnouncements('nse_sme', SME)[0]?.id, 'nse_sme:2001');
});

test('a mainboard filing links on the instrument', async () => {
  await storeFilings(parseAnnouncements('nse_equities', EQUITIES));
  const row = await readTxn(async (c) => {
    const { rows } = await c.query<{ company_id: string; linked_by: string }>(
      "SELECT company_id, linked_by FROM filings WHERE id = 'nse_equities:1001'",
    );
    return rows[0];
  });
  assert.equal(row?.company_id, 'c1');
  assert.equal(row?.linked_by, 'isin');
});

test('an SME filing has no ISIN and still finds its company by symbol', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      "INSERT INTO companies (id, symbol, isin, name) VALUES ('c2','AERON','INE0WL801011','Aeron Composite Limited')",
    );
  });
  await storeFilings(parseAnnouncements('nse_sme', SME));
  const row = await readTxn(async (c) => {
    const { rows } = await c.query<{ company_id: string; linked_by: string; isin: string | null }>(
      "SELECT company_id, linked_by, isin FROM filings WHERE id = 'nse_sme:2001'",
    );
    return rows[0];
  });
  assert.equal(row?.isin, null, 'NSE gives Emerge rows no ISIN');
  assert.equal(row?.company_id, 'c2', 'and it must still link, or SME names have no filings at all');
  assert.equal(row?.linked_by, 'symbol', 'the weaker key is recorded, not hidden');
});

test('a filing for a company nobody follows is stored unlinked', async () => {
  const row = await readTxn(async (c) => {
    const { rows } = await c.query<{ company_id: string | null; linked_by: string | null }>(
      "SELECT company_id, linked_by FROM filings WHERE id = 'nse_sme:2002'",
    );
    return rows[0];
  });
  assert.equal(row?.company_id, null);
  assert.equal(row?.linked_by, null);
});

test('following a name afterwards brings its filing history with it', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      "INSERT INTO companies (id, symbol, name) VALUES ('c3','NOTOURS','Some Other Limited')",
    );
  });
  assert.equal(await linkFilingsForCompany('c3'), 1);
  const row = await readTxn(async (c) => {
    const { rows } = await c.query<{ linked_by: string }>(
      "SELECT linked_by FROM filings WHERE id = 'nse_sme:2002'",
    );
    return rows[0];
  });
  assert.equal(row?.linked_by, 'symbol');
});

test('re-ingesting the same window updates rather than duplicating', async () => {
  const before = await readTxn(async (c) =>
    Number((await c.query<{ n: string }>('SELECT count(*)::text AS n FROM filings')).rows[0]!.n),
  );
  await storeFilings(parseAnnouncements('nse_sme', SME));
  const after = await readTxn(async (c) =>
    Number((await c.query<{ n: string }>('SELECT count(*)::text AS n FROM filings')).rows[0]!.n),
  );
  assert.equal(after, before, 'seq_id is stable, so an overlapping window adds nothing');
});

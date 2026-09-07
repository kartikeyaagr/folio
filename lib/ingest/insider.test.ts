import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../../db/migrate.ts';
import { closePool, readTxn, serviceTxn } from '../db.ts';
import { parseInsider, pitDate, storeInsider } from './insider.ts';
import { pickRows } from './nse.ts';

const DB = `trisula_pit_${process.pid}`;
const CO = 'c_praj';

/** Two halves of one real inter-se transfer, shaped exactly as NSE returned them. */
const TRANSFER = [
  {
    did: '558255', symbol: 'PRAJIND', company: 'Praj Industries Limited',
    acqName: 'Dr Pramod Chaudhari', personCategory: 'Promoters',
    tdpTransactionType: 'Buy', acqMode: 'Inter-se-Transfer',
    secAcq: '7200000', secVal: '0',
    befAcqSharesPer: '21.05', afterAcqSharesPer: '24.97',
    buyQuantity: '0', sellquantity: '0',
    date: '10-Dec-2025 15:23', intimDt: '10-Dec-2025',
    acqfromDt: '09-Dec-2025', acqtoDt: '09-Dec-2025',
  },
  {
    did: '558256', symbol: 'PRAJIND', company: 'Praj Industries Limited',
    acqName: 'Moriyaset Trust', personCategory: 'Promoter Group',
    tdpTransactionType: 'Sell', acqMode: 'Inter-se-Transfer',
    secAcq: '7200000', secVal: '0',
    befAcqSharesPer: '3.97', afterAcqSharesPer: '0',
    buyQuantity: '0', sellquantity: '0',
    date: '10-Dec-2025 15:20', intimDt: '10-Dec-2025',
    acqfromDt: '09-Dec-2025', acqtoDt: '09-Dec-2025',
  },
];

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
  await serviceTxn('system:ingest', (c) => c.query('DELETE FROM insider_transactions'));
});

// ---- the payload ------------------------------------------------------------------------------

test('the rows are the ones under `data`, not the first array in the payload', () => {
  // The bug this replaces: the insider endpoint answers {acqNameList, data}, and taking the first
  // array found returned a list of people's names. 232 real disclosures parsed to zero, with a 200
  // and no error anywhere.
  const payload = { acqNameList: ['Dr Pramod Chaudhari', 'Moriyaset Trust'], data: TRANSFER };
  assert.equal(pickRows<Record<string, unknown>>(payload).length, 2);
  assert.equal(pickRows<Record<string, unknown>>(payload)[0]?.['did'], '558255');
});

test('an endpoint that answers with a bare array still works', () => {
  assert.equal(pickRows([{ a: 1 }, { a: 2 }]).length, 2);
});

test('an endpoint with one differently named array still works', () => {
  assert.equal(pickRows({ records: [{ a: 1 }] }).length, 1);
});

test('a payload with no array at all is no rows, not a crash', () => {
  assert.deepEqual(pickRows({ message: 'no data' }), []);
  assert.deepEqual(pickRows(null), []);
});

// ---- parsing ----------------------------------------------------------------------------------

test('a date is read with or without a time after it', () => {
  assert.equal(pitDate('10-Dec-2025 15:23'), '2025-12-10');
  assert.equal(pitDate('09-Dec-2025'), '2025-12-09');
  assert.equal(pitDate('-'), null);
});

test('both sides of the holding are kept', () => {
  const [buy, sell] = parseInsider(TRANSFER);
  assert.equal(buy?.pctBefore, 21.05);
  assert.equal(buy?.pctAfter, 24.97);
  assert.equal(sell?.pctBefore, 3.97);
  assert.equal(sell?.pctAfter, 0, 'an exit is 0, not missing');
});

test('the quantity comes from secAcq for a sell as well as a buy', () => {
  // buyQuantity and sellquantity read 0 on rows that plainly moved 7.2m shares.
  const rows = parseInsider(TRANSFER);
  assert.deepEqual(rows.map((r) => r.quantity), [7200000, 7200000]);
});

test('zero consideration is a figure, and a dash is not', () => {
  const [r] = parseInsider([{ ...TRANSFER[0], secVal: '0', secAcq: '-' }]);
  assert.equal(r?.value, 0, 'an inter-se transfer really is worth nothing');
  assert.equal(r?.quantity, null);
});

test('a row without a disclosure id or a date is dropped', () => {
  assert.equal(parseInsider([{ ...TRANSFER[0], did: '' }]).length, 0);
  assert.equal(parseInsider([{ ...TRANSFER[0], date: '-', intimDt: '-' }]).length, 0);
});

test('a disclosure that names nobody is still a disclosure', () => {
  assert.equal(parseInsider([{ ...TRANSFER[0], acqName: '-' }])[0]?.person, 'unknown');
});

// ---- storing ----------------------------------------------------------------------------------

const count = () => readTxn(async (c) => {
  const { rows } = await c.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM insider_transactions',
  );
  return Number(rows[0]!.n);
});

test('two halves of one transfer are two disclosures', async () => {
  const r = await storeInsider(CO, parseInsider(TRANSFER));
  assert.equal(r.stored, 2);
  assert.equal(await count(), 2);
});

test('re-fetching stores nothing new', async () => {
  await storeInsider(CO, parseInsider(TRANSFER));
  await storeInsider(CO, parseInsider(TRANSFER));
  assert.equal(await count(), 2, 'the disclosure id is the identity');
});

test('the disclosed time survives, because two filings can share a day', async () => {
  await storeInsider(CO, parseInsider(TRANSFER));
  const times = await readTxn(async (c) => {
    const { rows } = await c.query<{ t: string }>(
      `SELECT to_char(disclosed_at, 'YYYY-MM-DD HH24:MI') AS t
         FROM insider_transactions ORDER BY disclosed_at`,
    );
    return rows.map((r) => r.t);
  });
  assert.deepEqual(times, ['2025-12-10 15:20', '2025-12-10 15:23']);
});

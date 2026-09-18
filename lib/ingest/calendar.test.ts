import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readTxn, serviceTxn } from '../db.ts';
import { asDate, parseCalendar, storeCalendar } from './calendar.ts';
import { upcoming } from '../alerts.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `trisula_cal_${process.pid}`;
const OURS = 'c_ours';

/** Shaped like the live feed, including a name the fund does not follow. */
const row = (symbol: string, date: string, purpose: string, desc = '') => ({
  symbol, date, purpose, bm_desc: desc, company: `${symbol} Limited`,
});

const inDays = (n: number): string => {
  const d = new Date(Date.now() + n * 86_400_000);
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]!;
  return `${String(d.getDate()).padStart(2, '0')}-${mon}-${d.getFullYear()}`;
};
const iso = (n: number) => {
  const d = new Date(Date.now() + n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'PRAJIND','Praj')", [OURS]);
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:ingest', (c) => c.query('DELETE FROM calendar_events'));
});

const count = () => readTxn(async (c) => {
  const { rows } = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM calendar_events');
  return Number(rows[0]!.n);
});

// ---- parsing ----------------------------------------------------------------------------------

test('DD-MMM-YYYY is read as a date, and anything else as nothing', () => {
  assert.equal(asDate('08-Sep-2026'), '2026-09-08');
  assert.equal(asDate('31-DEC-2025'), '2025-12-31');
  assert.equal(asDate('2026-09-08'), null);
  assert.equal(asDate('08-Sxp-2026'), null, 'a month that does not exist is not month 6');
});

test('a row without a usable date is dropped rather than stored wrong', () => {
  const parsed = parseCalendar([row('PRAJIND', '', 'Results'), row('PRAJIND', '08-Sep-2026', 'Results')]);
  assert.equal(parsed.length, 1);
});

// ---- storing ----------------------------------------------------------------------------------

test('only followed names are stored', async () => {
  const r = await storeCalendar(parseCalendar([
    row('PRAJIND', inDays(3), 'Financial Results'),
    row('SOMEONE', inDays(3), 'Financial Results'),
  ]));
  assert.equal(r.seen, 2);
  assert.equal(r.stored, 1, 'the other 2,000 listed companies are not this desk’s problem');
});

test('re-fetching the same calendar updates rather than duplicates', async () => {
  const feed = [row('PRAJIND', inDays(3), 'Financial Results', 'Q2 results')];
  await storeCalendar(parseCalendar(feed));
  const again = await storeCalendar(parseCalendar(
    [row('PRAJIND', inDays(3), 'Financial Results', 'Q2 results and dividend')],
  ));
  assert.equal(again.stored, 1);
  assert.equal(await count(), 1, 'same company, date and purpose is the same event');
  const title = await readTxn(async (c) => {
    const { rows } = await c.query<{ title: string }>('SELECT title FROM calendar_events');
    return rows[0]!.title;
  });
  assert.equal(title, 'Q2 results and dividend', 'and the newer description wins');
});

test('two purposes sharing a long prefix stay two events', async () => {
  // The id is hashed, not a truncated key: these differ only past character forty.
  const long = 'To consider other business matters as specified in the attached document regarding the ';
  await storeCalendar(parseCalendar([
    row('PRAJIND', inDays(3), `${long}annual general meeting`),
    row('PRAJIND', inDays(3), `${long}extraordinary general meeting`),
  ]));
  assert.equal(await count(), 2);
});

test('a results meeting is filed as results, anything else as a board meeting', async () => {
  await storeCalendar(parseCalendar([
    row('PRAJIND', inDays(3), 'Financial Results'),
    row('PRAJIND', inDays(4), 'Fund Raising'),
  ]));
  const kinds = await readTxn(async (c) => {
    const { rows } = await c.query<{ kind: string }>(
      'SELECT kind FROM calendar_events ORDER BY on_date',
    );
    return rows.map((r) => r.kind);
  });
  assert.deepEqual(kinds, ['results', 'board_meeting']);
});

// ---- withdrawal -------------------------------------------------------------------------------

test('a cancelled meeting is withdrawn, not left sitting on the desk', async () => {
  await storeCalendar(parseCalendar([
    row('PRAJIND', inDays(3), 'Financial Results'),
    row('PRAJIND', inDays(5), 'Fund Raising'),
  ]));
  const r = await storeCalendar(parseCalendar([
    row('PRAJIND', inDays(3), 'Financial Results'),
    row('PRAJIND', inDays(5), 'Other business matters'),
  ]));
  assert.equal(r.withdrawn, 1, 'the fund raising meeting is gone from the feed');
  assert.equal(await count(), 2);
});

test('a shrinking feed cannot delete events beyond the window it covers', async () => {
  // The failure this guards: NSE returns a fortnight one day and three days the next. Treating the
  // short feed as authoritative over everything would wipe real dates the desk is waiting on.
  await storeCalendar(parseCalendar([
    row('PRAJIND', inDays(2), 'Financial Results'),
    row('PRAJIND', inDays(20), 'Annual General Meeting'),
  ]));
  const r = await storeCalendar(parseCalendar([row('PRAJIND', inDays(2), 'Financial Results')]));
  assert.equal(r.withdrawn, 0);
  assert.equal(await count(), 2, 'the AGM three weeks out survives a short feed');
});

test('an empty feed withdraws nothing at all', async () => {
  await storeCalendar(parseCalendar([row('PRAJIND', inDays(2), 'Financial Results')]));
  const r = await storeCalendar([]);
  assert.equal(r.withdrawn, 0, 'a failed fetch that parses to nothing must not clear the calendar');
  assert.equal(await count(), 1);
});

test('a date that has passed is left alone', async () => {
  await storeCalendar(parseCalendar([row('PRAJIND', inDays(-5), 'Financial Results')]));
  const r = await storeCalendar(parseCalendar([
    row('PRAJIND', inDays(-6), 'Board Meeting'),
    row('PRAJIND', inDays(2), 'Financial Results'),
  ]));
  assert.equal(r.withdrawn, 0, 'what already happened is a record, not a plan');
  assert.equal(await count(), 3);
});

// ---- the desk ---------------------------------------------------------------------------------

test('upcoming shows the fortnight ahead and not the month', async () => {
  await storeCalendar(parseCalendar([
    row('PRAJIND', inDays(-2), 'Financial Results'),
    row('PRAJIND', inDays(4), 'Fund Raising'),
    row('PRAJIND', inDays(25), 'Annual General Meeting'),
  ]));
  const soon = await upcoming(14);
  assert.equal(soon.length, 1);
  assert.equal(soon[0]?.symbol, 'PRAJIND');
  assert.equal(soon[0]?.onDate, iso(4));
});

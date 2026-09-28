/**
 * Storing corporate actions.
 *
 * The parse has its own file. What is pinned here is everything around it: which announcements are
 * ours, what identifies one, and the two ways a re-fetch could quietly corrupt a book that has
 * already been replayed.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { readTxn, serviceTxn } from '../db.ts';
import { asDate, parseAnnouncements, storeAnnouncements } from './corporate-actions.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `folio_ca_${process.pid}`;
const OURS = 'c_ours';

/** Shaped like the live feed, "-" and all. */
const row = (symbol: string, exDate: string, subject: string, recDate = '-') => ({
  symbol, exDate, recDate, subject, series: 'EQ', comp: `${symbol} Limited`, isin: 'INE074A01025',
});

const stored = () =>
  readTxn(async (c) => {
    const { rows } = await c.query<{
      kind: string; record_date: string; ex_date: string;
      ratio_from: string | null; ratio_to: string | null; amount_per_share: string | null;
      subject: string | null; applied_at: Date | null; id: string;
    }>(
      `SELECT id, kind, record_date::text, ex_date::text, ratio_from::text, ratio_to::text,
              amount_per_share::text, subject, applied_at
         FROM corporate_actions ORDER BY kind`,
    );
    return rows;
  });

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'PRAJIND','Praj')", [OURS]);
    // An applied action has to name who applied it — the table's own CHECK says so — so the
    // confirmed-action test needs a real person to have done it.
    await c.query("INSERT INTO actors (id,kind,label) VALUES ('p1','person','T')");
    await c.query("INSERT INTO users (id,email,name) VALUES ('p1','t@x.com','T')");
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query('DELETE FROM corporate_actions');
  });
});

// ---- reading the feed's own fields ---------------------------------------------------------------

test('a "-" is not a date', () => {
  assert.equal(asDate('06-Aug-2026'), '2026-08-06');
  assert.equal(asDate('-'), null);
  assert.equal(asDate(''), null);
});

test('an announcement with no ex-date is not an announcement', () => {
  // The ex-date is on every one of the 19,036 rows in the corpus. A row without one has nothing to
  // replay against, and a row without a subject has nothing to say.
  const out = parseAnnouncements([
    row('PRAJIND', '06-Aug-2026', 'Dividend - Rs 3.60 Per Share'),
    row('PRAJIND', '-', 'Dividend - Rs 1 Per Share'),
    row('PRAJIND', '07-Aug-2026', ''),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.exDate, '2026-08-06');
  assert.equal(out[0]?.recordDate, null);
});

// ---- what is ours ---------------------------------------------------------------------------------

test('only followed names are stored, and the rest are not even counted as declined', async () => {
  const r = await storeAnnouncements(parseAnnouncements([
    row('PRAJIND', '06-Aug-2026', 'Dividend - Rs 3.60 Per Share'),
    row('RELIANCE', '06-Aug-2026', 'Dividend - Rs 10 Per Share'),
  ]));
  assert.equal(r.seen, 2);
  assert.equal(r.ours, 1, 'one followed name');
  assert.equal(r.stored, 1);
  assert.deepEqual(r.declined, {}, 'a company we do not follow is not a parse failure');
});

test('what was refused is counted and named, so a new form is visible', async () => {
  const r = await storeAnnouncements(parseAnnouncements([
    row('PRAJIND', '01-Aug-2026', 'Annual General Meeting'),
    row('PRAJIND', '02-Aug-2026', 'RIGHTS 1:1 @ PREMIUM RS 10/-'),
    row('PRAJIND', '03-Aug-2026', 'Scheme Of Arrangement - Bonus NCRPS 4:1'),
  ]));
  assert.equal(r.stored, 0);
  assert.equal(Object.values(r.declined).reduce((a, b) => a + b, 0), 3);
  assert.ok(Object.keys(r.declined).some((k) => /preference/.test(k)));
});

// ---- the record date -------------------------------------------------------------------------------

test('the exchange’s record date is used where it states one', async () => {
  await storeAnnouncements(parseAnnouncements([
    row('PRAJIND', '04-Aug-2026', 'Dividend - Rs 2 Per Share', '06-Aug-2026'),
  ]));
  const [a] = await stored();
  assert.equal(a?.record_date, '2026-08-06');
  assert.equal(a?.ex_date, '2026-08-04');
});

test('where it states none, the ex-date stands in', async () => {
  // 9,100 of 19,036 rows carry "-" for the record date, real dividends among them. The ex-date is
  // never later than the record date, so it can only be conservative about who was on the register.
  await storeAnnouncements(parseAnnouncements([
    row('PRAJIND', '04-Aug-2026', 'Dividend - Rs 2 Per Share'),
  ]));
  const [a] = await stored();
  assert.equal(a?.record_date, '2026-08-04');
});

// ---- identity, and the two ways a re-fetch could corrupt the book -------------------------------

test('the id survives the exchange filling in a record date later', async () => {
  // The trap that made the id key on the ex-date. NSE publishes with recDate "-" and completes it
  // days later; an id built from the record date would mint a SECOND row for the same action, and
  // the desk would be asked to confirm one dividend twice.
  await storeAnnouncements(parseAnnouncements([
    row('PRAJIND', '04-Aug-2026', 'Dividend - Rs 2 Per Share'),
  ]));
  const first = await stored();
  await storeAnnouncements(parseAnnouncements([
    row('PRAJIND', '04-Aug-2026', 'Dividend - Rs 2 Per Share', '06-Aug-2026'),
  ]));
  const second = await stored();
  assert.equal(second.length, 1, 'still one action');
  assert.equal(second[0]?.id, first[0]?.id, 'and the same one');
  assert.equal(second[0]?.record_date, '2026-08-06', 'now carrying the date it was given');
});

test('re-fetching the same window changes nothing', async () => {
  const feed = parseAnnouncements([row('PRAJIND', '06-Aug-2026', 'Dividend - Rs 3.60 Per Share')]);
  await storeAnnouncements(feed);
  await storeAnnouncements(feed);
  assert.equal((await stored()).length, 1);
});

test('an action a person has confirmed is never rewritten', async () => {
  // History does not get revised by a re-fetch. Without the guard, a corrected announcement would
  // silently change the numbers a position was already replayed against, and the holdings table
  // would disagree with the action that produced it with nothing to say which was right.
  await storeAnnouncements(parseAnnouncements([
    row('PRAJIND', '06-Aug-2026', 'Dividend - Rs 3.60 Per Share'),
  ]));
  await serviceTxn('system:ingest', async (c) => {
    await c.query("UPDATE corporate_actions SET applied_at = now(), applied_by = 'p1'");
  });

  await storeAnnouncements(parseAnnouncements([
    row('PRAJIND', '06-Aug-2026', 'Dividend - Rs 3.60 Per Share', '08-Aug-2026'),
  ]));
  const [a] = await stored();
  assert.equal(a?.record_date, '2026-08-06', 'the confirmed date stands');
  assert.equal(a?.amount_per_share, '3.6000');
});

// ---- one line, two rows ---------------------------------------------------------------------------

test('an announcement carrying two actions becomes two rows, each confirmable alone', async () => {
  const r = await storeAnnouncements(parseAnnouncements([
    row('PRAJIND', '06-Aug-2026', 'BONUS 3:1/DIVIDEND - RS 30 PER SHARE'),
  ]));
  assert.equal(r.stored, 2);
  const rows = await stored();
  assert.deepEqual(rows.map((x) => x.kind), ['bonus', 'dividend']);
  const bonus = rows.find((x) => x.kind === 'bonus')!;
  assert.equal(Number(bonus.ratio_to) / Number(bonus.ratio_from), 4);
  assert.equal(rows.find((x) => x.kind === 'dividend')?.amount_per_share, '30.0000');
  // Both carry the line they came from, so the desk can see one announcement behind two rows.
  assert.ok(rows.every((x) => x.subject === 'BONUS 3:1/DIVIDEND - RS 30 PER SHARE'));
});

test('the shape the table demands is the shape that is written', async () => {
  await storeAnnouncements(parseAnnouncements([
    row('PRAJIND', '01-Sep-2026', 'Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share'),
  ]));
  const [a] = await stored();
  assert.equal(a?.kind, 'split');
  assert.equal(Number(a?.ratio_to) / Number(a?.ratio_from), 10);
  assert.equal(a?.amount_per_share, null, 'the CHECK refuses a split carrying an amount');
});

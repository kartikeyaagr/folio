import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nseDate, nseTimestamp } from './dates.ts';

test('DD-MMM-YYYY reads, in either case, with or without a trailing time', () => {
  assert.equal(nseDate('08-Sep-2026'), '2026-09-08');
  assert.equal(nseDate('31-DEC-2025'), '2025-12-31');
  assert.equal(nseDate('10-Dec-2025 15:23'), '2025-12-10');
});

test('a three-letter token that is not a month is not a month', () => {
  // The guard this file exists to hold in one place. `'janfebmar…'.indexOf` matches at offsets
  // that are not multiples of three, so without the `% 3` these parse as real months:
  //   'rap' at 8 -> month 3, 'bma' at 5 -> month 2, 'nfe' at 2 -> month 1.
  assert.equal(nseDate('08-Sxp-2026'), null, 'a month that does not exist is not month 6');
  assert.equal(nseDate('08-rap-2026'), null);
  assert.equal(nseDate('08-bma-2026'), null);
  assert.equal(nseDate('08-nfe-2026'), null);
});

test('anything that is not that shape is null, not a guess', () => {
  for (const v of ['2026-09-08', 'Q1 2026', '-', '', null, undefined, '8-Sep-2026']) {
    assert.equal(nseDate(v), null, `${String(v)} should not parse`);
  }
});

test('a timestamp is read as IST, because NSE publishes in IST and says so nowhere', () => {
  assert.equal(nseTimestamp('08-Sep-2026 09:30:00')?.toISOString(), '2026-09-08T04:00:00.000Z');
});

test('a date with no time is not a timestamp', () => {
  assert.equal(nseTimestamp('08-Sep-2026'), null);
  assert.equal(nseTimestamp('08-Sxp-2026 09:30:00'), null);
});

test('a day the month does not have is null, in both readers', () => {
  // The month guard was the only calendar check here: the day was whatever two digits the regex
  // matched, pasted into the output string. The two readers then failed differently, and the
  // second way is the dangerous one.
  //
  // `nseDate` returned strings no calendar has — `2026-02-31`, `2026-01-00`, `2026-01-99`. Those
  // go into a `date` column, Postgres rejects them, and the throw abandons the whole file. This
  // module's own header promises the opposite: "a row whose date will not parse is a row to drop
  // rather than a reason to abandon the file."
  for (const [input, why] of [
    ['31-Feb-2026', 'February has no 31st'],
    ['30-Feb-2026', 'nor a 30th'],
    ['31-Apr-2026', 'April has 30 days'],
    ['29-Feb-2026', '2026 is not a leap year'],
    ['00-Jan-2026', 'there is no zeroth day'],
    ['99-Jan-2026', 'nor a 99th'],
  ] as const) {
    assert.equal(nseDate(input), null, `${input}: ${why}`);
  }

  // `nseTimestamp` was worse than a bad string. `new Date('2026-02-30T10:00:00+05:30')` is not an
  // Invalid Date — it rolls over — so the `Number.isNaN` guard never fired and Feb 30 was stored
  // as **2 March**. A loud refusal became a quiet wrong answer two days out, on the field that
  // records when a filing was announced.
  assert.equal(nseTimestamp('30-Feb-2026 10:00:00'), null, 'must refuse, not roll into March');
  assert.equal(nseTimestamp('00-Jan-2026 10:00:00'), null);

  // The real leap day still reads, which is what stops this guard being an off-by-one.
  assert.equal(nseDate('29-Feb-2024'), '2024-02-29');
  assert.equal(nseTimestamp('29-Feb-2024 10:00:00')?.toISOString(), '2024-02-29T04:30:00.000Z');
  assert.equal(nseDate('31-Dec-2025'), '2025-12-31');
  assert.equal(nseDate('30-Apr-2026'), '2026-04-30');
});

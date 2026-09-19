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

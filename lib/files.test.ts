/**
 * The name a filed document goes by.
 *
 * Its own test because the format is a promise two screens and a page heading all keep separately,
 * and because the month is exactly the thing that drifts without a type error. `Intl` spells
 * September "Sept" under en-IN and en-GB and "Sep" under en-US, and SQL's `to_char` says "Sep", so
 * every hand-rolled formatter picks a dialect by accident. This one spells from `lib/months.ts`,
 * like every date in the app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FILE_LABEL, periodName } from './files.ts';
import { MONTHS } from './months.ts';

test('a quarterly document is named for its month, its year and what it is', () => {
  assert.equal(periodName('transcript', '2026-08-20'), 'Aug 2026 Transcript');
  assert.equal(periodName('presentation', '2026-08-13'), 'Aug 2026 PPT');
});

test('September is Sep, as every other date in the app spells it', () => {
  // The date column beside this title is `dayMonthYear`, which reads "13 Sep 2026". Until
  // 28-Sep-2026 both were page-local en-IN formatters and both said "Sept". Moving one without the
  // other put "Sept 2026 Transcript" beside "13 Sep 2026" on the same row.
  assert.equal(periodName('transcript', '2026-09-13'), 'Sep 2026 Transcript');
});

test('every month is the three letters the date column uses, never what Intl happens to say', () => {
  for (let m = 1; m <= 12; m++) {
    const on = `2026-${String(m).padStart(2, '0')}-15`;
    assert.equal(periodName('transcript', on).split(' ')[0], MONTHS[m - 1], on);
  }
});

test('a document with no month in its identity keeps its plain name', () => {
  // An annual report is named by its financial year, which is already its date; a spreadsheet has a
  // title somebody typed. Prefixing either with a month would be inventing a period.
  assert.equal(periodName('annual_report', '2026-09-01'), 'Annual report');
  assert.equal(periodName('excel', '2026-01-02'), 'Spreadsheet');
});

test('an undated document falls back to the bare kind rather than to a wrong month', () => {
  assert.equal(periodName('transcript', null), 'Transcript');
  assert.equal(periodName('presentation', 'not a date'), 'PPT');
});

test('a kind with no label renders as itself rather than as undefined', () => {
  assert.equal(periodName('something_new', '2026-08-20'), 'something_new');
  assert.equal(FILE_LABEL['transcript'], 'Transcript');
});

test('the boundary is the Asia/Kolkata day, not UTC', () => {
  // 2026-09-01 IST is 2026-08-31T18:30Z. Formatted in UTC this reads August, and the document would
  // be named for the month before the one the exchange published it in.
  assert.equal(periodName('transcript', '2026-09-01'), 'Sep 2026 Transcript');
});

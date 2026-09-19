/**
 * The name a filed document goes by.
 *
 * Its own test because the format is a promise two screens and a page heading all keep separately,
 * and because the reason it is computed rather than stored is a month-name disagreement that no
 * type system would have caught: `to_char(…, 'Mon')` gives `Sep` where `Intl` under `en-IN` gives
 * `Sept`, so a title written by SQL and one written by TypeScript differ for one month a year.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FILE_LABEL, periodName } from './files.ts';

test('a quarterly document is named for its month, its year and what it is', () => {
  assert.equal(periodName('transcript', '2026-08-20'), 'Aug 2026 Transcript');
  assert.equal(periodName('presentation', '2026-08-13'), 'Aug 2026 PPT');
});

test('September is Sept, which is the whole reason this is not stored', () => {
  // `to_char(make_date(2026,9,15),'Mon')` is `Sep`. A migration renaming these rows and the job
  // promoting the next one would disagree, once a year, silently.
  assert.equal(periodName('transcript', '2026-09-13'), 'Sept 2026 Transcript');
});

test('the month agrees with the date column beside it, because both come from en-IN', () => {
  const shown = new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeZone: 'Asia/Kolkata',
  }).format(new Date('2026-09-13T00:00:00+05:30'));
  assert.ok(shown.includes('Sept'), `the date column renders ${shown}`);
  assert.ok(periodName('transcript', '2026-09-13').startsWith('Sept'));
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
  assert.equal(periodName('transcript', '2026-09-01'), 'Sept 2026 Transcript');
});

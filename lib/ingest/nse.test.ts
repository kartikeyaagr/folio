import { test } from 'node:test';
import assert from 'node:assert/strict';

import { field, parseCsv, parseCsvRows } from './nse.ts';

/**
 * The CSV reader is tested here rather than only through its callers, because it has three of
 * them and they do not want the same thing. `securities.ts` and `bhavcopy.ts` look columns up by
 * name against a file NSE generates. `lib/import/index.ts` hands it whatever somebody uploaded
 * from the fund's shared drive, which is where the interesting inputs come from.
 *
 * Two of the cases below used to pass silently with the wrong answer: a quoted newline, and two
 * columns sharing a name. The byte-order mark was already handled, but only by accident —
 * `String.prototype.trim()` counts U+FEFF as whitespace, so the old reader stripped it without
 * meaning to. It is pinned here so the next reader does not have to rediscover that.
 */

test('a quoted field may contain a newline', () => {
  // Excel writes this whenever a cell has a line break in it. The previous reader split the text
  // on newlines before it looked at quotes, so this became two rows and every later column on
  // both of them was shifted by one.
  const rows = parseCsvRows('SYMBOL,ADDRESS\nPRAJIND,"Praj Tower,\n Pune"');
  assert.equal(rows.length, 2, 'a newline inside quotes is content, not a row break');
  assert.deepEqual(rows[1], ['PRAJIND', 'Praj Tower,\n Pune']);
});

test('a leading byte-order mark is not part of the first column name', () => {
  // Excel prefixes a UTF-8 BOM on export. Unstripped, the first header reads "﻿SYMBOL" and
  // every lookup of SYMBOL misses, so the row is skipped as headerless.
  const rows = parseCsv('﻿SYMBOL,ISIN\nPRAJIND,INE074A01025');
  assert.equal(field(rows[0]!, 'SYMBOL'), 'PRAJIND');
});

test('a doubled quote inside a quoted field is one quote', () => {
  const rows = parseCsvRows('NAME\n"Praj ""Industries"" Ltd"');
  assert.deepEqual(rows[1], ['Praj "Industries" Ltd']);
});

test('rows shorter than the header are padded, not dropped', () => {
  // NSE's masters are ragged in places. A short row must still read, with the missing tail empty.
  const rows = parseCsv('SYMBOL,ISIN,SERIES\nPRAJIND,INE074A01025');
  assert.equal(rows[0]!['SYMBOL'], 'PRAJIND');
  assert.equal(rows[0]!['SERIES'], '');
});

test('CRLF line endings and blank lines are handled', () => {
  // NSE serves CRLF, and the archive files end with a trailing newline.
  const rows = parseCsv('SYMBOL,ISIN\r\nPRAJIND,INE074A01025\r\n\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!['ISIN'], 'INE074A01025');
});

test('whitespace around a delimiter is not part of the value', () => {
  const rows = parseCsv('SYMBOL, ISIN\nPRAJIND, INE074A01025');
  assert.equal(rows[0]!['ISIN'], 'INE074A01025');
});

test('a header-only file has no rows', () => {
  assert.deepEqual(parseCsv('SYMBOL,ISIN'), []);
  assert.deepEqual(parseCsv(''), []);
});

test('parseCsvRows keeps columns that share a name', () => {
  // The keyed form cannot: two columns called Total collapse to one. That is correct for NSE's
  // masters, where a name is how you find a column, and wrong for an imported grid, where the
  // column's position is its identity. `csvToSheet` uses the positional form for that reason.
  const rows = parseCsvRows('Year,Total,Total\n2026,10,20');
  assert.deepEqual(rows[1], ['2026', '10', '20']);
});

test('field() reads NSE both spellings of a column', () => {
  // The mainboard master says "NAME OF COMPANY"; the SME master says "NAME_OF_COMPANY".
  const spaced = parseCsv('SYMBOL,NAME OF COMPANY\nPRAJIND,Praj Industries')[0]!;
  const under = parseCsv('SYMBOL,NAME_OF_COMPANY\nAERON,Aeron Composite')[0]!;
  assert.equal(field(spaced, 'NAME OF COMPANY', 'NAME_OF_COMPANY'), 'Praj Industries');
  assert.equal(field(under, 'NAME OF COMPANY', 'NAME_OF_COMPANY'), 'Aeron Composite');
});

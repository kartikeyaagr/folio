/**
 * The brief as mail, and the line that says who wrote it.
 *
 * Pure, so no database: what lands in three inboxes at 08:03 is decided here, and the part that
 * matters most is that nothing unreviewed passes for reviewed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { briefMail, briefText, provenance } from './briefs.ts';

/** 08:03 IST on Monday 28-Sep-2026. */
const EIGHT_OH_THREE = new Date('2026-09-28T02:33:00Z');

const BRIEF = {
  period: 'The last 24 hours',
  by_company: [
    { symbol: 'TEGA', what_happened: ['The CFO resigned.', 'A new auditor.'], why_it_matters: 'Watch it.' },
  ],
  nothing_to_report: ['AERON', 'PRAJIND'],
  coming_up: ['TEGA — results, 30 September'],
};

const SCHEDULED = { writtenAt: EIGHT_OH_THREE, published: true, acceptedBy: null, askedBy: null };

test('the subject says what is inside, and the day it is for', () => {
  const { subject } = briefMail(BRIEF, SCHEDULED);
  assert.equal(subject, 'Folio brief — Mon 28 Sep: 1 name, 2 quiet', 'Sep, never en-GB’s "Sept"');
});

test('the mail carries the whole brief, filings and quiet names and all', () => {
  const { body } = briefMail(BRIEF, SCHEDULED);
  assert.match(body, /^The last 24 hours\n/);
  assert.match(body, /── TEGA ──\n\n {2}• The CFO resigned\.\n {2}• A new auditor\.\n\n {2}Watch it\./);
  assert.match(body, /── Nothing to report ──\n\n {2}AERON · PRAJIND/, 'the quiet names are the point');
  assert.match(body, /── Coming up ──\n\n {2}• TEGA — results, 30 September/);
});

test('an unreviewed brief says so, in the mail and on the page alike', () => {
  assert.match(briefMail(BRIEF, SCHEDULED).body,
    /Written by the news brief agent · Mon 28 Sep, 08:03 · not reviewed/);
  assert.equal(
    provenance({ ...SCHEDULED, askedBy: 'Anna' }, 'Mon 28 Sep, 15:10'),
    'Asked for by Anna · written by the news brief agent · Mon 28 Sep, 15:10 · not reviewed',
  );
});

test('a brief somebody accepted before 28-Sep-2026 still says who', () => {
  const line = provenance(
    { writtenAt: EIGHT_OH_THREE, published: false, acceptedBy: 'Bob', askedBy: 'Anna' },
    'Mon 21 Sep, 09:10');
  assert.equal(line, 'Accepted by Bob · Mon 21 Sep, 09:10');
  assert.doesNotMatch(line, /not reviewed/);
});

test('a malformed section is dropped rather than breaking the mail', () => {
  // Stored jsonb comes back untyped. The page drops what it cannot read, and so does this.
  const text = briefText({
    by_company: [{ what_happened: ['no symbol'] }, 'not a section',
      { symbol: 'TEGA', what_happened: [7, 'a line'] }],
    nothing_to_report: 'not a list',
  });
  assert.match(text, /── TEGA ──\n\n {2}• a line/);
  assert.doesNotMatch(text, /no symbol|not a section|not a list|7/);
});

test('a brief with nothing in it says so, rather than sending an empty mail', () => {
  assert.equal(briefText({ period: 'x', by_company: [], nothing_to_report: [], coming_up: [] }),
    'This brief has no content.\n');
});

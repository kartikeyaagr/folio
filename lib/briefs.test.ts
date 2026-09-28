/**
 * The brief as mail, and the line that says who wrote it.
 *
 * Pure, so no database: what lands in three inboxes at 08:03 is decided here, and the part that
 * matters most is that nothing unreviewed passes for reviewed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { briefMail, briefText, majorUpdates, provenance, tally } from './briefs.ts';

/** 08:03 IST on Monday 28-Sep-2026. */
const EIGHT_OH_THREE = new Date('2026-09-28T02:33:00Z');

/** A brief as they were written before 0068: the followed names alone. */
const BEFORE = {
  period: 'The last 24 hours',
  by_company: [
    { symbol: 'TEGA', what_happened: ['The CFO resigned.', 'A new auditor.'], why_it_matters: 'Watch it.' },
  ],
  nothing_to_report: ['AERON', 'PRAJIND'],
  coming_up: ['TEGA — results, 30 September'],
};

const BRIEF = {
  ...BEFORE,
  headline: 'Tega’s CFO resigned, and the RBI held rates.',
  major_updates: [
    {
      what_happened: 'The RBI held the repo rate at 5.5%.',
      why_it_matters: 'Rates set what small caps pay to borrow.',
      outlets: ['Mint', 'Economic Times'],
    },
    { what_happened: 'Crude crossed $108.', why_it_matters: 'An input cost for chemicals.', outlets: ['FT'] },
  ],
};

const SCHEDULED = { writtenAt: EIGHT_OH_THREE, published: true, acceptedBy: null, askedBy: null };

test('the subject says what is inside, and the day it is for', () => {
  const { subject } = briefMail(BRIEF, SCHEDULED);
  assert.equal(subject, 'Folio brief — Mon 28 Sep: 1 name, 2 quiet, 2 major updates',
    'Sep, never en-GB’s "Sept"');
  assert.equal(briefMail(BEFORE, SCHEDULED).subject, 'Folio brief — Mon 28 Sep: 1 name, 2 quiet',
    'and a brief from before the major updates reads as it always did');
});

test('the headline leads, and each major update says what, why, and which outlets ran it', () => {
  const { body } = briefMail(BRIEF, SCHEDULED);
  assert.match(body, /not reviewed\n\nTega’s CFO resigned, and the RBI held rates\.\n\n── TEGA ──/);
  assert.match(body,
    /── Nothing to report ──\n\n {2}AERON · PRAJIND\n\n── Major updates ──\n\n {2}• The RBI held the repo rate at 5\.5%\.\n {4}Rates set what small caps pay to borrow\.\n {4}Mint · Economic Times\n\n {2}• Crude crossed \$108\.\n {4}An input cost for chemicals\.\n {4}FT\n\n── Coming up ──/,
    'the book, then the market, then what is scheduled');
  assert.doesNotMatch(briefText(BEFORE), /Major updates/, 'nothing is shown where nothing was written');
});

test('a brief with no followed name is the market alone, and its subject counts no zeros', () => {
  const market = { ...BRIEF, by_company: [], nothing_to_report: [], coming_up: [] };
  assert.equal(briefMail(market, SCHEDULED).subject, 'Folio brief — Mon 28 Sep: 2 major updates');
  const text = briefText(market);
  assert.match(text, /^Tega’s CFO resigned, and the RBI held rates\.\n\n── Major updates ──/);
  assert.doesNotMatch(text, /Nothing to report|Coming up/);
});

test('a brief that reported no major update says so, rather than leaving the section out', () => {
  const none = { ...BRIEF, major_updates: [] };
  assert.match(briefText(none), /── Major updates ──\n\n {2}None reported\.\n/);
  assert.equal(briefMail(none, SCHEDULED).subject, 'Folio brief — Mon 28 Sep: 1 name, 2 quiet, no major updates');
  assert.deepEqual(majorUpdates([]), [], 'empty, which is an answer');
  assert.equal(majorUpdates(undefined), null, 'where absent is not one');
});

test('a malformed major update is dropped, and the rest keep where they were', () => {
  const read = majorUpdates([
    { why_it_matters: 'no what' }, 'not an update',
    { what_happened: 'A line.', outlets: [7, 'Mint'] },
    { what_happened: 'No outlets.' },
  ]);
  assert.deepEqual(read, [
    { index: 2, what_happened: 'A line.', why_it_matters: '', outlets: ['Mint'] },
    { index: 3, what_happened: 'No outlets.', why_it_matters: '', outlets: [] },
  ], 'the page and the mail read the same elements, each still knowing its place');
  assert.match(briefText({ major_updates: [{ what_happened: 'No outlets.' }] }),
    /• No outlets\.\n {4}No outlet named\./, 'and an outlet nobody named is said, not left blank');
  assert.equal(majorUpdates('not a list'), null);
});

test('the tally leaves out what would be a zero', () => {
  assert.equal(tally({ covered: 3, quiet: 0, major: 5 }), '3 names, 5 major updates');
  assert.equal(tally({ covered: 0, quiet: 2, major: null }), '2 quiet');
  assert.equal(tally({ covered: 0, quiet: 0, major: null }), 'nothing in it');
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

/**
 * Deciding what a filing points at.
 *
 * Every case below is a real filename out of the corpus, taken from the 111 attachments stored on
 * 08-Sep-2026. The classifier is conservative by design: anything not clearly one thing is a
 * `filing`, because a presentation mislabelled a transcript hands agent 2 a slide deck and asks it
 * to diff guidance against the last call — and it would produce something fluent and wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, pathFor } from './attachments.ts';

const BASE = 'https://nsearchives.nseindia.com/corporate/';
const CONCALL = 'Analysts/Institutional Investor Meet/Con. Call Updates';

test('the exchange dedicated category is taken at its word', () => {
  // Exact wherever it appears — but it appeared on 1 of PRAJIND's 845 filings, against 115 under
  // the generic heading, so it is sufficient and nowhere near necessary.
  assert.equal(
    classify('Transcript of Analysts/Institutional Investor Meet/Con. Call', `${BASE}anything.pdf`),
    'transcript',
  );
});

test('a transcript is caught by its filename under the generic category', () => {
  for (const name of [
    'PRAJIND_18082026091626_Transcript_of_Analysts_call_18082026.pdf',
    'PRAJIND_10112025153345_TranscriptEarningsCall10112025.pdf',
    'AERON_26112025133124_TRANSCRIPT.pdf',
    'PRAJIND_03062026095032_EarningsCallTranscript29052026.pdf',
  ]) {
    assert.equal(classify(CONCALL, BASE + name), 'transcript', name);
  }
});

test('the near misses in the same category are NOT transcripts', () => {
  // These are the cases that make the category alone useless: all four are filed under the same
  // heading as the transcript, and three of them are notices about a call rather than a record of
  // one. Getting these wrong is how agent 2 ends up summarising a two-page diary note.
  for (const name of [
    'PRAJIND_24082026152431_Intimation_about_participation_Investor_Conference_24082026.pdf',
    'PRAJIND_14082026164603_Audio_Recording_of_Analyst_Call_14082026.pdf',
    'PRAJIND_07082026125756_Intimation_of_schedule_of_Analysts_Call.pdf',
  ]) {
    assert.notEqual(classify(CONCALL, BASE + name), 'transcript', name);
  }
});

test('an investor presentation is separated from the press release beside it', () => {
  assert.equal(
    classify('Press Release', `${BASE}PRAJIND_14082026090554_InvestorPresentationQ113082026.pdf`),
    'presentation',
  );
  assert.equal(
    classify('Press Release', `${BASE}PRAJIND_13082026165322_Praj_Q1_FY27_Results_Release_130826.pdf`),
    'filing',
  );
});

test('a spreadsheet and an archive are their own kinds, not documents to read', () => {
  assert.equal(classify(CONCALL, `${BASE}AERON_ROID_96949_KMP_Doc.zip`), 'other');
  assert.equal(classify('Shareholding Pattern', `${BASE}shp_30062026.xlsx`), 'excel');
  // The extension wins over anything the category says: a zip named "transcript" is still a zip,
  // and unpdf would make nothing of it.
  assert.equal(classify('Transcript of Analysts Call', `${BASE}transcript.zip`), 'other');
});

test('anything unclear stays a filing rather than becoming a guess', () => {
  for (const name of [
    'AERON_05092026182347_NOTICEOFAGM2026.pdf',
    'AERON_29082026184243_OUTCOMEOFBM29082026.pdf',
    'PRAJIND_14082026153826_Scrutinizer_Report_along_with_Voting_Results_AGM_NSE.pdf',
  ]) {
    assert.equal(classify('Outcome of Board Meeting', BASE + name), 'filing', name);
  }
});

test('a URL-encoded filename is decoded before it is read', () => {
  assert.equal(classify(CONCALL, `${BASE}Q1%20FY27%20Transcript.pdf`), 'transcript');
});

test('the store fans out by the first two characters of the sha', () => {
  // One flat directory of tens of thousands of files is slow to list and unpleasant to back up.
  const sha = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  assert.ok(pathFor(sha).endsWith(`/ab/${sha}`), pathFor(sha));
});

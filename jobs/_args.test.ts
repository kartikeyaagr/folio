import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BadUsage, readFlags } from './_args.ts';

/**
 * Two of these describe what the hand-rolled reader did wrong. They are operator-facing rather
 * than data-facing, which is why they had never been caught: nothing fails, the job just does
 * something other than what was asked.
 */

test('a flag reads in both spellings', () => {
  assert.equal(readFlags(['symbol'], [], ['--symbol', 'AERON']).str('symbol'), 'AERON');
  // The equals form was silently unsupported: `--symbol=AERON` read as no symbol at all, and
  // jobs/backfill-filings.ts then backfilled every followed name.
  assert.equal(readFlags(['symbol'], [], ['--symbol=AERON']).str('symbol'), 'AERON');
});

test('an unknown flag is refused rather than ignored', () => {
  // `--symbl AERON` used to mean "every followed name", which is the broadest thing the job does.
  assert.throws(() => readFlags(['symbol'], [], ['--symbl', 'AERON']), BadUsage);
});

test('the refusal names what the job does accept', () => {
  try {
    readFlags(['symbol'], ['dry-run'], ['--nope']);
    assert.fail('should have refused');
  } catch (err) {
    assert.ok(err instanceof BadUsage);
    assert.match(err.message, /--symbol <value>/);
    assert.match(err.message, /--dry-run/);
  }
});

test('a value-taking flag given another flag as its value is refused', () => {
  // `set-admin --email --revoke` read "--revoke" as the address, then reported no such account.
  assert.throws(() => readFlags(['email'], ['revoke'], ['--email', '--revoke']), BadUsage);
});

test('a boolean flag is present or absent, never a string', () => {
  const on = readFlags([], ['list'], ['--list']);
  assert.equal(on.bool('list'), true);
  assert.equal(readFlags([], ['list'], []).bool('list'), false);
});

test('an absent flag is undefined, so a job can fall back to its default', () => {
  assert.equal(readFlags(['days'], [], []).str('days'), undefined);
});

test('a positional argument is refused, because no job here takes one', () => {
  assert.throws(() => readFlags(['symbol'], [], ['AERON']), BadUsage);
});

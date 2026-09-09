/**
 * Every subject in this file is a real one, copied verbatim out of the 19,036-row corpus fetched
 * from NSE on 09-Sep-2026. None is invented, because an invented subject tests the parser against
 * the grammar I imagined rather than the one the exchange writes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readSubject } from './ca-subject.ts';

const one = (subject: string) => {
  const r = readSubject(subject);
  assert.equal(r.declined, null, `expected to parse, declined: ${r.declined}`);
  assert.equal(r.actions.length, 1, `expected one action, got ${r.actions.length}`);
  return r.actions[0]!;
};

const refused = (subject: string): string => {
  const r = readSubject(subject);
  assert.deepEqual(r.actions, [], 'expected nothing to be taken');
  assert.notEqual(r.declined, null, 'expected a stated reason');
  return r.declined!;
};

/** What replay() will do to a position. The only number that actually matters. */
const factor = (subject: string): number => {
  const a = one(subject);
  return a.ratioTo! / a.ratioFrom!;
};

// ---- bonus: the direction, measured against the bhavcopy step on the ex-date --------------------

test('a bonus is "a new for every b held", so 1:1 doubles', () => {
  // ASHOKLEY 16-Jul-2025 closed 250.90 -> 124.60, a step of x0.497. The position doubled.
  assert.equal(factor('Bonus 1:1'), 2);
});

test('the asymmetric ratios are what rule out the mirror reading', () => {
  // Read as from:to these would be x4 and x0.333. The exchange's own price steps say otherwise:
  // CONCOR 04-Jul-2025 745.25 -> 599.65 is x1.243, and VMART 23-Jun-2025 3556.50 -> 923.40 is x3.85.
  assert.equal(factor('Bonus 1:4'), 1.25);
  assert.equal(factor('Bonus 3:1'), 4);
});

test('a bonus can never shrink a holding', () => {
  for (const s of ['Bonus 1:1', 'Bonus 1:10', 'Bonus 4:1', 'Bonus 1.5:1', 'Bonus 2:5']) {
    assert.ok(factor(s) > 1, `${s} gave ${factor(s)}`);
  }
});

test('the ratio survives a hyphen, spaces and a fraction', () => {
  assert.equal(factor('BONUS- 1:2'), 1.5);
  assert.equal(factor('Bonus 1 : 1'), 2);
  assert.equal(factor('Bonus 1.5:1'), 2.5);
});

// ---- bonus: the two that say BONUS and are not one ----------------------------------------------

test('a bonus of preference shares is not a bonus of equity', () => {
  // Read as a bonus this multiplies a real equity position by five. It issues NCRPS instead, and
  // the equity holding does not move at all. Six rows in eight years.
  assert.match(
    refused('Scheme Of Arrangement - Bonus NCRPS 4:1'),
    /preference/,
  );
  assert.match(refused('BONUS NCRPS 1:116'), /preference/);
});

test('a bonus of debentures is not a bonus of equity', () => {
  assert.match(
    refused('Scheme Of Arangement- Bonus - 1 Debenture For 1 Equity Share Held'),
    /debenture/,
  );
});

// ---- splits, and the one consolidation ----------------------------------------------------------

test('a face value cut multiplies the holding by the same factor', () => {
  // MCX 02-Jan-2026 closed 10989.00 -> 2216.00, a step of x0.202: five times the shares.
  assert.equal(factor('Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share'), 5);
  assert.equal(factor('Face Value Split (Sub-Division) - From Rs 10 Per Share To Rs 5 Per Share'), 2);
});

test('"Re 1" is a rupee too, and 141 splits are written that way', () => {
  assert.equal(factor('Face Value Split (Sub-Division) - From Rs 10/- Per Share To Re 1/- Per Share'), 10);
  assert.equal(factor('Face Value Split (Sub-Division) - From Rs 2/- Per Share To Re 1/- Per Share'), 2);
});

test('a consolidation runs the other way, and is not spelled like a split', () => {
  // The only one in the corpus: VERTOZ, 25-Jun-2025. It says "From Re 1", so a regex that knows
  // only "Rs" misses it — and one that catches it and assumes a split multiplies a position by ten
  // where it must divide by ten.
  assert.equal(
    factor('Consolidation Of Equity Shares From Re 1 Per Share To Rs 10 Per Share'),
    0.1,
  );
});

test('a face value that does not change is not an action', () => {
  assert.match(
    refused('Face Value Split (Sub-Division) - From Rs 10 Per Share To Rs 10 Per Share'),
    /no action|meeting/,
  );
});

// ---- dividends -----------------------------------------------------------------------------------

test('the amount comes off the line, in either spelling of rupee', () => {
  assert.equal(one('Dividend - Rs 3.60 Per Share').amountPerShare, 3.6);
  assert.equal(one('Dividend - Re 1 Per Share').amountPerShare, 1);
  assert.equal(one('DIVIDEND - RE 0.50 PER SHARE').amountPerShare, 0.5);
  assert.equal(one('Interim Dividend - Rs 41 Per Share').amountPerShare, 41);
});

test('an AGM prefix hides 3,381 real dividends and must not decline them', () => {
  assert.equal(one('Annual General Meeting/Dividend - Rs 14 Per Share').amountPerShare, 14);
  assert.equal(one('Annual General Meeting / Dividend -Rs 3 Per Share').amountPerShare, 3);
  // No space at all between the meeting and the dividend, 17 times.
  assert.equal(one('ANNUAL GENERAL MEETINGDIVIDEND - RS 7.50 PER SHARE').amountPerShare, 7.5);
});

test('a meeting with nothing after it is a meeting', () => {
  assert.match(refused('Annual General Meeting'), /meeting/);
  assert.match(refused('Extra Ordinary General Meeting'), /meeting/);
});

test('two dividends on one line are both paid, so both are counted', () => {
  assert.equal(
    one('Annual General Meeting/ Final Dividend - Rs 20 Per Share / Special Dividend - Rs 10 Per Share')
      .amountPerShare,
    30,
  );
  assert.equal(
    one('Interim Dividend - Rs 41 Per Share And Special Dividend - Rs 70 Per Share').amountPerShare,
    111,
  );
  // No separator at all between the two.
  assert.equal(
    one('Interim Dividend - Rs 3.5 Per Share Special Dividend - Rs 3.5 Per Share').amountPerShare,
    7,
  );
});

test('the exchange’s own typing is fixed, not guessed at', () => {
  assert.equal(one('SPECIA LDIVIDEND - RS 850 PER SHARE').amountPerShare, 850);
  assert.equal(one('INTERIM DIVIDNED - RS 135 PER SHARE').amountPerShare, 135);
  assert.equal(one('INTERIMDIVIDEND - RS 1.30 PER SHARE').amountPerShare, 1.3);
  assert.equal(one('INT DIV - RS 0.71 PER SH').amountPerShare, 0.71);
  assert.equal(one('DIVIDEND RS - 11 PER SHARE').amountPerShare, 11);
});

test('a dividend word with no amount beside it refuses the whole line', () => {
  // The rule that stops a partial parse. This one says two dividends and prices one, because the
  // second has no Rs in front of it: summing what matches gives 106 against a true 349.
  assert.match(
    refused('Dividend - Rs 106 Per Share Special Dividend 243 Per Share'),
    /could not be read in full/,
  );
  assert.match(refused('AGM/SPL DIV- RS.5/- DIV-7.5/-'), /could not be read in full/);
  assert.match(refused('Annual General Meeting/ Dividend - 12.50 Per Share'), /could not be read/);
  assert.match(refused('ANNUAL GENERAL MEETING/DIVIDEND - RS PER SHARE'), /could not be read/);
});

test('a dividend is never zero', () => {
  // "Rs 0 .70" is one real row. Read as its integer part it stores a measured zero, which reads as
  // a fact and is the most dangerous cell this system can print.
  assert.equal(one('Dividend - Rs 0 .70 Per Share').amountPerShare, 0.7);
  // No amount at all is caught a step earlier, by the rule that every dividend word needs one.
  assert.match(refused('Interim Dividend'), /could not be read in full/);
  assert.match(refused('Dividend - Rs 0 Per Share'), /stated as zero/);
});

// ---- everything else -----------------------------------------------------------------------------

test('the instruments that are not equity are refused by name', () => {
  assert.match(refused('INTEREST PAYMENT - RS 3.55 PER NCD'), /coupon on debt/);
  assert.match(refused('DISTRIBUTION - RS 3.30 PER UNIT'), /InvIT|REIT/);
});

test('the actions this book cannot represent are refused by name', () => {
  assert.match(refused('RIGHTS 1:1 @ PREMIUM RS 10/-'), /rights/);
  assert.match(refused('BUY BACK'), /buyback/);
  assert.match(refused('DEMERGER'), /scheme/);
  assert.match(refused('CAPITAL REDUCTION'), /capital return/);
});

test('a rights issue is refused even though it carries a ratio', () => {
  // The shape is a bonus and the meaning is not: it costs the subscription price, and only lands
  // if we subscribe. Stored as a bonus it would fabricate shares nobody paid for.
  const r = readSubject('RIGHTS 3:2 @ PREMIUM RS 90/-');
  assert.deepEqual(r.actions, []);
});

// ---- one line, two actions -----------------------------------------------------------------------

test('one announcement can be two actions, and each is confirmed on its own', () => {
  const r = readSubject('BONUS 3:1/DIVIDEND - RS 30 PER SHARE');
  assert.equal(r.declined, null);
  assert.equal(r.actions.length, 2);
  const bonus = r.actions.find((a) => a.kind === 'bonus')!;
  const div = r.actions.find((a) => a.kind === 'dividend')!;
  assert.equal(bonus.ratioTo! / bonus.ratioFrom!, 4);
  assert.equal(div.amountPerShare, 30);
  // The schema's CHECK refuses a row that carries both shapes, and so does this.
  assert.equal(bonus.amountPerShare, null);
  assert.equal(div.ratioFrom, null);
});

test('the shape always matches what the table will accept', () => {
  for (const s of [
    'Bonus 1:1',
    'Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share',
    'Dividend - Rs 3.60 Per Share',
    'BONUS 3:2 /DIVIDEND - RS 0.50 PER SHARE',
  ]) {
    for (const a of readSubject(s).actions) {
      if (a.kind === 'dividend') {
        assert.ok(a.amountPerShare !== null && a.amountPerShare > 0);
        assert.equal(a.ratioFrom, null);
        assert.equal(a.ratioTo, null);
      } else {
        assert.ok(a.ratioFrom !== null && a.ratioFrom > 0);
        assert.ok(a.ratioTo !== null && a.ratioTo > 0);
        assert.equal(a.amountPerShare, null);
      }
    }
  }
});

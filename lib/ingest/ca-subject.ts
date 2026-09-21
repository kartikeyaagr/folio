/**
 * Reading NSE's corporate-action subject line.
 *
 * The feed gives one line of free text per announcement and nothing else structured: no kind, no
 * ratio, no amount. Everything the book needs is in that line, written by a person, in eight years
 * of drifting house style. This module turns it into typed actions or refuses.
 *
 * **Refusing is the default.** `corporate_actions` holds three kinds, and applying the wrong one to
 * a real position is worse than missing it: a bonus parsed backwards halves a holding, and a
 * dividend read off the wrong number writes a cash row nothing else in the system contradicts. So
 * every form here was checked against the corpus, and everything else is declined by name.
 *
 * Measured on 19,036 rows fetched 09-Sep-2026 (2019-2026, equities and SME). The counts in the
 * comments are from that corpus.
 */

export type Kind = 'bonus' | 'split' | 'dividend';

export interface ParsedAction {
  kind: Kind;
  /** replay() multiplies quantity by ratioTo / ratioFrom. Null for a dividend. */
  ratioFrom: number | null;
  ratioTo: number | null;
  amountPerShare: number | null;
}

export interface Reading {
  actions: ParsedAction[];
  /** Why nothing was taken, when nothing was. Counted by the job so a new form is visible. */
  declined: string | null;
}

/**
 * Fix the exchange's own typing, and nothing else.
 *
 * Every substitution below is a string observed verbatim in the corpus, not a class of error
 * guessed at. "ANNUAL GENERAL MEETINGDIVIDEND - RS 5 PER SHARE" is 17 real dividends that a word
 * boundary would drop on the floor; "SPECIA LDIVIDEND - RS 850 PER SHARE" is one more.
 */
export function normalise(subject: string): string {
  return subject
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/ME0ETING/g, 'MEETING')
    .replace(/\bMETING\b/g, 'MEETING')
    // "RS 0 .70 PER SHARE" — one row, and without this it reads as 0.70's integer part and stores
    // a dividend of zero, which is the one thing this system says a cell must never be.
    .replace(/(\d) +\.(\d)/g, '$1.$2')
    .replace(/MEETING(?=DIVIDEND)/g, 'MEETING ')
    .replace(/INTERIMDIVIDEND/g, 'INTERIM DIVIDEND')
    .replace(/SPECIA LDIVIDEND/g, 'SPECIAL DIVIDEND')
    .replace(/SPLECIAL/g, 'SPECIAL')
    .replace(/DIVIDNED|DIVDEND/g, 'DIVIDEND')
    .trim();
}

/**
 * Forms that must never be read as one of our three kinds, with the reason kept for the report.
 *
 * NCRPS and DEBENTURE are the dangerous two. "Scheme Of Arrangement - Bonus NCRPS 4:1" is a bonus
 * issue of non-convertible redeemable *preference* shares, and "Bonus - 1 Debenture For 1 Equity
 * Share Held" is a bonus issue of *debentures*. Both say BONUS, both carry a ratio, and neither
 * changes the equity holding at all — read as a bonus the first multiplies a real position by five.
 * Nine rows in eight years, and they are checked before anything else is.
 */
const DECLINE: [RegExp, string][] = [
  [/\bNCRPS\b|\bPREFERENCE\b/, 'a preference-share issue, not an equity action'],
  [/\bDEBENTURE\b/, 'a debenture issue, not an equity action'],
  [/\bRIGHTS\b/, 'a rights issue: it costs the subscription price and only lands if we subscribe'],
  [/\bBUY[- ]?BACK\b/, 'a buyback: it is a sale we choose to make, entered as a trade'],
  [/\bINTEREST\b|\bNTEREST\b/, 'a coupon on debt, not a dividend on equity'],
  [/\bDISTRIBUTION\b/, 'an InvIT or REIT distribution, not an equity dividend'],
  [/\bDE-?MERGER\b|\bAMALGAMATION\b|\bARRANGEMENT\b|\bSCHEME OF\b/, 'a scheme this book cannot represent'],
  [/\bCAPITAL REDUCTION\b|\bREDEMPTION\b|\bRETURN ON CAPITAL\b/, 'a capital return this book cannot represent'],
];

/**
 * Split a subject into the clauses it announces.
 *
 * The separator is "/" or " AND " — but not the "/" inside "RS 10/- PER SHARE", which would cut a
 * face-value clause in half and leave two unreadable halves.
 *
 * The guard is what follows the slash, not what precedes it. Guarding on a preceding digit was the
 * first attempt and it silently ate a real dividend: "BONUS 3:1/DIVIDEND - RS 30 PER SHARE" has a
 * digit before its slash too, so the announcement stayed one clause, the bonus matched, and the
 * Rs 30 was never read. Only "/-" is part of a number.
 *
 * Some subjects have no separator at all: "Interim Dividend - Rs 3.5 Per Share Special Dividend -
 * Rs 3.5 Per Share" is one clause carrying two amounts, which is why the dividend reader sums
 * everything in its clause rather than taking the first match.
 */
function clauses(s: string): string[] {
  return s
    .split(/\/(?!-)|\bAND\b/)
    .map((c) => c.trim())
    .filter((c) => c !== '');
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;

/**
 * The currency token, which is "RS" or "RE" and sometimes carries a stray dash or full stop.
 *
 * `RS?` was the first attempt and it is wrong in a way nothing catches: it matches "R" followed by
 * an optional "S", so it matches "RS" and it matches "R", and it never matches "RE". A rupee is
 * "Re 1" when there is one of it, and the corpus says "Re 1 Per Share" 1,431 times and "To Re 1/-
 * Per Share" in 141 splits. Every one of them parsed to nothing, silently, with no error anywhere.
 */
const RUPEE = String.raw`\bR[SE]\.?\s*-?\s*`;

/**
 * "BONUS a:b" is **a new shares for every b held**, so the holding becomes (a + b) for every b.
 *
 * Not a convention taken on trust. Measured against the bhavcopy step on the ex-date, on eight
 * single-action cases across four ratios: 1:1 gave x1.95-2.04 against 2.000 (ASHOKLEY, NESTLEIND,
 * VIMTALABS, SHARDAMOTR), 3:1 gave x3.85 against 4.000 (VMART), 1:4 gave x1.243 against 1.250
 * (CONCOR), and 1:2 gave x1.48 and x1.52 against 1.500 (MOTHERSON, MSUMI). The asymmetric two rule
 * out every symmetric misreading. Migration 0009 says the same for the case it names: "A 1:1 bonus
 * is from 1 to 2."
 */
const BONUS = new RegExp(String.raw`\bBONUS\b[\s\-]*${NUM}\s*:\s*${NUM}`);

/**
 * A face-value change, in either direction.
 *
 * "RS" and "RE" alternate — the corpus writes "To Re 1/- Per Share" — and the single consolidation
 * in eight years says "From Re 1 Per Share To Rs 10 Per Share". A regex that only knows "RS" misses
 * it; one that catches it and assumes a split multiplies a position by ten where it should divide
 * by ten. One formula covers both: quantity x (from / to), which falls out of ratioTo / ratioFrom.
 */
const FACE = new RegExp(String.raw`FROM\s+${RUPEE}${NUM}[^0-9]*?TO\s+${RUPEE}${NUM}`);
const FACE_ANCHOR = /\bFACE VALUE\b|\bSUB[- ]?DIVISION\b|\bSPLIT\b|\bCONSOLIDATION\b/;

/** Every rupee amount in a clause. "RS.", "RS 1/-", "RS180", "RS - 4" and "RE 0.50" all appear. */
const AMOUNTS = new RegExp(RUPEE + NUM, 'g');

/** "DIV" abbreviates it in six rows — "INT DIV - RS 0.71 PER SH". The boundary keeps it out of
 *  DIVIDEND itself, so counting both words counts each announcement once. */
const DIVIDEND = /\bDIV(IDEND)?\b/g;

/**
 * Read one subject line.
 *
 * Returns every action it announces — two, for "Bonus 3:1/Dividend - Rs 30 Per Share", which is
 * both — or nothing with the reason why.
 */
export function readSubject(raw: string): Reading {
  const s = normalise(raw);
  if (s === '') return { actions: [], declined: 'empty subject' };

  // Checked against the whole line before any clause is read. A decline word anywhere poisons the
  // announcement: "Scheme Of Arrangement - Bonus NCRPS 4:1" splits into clauses that each look
  // innocent, and the ratio sits in the one that does.
  for (const [re, why] of DECLINE) if (re.test(s)) return { actions: [], declined: why };

  const actions: ParsedAction[] = [];
  let dividend = 0;

  for (const c of clauses(s)) {
    const bonus = BONUS.exec(c);
    if (bonus) {
      const newShares = Number(bonus[1]);
      const heldShares = Number(bonus[2]);
      if (newShares > 0 && heldShares > 0) {
        actions.push({
          kind: 'bonus', ratioFrom: heldShares, ratioTo: newShares + heldShares, amountPerShare: null,
        });
      }
      // Deliberately falls through to the dividend reader below. A bonus ratio carries no rupee
      // token, so it cannot be mistaken for an amount, and a clause that announces both should
      // yield both rather than whichever was checked first.
    }

    if (FACE_ANCHOR.test(c)) {
      const face = FACE.exec(c);
      if (face) {
        const from = Number(face[1]);
        const to = Number(face[2]);
        // Equal face values change nothing and would replay as a no-op wearing the costume of an
        // action somebody has to confirm.
        if (from > 0 && to > 0 && from !== to) {
          actions.push({ kind: 'split', ratioFrom: to, ratioTo: from, amountPerShare: null });
        }
      }
      continue;
    }

    // `match` rather than `test`, because both patterns are global and `test` would carry its
    // lastIndex from one clause into the next.
    const words = c.match(DIVIDEND) ?? [];
    if (words.length > 0) {
      const amounts = [...c.matchAll(AMOUNTS)].map((m) => Number(m[1]));
      // **Every dividend word must have an amount beside it**, or the whole subject is refused.
      //
      // This is the rule that stops a partial parse, which is the worst thing this file could
      // produce: silent, plausible, and wrong. "Dividend - Rs 106 Per Share Special Dividend 243
      // Per Share" says two dividends and prices only one of them, because the second amount has
      // no Rs in front of it — summing what matches gives 106 against a true 349. "AGM/Spl Div-
      // Rs.5/- Div-7.5/-" gives 5 against 12.5. 28 rows in eight years, and each one would have
      // written a cash figure nothing else in the system could contradict.
      if (amounts.length < words.length) {
        return { actions: [], declined: 'a dividend whose amount could not be read in full' };
      }
      for (const a of amounts) dividend += a;
    }
  }

  // Zero is not an amount. "Dividend - Rs 0 .70 Per Share" reads as 0 before the normaliser closes
  // that gap, and a dividend of zero is the most dangerous cell this system can print: an empty one
  // reads as broken and a dash reads as not-applicable, but a zero reads as a measured fact.
  if (dividend > 0) {
    actions.push({ kind: 'dividend', ratioFrom: null, ratioTo: null, amountPerShare: dividend });
  } else if (actions.length === 0 && DIVIDEND.test(s)) {
    DIVIDEND.lastIndex = 0;
    // Reached only when every dividend word had a number beside it and they summed to nothing —
    // "Dividend - Rs 0 Per Share". A stated zero is a different failure from an unreadable amount
    // and is worth its own line in the job's report.
    return { actions: [], declined: 'a dividend stated as zero' };
  }

  if (actions.length === 0) {
    // Meetings are the bulk of it and are not actions — but only once nothing else was found,
    // because 3,381 AGM lines carry a real dividend after the slash.
    if (/\bMEETING\b/.test(s)) return { actions: [], declined: 'a meeting, with no action attached' };
    return { actions: [], declined: 'no action this book can represent' };
  }
  return { actions, declined: null };
}

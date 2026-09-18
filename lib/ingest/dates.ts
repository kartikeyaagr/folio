/**
 * NSE writes its dates `DD-MMM-YYYY`, and every feed reader here had its own copy of this.
 *
 * Seven of them by 18-Sep-2026 — `filings`, `annual-reports`, `insider`, `shareholding`,
 * `calendar`, `corporate-actions`, `securities`. That is fine until you notice the guard had
 * already drifted into two spellings:
 *
 *     if (i < 0 || i % 3 !== 0) return null;                 // four files
 *     if (!Number.isInteger(idx) || idx < 0) return null;    // three files
 *
 * **The guard is not decoration.** `indexOf` on `'janfebmar…'` matches at offsets that are not
 * multiples of three — `'rap'` at 8, `'bma'` at 5, `'nfe'` at 2 — so without it a three-letter
 * token that is not a month parses as one. `08-Sxp-2026` becomes the sixth month rather than
 * nothing, and `calendar.test.ts` says so in as many words: *"a month that does not exist is not
 * month 6"*. A check that matters this much should exist once.
 *
 * **Not `date-fns`.** Its `parse(v, 'dd-MMM-yyyy', ref)` accepts a great deal more than NSE ever
 * sends and coerces quietly, where every call site here deliberately returns `null` on anything
 * unexpected. The strictness is the feature.
 */

const MONTHS = 'janfebmaraprmayjunjulaugsepoctnovdec';

/** Zero-based month, or null. The `% 3` is the guard described above. */
function monthOf(name: string): number | null {
  const i = MONTHS.indexOf(name.toLowerCase());
  return i < 0 || i % 3 !== 0 ? null : i / 3;
}

/** `DD-MMM-YYYY`, optionally followed by a time, which several feeds append. */
const DATE = /^(\d{2})-([A-Za-z]{3})-(\d{4})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/;

/**
 * `DD-MMM-YYYY` → `YYYY-MM-DD`. A trailing time is ignored; anything else is null.
 *
 * Null rather than a throw because these read feed fields one row at a time, and a row whose date
 * will not parse is a row to drop rather than a reason to abandon the file.
 */
export function nseDate(value: unknown): string | null {
  const m = DATE.exec(String(value ?? '').trim());
  if (!m) return null;
  const mon = monthOf(m[2]!);
  if (mon === null) return null;
  return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[1]}`;
}

/**
 * `DD-MMM-YYYY HH:MM:SS` → the instant it names, read as IST.
 *
 * NSE publishes in IST and says so nowhere, so the offset is applied here rather than assumed by
 * whatever timezone the box happens to run in. Null when there is no time: a caller wanting the
 * day should ask for the day.
 */
export function nseTimestamp(value: unknown): Date | null {
  const m = DATE.exec(String(value ?? '').trim());
  if (!m || m[4] === undefined) return null;
  const mon = monthOf(m[2]!);
  if (mon === null) return null;
  const at = new Date(
    `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`,
  );
  return Number.isNaN(at.getTime()) ? null : at;
}

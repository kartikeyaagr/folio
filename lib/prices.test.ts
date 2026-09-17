/**
 * `windowOf`, which is the whole reason the chart can change range without a round trip.
 *
 * It runs in the browser, so everything it depends on has to travel with the data. The one that
 * would not is "today": the window is counted back from a calendar day, and a viewer's clock — or
 * simply their timezone — must not be allowed to decide which day that is. `History.asOf` carries
 * the server's answer and these pin that it is the answer used.
 *
 * Pure, so no database: the query half is one SELECT with no window in it any more.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RANGES, windowOf, type History, type Point } from './prices.ts';

const ASOF = '2026-09-17';

/** `n` closes ending on `asOf`, one per calendar day, rising by ₹1 a day from ₹100. */
function daily(n: number, asOf = ASOF): Point[] {
  const end = Date.parse(`${asOf}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    on: new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    close: 100 + i,
  }));
}

const history = (points: Point[], asOf = ASOF): History => ({
  points,
  heldFrom: points[0]?.on ?? null,
  heldTo: points[points.length - 1]?.on ?? null,
  heldCount: points.length,
  asOf,
});

test('max is every close held, which is what the chart opens on', () => {
  const h = history(daily(900));
  assert.equal(windowOf(h, 'max').points.length, 900);
  assert.equal(windowOf(h, 'max').points[0]!.on, h.heldFrom);
});

test('a narrower range is a slice of the same array, never a second read', () => {
  const h = history(daily(900));
  const wide = windowOf(h, 'max').points.length;
  const year = windowOf(h, '1y').points.length;
  const week = windowOf(h, '1w').points.length;
  assert.ok(week < year && year < wide, `${week} < ${year} < ${wide}`);
  // 1w is 7 days, strictly after the cutoff — the same predicate the SQL used.
  assert.equal(week, 7);
});

test('the window is counted from the history asOf, not from the machine reading it', () => {
  // The same points, told two different "todays". A browser an hour ahead of the server, or in
  // another zone, would otherwise draw a different week than the server rendered.
  const points = daily(30);
  const asServerSees = windowOf(history(points, ASOF), '1w').points.length;
  const aWeekLater = windowOf(history(points, '2026-09-24'), '1w').points.length;
  assert.equal(asServerSees, 7);
  assert.equal(aWeekLater, 0, 'a week that ended before the window opens is empty, and says so');
});

test('the window is calendar days, so a gap in trading shows as a gap', () => {
  // Nine closes, then a fortnight of nothing, then today. A row-count window would reach back and
  // silently fill the same number of points from before the halt.
  const h = history([
    ...daily(9, '2026-08-20'),
    { on: '2026-09-16', close: 500 },
    { on: '2026-09-17', close: 505 },
  ]);
  assert.deepEqual(
    windowOf(h, '1w').points.map((p) => p.on),
    ['2026-09-16', '2026-09-17'],
  );
});

test('change, low and high are over the window and not over the history', () => {
  const h = history(daily(400));
  const all = windowOf(h, 'max');
  const week = windowOf(h, '1w');
  assert.equal(all.low, 100);
  assert.equal(week.low, 100 + 400 - 7);
  assert.ok(all.change!.pct > week.change!.pct, 'a longer window holds a bigger move');
  // Held* is the history either side, so the chart can say what a short range is drawn from.
  assert.equal(week.heldCount, 400);
  assert.equal(week.heldFrom, all.points[0]!.on);
});

test('one close is a price, not a move', () => {
  const week = windowOf(history([{ on: '2026-09-17', close: 700 }]), '1w');
  assert.equal(week.points.length, 1);
  assert.equal(week.change, null);
  assert.equal(week.low, 700);
});

test('a name with no closes yields an empty window rather than a thrown chart', () => {
  const empty = windowOf(history([]), 'max');
  assert.deepEqual(empty.points, []);
  assert.equal(empty.change, null);
  assert.equal(empty.low, null);
  assert.equal(empty.high, null);
  assert.equal(empty.heldCount, 0);
});

test('every offered range is one this can window, so a button cannot be dead', () => {
  const h = history(daily(2000));
  for (const r of RANGES) {
    const s = windowOf(h, r.key);
    assert.equal(s.range, r.key);
    assert.ok(s.points.length > 0, `${r.key} drew nothing from 2,000 closes`);
  }
});

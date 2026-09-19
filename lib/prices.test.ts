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

const history = (points: Point[], asOf = ASOF, indices: History['indices'] = []): History => ({
  points,
  heldFrom: points[0]?.on ?? null,
  heldTo: points[points.length - 1]?.on ?? null,
  heldCount: points.length,
  asOf,
  indices,
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

// ------------------------------------------------------------------------------------------------
// The benchmark
// ------------------------------------------------------------------------------------------------

/** An index at a completely different order of magnitude, which is the realistic case. */
const idx = (points: Point[], name = 'Nifty Smallcap 250', label = 'Smallcap 250') => [
  { name, label, points },
];

const level = (n: number, from: number, step: number, asOf = ASOF): Point[] => {
  const end = Date.parse(`${asOf}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => ({
    on: new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    close: from + i * step,
  }));
};

test('the benchmark is rebased onto the stock\'s axis, starting where the stock starts', () => {
  // A ₹100 stock and a 17,000 index. Plotted literally the stock is a flat line along the floor.
  const h = history(daily(30), ASOF, idx(level(30, 17000, 10)));
  const s = windowOf(h, 'max', 'Nifty Smallcap 250');
  assert.ok(s.benchmark);
  assert.equal(s.benchmark!.points[0]!.close, s.points[0]!.close, 'both lines open at the same y');
  assert.ok(s.benchmark!.points.every((p) => p.close > 90 && p.close < 200), 'and stay on the axis');
});

test('the rebasing preserves the index\'s shape, not its level', () => {
  // The index rises 10% over the window; the rebased line must rise 10% too.
  const h = history(daily(11), ASOF, idx(level(11, 1000, 10)));
  const s = windowOf(h, 'max', 'Nifty Smallcap 250');
  const b = s.benchmark!.points;
  const moved = (b[b.length - 1]!.close - b[0]!.close) / b[0]!.close;
  assert.ok(Math.abs(moved - 0.1) < 1e-9, `rebased move was ${moved}`);
  assert.ok(Math.abs(s.benchmark!.changePct! - 10) < 1e-9, 'and changePct reports the real move');
});

test('changePct is the index\'s own move, computed before any rebasing', () => {
  // The number the second line exists to produce: a stock down 30% against an index down 28% has
  // done nothing, and only this number says so.
  const h = history(daily(101), ASOF, idx(level(101, 20000, -50)));
  const s = windowOf(h, 'max', 'Nifty Smallcap 250');
  assert.ok(Math.abs(s.benchmark!.changePct! - -25) < 1e-9, `got ${s.benchmark!.changePct}`);
});

test('the benchmark is windowed by the same cutoff as the stock', () => {
  const h = history(daily(90), ASOF, idx(level(90, 17000, 5)));
  const week = windowOf(h, '1w', 'Nifty Smallcap 250');
  assert.equal(week.points.length, 7);
  assert.equal(week.benchmark!.points.length, 7, 'or the two lines describe different periods');
  assert.equal(week.benchmark!.points[0]!.close, week.points[0]!.close);
});

test('floor and ceiling cover both lines, so neither is clipped', () => {
  // An index that outruns the stock: drawn against the stock's own low/high the benchmark would
  // leave the top of the box.
  const h = history(daily(30), ASOF, idx(level(30, 1000, 100)));
  const s = windowOf(h, 'max', 'Nifty Smallcap 250');
  const every = [...s.points, ...s.benchmark!.points].map((p) => p.close);
  assert.equal(s.floor, Math.min(...every));
  assert.equal(s.ceiling, Math.max(...every));
  assert.ok(s.ceiling! > s.high!, 'the benchmark is what sets the ceiling here');
});

test('no benchmark asked for means no benchmark, and the bounds are the stock alone', () => {
  const h = history(daily(30), ASOF, idx(level(30, 17000, 10)));
  const s = windowOf(h, 'max', null);
  assert.equal(s.benchmark, null);
  assert.equal(s.floor, s.low);
  assert.equal(s.ceiling, s.high);
});

test('an index the window holds too little of draws nothing rather than a part-line', () => {
  // The walk has not reached this far back. One point cannot be rebased against itself.
  const h = history(daily(30), ASOF, idx([{ on: ASOF, close: 17000 }]));
  assert.equal(windowOf(h, 'max', 'Nifty Smallcap 250').benchmark, null);
  assert.equal(windowOf(h, '1w', 'Nifty Smallcap 250').benchmark, null);
});

test('an unknown index name is no benchmark, never a crash', () => {
  const h = history(daily(30), ASOF, idx(level(30, 17000, 10)));
  assert.equal(windowOf(h, 'max', 'Nifty Gone').benchmark, null);
});

test('a company with no closes cannot rebase, and says so by returning none', () => {
  // There is no anchor: rebasing needs the stock's opening price to scale onto.
  const h = history([], ASOF, idx(level(30, 17000, 10)));
  assert.equal(windowOf(h, 'max', 'Nifty Smallcap 250').benchmark, null);
});

test('a benchmark that does not cover the window is refused, with the reason', () => {
  // The bug this exists for, as it appeared on 17-Sep-2026: PRAJIND over max ran 2025-08-07 onward
  // and the index walk had reached only 2026-04-07, so the head read −30.7% beside +10.3% — two
  // true numbers over two different periods, presented as a comparison.
  const stock = daily(400);
  const short = level(60, 17000, 10);
  const s = windowOf(history(stock, ASOF, idx(short)), 'max', 'Nifty Smallcap 250');
  assert.equal(s.benchmark, null, 'no line rather than a line over the wrong period');
  assert.match(s.benchmarkShort ?? '', /held only from/);
  assert.ok(s.benchmarkShort!.includes(short[0]!.on), 'and it names the date it does start');
});

test('a narrower range the benchmark DOES cover still draws', () => {
  // The same short index, against a window it covers: the comparison is honest here and must not
  // be refused by a rule aimed at the case above.
  const s = windowOf(history(daily(400), ASOF, idx(level(60, 17000, 10))), '1m', 'Nifty Smallcap 250');
  assert.ok(s.benchmark, s.benchmarkShort ?? 'expected a benchmark');
  assert.equal(s.benchmarkShort, null);
});

test('a weekend or a holiday at the window edge is a late start, not a short history', () => {
  // The two series share a trading calendar, so the index legitimately opens a day or two after the
  // stock. A rule with no slack would refuse every window that began on a Friday.
  const stock = daily(30);
  const s = windowOf(
    history(stock, ASOF, idx(level(27, 17000, 10))),
    'max',
    'Nifty Smallcap 250',
  );
  assert.ok(s.benchmark, s.benchmarkShort ?? 'three days of slack must be tolerated');
});


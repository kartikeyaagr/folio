/**
 * `untilQueueEmpty`'s loop and accumulation, tested against a fake `step` — no database, no
 * embedding model. `drain()` itself (the registerAll/claim/SAVEPOINT machinery `step` stands in
 * for here) is already covered end-to-end by lib/retrieval/index.test.ts against a real corpus of
 * hand-written documents; what is new in this file, and not exercised anywhere else, is the loop
 * `--all` adds on top of it. The one property worth a real test is the termination guarantee
 * argued in index-content.ts's own comment: a batch that indexes nothing must end the run rather
 * than spin, because a permanently-failing row never clears `indexed_at` and would otherwise be
 * reclaimed by every future call to `drain`. A test that actually indexes enough real documents to
 * cross a 50-row batch boundary would need either a real corpus (the thing Task 8 exists to run
 * once, by hand, against the dev database) or a batch-size override that does not otherwise exist
 * in `drain`'s interface — neither is worth adding just to re-prove what this file proves for free.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { untilQueueEmpty } from './index-content.ts';
import type { DrainResult } from '../lib/retrieval/index.ts';

test('accumulates totals across batches and stops at the first empty claim', async () => {
  const batches: DrainResult[] = [
    { registered: 3, indexed: 50, failed: 0 },
    { registered: 0, indexed: 50, failed: 2 },
    { registered: 0, indexed: 12, failed: 0 },
    { registered: 0, indexed: 0, failed: 0 }, // the empty claim that ends a normal backfill
  ];
  let calls = 0;
  const step = async (): Promise<DrainResult> => batches[calls++]!;
  const seenIndexed: number[] = [];

  const totals = await untilQueueEmpty(step, (t) => {
    seenIndexed.push(t.indexed);
  });

  assert.equal(calls, 4, 'must call step exactly once per batch, including the terminating empty one');
  assert.deepEqual(totals, { registered: 3, indexed: 112, failed: 2 });
  // onBatch sees the running total after every batch, so a human watching stdout sees it grow.
  assert.deepEqual(seenIndexed, [50, 100, 112, 112]);
});

test('a batch that indexes nothing ends the run even while failures continue', async () => {
  // Shape of a permanently-broken source: `drain` never sets indexed_at on failure, so the exact
  // same rows would be reclaimed by the exact same `ORDER BY id LIMIT` claim on every call. If the
  // loop kept going whenever failed > 0, this step would be called forever.
  let calls = 0;
  const step = async (): Promise<DrainResult> => {
    calls++;
    return { registered: 0, indexed: 0, failed: 5 };
  };

  const totals = await untilQueueEmpty(step, () => {});

  assert.equal(calls, 1, 'zero indexed must stop the loop on the very first batch');
  assert.deepEqual(totals, { registered: 0, indexed: 0, failed: 5 });
});

test('an already-empty queue makes exactly one call', async () => {
  let calls = 0;
  const step = async (): Promise<DrainResult> => {
    calls++;
    return { registered: 0, indexed: 0, failed: 0 };
  };

  const totals = await untilQueueEmpty(step, () => {});

  assert.equal(calls, 1);
  assert.deepEqual(totals, { registered: 0, indexed: 0, failed: 0 });
});

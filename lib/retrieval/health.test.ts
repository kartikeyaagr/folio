/**
 * indexingLag(): how far behind the indexer is.
 *
 * Every case here turns on a distinction the design leans on: `pending` is the whole queue
 * (`indexed_at IS NULL`), which — per 0040 — still includes a source that already failed once, and
 * `failed` only narrows that same set to the ones currently in trouble. Getting the two conflated
 * would make a source that is retrying and losing every time look like ordinary backlog.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { serviceTxn } from '../db.ts';
import { indexingLag } from './health.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `trisula_health_${process.pid}`;

before(async () => {
  await createTestDatabase(DB);
});

after(async () => {
  await dropTestDatabase(DB);
});

// No RESTART IDENTITY: sources.id keeps climbing across tests, so a row this test truncated away
// can never collide with a later test's id and confuse the oldest-pending join in health.ts against
// a stale audit_log row left over from before the truncate.
beforeEach(async () => {
  await serviceTxn('system:index', (c) => c.query('TRUNCATE sources, chunks CASCADE'));
});

/** The minimal registration a real one (register.ts) does, plus the audit row's own timestamp. */
async function registerPending(refId: string): Promise<{ id: string; insertedAt: string }> {
  return serviceTxn('system:index', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO sources (kind, ref_id, title, content_hash)
       VALUES ('document_version', $1, $1, 'h') RETURNING id`,
      [refId],
    );
    const id = rows[0]!.id;
    const { rows: audit } = await c.query<{ at: Date }>(
      `SELECT at FROM audit_log WHERE table_name = 'sources' AND op = 'INSERT' AND row_id = $1`,
      [id],
    );
    return { id, insertedAt: audit[0]!.at.toISOString() };
  });
}

test('a corpus with nothing pending reports null rather than zero', async () => {
  // Null is "nothing is waiting". Zero minutes would read as "something is waiting, very briefly".
  const lag = await indexingLag();
  assert.equal(lag.pending, 0);
  assert.equal(lag.oldestPendingAt, null);
});

test('indexing lag reports the age of the oldest unindexed source', async () => {
  const first = await registerPending('s1');
  const second = await registerPending('s2');

  const lag = await indexingLag();
  assert.equal(lag.pending, 2);
  assert.equal(lag.oldestPendingAt, first.insertedAt, 'the earlier of the two, not the later');
  assert.notEqual(lag.oldestPendingAt, second.insertedAt);
});

test('a source that failed once still counts as pending, and also as failed', async () => {
  // 0040: "a source that failed still has no index, so it stays in the queue by the same
  // predicate" — the next drain() retries it. failed exists to tell that apart from a backlog
  // that is simply draining slowly.
  const { id } = await registerPending('s_fail');
  await serviceTxn('system:index', (c) =>
    c.query('UPDATE sources SET index_error = $2 WHERE id = $1', [id, 'embedding failed']),
  );

  const lag = await indexingLag();
  assert.equal(lag.pending, 1);
  assert.equal(lag.failed, 1);
});

test('chunks counts the whole corpus, independent of what is still pending', async () => {
  const { id } = await registerPending('s_done');
  await serviceTxn('system:index', async (c) => {
    await c.query(
      `INSERT INTO chunks (source_id, ord, text, char_from, char_to) VALUES ($1, 0, 'text', 0, 4)`,
      [id],
    );
    await c.query('UPDATE sources SET indexed_at = now() WHERE id = $1', [id]);
  });

  const lag = await indexingLag();
  assert.equal(lag.chunks, 1);
  assert.equal(lag.pending, 0, 'indexed_at is set, so this source left the queue');
});

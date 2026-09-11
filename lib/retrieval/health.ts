/**
 * How far behind the indexer is, right now.
 *
 * A retrieval layer whose indexer silently stopped looks identical, from the outside, to one whose
 * answers are merely poor — v2 built `exemplarCoverage()` for exactly this reason, so "the loop
 * isn't helping" could be told apart from "the worker hasn't run since Tuesday". This is that
 * figure for v4, read by `/admin?tab=ops`.
 *
 * Lives here, not in `lib/admin.ts` (which re-exports `indexingLag`), because this is a
 * retrieval-health question, not an administrative one — the boundary the rest of `lib/retrieval/`
 * already draws between what indexes the corpus and what lets someone change a setting.
 */
import { readTxn } from '../db.ts';

export interface IndexingLag {
  pending: number;
  oldestPendingAt: string | null;
  failed: number;
  chunks: number;
}

/**
 * `pending` is `index.ts`'s own queue predicate (`sources.indexed_at IS NULL`) — the same set
 * `drain()` claims from, and it already includes sources that failed once: 0040 is explicit that a
 * failed source "still has no index, so it stays in the queue by the same predicate," and gets
 * retried on the next drain. `failed` narrows that same set to the ones currently carrying a
 * recorded `index_error`, so a backlog that is draining on its own reads differently from one that
 * is retrying the same sources and losing every time.
 *
 * `oldestPendingAt` is null exactly when `pending` is zero — never a zero-length duration, which
 * would read as "something is waiting, very briefly" rather than "nothing is waiting at all" (the
 * house rule against a confident zero, `CLAUDE.md`). `sources` carries no `created_at` of its own
 * (0040) — the timestamp comes off the audit trail every write to `sources` already produces
 * (0001's `attach_audit`), for the row `drain()` would itself claim first: `id` is the table's own
 * insertion order, the same "oldest first" `drain` already sorts by (`ORDER BY id LIMIT $1`).
 *
 * `chunks` is the whole corpus, not scoped to what is pending — it answers "how much is there to
 * search," the other half of "is the index keeping up."
 */
export async function indexingLag(): Promise<IndexingLag> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{
      pending: string;
      failed: string;
      oldest_pending_at: Date | null;
      chunks: string;
    }>(
      `WITH pending AS (
         SELECT id, index_error FROM sources WHERE indexed_at IS NULL
       )
       SELECT
         (SELECT count(*) FROM pending)::text AS pending,
         (SELECT count(*) FROM pending WHERE index_error IS NOT NULL)::text AS failed,
         (SELECT a.at
            FROM pending p
            JOIN audit_log a
              ON a.table_name = 'sources' AND a.op = 'INSERT' AND a.row_id = p.id::text
           ORDER BY p.id ASC
           LIMIT 1) AS oldest_pending_at,
         (SELECT count(*) FROM chunks)::text AS chunks`,
    );
    const r = rows[0]!;
    return {
      pending: Number(r.pending),
      failed: Number(r.failed),
      oldestPendingAt: r.oldest_pending_at ? r.oldest_pending_at.toISOString() : null,
      chunks: Number(r.chunks),
    };
  });
}

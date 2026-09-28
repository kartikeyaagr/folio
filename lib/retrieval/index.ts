/**
 * The indexer: chunk what `register.ts` decided is worth indexing, embed it, write it.
 *
 * Two entry points, two different callers:
 *
 *   indexOne(c, sourceId)   one source, inside whatever transaction the caller is already in.
 *                           Delete-then-write, so a half-indexed source can never exist and a
 *                           re-index always replaces rather than accumulates.
 *   drain(chunkBudget)      the sweep. registerAll() first (which reaps first — see register.ts),
 *                           then claims a batch of unindexed sources with `FOR UPDATE SKIP LOCKED`
 *                           and indexes them one by one, behind its own SAVEPOINT each, UNTIL the
 *                           batch has written `chunkBudget` chunks — not until it runs out of
 *                           claimed sources. See the comment on `drain` for why the bound is chunks
 *                           and not source count.
 *
 * **Why a SAVEPOINT per source.** `drain` runs entirely inside one `serviceTxn`. Without a
 * savepoint, a source that throws partway through — chunking, embedding, or the insert itself —
 * would poison that whole transaction, and the very next statement is the one recording *why the
 * source failed*: that write would fail too, the real error would be replaced by "current
 * transaction is aborted", and the row would sit unindexed with no explanation. Same failure shape
 * `lib/agents/runner.ts` documents for its own handler savepoint, and the same fix.
 *
 * **Why delete-then-write, not insert-then-delete-the-old-ones.** `chunks.source_id` has no
 * natural version number to key on — content_hash lives on `sources`, not per chunk — so the only
 * clean way to guarantee old and new chunks never coexist is to remove the old ones first, inside
 * the same transaction (and, for `drain`, the same savepoint) as writing the new ones. A reader who
 * searches between the delete and the write simply does not see this source for a moment; one who
 * searched before the edit and one who searches after never both get an answer for it at once.
 */
import type { Client } from '../db.ts';
import { serviceTxn } from '../db.ts';
import { chunkCells, chunkText, type Piece } from './chunk.ts';
import { embed, toVector, EMBED_MODEL } from './embed.ts';
import { registerAll, textFor, type Indexable } from './register.ts';

/**
 * Which chunker applies is decided by content, not by kind. Every kind but `document_version` is
 * always prose (news, filings and fundamentals are all rendered to plain text in register.ts;
 * attachments are extracted PDF text). A `document_version` is prose or a workbook depending on
 * what the desk saved — `lib/workspace.ts`: `{"text": …}` for prose, `{"sheets": …}` for a
 * spreadsheet, and `{"cells": …}` for one saved before a document could hold tabs, which
 * `lib/sheet/book.ts` reads as a workbook of one. `textFor` already did the detection (it has to,
 * to decide what `text` itself even means for a sheet — see register.ts's `rawText`) and hands the
 * parsed tabs straight through on `source.sheets`, so this is a lookup, not a second detection:
 * re-sniffing `source.text`'s shape here was the bug (chunk.ts's file header has the full story)
 * and is exactly what this file no longer does.
 */
function piecesFor(source: Indexable): Piece[] {
  return source.sheets ? chunkCells(source.sheets) : chunkText(source.text);
}

/**
 * Index one source: delete its old chunks, chunk its current text, embed the batch in one call,
 * write the new chunks. Runs inside the caller's transaction — `drain` wraps this in a SAVEPOINT;
 * a direct caller (a test, a future "index this one now" action) gets the same all-or-nothing
 * guarantee from whatever transaction it is already in.
 *
 * Returns the number of chunks written. Does not touch `sources.indexed_at` or `index_error` —
 * that bookkeeping belongs to whoever is driving the queue (`drain`, below), because a direct call
 * to `indexOne` is not necessarily servicing the queue at all.
 *
 * Throws if the source no longer resolves to any text (`textFor` returns null) or if embedding
 * fails — both are exactly what a queue-driven caller needs to catch and record.
 */
export async function indexOne(c: Client, sourceId: string): Promise<number> {
  const source = await textFor(c, sourceId);
  if (source === null) {
    // A `sources` row with nothing left to read from is not a quiet success — the row claims to
    // index something, and there is nothing there. Recording why is exactly what the caller's
    // SAVEPOINT/index_error machinery exists for.
    throw new Error(`source ${sourceId} has no text to index (its content may have been removed)`);
  }

  // Delete before write, unconditionally — see the file header. This also means a source whose
  // text is now empty correctly ends up with zero chunks rather than its previous, stale ones.
  await c.query('DELETE FROM chunks WHERE source_id = $1::bigint', [sourceId]);

  const pieces = piecesFor(source);
  if (pieces.length === 0) return 0;

  // One embed() call for the whole source, not one per chunk: a 794,891-character annual report
  // is on the order of 800 pieces, and Task 8's backfill runs this over the entire corpus.
  const vectors = await embed(pieces.map((p) => p.text));

  await c.query(
    `INSERT INTO chunks (source_id, company_id, ord, text, char_from, char_to, occurred_at, embedding, embed_model)
     SELECT $1::bigint, $2::text, x.ord, x.text, x.char_from, x.char_to, $3::timestamptz, x.embedding::vector, $4::text
       FROM unnest($5::int[], $6::text[], $7::int[], $8::int[], $9::text[])
         AS x(ord, text, char_from, char_to, embedding)`,
    [
      sourceId,
      source.companyId,
      source.occurredAt,
      EMBED_MODEL,
      pieces.map((_, i) => i),
      pieces.map((p) => p.text),
      pieces.map((p) => p.charFrom),
      pieces.map((p) => p.charTo),
      vectors.map(toVector),
    ],
  );

  return pieces.length;
}

export interface DrainResult {
  registered: number;
  indexed: number;
  failed: number;
}

/**
 * How much embedding work one `drain` call does, measured in CHUNKS WRITTEN — never in sources
 * claimed. A source count means nothing when a source can be a 177-character filing announcement
 * (one chunk) or a 795,000-character annual report (~900 chunks): a `limit=50` batch could be 50
 * announcements or, following two new companies in one window, ~32 annual reports.
 *
 * Measured 11-Sep-2026, live corpus: 25 annual-report sources inside one `drain` batch took 922s
 * end to end and wrote 12,168 chunks — 36.9s/source, ~75.8ms/chunk. `ops/systemd/folio-job@.service`
 * sets `TimeoutStartSec=30min`; a 50-source batch of that shape is already ~30.7min, past the
 * timeout, and the failure is silent — see the finding this constant fixes for the full chain
 * (systemd kills the transaction, every claimed row including its `index_error` rows rolls back,
 * and the next tick claims the identical rows and dies identically, forever).
 *
 * Sized off the SLOWER of the two measured rates (75.8ms/chunk, vs. Task 8's 27.8 chunks/sec on a
 * smaller-chunk corpus) with a further 2x margin for the deploy target: Task 1 measured cold start
 * only on macOS ARM, and the Linux ARM production host is unverified. Even at half that speed
 * (151.6ms/chunk), 5,000 chunks is ~12.6min — well under a third of the 30-minute timeout, leaving
 * the rest of the window as headroom for whatever the next `drain` finds waiting.
 */
export const CHUNK_BUDGET = 5000;

/**
 * Upper bound on how many `sources` rows one call locks with `FOR UPDATE SKIP LOCKED` — NOT on how
 * many it indexes; that bound is `chunkBudget`, above. Deliberately generous: a batch made entirely
 * of small filings (~1 chunk each) should not stop at an arbitrary source count while the chunk
 * budget still has room to do more in the same transaction.
 */
const CLAIM_CAP = 500;

/**
 * Work the indexing queue: register (which reaps first), claim, index.
 *
 * One transaction for the whole call. `FOR UPDATE SKIP LOCKED` on the claim means two overlapping
 * runs (the ten-minute timer and a manual backfill, Task 8) never index the same source twice; a
 * crash before this transaction commits leaves every claimed row exactly as it was —
 * `indexed_at IS NULL` — for the next run to pick up. Nothing here is a failure on its own: an
 * empty queue returns `{registered: 0, indexed: 0, failed: 0}`, not an error. See
 * `jobs/index-content.ts` for why that is the correct read of a zero.
 *
 * The claimed rows are indexed IN ORDER until `chunkBudget` chunks have been written, then the
 * loop stops — the rows still claimed-but-untouched simply stay `indexed_at IS NULL` and are
 * released back (the lock is scoped to this transaction) for the next call to pick up, exactly as
 * `jobs/index-content.ts`'s own "stops on no forward progress" loop already expects. The first
 * claimed row is ALWAYS indexed regardless of the budget — a `chunkBudget` smaller than a single
 * oversized source must not round down to "index nothing", or `jobs/index-content.ts --all`'s
 * `untilQueueEmpty` would read that as an empty queue and stop while sources still wait.
 */
export async function drain(chunkBudget = CHUNK_BUDGET, claimCap = CLAIM_CAP): Promise<DrainResult> {
  return serviceTxn('system:index', async (c) => {
    const registered = await registerAll(c);

    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM sources WHERE indexed_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [claimCap],
    );

    let indexed = 0;
    let failed = 0;
    let chunksWritten = 0;
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && chunksWritten >= chunkBudget) break;
      const row = rows[i]!;

      // A savepoint per source — see the file header. One bad source records why it failed
      // without taking the rest of the batch, or registerAll's work above, down with it.
      await c.query('SAVEPOINT index_source');
      try {
        chunksWritten += await indexOne(c, row.id);
        await c.query('RELEASE SAVEPOINT index_source');
        await c.query('UPDATE sources SET indexed_at = now(), index_error = NULL WHERE id = $1::bigint', [
          row.id,
        ]);
        indexed++;
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT index_source');
        await c.query('UPDATE sources SET index_error = $2 WHERE id = $1::bigint', [
          row.id,
          String(err instanceof Error ? err.message : err).slice(0, 2000),
        ]);
        failed++;
      }
    }

    return { registered, indexed, failed };
  });
}

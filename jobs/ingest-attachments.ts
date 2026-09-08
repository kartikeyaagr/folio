/**
 * Fetch what the filings point at, and read it.
 *
 * Every filing held carries an `attachment_url` and, until 08-Sep-2026, none carried an
 * `attachment_sha256`. The documents the fund asked for — concall transcripts and quarterly
 * investor presentations — are filed as announcements, so they were already named in `filings` and
 * simply never fetched.
 *
 *   pnpm exec tsx jobs/ingest-attachments.ts              # a batch of 200
 *   pnpm exec tsx jobs/ingest-attachments.ts --limit 20   # a smaller bite
 *
 * Both halves ask "what has not been done yet" rather than "what is new", so the job is safe to
 * re-run, resumes after a crash, and cannot lose a filing to a window. Run it repeatedly to work
 * through a backlog; there is no state to reset between runs.
 *
 * `ATTACHMENT_DIR` decides where the bytes go, defaulting to the `/var/lib/trisula/attachments`
 * that `ops/SETUP.md` §5 creates.
 */
import { closePool, serviceTxn } from '../lib/db.ts';
import { attachmentDir, fetchAttachments } from '../lib/ingest/attachments.ts';
import { extractPending } from '../lib/ingest/extract.ts';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const limit = Number(arg('--limit') ?? 200);
  if (!Number.isFinite(limit) || limit < 1) throw new Error('--limit must be a positive number');

  const runId = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('nse_attachments') RETURNING id",
    );
    return rows[0]!.id;
  });

  const finish = (status: 'ok' | 'failed', items: number, detail: string) =>
    serviceTxn('system:ingest', async (c) => {
      await c.query(
        'UPDATE ingestion_runs SET finished_at = now(), status = $1, items = $2, detail = $3 WHERE id = $4',
        [status, items, detail.slice(0, 500), runId],
      );
    });

  try {
    console.log(`storing under ${attachmentDir()}`);
    const got = await fetchAttachments(limit);
    console.log(
      `fetch    ${got.pending} pending  ${got.fetched} new  ${got.skipped} already held  ` +
        `${got.failed} failed  ${(got.bytes / 1e6).toFixed(1)} MB`,
    );

    // Every download in a batch failing is a dead archive, not a quiet day. Nothing pending is
    // genuinely nothing to do — the queue is drained — and is the one empty result that is not a
    // failure here.
    if (got.pending > 0 && got.fetched === 0 && got.skipped === 0) {
      throw new Error(`all ${got.pending} attachments failed to download`);
    }

    const read = await extractPending(limit);
    console.log(
      `extract  ${read.pending} pending  ${read.extracted} read  ${read.documents} transcripts  ` +
        `${read.scanned} scans with no text layer  ${read.failed} failed`,
    );

    await finish(
      'ok',
      got.fetched,
      `${got.fetched} fetched, ${got.skipped} already held, ${got.failed} failed; ` +
        `${read.extracted} read, ${read.documents} transcripts, ${read.scanned} scans`,
    );

    if (read.documents > 0) {
      console.log(`\n${read.documents} transcript(s) are now readable by agent 2.`);
    }
  } catch (err) {
    await finish('failed', 0, String(err instanceof Error ? err.message : err));
    throw err;
  }
}

main()
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());

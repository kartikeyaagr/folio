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
import { attachmentDir, fetchAttachments } from '../lib/ingest/attachments.ts';
import { extractPending } from '../lib/ingest/extract.ts';
import { readFlags } from './_args.ts';
import { runJob } from './_run.ts';


const flags = readFlags(['limit']);
const limit = Number(flags.str('limit') ?? 200);
if (!Number.isFinite(limit) || limit < 1) throw new Error('--limit must be a positive number');

await runJob('nse_attachments', async () => {
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

  if (read.documents > 0) {
    console.log(`\n${read.documents} transcript(s) are now readable by agent 2.`);
  }

  return {
    items: got.fetched,
    detail:
      `${got.fetched} fetched, ${got.skipped} already held, ${got.failed} failed; ` +
      `${read.extracted} read, ${read.documents} transcripts, ${read.scanned} scans`,
  };
});

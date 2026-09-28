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
 * `ATTACHMENT_DIR` decides where the bytes go, defaulting to the `/var/lib/folio/attachments`
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
      `${got.gone} gone  ${got.failed} failed  ${(got.bytes / 1e6).toFixed(1)} MB`,
  );

  const read = await extractPending(limit);
  console.log(
    `extract  ${read.pending} pending  ${read.extracted} read  ${read.documents} transcripts  ` +
      `${read.scanned} scans with no text layer  ${read.missing} missing  ${read.failed} failed`,
  );

  if (read.documents > 0) {
    console.log(`\n${read.documents} transcript(s) are now readable by agent 2.`);
  }

  // Branched on the counts, not on whether anything threw — `ingest-shareholding.ts` says the same
  // thing beside the same shape, and L34 is the lesson both come from.
  //
  // The only guard here used to be all-or-nothing: `fetched === 0 && skipped === 0`. So 200 of 200
  // failing was caught and **199 of 200 was a green run** that wrote `ingestion_runs` status `ok`.
  // An unwritable ATTACHMENT_DIR that let one file through, or a rate limit starting midway
  // through a batch, read as a good afternoon.
  //
  // `gone` and `missing` are deliberately not counted here, and that distinction is the whole
  // reason both exist (L35): a 4xx is the archive's answer about that document and will be the
  // same tomorrow, and a row whose bytes are not on disk has no text to extract however often it
  // is retried. Only `failed` — this run could not do it — holds the run open. Both are printed,
  // because a permanent silence still has to be visible to somebody reading the log.
  const broke: string[] = [];
  if (got.failed > 0) broke.push(`${got.failed} of ${got.pending} attachments could not be fetched`);
  if (read.failed > 0) broke.push(`${read.failed} of ${read.pending} could not be read`);
  if (broke.length > 0) throw new Error(broke.join('; '));

  return {
    items: got.fetched,
    detail:
      `${got.fetched} fetched, ${got.skipped} already held, ${got.gone} gone, ${got.failed} failed; ` +
      `${read.extracted} read, ${read.documents} transcripts, ${read.scanned} scans, ` +
      `${read.missing} missing`,
  };
});

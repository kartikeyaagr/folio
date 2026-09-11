/**
 * Turning a stored PDF into text, and a transcript into something agent 2 can read.
 *
 * The last piece of P3. Agent 2 (`concall-insights`) fires on a `documents` row of kind
 * `transcript` and has **never had one**: the only production `INSERT INTO documents` was inside
 * `acceptDraft`, so a transcript could arrive only by accepting a draft from the one agent that
 * needs a transcript to write one. Migration `0033` repointed `documents.created_by` at `actors`
 * so a job can write one at all.
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { extractText, getDocumentProxy } from 'unpdf';

import { serviceTxn, type Client } from '../db.ts';
import { pathFor } from './attachments.ts';

/**
 * Agent 2's own floor, from `lib/agents/concall.ts`. Repeated here rather than imported because
 * this decides what becomes a document and that decides what to run on one — the same number for
 * two different reasons, and a shared constant would hide that they can diverge.
 */
const TRANSCRIPT_MIN_CHARS = 4_000;

export class NoTextInPdf extends Error {}

/**
 * The text of one stored PDF.
 *
 * **A PDF that yields no text is a failure, not an empty document.** Scanned filings are common on
 * the SME board — a secretary prints, signs, scans and uploads — and a scan parses to the empty
 * string with no error at all. Recording that as "extracted, nothing in it" would put a document
 * in the record that says the company disclosed nothing, which is the dangerous direction. It is
 * raised so the row keeps a null `extracted_text` and is visibly unread rather than invisibly
 * empty.
 */
export async function pdfText(sha256: string): Promise<string> {
  const bytes = await readFile(pathFor(sha256));
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  const merged = (Array.isArray(text) ? text.join('\n') : text).trim();
  if (merged.length === 0) {
    throw new NoTextInPdf('no text layer; the filing is probably a scan and needs OCR');
  }
  return merged;
}

export interface ExtractResult {
  pending: number;
  extracted: number;
  documents: number;
  scanned: number;
  failed: number;
}

export interface Row {
  sha256: string;
  company_id: string | null;
  filename: string;
  kind: string;
  // The date of the CALL, not the date it happens to be extracted — see promoteTranscript below.
  // Null for an attachment with no linking filing (an imported PDF, or one dragged into the import
  // dialog), which is the one case with no true date to carry.
  announced_at: string | null;
}

/**
 * A transcript becomes a document, stamped with the date of the CALL.
 *
 * The version insert used to take no `written_at`, so it fell through to the column's `now()`
 * default — the date the job happened to run, not the date of the call. Every transcript in the
 * corpus carried this: 18 rows, 1 distinct date. `row.announced_at` — the linking filing's date —
 * is the fix: checked against the filename-embedded date on every row of the live corpus, all
 * matched exactly (`PRAJIND_21102022153139_...` to `2022-10-21`, and so on).
 *
 * `COALESCE(..., now())` rather than requiring a filing: an imported PDF or one dragged into the
 * import dialog has no filings row and so no true date to carry, and falling back to "when we
 * received it" is an honest, defensible answer. Silently writing the wrong date — which is what
 * the bug this replaces did — is not.
 */
export async function promoteTranscript(c: Client, row: Row, text: string): Promise<boolean> {
  const id = randomBytes(16).toString('hex');
  await c.query(
    `INSERT INTO documents (id, company_id, title, kind, created_by, from_attachment)
     VALUES ($1, $2, $3, 'transcript', 'system:ingest', $4)`,
    [id, row.company_id, row.filename, row.sha256],
  );
  await c.query(
    `INSERT INTO document_versions (document_id, body, written_by, written_at)
     VALUES ($1, $2, 'system:ingest', COALESCE($3::timestamptz, now()))`,
    [id, JSON.stringify({ text }), row.announced_at],
  );
  return true;
}

/**
 * What has no text yet, and the date each will carry if it turns out to be a transcript.
 *
 * The linking filing, not just the attachment: an attachment carries only when it was fetched,
 * never what it is ABOUT. `filings.attachment_sha256` is not unique — the same content-addressed
 * PDF can back more than one announcement, the exact fan-out register.ts's ATTACHMENTS_SELECT
 * already had to handle — so the inner query picks one deterministically (most recently announced)
 * before the outer query re-applies the caller's own added_at ordering and limit. LEFT JOIN is
 * load-bearing: an imported PDF or an annual report from /api/annual-reports has no filings row at
 * all, and it must still be extracted rather than silently skipped.
 *
 * Exported so the date resolution can be tested without a real PDF on disk — see extract.test.ts.
 */
export async function pendingAttachments(c: Client, limit: number): Promise<Row[]> {
  const { rows } = await c.query<Row>(
    `SELECT sha256, company_id, filename, kind, announced_at
       FROM (
         SELECT DISTINCT ON (a.sha256)
                a.sha256, a.company_id, a.filename, a.kind, a.added_at, f.announced_at
           FROM attachments a
           LEFT JOIN filings f ON f.attachment_sha256 = a.sha256
          WHERE a.extracted_text IS NULL
            AND a.media_type LIKE '%pdf%'
          ORDER BY a.sha256, f.announced_at DESC NULLS LAST
       ) x
      ORDER BY added_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

/**
 * Extract text from every stored PDF that has none yet, and promote the transcripts.
 *
 * `NOT EXISTS`-shaped again — "which attachment has no text" — so it resumes after a crash and
 * cannot lose one to a window.
 */
export async function extractPending(limit = 100): Promise<ExtractResult> {
  const pending = await serviceTxn('system:ingest', (c) => pendingAttachments(c, limit));

  let extracted = 0;
  let documents = 0;
  let scanned = 0;
  let failed = 0;

  for (const row of pending) {
    let text: string;
    try {
      text = await pdfText(row.sha256);
    } catch (err) {
      // A scan is a known, expected outcome and is counted apart from a real fault: one is the SME
      // board being the SME board, the other is something to look at.
      if (err instanceof NoTextInPdf) scanned++;
      else failed++;
      console.error(`${row.filename}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const made = await serviceTxn('system:ingest', async (c) => {
      await c.query('UPDATE attachments SET extracted_text = $2 WHERE sha256 = $1', [
        row.sha256,
        text,
      ]);

      // Only transcripts become documents, and only when there is enough of one to be worth a
      // model. A two-page "we will hold a call on Tuesday" is filed under the same category as the
      // transcript of the call itself.
      if (row.kind !== 'transcript' || !row.company_id || text.length < TRANSCRIPT_MIN_CHARS) {
        return false;
      }

      // Keyed on the attachment, so re-running makes no second document for the same bytes.
      const { rows: seen } = await c.query('SELECT 1 FROM documents WHERE from_attachment = $1', [
        row.sha256,
      ]);
      if (seen.length > 0) return false;

      return promoteTranscript(c, row, text);
    });

    extracted++;
    if (made) documents++;
  }

  return { pending: pending.length, extracted, documents, scanned, failed };
}

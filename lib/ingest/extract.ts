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

import { serviceTxn } from '../db.ts';
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

interface Row {
  sha256: string;
  company_id: string | null;
  filename: string;
  kind: string;
}

/**
 * Extract text from every stored PDF that has none yet, and promote the transcripts.
 *
 * `NOT EXISTS`-shaped again — "which attachment has no text" — so it resumes after a crash and
 * cannot lose one to a window.
 */
export async function extractPending(limit = 100): Promise<ExtractResult> {
  const pending = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<Row>(
      `SELECT sha256, company_id, filename, kind
         FROM attachments
        WHERE extracted_text IS NULL
          AND media_type LIKE '%pdf%'
        ORDER BY added_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows;
  });

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

      const id = randomBytes(16).toString('hex');
      await c.query(
        `INSERT INTO documents (id, company_id, title, kind, created_by, from_attachment)
         VALUES ($1, $2, $3, 'transcript', 'system:ingest', $4)`,
        [id, row.company_id, row.filename, row.sha256],
      );
      await c.query(
        `INSERT INTO document_versions (document_id, body, written_by)
         VALUES ($1, $2, 'system:ingest')`,
        [id, JSON.stringify({ text })],
      );
      return true;
    });

    extracted++;
    if (made) documents++;
  }

  return { pending: pending.length, extracted, documents, scanned, failed };
}

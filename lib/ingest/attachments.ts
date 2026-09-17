/**
 * Downloading what a filing points at, and deciding what it is.
 *
 * Every one of the 11,975 filings held carries an `attachment_url` and none carried an
 * `attachment_sha256`: the column was designed for this and nothing ever filled it. The documents
 * the fund actually wants — concall transcripts and quarterly investor presentations — are filed
 * *as* announcements, so they are already named in `filings` and were simply never fetched.
 *
 * Content-addressed on purpose. A company re-filing a corrected presentation under a new
 * announcement is the same bytes or different bytes, and the sha decides; two filings that point
 * at one document share one row and one file rather than two copies that can drift.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { serviceTxn } from '../db.ts';

/** Where the bytes go. `ops/SETUP.md` §5 creates this; the default matches. */
export const attachmentDir = (): string =>
  process.env['ATTACHMENT_DIR'] ?? '/var/lib/trisula/attachments';

/**
 * Fanned out by the first two hex characters. One flat directory of tens of thousands of files is
 * slow to list and unpleasant to back up; 256 subdirectories is enough at this scale and needs no
 * rebalancing later.
 */
export const pathFor = (sha256: string): string =>
  join(attachmentDir(), sha256.slice(0, 2), sha256);

/** 64 MB. The largest thing seen in the corpus is an annual report; a 500-page PDF is single-digit
 *  MB. A cap exists because the far end is untrusted and a stream with no ceiling is a disk. */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * NSE has answered slowly rather than not at all, and a hung socket on a `Type=oneshot` unit holds
 * it in "activating" forever without ever failing.
 *
 * A bare `fetch` rather than `NseSession.bytes()` for exactly this: the session has no timeout and
 * no size cap, and the archive host needs only a browser-shaped User-Agent, not the cookie dance
 * the JSON endpoints require. `lib/news/poll.ts` uses the same shape.
 */
const TIMEOUT_MS = 60_000;

export type AttachmentKind =
  | 'transcript'
  | 'presentation'
  | 'annual_report'
  | 'filing'
  | 'excel'
  | 'other';

/**
 * What kind of document a filing points at, from what the exchange said about it.
 *
 * Measured on the 929 filings held for the two followed names, 08-Sep-2026. NSE has a **dedicated
 * category** — `Transcript of Analysts/Institutional Investor Meet/Con. Call` — which is an exact
 * signal wherever it appears, but it appeared on 1 of PRAJIND's 845 filings against 115 under the
 * generic `Analysts/Institutional Investor Meet/Con. Call Updates`. So the category is sufficient
 * when it is specific and useless when it is not, and the filename is what separates the rest.
 *
 * Deliberately conservative: anything not clearly one thing is `filing`, not a guess. A
 * presentation mislabelled a transcript would hand agent 2 a slide deck and ask it to diff
 * guidance against the last call, and it would produce something fluent and wrong.
 */
export function classify(category: string | null, url: string): AttachmentKind {
  const cat = (category ?? '').toLowerCase();
  const file = decodeURIComponent(url.split('/').pop() ?? '').toLowerCase();

  if (/\.(xlsx?|csv)$/.test(file)) return 'excel';
  if (/\.zip$/.test(file)) return 'other';

  // The exchange's own dedicated category. Exact where it is used.
  if (cat.startsWith('transcript of')) return 'transcript';

  // Filenames are written by the company and are the only signal that separates a transcript from
  // a presentation inside the shared "Con. Call Updates" category.
  if (/transcript/.test(file)) return 'transcript';
  if (/(investor|earnings|analyst).*(present|deck|ppt)|present.*(investor|earnings)|_ppt|\bppt\b/.test(file)) {
    return 'presentation';
  }
  if (/annual[\s_-]*report|\bar[-_]?20\d\d/.test(file)) return 'annual_report';

  if (cat.includes('annual report')) return 'annual_report';
  return 'filing';
}

export interface FetchResult {
  pending: number;
  fetched: number;
  skipped: number;
  failed: number;
  bytes: number;
}

interface Row {
  id: string;
  company_id: string;
  category: string | null;
  attachment_url: string;
}

/**
 * Fetch what has not been fetched.
 *
 * Asks "which filing has no sha yet" rather than "what arrived since I last looked", so it is
 * idempotent, resumable after a crash halfway through, and cannot lose a filing to a window.
 * Restricted to followed companies: the corpus holds announcements for 2,539 symbols the fund does
 * not follow, and downloading those would be tens of gigabytes of other people's paperwork.
 *
 * **`companyId` narrows it to one name**, which is what the on-add backfill needs and what it did
 * not have. Unscoped, this orders by `announced_at DESC` across every followed company, so a name
 * whose history has just been attached — sixteen years of it, all of it older than everything
 * already held — sorts to the *bottom* of its own backfill. Measured 17-Sep-2026: adding TEGA put
 * 480 unfetched attachments on the queue behind an existing backlog of 268, against one capped
 * pass of 500. Nothing would have collected the remainder, because `jobs/ingest-attachments.ts`
 * has no timer.
 */
export async function fetchAttachments(limit = 200, companyId?: string | null): Promise<FetchResult> {
  const pending = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<Row>(
      `SELECT f.id, f.company_id, f.category, f.attachment_url
         FROM filings f
        WHERE f.company_id IS NOT NULL
          AND ($2::text IS NULL OR f.company_id = $2)
          AND f.attachment_url IS NOT NULL
          AND f.attachment_sha256 IS NULL
          -- NSE writes a bare "-" where a filing has no attachment. It arrives here either as the
          -- hyphen itself, which fetch rejects outright with "Failed to parse URL", or as a URL
          -- ending in a slash-hyphen, which 404s. Both are excluded by requiring an actual URL,
          -- rather than by naming the two shapes the placeholder has been seen to take. Nothing
          -- sets a sha on a failure, so without this the same dead value is retried every run.
          AND f.attachment_url LIKE 'http%'
        ORDER BY f.announced_at DESC
        LIMIT $1`,
      [limit, companyId ?? null],
    );
    return rows;
  });

  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  let bytes = 0;

  for (const row of pending) {
    try {
      const res = await fetch(row.attachment_url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`${res.status} from the archive`);

      // Checked before reading the body where the server declares it, and again after: a length
      // header is a claim, and the bytes are the fact.
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > MAX_BYTES) throw new Error(`declared ${declared} bytes, over the cap`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error(`${buf.length} bytes, over the cap`);
      if (buf.length === 0) throw new Error('the archive returned an empty body');

      const sha256 = createHash('sha256').update(buf).digest('hex');
      const file = pathFor(sha256);
      await mkdir(dirname(file), { recursive: true });
      // Written before the row exists. A file with no row is an orphan the next sweep overwrites
      // with identical bytes; a row with no file is a promise the reader cannot collect.
      await writeFile(file, buf);

      const filename = decodeURIComponent(row.attachment_url.split('/').pop() ?? sha256);
      const kind = classify(row.category, row.attachment_url);
      const mediaType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';

      const isNew = await serviceTxn('system:ingest', async (c) => {
        const { rowCount } = await c.query(
          `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, source_note, added_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'system:ingest')
           ON CONFLICT (sha256) DO NOTHING`,
          [sha256, row.company_id, filename, mediaType, buf.length, kind, `filing ${row.id}`],
        );
        await c.query('UPDATE filings SET attachment_sha256 = $2 WHERE id = $1', [row.id, sha256]);
        return (rowCount ?? 0) > 0;
      });

      if (isNew) {
        fetched++;
        bytes += buf.length;
      } else {
        // Two filings pointing at one document. The filing is still linked to it; the bytes are
        // already on disk and are the same bytes, because the sha is what said so.
        skipped++;
      }
    } catch (err) {
      failed++;
      // Recorded per filing rather than aborting the sweep: one company's broken link should not
      // stop the other 199. The count is returned and the job decides what it means.
      console.error(`${row.attachment_url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { pending: pending.length, fetched, skipped, failed, bytes };
}

/**
 * Documents and spreadsheets — the desk's own writing.
 *
 * A3 asks for free-form notes against a company with no required sequence and no gates, and this is
 * it. `documents` and `document_versions` have existed since 0011 with nothing able to create one,
 * so the fund kept its notes in Google Docs and its models in Excel — the two things
 * `docs/specs/v2-system-map.md` says in its first paragraph that this system replaces.
 *
 * **A spreadsheet is a document whose body is a grid.** Same table, same versioning, same
 * attribution, same archive. Every save is a new `document_versions` row, so a model's history is
 * kept for the same reason a memo's is: a number in an investment case is worth little without
 * being able to see what it was last quarter and who changed it.
 *
 * **Archived, not deleted.** `archived_at` is the delete, and the rows stay. A note somebody wrote
 * about a company they then passed on is exactly the note worth finding two years later, and A8's
 * graveyard rests on the same argument.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { readTxn, rowId, type Client, writeTxn } from './db.ts';
import { pathFor } from './ingest/attachments.ts';

export type DocKind = 'note' | 'memo' | 'meeting' | 'checklist' | 'sheet';

/** What a person can make. The others — transcript, brief — are written by ingest and agents. */
export const AUTHORED: DocKind[] = ['note', 'memo', 'meeting', 'checklist', 'sheet'];

/**
 * Kinds this system produced rather than a person, which are therefore **read-only**.
 *
 * A transcript is a record of what a company actually said on a call, extracted from the PDF it
 * filed. Opening it in an editor with a Save button invites somebody to fix a typo in it — and the
 * result is a document that reads like the exchange's and is not, with a version history saying a
 * colleague wrote it. The desk's own writing is editable; the record is not.
 */
export const INGESTED = new Set(['transcript', 'brief']);

export const isEditable = (kind: string): boolean => !INGESTED.has(kind);

export const KIND_LABEL: Record<string, string> = {
  note: 'Note',
  memo: 'Memo',
  meeting: 'Meeting',
  checklist: 'Checklist',
  sheet: 'Spreadsheet',
  transcript: 'Transcript',
  brief: 'Brief',
};

export class NoSuchDocument extends Error {}
export class TitleRequired extends Error {}

export interface DocSummary {
  id: string;
  title: string;
  kind: string;
  companyId: string | null;
  symbol: string | null;
  updatedAt: Date;
  archivedAt: Date | null;
  updatedByName: string | null;
  versions: number;
}

export interface DocDetail extends DocSummary {
  /** `{text}` for prose, `{cells}` for a sheet. Whatever the last save wrote. */
  body: Record<string, unknown>;
  createdByName: string | null;
}

/**
 * Where an ingested document came from.
 *
 * The point of showing this is that a reader can get back to the thing itself. An extracted
 * transcript is this system's reading of a PDF the company filed, and a reading is worth having
 * only while you can check it against the original — so the filing, the date it was announced, and
 * the file itself are all named.
 */
export interface Provenance {
  sha256: string;
  filename: string;
  mediaType: string;
  bytes: number;
  /** The announcement it was attached to, where one still links to it. */
  filingSubject: string | null;
  filingCategory: string | null;
  announcedAt: Date | null;
}

export async function provenanceOf(documentId: string): Promise<Provenance | null> {
  return readTxn(async (c) => {
    const { rows } = await c.query<Provenance>(
      `SELECT a.sha256, a.filename, a.media_type AS "mediaType", a.bytes,
              f.summary AS "filingSubject", f.category AS "filingCategory",
              f.announced_at AS "announcedAt"
         FROM documents d
         JOIN attachments a ON a.sha256 = d.from_attachment
         LEFT JOIN LATERAL (
           SELECT summary, category, announced_at FROM filings
            WHERE attachment_sha256 = a.sha256 ORDER BY announced_at DESC LIMIT 1
         ) f ON true
        WHERE d.id = $1`,
      [documentId],
    );
    return rows[0] ?? null;
  });
}

/**
 * Keep an uploaded file's bytes, content-addressed — the same store `fetchAttachments` and
 * `storeAnnualReport` (`lib/ingest/attachments.ts`, `lib/ingest/annual-reports.ts`) write into, so
 * a file dragged into this desk's own import dialog is indistinguishable on disk from one this
 * system fetched itself. `ON CONFLICT (sha256) DO NOTHING` matches both: the same PDF imported
 * twice is one row, not two, which is the whole reason identity is the content and not a filename.
 *
 * The import path used to parse a file into a document — a note's extracted text, a sheet's cells
 * — and throw the bytes away, so no human upload was ever downloadable
 * (`app/api/attachment/[sha]/route.ts`) or reachable by Task 6's own registration
 * (`lib/retrieval/register.ts`), which walks `attachments` through a `LEFT JOIN filings` precisely
 * so a file with no exchange filing behind it still reaches the index. Returns the sha256 so the
 * caller can look the row back up.
 */
export async function keepUploadAsAttachment(
  c: Client,
  input: { companyId: string | null; kind: string; filename: string; bytes: Buffer; actorId: string },
): Promise<string> {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const file = pathFor(sha256);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, input.bytes);

  // Sniffed, not trusted from the extension — `lib/import/index.ts` decides a workbook by its
  // bytes rather than its name for the same reason: a renamed file should not lie. This is also
  // what `pendingAttachments` (lib/ingest/extract.ts, `media_type LIKE '%pdf%'`) keys on to pick
  // the file up for text extraction at all — get it wrong and the row sits stored, but never
  // becomes searchable.
  const mediaType =
    input.bytes.subarray(0, 5).toString('latin1') === '%PDF-' ? 'application/pdf' : 'application/octet-stream';

  await c.query(
    `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, source_note, added_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'uploaded through the import dialog', $7)
     ON CONFLICT (sha256) DO NOTHING`,
    [sha256, input.companyId, input.filename, mediaType, input.bytes.length, input.kind, input.actorId],
  );
  return sha256;
}

const SELECT = `
  SELECT d.id, d.title, d.kind, d.company_id AS "companyId", co.symbol,
         d.updated_at AS "updatedAt", d.archived_at AS "archivedAt",
         (SELECT a.label FROM document_versions v JOIN actors a ON a.id = v.written_by
           WHERE v.document_id = d.id ORDER BY v.written_at DESC LIMIT 1) AS "updatedByName",
         (SELECT count(*)::int FROM document_versions v WHERE v.document_id = d.id) AS versions
    FROM documents d
    LEFT JOIN companies co ON co.id = d.company_id`;

/** Everything written against one company, newest first. Archived ones only when asked for. */
export async function documentsFor(
  companyId: string,
  opts: { archived?: boolean } = {},
): Promise<DocSummary[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<DocSummary>(
      `${SELECT} WHERE d.company_id = $1
         AND (d.archived_at IS NULL OR $2)
       ORDER BY d.archived_at IS NOT NULL, d.updated_at DESC`,
      [companyId, opts.archived ?? false],
    );
    return rows;
  });
}

/**
 * Everything written or ingested, across every company.
 *
 * The index exists because a document is not always about one company. Agent 4's news brief covers
 * the whole book, so `company_id` is null on it and no company page could ever list it — it was
 * written, stored, versioned, and reachable from nowhere. Anything that can be created has to be
 * findable, or it may as well not have been kept.
 */
export async function allDocuments(opts: { archived?: boolean } = {}): Promise<DocSummary[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<DocSummary>(
      `${SELECT} WHERE d.archived_at IS NULL OR $1
       ORDER BY d.archived_at IS NOT NULL, d.updated_at DESC
       LIMIT 500`,
      [opts.archived ?? false],
    );
    return rows;
  });
}

export async function getDocument(id: string): Promise<DocDetail | null> {
  return readTxn(async (c) => {
    const { rows } = await c.query<DocDetail>(
      `SELECT d.id, d.title, d.kind, d.company_id AS "companyId", co.symbol,
              d.updated_at AS "updatedAt", d.archived_at AS "archivedAt",
              (SELECT a.label FROM document_versions v JOIN actors a ON a.id = v.written_by
                WHERE v.document_id = d.id ORDER BY v.written_at DESC LIMIT 1) AS "updatedByName",
              (SELECT count(*)::int FROM document_versions v WHERE v.document_id = d.id) AS versions,
              (SELECT a.label FROM actors a WHERE a.id = d.created_by) AS "createdByName",
              COALESCE(
                (SELECT v.body FROM document_versions v
                  WHERE v.document_id = d.id ORDER BY v.written_at DESC LIMIT 1),
                '{}'::jsonb
              ) AS body
         FROM documents d
         LEFT JOIN companies co ON co.id = d.company_id
        WHERE d.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  });
}

/**
 * A new document, with its first version.
 *
 * The empty first version exists so that "created" and "has a body" are never two different states
 * — every reader can take the latest version without a special case for a document nobody has
 * typed into yet.
 */
export async function createDocument(
  input: { title: string; kind: DocKind; companyId: string | null },
  actorId: string,
): Promise<string> {
  const title = input.title.trim();
  if (!title) throw new TitleRequired('A document needs a title.');
  const id = rowId();
  const body = input.kind === 'sheet' ? { cells: {} } : { text: '' };

  await writeTxn(actorId, async (c) => {
    await c.query(
      'INSERT INTO documents (id, company_id, title, kind, created_by) VALUES ($1,$2,$3,$4,$5)',
      [id, input.companyId, title, input.kind, actorId],
    );
    await c.query(
      'INSERT INTO document_versions (document_id, body, written_by) VALUES ($1,$2,$3)',
      [id, JSON.stringify(body), actorId],
    );
  });
  return id;
}

/**
 * Save a new version.
 *
 * Always a new row, never an update. The version history is the point: a model that changed its
 * mind about a growth rate should be able to say when, and who.
 */
export async function saveDocument(
  id: string,
  body: Record<string, unknown>,
  actorId: string,
): Promise<void> {
  await writeTxn(actorId, async (c) => {
    const { rowCount } = await c.query('SELECT 1 FROM documents WHERE id = $1', [id]);
    if (!rowCount) throw new NoSuchDocument('That document no longer exists.');
    await c.query(
      'INSERT INTO document_versions (document_id, body, written_by) VALUES ($1,$2,$3)',
      [id, JSON.stringify(body), actorId],
    );
    await c.query('UPDATE documents SET updated_at = now() WHERE id = $1', [id]);
  });
}

export async function renameDocument(id: string, title: string, actorId: string): Promise<void> {
  const clean = title.trim();
  if (!clean) throw new TitleRequired('A document needs a title.');
  await writeTxn(actorId, async (c) => {
    const { rowCount } = await c.query(
      'UPDATE documents SET title = $2, updated_at = now() WHERE id = $1',
      [id, clean],
    );
    if (!rowCount) throw new NoSuchDocument('That document no longer exists.');
  });
}

/** The delete. Reversible on purpose — see the note at the top of this file. */
export async function archiveDocument(id: string, actorId: string, archived = true): Promise<void> {
  await writeTxn(actorId, async (c) => {
    const { rowCount } = await c.query(
      'UPDATE documents SET archived_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1',
      [id, archived],
    );
    if (!rowCount) throw new NoSuchDocument('That document no longer exists.');
  });
}

export interface Revision {
  id: string;
  writtenAt: Date;
  writtenByName: string | null;
}

/** Who saved what, when. Not the bodies — this is the list you pick from. */
export async function revisionsOf(documentId: string, limit = 30): Promise<Revision[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<Revision>(
      `SELECT v.id::text, v.written_at AS "writtenAt", a.label AS "writtenByName"
         FROM document_versions v LEFT JOIN actors a ON a.id = v.written_by
        WHERE v.document_id = $1 ORDER BY v.written_at DESC LIMIT $2`,
      [documentId, limit],
    );
    return rows;
  });
}

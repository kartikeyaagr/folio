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

import { randomBytes } from 'node:crypto';

import { readTxn, writeTxn } from './db.ts';

export type DocKind = 'note' | 'memo' | 'meeting' | 'checklist' | 'sheet';

/** What a person can make. The others — transcript, brief — are written by ingest and agents. */
export const AUTHORED: DocKind[] = ['note', 'memo', 'meeting', 'checklist', 'sheet'];

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
  const id = randomBytes(16).toString('hex');
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

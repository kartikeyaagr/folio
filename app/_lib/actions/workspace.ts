'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { writeTxn } from '@/lib/db.ts';
import {
  readUpload,
  UnreadableDocument,
  UnreadableWorkbook,
  UnsupportedFile,
  type Imported,
} from '@/lib/import/index.ts';
import { lookupsFor } from '@/lib/sheet/data.ts';
import type { Lookups } from '@/lib/sheet/evaluate.ts';
import {
  archiveDocument,
  createDocument,
  keepUploadAsAttachment,
  NoSuchDocument,
  renameDocument,
  saveDocument,
  TitleRequired,
  type DocKind,
} from '@/lib/workspace.ts';

import { flash } from '../flash.ts';
import { requireUser } from '../session.ts';

/**
 * Making, saving and putting away the desk's own writing.
 *
 * Nothing here computes. `lib/workspace.ts` owns the rows and the versioning; these resolve who is
 * asking, check what arrived, and say what happened.
 */

const KINDS: DocKind[] = ['note', 'memo', 'meeting', 'checklist', 'sheet'];

export async function createDocumentAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const title = String(form.get('title') ?? '');
  const kind = String(form.get('kind') ?? 'note');
  const companyId = String(form.get('companyId') ?? '') || null;

  if (!(KINDS as string[]).includes(kind)) return flash('That is not a kind of document.');

  let id: string;
  try {
    id = await createDocument({ title, kind: kind as DocKind, companyId }, user.userId);
  } catch (err) {
    if (err instanceof TitleRequired) return flash(err.message);
    throw err;
  }
  // Straight into it. Creating something and being left on the list is a click nobody wanted.
  redirect(`/doc/${id}`);
}

/**
 * Save a body.
 *
 * Two entry points rather than one, and both take the id — because a server action reaches a client
 * component only as itself. Wrapping one in an arrow to close over the id makes it an event
 * handler, which React refuses to serialise across the boundary: "Event handlers cannot be passed
 * to Client Component props". The editors are handed the action and the id separately.
 *
 * Every save is a new version — `saveDocument` never updates one — which is what makes a model's
 * history readable.
 */
export async function saveTextAction(id: string, text: string): Promise<void> {
  const user = await requireUser();
  try {
    await saveDocument(id, { text }, user.userId);
  } catch (err) {
    if (err instanceof NoSuchDocument) return flash(err.message);
    throw err;
  }
  revalidatePath(`/doc/${id}`);
}

/**
 * Save a grid, and answer with the figures it now asks this box for.
 *
 * The evaluator runs in the browser, but the data functions cannot — they read this system's own
 * tables. So a save is also the moment to re-resolve them: a model that gained a
 * `FIN("PRAJIND","revenue","FY27")` between one save and the next gets its answer without a reload.
 */
export async function saveSheetAction(
  id: string,
  cells: Record<string, string>,
): Promise<Lookups> {
  const user = await requireUser();
  try {
    await saveDocument(id, { cells }, user.userId);
  } catch (err) {
    if (err instanceof NoSuchDocument) {
      await flash(err.message);
      return {};
    }
    throw err;
  }
  revalidatePath(`/doc/${id}`);
  return lookupsFor(cells);
}

export async function renameDocumentAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(form.get('id') ?? '');
  try {
    await renameDocument(id, String(form.get('title') ?? ''), user.userId);
  } catch (err) {
    if (err instanceof TitleRequired || err instanceof NoSuchDocument) return flash(err.message);
    throw err;
  }
  revalidatePath(`/doc/${id}`);
  revalidatePath('/company/[symbol]', 'page');
}

/**
 * The delete, which is an archive.
 *
 * A note about a company the fund then passed on is exactly the note worth finding two years
 * later, so nothing is removed — and the flash says so, because a button labelled Delete that does
 * not delete should admit it rather than be quietly kind.
 */
export async function archiveDocumentAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(form.get('id') ?? '');
  const restore = String(form.get('restore') ?? '') === '1';
  const symbol = String(form.get('symbol') ?? '');

  try {
    await archiveDocument(id, user.userId, !restore);
  } catch (err) {
    if (err instanceof NoSuchDocument) return flash(err.message);
    throw err;
  }
  await flash(
    restore
      ? `Restored, as ${user.email}.`
      : `Archived, as ${user.email}. Nothing is deleted — show archived to find it again.`,
  );
  revalidatePath(`/doc/${id}`);
  revalidatePath('/company/[symbol]', 'page');
  if (!restore && symbol) redirect(`/company/${symbol}`);
}

/**
 * Bringing in a file the desk already has.
 *
 * One upload can become several documents: a workbook with four tabs is four grids, because one
 * grid per document is the model here and importing tab one of four in silence is the kind of loss
 * this system exists to prevent. The flash says how many and what they were.
 *
 * Everything lands as a first version attributed to whoever uploaded it, so an imported model has
 * the same history as one typed here — starting from the moment it arrived.
 */
// 32MB, not 12. A DRHP runs 300-500 pages with embedded images — the two this desk actually needs
// are 7 and 11MB — and the largest annual report in the corpus is 21.4MB. Of 969 real attachments
// only 6 exceed 12MB, so this is not a licence for junk; it is the difference between the import
// path working for the documents it exists to accept and silently refusing them.
const MAX_UPLOAD = 32 * 1024 * 1024;

export async function importFileAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const companyId = String(form.get('companyId') ?? '') || null;
  const symbol = String(form.get('symbol') ?? '');
  const file = form.get('file');

  if (!(file instanceof File) || file.size === 0) return flash('No file was chosen.');
  if (file.size > MAX_UPLOAD) {
    return flash(
      `${file.name} is ${(file.size / 1e6).toFixed(1)} MB; the limit is ${(MAX_UPLOAD / 1e6).toFixed(0)} MB.`,
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  let read: Imported;
  try {
    read = await readUpload(file.name, bytes);
  } catch (err) {
    // Said in place. Every one of these carries a sentence naming what was wrong with the file.
    if (
      err instanceof UnsupportedFile ||
      err instanceof UnreadableWorkbook ||
      err instanceof UnreadableDocument
    ) {
      return flash(err.message);
    }
    throw err;
  }

  // The parsed content becomes a document below, same as ever — but until now the original bytes
  // went nowhere the moment readUpload returned. Task 6's registration (lib/retrieval/register.ts)
  // reaches `attachments` through a LEFT JOIN filings precisely so a file with no exchange filing
  // behind it still reaches the index, and app/api/attachment/[sha]/route.ts is how a person gets
  // the original back rather than this system's lossy reading of it. Kept under whichever kind
  // fits without guessing: a workbook's own rows are already searchable as a sheet document, so
  // 'excel' here just labels the original file; anything else is 'other' rather than a
  // classification this path has no real basis for.
  await writeTxn(user.userId, (c) =>
    keepUploadAsAttachment(c, {
      companyId,
      kind: read.kind === 'sheet' ? 'excel' : 'other',
      filename: file.name,
      bytes,
      actorId: user.userId,
    }),
  );

  const base = file.name.replace(/\.[^.]+$/, '') || file.name;
  const made: string[] = [];

  if (read.kind === 'note') {
    const id = await createDocument({ title: base, kind: 'note', companyId }, user.userId);
    await saveDocument(id, { text: read.text }, user.userId);
    made.push(id);
    await flash(`Imported ${file.name} as a note, ${read.text.length} characters.`);
  } else {
    let kept = 0;
    let flattened = 0;
    for (const sheet of read.sheets) {
      // A one-sheet workbook takes the file's name; several take the file's name and the tab's,
      // so four grids from one upload are still findable as having come from it.
      const title = read.sheets.length === 1 ? base : `${base} — ${sheet.name}`;
      const id = await createDocument({ title, kind: 'sheet', companyId }, user.userId);
      await saveDocument(id, { cells: sheet.cells }, user.userId);
      made.push(id);
      kept += sheet.formulasKept;
      flattened += sheet.formulasFlattened;
    }
    await flash(
      `Imported ${file.name}: ${read.sheets.length} ${read.sheets.length === 1 ? 'sheet' : 'sheets'}, ` +
        `${kept} formulas kept live` +
        (flattened > 0
          ? `, ${flattened} replaced by the value Excel last showed — those used something this engine does not read.`
          : '.'),
    );
  }

  revalidatePath('/company/[symbol]', 'page');
  // Straight into it when there is one thing to look at; back to the list when there are several.
  if (made.length === 1) redirect(`/doc/${made[0]}`);
  if (symbol) redirect(`/company/${symbol}`);
}

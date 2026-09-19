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
import { typographyBody, type Typography } from '@/lib/prose/typography.ts';
import { bodyOf, type Tab } from '@/lib/sheet/book.ts';
import { lookupsFor } from '@/lib/sheet/data.ts';
import type { Lookups } from '@/lib/sheet/evaluate.ts';
import {
  archiveDocument,
  createDocument,
  deleteDocument,
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
export async function saveTextAction(
  id: string,
  text: string,
  type: Typography,
): Promise<void> {
  const user = await requireUser();
  try {
    // `{text, face, size}` — the typography is a sibling of the text, not inside it. Markdown has
    // nowhere to put a typeface, and `lib/retrieval/`'s chunker reads `.text` and would have to
    // learn to skip it if it were. Defaults are left out, so an untouched document stores `{text}`
    // exactly as it did before any of this.
    await saveDocument(id, typographyBody(text, type), user.userId);
  } catch (err) {
    if (err instanceof NoSuchDocument) return flash(err.message);
    throw err;
  }
  revalidatePath(`/doc/${id}`);
}

/**
 * Save a workbook, and answer with the figures it now asks this box for.
 *
 * The evaluator runs in the browser, but the data functions cannot — they read this system's own
 * tables. So a save is also the moment to re-resolve them: a model that gained a
 * `FIN("PRAJIND","revenue","FY27")` between one save and the next gets its answer without a reload.
 *
 * Every tab, always, rather than the one being looked at. A workbook is saved as a whole because
 * its tabs read each other: writing back only the active tab would let `=Inputs!B4` be evaluated
 * against an `Inputs` two saves behind the one the author was looking at when they typed it.
 *
 * `Tab`, not `Grid`: a tab carries its formats as well as its cells, and typing this as the grid
 * alone would let them through at runtime while the signature said they could not be there.
 */
export async function saveSheetAction(id: string, sheets: Tab[]): Promise<Lookups> {
  const user = await requireUser();
  const book = bodyOf(sheets);
  try {
    await saveDocument(id, book, user.userId);
  } catch (err) {
    if (err instanceof NoSuchDocument) {
      await flash(err.message);
      return {};
    }
    throw err;
  }
  revalidatePath(`/doc/${id}`);
  return lookupsFor(book.sheets);
}

/**
 * Rename, called from the title itself rather than from a form.
 *
 * The same `renameDocument` behind both: a dialog posts a FormData, the title in the header calls
 * this. Two entry points, one rule — `TitleRequired` is raised in `lib/workspace.ts` and neither
 * caller is trusted to have checked.
 */
export async function renameTitleAction(id: string, title: string): Promise<void> {
  const user = await requireUser();
  try {
    await renameDocument(id, title, user.userId);
  } catch (err) {
    if (err instanceof TitleRequired || err instanceof NoSuchDocument) return flash(err.message);
    throw err;
  }
  revalidatePath(`/doc/${id}`);
  revalidatePath('/documents');
  revalidatePath('/company/[symbol]', 'page');
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
      : `Archived, as ${user.email}. Show archived to find it again.`,
  );
  revalidatePath(`/doc/${id}`);
  revalidatePath('/company/[symbol]', 'page');
  if (!restore && symbol) redirect(`/company/${symbol}`);
}

/**
 * The real delete, which really deletes.
 *
 * Both actions exist and both are offered, because they answer different questions. Archive is for
 * writing the desk has finished with; this is for things that should not have been written — an
 * import that went in wrong, a file against the wrong company. The confirmation on each screen
 * names what goes, because the one thing this system will not do is have a button whose label
 * overstates or understates what it did.
 */
export async function deleteDocumentAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(form.get('id') ?? '');
  const symbol = String(form.get('symbol') ?? '');
  const title = String(form.get('title') ?? '');

  try {
    await deleteDocument(id, user.userId);
  } catch (err) {
    if (err instanceof NoSuchDocument) return flash(err.message);
    throw err;
  }
  await flash(
    `Deleted ${title || 'the document'} and every version of it, as ${user.email}. ` +
      'It is out of search too, and no screen here brings it back — only audit_log still holds it.',
  );

  revalidatePath('/documents');
  revalidatePath('/company/[symbol]', 'page');
  // Never back to /doc/<id> — it is gone, and that would be a 404 for a button that worked.
  redirect(symbol ? `/company/${symbol}` : '/documents');
}

/**
 * Bringing in a file the desk already has.
 *
 * **One file becomes one document.** A workbook with four tabs is one spreadsheet with four tabs,
 * which is what it was in Excel and what the person who uploaded it still believes they have. It
 * used to become four separate documents, and the cost was not untidiness: the tabs could no
 * longer see each other, so `lib/import/xlsx.ts`'s agreement check found every `=Inputs!B4`
 * disagreeing with the value Excel had cached for it and replaced the formula with a constant. A
 * four-tab model arrived as four documents of frozen numbers.
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
  let id: string;

  if (read.kind === 'note') {
    id = await createDocument({ title: base, kind: 'note', companyId }, user.userId);
    await saveDocument(id, { text: read.text }, user.userId);
    await flash(`Imported ${file.name} as a note, ${read.text.length} characters.`);
  } else {
    // The file's own name, and the tabs keep theirs. Titles used to carry the tab name — `Model —
    // Inputs` — because it was the only place it could survive; now it survives as a tab name,
    // which is where a formula can reach it.
    id = await createDocument({ title: base, kind: 'sheet', companyId }, user.userId);
    await saveDocument(
      id,
      bodyOf(read.sheets.map((s) => ({ name: s.name, cells: s.cells }))),
      user.userId,
    );

    const kept = read.sheets.reduce((n, s) => n + s.formulasKept, 0);
    const flattened = read.sheets.reduce((n, s) => n + s.formulasFlattened, 0);
    const tabs = read.sheets.length;
    await flash(
      `Imported ${file.name}: ${tabs} ${tabs === 1 ? 'tab' : 'tabs'} in one spreadsheet, ` +
        `${kept} formulas kept live` +
        (flattened > 0
          ? `, ${flattened} replaced by the value Excel last showed — those used something this engine does not read.`
          : '.'),
    );
  }

  revalidatePath('/company/[symbol]', 'page');
  // Straight into it. One upload is one document now, so there is never a list to land back on.
  redirect(`/doc/${id}`);
}

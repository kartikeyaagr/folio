'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { lookupsFor } from '@/lib/sheet/data.ts';
import type { Lookups } from '@/lib/sheet/evaluate.ts';
import {
  archiveDocument,
  createDocument,
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

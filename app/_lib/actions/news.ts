'use server';

import { revalidatePath } from 'next/cache';

import { clear, mark } from '@/lib/engagement.ts';

import { flash } from '../flash.ts';
import { requireUser } from '../session.ts';

/**
 * Reading and dismissing.
 *
 * A dismissal is a person saying "this matched, and it should not have". It is kept rather than
 * deleted because it is evidence about the matching — the only thing that would ever show that a
 * tier has stopped earning its place.
 */
export async function markNews(form: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(form.get('id') ?? '');
  const state = String(form.get('state') ?? '');
  if (state === 'read' || state === 'dismissed') {
    await mark('news', id, state, user.userId);
    await flash(state === 'read' ? 'Marked read' : `Dismissed as ${user.email}`);
  } else {
    await clear('news', id, user.userId);
    await flash('Brought back');
  }
  revalidatePath('/news');
}

'use server';

import { revalidatePath } from 'next/cache';

import {
  addCompany,
  AlreadyFollowed,
  searchSecurities as search,
  UnknownSymbol,
  type SecurityHit,
} from '@/lib/companies.ts';

import { flash } from '../flash.ts';
import { currentUser, requireUser } from '../session.ts';

/**
 * Following a name — the thing that starts everything else.
 *
 * Searches the **security master**, not `companies`. The header's ⌘K search is the other way round
 * on purpose: that one is for reaching a name the fund already follows, this one is for finding a
 * name it does not. Nothing could reach `addCompany` until 08-Sep-2026, so A1 and A5 were built in
 * `lib/` and unreachable from a browser, and the empty state invited you to follow a company with
 * no control that could.
 */

export type { SecurityHit } from '@/lib/companies.ts';

export async function searchSecurities(query: string): Promise<SecurityHit[]> {
  // Checked here and not only in the page: a server action is its own entry point, reachable
  // without ever rendering the page that hosts it.
  if (!(await currentUser())) return [];
  return search(query);
}

/**
 * Follow a name.
 *
 * A name already followed stays in the search results and is shown as such rather than being
 * filtered out. Someone who types a symbol and sees nothing concludes it does not exist; the
 * honest answer is that it exists and is already on the list.
 */
export async function followCompany(form: FormData): Promise<void> {
  const user = await requireUser();
  const symbol = String(form.get('symbol') ?? '')
    .trim()
    .toUpperCase();

  if (!symbol) {
    await flash('No symbol given, so nothing was followed.');
    return;
  }

  try {
    const company = await addCompany(symbol, user.userId);
    // Says what happened and as whom. `addCompany` attaches any filings already held for the name
    // in the same transaction, so the count is a fact at the moment of writing rather than a
    // promise about a later job.
    await flash(`Now following ${company.symbol} — ${company.name}, added by ${user.email}`);
  } catch (err) {
    // Both of these are things a person did, not faults: say so in place and leave the page
    // usable. Anything else is a real error and is allowed to reach the error boundary.
    if (err instanceof UnknownSymbol || err instanceof AlreadyFollowed) {
      await flash(err.message);
    } else {
      throw err;
    }
  }

  revalidatePath('/companies');
}

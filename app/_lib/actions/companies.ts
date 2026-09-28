'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  addCompany,
  AlreadyFollowed,
  NotFollowed,
  ReasonRequired,
  removeCompany,
  restoreCompany,
  StillHeld,
  UnknownSector,
  searchSecurities as search,
  setCoverage,
  setSector,
  setStatus,
  STATUSES,
  UnknownSymbol,
  type Removal,
  type SecurityHit,
  type Status,
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

/**
 * The security-master search, wrapped so a client component can be handed it.
 *
 * Nothing here but the check — `lib/companies.ts` owns the query, and is imported under an alias
 * so the name a caller sees is the name it already knew. The wrapper exists because `FollowPicker`
 * is a client component and can only be given a server action, and the library cannot become one:
 * `'use server'` at the top of a module publishes *every* export in it as a POST endpoint, and
 * that file holds `addCompany`, `setStatus` and `setSector` alongside the search, and is imported
 * by the standalone `tsx` jobs as well. One checked export is the smaller surface by far.
 *
 * Signed out it answers with no hits rather than an error, which is indistinguishable from no
 * match. Harmless only because the one caller lives inside the (app) layout, where there is always
 * a session — a picker rendered anywhere else would report an empty security master.
 */
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
    if (company.restored) {
      await flash(
        `${company.symbol} is back on the list, restored as ${user.email}, with everything it had. ` +
          'What it missed while removed is queued and arrives within the hour.',
      );
      revalidatePath('/companies');
      return;
    }
    // Says what actually happened rather than what a reader would assume. `addCompany` attaches the
    // filings already stored for the symbol, which is whatever the 14-day announcement window
    // happened to catch — not the company's history.
    //
    // It used to name `backfill-filings.ts` for a person to type. `0035` built the queue precisely
    // to remove that sentence, and `folio-backfill-company.timer` drains it every ten minutes, so
    // the instruction had been wrong since the unit shipped — and it named the narrower job, which
    // fetches announcements and none of the results, documents, actions, shareholding or prices the
    // name is also owed. The name is in the queue the moment this row exists; the table says where
    // it has got to.
    await flash(
      `Now following ${company.symbol} — ${company.name}, added by ${user.email}. ` +
        'Its history, results, documents and prices are queued and arrive within the hour.',
    );
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

/**
 * Where a name stands, and whose it is.
 *
 * A5 is a MUST and every part of it existed in `lib/companies.ts` with no caller outside its own
 * test: three companies sat at `watching` with `covered_by` NULL because nothing could write
 * either column. Two things followed from that and neither announced itself. A8's graveyard was
 * unreachable, since `closed_reason` can only be set by moving a name to `exited` or `passed`, so
 * `ReasonRequired` was dead code guarding a path nobody could walk. And alert routing read "tell
 * everyone" permanently, which is indistinguishable from a routing rule that works.
 */
export async function setStatusAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const companyId = String(form.get('companyId') ?? '');
  const status = String(form.get('status') ?? '');
  const reason = String(form.get('reason') ?? '');
  const symbol = String(form.get('symbol') ?? '');

  // Checked here rather than trusted from the select. A server action is its own entry point.
  if (!companyId) return flash('No company given.');
  if (!(STATUSES as readonly string[]).includes(status)) return flash('That is not a status.');

  try {
    await setStatus(companyId, status as Status, reason, user.userId);
    await flash(`${symbol || 'The name'} is now ${status}, as ${user.email}.`);
  } catch (err) {
    // Closing a name without saying why is the one thing this refuses, and it refuses it in a
    // sentence rather than as a constraint name.
    if (err instanceof ReasonRequired) return flash(err.message);
    throw err;
  }

  // The page-file form, not the resolved one. `revalidatePath('/company/PRAJIND')` returns without
  // complaint and leaves the rendered card showing the old status, so the toast says the name
  // moved and the fact beside it says it did not — measured 09-Sep-2026. Naming the page file
  // invalidates every path that matches it, which is what a dynamic segment needs.
  revalidatePath('/company/[symbol]', 'page');
  revalidatePath('/companies');
}

export async function setCoverageAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const companyId = String(form.get('companyId') ?? '');
  const userId = String(form.get('userId') ?? '');
  const symbol = String(form.get('symbol') ?? '');
  if (!companyId) return flash('No company given.');

  // Empty means nobody, which is a real answer and not a missing one: alert routing reads it as
  // "tell everyone". Passing it through as null rather than refusing it keeps that sayable.
  await setCoverage(companyId, userId || null, user.userId);
  await flash(
    userId
      ? `${symbol || 'The name'} is covered from now on, set by ${user.email}.`
      : `${symbol || 'The name'} is uncovered; its alerts go to everyone.`,
  );
  revalidatePath('/company/[symbol]', 'page');
  revalidatePath('/companies');
}

/**
 * Which sector a name belongs to.
 *
 * The one field on this page the security master cannot supply: NSE's file says what a company is
 * called and when it listed, and nothing about what it does. Until now nothing could write it
 * either, so every name added through the picker was excluded from the news matcher's sector tier
 * forever — silently, and permanently, while the Companies table rendered a Blank that no action
 * in the system could fill.
 */
export async function setSectorAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const companyId = String(form.get('companyId') ?? '');
  const sector = String(form.get('sector') ?? '');
  const symbol = String(form.get('symbol') ?? '');
  if (!companyId) return flash('No company given.');

  try {
    await setSector(companyId, sector, user.userId);
    await flash(
      sector
        ? `${symbol || 'The name'} is ${sector}, set by ${user.email}. Sector news will match from the next run.`
        : `${symbol || 'The name'} has no sector; it is out of the sector-news tier.`,
    );
  } catch (err) {
    // A sector with no vocabulary behind it is refused, and the refusal says why rather than
    // storing something that would behave exactly like the blank it replaced.
    if (err instanceof UnknownSector) return flash(err.message);
    throw err;
  }

  revalidatePath('/company/[symbol]', 'page');
  revalidatePath('/companies');
}

/**
 * Take a name off the list.
 *
 * The library decides between deleting and removing; this only says which happened. A deleted
 * name's page no longer exists, so it lands on the list rather than on a 404 for a button that
 * worked.
 */
export async function removeCompanyAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const symbol = String(form.get('symbol') ?? '').trim().toUpperCase();
  if (!symbol) return flash('No company given.');

  let outcome: Removal;
  try {
    outcome = await removeCompany(user.userId, symbol);
  } catch (err) {
    // A name on the book is the refusal a person can act on, and the sentence says how.
    if (err instanceof StillHeld || err instanceof NotFollowed) return flash(err.message);
    throw err;
  }

  revalidatePath('/companies');
  if (outcome === 'deleted') {
    await flash(`${symbol} is deleted, as ${user.email}. Nothing was recorded against it to keep.`);
    redirect('/companies');
  }
  await flash(
    `${symbol} is removed, as ${user.email}. Its history is kept, and Restore brings it back.`,
  );
  revalidatePath('/company/[symbol]', 'page');
}

export async function restoreCompanyAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const symbol = String(form.get('symbol') ?? '').trim().toUpperCase();
  if (!symbol) return flash('No company given.');

  try {
    const restored = await restoreCompany(user.userId, symbol);
    await flash(
      restored
        ? `${symbol} is back on the list, restored as ${user.email}. What it missed while ` +
            'removed is queued and arrives within the hour.'
        : `${symbol} was not removed, so nothing changed.`,
    );
  } catch (err) {
    if (err instanceof NotFollowed) return flash(err.message);
    throw err;
  }

  revalidatePath('/company/[symbol]', 'page');
  revalidatePath('/companies');
}

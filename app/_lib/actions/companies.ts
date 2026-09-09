'use server';

import { revalidatePath } from 'next/cache';

import {
  addCompany,
  AlreadyFollowed,
  ReasonRequired,
  UnknownSector,
  searchSecurities as search,
  setCoverage,
  setSector,
  setStatus,
  STATUSES,
  UnknownSymbol,
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
    // Says what actually happened rather than what a reader would assume. `addCompany` attaches
    // the filings already stored for the symbol, which is whatever the 14-day announcement window
    // happened to catch — not the company's history. Fetching that is one call to NSE, which does
    // not belong inside a request, so the command is named rather than the gap left silent.
    await flash(
      `Now following ${company.symbol} — ${company.name}, added by ${user.email}. ` +
        `For its filing history: pnpm exec tsx jobs/backfill-filings.ts --symbol ${company.symbol}`,
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

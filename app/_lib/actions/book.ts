'use server';

import { revalidatePath } from 'next/cache';

import {
  DuplicateTrade,
  ReasonRequired,
  confirmAction,
  recordCapital,
  recordTrade,
  reverseTrade,
} from '@/lib/book.ts';

import { flash } from '../flash.ts';
import { requireUser } from '../session.ts';

/**
 * The only manual write to the ledger.
 *
 * B2 says a trade is recorded once, attributed, and reversible. All three already held in
 * `lib/book.ts` and none of them could be reached: `recordTrade`, `reverseTrade`, `recordCapital`
 * and `confirmAction` had no caller outside their own test, so the empty state promised that "a
 * position appears here the moment its first trade is recorded" above nothing that could record
 * one.
 *
 * Nothing here computes. The library owns the arithmetic and the replay; these resolve who is
 * asking, turn a form into typed arguments, and say what happened.
 */

/** A form field that must be a number. Returns null rather than NaN, which would reach the ledger. */
function num(form: FormData, field: string): number | null {
  const raw = String(form.get(field) ?? '').trim().replace(/,/g, '');
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function recordTradeAction(form: FormData): Promise<void> {
  const user = await requireUser();

  const companyId = String(form.get('companyId') ?? '');
  const tradeDate = String(form.get('tradeDate') ?? '');
  const side = String(form.get('side') ?? '');
  const quantity = num(form, 'quantity');
  const price = num(form, 'price');
  const fees = num(form, 'fees') ?? 0;
  const seq = num(form, 'seq');

  // Checked here rather than trusted from the form. A required attribute is a courtesy to somebody
  // filling it in, not a guarantee to whatever posts to this endpoint.
  if (!companyId) return flash('Pick a company.');
  if (!DATE.test(tradeDate)) return flash('The trade date must be a calendar date.');
  if (side !== 'buy' && side !== 'sell') return flash('A trade is a buy or a sell.');
  if (quantity === null || quantity <= 0) return flash('Quantity must be a positive number.');
  if (price === null || price <= 0) return flash('Price must be a positive number.');
  if (fees < 0) return flash('Fees cannot be negative.');

  try {
    await recordTrade(
      { companyId, tradeDate, side, quantity, price, fees, seq: seq ?? undefined },
      user.userId,
    );
    await flash(`Recorded: ${side} ${quantity} at ${price}, as ${user.email}.`);
  } catch (err) {
    // A double-submitted form is the ordinary cause, and the library's message already names the
    // escape hatch for a genuine second fill. Said in place rather than thrown.
    if (err instanceof DuplicateTrade) return flash(err.message);
    throw err;
  }

  revalidatePath('/portfolio');
  revalidatePath('/');
  // The company page records trades too, and shows the holding the trade just moved. The
  // page-file form, for the reason `setStatusAction` gives: a resolved path leaves it stale.
  revalidatePath('/company/[symbol]', 'page');
}

/**
 * Reverse, never delete.
 *
 * The reason is required by the library and asked for here, because a reversal with no reason is
 * unreadable six months later — the position is right and nobody can say why it changed.
 */
export async function reverseTradeAction(form: FormData): Promise<void> {
  const user = await requireUser();
  try {
    await reverseTrade(
      String(form.get('id') ?? ''),
      String(form.get('reason') ?? ''),
      user.userId,
    );
    await flash(`Reversed, as ${user.email}. The trade stays on the record.`);
  } catch (err) {
    if (err instanceof ReasonRequired) return flash(err.message);
    throw err;
  }
  revalidatePath('/portfolio');
}

export async function recordCapitalAction(form: FormData): Promise<void> {
  const user = await requireUser();

  const kind = String(form.get('kind') ?? '');
  const amount = num(form, 'amount');
  const onDate = String(form.get('onDate') ?? '');
  const note = String(form.get('note') ?? '').trim();

  if (kind !== 'capital_in' && kind !== 'capital_out') return flash('Pick money in or money out.');
  if (amount === null || amount <= 0) {
    // The sign comes from the kind, not from the number: a negative in the "money out" box would
    // otherwise be money in, which is the wrong way to discover a typo.
    return flash('Amount must be a positive number; the direction comes from the choice above.');
  }
  if (!DATE.test(onDate)) return flash('The date must be a calendar date.');
  if (!note) return flash('Say what the movement was for.');

  await recordCapital(kind, amount, onDate, note, user.userId);
  await flash(
    `${kind === 'capital_in' ? 'Money in' : 'Money out'}: ${amount} on ${onDate}, as ${user.email}`,
  );
  revalidatePath('/portfolio');
}

/**
 * Confirm a corporate action, which is what makes it real to the book.
 *
 * An exchange feed announcing a bonus is not the same as the bonus having happened to us, which is
 * why nothing an ingest writes touches a position until a person says so. B5's confirm step is
 * this button.
 */
export async function confirmActionAction(form: FormData): Promise<void> {
  const user = await requireUser();
  await confirmAction(String(form.get('id') ?? ''), user.userId);
  await flash(`Applied to the book, as ${user.email}.`);
  revalidatePath('/portfolio');
  revalidatePath('/');
}

'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { requireUser } from '../session.ts';

/**
 * The theme toggle, and the last action in this directory to establish its caller.
 *
 * It had no `requireUser()` and no `currentUser()` until 21-Sep-2026 — a POST endpoint with a
 * stable id that an unauthenticated request could reach. It was the one exception of thirteen:
 * eleven resolve a user or an admin, and `auth.ts` resolves none because signing in and out are
 * what it is for. `tasks/open-items.md` §4 found the same hole when there were seven files, and
 * what it actually cost was a coverage table claiming all seven were gated — the kind of false
 * clean that outlives the thing it describes.
 *
 * The cost of the hole itself was nil, and that is worth keeping rather than deleting: this
 * writes a cookie on the caller's own browser and touches no row, so there was no write to
 * attribute and nothing of anyone else's within reach, and `currentTheme()` validates on read —
 * anything but `light` or `dark` comes back null — so a forged value never reached `data-theme`.
 * It is gated now because "reachable, but harmless" is a claim that has to be re-checked every
 * time the function grows, and "signed in" is a claim that does not.
 *
 * `requireUser` rather than a quiet `currentUser()` return: the toggle only exists inside the
 * (app) layout, which is already behind it, so a caller who is not signed in is not a user whose
 * click we are declining — it is a request nobody made from a page.
 *
 * `'layout'` and not the default: the toggle is in the (app) layout and can be clicked from any
 * page under it, so every path below that layout has to be invalidated, not just `/`.
 */
/** A year, because a theme choice is not a session-scoped preference. */
export async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  await requireUser();
  (await cookies()).set('folio_theme', theme, {
    path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax',
  });
  revalidatePath('/', 'layout');
}

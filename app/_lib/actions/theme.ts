'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

/**
 * The theme toggle — and the one action here that establishes no caller by accident.
 *
 * There is no `requireUser()` and no `currentUser()`, so this is a POST endpoint with a stable id
 * that an unauthenticated request can reach. Re-checked across all thirteen files in this
 * directory on 21-Sep-2026: eleven resolve a user or an admin, `auth.ts` resolves none because
 * signing in and out are what it is for, and this one is the remainder. The audit in
 * `tasks/open-items.md` §4 found the same thing when there were seven files.
 *
 * Written down rather than quietly closed, because the reason the cost is nil belongs next to the
 * code: this writes a cookie on the caller's own browser and touches no row, so there is no write
 * to attribute and nothing of anyone else's within reach. `currentTheme()` validates on read —
 * anything but `light` or `dark` comes back as null — so a forged value never reaches the
 * `data-theme` attribute either. What it actually cost was a coverage table that claimed all seven
 * actions were gated, which is the kind of false clean that outlives the thing it describes.
 *
 * `'layout'` and not the default: the toggle is in the (app) layout and can be clicked from any
 * page under it, so every path below that layout has to be invalidated, not just `/`.
 */
/** A year, because a theme choice is not a session-scoped preference. */
export async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  (await cookies()).set('trisula_theme', theme, {
    path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax',
  });
  revalidatePath('/', 'layout');
}

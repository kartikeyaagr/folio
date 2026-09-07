'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

/** A year, because a theme choice is not a session-scoped preference. */
export async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  (await cookies()).set('trisula_theme', theme, {
    path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax',
  });
  revalidatePath('/', 'layout');
}

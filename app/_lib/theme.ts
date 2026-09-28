import { cookies } from 'next/headers';

export type Theme = 'light' | 'dark';

/**
 * The chosen theme, or nothing.
 *
 * Nothing is a real answer: with no choice made the stylesheet follows the operating system, so the
 * attribute is absent rather than guessed. Guessing means a flash of the wrong theme on first load.
 */
export async function currentTheme(): Promise<Theme | null> {
  const value = (await cookies()).get('folio_theme')?.value;
  return value === 'light' || value === 'dark' ? value : null;
}

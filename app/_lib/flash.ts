import { cookies } from 'next/headers';

import { FLASH_COOKIE } from './flash-cookie.ts';

/**
 * A one-shot message across a redirect.
 *
 * Read clears it, so a message is shown once and not again on the next navigation. Copy says what
 * actually happened and as whom — "Recorded as Ana", not "Saved".
 */
export async function flash(message: string): Promise<void> {
  (await cookies()).set(FLASH_COOKIE, message, { httpOnly: true, path: '/', maxAge: 30 });
}

export async function readFlash(): Promise<string | null> {
  const jar = await cookies();
  const message = jar.get(FLASH_COOKIE)?.value ?? null;
  if (message) jar.delete(FLASH_COOKIE);
  return message;
}

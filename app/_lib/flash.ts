import { cookies } from 'next/headers';

import { FLASH_COOKIE } from './flash-cookie.ts';

/**
 * A one-shot message across a redirect.
 *
 * Copy says what actually happened and as whom — "Recorded as Ana", not "Saved". A confirmation
 * the reader cannot check is not a confirmation.
 *
 * **Reading does not clear it, and must not.** Cookies can only be mutated inside a Server Action
 * or a Route Handler; this is read from the layout, which is a render. Clearing here throws
 * "Cookies can only be modified in a Server Action or Route Handler" — and only on the requests
 * where a message actually exists, so it stays invisible until the first time somebody is told
 * something and then breaks that page.
 *
 * The `Toast` client component clears it in the browser once it has been shown, which is what
 * `flash-cookie.ts` exists for: a cookie name with no server dependencies, importable from a
 * client component.
 */
export async function flash(message: string): Promise<void> {
  (await cookies()).set(FLASH_COOKIE, message, { httpOnly: false, path: '/', maxAge: 30 });
}

export async function readFlash(): Promise<string | null> {
  return (await cookies()).get(FLASH_COOKIE)?.value ?? null;
}

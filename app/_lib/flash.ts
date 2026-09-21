import { randomBytes } from 'node:crypto';

import { cookies } from 'next/headers';

import { FLASH_COOKIE } from './flash-cookie.ts';
import { SECURE_COOKIES } from './session-cookie.ts';

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

/** A one-shot message, and which setting of it this is. */
export interface Flash {
  /** What to say. */
  message: string;
  /**
   * Which setting of the cookie this is, not which message.
   *
   * `Toast`'s effect keys on this. Keyed on the text alone, the same confirmation twice in a row
   * showed one toast — clicking "Queue" twice in ten seconds looked like the second click did
   * nothing, on the one component whose whole job is to say that something happened.
   */
  occurrence: string;
}

/** Say this once, on whatever page the redirect lands on. */
export async function flash(message: string): Promise<void> {
  // `<occurrence> <message>`. The occurrence is hex, so the first space is unambiguously the
  // separator and the message may contain as many more as it likes.
  const occurrence = randomBytes(8).toString('hex');
  (await cookies()).set(FLASH_COOKIE, `${occurrence} ${message}`, {
    // Not httpOnly, deliberately: `Toast` clears this from the browser once it has been shown,
    // for the reason in the header above. What it carries is a sentence meant for the screen.
    httpOnly: false,
    // Hygiene rather than exposure, and the same two settings as the session cookie beside it, so
    // there is one answer in this directory to "how is a cookie set here" rather than two.
    secure: SECURE_COOKIES,
    sameSite: 'lax',
    path: '/',
    maxAge: 30,
  });
}

/** Whatever is waiting to be said, still waiting — reading it does not clear it, per the header. */
export async function readFlash(): Promise<Flash | null> {
  const raw = (await cookies()).get(FLASH_COOKIE)?.value;
  if (raw === undefined) return null;
  const separator = raw.indexOf(' ');
  // A value written before the occurrence existed, or set by hand, has no separator. It outlives
  // a deploy by at most the 30 seconds above, and reading the whole of it as the message costs
  // one comparison and means that deploy swallows nobody's confirmation.
  if (separator === -1) return { message: raw, occurrence: raw };
  return { message: raw.slice(separator + 1), occurrence: raw.slice(0, separator) };
}

/**
 * A fixed-window counter, in process.
 *
 * Sized for one box running one Node process, which is what `ops/SETUP.md` builds. It is
 * deliberately not in Postgres: the thing most worth surviving here is a burst of login attempts,
 * and a limiter that writes a row per attempt turns the attack it is defending against into
 * database load. The cost is that counters reset on restart and are not shared across processes —
 * both acceptable for a single-process deployment, and both wrong the moment there are two, which
 * is why this says so rather than pretending to be general.
 *
 * Fixed window, not sliding: a sliding window needs the timestamps kept, and against an attacker
 * who can send thousands a second the difference between the two is a rounding error next to the
 * difference between limiting and not.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Bounded memory: entries are only ever created on a miss, and expired ones are dropped here. */
function sweep(now: number): void {
  if (windows.size < 1000) return;
  for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
}

export interface Limit {
  /** Attempts allowed inside one window. */
  max: number;
  windowMs: number;
}

export interface Verdict {
  allowed: boolean;
  /** Seconds until the window resets. Zero when allowed. */
  retryAfter: number;
}

/**
 * Record an attempt against `key` and say whether it is allowed.
 *
 * Counts the attempt whether or not it is allowed, so hammering a limited key keeps it limited
 * rather than letting the window drain while the attacker keeps trying.
 */
export function hit(key: string, limit: Limit, now = Date.now()): Verdict {
  sweep(now);
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + limit.windowMs });
    return { allowed: true, retryAfter: 0 };
  }
  existing.count += 1;
  if (existing.count > limit.max) {
    return { allowed: false, retryAfter: Math.ceil((existing.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}

/** Forget a key. Called on a successful login so a fumbled password does not count against you. */
export function clear(key: string): void {
  windows.delete(key);
}

/** Test-only: an empty limiter between cases. */
export function reset(): void {
  windows.clear();
}

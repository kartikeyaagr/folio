/**
 * Reading a job's flags.
 *
 * Eight jobs carried a verbatim copy of this until 18-Sep-2026:
 *
 *     function arg(flag: string): string | undefined {
 *       const i = process.argv.indexOf(flag);
 *       return i >= 0 ? process.argv[i + 1] : undefined;
 *     }
 *
 * It had two holes, and both are the kind an operator meets at the worst moment. `--flag=value`
 * was silently unsupported, so `--symbol=AERON` read as no symbol at all. And nothing detected an
 * unknown flag, so a typo — `--symbl AERON` against `jobs/backfill-filings.ts` — quietly backfilled
 * *every* followed name instead of one. `jobs/set-admin.ts --email --revoke` likewise took
 * `"--revoke"` for an address and reported no such account.
 *
 * `parseArgs` has been in `node:util` since Node 20 and this tree runs Node 25, so the fix costs
 * no dependency: it understands both spellings and refuses what it was not told about.
 */

import { parseArgs } from 'node:util';

export class BadUsage extends Error {}

export interface Flags {
  /** A flag carrying a value — `--symbol AERON` or `--symbol=AERON`. */
  str(name: string): string | undefined;
  /** A flag that is present or not — `--revoke`. */
  bool(name: string): boolean;
}

/**
 * Parse `process.argv`, accepting exactly the flags named and refusing everything else.
 *
 * Names are given without their dashes. An unknown or malformed flag raises `BadUsage`, which a
 * job should print and exit non-zero on rather than continuing with a default — the whole point is
 * that a mistyped flag must not look like an instruction to do the broadest possible thing.
 */
export function readFlags(
  strings: readonly string[],
  booleans: readonly string[] = [],
  /** Defaults to this process's arguments; passed explicitly by the tests. */
  args?: readonly string[],
): Flags {
  const options: Record<string, { type: 'string' | 'boolean' }> = {};
  for (const name of strings) options[name] = { type: 'string' };
  for (const name of booleans) options[name] = { type: 'boolean' };

  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      ...(args ? { args: [...args] } : {}),
      options,
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    const known = [...strings.map((s) => `--${s} <value>`), ...booleans.map((b) => `--${b}`)];
    throw new BadUsage(
      `${err instanceof Error ? err.message : String(err)}\nAccepts: ${known.join(' ') || '(no flags)'}`,
    );
  }

  return {
    str: (name) => (typeof values[name] === 'string' ? values[name] : undefined),
    bool: (name) => values[name] === true,
  };
}

/**
 * Reading a zip.
 *
 * Hand-written against `node:zlib` until 18-Sep-2026, here and again in `lib/ingest/bhavcopy.ts` —
 * two walkers of the same container format in one tree, which is the shape that drifts. The
 * reuse-ladder argument for writing them ("about seventy lines against a zip dependency") was
 * sound about `zlib` and wrong about the rung: `zlib` gives you inflate, and inflate is not the
 * part with the edge cases. The container is.
 *
 * `fflate` is 30KB with no dependencies of its own and no native build step, so it clears the bar
 * `pnpm.onlyBuiltDependencies: []` sets. It also reads entries lazily, which `unzipListing` and
 * `unzipOne` below exist to use: picking one member out of an annual-report archive no longer
 * inflates the rest to throw them away.
 *
 * Every failure is still raised as `UnreadableZip`. That is load-bearing rather than tidy —
 * `lib/ingest/annual-reports.ts` treats it as a *terminal* outcome ("this archive will never
 * read") and records `unavailable` instead of retrying, so an error escaping under fflate's own
 * type would turn a recorded outcome into a failed job.
 */

import { unzipSync, type UnzipFileInfo } from 'fflate';

export class UnreadableZip extends Error {}

/** fflate reports a malformed archive by throwing; the callers here are written against one type. */
function readZip(buf: Buffer, filter?: (f: UnzipFileInfo) => boolean): Record<string, Uint8Array> {
  try {
    return unzipSync(new Uint8Array(buf), filter ? { filter } : undefined);
  } catch (err) {
    throw new UnreadableZip(err instanceof Error ? err.message : String(err));
  }
}

/**
 * What the archive holds, and how big each member is once inflated, without inflating any of it.
 *
 * `originalSize` comes off the central directory, so this is a read of the index rather than of
 * the contents.
 */
export function unzipListing(buf: Buffer): { name: string; bytes: number }[] {
  const out: { name: string; bytes: number }[] = [];
  readZip(buf, (f) => {
    out.push({ name: f.name, bytes: f.originalSize });
    return false;
  });
  return out;
}

/** One entry, inflated on its own. Null when the archive does not hold that name. */
export function unzipOne(buf: Buffer, name: string): Buffer | null {
  const got = readZip(buf, (f) => f.name === name)[name];
  return got ? Buffer.from(got) : null;
}

/** Every entry, by name. For the OOXML formats, where a dozen small parts are all wanted. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const [name, bytes] of Object.entries(readZip(buf))) {
    // A directory entry is a zero-byte member whose name ends in a slash. Not a part.
    if (!name.endsWith('/')) out.set(name, Buffer.from(bytes));
  }
  return out;
}


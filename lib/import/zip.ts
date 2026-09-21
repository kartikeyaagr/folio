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

/**
 * What an archive is allowed to cost.
 *
 * `unzipSync` had no ceiling of any kind, so a malformed or hostile archive could ask for every
 * byte on the box — a 2GB t4g.small running Postgres and Next beside this. Same shape as the range
 * bomb fixed in `b993f46` and the same threat model: three people on a private network with no
 * public upload, so a footgun somebody reaches by dropping in the wrong file rather than an attack
 * surface. Same answer too — ask the question before allocating, and refuse with a sentence that
 * names the limit.
 *
 * The numbers are an order of magnitude past anything this desk imports. The largest annual report
 * in the corpus is 21.4MB and `importFileAction` refuses an upload over 32MB; note.docx — a real
 * Word file with an embedded image — inflates to 827KB across 17 parts, and model.xlsx to 18KB
 * across 10.
 *
 * They are read off the central directory rather than measured while inflating, because that is
 * the only place they can be read *before* the allocation they exist to prevent: fflate 0.8.3
 * allocates `new u8(originalSize)` per entry from exactly that field. A field that lies cannot get
 * past them either — measured 21-Sep-2026 against fflate 0.8.3, an entry declaring 10 bytes for an
 * 8MB stream inflates to the 10 it declared and stops, so the declaration is the ceiling whether
 * it is honest or not.
 */
const MAX_ENTRIES = 4_096;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

/** fflate reports a malformed archive by throwing; the callers here are written against one type. */
function readZip(buf: Buffer, filter?: (f: UnzipFileInfo) => boolean): Record<string, Uint8Array> {
  let entries = 0;
  let total = 0;
  try {
    return unzipSync(new Uint8Array(buf), {
      // The count is taken over the whole central directory, since that is what fflate walks; the
      // two byte ceilings are taken over what is actually inflated, which is what `unzipListing`
      // and `unzipOne` exist to keep small. So the index of an archive too large to open still
      // reads, and picking one 30MB report out of it still works.
      filter: (f) => {
        if (++entries > MAX_ENTRIES) {
          throw new UnreadableZip(
            `this archive holds more than ${MAX_ENTRIES.toLocaleString('en-IN')} entries, which is ` +
              'more parts than a document has',
          );
        }
        if (filter && !filter(f)) return false;
        if (f.originalSize > MAX_ENTRY_BYTES) {
          throw new UnreadableZip(
            `${f.name} inflates to ${mb(f.originalSize)}, past the ${mb(MAX_ENTRY_BYTES)} one entry may hold`,
          );
        }
        total += f.originalSize;
        if (total > MAX_TOTAL_BYTES) {
          throw new UnreadableZip(`this archive inflates to more than ${mb(MAX_TOTAL_BYTES)}`);
        }
        return true;
      },
    });
  } catch (err) {
    // A refusal raised above is already the sentence to show; rewrapping it would bury it.
    if (err instanceof UnreadableZip) throw err;
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


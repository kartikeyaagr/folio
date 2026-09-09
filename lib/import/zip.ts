/**
 * Reading a zip with more than one thing in it.
 *
 * `lib/ingest/bhavcopy.ts` already reads a zip holding exactly one entry by walking its local
 * header. An `.xlsx` or a `.docx` is a zip holding a dozen — a workbook, its shared strings, a
 * sheet per tab, the styles — and finding those means reading the **central directory** rather
 * than guessing at offsets, because a local header may declare zero sizes when a data descriptor
 * follows the entry.
 *
 * About seventy lines against a zip dependency, using only `node:zlib`, and the same reuse-ladder
 * argument bhavcopy.ts makes for its twenty. Only what those two formats actually use is
 * supported: stored and deflated entries, no encryption, no zip64, no spanning. Anything else is
 * refused by name rather than half-read.
 */

import { inflateRawSync } from 'node:zlib';

export class UnreadableZip extends Error {}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;

/**
 * Every entry, by name.
 *
 * Read back-to-front, which is how a zip is meant to be read: the end-of-central-directory record
 * is the only thing at a known position, and it says where the directory is. Scanning forward from
 * the start works until an entry's name appears inside another entry's compressed bytes.
 */
export function unzip(buf: Buffer): Map<string, Buffer> {
  if (buf.length < 22 || buf.readUInt32LE(0) !== LOCAL) {
    throw new UnreadableZip('not a zip file');
  }

  // The end record is 22 bytes plus a comment of up to 64k. Searched backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65_536; i--) {
    if (buf.readUInt32LE(i) === END) { eocd = i; break; }
  }
  if (eocd === -1) throw new UnreadableZip('no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);

  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) {
      throw new UnreadableZip('the central directory ended early');
    }
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localAt) !== LOCAL) {
      throw new UnreadableZip(`${name} does not start where the directory says it does`);
    }
    // The local header's own name and extra lengths, which need not match the directory's.
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const body = buf.subarray(dataAt, dataAt + compressed);

    if (method === 0) out.set(name, Buffer.from(body));
    else if (method === 8) out.set(name, inflateRawSync(body));
    else throw new UnreadableZip(`${name} uses zip compression method ${method}, which is not supported`);
  }
  return out;
}

/** One entry as text, or null. Names in these formats are fixed, so a miss is a shape problem. */
export function entryText(zip: Map<string, Buffer>, name: string): string | null {
  const b = zip.get(name);
  return b ? b.toString('utf8') : null;
}

/**
 * Writing a zip, which is what a `.docx` is.
 *
 * The mirror of `lib/import/zip.ts`, and the same argument: about eighty lines against a zip
 * dependency, using only `node:zlib`. The reader supports what `.xlsx` and `.docx` actually use;
 * this writes the narrowest thing Word will open — deflated entries, no encryption, no zip64, no
 * data descriptors, because every entry's size is known before it is written.
 *
 * The one part that is easy to get subtly wrong is that a zip says everything twice: once in each
 * entry's local header and again in the central directory at the end. Word reads the directory,
 * most tools read the headers, and a file where the two disagree opens in one and not the other.
 * So both are written from the same record here rather than computed twice.
 */

import { deflateRawSync } from 'node:zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
/** Deflate. Stored (0) is allowed by the format but nothing here is small enough to want it. */
const DEFLATED = 8;

/**
 * Bit 11 of the general-purpose flags: this entry's name is UTF-8.
 *
 * Names are written with `Buffer.from(name, 'utf8')` and the flag word said nothing, so a reader
 * was entitled by the spec to decode anything outside ASCII as CP437 and show mojibake. Nothing in
 * this tree can reach it today — `zip()`'s only caller is `toDocx`, whose six entry names are
 * ASCII constants — but it costs a word, and the first caller that puts a document title into an
 * entry name should not have to find the bug first. Every other bit stays clear: no encryption
 * (bit 0) and no data descriptor (bit 3), because every entry's size is known before it is
 * written.
 */
const UTF8_NAMES = 0x0800;

/** CRC-32, which the format requires and `node:zlib` does not expose. */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * MS-DOS date and time, which is what a zip stores.
 *
 * Fixed at the start of 1980 — the earliest the format can express — rather than `now`. A document
 * exported twice with no edit in between should be the same bytes: it makes the export testable,
 * and it means a reader diffing two exports sees what changed in the document rather than when
 * they pressed the button.
 */
const DOS_EPOCH = { time: 0, date: (1 << 5) | 1 };

export interface Entry {
  name: string;
  body: Buffer;
}

export function zip(entries: readonly Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.body, { level: 9 });
    const sum = crc32(entry.body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, which is deflate
    local.writeUInt16LE(UTF8_NAMES, 6); // and nothing else: no data descriptor, no encryption
    local.writeUInt16LE(DEFLATED, 8);
    local.writeUInt16LE(DOS_EPOCH.time, 10);
    local.writeUInt16LE(DOS_EPOCH.date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    locals.push(local, name, deflated);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(UTF8_NAMES, 8); // the same word; the two headers must agree
    central.writeUInt16LE(DEFLATED, 10);
    central.writeUInt16LE(DOS_EPOCH.time, 12);
    central.writeUInt16LE(DOS_EPOCH.date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(entry.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + deflated.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk the directory starts on
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no comment

  return Buffer.concat([...locals, directory, end]);
}

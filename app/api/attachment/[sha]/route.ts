import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { NextResponse } from 'next/server';

import { readTxn } from '@/lib/db.ts';
import { pathFor } from '@/lib/ingest/attachments.ts';

import { currentUser } from '../../../_lib/session.ts';

/**
 * The original file behind an extracted document.
 *
 * An extracted transcript is this system's *reading* of a PDF the company filed, and a reading is
 * worth having only while it can be checked against the thing it read. This serves that thing.
 *
 * **Signed in, always.** These are the fund's own downloads of filings, on a box reachable over
 * Tailscale, and an unauthenticated file endpoint on it would be the one door in the building with
 * no lock. `middleware.ts` guards the pages; a route handler has to say so itself.
 *
 * **The name in the URL is a hash, and it is checked against the table before it touches disk.**
 * `pathFor` joins its argument into a directory path, so a value like `../../etc/passwd` would
 * resolve outside the store — the 64-hex test refuses that shape outright, and the row lookup means
 * only a file this system actually recorded can be asked for.
 */

export const dynamic = 'force-dynamic';

const SHA = /^[0-9a-f]{64}$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sha: string }> },
): Promise<NextResponse> {
  if (!(await currentUser())) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }

  const { sha } = await params;
  if (!SHA.test(sha)) {
    return NextResponse.json({ error: 'not a content hash' }, { status: 400 });
  }

  const row = await readTxn(async (c) => {
    const { rows } = await c.query<{ filename: string; media_type: string; bytes: string }>(
      'SELECT filename, media_type, bytes::text FROM attachments WHERE sha256 = $1',
      [sha],
    );
    return rows[0] ?? null;
  });
  if (!row) return NextResponse.json({ error: 'no such attachment' }, { status: 404 });

  const file = pathFor(sha);
  try {
    await stat(file);
  } catch {
    // The row is the record that it was fetched; the bytes living somewhere else is an operational
    // fact, and saying which of the two is missing is the difference between a five-minute fix and
    // an afternoon. ATTACHMENT_DIR is the usual answer.
    return NextResponse.json(
      { error: `recorded but not on disk at ${file}; check ATTACHMENT_DIR` },
      { status: 404 },
    );
  }

  // Streamed rather than read into memory: an annual report is single-digit megabytes and there is
  // no reason for the web process to hold one.
  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      'Content-Type': row.media_type || 'application/octet-stream',
      'Content-Length': row.bytes,
      // `inline` so a PDF opens in the browser beside the extracted text rather than landing in
      // Downloads. The filename is quoted because NSE's carry spaces and commas.
      'Content-Disposition': `inline; filename="${row.filename.replace(/["\\]/g, '')}"`,
      // The name is the content's own hash, so the bytes can never change under it.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}

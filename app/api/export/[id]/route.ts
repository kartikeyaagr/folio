import { NextResponse } from 'next/server';

import { toDocx, docxFilename } from '@/lib/export/docx.ts';
import { getDocument } from '@/lib/workspace.ts';

import { currentUser } from '../../../_lib/session.ts';

/**
 * A document, as a `.docx`.
 *
 * Built on the way out rather than stored. A document's canonical form is its text, and the version
 * history, the search index and every diff read that — a `.docx` kept beside it would be a second
 * copy that is wrong the moment somebody saves without exporting. Generating it per request costs
 * a few milliseconds on a memo and cannot go stale.
 *
 * **Signed in, always.** Same argument as `app/api/attachment/[sha]/route.ts`: `middleware.ts`
 * guards the pages, and a route handler has to say so itself. This one serves the desk's own
 * writing, which is the most sensitive thing in the building.
 *
 * Spreadsheets are refused by name rather than exported as a page of tab-separated text. A workbook
 * has tabs, formats and column widths that a `.docx` has nowhere to put, and a file that silently
 * loses them is worse than one that was never offered — `.xlsx` is its own export and its own work.
 */

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!(await currentUser())) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }

  const { id } = await params;
  const doc = await getDocument(id);
  if (!doc) return NextResponse.json({ error: 'no such document' }, { status: 404 });

  if (doc.kind === 'sheet') {
    return NextResponse.json(
      { error: 'a spreadsheet does not export as a Word document' },
      { status: 400 },
    );
  }

  const text = typeof doc.body['text'] === 'string' ? doc.body['text'] : '';
  const bytes = toDocx(doc.title, text);
  const filename = docxFilename(doc.title);

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Length': String(bytes.length),
      // `attachment`, not `inline`: the point of this is a file you can mail, so it belongs in
      // Downloads rather than in a tab the browser cannot render anyway. Quoted because a memo's
      // title carries spaces and em dashes, and `filename*` carries the ones that are not ASCII.
      'Content-Disposition':
        `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '')}"; `
        + `filename*=UTF-8''${encodeURIComponent(filename)}`,
      // Regenerated from the current version every time, so there is nothing to cache.
      'Cache-Control': 'no-store',
    },
  });
}

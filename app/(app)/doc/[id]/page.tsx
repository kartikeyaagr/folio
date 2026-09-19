import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getDocument, isEditable, KIND_LABEL, provenanceOf, revisionsOf } from '@/lib/workspace.ts';
import { DATA_FUNCTIONS, lookupsFor } from '@/lib/sheet/data.ts';
import { AppHeader, Blank, Card, Empty, Fact, Facts } from '@/components/ui.tsx';
import { DialogButton } from '@/components/DialogButton.tsx';
import { DocEditor } from '@/components/DocEditor.tsx';
import { DocumentText } from '@/components/DocumentText.tsx';
import { SheetEditor } from '@/components/SheetEditor.tsx';

import { requireUser } from '../../../_lib/session.ts';
import {
  archiveDocumentAction,
  renameDocumentAction,
  saveSheetAction,
  saveTextAction,
} from '../../../_lib/actions/workspace.ts';

/**
 * One document, open.
 *
 * A note and a model are the same object here — same table, same versioning, same attribution —
 * so this page is one shell with two bodies rather than two pages that drift apart.
 *
 * The sheet's data functions are resolved **on the server**, on the way in, and handed to the grid
 * as a map. The evaluator itself is pure and runs in the browser as you type; only the figures that
 * come out of this box need a round trip, and they need it once rather than once a cell.
 */

export const dynamic = 'force-dynamic';

const when = (d: Date | null): string =>
  d === null
    ? '—'
    : new Intl.DateTimeFormat('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Kolkata',
      }).format(d);

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const doc = await getDocument(id);
  if (!doc) notFound();

  const isSheet = doc.kind === 'sheet';
  // Written by this system rather than by a person, and therefore read rather than edited.
  const editable = isEditable(doc.kind);
  const cells = (doc.body['cells'] ?? {}) as Record<string, string>;
  const text = typeof doc.body['text'] === 'string' ? doc.body['text'] : '';
  const [lookups, revisions, from] = await Promise.all([
    isSheet ? lookupsFor(cells) : Promise.resolve({}),
    revisionsOf(doc.id, 12),
    provenanceOf(doc.id),
  ]);

  return (
    <>
      <AppHeader
        title={doc.title}
        subtitle={
          `${KIND_LABEL[doc.kind] ?? doc.kind}` +
          (doc.symbol ? ` · ${doc.symbol}` : '') +
          ` · ${doc.versions} ${doc.versions === 1 ? 'version' : 'versions'}`
        }
        back={doc.symbol ? `/company/${doc.symbol}` : '/documents'}
        backTitle={doc.symbol ?? 'Documents'}
      />

      <div className="page">
        {doc.archivedAt && (
          <p className="notice">
            Archived {when(doc.archivedAt)}. It is still here and still editable — nothing in this
            system deletes writing.
          </p>
        )}

        <Card
          title={isSheet ? 'Model' : editable ? 'Document' : KIND_LABEL[doc.kind] ?? 'Document'}
          action={
            <div className="form-actions">
              {!editable && (
                // Said, not merely enforced by the absence of a Save button. A reader who cannot
                // find how to edit should learn that there is nothing to find.
                <span className="chip chip-neutral" title="Extracted by this system from the filing below. The record is not edited here.">
                  read only
                </span>
              )}
              <DialogButton label="Rename" title="Rename" className="btn btn-link">
                <form action={renameDocumentAction} className="form-grid">
                  <input type="hidden" name="id" value={doc.id} />
                  <label className="lbl">
                    Title
                    <input className="field" name="title" defaultValue={doc.title} required />
                  </label>
                  <div className="form-actions">
                    <button type="submit" className="btn btn-primary">Rename</button>
                  </div>
                </form>
              </DialogButton>
              <form action={archiveDocumentAction}>
                <input type="hidden" name="id" value={doc.id} />
                {doc.archivedAt && <input type="hidden" name="restore" value="1" />}
                <button type="submit" className="btn btn-link">
                  {doc.archivedAt ? 'Restore' : 'Archive'}
                </button>
              </form>
            </div>
          }
          padded={!isSheet}
        >
          {isSheet ? (
            // The action by reference and the id beside it. An arrow closing over the id would be
            // an event handler, which cannot cross into a client component.
            <SheetEditor id={doc.id} cells={cells} lookups={lookups} onSave={saveSheetAction} />
          ) : editable ? (
            <DocEditor id={doc.id} text={text} onSave={saveTextAction} />
          ) : (
            <DocumentText text={text} />
          )}
        </Card>

        {isSheet && (
          <Card title="Figures this sheet can read">
            <p className="picker-none">
              These read the figures already ingested, so a model updates when the next filing
              lands. A figure that is not held answers <code>#N/A</code>, never zero.
            </p>
            <div className="tbl-scroll">
              <table className="tbl">
                <thead><tr><th>Function</th><th>Takes</th><th>Answers</th></tr></thead>
                <tbody>
                  {DATA_FUNCTIONS.map((f) => (
                    <tr key={f.name}>
                      <td><code>{f.name}</code></td>
                      <td className="cell-wrap"><code>{f.args}</code></td>
                      <td className="cell-wrap">{f.what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {from && (
          <Card title="Where this came from">
            <p className="picker-none">
              This is what was read out of the file below. The original is kept so the reading can
              be checked against it.
            </p>
            <Facts>
              <Fact label="Filing" value={from.filingCategory ?? <Blank why="No announcement links to this file" />} />
              <Fact label="Announced" value={from.announcedAt ? when(from.announcedAt) : <Blank why="Not linked to an announcement" />} />
              <Fact label="Size" value={`${(from.bytes / 1e6).toFixed(2)} MB`} />
            </Facts>
            {from.filingSubject && <p className="tbl-note">{from.filingSubject}</p>}
            <p className="tbl-note">
              <a href={`/api/attachment/${from.sha256}`} target="_blank" rel="noreferrer">
                Open {from.filename}
              </a>
            </p>
          </Card>
        )}

        <Card title="History">
          {revisions.length === 0 ? (
            <Empty>No saves recorded.</Empty>
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead><tr><th>Saved</th><th>By</th></tr></thead>
                <tbody>
                  {revisions.map((r) => (
                    <tr key={r.id}>
                      <td className="num">{when(r.writtenAt)}</td>
                      <td>{r.writtenByName ?? <Blank why="Saved before authorship was recorded" />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="tbl-note">
            Every save is kept. <Link href={doc.symbol ? `/company/${doc.symbol}` : '/documents'}>
              Back to {doc.symbol ?? 'documents'}
            </Link>.
          </p>
        </Card>
      </div>
    </>
  );
}

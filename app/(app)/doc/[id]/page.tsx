import { notFound } from 'next/navigation';

import { getDocument, isEditable, KIND_LABEL, provenanceOf, revisionsOf } from '@/lib/workspace.ts';
import { sheetsOf } from '@/lib/sheet/book.ts';
import { lookupsFor } from '@/lib/sheet/data.ts';
import { AppHeader, Blank, Empty, Fact, Facts } from '@/components/ui.tsx';
import { DeleteDocument } from '@/components/DeleteDocument.tsx';
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
 * One document, open — and open is all it is.
 *
 * **The document fills the screen.** Every other page here is a stack of cards you scroll through,
 * because every other page is a set of readings that are looked at together. This one holds a
 * single thing somebody is working inside, and a model that ends two thirds of the way down the
 * viewport with a History table under it is a model you scroll past to reach rather than one you
 * work in. So the grid takes the height, scrolls within itself, and keeps its column letters and
 * row numbers pinned while it does — which the page-level scroll could never do.
 *
 * Everything that used to be a card below the document is now an icon in the ribbon: the history,
 * and the filing an ingested document was read out of. They are worth reaching; they are not worth
 * pushing the work off the screen.
 *
 * A note and a model are still the same object — same table, same versioning, same attribution —
 * so this is one shell with three bodies rather than three pages that drift apart.
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

/** The house icon shape: 16px, stroked in `currentColor`, no fill. Same as the header's own back arrow. */
const icon = (path: React.ReactNode) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

const HISTORY = icon(
  <>
    <path d="M3 3v5h5" />
    <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
    <path d="M12 7v5l3 2" />
  </>,
);

const EXPORT = icon(
  <>
    <path d="M12 3v12" />
    <path d="m8 11 4 4 4-4" />
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
  </>,
);

const SOURCE = icon(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </>,
);

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const doc = await getDocument(id);
  if (!doc) notFound();

  const isSheet = doc.kind === 'sheet';
  // Written by this system rather than by a person, and therefore read rather than edited.
  const editable = isEditable(doc.kind);
  // Both body shapes read the same way. A version saved before a document could hold tabs is
  // `{cells}` and comes back as one tab; nothing rewrites it, because a version row is the record
  // of what somebody saved and not a place to tidy.
  const sheets = sheetsOf(doc.body);
  const text = typeof doc.body['text'] === 'string' ? doc.body['text'] : '';
  const [lookups, revisions, from] = await Promise.all([
    isSheet ? lookupsFor(sheets) : Promise.resolve({}),
    revisionsOf(doc.id, 30),
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

      {/* `paper`: a document is white in both themes — see the block in globals.css. */}
      <div className="doc-screen paper">
        {doc.archivedAt && (
          <p className="doc-flag">
            Archived {when(doc.archivedAt)}. It is still here and still editable — archiving does
            not delete writing.
          </p>
        )}

        <div className="doc-ribbon">
          {!editable && (
            // Said, not merely enforced by the absence of a Save button. A reader who cannot find
            // how to edit should learn that there is nothing to find.
            <span
              className="chip chip-neutral"
              title="Extracted by this system from the filing behind the source icon. The record is not edited here."
            >
              read only
            </span>
          )}

          <span className="doc-ribbon-gap" />

          {/* Not a DialogButton: this is a download, and a download is a link. An anchor gets the
              browser's own save behaviour, works on a middle-click, and needs no client component
              to fetch bytes it would then have to hand back to the browser anyway. */}
          {!isSheet && (
            <a
              className="btn btn-icon"
              href={`/api/export/${doc.id}`}
              title={`Export ${doc.title} as a Word document`}
              aria-label="Export as a Word document"
            >
              {EXPORT}
            </a>
          )}

          <DialogButton
            label={HISTORY}
            title="History"
            className="btn btn-icon"
            buttonTitle={`${doc.versions} ${doc.versions === 1 ? 'save' : 'saves'} — who wrote what, and when`}
            wide
          >
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
                        <td>{r.writtenByName ?? <Blank why="Written before saves were attributed" />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="tbl-note">
              Every save is kept, and never an update — which is what makes a model&rsquo;s history
              readable a year later.
            </p>
          </DialogButton>

          {from && (
            <DialogButton
              label={SOURCE}
              title="Where this came from"
              className="btn btn-icon"
              buttonTitle={`Read out of ${from.filename}`}
              wide
            >
              <p className="picker-none">
                This is what this system read out of the file below. A reading is worth having only
                while it can be checked against the thing it read, so the original is here.
              </p>
              <Facts>
                <Fact label="Filing" value={from.filingCategory ?? <Blank why="No announcement still links to this file" />} />
                <Fact label="Announced" value={from.announcedAt ? when(from.announcedAt) : <Blank why="Not linked to an announcement" />} />
                <Fact label="Size" value={`${(from.bytes / 1e6).toFixed(2)} MB`} />
              </Facts>
              {from.filingSubject && <p className="tbl-note">{from.filingSubject}</p>}
              <p className="tbl-note">
                <a href={`/api/attachment/${from.sha256}`} target="_blank" rel="noreferrer">
                  Open {from.filename}
                </a>
              </p>
            </DialogButton>
          )}

          <DialogButton label="Rename" title="Rename" className="btn btn-link">
            <form action={renameDocumentAction} className="form-grid">
              <input type="hidden" name="id" value={doc.id} />
              <label className="lbl">
                Title
                <input className="field" name="title" defaultValue={doc.title} required />
              </label>
              <div className="form-actions">
                <button type="submit" className="btn btn-primary">Rename it</button>
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

          {/* Beside archive rather than instead of it: the two answer different questions, and the
              dialog says which is which before anything happens. */}
          <DeleteDocument
            id={doc.id}
            title={doc.title}
            versions={doc.versions}
            symbol={doc.symbol}
            filename={from?.filename ?? null}
          />
        </div>

        <div className="doc-canvas">
          {isSheet ? (
            // The action by reference and the id beside it. An arrow closing over the id would be
            // an event handler, which cannot cross into a client component.
            <SheetEditor id={doc.id} sheets={sheets} lookups={lookups} onSave={saveSheetAction} />
          ) : editable ? (
            <DocEditor id={doc.id} text={text} onSave={saveTextAction} />
          ) : (
            <DocumentText text={text} />
          )}
        </div>
      </div>
    </>
  );
}

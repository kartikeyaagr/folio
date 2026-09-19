import { deleteDocumentAction } from '@/app/_lib/actions/workspace.ts';

import { DialogButton } from './DialogButton.tsx';

/**
 * Deleting a document, and saying what that costs before it happens.
 *
 * One component rather than the same dialog written on each screen, because the wording *is* the
 * safety here. There is no undo, no trash and no second chance to read it — so the sentence naming
 * how many versions go is the only thing standing between a misaimed click and a model's history.
 * Written twice, it drifts, and the screen with the older wording is the one that tells somebody
 * less than the truth.
 *
 * **Archive is still offered beside this, and is still the right answer most of the time.** The two
 * are not degrees of the same action: archive is for writing the desk has finished with, and this
 * is for things that should not be in the record at all — an import that went in wrong, a file
 * uploaded against the wrong company. Presenting delete as the stronger archive would invite it to
 * be used as one.
 */
export function DeleteDocument({
  id,
  title,
  versions,
  symbol,
  filename,
  className = 'btn btn-link',
}: {
  id: string;
  title: string;
  versions: number;
  /** Where to land afterwards. The document's own page will not exist. */
  symbol?: string | null;
  /** The uploaded original, when this document came from one. It is kept, and that is worth saying. */
  filename?: string | null;
  className?: string;
}) {
  return (
    <DialogButton
      label="Delete"
      title={`Delete ${title}?`}
      className={className}
      buttonTitle="Delete this document and every version of it. There is no undo."
    >
      <form action={deleteDocumentAction} className="form-grid">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="title" value={title} />
        {symbol && <input type="hidden" name="symbol" value={symbol} />}

        <p className="picker-none">
          This removes <b>{title}</b> and {versions === 1 ? 'its single version' : `all ${versions} versions`} of
          it, and takes it out of search in the same breath. No screen shows it again and no button
          here brings it back.
        </p>
        <p className="picker-none">
          <b>Archive instead</b> if there is any chance it is wanted later: that keeps the document
          and its whole history and only hides it from the list. A note about a company the fund
          passed on is exactly the note worth finding in two years.
        </p>
        {/* Said rather than left as a comforting "gone forever", because it is not quite that and
            this system does not round in the flattering direction. `audit_log` keeps the row it
            deleted, body and all, attributed to whoever pressed this. */}
        <p className="picker-none">
          The deletion is itself on the record: <code>audit_log</code> keeps what was removed and
          who removed it. Getting it back means going to the database by hand — it is not something
          this app can do.
        </p>
        {filename && (
          // Said because it is surprising. The bytes are content-addressed and the same upload can
          // back more than one document, so removing them here could empty a document nobody asked
          // about — see `deleteDocument` in lib/workspace.ts.
          <p className="picker-none">
            The uploaded file itself — <code>{filename}</code> — is kept and stays downloadable.
          </p>
        )}

        <div className="form-actions">
          <button type="submit" className="btn btn-danger">Delete it for good</button>
        </div>
      </form>
    </DialogButton>
  );
}

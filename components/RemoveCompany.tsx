import { removeCompanyAction } from '@/app/_lib/actions/companies.ts';

import { DialogButton } from './DialogButton.tsx';

/**
 * Taking a name off the list, and saying before it happens what that does and does not cost.
 *
 * A component rather than a dialog written into the page, for `DeleteDocument`'s reason: the
 * wording is the safety. "Remove" beside a company reads as destroying its history, and a person
 * who believes that will not press it on a name they have finished with, which leaves the list
 * holding names nobody works on. So the dialog leads with what is kept.
 *
 * A name on the book is told why it cannot go rather than offered a button that is refused.
 * `removeCompany` refuses it too; this only says so first.
 */
export function RemoveCompany({
  symbol,
  held,
  className = 'btn btn-quiet',
}: {
  symbol: string;
  /** Shares on the book. Above zero, the name cannot be removed. */
  held: number;
  className?: string;
}) {
  return (
    <DialogButton
      label="Remove"
      title={`Remove ${symbol}?`}
      className={className}
      buttonTitle="Take this name off the list. Its history is kept and it can be restored."
    >
      {held > 0 ? (
        <p className="picker-none">
          {symbol} is on the book, so it cannot be removed. Record the sale first.
        </p>
      ) : (
        <form action={removeCompanyAction} className="form-grid">
          <input type="hidden" name="symbol" value={symbol} />
          <p className="picker-none">
            Its filings, documents, trades, alerts and agent drafts are all kept. It leaves the
            list, the feeds, the agents, the alerts and search.
          </p>
          <p className="picker-none">
            Restore brings it back, from its own page or from the Removed view of Companies, and
            fetches what it missed.
          </p>
          {/* Said because it is the one case where Remove means delete, and the reader should not
              learn that from the toast. */}
          <p className="picker-none">
            A name with nothing recorded against it is deleted instead: there is nothing to keep.
          </p>
          <div className="form-actions">
            <button type="submit" className="btn btn-danger">
              Remove
            </button>
          </div>
        </form>
      )}
    </DialogButton>
  );
}

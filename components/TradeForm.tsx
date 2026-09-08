'use client';

import { useState } from 'react';

export interface TradeName {
  id: string;
  symbol: string;
  name: string;
}

/**
 * Recording a trade.
 *
 * The shape here is the one `styles/portfolio.css` has carried since before there was a form to
 * put in it — `.pf-pick`, `.pf-side`, `.pf-more`, `.pf-decide` — written and unwired, exactly as
 * `FollowPicker`'s was. Three of its decisions are worth restating where the markup is:
 *
 * - **The list sits in flow, not floating.** A native `<dialog>` clips anything that leaves it, so
 *   a popover would be cut off where a list that grows simply scrolls.
 * - **Side is two segments, not a menu.** There are two answers and hiding one of them behind a
 *   click is how a sell gets entered as a buy.
 * - **What the ticker stands for is spelled out** once a name is picked, because a four-letter
 *   symbol should never be taken on faith on the one screen that moves the book.
 *
 * Client-side only for the picking and the filter. Every value is still checked server-side in
 * `recordTradeAction`; nothing here is a guarantee to anything.
 */
export function TradeForm({
  names,
  today,
  action,
}: {
  names: TradeName[];
  today: string;
  action: (form: FormData) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<TradeName | null>(null);

  const q = query.trim().toLowerCase();
  const hits =
    q === '' ? names : names.filter((n) => `${n.symbol} ${n.name}`.toLowerCase().includes(q));

  return (
    <form action={action} className="form-grid">
      <div className="pf-pick">
        <input type="hidden" name="companyId" value={picked?.id ?? ''} />
        {picked ? (
          <>
            <p className="pf-pick-at">
              <b>{picked.symbol}</b> is {picked.name}
            </p>
            <div className="form-actions">
              <button type="button" className="btn btn-link" onClick={() => setPicked(null)}>
                Pick a different name
              </button>
            </div>
          </>
        ) : (
          <>
            <label className="lbl">
              Company
              <input
                className="field"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="PRAJIND, or Praj Industries…"
                aria-label="Filter the followed names"
                autoComplete="off"
              />
            </label>
            {hits.length > 0 ? (
              <div className="pf-pick-list" role="listbox">
                {hits.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className="search-hit"
                    onClick={() => {
                      setPicked(n);
                      setQuery('');
                    }}
                  >
                    <b>{n.symbol}</b>
                    <span className="name">{n.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              // Only the book's own names, on purpose: a trade in something nobody follows is
              // either a mistake or a name that should be followed first.
              <p className="pf-pick-none">
                No followed name matches “{query.trim()}”. Follow it from Companies first, so the
                book and the research are about the same company.
              </p>
            )}
          </>
        )}
      </div>

      <div className="form-row">
        <label className="lbl">
          Side
          <div className="pf-side">
            <label>
              <input type="radio" name="side" value="buy" defaultChecked />
              <span>Buy</span>
            </label>
            <label>
              <input type="radio" name="side" value="sell" />
              <span>Sell</span>
            </label>
          </div>
        </label>
        <label className="lbl">
          Trade date
          <input className="field" type="date" name="tradeDate" defaultValue={today} required />
        </label>
      </div>

      <div className="form-row">
        <label className="lbl">
          Quantity
          <input className="field" name="quantity" inputMode="decimal" required />
        </label>
        <label className="lbl">
          Price
          <input className="field" name="price" inputMode="decimal" required />
        </label>
      </div>

      {/* Real, kept, and not the first thing the eye lands on. Both of these have a right answer
          most of the time — no charges worth splitting out, and one fill — and asking for them up
          front would put two optional boxes above the two that decide the position. */}
      <details className="pf-more">
        <summary>Charges, and a second fill on the same day</summary>
        <label className="lbl">
          Charges
          <input className="field" name="fees" inputMode="decimal" defaultValue="0" />
        </label>
        <label className="lbl">
          Fill number
          <input className="field" name="seq" inputMode="numeric" placeholder="1" />
        </label>
        {/* Said before it is needed. An identical fill is refused by a unique index, which is what
            turns a double-submitted form into an error instead of a doubled position — and a
            genuine second fill on the same day at the same price is routine enough to need a way
            through. */}
        <p className="picker-none">
          An identical fill on the same day is refused as a double submission. For a genuine second
          fill, put 2 here.
        </p>
      </details>

      <div className="pf-decide">
        <button type="submit" className="btn btn-primary" disabled={picked === null}>
          Record the trade
        </button>
      </div>
    </form>
  );
}

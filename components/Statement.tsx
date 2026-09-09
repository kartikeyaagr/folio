'use client';

import { useState } from 'react';

import { Blank } from './ui.tsx';
import type { Statement as StatementData, StatementRow } from '@/lib/financials.ts';

/**
 * One financial statement: periods across, line items down.
 *
 * The layout every filing uses and the only one a trend can be read from — twelve rows of one
 * period each tells you what a company earned; one row of twelve periods tells you what happened
 * to it. Laid out to match Screener, which is what this desk reads every day.
 *
 * The first column is sticky, because a table wide enough to be worth scrolling is a table where
 * you lose track of which line you are on.
 *
 * A client component only for the expanders. Which rows are open is a disclosure, not a place in
 * the application — nobody sends a colleague a link to "the P&L with expenses expanded" — so it
 * stays out of the URL, the same call `FilterList` makes about its search box.
 */

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2024-03-31` reads as `Mar 2024`, which is how a period is named everywhere else it appears. */
function periodLabel(end: string): string {
  const [y, m] = end.split('-');
  return `${MONTH[Number(m) - 1] ?? m} ${y ?? ''}`;
}

/**
 * A percentage, no decimals: the precision is not there and pretending otherwise is noise.
 *
 * `+ 0` collapses negative zero. A stock movement of -0.4% rounds to "-0%", which reads as a
 * discovered minus sign rather than as the rounding it is.
 */
const pct = (v: string): string => `${(Number(Number(v).toFixed(0)) + 0).toFixed(0)}%`;

/**
 * A figure in crore, bare.
 *
 * Not `crore()` from ui.tsx, which renders "₹829.01 cr" — correct wherever a figure stands alone,
 * and thirteen columns of visual noise here, where the header already says "In ₹ crore" and the
 * only thing a reader is doing is comparing one column against the next. Whole crore for the same
 * reason: two decimals across a decade of quarters is precision nobody reads and width everybody
 * pays for.
 */
const inCrore = (v: string): string =>
  (Number(v) / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 });

function Cells({ row, periods }: { row: StatementRow; periods: StatementData['periods'] }) {
  return (
    <>
      {row.values.map((v, i) => (
        <td key={periods[i]?.end ?? i} className="num">
          {v === null ? (
            <Blank why="Not reported in this filing" />
          ) : row.percent ? (
            pct(v)
          ) : row.perShare ? (
            Number(v).toFixed(2)
          ) : (
            inCrore(v)
          )}
        </td>
      ))}
    </>
  );
}

function Line({
  row,
  periods,
  striped,
}: {
  row: StatementRow;
  periods: StatementData['periods'];
  striped: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expandable = (row.children?.length ?? 0) > 0;

  const cls = [striped ? 'stmt-stripe' : '', row.strong ? 'is-strong' : ''].filter(Boolean).join(' ');

  return (
    <>
      <tr className={cls || undefined}>
        <td className="stmt-item">
          {expandable ? (
            <button
              type="button"
              className="stmt-expand"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {row.label} <span aria-hidden="true">{open ? '−' : '+'}</span>
            </button>
          ) : (
            row.label
          )}
          {row.derived && (
            <span
              className="stmt-flag"
              title="Computed from the reported lines, not filed as its own figure. Null wherever one of its inputs was not reported."
            >
              computed
            </span>
          )}
        </td>
        <Cells row={row} periods={periods} />
      </tr>
      {open &&
        row.children!.map((child) => (
          <tr key={child.key} className="stmt-child">
            <td className="stmt-item">
              {child.label}
              {child.derived && (
                <span className="stmt-flag" title="Computed from the reported lines.">
                  computed
                </span>
              )}
            </td>
            <Cells row={child} periods={periods} />
          </tr>
        ))}
    </>
  );
}

export function Statement({ data, empty }: { data: StatementData; empty: string }) {
  if (data.periods.length === 0 || data.rows.length === 0) {
    return <p className="picker-none">{empty}</p>;
  }

  return (
    <div className="tbl-scroll">
      <table className="tbl stmt">
        <thead>
          <tr>
            <th className="stmt-item">In ₹ crore</th>
            {data.periods.map((p) => (
              <th key={p.end} className="num">
                {periodLabel(p.end)}
                {p.suspectDates && (
                  <span
                    className="stmt-flag"
                    title="The XBRL context declared this period's dates while carrying a different span of figures. The dates here come from the reported facts, not from the context."
                  >
                    ·
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => (
            <Line key={row.key} row={row} periods={data.periods} striped={i % 2 === 1} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
